"""Design reference router — deterministic lexical router for the agent-kit.

Ported from agent-kit/router/route.mjs (MIT — github.com/educlopez/ui-craft).
Zero dependencies, no model call, no network. Same input always routes the same way.

Public API:
    route(prompt, limit=4)          → ranked references + intent + instruction
    list_references()               → manifest of every available reference
    read_reference(name_or_path)    → file content by corpus name or path
    load_references(prompt, limit=2)→ route + read in one call
"""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path
from typing import NamedTuple


# ---------------------------------------------------------------------------
# Kit root — agent-kit/ is a sibling of xvie_agent/
# ---------------------------------------------------------------------------

_KIT_ROOT = Path(__file__).resolve().parent.parent / "agent-kit"


# ---------------------------------------------------------------------------
# Route data (ported from route-data.mjs)
# ---------------------------------------------------------------------------

STOPWORDS: set[str] = {
    "a", "an", "the", "and", "or", "but", "if", "then", "than", "that", "this",
    "these", "those", "is", "are", "was", "were", "be", "been", "being", "to",
    "of", "in", "on", "at", "by", "for", "with", "without", "from", "into",
    "onto", "about", "as", "it", "its", "my", "me", "our", "ours", "your",
    "yours", "you", "i", "we", "they", "them", "their", "can", "could",
    "should", "would", "will", "shall", "may", "might", "must", "do", "does",
    "did", "done", "have", "has", "had", "not", "no", "nor", "so", "up",
    "out", "over", "under", "more", "most", "less", "some", "any", "each",
    "one", "two", "also", "very", "just", "like", "there", "here", "when",
    "while", "where", "how", "what", "which", "who", "why", "all", "both",
    "either", "other", "another", "same", "build", "building", "make",
    "making", "create", "creating", "add", "adding", "need", "needs", "want",
    "wants", "help", "please", "give", "get", "let", "lets", "work",
    "working", "use", "using", "new", "good", "nice", "quick", "quickly",
    "thing", "things", "stuff", "something", "anything", "everything", "now",
    "again", "maybe", "probably", "basically", "really", "actually", "kinda",
    "sorta", "whatnot", "etc", "plus", "okay", "ok", "yeah", "thanks",
}

