# UI quality benchmark

Use this fixed set to compare prompt, model, or validator changes. Keep the
model, generation settings, viewport sizes, and task wording constant between
runs. Save each run's `review_ui_render` screenshots with the benchmark result
and score them without looking at the model name or prompt version.

## Tasks

1. **Product landing page:** Build a landing page for a small team that turns
   customer support tickets into searchable product insights. Show the product
   workflow and one clear next action. No brand assets are supplied.
2. **Data dashboard:** Build an operations dashboard for a delivery team with
   late orders, on-time rate, and region comparison. Include a useful table and
   at least one chart that matches the data.
3. **Signup flow:** Build a mobile-first signup form for a service that helps
   independent tutors manage bookings. Include validation, password visibility,
   and a clear success state.
4. **Existing-site repair:** In a fixture with a narrow mobile viewport and an
   overflowing navigation, repair the layout while preserving the existing
   colors, fonts, and component style.

## Blind visual score

Score each dimension from 1 (poor) to 5 (strong) using desktop and mobile
screenshots. Record a short piece of visible evidence for every score.

| Dimension | What to judge |
|---|---|
| Product fit | Content and visual choices make sense for the audience and task |
| Hierarchy | The primary action and important information are easy to find |
| Composition | The page has intentional alignment, spacing, and section rhythm |
| Typography and color | Text is readable and visual emphasis is controlled |
| Responsive quality | Mobile layout is composed for the viewport, with no clipping or overflow |
| Finish | States, imagery, details, and interactions feel complete and coherent |

Report the mean score, each dimension's score, the evidence, browser errors,
and horizontal-overflow results. Treat the total as a comparison aid, not an
objective truth; use at least two reviewers when comparing close results.
