# Layout & Composition

Spatial reasoning, grouping principles, and hierarchy discipline. Tools (Flex, Grid) come last.

---

## Gestalt Grouping Principles

Perception organizes visual fields before conscious thought. Five laws govern how elements are read as groups:

**Proximity** — Elements closer together are perceived as related. Spacing is the primary grouping signal. Use it before borders, cards, or background fills.

**Similarity** — Elements that share shape, color, or size are perceived as the same kind of thing. Color-coding a column in a table exploits this; inconsistent icon weights break it.

**Common Region** — Elements inside a shared boundary (card, background, border) form a group. Use sparingly — every card is a visual tax. Ask: does this content need isolation, or does proximity alone suffice?

**Continuity** — The eye follows a line or curve through a layout. Aligning elements along an axis creates an implied path that guides the scan.

**Closure** — The eye completes incomplete shapes. Use this to reduce clutter: a partially-visible element (card cropped at viewport edge) signals "more exists" without a label.

### The primary rule: use spacing before structure

Before reaching for a card, background swatch, or divider line, try creating the group with spacing alone. If it reads, stop there. Structure adds visual weight and complexity — earn it.

---

## Spacing Rhythm

The most violated rule in UI. State it as an invariant:

> **Space within a group < space between groups < space between sections.**

Concrete: a form label 4px above its input, inputs in the same form 16px apart, the form itself 48px from the next section. If any of these relationships inverts, the grouping breaks.

### Scale

Use tokens from a defined set. Values come from the scale — never arbitrary.

```css
--space-xs:  0.25rem;   /* 4px  — label-to-input, icon-to-label */
--space-sm:  0.5rem;    /* 8px  — items within a group */
--space-md:  1rem;      /* 16px — related components */
--space-lg:  1.5rem;    /* 24px — sibling sections */
--space-xl:  2rem;      /* 32px — component-to-component */
--space-2xl: 3rem;      /* 48px — section separations */
--space-3xl: 4rem;      /* 64px — major page regions */
--space-4xl: 6rem;      /* 96px — hero-to-content, above-fold breathing room */
```

Use `gap` for sibling spacing — eliminates margin collapse and is the correct mental model.

Use `clamp()` for fluid spacing: `clamp(var(--space-lg), 4vw, var(--space-3xl))` scales without breakpoints.

**WHEN IT BREAKS:** Very dense data tables and compact UI patterns (command palettes, menus) compress this rhythm deliberately. At 100% zoom the hierarchy still holds — the scale values shrink proportionally. Never collapse two adjacent levels to the same value.

---

## Visual Hierarchy

### The Squint Test

Stand back, defocus your eyes, or apply a blur filter to the design. The image resolves to blobs of light and dark, size and contrast — text becomes unreadable. What you see is the page at the perceptual level of a first glance (~200ms).

At that level:

1. One thing should dominate — the primary action or headline.
2. A secondary cluster should appear next — supporting information.
3. The page structure (navigation, footer, sidebar) should be lowest in perceived weight.

Why it works: the human visual system applies a low-pass spatial frequency filter before conscious reading. The squint test simulates that filter. If hierarchy fails the squint test, users experience visual noise even if they cannot articulate why.

### Measurable Ratios

Four levels is the practical maximum for most UI. Beyond that, distinctions collapse.

| Level | Role | Signal |
|-------|------|--------|
| Primary | Page-defining element (hero headline, main CTA) | Largest, highest contrast, most visual weight |
| Secondary | Supporting structure (subheadings, section labels) | Minimum 1.5x smaller or lighter than primary |
| Tertiary | Body content, field labels, card titles | Readable, not competing |
| Quaternary | Metadata, timestamps, captions | Muted, clearly subordinate |

**Minimum 1.5x difference between adjacent levels** to create a clear distinction. A 1.2x difference reads as an accident, not a decision.