SYNONYMS: dict[str, list[str]] = {
    "dashboard": [
        "analytics", "kpi", "kpis", "metrics", "metric", "panel", "panels",
        "admin", "reporting", "reports", "report", "stats", "statistics",
        "overview", "console", "backoffice", "back-office", "monitoring",
        "observability", "insights",
    ],
    "landing": [
        "marketing", "homepage", "home", "hero", "fold", "above-the-fold",
        "promo", "saas", "website", "site", "pricing", "testimonials",
        "testimonial", "features", "cta", "waitlist", "launch-page", "logos",
        "faq", "footer", "header", "content", "sections", "rich",
    ],
    "auth": [
        "login", "log-in", "signin", "sign-in", "signup", "sign-up",
        "register", "registration", "session", "password", "passwords",
        "passkey", "otp", "magic-link", "oauth", "sso", "authentication",
        "onboarding", "verification",
    ],
    "forms": [
        "form", "input", "inputs", "field", "fields", "validation",
        "validate", "validating", "invalid", "checkout", "wizard", "stepper",
        "multi-step", "autosave", "select", "checkbox", "radio", "textarea",
        "submit", "fieldset",
    ],
    "tokens": [
        "token", "variables", "variable", "design-system", "scale", "scales",
        "primitives", "primitive", "semantic", "palette", "ramp",
        "custom-properties",
    ],
    "color": [
        "colour", "colours", "colors", "accent", "hue", "oklch", "hsl",
        "lch", "contrast", "dark", "darkmode", "dark-mode", "light",
        "lightmode", "apca", "saturation", "chroma", "gamut", "p3", "tint",
        "shade",
    ],
    "typography": [
        "type", "typeface", "typefaces", "font", "fonts", "tracking",
        "leading", "kerning", "letterspacing", "letter-spacing", "text",
        "heading", "headings", "headline", "serif", "sans", "monospace",
        "weight", "weights", "lineheight", "line-height", "readability",
        "measure",
    ],
    "motion": [
        "animation", "animations", "animate", "animated", "transition",
        "transitions", "easing", "ease", "spring", "springs", "stagger",
        "keyframes", "choreography", "micro-interaction", "microinteraction",
        "hover", "gesture", "gestures", "scroll", "parallax", "reveal",
        "entrance", "exit", "waapi", "view-transition", "view-transitions",
        "shared-element", "flip", "starting-style",
    ],
    "layout": [
        "spacing", "grid", "grids", "composition", "rhythm", "alignment",
        "align", "hierarchy", "gestalt", "whitespace", "margins", "margin",
        "padding", "gutter", "columns", "stack", "flexbox", "asymmetry",
        "balance", "header", "footer", "hero", "skeleton", "sections",
    ],
    "accessibility": [
        "a11y", "aria", "wcag", "keyboard", "screenreader", "screen-reader",
        "focus", "focus-visible", "contrast", "tabindex", "semantics",
        "semantic-html", "inclusive", "landmark", "alt-text", "skip-link",
    ],
    "responsive": [
        "mobile", "tablet", "desktop", "breakpoint", "breakpoints",
        "adaptive", "fluid", "viewport", "touch", "thumb",
        "container-query", "container-queries", "small-screen", "narrow",
        "zoom",
    ],
    "dataviz": [
        "chart", "charts", "graph", "graphs", "plot", "visualization",
        "visualisation", "sparkline", "sparklines", "axis", "axes", "legend",
        "series", "tufte", "heatmap", "histogram", "scatter", "bar-chart",
        "line-chart",
    ],
    "tables": [
        "table", "tables", "rows", "row", "columns", "datagrid",
        "data-grid", "sorting", "sortable", "pagination", "paginated",
        "virtualization", "virtualized", "spreadsheet",
    ],
    "components": [
        "component", "components", "button", "buttons", "modal", "modals",
        "dialog", "menu", "menus", "dropdown", "card", "cards", "nav",
        "navbar", "navigation", "sidebar", "tooltip", "toast", "badge",
        "tabs", "popover", "search", "accordion", "avatar", "chip",
        "drawer", "drawers", "sheet", "sheets", "sonner", "toaster",
        "combobox",
    ],
    "copy": [
        "copywriting", "microcopy", "wording", "voice", "tone", "label",
        "labels", "message", "messages", "messaging", "placeholder",
        "helper-text", "terminology",
    ],
    "states": [
        "state", "loading", "skeleton", "spinner", "empty", "empty-state",
        "offline", "partial", "conflict", "edge-case", "edge-cases",
        "unhappy", "pending", "stale", "retry", "timeout",
    ],
    "review": [
        "critique", "audit", "auditing", "assess", "assessment", "evaluate",
        "feedback", "findings", "inspect", "check", "checking",
        "second-opinion", "code-review", "walkthrough",
    ],
    "polish": [
        "refine", "refinement", "detail", "details", "finish", "finishing",
        "craft", "quality", "nitpick", "micro", "last-mile", "fit-and-finish",
    ],
    "performance": [
        "perf", "fps", "janky", "jank", "lag", "laggy", "slow", "sluggish",
        "frames", "framerate", "compositor", "gpu", "reflow", "repaint",
        "layout-thrash", "optimize", "optimise", "stutter", "dropped-frames",
    ],
    "brief": [
        "identity", "positioning", "audience", "principles", "principle",
        "intent", "constraints", "constraint", "memory", "context",
        "product-context", "brand",
    ],
    "spec": [
        "specification", "wireframe", "wireframes", "blueprint", "plan",
        "structure", "inventory", "content-inventory", "lo-fi", "mockup",
    ],
    "metadata": [
        "meta", "seo", "title", "titles", "description", "canonical", "og",
        "opengraph", "open-graph", "favicon", "favicons", "social-card",
        "sharing", "structured-data", "schema-org", "sitemap", "noindex",
    ],
    "sound": [
        "audio", "sfx", "sound-effects", "haptics", "haptic", "vibration",
        "webaudio", "web-audio", "chime", "mute",
    ],
    "stack": [
        "gsap", "threejs", "three", "three-js", "webgl", "shader", "shaders",
        "framer", "framer-motion", "r3f", "canvas", "lottie", "rive",
        "scrolltrigger", "webgpu", "3d", "cobe", "globe", "globes", "ogl",
    ],
    "ai": [
        "chat", "llm", "streaming", "stream", "agent", "agentic",
        "assistant", "prompt", "citations", "tool-call", "tool-calls",
        "generative", "copilot", "completion",
    ],
    "theme": [
        "themes", "preset", "presets", "skin", "reskin", "branding",
        "whitelabel", "white-label", "multi-tenant", "tenant",
    ],
    "redesign": [
        "rebuild", "modernize", "modernise", "refresh", "revamp", "migrate",
        "migration", "legacy", "facelift", "overhaul",
    ],
    "simplify": [
        "distill", "reduce", "simplify", "cut", "trim", "declutter", "noise",
        "bloat", "overbuilt", "busy", "cluttered", "minimalise",
    ],
    "extract": [
        "refactor", "refactoring", "dedupe", "deduplicate", "duplication",
        "duplicated", "repeated", "componentize", "abstract", "reuse",
        "reusable", "dry",
    ],
    "variance": [
        "bolder", "bold", "personality", "expressive", "signature",
        "distinctive", "generic", "samey", "boring", "bland", "slop",
        "template-y", "cookie-cutter", "ai-looking", "forgettable",
    ],
    "quieter": [
        "calm", "calmer", "restrained", "subtle", "understated",
        "tone-down", "quiet", "minimal", "minimalist", "noisy", "loud",
        "shouty",
    ],
    "ship": [
        "finalize", "finalise", "merge", "merging", "pr", "pull-request",
        "preship", "pre-ship", "gate", "release", "production", "deploy",
        "deployment", "launch",
    ],
    "harden": [
        "hardening", "robust", "robustness", "i18n", "l10n", "rtl",
        "localization", "localisation", "resilience", "resilient",
        "production-ready", "battle-tested",
    ],
    "heuristic": [
        "nielsen", "usability", "score", "scoring", "rubric", "grade",
        "graded", "persona", "personas", "benchmark-score",
    ],
    "css": [
        "modern-css", "view-transitions", "view-transition",
        "anchor-positioning", "popover", "container-queries",
        "starting-style", "clip-path", "mask", "mask-image", "nesting",
        "has-selector", "subgrid",
    ],
    "inspiration": [
        "reference", "references", "examples", "example", "archetype",
        "archetypes", "patterns", "pattern", "mature", "benchmark",
        "competitor", "prior-art",
    ],
}

