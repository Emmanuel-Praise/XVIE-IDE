/**
 * route-data.mjs — retrieval index for the agent-kit router.
 *
 * Adapted from ui-craft's mcp/src/route-data.mjs (MIT — github.com/educlopez/ui-craft).
 * Changes for the kit: command and MCP-tool entries removed (a custom orchestrator has
 * no slash commands or MCP server), reference entries kept verbatim. Paths resolve
 * relative to the kit root, where `references/` is vendored.
 *
 * Boundary: this file holds POINTERS and vocabulary only — never a design rule.
 */

// ─── Stopwords ───────────────────────────────────────────────────────────────

export const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these',
  'those', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'to', 'of', 'in', 'on',
  'at', 'by', 'for', 'with', 'without', 'from', 'into', 'onto', 'about', 'as', 'it',
  'its', 'my', 'me', 'our', 'ours', 'your', 'yours', 'you', 'i', 'we', 'they', 'them',
  'their', 'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must',
  'do', 'does', 'did', 'done', 'have', 'has', 'had', 'not', 'no', 'nor', 'so', 'up',
  'out', 'over', 'under', 'more', 'most', 'less', 'some', 'any', 'each', 'one', 'two',
  'also', 'very', 'just', 'like', 'there', 'here', 'when', 'while', 'where', 'how',
  'what', 'which', 'who', 'why', 'all', 'both', 'either', 'other', 'another', 'same',
  'build', 'building', 'make', 'making', 'create', 'creating', 'add', 'adding', 'need',
  'needs', 'want', 'wants', 'help', 'please', 'give', 'get', 'let', 'lets', 'work',
  'working', 'use', 'using', 'new', 'good', 'nice', 'quick', 'quickly', 'thing',
  'things', 'stuff', 'something', 'anything', 'everything', 'now', 'again', 'maybe',
  'probably', 'basically', 'really', 'actually', 'kinda', 'sorta', 'whatnot', 'etc',
  'plus', 'okay', 'ok', 'yeah', 'thanks',
]);

// ─── Synonym map ─────────────────────────────────────────────────────────────
// concept → the words that should reach it. "analytics" must find recipe-dashboard.md
// even though nothing in that filename says analytics. One hop only.