**WHEN IT BREAKS:** Typography pairs can carry hierarchy at identical size using weight + tracking — a 400/700 weight pair at 14px is a clear two-level system. In that case the size ratio rule yields to the type system. See `typography.md`.

### Hierarchy Tools (use in this order)

1. **Space** — generous whitespace isolates the primary element before you touch anything else
2. **Size** — scale differences above 1.5x register immediately
3. **Weight** — font-weight, border-weight, shadow depth
4. **Color** — last resort; adds semantic load and accessibility risk

Using all four at once creates noise. Mature interfaces use one or two.

---

### Serial Position Effect

First and last items in a sequence are remembered best (primacy + recency). Put the critical item first or last in nav lists, onboarding steps, and feature rows — never buried mid-sequence. Mid-list is where options go to be forgotten.

## Composition Strategies

### Symmetry vs. Asymmetry

Symmetry signals stability, formality, and confidence. Use it for hero sections, authentication flows, landing page headers.

Asymmetry signals energy, modernity, and movement. Use it for editorial layouts, feature showcases, dashboards with a dominant primary panel.

Avoid the default of centered-everything — it reads as unsophisticated because it makes no compositional decision. Left-aligned layouts with deliberate asymmetric weight distribution feel more considered.

### Focal Point

Every layout needs exactly one focal point — the element the eye arrives at first. If you have two competing elements at the same visual weight, one of them is wrong. Remove hierarchy from one or subordinate it spatially.

### Optical Center vs. Geometric Center

The geometric center of a rectangle is at 50% vertical. The optical center is 5–8% above that. Content positioned at the optical center feels balanced; content at true geometric center reads as slightly low.

This matters most for:
- Modal dialogs — vertically centered modals in a viewport look sunken; use `align-items: center` with a slight upward offset or top-biased margins
- Icon placement within a bounding box — a 24×24 icon with a visually tall glyph needs a −1px vertical nudge
- Above-the-fold hero sections — weight the primary element in the upper optical zone

### Rule of Thirds (use only with hero imagery)

The rule of thirds creates dynamic tension by placing subjects at grid intersections rather than center. In interfaces without strong photographic content it adds complexity without benefit. Reserve it for editorial layouts and landing pages with full-bleed images.

---

## Alignment Discipline

- **Max 1-2 alignment types per section.** Every additional alignment axis is another anchor the eye must re-find; mixed left/center/right in one view reads as unplanned.
- **Mixed text sizes on one line align to the shared baseline**, not to vertical centers — center-aligning a 24px number next to a 13px label makes the label float.
- **Truncate the middle, not the end**, when items share long prefixes ("Quarterly report — … — Q3 2026"): the differentiating ends are what users scan for.

---

## Choosing Layout Tools

**Flexbox — 1D.** Rows of items, nav bars, button groups, component internals. Default choice for the majority of components.

**Grid — 2D.** Page structure, dashboards, anything requiring row AND column coordination. Reach for it when flex with `flex-wrap` forces workarounds.

```css
/* Responsive without breakpoints — flex */
.group { display: flex; flex-wrap: wrap; gap: var(--space-md); }

/* Responsive without breakpoints — grid */
.grid  { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: var(--space-lg); }
```

Don't default to Grid when Flex would be simpler. Don't reach for JS measurement when CSS layout solves it.

---

## Breaking Monotony

- Don't default to card grids for everything — spacing creates grouping naturally
- Cards only when content is truly distinct and actionable — never nest cards inside cards
- Vary card sizes, span columns, or mix cards with non-card content
- Asymmetric compositions break the centered-content default when the content supports it
- Never template the "big metric + small label + stat row + gradient" pattern — it's a design cliché

---

## Depth & Elevation

### Z-Index Scale (Semantic)
```css
--z-dropdown:       10;
--z-sticky:         20;
--z-modal-backdrop: 30;
--z-modal:          40;
--z-toast:          50;
--z-tooltip:        60;
```