REPAIR_MARKERS: list[str] = [
    "fix", "fixes", "fixing", "broken", "break", "breaks", "breaking",
    "bug", "bugs", "buggy", "wrong", "issue", "issues", "problem",
    "problems", "slow", "sluggish", "janky", "jank", "laggy", "ugly",
    "off", "weird", "awkward", "improve", "improves", "improving",
    "better", "review", "audit", "critique", "regression", "regressions",
    "fails", "failing", "failed", "jumps", "jumping", "shifts", "shifting",
    "flickers", "flickering", "stutters", "stuttering", "unreadable",
    "inconsistent", "messy", "cluttered", "confusing", "hurts", "wrongly",
    "misaligned",
]


class _CorpusEntry(NamedTuple):
    id: str
    name: str
    path: str
    tier: int
    summary: str
    keywords: list[str]
    contains: list[str]
    priority: int | None  # lower = higher priority (recipes get 0)


CORPUS: list[_CorpusEntry] = [
    # Tier 1
    _CorpusEntry("ref-craft-intent", "craft-intent", "references/craft-intent.md", 1,
                 "Craft Read, DESIGN_VARIANCE, signature bets, product vs marketing build patterns.",
                 ["variance", "craft", "intent", "signature", "craft-read"],
                 ["design-variance", "signature-bet"], None),
    _CorpusEntry("ref-tokens", "tokens", "references/tokens.md", 1,
                 "3-layer token spine — primitive → semantic → component, both modes intentional.",
                 ["tokens"], ["radius-scale", "spacing-scale", "z-index", "shadows"], None),
    _CorpusEntry("ref-inspiration", "inspiration", "references/inspiration.md", 1,
                 "Pattern archetypes from mature SaaS, signature details, what mature interfaces never do.",
                 ["inspiration"], ["archetypes", "reference-values"], None),
    _CorpusEntry("ref-accessibility", "accessibility", "references/accessibility.md", 1,
                 "WCAG, keyboard, focus, forms, ARIA, touch targets, checklist.",
                 ["accessibility"], ["focus-visible", "aria", "keyboard", "touch-targets"], None),
    _CorpusEntry("ref-color", "color", "references/color.md", 1,
                 "Color strategy, palettes, dark mode, accent budget, OKLCH scales, APCA.",
                 ["color"], ["accent-budget", "oklch", "apca", "dark-mode"], None),
    _CorpusEntry("ref-layout", "layout", "references/layout.md", 1,
                 "Gestalt grouping, spacing rhythm, hierarchy ratios, composition strategies, optical center.",
                 ["layout"], ["gestalt", "spacing-rhythm", "optical-center", "nested-radii"], None),
    # Tier 2
    _CorpusEntry("ref-spec", "spec", "references/spec.md", 2,
                 "Durable composition spec format — per-surface composition choice and acceptance bar.",
                 ["spec"], [], None),
    _CorpusEntry("ref-recipe-dashboard", "recipe-dashboard", "references/recipe-dashboard.md", 2,
                 "Outcome recipe: 3 named dashboard compositions, shell spec, build order, acceptance bar.",
                 ["dashboard", "recipe"],
                 ["metric-cards", "kpi-grid", "sidebar", "charts", "data-tables", "filters", "toolbar", "sparklines"],
                 0),
    _CorpusEntry("ref-recipe-landing", "recipe-landing", "references/recipe-landing.md", 2,
                 "Outcome recipe: product-forward / message-forward / proof-forward compositions, section grammar, pricing rules.",
                 ["landing", "recipe"],
                 ["hero", "pricing-table", "testimonials", "logo-wall", "feature-rows", "faq", "footer", "social-proof", "eyebrow"],
                 0),
    _CorpusEntry("ref-recipe-auth", "recipe-auth", "references/recipe-auth.md", 2,
                 "Outcome recipe: split-panel / centered-card auth compositions, form contract, sign-up deltas.",
                 ["auth", "recipe"],
                 ["sign-in-form", "oauth-buttons", "password-field", "magic-link"],
                 0),
    _CorpusEntry("ref-themes", "themes", "references/themes.md", 2,
                 "4 named production token presets — Graphite, Porcelain, Carbon, Signal.",
                 ["theme"], ["graphite", "porcelain", "carbon", "signal"], None),
    _CorpusEntry("ref-dashboard", "dashboard", "references/dashboard.md", 2,
                 "Dashboard patterns — metric cards, charts, tables, sidebar, filters, density, signal-to-noise tiers.",
                 ["dashboard", "tables"],
                 ["metric-cards", "status-dots", "proportion-bars", "virtualization", "scrollbar-gutter", "density", "overflow-x", "sticky-header"],
                 None),
    _CorpusEntry("ref-forms", "forms", "references/forms.md", 2,
                 "Validation timing, progressive disclosure, multi-step wizards, autosave, optimistic submit.",
                 ["forms"], ["validation-timing", "wizard", "autosave"], None),
    _CorpusEntry("ref-components", "components", "references/components.md", 2,
                 "Component anatomy contracts — buttons, menus, modals, search, cards, nav bar.",
                 ["components"], ["button", "menu", "modal", "search", "card", "navbar"], None),
    _CorpusEntry("ref-ai-chat", "ai-chat", "references/ai-chat.md", 2,
                 "Streaming contract, 7-state affordance model for AI surfaces, tool traces, citations, generative UI.",
                 ["ai"], ["streaming", "tool-traces", "citations", "feedback"], None),
    _CorpusEntry("ref-review", "review", "references/review.md", 2,
                 "Critique methodology, Polish Pass, common issues, component craft, Craft Report format.",
                 ["review", "polish"], ["polish-pass", "craft-report"], None),
    _CorpusEntry("ref-finish-bar", "finish-bar", "references/finish-bar.md", 2,
                 "10-pass finishing protocol before merge.",
                 ["ship", "polish"], ["ten-passes"], None),
    _CorpusEntry("ref-loops", "loops", "references/loops.md", 2,
                 "Loop engine — read→evaluate→fix-one→re-evaluate→stop, plus 3 presets.",
                 ["loops", "loop", "converge", "convergence", "iterate", "iteration"], [], None),
    _CorpusEntry("ref-principles", "principles-catalog", "references/principles-catalog.md", 2,
                 "42 example design principles across 8 product categories.",
                 ["brief"], ["principles"], None),
    _CorpusEntry("ref-coverage", "coverage", "references/coverage.md", 2,
                 "UX coverage — the parts 12 screen archetypes need to be complete.",
                 ["missing", "completeness", "coverage"], ["what is missing", "archetype", "parts"], None),
    _CorpusEntry("ref-page-completeness", "page-completeness", "references/page-completeness.md", 2,
                 "Mandatory page skeleton + content floor — header/hero/sections/rich-footer minimums, no thin pass.",
                 ["landing", "completeness"], ["hero", "footer", "header", "feature-rows", "skeleton", "sections", "pricing-table", "faq"], 0),
    # Tier 3
    _CorpusEntry("ref-typography", "typography", "references/typography.md", 3,
                 "Type scale, font choice, readability, weight — scoped per script and role.",
                 ["typography"], ["modular-scale", "font-loading", "optical-sizing"], None),
    _CorpusEntry("ref-motion", "motion", "references/motion.md", 3,
                 "Decision ladder, duration + easing scales, interaction rules, choreography, rendering performance.",
                 ["motion", "performance"],
                 ["easing-scale", "duration-scale", "flip", "reduced-motion", "motion-budget"], None),
    _CorpusEntry("ref-modern-css", "modern-css", "references/modern-css.md", 3,
                 "View Transitions, scroll timelines, container queries, @starting-style, anchor positioning, mask-image fades.",
                 ["css"],
                 ["view-transitions", "container-queries", "popover", "anchor-positioning", "mask-image", "scrollbar-gutter"],
                 None),
    _CorpusEntry("ref-responsive", "responsive", "references/responsive.md", 3,
                 "Mobile/tablet/desktop, breakpoints, touch zones, thumb-first design.",
                 ["responsive"], ["breakpoints", "thumb-zone", "safe-areas"], None),
    _CorpusEntry("ref-metadata", "metadata", "references/metadata.md", 3,
                 "Title/description/canonical consistency, social cards, noindex on staging, structured data honesty, favicons.",
                 ["metadata"], ["open-graph", "canonical", "favicons"], None),
    _CorpusEntry("ref-copy", "copy", "references/copy.md", 3,
                 "Voice/tone matrix, reading level, terminology, inclusive language, errors, empty states, CTAs.",
                 ["copy"], ["voice-matrix", "error-messages", "empty-states", "ctas"], None),
    _CorpusEntry("ref-sound", "sound", "references/sound.md", 3,
                 "Web Audio, UI sound, appropriateness matrix.",
                 ["sound"], ["web-audio"], None),
    # Tier 4
    _CorpusEntry("ref-stack", "stack", "references/stack.md", 4,
                 "Three.js / GSAP / Motion. OPT-IN ONLY.",
                 ["stack"], ["gsap", "threejs", "framer-motion", "scrolltrigger"], None),
    _CorpusEntry("ref-heuristics", "heuristics", "references/heuristics.md", 4,
                 "Nielsen's 10 + 6 design laws + 1-5 rubric.",
                 ["heuristic"], ["nielsen", "fitts", "hicks"], None),
    _CorpusEntry("ref-personas", "personas", "references/personas.md", 4,
                 "5 persona walkthroughs — first-timer, power, low-bandwidth, screen-reader, one-thumb.",
                 ["heuristic"], ["walkthroughs"], None),
    _CorpusEntry("ref-state-design", "state-design", "references/state-design.md", 4,
                 "State lattice — idle / loading / empty / error / partial / conflict / offline.",
                 ["states"], ["state-lattice"], None),
    _CorpusEntry("ref-dataviz", "dataviz", "references/dataviz.md", 4,
                 "Cleveland-McGill perceptual hierarchy, chart selection matrix, palettes, Tufte, direct labeling.",
                 ["dataviz"], ["chart-selection", "cleveland-mcgill", "okabe-ito"], None),
]

