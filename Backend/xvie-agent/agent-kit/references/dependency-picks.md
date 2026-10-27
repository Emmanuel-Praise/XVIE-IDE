# Dependency Picks (one pick per need — check package.json first)

Mirrors the curated-dependency discipline: never hand-roll what a
well-maintained library owns. Violations are advisory
(`collect_design_warnings` does not check this; reviewers do).

| Need | Pick | Notes |
|---|---|---|
| primitives / dialog / popover | `base-ui` | Floating-UI positioning, no div-dropdowns |
| command-K | `cmdk` | — |
| toast | `sonner` | One `<Toaster/>` at root; styling ladder defaults → `toastOptions` → headless |
| OTP | `input-otp` | — |
| animation / springs / layout / exit | `motion` | Full `transform` strings; spring `{duration:0.5,bounce:0.2}` |
| animated numbers | `numberflow` | Never re-render tween numbers |
| animated text | `torph` | — |
| 3D globe | `cobe` | Pointer-driven; Canvas2D fallback |
| OG images | `satori` | — |
| code highlight | `shiki` | — |
| realtime chart | `liveline`, else `recharts` | — |
| drag-and-drop | `dnd-kit` | — |
| long lists | `virtuoso` | Virtualize past ~100 rows |
| state | `zustand` | No prop-drilling |
| classnames | `clsx` ad-hoc / `cva` variants | No nested-ternary class soup |
| theme | `next-themes` | — |

**Fail review (advisory):** hand-rolled toast, div dropdown, number
re-render tween, 1000-row unvirtualized list, prop-drilled theme state.
**Never install two animation libraries animating the same property.**
See `stack.md` (library decision tree) and `stack-choice.md` (vanilla-CDN
vs Tailwind-Vite snippets).
