# Page Completeness — mandatory skeleton + content floor

Rich-first rulebook for full-surface builds. Taste (layout.md, recipe-landing.md)
decides *how* it looks; this file decides *what must exist* so a first pass
never ships thin. Load it on every landing / marketing / portfolio build.

## 1. Mandatory skeletons

### Landing / marketing page (minimum 7 blocks)

1. **Sticky header** — logo/SVG mark + 4-7 nav links + 1 primary CTA. Flex
   `space-between`, never stacked vertically on desktop.
2. **Hero with proof** — H1 (<=2 lines) + sub (<=20 words) + primary + ghost
   CTA + ONE micro-trust line + real visual (product shot, cropped at fold
   edge) or off-centre proof (avatars+count). Left-aligned default.
3. **Proof strip** — logo row (real SVG/monogram, low contrast) + 1 specific
   stat ("cut onboarding 6h -> 20min").
4. **Feature rows x2-3** — alternating asymmetric grid (`1fr 1fr`, even rows
   swapped), each with REAL visual (chart/detail/flow), >=120 words of real
   copy per row. NEVER uniform 3-column icon grid.
5. **How it works (<=3 steps) or depth section** — numbered only if truly
   sequential, else diagram/timeline.
6. **Social proof** — >=2 attributed quotes (name + role + face/initials) +
   metrics, NOT star ratings alone.
7. **Pricing (teaser or full 3-tier, ONE highlighted) + FAQ (>=4 real Q/A) +
   final CTA (restate action + trust line) + rich footer.**

Skip a block only with a stated reason in the Craft Read. "Keep it short" is
never a reason on a landing request.

### Rich footer floor (boring on purpose, never thin)

- `grid-template-columns: 2fr 1fr 1fr 1fr`, `gap: 3rem`, single column on
  mobile. Left-aligned links inside each column — never centered.
- Brand col (blurb + contact email + socials) + >=3 link groups (Product /
  Company / Resources or equivalent) + legal bar (copyright + privacy +
  terms). <3 columns or missing legal bar = incomplete.
- Footer links are grouped and prioritized, not a dumped mini-sitemap.

### Dashboards / auth

Dashboards: sidebar (subtle tint, NOT full dark) + >=3 content types per
viewport (chart + table + metric), sparklines on metrics. Auth: split-panel
or centered card + OAuth + password rules + error/empty states. See recipes.

## 2. Content floor (no placeholders, no thin pass)

- Every feature/testimonial/pricing/FAQ block carries REAL copy: specifics,
  numbers, names — never lorem, "coming soon", "will be populated",
  "insert image". Empty media wrappers fail validation.
- Landing copy minimum: hero sub + >=150 words across feature rows + >=2
  quotes + >=4 FAQ answers. If the brief lacks facts, invent plausible
  product-specific copy and mark it as draft in code comments — do not leave
  blanks.
- One idea per section; each section answers one question (proof / what /
  credible / afford / start). If a section answers nothing, cut it — but
  never cut to fewer than the skeleton above.
- Section spacing MUST vary (hero 8rem / features 6rem / demo 4rem /
  pricing 6rem / CTA 5rem / footer 3rem). Uniform padding on >=3 sections is
  stamped-out rhythm.

## 3. Layout primitives (must emit — copy verbatim shape)

Header flex, hero split-then-stack, feature alternating grid, pricing
`align-items: start`, footer 4-col grid (see system-prompt-core Layout
Primitives). Without `display:flex|grid` on those containers, children stack
vertically — the #1 broken-layout cause. `verify_file` checks this pair.

## 4. Hero variants (do not default to split every time)

Pick per brief: type-only (message-forward, no visual), full-bleed-overlay,
split, stacked, product-dominant (product-forward, asset 30-70% of fold),
band. Product-forward cannot be type-only; message-forward cannot be
product-dominant; proof-forward cannot be full-bleed-overlay.

## 5. Self-check before finishing

Header present + flex? Hero has proof + CTAs? >=5 content sections? Footer
>=4 columns + legal? Copy real, no placeholders? Spacing varied? Center
used <=2 sections? If any fail, fix before summarizing — do not ask the user
to reprompt for "more content" or "fix footer".