OUT_OF_SCOPE: list[dict[str, str | list[str]]] = [
    {
        "id": "native-mobile",
        "label": "Native mobile screens",
        "triggers": ["react native", "swiftui", "swift ui", "uikit", "jetpack compose", "native screen", "native app screen"],
        "use": "Apple HIG or Material directly — these references cover web surfaces.",
    },
    {
        "id": "code-editor",
        "label": "Code-editor surfaces",
        "triggers": ["code editor", "syntax highlight", "syntax highlighting", "monaco", "codemirror", "diff viewer", "editor gutter"],
        "use": "Monaco or CodeMirror with their own theming API.",
    },
    {
        "id": "html-email",
        "label": "HTML email",
        "triggers": ["html email", "email template", "newsletter template", "mjml", "transactional email"],
        "use": "MJML or a dedicated email framework — the CSS rules here are void in mail clients.",
    },
    {
        "id": "realtime-collab",
        "label": "Realtime collaboration UI",
        "triggers": ["live cursor", "live cursors", "presence indicator", "collaborative editing", "operational transform", "multiplayer cursor"],
        "use": "A different problem class — the recipes assume a single actor.",
    },
]


# ---------------------------------------------------------------------------
# Signal ladder
# ---------------------------------------------------------------------------

_SIGNAL_NAME_EXACT = 100
_SIGNAL_KEYWORD_EXACT = 60
_SIGNAL_CONTAINS_EXACT = 45
_SIGNAL_NAME_FUZZY = 40
_SIGNAL_KEYWORD_FUZZY = 25
_SIGNAL_SUMMARY_WORD = 12

