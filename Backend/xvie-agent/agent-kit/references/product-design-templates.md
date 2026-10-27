# Product / Design Templates + Direction Contract

## PRODUCT template (durable product truth — NEVER aesthetics here)

```md
# PRODUCT — <project>
<!-- product-schema 1 -->
## Users
## Purpose
## Positioning
## Operating Context
## Capabilities / Constraints
## Brand Commitments
## Evidence (state absences — never fabricate)
## Principles (3–5)
## Accessibility
## Platform: web
```

Interview ≤3 questions/round: (1) who / situation / job,
(2) mechanism / positioning, (3) constraints / assets / evidence.

## DESIGN template (durable visual decisions)

```md
---
colors: { primary: ..., neutral: ..., accent: ... }
typography: { display: ..., body: ..., mono: ... }
spacing: { base: 8, scale: [8,16,24,32,48,80,112] }
shapes: { radius: ..., elevation: ... }
components: [button, bento, section, badge, toast, modal, empty]
---
# DESIGN — <project>
## Overview
## Colors (strategy first: Restrained default)
## Typography
## Layout
## Elevation & Depth
## Shapes
## Components (reuse kit before inventing)
## Do's and Don'ts
```

Tokens live in `design-tokens-starter.css` (vanilla) or `theme.extend`
mirror (Tailwind). Page CSS references via `var()` only.

## Direction contract (~150 words, written BEFORE code)

```md
## THESIS (owns + refuses)
## OWN-WORLD (recognizable with content removed)
## STORY (understand / believe / do)
## FIRST VIEWPORT (exact composition + primary action)
## FORM (position + seed key)
## FINISH
## Delight thesis: <feeling> because <product reason>; moment: <where>; budget: <cost/frequency>
FINISH: unreviewed and undocumented is unfinished.
```

One authored focal moment per site — product-specific, never generic
fade-rise / hover-lift / parallax / reveal.