export const SYNONYMS = {
  dashboard: ['analytics', 'kpi', 'kpis', 'metrics', 'metric', 'panel', 'panels',
    'admin', 'reporting', 'reports', 'report', 'stats', 'statistics', 'overview',
    'console', 'backoffice', 'back-office', 'monitoring', 'observability', 'insights'],
  landing: ['marketing', 'homepage', 'home', 'hero', 'fold', 'above-the-fold', 'promo',
    'saas', 'website', 'site', 'pricing', 'testimonials', 'testimonial', 'features',
    'cta', 'waitlist', 'launch-page', 'logos', 'faq', 'footer', 'header', 'content', 'sections', 'rich'],
  auth: ['login', 'log-in', 'signin', 'sign-in', 'signup', 'sign-up', 'register',
    'registration', 'session', 'password', 'passwords', 'passkey', 'otp', 'magic-link',
    'oauth', 'sso', 'authentication', 'onboarding', 'verification'],
  forms: ['form', 'input', 'inputs', 'field', 'fields', 'validation', 'validate',
    'validating', 'invalid', 'checkout', 'wizard', 'stepper', 'multi-step', 'autosave',
    'select', 'checkbox', 'radio', 'textarea', 'submit', 'fieldset'],
  tokens: ['token', 'variables', 'variable', 'design-system', 'scale', 'scales',
    'primitives', 'primitive', 'semantic', 'palette', 'ramp', 'custom-properties'],
  color: ['colour', 'colours', 'colors', 'accent', 'hue', 'oklch', 'hsl', 'lch',
    'contrast', 'dark', 'darkmode', 'dark-mode', 'light', 'lightmode', 'apca',
    'saturation', 'chroma', 'gamut', 'p3', 'tint', 'shade'],
  typography: ['type', 'typeface', 'typefaces', 'font', 'fonts', 'tracking', 'leading',
    'kerning', 'letterspacing', 'letter-spacing', 'text', 'heading', 'headings',
    'headline', 'serif', 'sans', 'monospace', 'weight', 'weights', 'lineheight',
    'line-height', 'readability', 'measure'],
  motion: ['animation', 'animations', 'animate', 'animated', 'transition', 'transitions',
    'easing', 'ease', 'spring', 'springs', 'stagger', 'keyframes', 'choreography',
    'micro-interaction', 'microinteraction', 'hover', 'gesture', 'gestures', 'scroll',
    'parallax', 'reveal', 'entrance', 'exit'],
  layout: ['spacing', 'grid', 'grids', 'composition', 'rhythm', 'alignment', 'align',
    'hierarchy', 'gestalt', 'whitespace', 'margins', 'margin', 'padding', 'gutter',
    'columns', 'stack', 'flexbox', 'asymmetry', 'balance', 'header', 'footer', 'hero', 'skeleton', 'sections'],
  accessibility: ['a11y', 'aria', 'wcag', 'keyboard', 'screenreader', 'screen-reader',
    'focus', 'focus-visible', 'contrast', 'tabindex', 'semantics', 'semantic-html',
    'inclusive', 'landmark', 'alt-text', 'skip-link'],
  responsive: ['mobile', 'tablet', 'desktop', 'breakpoint', 'breakpoints', 'adaptive',
    'fluid', 'viewport', 'touch', 'thumb', 'container-query', 'container-queries',
    'small-screen', 'narrow', 'zoom'],
  dataviz: ['chart', 'charts', 'graph', 'graphs', 'plot', 'visualization',
    'visualisation', 'sparkline', 'sparklines', 'axis', 'axes', 'legend', 'series',
    'tufte', 'heatmap', 'histogram', 'scatter', 'bar-chart', 'line-chart'],
  tables: ['table', 'tables', 'rows', 'row', 'columns', 'datagrid', 'data-grid',
    'sorting', 'sortable', 'pagination', 'paginated', 'virtualization', 'virtualized',
    'spreadsheet'],
  components: ['component', 'components', 'button', 'buttons', 'modal', 'modals',
    'dialog', 'menu', 'menus', 'dropdown', 'card', 'cards', 'nav', 'navbar',
    'navigation', 'sidebar', 'tooltip', 'toast', 'badge', 'tabs', 'popover', 'search',
    'accordion', 'avatar', 'chip'],
  copy: ['copywriting', 'microcopy', 'wording', 'voice', 'tone', 'label', 'labels',
    'message', 'messages', 'messaging', 'placeholder', 'helper-text', 'terminology'],
  states: ['state', 'loading', 'skeleton', 'spinner', 'empty', 'empty-state', 'offline',
    'partial', 'conflict', 'edge-case', 'edge-cases', 'unhappy', 'pending', 'stale',
    'retry', 'timeout'],
  review: ['critique', 'audit', 'auditing', 'assess', 'assessment', 'evaluate',
    'feedback', 'findings', 'inspect', 'check', 'checking', 'second-opinion',
    'code-review', 'walkthrough'],
  polish: ['refine', 'refinement', 'detail', 'details', 'finish', 'finishing', 'craft',
    'quality', 'nitpick', 'micro', 'last-mile', 'fit-and-finish'],
  performance: ['perf', 'fps', 'janky', 'jank', 'lag', 'laggy', 'slow', 'sluggish',
    'frames', 'framerate', 'compositor', 'gpu', 'reflow', 'repaint', 'layout-thrash',
    'optimize', 'optimise', 'stutter', 'dropped-frames'],
  brief: ['identity', 'positioning', 'audience', 'principles', 'principle', 'intent',
    'constraints', 'constraint', 'memory', 'context', 'product-context', 'brand'],
  spec: ['specification', 'wireframe', 'wireframes', 'blueprint', 'plan', 'structure',
    'inventory', 'content-inventory', 'lo-fi', 'mockup'],
  metadata: ['meta', 'seo', 'title', 'titles', 'description', 'canonical', 'og',
    'opengraph', 'open-graph', 'favicon', 'favicons', 'social-card', 'sharing',
    'structured-data', 'schema-org', 'sitemap', 'noindex'],
  sound: ['audio', 'sfx', 'sound-effects', 'haptics', 'haptic', 'vibration', 'webaudio',
    'web-audio', 'chime', 'mute'],
  stack: ['gsap', 'threejs', 'three', 'webgl', 'shader', 'shaders', 'framer',
    'framer-motion', 'r3f', 'canvas', 'lottie', 'rive', 'scrolltrigger', 'webgpu'],
  ai: ['chat', 'llm', 'streaming', 'stream', 'agent', 'agentic', 'assistant', 'prompt',
    'citations', 'tool-call', 'tool-calls', 'generative', 'copilot', 'completion'],
  theme: ['themes', 'preset', 'presets', 'skin', 'reskin', 'branding', 'whitelabel',
    'white-label', 'multi-tenant', 'tenant'],
  redesign: ['rebuild', 'modernize', 'modernise', 'refresh', 'revamp', 'migrate',
    'migration', 'legacy', 'facelift', 'overhaul'],
  simplify: ['distill', 'reduce', 'simplify', 'cut', 'trim', 'declutter', 'noise',
    'bloat', 'overbuilt', 'busy', 'cluttered', 'minimalise'],
  extract: ['refactor', 'refactoring', 'dedupe', 'deduplicate', 'duplication',
    'duplicated', 'repeated', 'componentize', 'abstract', 'reuse', 'reusable', 'dry'],
  variance: ['bolder', 'bold', 'personality', 'expressive', 'signature', 'distinctive',
    'generic', 'samey', 'boring', 'bland', 'slop', 'template-y', 'cookie-cutter',
    'ai-looking', 'forgettable'],
  quieter: ['calm', 'calmer', 'restrained', 'subtle', 'understated', 'tone-down',
    'quiet', 'minimal', 'minimalist', 'noisy', 'loud', 'shouty'],
  ship: ['finalize', 'finalise', 'merge', 'merging', 'pr', 'pull-request', 'preship',
    'pre-ship', 'gate', 'release', 'production', 'deploy', 'deployment', 'launch'],
  harden: ['hardening', 'robust', 'robustness', 'i18n', 'l10n', 'rtl', 'localization',
    'localisation', 'resilience', 'resilient', 'production-ready', 'battle-tested'],
  heuristic: ['nielsen', 'usability', 'score', 'scoring', 'rubric', 'grade', 'graded',
    'persona', 'personas', 'benchmark-score'],
  css: ['modern-css', 'view-transitions', 'view-transition', 'anchor-positioning',
    'popover', 'container-queries', 'starting-style', 'clip-path', 'mask', 'mask-image',
    'nesting', 'has-selector', 'subgrid'],
  inspiration: ['reference', 'references', 'examples', 'example', 'archetype',
    'archetypes', 'patterns', 'pattern', 'mature', 'benchmark', 'competitor', 'prior-art'],
};