_COVERAGE_BONUS = 25
_SCORE_FLOOR = 20
_RELEVANT_RATIO = 0.6
_FUZZY_MIN_LENGTH = 5
_FUZZY_MAX_DISTANCE = 2


# ---------------------------------------------------------------------------
# Reverse synonym index
# ---------------------------------------------------------------------------

_ALIAS_TO_CONCEPTS: dict[str, list[str]] = {}
for _concept, _aliases in SYNONYMS.items():
    def _register(word: str, target: str = _concept) -> None:
        existing = _ALIAS_TO_CONCEPTS.get(word)
        if existing:
            if target not in existing:
                existing.append(target)
        else:
            _ALIAS_TO_CONCEPTS[word] = [target]
    _register(_concept)
    for _alias in _aliases:
        _register(_alias)


# ---------------------------------------------------------------------------
# Normalisation
# ---------------------------------------------------------------------------

def _deaccent(word: str) -> str:
    nfkd = unicodedata.normalize("NFD", word)
    return "".join(c for c in nfkd if unicodedata.category(c) != "Mn")


_MIN_STEM = 5
_STEM_RULES: list[tuple[re.Pattern, str]] = [
    (re.compile(r"ing$"), ""),
    (re.compile(r"ies$"), "y"),
    (re.compile(r"es$"), ""),
    (re.compile(r"s$"), ""),
]


