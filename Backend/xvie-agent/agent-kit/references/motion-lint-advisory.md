# Motion / Slop Lint — Advisory (warn-only, never blocking)

Status: ADVISORY. Report issues as warnings; do NOT fail verification.
Each item ships its grep pattern so models can self-check before finishing.
Promotion to enforced validators is a separate phase.

## Motion bans (self-check patterns)

| # | Ban | Grep pattern | Fix |
|---|---|---|---|
| M1 | `transition: all` | `transition\s*:\s*all` | List exact props |
| M2 | `scale(0)` start | `scale\(\s*0\s*\)` | Start `scale(0.95)+opacity:0` |
| M3 | `ease-in` on enter | `ease-in(?!-out)` near enter/mount | Use `var(--ease-out)` |
| M4 | UI animation `>300ms` | `(\d{3,})ms` / `(\d+\.\d+)s` in transition/animation | Cap 300ms (focal exempt ≤800ms) |
| M5 | Layout-prop animation | `transition[^;]*(width\|top\|left\|height)` (`height` tolerated only accordion) | Animate `transform`/`opacity`/`clip-path` |
| M6 | Animated `blur()` > 20px | `blur\(\s*([2-9]\d|\d{3,})px` | Bound ≤20px, isolate layer |
| M7 | Keyframes on toast/toggle | `@keyframes` + toast/toggle selectors | Use transitions (interruptible) |
| M8 | `origin:center` popover | `transform-origin\s*:\s*center` | `var(--transform-origin)` from trigger |
| M9 | Missing reduced-motion | animation present AND no `prefers-reduced-motion` | Add alternative block |
| M10 | Ungated hover | `:hover` without `(hover:hover) and (pointer:fine)` | Gate hover styles |

## Slop bans (craft-floor merge)

S1 identical icon+heading+text card grids (≥3 `.feature-card`) → alternating
asymmetric rows. S2 nested cards. S3 hero-metric template. S4 eyebrow/kicker
above heading. S5 `01/02/03` section numbers. S6 modal-by-reflex. S7 gradient
text. S8 glass/blur decoration. S9 `border-left/right > 1px` stripe. S10
emoji/glyph icons → inline SVG, one stroke. S11 theme-by-category.
S12 `text-align:center` > 3 → left-align body/cards/lists.

## Type / copy guards

Body 45–75ch, ≥16px, leading 1.5–1.8; display ≤6rem; tracking floor `-0.04em`;
headings `balanced`. Banned display faces: Fraunces, Playfair, Cormorant, Lora,
Syne, Space Grotesk/Mono, IBM Plex, Inter-as-display, DM Sans/Serif, Outfit,
Plus Jakarta, Instrument. No em-dash saturation, no buzzword stacks.

## Advisory report format

```md
## Advisory lint (warn-only)
| Check | Result | File:line |
| Before | After | Why |
```
