# Stack Choice (snippets + guidance only — no scaffold generator)

Ask ONCE per project, cache in `.xvie/design-memory.json` as `stack`
(`vanilla` | `tailwind`). Never re-ask once cached.

## Decision rule

- Landing page / single-file site / prototype → **vanilla** (HTML + CSS + JS, CDN libs).
- Multi-route app / dashboard / component-heavy UI → **tailwind** (Tailwind + Vite + npm).
- Same token values back both paths (`design-tokens-starter.css` ↔ `theme.extend` mirror).

## Vanilla path (CDN)

```html
<link rel="stylesheet" href="./design-tokens-starter.css">
<link rel="stylesheet" href="./style.css">
<!-- Motion for springs/layout/exit/gesture only; CSS handles the rest -->
<script type="module">
  import { animate } from 'https://cdn.jsdelivr.net/npm/motion@latest/dist/motion.js';
</script>
<!-- Optional: GSAP + ScrollTrigger for pinned/scrubbed timelines (non-React) -->
<!-- <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script> -->
<!-- Optional: Cobe for 3D globes -->
<!-- <script src="https://cdn.jsdelivr.net/npm/cobe@latest/dist/cobe.js"></script> -->
```

Guards: `@supports` around modern CSS, lazy-init near viewport
(`IntersectionObserver`), pause offscreen/hidden, `prefers-reduced-motion`
alternative. Never install two animation libraries animating the same property.

## Tailwind path (npm)

```bash
npm install motion sonner
# Add per need only: cmdk | base-ui | input-otp | numberflow | cobe | virtuoso | zustand | next-themes
```

```js
// tailwind.config — mirror design-tokens-starter.css values exactly
theme: { extend: { /* colors, fontSize, spacing, borderRadius, transitionTimingFunction, transitionDuration */ } }
```

## Dependency discipline (one pick, check package.json first)

| Need | Pick |
|---|---|
| primitives / dialog / popover | `base-ui` |
| command-K | `cmdk` |
| toast | `sonner` (one `<Toaster/>` at root) |
| OTP | `input-otp` |
| animation / springs / layout / exit | `motion` |
| numbers | `numberflow` |
| 3D globe | `cobe` |
| long list | `virtuoso` |
| state | `zustand` |
| theme | `next-themes` |

Hand-rolled toast / div-dropdown / number re-render tween / 1000-row
unvirtualized list = fail review. See `stack.md` for the library decision tree.