def stem(word: str) -> str:
    for pattern, replacement in _STEM_RULES:
        if not pattern.search(word):
            continue
        next_word = pattern.sub(replacement, word)
        if len(next_word) >= _MIN_STEM or len(next_word) == len(word):
            return next_word
    return word


def tokenize(prompt: str) -> list[str]:
    text = str(prompt).lower()
    # Keep letters, digits, whitespace, and hyphens; replace everything else
    text = re.sub(r"[^\w\s-]+", " ", text, flags=re.UNICODE)
    tokens = text.split()
    tokens = [t.strip("-") for t in tokens]
    tokens = [t for t in tokens if t]
    tokens = [_deaccent(t) for t in tokens]
    return [t for t in tokens if len(t) > 1 and t not in STOPWORDS and not t.isdigit()]


def edit_distance(a: str, b: str, max_dist: int = _FUZZY_MAX_DISTANCE) -> int:
    if a == b:
        return 0
    if abs(len(a) - len(b)) > max_dist:
        return max_dist + 1
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        curr = [i]
        row_min = i
        for j in range(1, len(b) + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            curr.append(min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost))
            if curr[j] < row_min:
                row_min = curr[j]
        if row_min > max_dist:
            return max_dist + 1
        prev = curr
    return prev[len(b)]


class _Concept(NamedTuple):
    token: str
    stem_: str
    concept_ids: list[str]
    words: list[str]


def to_concepts(prompt: str) -> list[_Concept]:
    tokens = tokenize(prompt)
    concepts: list[_Concept] = []
    seen_keys: set[str] = set()

    for token in tokens:
        stemmed = stem(token)
        concept_ids = _ALIAS_TO_CONCEPTS.get(token, _ALIAS_TO_CONCEPTS.get(stemmed, []))
        key = f"concept:{'+'.join(concept_ids)}" if concept_ids else f"token:{stemmed}"
        if key in seen_keys:
            continue
        seen_keys.add(key)

        words = {token, stemmed}
        for cid in concept_ids:
            words.add(cid)
            for alias in SYNONYMS.get(cid, []):
                words.add(_deaccent(alias))
        concepts.append(_Concept(token=token, stem_=stemmed, concept_ids=concept_ids, words=sorted(words)))
    return concepts


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def _score_concept(entry: _CorpusEntry, concept: _Concept) -> int:
    name = _deaccent(entry.name.lower())
    name_stem = stem(name)
    keywords = [_deaccent(k.lower()) for k in entry.keywords]
    contains = [_deaccent(c.lower()) for c in entry.contains]
    summary_words = {stem(w) for w in tokenize(entry.summary)}

    for w in concept.words:
        if name == w or name_stem == stem(w):
            return _SIGNAL_NAME_EXACT

    for w in concept.words:
        if w in keywords or any(stem(k) == stem(w) for k in keywords):
            return _SIGNAL_KEYWORD_EXACT

    for w in concept.words:
        if w in contains or any(stem(c) == stem(w) or w in c.split("-") for c in contains):
            return _SIGNAL_CONTAINS_EXACT

    if len(concept.token) >= _FUZZY_MIN_LENGTH:
        if edit_distance(concept.token, name) <= _FUZZY_MAX_DISTANCE:
            return _SIGNAL_NAME_FUZZY
        if any(
            len(k) >= _FUZZY_MIN_LENGTH and edit_distance(concept.token, k) <= _FUZZY_MAX_DISTANCE
            for k in keywords
        ):
            return _SIGNAL_KEYWORD_FUZZY

    for w in concept.words:
        if stem(w) in summary_words:
            return _SIGNAL_SUMMARY_WORD

    return 0


