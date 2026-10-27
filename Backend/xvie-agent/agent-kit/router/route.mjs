/**
 * route.mjs — deterministic reference router for the agent-kit.
 *
 * Ported from ui-craft's mcp/src/tools/route-task.mjs (MIT — github.com/educlopez/ui-craft).
 * Zero dependencies, no model call, no network. Same prompt always routes the same way.
 *
 * Public API:
 *   route(prompt, opts)        → ranked references + intent + instruction (pointers only)
 *   listReferences()           → manifest of every available reference (for the read tool)
 *   readReference(nameOrPath)  → file content by corpus name or kit-relative path
 *   loadReferences(prompt, o)  → route + read in one call: [{ name, path, content }]
 *
 * Boundary: returns POINTERS, never rules. The design judgment lives in the files this
 * points at.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STOPWORDS, SYNONYMS, CORPUS, REPAIR_MARKERS, OUT_OF_SCOPE } from './route-data.mjs';

// Kit root = parent of router/. All corpus paths resolve from here.
const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ─── Signal ladder ───────────────────────────────────────────────────────────

const SIGNAL = {
  NAME_EXACT: 100,
  KEYWORD_EXACT: 60,
  CONTAINS_EXACT: 45,
  NAME_FUZZY: 40,
  KEYWORD_FUZZY: 25,
  SUMMARY_WORD: 12,
};

// Coverage is an additive bonus, never a multiplier — a multiplier would scale a long
// prompt down by the fraction of words that missed and punish rambling prompts.
const COVERAGE_BONUS = 25;

const SCORE_FLOOR = 20;
const RELEVANT_RATIO = 0.6;
const FUZZY_MIN_LENGTH = 5;
const FUZZY_MAX_DISTANCE = 2;

// ─── Reverse synonym index (alias → concept ids, one hop only) ──────────────

const ALIAS_TO_CONCEPTS = new Map();
for (const [concept, aliases] of Object.entries(SYNONYMS)) {
  const register = (word, target) => {
    const existing = ALIAS_TO_CONCEPTS.get(word);
    if (existing) {
      if (!existing.includes(target)) existing.push(target);
    } else {
      ALIAS_TO_CONCEPTS.set(word, [target]);
    }
  };
  register(concept, concept);
  for (const alias of aliases) register(alias, concept);
}

// ─── Normalisation ───────────────────────────────────────────────────────────

function deaccent(word) {
  return word.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

const MIN_STEM = 5;
const STEM_RULES = [
  [/ing$/, ''],
  [/ies$/, 'y'],
  [/es$/, ''],
  [/s$/, ''],
];

export function stem(word) {
  for (const [pattern, replacement] of STEM_RULES) {
    if (!pattern.test(word)) continue;
    const next = word.replace(pattern, replacement);
    if (next.length >= MIN_STEM || next.length === word.length) return next;
  }
  return word;
}

export function tokenize(prompt) {
  return String(prompt)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^-+|-+$/g, ''))
    .filter(Boolean)
    .map(deaccent)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

export function editDistance(a, b, max = FUZZY_MAX_DISTANCE) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[b.length];
}

export function toConcepts(prompt) {
  const tokens = tokenize(prompt);
  const concepts = [];
  const seenKey = new Set();

  for (const token of tokens) {
    const stemmed = stem(token);
    const conceptIds = ALIAS_TO_CONCEPTS.get(token) ?? ALIAS_TO_CONCEPTS.get(stemmed) ?? [];
    const key = conceptIds.length ? `concept:${conceptIds.join('+')}` : `token:${stemmed}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);

    const words = new Set([token, stemmed]);
    for (const id of conceptIds) {
      words.add(id);
      for (const alias of SYNONYMS[id] ?? []) words.add(deaccent(alias));
    }
    concepts.push({ token, stem: stemmed, conceptIds, words: [...words] });
  }
  return concepts;
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

function scoreConcept(entry, concept) {
  const name = deaccent(entry.name.toLowerCase());
  const nameStem = stem(name);
  const keywords = (entry.keywords ?? []).map((k) => deaccent(k.toLowerCase()));
  const contains = (entry.contains ?? []).map((c) => deaccent(c.toLowerCase()));
  const summaryWords = new Set(tokenize(entry.summary ?? '').map(stem));

  for (const w of concept.words) {
    if (name === w || nameStem === stem(w)) return SIGNAL.NAME_EXACT;
  }
  for (const w of concept.words) {
    if (keywords.includes(w) || keywords.some((k) => stem(k) === stem(w))) return SIGNAL.KEYWORD_EXACT;
  }
  for (const w of concept.words) {
    if (contains.includes(w) || contains.some((c) => stem(c) === stem(w) || c.split('-').includes(w))) {
      return SIGNAL.CONTAINS_EXACT;
    }
  }
  // Fuzzy only against the literal token, never expanded synonyms — fuzzing an alias is
  // two hops of approximation, which is where nonsense matches come from.
  if (concept.token.length >= FUZZY_MIN_LENGTH) {
    if (editDistance(concept.token, name) <= FUZZY_MAX_DISTANCE) return SIGNAL.NAME_FUZZY;
    if (keywords.some((k) => k.length >= FUZZY_MIN_LENGTH && editDistance(concept.token, k) <= FUZZY_MAX_DISTANCE)) {
      return SIGNAL.KEYWORD_FUZZY;
    }
  }
  for (const w of concept.words) {
    if (summaryWords.has(stem(w))) return SIGNAL.SUMMARY_WORD;
  }
  return 0;
}

function scoreEntry(entry, concepts) {
  if (!concepts.length) return { score: 0, matched: [] };
  const perConcept = concepts.map((c) => ({ concept: c, signal: scoreConcept(entry, c) }));
  const matched = perConcept.filter((p) => p.signal > 0);
  if (!matched.length) return { score: 0, matched: [] };

  // Strength is the entry's BEST claim, not the mean. One incidental summary word is not
  // a match — require two before a summary-only hit counts.
  const strongest = Math.max(...matched.map((m) => m.signal));
  if (strongest <= SIGNAL.SUMMARY_WORD && matched.length < 2) return { score: 0, matched: [] };

  const coverage = matched.length / concepts.length;
  return {
    score: Math.round((strongest + coverage * COVERAGE_BONUS) * 10) / 10,
    matched: matched.map((m) => m.concept.token),
  };
}

// ─── Repair intent ───────────────────────────────────────────────────────────

const REPAIR_SET = new Set(REPAIR_MARKERS.map(deaccent));

/** True when the prompt says something already exists and is wrong ("this modal is janky"). */
export function isRepairIntent(prompt) {
  return String(prompt)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .split(/\s+/)
    .map(deaccent)
    .some((w) => REPAIR_SET.has(w));
}