// ─── Repair intent ───────────────────────────────────────────────────────────

export const REPAIR_MARKERS = [
  'fix', 'fixes', 'fixing', 'broken', 'break', 'breaks', 'breaking', 'bug', 'bugs',
  'buggy', 'wrong', 'issue', 'issues', 'problem', 'problems', 'slow', 'sluggish',
  'janky', 'jank', 'laggy', 'ugly', 'off', 'weird', 'awkward', 'improve', 'improves',
  'improving', 'better', 'review', 'audit', 'critique', 'regression', 'regressions',
  'fails', 'failing', 'failed', 'jumps', 'jumping', 'shifts', 'shifting', 'flickers',
  'flickering', 'stutters', 'stuttering', 'unreadable', 'inconsistent', 'messy',
  'cluttered', 'confusing', 'hurts', 'wrongly', 'misaligned',
];

// ─── Corpus (references only) ────────────────────────────────────────────────
// `keywords` are what someone might actually type. `contains` carries the names of the
// parts an entry is built from, so a recipe surfaces on "pricing block" or "KPI grid"
// even though its title says neither. `tier` mirrors SKILL.md tiers; tier 1 = always
// load before writing UI.

export const CORPUS = [
  // ── Tier 1 ──────────────────────────────────────────────────────────────
  {
    id: 'ref-craft-intent', name: 'craft-intent', path: 'references/craft-intent.md', tier: 1,
    summary: 'Craft Read, DESIGN_VARIANCE, signature bets, product vs marketing build patterns.',
    keywords: ['variance', 'craft', 'intent', 'signature', 'craft-read'],
    contains: ['design-variance', 'signature-bet'], first_move: null,
  },
  {
    id: 'ref-tokens', name: 'tokens', path: 'references/tokens.md', tier: 1,
    summary: '3-layer token spine — primitive → semantic → component, both modes intentional.',
    keywords: ['tokens'],
    contains: ['radius-scale', 'spacing-scale', 'z-index', 'shadows'], first_move: null,
  },
  {
    id: 'ref-inspiration', name: 'inspiration', path: 'references/inspiration.md', tier: 1,
    summary: 'Pattern archetypes from mature SaaS, signature details, what mature interfaces never do.',
    keywords: ['inspiration'], contains: ['archetypes', 'reference-values'], first_move: null,
  },
  {
    id: 'ref-accessibility', name: 'accessibility', path: 'references/accessibility.md', tier: 1,
    summary: 'WCAG, keyboard, focus, forms, ARIA, touch targets, checklist.',
    keywords: ['accessibility'],
    contains: ['focus-visible', 'aria', 'keyboard', 'touch-targets'], first_move: null,
  },
  {
    id: 'ref-color', name: 'color', path: 'references/color.md', tier: 1,
    summary: 'Color strategy, palettes, dark mode, accent budget, OKLCH scales, APCA.',
    keywords: ['color'], contains: ['accent-budget', 'oklch', 'apca', 'dark-mode'], first_move: null,
  },
  {
    id: 'ref-layout', name: 'layout', path: 'references/layout.md', tier: 1,
    summary: 'Gestalt grouping, spacing rhythm, hierarchy ratios, composition strategies, optical center.',
    keywords: ['layout'],
    contains: ['gestalt', 'spacing-rhythm', 'optical-center', 'nested-radii'], first_move: null,
  },

  // ── Tier 2 (surface-specific) ───────────────────────────────────────────
  {
    id: 'ref-spec', name: 'spec', path: 'references/spec.md', tier: 2,
    summary: 'Durable composition spec format — per-surface composition choice and acceptance bar.',
    keywords: ['spec'], contains: [], first_move: null,
  },
  {
    id: 'ref-recipe-dashboard', priority: 0, name: 'recipe-dashboard', path: 'references/recipe-dashboard.md', tier: 2,
    summary: 'Outcome recipe: 3 named dashboard compositions, shell spec, build order, acceptance bar.',
    keywords: ['dashboard', 'recipe'],
    contains: ['metric-cards', 'kpi-grid', 'sidebar', 'charts', 'data-tables', 'filters', 'toolbar', 'sparklines'],
    first_move: null,
  },
  {
    id: 'ref-recipe-landing', priority: 0, name: 'recipe-landing', path: 'references/recipe-landing.md', tier: 2,
    summary: 'Outcome recipe: product-forward / message-forward / proof-forward compositions, section grammar, pricing rules.',
    keywords: ['landing', 'recipe'],
    contains: ['hero', 'pricing-table', 'testimonials', 'logo-wall', 'feature-rows', 'faq', 'footer', 'social-proof', 'eyebrow'],
    first_move: null,
  },
  {
    id: 'ref-recipe-auth', priority: 0, name: 'recipe-auth', path: 'references/recipe-auth.md', tier: 2,
    summary: 'Outcome recipe: split-panel / centered-card auth compositions, form contract, sign-up deltas.',
    keywords: ['auth', 'recipe'],
    contains: ['sign-in-form', 'oauth-buttons', 'password-field', 'magic-link'],
    first_move: null,
  },
  {
    id: 'ref-themes', name: 'themes', path: 'references/themes.md', tier: 2,
    summary: '4 named production token presets — Graphite, Porcelain, Carbon, Signal.',
    keywords: ['theme'], contains: ['graphite', 'porcelain', 'carbon', 'signal'], first_move: null,
  },
  {
    id: 'ref-dashboard', name: 'dashboard', path: 'references/dashboard.md', tier: 2,
    summary: 'Dashboard patterns — metric cards, charts, tables, sidebar, filters, density, signal-to-noise tiers.',
    keywords: ['dashboard', 'tables'],
    contains: ['metric-cards', 'status-dots', 'proportion-bars', 'virtualization', 'scrollbar-gutter',
      'density', 'overflow-x', 'sticky-header'],
    first_move: null,
  },
  {
    id: 'ref-forms', name: 'forms', path: 'references/forms.md', tier: 2,
    summary: 'Validation timing, progressive disclosure, multi-step wizards, autosave, optimistic submit.',
    keywords: ['forms'], contains: ['validation-timing', 'wizard', 'autosave'], first_move: null,
  },
  {
    id: 'ref-components', name: 'components', path: 'references/components.md', tier: 2,
    summary: 'Component anatomy contracts — buttons, menus, modals, search, cards, nav bar.',
    keywords: ['components'],
    contains: ['button', 'menu', 'modal', 'search', 'card', 'navbar'], first_move: null,
  },
  {
    id: 'ref-ai-chat', name: 'ai-chat', path: 'references/ai-chat.md', tier: 2,
    summary: 'Streaming contract, 7-state affordance model for AI surfaces, tool traces, citations, generative UI.',
    keywords: ['ai'], contains: ['streaming', 'tool-traces', 'citations', 'feedback'], first_move: null,
  },
  {
    id: 'ref-review', name: 'review', path: 'references/review.md', tier: 2,
    summary: 'Critique methodology, Polish Pass, common issues, component craft, Craft Report format.',
    keywords: ['review', 'polish'], contains: ['polish-pass', 'craft-report'], first_move: null,
  },
  {
    id: 'ref-finish-bar', name: 'finish-bar', path: 'references/finish-bar.md', tier: 2,
    summary: '10-pass finishing protocol before merge.',
    keywords: ['ship', 'polish'], contains: ['ten-passes'], first_move: null,
  },
  {
    id: 'ref-loops', name: 'loops', path: 'references/loops.md', tier: 2,
    summary: 'Loop engine — read→evaluate→fix-one→re-evaluate→stop, plus 3 presets. Converge instead of one-shot.',
    keywords: ['loops', 'loop', 'converge', 'convergence', 'iterate', 'iteration'],
    contains: [], first_move: null,
  },
  {
    id: 'ref-principles', name: 'principles-catalog', path: 'references/principles-catalog.md', tier: 2,
    summary: '42 example design principles across 8 product categories.',
    keywords: ['brief'], contains: ['principles'], first_move: null,
  },
  {
    id: 'ref-coverage', name: 'coverage', path: 'references/coverage.md', tier: 2,
    summary: 'UX coverage — the parts 12 screen archetypes need to be complete.',
    keywords: ['missing', 'completeness', 'coverage'],
    contains: ['what is missing', 'archetype', 'parts'], first_move: null,
  },
  {
    id: 'ref-page-completeness', priority: 0, name: 'page-completeness', path: 'references/page-completeness.md', tier: 2,
    summary: 'Mandatory page skeleton + content floor — header/hero/sections/rich-footer minimums, no thin pass.',
    keywords: ['landing', 'completeness'],
    contains: ['hero', 'footer', 'header', 'feature-rows', 'skeleton', 'sections', 'pricing-table', 'faq'], first_move: null,
  },

  // ── Tier 3 (foundations) ────────────────────────────────────────────────
  {
    id: 'ref-typography', name: 'typography', path: 'references/typography.md', tier: 3,
    summary: 'Type scale, font choice, readability, weight — scoped per script and role.',
    keywords: ['typography'],
    contains: ['modular-scale', 'font-loading', 'optical-sizing'], first_move: null,
  },
  {
    id: 'ref-motion', name: 'motion', path: 'references/motion.md', tier: 3,
    summary: 'Decision ladder, duration + easing scales, interaction rules, choreography, rendering performance.',
    keywords: ['motion', 'performance'],
    contains: ['easing-scale', 'duration-scale', 'flip', 'reduced-motion', 'motion-budget'], first_move: null,
  },
  {
    id: 'ref-modern-css', name: 'modern-css', path: 'references/modern-css.md', tier: 3,
    summary: 'View Transitions, scroll timelines, container queries, @starting-style, anchor positioning, mask-image fades.',
    keywords: ['css'],
    contains: ['view-transitions', 'container-queries', 'popover', 'anchor-positioning', 'mask-image', 'scrollbar-gutter'],
    first_move: null,
  },
  {
    id: 'ref-responsive', name: 'responsive', path: 'references/responsive.md', tier: 3,
    summary: 'Mobile/tablet/desktop, breakpoints, touch zones, thumb-first design.',
    keywords: ['responsive'], contains: ['breakpoints', 'thumb-zone', 'safe-areas'], first_move: null,
  },
  {
    id: 'ref-metadata', name: 'metadata', path: 'references/metadata.md', tier: 3,
    summary: 'Title/description/canonical consistency, social cards, noindex on staging, structured data honesty, favicons.',
    keywords: ['metadata'], contains: ['open-graph', 'canonical', 'favicons'], first_move: null,
  },
  {
    id: 'ref-copy', name: 'copy', path: 'references/copy.md', tier: 3,
    summary: 'Voice/tone matrix, reading level, terminology, inclusive language, errors, empty states, CTAs.',
    keywords: ['copy'], contains: ['voice-matrix', 'error-messages', 'empty-states', 'ctas'], first_move: null,
  },
  {
    id: 'ref-sound', name: 'sound', path: 'references/sound.md', tier: 3,
    summary: 'Web Audio, UI sound, appropriateness matrix. Rare — only when explicitly building audio feedback.',
    keywords: ['sound'], contains: ['web-audio'], first_move: null,
  },

  // ── Tier 4 (opt-in / on trigger) ────────────────────────────────────────
  {
    id: 'ref-stack', name: 'stack', path: 'references/stack.md', tier: 4,
    summary: 'Three.js / GSAP / Motion. OPT-IN ONLY — do not load unless the user chose one in Discovery.',
    keywords: ['stack'], contains: ['gsap', 'threejs', 'framer-motion', 'scrolltrigger'], first_move: null,
  },
  {
    id: 'ref-heuristics', name: 'heuristics', path: 'references/heuristics.md', tier: 4,
    summary: "Nielsen's 10 + 6 design laws (Fitts, Hick, Doherty, Cleveland-McGill, Miller, Tesler) + 1-5 rubric.",
    keywords: ['heuristic'], contains: ['nielsen', 'fitts', 'hicks'], first_move: null,
  },
  {
    id: 'ref-personas', name: 'personas', path: 'references/personas.md', tier: 4,
    summary: '5 persona walkthroughs — first-timer, power, low-bandwidth, screen-reader, one-thumb.',
    keywords: ['heuristic'], contains: ['walkthroughs'], first_move: null,
  },
  {
    id: 'ref-state-design', name: 'state-design', path: 'references/state-design.md', tier: 4,
    summary: 'State lattice — idle / loading / empty / error / partial / conflict / offline.',
    keywords: ['states'], contains: ['state-lattice'], first_move: null,
  },
  {
    id: 'ref-dataviz', name: 'dataviz', path: 'references/dataviz.md', tier: 4,
    summary: 'Cleveland-McGill perceptual hierarchy, chart selection matrix, ColorBrewer/Okabe-Ito palettes, Tufte, direct labeling.',
    keywords: ['dataviz'], contains: ['chart-selection', 'cleveland-mcgill', 'okabe-ito'], first_move: null,
  },
];