def _score_entry(entry: _CorpusEntry, concepts: list[_Concept]) -> tuple[int, list[str]]:
    if not concepts:
        return 0, []
    per_concept = [(c, _score_concept(entry, c)) for c in concepts]
    matched = [(c, s) for c, s in per_concept if s > 0]
    if not matched:
        return 0, []

    strongest = max(s for _, s in matched)
    if strongest <= _SIGNAL_SUMMARY_WORD and len(matched) < 2:
        return 0, []

    coverage = len(matched) / len(concepts)
    score = round((strongest + coverage * _COVERAGE_BONUS) * 10) / 10
    return score, [c.token for c, _ in matched]


# ---------------------------------------------------------------------------
# Repair / out-of-scope
# ---------------------------------------------------------------------------

_REPAIR_SET = {m.lower() for m in REPAIR_MARKERS}


def is_repair_intent(prompt: str) -> bool:
    text = str(prompt).lower()
    text = re.sub(r"[^\w\s-]+", " ", text, flags=re.UNICODE)
    return any(_deaccent(w) in _REPAIR_SET for w in text.split())


def out_of_scope_matches(prompt: str) -> list[dict[str, str]]:
    haystack = " " + re.sub(r"[^a-z0-9]+", " ", _deaccent(str(prompt).lower())) + " "
    results = []
    for entry in OUT_OF_SCOPE:
        triggers = entry["triggers"]
        assert isinstance(triggers, list)
        for t in triggers:
            if f" {t} " in haystack:
                results.append({"id": entry["id"], "label": entry["label"], "use": entry["use"]})
                break
    return results


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------

class RouteResult(NamedTuple):
    prompt: str
    concepts: list[str]
    intent: str  # "build" | "repair"
    references: list[dict]  # [{name, path, summary, score, matched, tier}]
    always_load: list[str]
    out_of_scope: list[dict[str, str]]
    instruction: str


def route(prompt: str, limit: int = 4) -> RouteResult:
    max_refs = max(1, min(limit, 12))
    empty = RouteResult(
        prompt=str(prompt or ""),
        concepts=[],
        intent="build",
        references=[],
        always_load=[],
        out_of_scope=[],
        instruction="",
    )
    if not prompt or not str(prompt).strip():
        return RouteResult(
            **{**empty._asdict(), "instruction": "Empty prompt — nothing to route."}
        )

    concepts = to_concepts(prompt)
    scope = out_of_scope_matches(prompt)

    if not concepts:
        return RouteResult(
            **{
                **empty._asdict(),
                "out_of_scope": scope,
                "instruction": (
                    "Nothing in that prompt survived stopword removal, so there is nothing to rank. "
                    "Ask the user what surface they want (dashboard, landing page, auth screen, form…)."
                ),
            }
        )

    scored = []
    for entry in CORPUS:
        score, matched = _score_entry(entry, concepts)
        if score >= _SCORE_FLOOR:
            scored.append((entry, score, matched))

    scored.sort(key=lambda r: (-r[1], r[0].priority if r[0].priority is not None else 1, r[0].id))

    references = []
    for entry, score, matched in scored[:max_refs]:
        references.append({
            "name": entry.name,
            "path": entry.path,
            "summary": entry.summary,
            "score": score,
            "matched": matched,
            "tier": entry.tier,
        })

    # Promote recipes within relevance band
    top_score = scored[0][1] if scored else 0
    promoted = {
        entry.id
        for entry, score, _ in scored
        if entry.id.startswith("ref-recipe-") and score >= top_score * _RELEVANT_RATIO
    }
    if promoted:
        head = [r for r in references if any(
            e.id in promoted for e in CORPUS if e.path == r["path"]
        )]
        rest = [r for r in references if r not in head]
        references = head + rest

    always_load = [e.path for e in CORPUS if e.tier == 1]
    always_load = [p for p in always_load if not any(r["path"] == p for r in references)]

    repair = is_repair_intent(prompt)

    if not scored:
        instruction = (
            f'Nothing matched "{prompt}" above the noise floor. That is a real answer, not a fallback: '
            "the surface may be outside the library. Ask the user to state it directly "
            "(dashboard, landing page, auth screen, form), then apply the core rules anyway."
        )
    else:
        ref_paths = ", ".join(r["path"] for r in references)
        instruction = f"Load these references before writing any code: {ref_paths}. "
        if repair:
            instruction += (
                "This request describes something that already exists and is wrong — "
                "run a review/repair pass over existing code rather than building a new surface. "
            )
        instruction += "Discovery still runs first: analyze the project for existing tokens/fonts, or ask the Quick Ask questions."

    if scope:
        scope_str = " ".join(f"{s['label']} → {s['use']}" for s in scope)
        instruction += f" Out of scope: {scope_str} Say so rather than producing web guidance for it."

    return RouteResult(
        prompt=str(prompt),
        concepts=[c.token for c in concepts],
        intent="repair" if repair else "build",
        references=references,
        always_load=always_load,
        out_of_scope=scope,
        instruction=instruction,
    )