// ─── Out-of-scope detection ──────────────────────────────────────────────────

export function outOfScopeMatches(prompt) {
  const haystack = ` ${deaccent(String(prompt).toLowerCase()).replace(/[^a-z0-9]+/g, ' ')} `;
  return OUT_OF_SCOPE.filter((c) => c.triggers.some((t) => haystack.includes(` ${t} `))).map(
    ({ id, label, use }) => ({ id, label, use })
  );
}

// ─── Route ───────────────────────────────────────────────────────────────────

/**
 * Route a natural-language UI request to the references that cover it.
 *
 * @param {string} prompt - the user's request in natural language
 * @param {{ limit?: number }} [opts]
 * @returns {{
 *   prompt: string, concepts: string[], intent: 'build'|'repair',
 *   references: Array<{name,path,summary,score,matched,tier}>,
 *   always_load: string[], out_of_scope: Array<{id,label,use}>, instruction: string,
 * }}
 */
export function route(prompt, { limit = 4 } = {}) {
  const max = Math.min(Math.max(Number.isInteger(limit) ? limit : 4, 1), 12);
  const empty = {
    prompt: String(prompt ?? ''),
    concepts: [],
    intent: 'build',
    references: [],
    always_load: [],
    out_of_scope: [],
    instruction: '',
  };
  if (!prompt || !String(prompt).trim()) {
    return { ...empty, instruction: 'Empty prompt — nothing to route.' };
  }

  const concepts = toConcepts(prompt);
  const scope = outOfScopeMatches(prompt);

  if (!concepts.length) {
    return {
      ...empty,
      out_of_scope: scope,
      instruction:
        'Nothing in that prompt survived stopword removal, so there is nothing to rank. ' +
        'Ask the user what surface they want (dashboard, landing page, auth screen, form…).',
    };
  }

  // Kit adaptation vs upstream: on equal scores, outcome recipes (recipe-*) outrank
  // pattern references — for one-shot generation the recipe carries the composition
  // rules and acceptance bar, so it should lead the injected list.
  const scored = CORPUS.map((entry) => {
    const { score, matched } = scoreEntry(entry, concepts);
    return { entry, score, matched };
  })
    .filter((r) => r.score >= SCORE_FLOOR)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.entry.priority ?? 1) - (b.entry.priority ?? 1) ||
        a.entry.id.localeCompare(b.entry.id)
    );

  const shape = (r) => ({
    name: r.entry.name,
    path: r.entry.path,
    summary: r.entry.summary,
    score: r.score,
    matched: r.matched,
    tier: r.entry.tier,
  });

  const references = scored.slice(0, max).map(shape);

  // Kit adaptation vs upstream: there are no slash commands here, so nothing carries
  // upstream's first move ("/craft dashboard"). SKILL.md makes surface recipes required
  // reading ("load the recipe BEFORE writing code — skipping it removes the numeric
  // limits"), so a recipe scoring within relevance of the winner is promoted to the
  // front of the list instead of trailing a pattern reference it supports.
  // Guarded: a prompt with concepts but no corpus hit reaches here with an empty
  // scored list and must fall through to the honest no-match instruction below.
  if (scored.length) {
    const topScore = scored[0].score;
    const promoted = new Set(
      scored
        .filter(
          (r) =>
            r.entry.id.startsWith('ref-recipe-') && r.score >= topScore * RELEVANT_RATIO
        )
        .map((r) => r.entry.id)
    );
    if (promoted.size) {
      const head = references.filter((r) => {
        const e = CORPUS.find((c) => c.path === r.path);
        return e && promoted.has(e.id);
      });
      const rest = references.filter((r) => !head.includes(r));
      references.length = 0;
      references.push(...head, ...rest);
    }
  }

  // Tier-1 entries are required reading before writing UI — surface them separately so
  // the orchestrator can guarantee they are present even when ranking missed one.
  const alwaysLoad = CORPUS.filter((e) => e.tier === 1).map((e) => e.path);

  const repair = isRepairIntent(prompt);

  let instruction;
  if (!scored.length) {
    instruction =
      `Nothing matched "${prompt}" above the noise floor. That is a real answer, not a fallback: ` +
      'the surface may be outside the library. Ask the user to state it directly ' +
      '(dashboard, landing page, auth screen, form), then apply the core rules anyway.';
  } else {
    instruction =
      `Load these references before writing any code: ${references.map((r) => r.path).join(', ')}. ` +
      (repair
        ? 'This request describes something that already exists and is wrong — run a review/repair pass over existing code rather than building a new surface. '
        : '') +
      'Discovery still runs first: analyze the project for existing tokens/fonts, or ask the Quick Ask questions.';
  }

  return {
    prompt: String(prompt),
    concepts: concepts.map((c) => c.token),
    intent: repair ? 'repair' : 'build',
    references,
    always_load: alwaysLoad.filter((p) => !references.some((r) => r.path === p)),
    out_of_scope: scope,
    instruction:
      instruction +
      (scope.length
        ? ` Out of scope: ${scope.map((o) => `${o.label} → ${o.use}`).join(' ')} Say so rather than producing web guidance for it.`
        : ''),
  };
}