/**
 * Surface classes the recipes do not help with. Additive: routing still runs;
 * this adds the sentence the skill would otherwise leave unsaid.
 */
export const OUT_OF_SCOPE = [
  {
    id: 'native-mobile',
    label: 'Native mobile screens',
    triggers: ['react native', 'swiftui', 'swift ui', 'uikit', 'jetpack compose', 'native screen', 'native app screen'],
    use: 'Apple HIG or Material directly — these references cover web surfaces.',
  },
  {
    id: 'code-editor',
    label: 'Code-editor surfaces (syntax, gutters, diff views)',
    triggers: ['code editor', 'syntax highlight', 'syntax highlighting', 'monaco', 'codemirror', 'diff viewer', 'editor gutter'],
    use: 'Monaco or CodeMirror with their own theming API.',
  },
  {
    id: 'html-email',
    label: 'HTML email',
    triggers: ['html email', 'email template', 'newsletter template', 'mjml', 'transactional email'],
    use: 'MJML or a dedicated email framework — the CSS rules here are void in mail clients.',
  },
  {
    id: 'realtime-collab',
    label: 'Realtime collaboration UI (presence, live cursors, conflict states)',
    triggers: ['live cursor', 'live cursors', 'presence indicator', 'collaborative editing', 'operational transform', 'multiplayer cursor'],
    use: 'A different problem class — the recipes assume a single actor.',
  },
];

export default { STOPWORDS, SYNONYMS, CORPUS, REPAIR_MARKERS, OUT_OF_SCOPE };