Never use arbitrary values (999, 9999). Use elevation to reinforce hierarchy, not as decoration.

### Shadow Scale
```css
--shadow-sm:  0 1px 2px rgba(0,0,0,0.05);
--shadow-md:  0 4px 6px rgba(0,0,0,0.07), 0 1px 3px rgba(0,0,0,0.06);
--shadow-lg:  0 10px 15px rgba(0,0,0,0.1), 0 4px 6px rgba(0,0,0,0.05);
--shadow-xl:  0 20px 25px rgba(0,0,0,0.1), 0 8px 10px rgba(0,0,0,0.04);
```

Always layered (ambient + direct light). Higher elevation = larger spread + lower opacity, not just a bigger number.

**Dark mode breaks layered shadows.** A dark shadow cast on a dark surface has nowhere to show up — the layered ambient+direct recipe above effectively disappears. Don't stack darker shadows to compensate; collapse elevation to a single subtle light ring instead — a 1px, low-alpha white inset or outset border (`0 0 0 1px rgba(255,255,255,0.08)`-ish) reads as "raised" against a dark surface the way a shadow does against a light one.

---

## Optical Adjustments

- **±1px nudges** when geometric centering looks visually off-center — common with icons inside buttons, badges, avatars
- **Nested radii:** child ≤ parent. Use `calc(var(--radius-parent) - var(--padding))` to keep concentric curves
- **Icon/text lockups:** adjust weight, size, spacing, or color — one lever at a time until they feel unified

### Concentric Radius Arithmetic

The relationship that keeps nested corners visually parallel: **outer radius = inner radius + the gap between the two edges.** Worked example on the token scale — an inner surface using `--radius-xl` (14px) sitting inside 6px of padding needs an outer radius of `14 + 6 = 20px`, which lands exactly on `--radius-2xl`. Skip the arithmetic and the outer curve either pinches tighter than the inner one (looks accidental) or bows out looser (looks sloppy) — concentric only reads as intentional when the two curves share a center point.

**Exception:** past roughly 24px of padding, the two surfaces read far enough apart that concentric math stops mattering — at that distance, treat inner and outer as separate surfaces with independently chosen radii rather than chasing an arithmetic relationship the eye can no longer perceive.

### Optical Alignment Recipes

- **Icon-leading buttons need asymmetric padding** — trim roughly 2px off the icon side of the button's padding. An icon's own whitespace (the space inside its bounding box between the glyph and its edge) reads as extra padding the eye already counts, so equal padding on both sides looks lopsided toward the icon.
- **Triangular and asymmetric glyphs need a nudge toward their visual mass.** Play icons, carets, and similar shapes have most of their ink weight off-center within their bounding box — a 1-2px nudge in the direction the shape "leans" corrects the optical imbalance a perfectly centered bounding box leaves behind.
- **When an SVG is persistently off-balance across every context it's used in**, fix the path's `viewBox` centering at the source rather than compensating with margin on every instance. Per-instance margin hacks drift out of sync the next time the icon is resized or reused elsewhere; a corrected `viewBox` fixes it everywhere at once.

---

## Style-to-CSS Reference

| Property | Minimal Clean | Soft Modern | Sharp Geometric | Rich Editorial | Dark Premium | Playful Bold |
|----------|---------------|-------------|-----------------|----------------|--------------|--------------|
| `border-radius` | 2-4px | 8-16px | 0px | 2-4px | 4-8px | 12-20px |
| Shadows | None or barely-there | Layered (ambient + direct) | None — use borders | Subtle, warm | Subtle glow, inset | Bold, offset |
| Borders | `rgba(0,0,0,0.06)` 1px | Soft, same hue as shadow | 1px crisp, high-contrast | Thin, warm-tinted | `rgba(255,255,255,0.08)` | Thick, colored |
| Spacing | Generous whitespace | Comfortable, padded | Tight, precise | Generous, editorial | Moderate | Loose, breathing |
| Weight range | 400-600 | 400-600 | 400-800 | 300-700 | 400-700 | 500-800 |

