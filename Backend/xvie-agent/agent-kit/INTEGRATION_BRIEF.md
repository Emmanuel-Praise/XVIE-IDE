# INTEGRATION BRIEF — READ BEFORE MODIFYING THE HOST CODEBASE

You are the AI engineer wiring this design system (`agent-kit/`) into the host agentic product. Follow this brief exactly. Do not improvise alternative architectures — this one is measured and deliberate. Verify your work with the acceptance criteria at the bottom before reporting done.

## Context

This kit gives the host LLM agent real UI design skill. It was cut from [ui-craft](https://github.com/educlopez/ui-craft) for one purpose: stop first-pass AI-slop output (gradient cards, uniform grids, bounce easing, default-blue-Inter). It has three layers that must all be wired — a partial install silently loses most of the value:

1. **Taste core** — `system-prompt-core.md` + `routing-table.md` → always in the system prompt.
2. **Reference routing** — `router/route.mjs` → per-request, pre-loads only the relevant references into context.
3. **Discovery** — project scan / Quick Ask → runs before any generation, never skipped.

## Required modifications to the host codebase

### 1. System prompt assembly

Prepend, verbatim and in order:

```
<contents of system-prompt-core.md>
<contents of routing-table.md>
```

Do not summarize, trim, or paraphrase these files when injecting them. The anti-slop lists lose their force when compressed — models "remember" rules they saw verbatim far better than rules described to them. If prompt budget is tight, reduce elsewhere; never here.

### 2. Per-request context (the router)

Before every generation call, call `loadReferences(userRequest, { limit: 4 })` and inject `routed.loaded[].content` into the context after the core files. Rules:

- Inject the full text of each loaded reference, wrapped with its path as a comment header (see `examples/orchestrator.mjs`).
- Also inject `routed.instruction` — it carries intent (`build` vs `repair`) and out-of-scope warnings.
- **Never bypass the router** by loading all of `references/`. The whole library is ~460KB; loading everything degrades output and cost. The relevance band is the feature.
- If `routed.intent === 'repair'`, frame the task as review/fix of existing code, not a rebuild.
- If `routed.out_of_scope` is non-empty, surface its `use` recommendation to the user instead of producing web guidance for native mobile / HTML email / code-editor surfaces.

### 3. Read tool (mandatory)

Register a tool named `read_ui_reference` backed by `readReference(name)`:

```js
import { listReferences, readReference } from './router/route.mjs';
// name must be one of listReferences()[].name; readReference rejects path traversal.
```

The tool description must tell the model to consult the routing table and pull any reference whose trigger matches but which was not pre-loaded. Without this tool, mid-task needs (forms validation timing, dataviz chart choice, state design) go unmet and quality regresses exactly where surfaces get complex.

### 4. Discovery hook (mandatory)

Before any build request:

- Scan the user's project for existing tokens/fonts (CSS variables, Tailwind config, font imports). Found → pass the inventory as constraints; respect them.
- Not found → ask the Quick Ask once per project (style, accent color, font, animation library) and cache the answers. Skip if the user already specified preferences in the request itself.

Cache answers per user project (keyed by project id), not per session. Re-asking every session is the single fastest way to make users hate this feature.

## Acceptance criteria — verify all before reporting done

1. `node agent-kit/router/smoke.test.mjs` exits 0.
2. A generated dashboard request produces a system prompt containing: both core files verbatim, `recipe-dashboard.md`, `dashboard.md`, `craft-intent.md`, and nothing below the relevance band.
3. `"this modal is janky"` routes with `intent: 'repair'` and does NOT load `recipe-*` content.
4. A React Native request returns the out-of-scope warning to the user.
5. The `read_ui_reference` tool resolves `forms` and rejects `../package.json`.
6. No request path loads more than ~15K tokens of reference content.
7. Discovery fires exactly once per project and its answers persist across sessions.

## Later upgrades (do NOT build now unless explicitly asked)

Post-generation scoring + regenerate loop (`npx ui-craft-detect`, MCP `score_ui`, contract in `references/loops.md`) and durable per-project design memory at `.ui-craft/brief.md` + `tokens.md` (formats in `references/brief.md`, `references/tokens.md`). These are documented in `README.md`.

## Updating this kit

Content is vendored from upstream ui-craft. To refresh: re-copy `skills/ui-craft/references/` over `references/`, diff `route-data.mjs` for corpus changes, re-run the smoke tests. Preserve MIT attribution.