# ---------------------------------------------------------------------------
# Reference access
# ---------------------------------------------------------------------------

def list_references() -> list[dict]:
    """Manifest of every available reference."""
    return [
        {"name": e.name, "path": e.path, "summary": e.summary, "tier": e.tier}
        for e in CORPUS
    ]


def read_reference(name_or_path: str) -> dict:
    """Read one reference by corpus name or kit-relative path."""
    entry = None
    for e in CORPUS:
        if e.name == name_or_path or e.path == name_or_path or f"{e.name}.md" == name_or_path:
            entry = e
            break

    rel = entry.path if entry else str(name_or_path)
    abs_path = (_KIT_ROOT / rel).resolve()

    # Security: reject path traversal
    if not str(abs_path).startswith(str(_KIT_ROOT.resolve())):
        raise ValueError(f"Path escapes the kit directory: {rel}")

    if not abs_path.exists():
        raise FileNotFoundError(f"Reference not found: {rel}")

    content = abs_path.read_text(encoding="utf-8")
    return {"name": entry.name if entry else None, "path": rel, "content": content}


# Tier-4 references are opt-in only (per the routing table): they stay
# rankable as pointers in route() but are NEVER auto-loaded into the prompt.
# stack.md alone is 21KB — auto-loading it pushed every 3D-mentioning request
# over the provider wire limit before a single tool ran.
_TIER4_NO_AUTOLOAD = {"stack", "heuristics", "personas", "state-design", "dataviz"}

# Keep automatic reference context small; detailed material remains available
# through read_ui_reference when a task needs it.
_REF_BUDGET_CHARS = 12_000


def _tier_of(path: str) -> int | None:
    for e in CORPUS:
        if e.path == path:
            return e.tier
    return None


def _name_of(path: str) -> str | None:
    for e in CORPUS:
        if e.path == path:
            return e.name
    return None


def load_references(prompt: str, limit: int = 2) -> dict:
    """Route a prompt and read the ranked references.

    Load only the highest-ranked relevant references (tier-4 opt-ins remain
    pointers). Total content is capped at _REF_BUDGET_CHARS; deeper material
    can be requested through read_ui_reference.
    """
    result = route(prompt, limit)

    # Filter to relevant band, dropping tier-4 opt-in refs from auto-load
    # (they remain visible in result.references as pointers for the read tool).
    top_score = max((r["score"] for r in result.references), default=0)
    ranked = [
        r["path"]
        for r in result.references
        if r["score"] >= top_score * _RELEVANT_RATIO
        and (_name_of(r["path"]) or "") not in _TIER4_NO_AUTOLOAD
    ][:limit]

    # Ranking already reflects request relevance. Avoid broad layout/craft/
    # completeness pins that make unrelated pages inherit extra requirements.
    ordered = list(dict.fromkeys(ranked))

    # Strict budget fill: whole file if it fits, else truncate this one file
    # with a read-tool pointer and stop. Never overshoot.
    loaded = []
    seen: set[str] = set()
    used = 0
    for p in ordered:
        if p in seen:
            continue
        seen.add(p)
        try:
            ref = read_reference(p)
        except (FileNotFoundError, ValueError):
            continue
        content = ref.get("content", "")
        remaining = _REF_BUDGET_CHARS - used
        if remaining <= 0:
            break
        truncated = False
        if len(content) > remaining:
            notice = (
                f"\n\n[... shortened to fit the reference budget; "
                f"use read_ui_reference('{ref.get('name', p)}') for more.]"
            )
            content = content[:max(0, remaining - len(notice))] + notice
            truncated = True
        used += len(content)
        ref["content"] = content
        loaded.append(ref)
        if truncated:
            break

    loaded_paths = [r["path"] for r in loaded]
    pointed = [
        r["name"] for r in result.references
        if r["path"] not in loaded_paths
        and (_name_of(r["path"]) or "") in _TIER4_NO_AUTOLOAD
    ]
    instruction = result.instruction
    if pointed:
        instruction += (
            f" Opt-in only, NOT pre-loaded (pull via read_ui_reference only if "
            f"the task genuinely needs it): {', '.join(pointed)}. "
            f"Loaded into context now: {', '.join(loaded_paths)}."
        )

    return {
        "prompt": result.prompt,
        "concepts": result.concepts,
        "intent": result.intent,
        "references": result.references,
        "always_load": result.always_load,
        "out_of_scope": result.out_of_scope,
        "instruction": instruction,
        "loaded": loaded,
    }


def get_reference_names() -> list[str]:
    """Return just the names for the read_ui_reference tool."""
    return [e.name for e in CORPUS]