---

## Never

- Arbitrary spacing outside your defined scale
- All spacing equal across a section — variety creates hierarchy
- Wrap everything in cards — not everything needs a container
- Nest cards inside cards
- Center everything — left-aligned asymmetry reads as more intentional
- Default to Grid when Flex would be simpler
- Arbitrary z-index values (999, 9999)
- Two adjacent hierarchy levels at the same visual weight — decide which leads

---

## Required CSS Patterns

These patterns are not suggestions — they are the minimum CSS every layout type MUST include. Without `display: flex` or `display: grid` on container elements, children stack vertically by default. This is the single most common cause of broken layouts.

### Header (fixed, horizontal)

```css
.header .container {
    display: flex;
    align-items: center;
    justify-content: space-between;
}
.nav-list {
    display: flex;
    align-items: center;
    gap: 2rem;
    list-style: none;
}
.mobile-menu-btn {
    display: none;  /* shown via media query on mobile */
}
@media (max-width: 768px) {
    .mobile-menu-btn { display: flex; }
    .nav-list {
        position: fixed;
        top: 70px;
        left: -100%;
        flex-direction: column;
        width: 100%;
        transition: left 0.3s;
    }
    .nav-list.active { left: 0; }
}
```

### Hero split (content + visual)

```css
.hero .container {
    display: flex;
    align-items: center;
    gap: clamp(2rem, 4vw, 4rem);
}
.hero-content { flex: 1; }
.hero-image   { flex: 1; display: flex; justify-content: center; }

@media (max-width: 768px) {
    .hero .container {
        flex-direction: column;
        text-align: left;  /* NEVER center hero on mobile */
    }
    .hero-content { padding-right: 0; margin-bottom: 2rem; }
}
```

### Feature alternating rows (NOT uniform card grid)

The #1 template tell is a row of identical icon+heading+text cards. Replace with alternating asymmetric rows:

```css
.feature-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: clamp(2rem, 4vw, 4rem);
    align-items: center;
}
.feature-row + .feature-row { margin-top: clamp(3rem, 6vw, 6rem); }

/* Alternate the layout: text-left/visual-right, then swap */
.feature-row:nth-child(even) .feature-text   { order: 2; }
.feature-row:nth-child(even) .feature-visual  { order: 1; }

.feature-text h3   { font-size: 1.75rem; margin-bottom: 1rem; text-align: left; }
.feature-text p     { color: var(--text-secondary); text-align: left; line-height: 1.7; }

@media (max-width: 768px) {
    .feature-row { grid-template-columns: 1fr; }
    .feature-row:nth-child(even) .feature-text  { order: 1; }
    .feature-row:nth-child(even) .feature-visual { order: 2; }
}
```

### Pricing (cards with ONE highlighted)

```css
.pricing-cards {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 2rem;
    align-items: start;  /* NOT stretch — cards keep natural height */
}
.pricing-card.popular {
    transform: scale(1.05);
    border-color: var(--accent-primary);
}
@media (max-width: 768px) {
    .pricing-cards { grid-template-columns: 1fr; }
    .pricing-card.popular { transform: none; }
}
```

### Testimonials (scrollable row, NOT centering)

```css
.testimonials-track {
    display: flex;
    gap: 1.5rem;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    -webkit-overflow-scrolling: touch;
    padding-bottom: 1rem;
    scrollbar-width: none;
}
.testimonials-track::-webkit-scrollbar { display: none; }
.testimonial-card {
    min-width: 340px;
    flex-shrink: 0;
    scroll-snap-align: start;
    text-align: left;  /* NEVER center testimonial cards */
}
```

### Footer (horizontal columns)