// ─── Reference access (the "C" half of the hybrid) ──────────────────────────

/**
 * Manifest of every available reference — expose this to your agent as a
 * `read_ui_reference` tool so it can pull extras mid-task.
 */
export function listReferences() {
  return CORPUS.map(({ name, path, summary, tier }) => ({ name, path, summary, tier }));
}

/**
 * Read one reference by corpus name ("forms") or kit-relative path
 * ("references/forms.md"). Returns { name, path, content }. Throws on unknown names
 * and rejects anything escaping the kit directory.
 */
export function readReference(nameOrPath) {
  const entry =
    CORPUS.find((e) => e.name === nameOrPath || e.path === nameOrPath) ??
    CORPUS.find((e) => `${e.name}.md` === nameOrPath);
  const rel = entry ? entry.path : String(nameOrPath);
  const abs = resolve(KIT_ROOT, rel);
  if (!abs.startsWith(KIT_ROOT + sep)) {
    throw new Error(`Path escapes the kit directory: ${rel}`);
  }
  return { name: entry?.name ?? null, path: rel, content: readFileSync(abs, 'utf8') };
}

/**
 * Convenience: route a prompt and read the ranked references.
 *
 * Context budget rule (from upstream build evals — a passing build opens 1-2 files,
 * not the whole library): only ranked hits are read in full. When a surface recipe is
 * among them, `craft-intent.md` (the one reference every full-surface build needs, per
 * SKILL.md) and `layout.md` are appended too — recipes carry surface-specific shells,
 * but the spacing/hierarchy fundamentals live in layout.md, and requests rarely name
 * it ("pricing page" says nothing about spacing). Remaining Tier-1 paths ride along as
 * pointers in `always_load` for the agent to pull via its read tool.
 */
