# ui-craft agent-kit

Design knowledge for a custom agentic coding system. Lift this folder into your product so your agent stops shipping AI-slop UI: real hierarchy, intentional tokens, and the anti-pattern list that catches "gradient cards + bounce animations" before it ships.

Adapted from [ui-craft](https://github.com/educlopez/ui-craft) (MIT). Keep the LICENSE attribution when you redistribute.

> **AI agent developing the host product?** Read `INTEGRATION_BRIEF.md` first — it specifies exactly what to modify, what never to change, and how to verify your work.

## What's in here

```
agent-kit/
├── system-prompt-core.md     # Layer 1 — always-on taste (~12KB). Prepend to your system prompt.
├── routing-table.md          # Compact index of all references. Also goes in the prompt.
├── references/               # 34 design reference files (recipes, foundations, opt-ins)
├── router/
│   ├── route.mjs             # Zero-dep deterministic router + reference reader
│   └── route-data.mjs        # Corpus: synonyms, stopwords, keywords, tiers
└── examples/
    └── orchestrator.mjs      # Working example of the full loop
```

## The 3 layers

### Layer 1 — Always-on taste (system prompt)

`system-prompt-core.md` holds the distilled rules: persona, knobs, Top 12, the full Anti-Slop Test, Craft Test, motion ladder, discovery protocol. Prepend it to your agent's system prompt. It was cut for generation — every line changes output behavior.

### Layer 2 — Per-request references (router)

Never load all ~460KB of references. For each user request:

```js
import { loadReferences } from './router/route.mjs';

const routed = loadReferences('analytics panel with KPIs and a data table', { limit: 4 });
// routed.references  → top-ranked files ("recipe-dashboard", "dashboard", …)
// routed.always_load → Tier-1 must-reads not already included
// routed.intent      → 'build' | 'repair' ("this modal is janky" = repair)
// routed.out_of_scope→ flags React Native / email / code-editor briefs
// routed.loaded      → same references with file contents read in
```

The router is lexical — no model call, no embeddings, no network. `"analytics panel"` reaches `recipe-dashboard.md` even though that filename never says analytics; `"pricing block"` reaches `recipe-landing.md`. Same input always routes the same way.

Inject `routed.loaded[].content` into context next to the core prompt. `examples/orchestrator.mjs` shows the full assembly.

### Layer 2b — The read tool (agent-driven fallback)

Expose `read_ui_reference` as a tool so the agent can pull extras mid-task (`forms`, `accessibility`, `dataviz`) using the routing table you put in the prompt:

```js
import { listReferences, readReference } from './router/route.mjs';

const readTool = {
  name: 'read_ui_reference',
  description: 'Read a ui-craft design reference by name',
  // ... map to your framework's tool schema
  run: ({ name }) => readReference(name).content,
};
```

`readReference()` accepts a corpus name or kit-relative path and rejects paths escaping the kit directory.

### Layer 3 — Discovery before generating

Bake into your flow before any build request:

1. **Scan the user's project** for existing tokens/fonts (CSS variables, Tailwind config, font imports). If found, respect them — pass the inventory as constraints.
2. **If none**, ask the Quick Ask once per project: style? accent color? font? animation library? Skip if the user already specified.
3. **Cache the answers** (see Design memory below).

This is what kills default-blue-Inter output. The exact questions are in `system-prompt-core.md`.

## Minimal wiring

```js
const system = [
  corePrompt,                    // Layer 1
  routingTable,                  // what exists + when to pull it
  routed.instruction,            // router verdict
  ...routed.loaded.map(r => r.content),  // Layer 2 pre-load
  discoveryContext(projectSignals),      // Layer 3
].join('\n');

await llm.create({ system, messages, tools: [readTool] });
```

## Optional upgrades (when you're ready)

| Upgrade | What it buys | Where to look |
|---------|--------------|---------------|
| **Design memory** | Persist taste across sessions: scaffold `.ui-craft/brief.md` + `tokens.md` per user project; inject both on every request | `references/brief.md`, `references/tokens.md` |
| **Post-generation scoring** | Deterministic 0–100 score + slop findings on your agent's output; log first, gate later | Upstream repo: `npx ui-craft-detect ./out`, MCP tool `score_ui`, or import `scripts/detect/scan` |
| **Regenerate loop** | If score < threshold, feed findings back for one fix round (see `references/loops.md` for the read→evaluate→fix-one→re-evaluate contract) | `references/loops.md` |
| **Acceptance bars** | Per-surface checklists (dashboard/landing/auth) to verify builds against | `mcp` package `acceptance_bar` tool |

## Updating

The kit vendors upstream at a point in time. To refresh content from a newer ui-craft release: re-copy `skills/ui-craft/references/` over `agent-kit/references/`, and diff `route-data.mjs` for corpus additions. Reference scoring logic rarely changes.

## Render review in Xvie

Xvie can capture full-page desktop and mobile screenshots and report browser
errors and horizontal overflow with the `review_ui_render` tool. Install the
optional dependency and Chromium once with `pip install -e .[visual]` and
`playwright install chromium --no-shell`. Screenshots are saved under
`.xvie/reviews/`. This provides rendered evidence and basic responsive checks;
the tool also asks the active model for one concise visual critique when the
provider accepts image inputs. Set `XVIE_VISION_MODEL` to choose a separate
vision-capable model; if image input is unsupported, screenshots and browser
diagnostics still work without blocking the task.

## License

Upstream ui-craft is MIT — free for commercial use. Preserve the copyright notice in redistributed copies.
