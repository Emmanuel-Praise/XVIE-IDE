"""UI design guidance — the 3-layer design system integration.

Layer 1: Always-on taste (system-prompt-core.md + routing-table.md)
Layer 2: Per-request references via the design router
Layer 3: Discovery — project scan / Quick Ask before any generation

When the active role is ``ui_design`` or the user's prompt mentions
UI/web keywords, the full agent-kit design system is injected into the
system prompt. This replaces the previous basic DESIGN_PRINCIPLES with
the professional design knowledge from the agent-kit.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Kit root and file cache
# ---------------------------------------------------------------------------

_KIT_ROOT = Path(__file__).resolve().parent.parent / "agent-kit"
_core_prompt: str | None = None
_routing_table: str | None = None


def _load_file(name: str) -> str:
    path = _KIT_ROOT / name
    if path.exists():
        return path.read_text(encoding="utf-8")
    return ""


def get_core_prompt() -> str:
    """Load the always-on taste layer (system-prompt-core.md)."""
    global _core_prompt
    if _core_prompt is None:
        _core_prompt = _load_file("system-prompt-core.md")
    return _core_prompt


def get_routing_table() -> str:
    """Load the routing table (routing-table.md)."""
    global _routing_table
    if _routing_table is None:
        _routing_table = _load_file("routing-table.md")
    return _routing_table


# ---------------------------------------------------------------------------
# Legacy DESIGN_PRINCIPLES constant (backwards compatibility)
# ---------------------------------------------------------------------------
# Kept for tests that import it directly. The real design knowledge now
# lives in agent-kit/system-prompt-core.md.
DESIGN_PRINCIPLES = """\
<design-principles>
You are building a user interface. Follow these concrete design rules:

SPACING
- Use a strict spacing scale: 4, 8, 12, 16, 24, 32, 48, 64px. Never use arbitrary values.
- Generous whitespace beats cramped layouts. When in doubt, add more space.
- Consistent spacing between siblings (e.g. 16px gap between cards, 24px between sections).

TYPOGRAPHY
- Use a max of 2 font families: one for headings, one for body.
- Body text: 16px, line-height 1.5-1.6. Headings: scale down from 32px (h1) to 20px (h3).
- Never set font-size below 14px for readable content.