export function loadReferences(prompt, { limit = 4 } = {}) {
  const result = route(prompt, { limit });

  // Inject only the relevant band — hits within RELEVANT_RATIO of the top score —
  // mirroring upstream's first-move guard. Below that line live the synonym-bleed
  // matches ('report' inside craft-report catching 'analytics'); they stay visible in
  // result.references as pointers but never enter the prompt. Max, not [0]: promotion
  // reorders the list, so a promoted recipe must not lower the bar for its tail.
  const topScore = Math.max(0, ...result.references.map((r) => r.score));
  const paths = result.references
    .filter((r) => r.score >= topScore * RELEVANT_RATIO)
    .slice(0, limit)
    .map((r) => r.path);
  // Tier-4 refs are opt-in only: rankable pointers, never auto-loaded into
  // the prompt. stack.md alone (21KB) pushed requests over the wire limit.
  const TIER4_NO_AUTOLOAD = new Set(['stack', 'heuristics', 'personas', 'state-design', 'dataviz']);
  const nameOf = (p) => CORPUS.find((c) => c.path === p)?.name ?? null;
  const ranked = paths.filter((p) => !TIER4_NO_AUTOLOAD.has(nameOf(p)));
  // Priority: top ranked hit first, then pins, then remaining hits.
  const lower = String(prompt || '').toLowerCase();
  const isLanding = ['landing', 'homepage', 'website', 'marketing', 'hero', 'footer', 'pricing', 'portfolio'].some((w) => lower.includes(w));
  const hasRecipe = ranked.some((p) => p.includes('recipe-'));
  const pins = [];
  if (hasRecipe && !ranked.includes('references/craft-intent.md')) pins.push('references/craft-intent.md');
  if (isLanding && !ranked.includes('references/page-completeness.md')) pins.push('references/page-completeness.md');
  if (!ranked.includes('references/layout.md')) pins.push('references/layout.md');
  const ordered = [];
  for (const p of [...(ranked.slice(0, 1)), ...pins, ...ranked.slice(1)]) {
    if (!ordered.includes(p)) ordered.push(p);
  }
  // Strict budget: 40K chars (~10K tokens). Whole file if it fits, else
  // truncate this one file with a read-tool pointer and stop. No overshoot.
  const seen = new Set();
  const withContent = [];
  const budgetChars = 40000;
  let used = 0;
  for (const p of ordered) {
    if (seen.has(p)) continue;
    seen.add(p);
    if (used >= budgetChars) break;
    const ref = readReference(p);
    let content = ref.content;
    const remaining = budgetChars - used;
    if (content.length > remaining) {
      content = content.slice(0, remaining) + `\n\n[... truncated to fit the reference budget — pull the rest via read_ui_reference('${ref.name || p}')]`;
      used += content.length;
      withContent.push({ ...ref, content });
      break;
    }
    used += content.length;
    withContent.push({ ...ref, content });
  }
  return { ...result, loaded: withContent };
}
