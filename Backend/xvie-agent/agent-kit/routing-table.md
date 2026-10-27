# Reference Library — Routing Table

The router pre-loads the top-ranked references for each request. If the current task touches a row below whose reference is NOT already in context, call `read_ui_reference(name)` before proceeding. Tier 1 rows are required reading before writing any UI.

## Tier 1 — always load before writing UI

| Reference | Read it for |
|-----------|-------------|
| `craft-intent` | Craft Read line, DESIGN_VARIANCE, signature bets, product vs marketing build patterns |
| `tokens` | The 3-layer token spine (primitive → semantic → component), radius/spacing/z-index scales |
| `inspiration` | Pattern archetypes from mature SaaS, signature details, what mature interfaces never do |
| `accessibility` | WCAG, keyboard nav, focus management, ARIA, touch targets |
| `color` | Palette strategy, OKLCH scales, dark mode, accent budget, APCA contrast |
| `layout` | Gestalt grouping, spacing rhythm, hierarchy ratios, composition strategies |

## Tier 2 — surface-specific

| Reference | Trigger |
|-----------|---------|
| `recipe-dashboard` | Building any dashboard/admin/analytics surface |
| `recipe-landing` | Building any marketing page/homepage/pricing page |
| `recipe-auth` | Building sign-in/sign-up screens |
| `themes` | No token system exists — pick a named production preset (Graphite, Porcelain, Carbon, Signal) |
| `dashboard` | Dashboard patterns: metric cards, charts, tables, sidebar, filters, density |
| `forms` | Any form beyond trivial: validation timing, wizards, autosave, checkout |
| `components` | Anatomy contracts: buttons, menus, modals, search, cards, nav bar |
| `ai-chat` | Chat/streaming AI surfaces: streaming contract, tool traces, citations |
| `review` | Reviewing or refining existing UI; Polish Pass details |
| `finish-bar` | Pre-ship finishing protocol (10 passes) |
| `loops` | Iterating a surface until a quality bar passes instead of one-shot output |
| `principles-catalog` | Seed principles when writing a project design brief |
| `coverage` | "What is this screen missing?" — completeness parts for 12 screen archetypes |
| `spec` | Durable composition spec format per surface |

## Tier 3 — foundations (read for the relevant discipline)

| Reference | Trigger |
|-----------|---------|
| `typography` | Type scale, font choice, weight hierarchy, readability |
| `motion` | Easing/duration scales, choreography, animation performance |
| `modern-css` | View Transitions, container queries, popover, anchor positioning |
| `responsive` | Breakpoints, touch zones, thumb-first layout |
| `metadata` | Title/canonical/social cards/favicons correctness |
| `copy` | UX microcopy: errors, empty states, CTAs, voice/tone |
| `sound` | Web Audio UI feedback (only when explicitly requested) |

## Tier 4 — opt-in only

| Reference | Trigger |
|-----------|---------|
| `stack` | GSAP / Three.js / Motion — ONLY if the user opted in during Discovery |
| `heuristics` | Scored usability critique (Nielsen 10 + 6 design laws) |
| `personas` | Persona walkthroughs (first-timer, power user, screen-reader…) |
| `state-design` | Non-happy states: idle/loading/empty/error/partial/conflict/offline |
| `dataviz` | Chart selection, perceptual hierarchy, palettes for data |

## Out of scope (say so, name the right tool)

Native mobile (→ Apple HIG/Material) · Code-editor surfaces (→ Monaco/CodeMirror) · HTML email (→ MJML) · Realtime collaboration UI (→ Liveblocks/Yjs).