```css
.footer-content {
    display: grid;
    grid-template-columns: 2fr 1fr 1fr 1fr;
    gap: 3rem;
}
.footer-column { text-align: left; }
.footer-bottom { text-align: center; }  /* only the copyright line is centered */

@media (max-width: 768px) {
    .footer-content { grid-template-columns: 1fr; text-align: center; }
    .footer-column { text-align: center; }
}
```

---

## Spacing Rhythm (REQUIRED — varied, not uniform)

Section padding MUST vary — never use the same padding on every section. Identical spacing on every section is the signature of stamped-out layouts.

### Landing page rhythm

```css
.hero     { padding: 8rem 0 4rem; }   /* tallest — above-fold breathing room */
.features { padding: 6rem 0; }         /* standard section */
.demo     { padding: 4rem 0; }         /* tighter — it's a showcase, not a section */
.pricing  { padding: 6rem 0; }         /* standard section */
.cta      { padding: 5rem 0; }         /* slightly tighter — closing moment */
.footer   { padding: 3rem 0 2rem; }    /* tightest — chrome, not content */
```

### Within-section gaps

| Relationship | Gap |
|---|---|
| Card to card (same row) | 1.5–2rem |
| Heading to subheading | 0.5–1rem |
| Subheading to content | 1–1.5rem |
| Content to CTA | 2–3rem |
| Section to section | 4–6rem (varied) |

### Fluid spacing

Use `clamp()` to scale spacing without breakpoints:
```css
padding: clamp(var(--space-lg), 4vw, var(--space-3xl));
gap: clamp(1rem, 2vw, 2rem);
```

---

## Anti-patterns with Fixes

These are the most common layout failures in generated output. Check every build against this table.

| Anti-pattern | Why it's wrong | Fix |
|---|---|---|
| No `display: flex` on `.header .container` | Logo, nav, hamburger stack vertically | Add `display: flex; align-items: center; justify-content: space-between;` |
| No `display: flex` on `.hero .container` | Hero text and image stack vertically on desktop | Add `display: flex; align-items: center; gap: clamp(2rem, 4vw, 4rem);` |
| `text-align: center` on all feature cards | Everything centered = no hierarchy, reads as template | Left-align feature text; use `text-align: left` on `.feature-card` |
| Same `padding: 6rem 0` on every section | No rhythm, looks stamped out | Vary: 8/6/4/6/5/3rem across sections |
| Uniform 3-4 column icon+heading+text grid | #1 template tell per recipe-landing.md | Use alternating asymmetric rows with visuals |
| `flex-direction: column` on hero at all sizes | Hero split broken on desktop | Only column on mobile (`@media max-width: 768px`) |
| `text-align: center` on pricing cards | Pricing features list centered = unreadable | Left-align the features list; center only the price |
| Centered footer columns | Footer links buried, hard to scan | Left-align within columns; center only copyright line |
| All sections use same background color | No visual rhythm, flat page | Alternate: light → dark → light or subtle bg tint variation |
| `transition: all` on interactive elements | Animates unexpected properties, performance hit | List specific properties: `transition: color 0.2s, transform 0.2s;` |

---

## Layout Squint Test (run before shipping)

Before writing the final CSS, verify these 6 checkpoints. If any fails, fix it before completing the build.

1. **Header:** Logo left, nav right — horizontal, not stacked. On mobile: hamburger replaces nav.
2. **Hero:** Text + visual side-by-side on desktop (or deliberate type-only). NOT stacked.
3. **Features:** Alternating rows with visuals, NOT uniform card grid. At least 2 distinct layout families.
4. **Alignment:** At least 2 sections left-aligned (not all centered). Feature text, pricing lists, and testimonials are left-aligned.
5. **Spacing:** Section padding visibly varies when you squint. Hero is tallest, footer is tightest. No two adjacent sections share the same padding value.
6. **Variety:** No section has the exact same layout structure as its neighbor. A card grid next to a split row is fine; two card grids in a row is not.
