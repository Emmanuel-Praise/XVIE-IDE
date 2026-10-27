# Animation Recipes (copy-paste — fill in the blank, never blank-page)

Rules on EVERY recipe: GPU-only (`transform`/`opacity`, sanctioned `clip-path`);
interruptible (transitions for rapid-fire, springs carry velocity);
exit follows the enter path; asymmetric timing (slow deliberate in, snap out);
reduced-motion alternative included. UI chrome hard cap `<300ms` (focal exempt).

Tokens used: `--ease-out`, `--ease-in-out`, `--ease-drawer`, `--ease-focal`,
`--dur-feedback`, `--dur-state`, `--dur-layout`, `--dur-focal`, `--stagger-step`.
See `design-tokens-starter.css` and `motion.md`.

## 1. Button press (feedback)

```css
.btn { transition: transform var(--dur-feedback) var(--ease-out), box-shadow var(--dur-feedback) var(--ease-out); }
.btn:active { transform: scale(0.97); }
```

## 2. Origin-aware popover

```css
.popover {
  transform-origin: var(--transform-origin, top center);
  transition: transform var(--dur-state) var(--ease-out), opacity var(--dur-state) var(--ease-out);
}
/* Set --transform-origin from the trigger rect in JS; modal exempt (center). */
```

Enter with `@starting-style` for mount transitions:

```css
.popover { opacity: 1; transform: translateY(0) scale(1); }
@starting-style { .popover { opacity: 0; transform: translateY(4px) scale(0.98); } }
```

## 3. Tooltip + instant second hover (perceived perf)

```css
.tooltip { transition: opacity 125ms var(--ease-out), transform 125ms var(--ease-out); }
.tooltip[data-instant] { transition-duration: 0ms; }
/* Set data-instant on any tooltip shown within ~1s of the previous one. */
```

## 4. Modal + backdrop

```css
.backdrop { transition: opacity var(--dur-state) var(--ease-out); }
.modal { transition: transform var(--dur-layout) var(--ease-drawer), opacity var(--dur-state) var(--ease-out); }
@starting-style {
  .backdrop { opacity: 0; }
  .modal { opacity: 0; transform: translateY(12px) scale(0.98); }
}
```

## 5. Drawer (bottom sheet)

```css
.drawer { transform: translateY(0); transition: transform var(--dur-layout) var(--ease-drawer); }
.drawer[hidden] { transform: translateY(100%); }
/* translateY(100%) = own height. Dismiss on drag velocity |d|/ms > 0.11. */
```

## 6. Toast (Sonner-style, elegant not bouncy)

```css
.toast { transition: transform 400ms ease, opacity 250ms var(--ease-out); }
/* One <Toaster/> at root. Never keyframes on rapid-fire toasts. */
```

## 7. Accordion (`height` tolerated ONLY here)

```css
.accordion-panel { display: grid; grid-template-rows: 0fr; transition: grid-template-rows var(--dur-state) var(--ease-out); }
.accordion-panel[open] { grid-template-rows: 1fr; }
.accordion-inner { overflow: hidden; }
```

## 8. Stagger (lists-as-lists only, never blocks interaction)

```css
.list-enter > * { opacity: 0; transform: translateY(8px); animation: list-in var(--dur-state) var(--ease-out) forwards; }
.list-enter > *:nth-child(2) { animation-delay: 50ms; }
.list-enter > *:nth-child(3) { animation-delay: 100ms; }
/* Cap ~5 items; keep content interactive during the stagger. */
@keyframes list-in { to { opacity: 1; transform: none; } }
```

## 9. Hold-to-confirm (`clip-path` fill)

```css
.hold-btn { --p: 0%; }
.hold-btn::after { content: ""; clip-path: inset(0 calc(100% - var(--p)) 0 0); }
/* JS drives --p 0→100% on 2s linear press; release snaps 200ms ease-out. */
```

## 10. Tab indicator (duplicate + clip)

```html
<!-- Duplicate the active tab label in an overlay clipped to the pill. -->
```

```css
.tab-pill { clip-path: inset(0 100% 0 0); transition: clip-path var(--dur-state) var(--ease-out); }
.tab-active .tab-pill { clip-path: inset(0 0 0 0); }
```

## 11. Scroll reveal (IntersectionObserver, once)

```css
.reveal { clip-path: inset(0 0 100% 0); transition: clip-path var(--dur-layout) var(--ease-out), opacity var(--dur-state) var(--ease-out); opacity: 0; }
.reveal.in { clip-path: inset(0 0 0 0); opacity: 1; }
```

```js
const io = new IntersectionObserver(es => es.forEach(e => {
  if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
}), { rootMargin: '-100px' });
document.querySelectorAll('.reveal').forEach(el => io.observe(el));
```

## 12. Drag-dismiss (pointer capture + rubberband)

```js
// Velocity handoff: dismiss when |displacement|/ms > 0.11, else spring back.
// Track pointer with setPointerCapture; rubberband overshoot:
//   rubber = (overshoot * dim * 0.55) / (dim + 0.55 * |overshoot|)
```

## 13. Blur-masked crossfade (fixes double-exposure)

```css
.xfade { transition: opacity var(--dur-state) var(--ease-out), filter var(--dur-state) var(--ease-out); }
.xfade.swap { opacity: 0.7; filter: blur(2px); }
/* Blur(2px) masks the bad mid-crossfade frame no tuning can fix. */
```

## Programmatic (WAAPI over libraries for predetermined motion)

```js
el.animate(
  [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }],
  { duration: 250, easing: 'cubic-bezier(0.23,1,0.32,1)' }
);
```

## Springs (Motion — gesture/interruptible only)

```js
// { type: 'spring', duration: 0.5, bounce: 0.2 } — bounce 0.1–0.3.
// Animate the full `transform` string, never x/y/scale shorthands under load.
```

## Reduced motion (append to every build)

```css
@media (prefers-reduced-motion: reduce) {
  .popover, .modal, .drawer, .toast, .reveal { transition-duration: 0.01ms !important; }
}
```