COLOR
- Start with a neutral palette: near-black text (#1a1a1a), white/near-white backgrounds,
  one intentional accent color. Avoid purple-gradient-on-white unless explicitly asked.
- Avoid default browser blue links (#0000EE). Use your accent color for interactive elements.
- Verify text/background contrast with check_contrast before finalizing colors.

LAYOUT
- Do NOT center everything. Use left-aligned text, full-width containers, and intentional alignment.
- Max content width: 680px for text, 1200px for page layouts.
- Use CSS Grid or Flexbox. Never use floats for layout.

DON'T DEFAULT TO
- No lorem ipsum placeholder text. Write real, relevant copy.
- No hero + three cards + purple gradient template unless it is genuinely the right fit.
- No unstyled form elements (use styled inputs, selects, buttons).
- Do not use generic stock-photo hero sections. For menus, catalogs, portfolios, and image-led product pages, use search_images for relevant product photography when it strengthens the page; use gradients, original illustrations, or typography when photography does not fit.
- Do not use emoji as website icons, decoration, or image placeholders unless the user explicitly requests emoji. Prefer the project icon set, inline SVG, CSS, or relevant real images.
- No "Welcome to our website" as the hero headline. Lead with value.

INTERACTIVE ELEMENTS
- Buttons: consistent padding (12px 24px), clear hover/active states, max 2-3 button styles.
- Forms: labels above inputs, clear validation states, logical tab order.
- Links: underlined or clearly distinguished from body text.

ACCESSIBILITY
- Minimum contrast ratio 4.5:1 for normal text, 3:1 for large text (use check_contrast).
- All images need alt text. All form inputs need labels.
- Focus states must be visible.

RESPONSIVE DESIGN (CRITICAL)
- Every page MUST work on mobile (320px) through desktop (1200px+).
- Use this viewport meta tag: <meta name="viewport" content="width=device-width, initial-scale=1.0">
- Use @media queries for breakpoints: 640px (sm), 768px (md), 1024px (lg), 1280px (xl).
- Use CSS Grid or Flexbox with wrapping — never fixed pixel widths for containers.

SEMANTIC HTML (REQUIRED)
- Use <header>, <nav>, <main>, <section>, <article>, <footer> — not just divs.
- Every page needs: lang attribute on <html>, <title>, viewport meta, semantic structure.
- Forms: <label> for every <input>, logical tab order, visible focus states.

CSS SYNTAX (CRITICAL)
- Always use var(--name) with double-dash prefix for custom properties.
- Never write var-name) or var(name) — the syntax is var(--name).
- Balance all parentheses in CSS functions.

NO HACKS (NEVER VIOLATE)
- NEVER add dummy media queries or hidden test divs to fake responsive design.
- NEVER add comments like "satisfy verifier" or "dummy" to bypass checks.
- Build REAL responsive design: actual @media breakpoints, real flexbox/grid layouts.

VERIFICATION
- After writing ALL files, call verify_file on each HTML and CSS file.
- Fix any issues it reports before marking tasks done.
</design-principles>"""


# ---------------------------------------------------------------------------
# UI prompt detection
# ---------------------------------------------------------------------------

_UI_PROMPT_PATTERN = re.compile(
    r"\b(html|css|web\s*page|webpage|website|landing|dashboard|"
    r"component|layout|styling|style|responsive|navbar|hero|footer|header|"
    r"sidebar|modal|form|button|card|menu|gallery|portfolio|"
    r"user\s+interface|ui|frontend|front-end|tailwind|bootstrap|"
    r"sign.?in|sign.?up|auth|login|register|onboarding|"
    r"design|token|font|typography|color|spacing|animation|motion|"
    r"chart|graph|data\s*viz|sparkline|metric|kpi|"
    r"chat|streaming|ai\s*interface|"
    r"viewport|breakpoint|mobile|tablet|desktop)\b",
    re.IGNORECASE,
)


def prompt_needs_design_guidance(prompt: str) -> bool:
    """Return True when the user's request involves UI/web work."""
    return bool(_UI_PROMPT_PATTERN.search(prompt or ""))


# ---------------------------------------------------------------------------
# Layer 1: Always-on taste injection
# ---------------------------------------------------------------------------

def inject_core_taste(system_prompt: str) -> str:
    """Inject compact, always-on guidance; detailed references load on demand."""
    if not get_core_prompt() and not get_routing_table():
        return system_prompt
    compact = """# UI Design System — Core Taste
Make deliberate choices for the product and audience. Inspect existing tokens,
fonts, and layout conventions first; preserve intentional project choices. If
the user has not set a visual direction, ask one compact question or state a
coherent assumption.

Create one clear focal point and hierarchy. Group with spacing before cards or
dividers. Use a consistent spacing scale, mostly neutral colors with one
restrained accent, and no more than two type families. Choose a composition
that fits the content, vary section rhythm, and use relevant imagery where it
helps. Avoid repeated template grids, generic gradients, decorative motion,
and placeholder content.

Use semantic HTML, responsive layouts, readable contrast, visible keyboard
focus, descriptive image text, and reduced-motion support. Reuse project
tokens and components. Add only sections and interactions that serve the
request. Pull a named design reference only when its detail is needed."""
    return f"{system_prompt}\n\n{compact}"


# ---------------------------------------------------------------------------
# Layer 2: Per-request reference injection
# ---------------------------------------------------------------------------

def inject_routed_references(system_prompt: str, routed: dict) -> str:
    """Inject pre-loaded references from the router into the system prompt.

    ``routed`` is the output of ``design_router.load_references()``.
    Each loaded reference is wrapped with its path as a comment header.
    """
    if not routed:
        return system_prompt

    parts = [system_prompt]

    # Router decision
    instruction = routed.get("instruction", "")
    if instruction:
        parts.append(f"\n\n## Router decision for this request\n\n{instruction}")

    # Out of scope
    oos = routed.get("out_of_scope", [])
    if oos:
        labels = ", ".join(o.get("label", "") for o in oos)
        parts.append(f"\n\nOut of scope for this request: {labels}.")

    # Loaded references
    loaded = routed.get("loaded", [])
    if loaded:
        parts.append("\n\n## Loaded references\n")
        for ref in loaded:
            path = ref.get("path", "")
            content = ref.get("content", "")
            parts.append(f"\n<!-- {path} -->\n\n{content}\n")

    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Discovery context (Layer 3)
# ---------------------------------------------------------------------------

def build_discovery_context(project_signals: dict | None = None) -> str:
    """Build the discovery context for the system prompt.

    Layer 3 of the design system. Scans for existing tokens/fonts in the
    project, or tells the model to ask the Quick Ask.
    """
    if not project_signals or not project_signals.get("has_tokens"):
        return (
            "DISCOVERY: no established design-token system detected. "
            "First infer the audience, product purpose, and main user action from "
            "the request and project. Ask one short question only when a missing "
            "product constraint would materially change the interface; otherwise "
            "state a concise product-led design direction and proceed. Do not "
            "interview the user about fonts, colors, or animation by default. "
            "Ask about stack (vanilla-CDN or Tailwind-Vite) only when the project "
            "does not make it clear and the choice affects implementation. "
            "See stack-choice.md for the decision rule and snippets. "
            "Seed new work from design-tokens-starter.css (vanilla) or its "
            "theme.extend mirror (Tailwind); copy animation from "
            "animation-recipes.md — never invent easings, durations, or "
            "physics from scratch. Motion and 3D are optional tools, not default "
            "styling: use 3D only when it explains the product or enables a "
            "meaningful interaction; otherwise prefer a product image, diagram, "
            "illustration, or typography-led composition. "
            "Cache the stack answer in design memory so it is asked once per project."
        )
    inventory = project_signals.get("inventory", {})
    return (
        f"DISCOVERY: project tokens found — they are the source of truth, "
        f"respect them. Inventory: {inventory} "
        f"Page CSS must reference tokens via var(), never hand-type values. "
        f"Motion: see animation-recipes.md; advisory lint: motion-lint-advisory.md."
    )


def scan_project_tokens(workspace_root: Path) -> dict:
    """Scan the project for existing design tokens, fonts, and style config.

    Returns a dict with ``has_tokens`` bool and ``inventory`` details.
    """
    inventory: dict[str, Any] = {}

    # Check for CSS custom properties
    css_files = list(workspace_root.rglob("*.css"))[:10]
    css_vars_found = False
    for css in css_files:
        try:
            text = css.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if "--color-" in text or "--font-" in text or "--spacing-" in text:
            css_vars_found = True
            inventory["css_variables"] = True
            break

    # Check for Tailwind config
    tailwind_files = list(workspace_root.rglob("tailwind.config.*"))
    if tailwind_files:
        inventory["tailwind"] = True
        try:
            tw_text = tailwind_files[0].read_text(encoding="utf-8", errors="replace")
            if "theme" in tw_text and "extend" in tw_text:
                inventory["tailwind_extended"] = True
        except OSError:
            pass

    # Check for globals.css
    globals_css = list(workspace_root.rglob("globals.css")) + list(workspace_root.rglob("global.css"))
    if globals_css:
        inventory["globals_css"] = str(globals_css[0].relative_to(workspace_root))

    # Check for font imports
    font_patterns = [
        re.compile(r"@import\s+['\"]https?://fonts\.googleapis\.com"),
        re.compile(r"next/font"),
        re.compile(r"font-family\s*:"),
    ]
    for css in css_files[:5]:
        try:
            text = css.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for pat in font_patterns:
            if pat.search(text):
                inventory["font_imports"] = True
                break

    # Check for component libraries
    pkg_json = workspace_root / "package.json"
    if pkg_json.exists():
        try:
            pkg_text = pkg_json.read_text(encoding="utf-8")
        except OSError:
            pkg_text = ""
        for lib in ("shadcn", "@radix-ui", "@mui/material", "antd", "chakra-ui"):
            if lib in pkg_text:
                inventory.setdefault("component_libraries", []).append(lib)

    # A font import, component library, or globals.css file is not itself a
    # design-token system. Treat only actual CSS custom properties or an
    # extended Tailwind theme as token evidence; otherwise discovery should
    # still establish a small, coherent set of tokens.
    has_tokens = bool(inventory.get("css_variables") or inventory.get("tailwind_extended"))
    return {"has_tokens": has_tokens, "inventory": inventory}


# ---------------------------------------------------------------------------
# Combined injection (convenience)
# ---------------------------------------------------------------------------

def inject_design_principles(
    system_prompt: str,
    role: str,
    prompt: str = "",
    workspace_root: Path | None = None,
    routed: dict | None = None,
) -> str:
    """Conditionally inject the full 3-layer design system.

    Injects when ``role`` is ``"ui_design"`` OR when the user's prompt
    mentions UI/web/design keywords.

    The 3 layers:
    1. Core taste (always-on when triggered)
    2. Per-request references (router output)
    3. Discovery context (project scan)
    """
    should_inject = role == "ui_design" or prompt_needs_design_guidance(prompt)
    if not should_inject:
        return system_prompt

    # Layer 1: Core taste
    result = inject_core_taste(system_prompt)

    # Layer 1b: concise UI guidance (kept out of the base prompt).
    result += (
        "\n\n## Design guidance (partly advisory)\n"
        "Follow the existing project stack and tokens. Prefer semantic HTML, "
        "responsive layouts, visible focus, meaningful content, and a clear "
        "visual hierarchy. Use verify_file for structural and syntax checks; "
        "visual quality, token use, and some style rules are not enforced "
        "automatically. When review_ui_render is available, inspect desktop "
        "and mobile output and fix concrete reported issues. Do not claim a "
        "visual review when the tool is unavailable."
    )

    # Layer 2: Routed references (if provided)
    if routed:
        result = inject_routed_references(result, routed)

    # Layer 3: Discovery
    if workspace_root:
        signals = scan_project_tokens(workspace_root)
        discovery = build_discovery_context(signals)
        # Persisted user preferences from /design (or direct callers): merge
        # after discovery so the agent respects them instead of re-asking.
        from xvie_agent.design_memory import format_design_memory, load_design_memory
        memory_text = format_design_memory(load_design_memory(workspace_root))
        if memory_text:
            discovery += (
                "\n\nDESIGN MEMORY (persisted user preferences — respect these, "
                "do not re-ask about them):\n" + memory_text
            )
        result += f"\n\n{discovery}"

    return result
