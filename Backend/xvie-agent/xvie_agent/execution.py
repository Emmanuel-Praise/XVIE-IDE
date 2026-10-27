"""Controller state and deterministic helpers for coding-task execution."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import StrEnum
from pathlib import Path
import subprocess
import sys
import re
import ast
import json
import logging

logger = logging.getLogger(__name__)


class PermissionMode(StrEnum):
    DEFAULT = "default"
    ACCEPT_EDITS = "accept-edits"
    PLAN = "plan"


class ExecutionPhase(StrEnum):
    INVESTIGATE = "investigate"
    PLAN = "plan"
    AWAITING_APPROVAL = "awaiting_approval"
    IMPLEMENT = "implement"
    VERIFY = "verify"
    REPORT = "report"


@dataclass
class TaskExecutionState:
    task_kind: str
    prompt: str
    phase: str = ExecutionPhase.INVESTIGATE
    inspected_files: list[str] = field(default_factory=list)
    proposed_plan: str = ""
    approved: bool = False
    changed_files: list[str] = field(default_factory=list)
    verification_command: str = ""
    verification_output: str = ""
    verification_outcome: str = "not_run"
    final_outcome: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict | None) -> "TaskExecutionState | None":
        return cls(**data) if data else None


def bounded_inventory(root: Path, limit: int | None = None) -> list[str]:
    """Return a small, deterministic project inventory without hidden model work.

    Pruned walk: ignored dirs are never descended into, so a big ``.venv``
    or ``.git`` doesn't cost an ``rglob("*")`` over thousands of files
    before the first model call. Default 30 (env ``XVIE_INVENTORY_LIMIT``)
    — 80-file inventories crowded the prompt and triggered trims.
    """
    import os as _os
    if limit is None:
        try:
            limit = max(10, int(_os.getenv("XVIE_INVENTORY_LIMIT", "30")))
        except ValueError:
            limit = 30
    ignored = {
        ".git", ".venv", "__pycache__", ".pytest_cache", ".xvie-sessions",
        ".xvie", ".forge-sessions", "node_modules", ".mypy_cache", ".ruff_cache",
        ".pytest-tmp", "dist", "build", ".tox",
    }
    files: list[str] = []
    # Stack of dirs to visit; sorted for determinism, pruned aggressively.
    # Depth-first with early stop once `limit` files are collected.
    stack: list[Path] = [root]
    while stack and len(files) < limit:
        current = stack.pop()
        try:
            entries = sorted(current.iterdir(), key=lambda p: p.name)
        except OSError:
            continue
        # Queue subdirs for later (reversed so pop() stays alphabetical).
        subdirs: list[Path] = []
        for entry in entries:
            name = entry.name
            if name in ignored:
                continue
            try:
                if entry.is_dir() and not entry.is_symlink():
                    subdirs.append(entry)
                elif entry.is_file():
                    try:
                        files.append(str(entry.relative_to(root)))
                    except ValueError:
                        continue
                    if len(files) >= limit:
                        break
            except OSError:
                continue
        stack.extend(reversed(subdirs))
    return files


def build_relevant_context(root: Path, prompt: str, limit: int | None = None) -> str:
    """Read small, high-signal project files and explicitly named targets."""
    import os as _os
    if limit is None:
        try:
            limit = max(2000, int(_os.getenv("XVIE_RELEVANT_CONTEXT_CHARS", "6000")))
        except ValueError:
            limit = 6_000
    candidates = ["README.md", "pyproject.toml", "package.json", "tsconfig.json", "index.html"]
    candidates.extend(re.findall(r"\b[\w./-]+\.(?:py|html|css|js|ts|json|md)\b", prompt, re.I))
    seen: set[str] = set()
    parts: list[str] = []
    remaining = limit
    for relative in candidates:
        if relative in seen:
            continue
        seen.add(relative)
        path = (root / relative).resolve()
        if root not in path.parents or not path.is_file():
            continue
        try:
            content = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        excerpt = content[:remaining]
        parts.append(f"--- {relative} ---\n{excerpt}")
        remaining -= len(excerpt)
        if remaining <= 0:
            break
    return "\n\n".join(parts)


def is_website_task(prompt: str) -> bool:
    return bool(re.search(r"\b(website|webpage|landing page|html|css|frontend|front-end)\b", prompt, re.I))


def detect_verification_command(root: Path) -> str:
    """Choose only conventional local checks; never infer arbitrary shell code."""
    if (root / "pyproject.toml").exists() or (root / "pytest.ini").exists():
        return "python -m pytest -q"
    if (root / "package.json").exists():
        return "npm test -- --runInBand"
    if (root / "Cargo.toml").exists():
        return "cargo test"
    if (root / "go.mod").exists():
        return "go test ./..."
    return ""


def run_verification(command: str, root: Path, timeout: int) -> tuple[bool, str]:
    """Run a selected local check and report its real process exit status."""
    if sys.platform == "win32":
        command = re.sub(r"^(python3?|py)(?=\s)", lambda _: f'"{sys.executable}"', command, count=1)
    try:
        completed = subprocess.run(
            command, shell=True, capture_output=True, text=True,
            timeout=timeout, cwd=str(root),
        )
    except subprocess.TimeoutExpired:
        return False, f"Verification timed out after {timeout}s: {command}"
    output = (completed.stdout or "")
    if completed.stderr:
        output += ("\n" if output else "") + completed.stderr
    if completed.returncode:
        output += f"\n(exit code: {completed.returncode})"
    return completed.returncode == 0, output


def validate_changed_file(path: str, root: Path, *, rich_html: bool = False) -> str | None:
    """Return a concrete validation error for common generated artifact types.

    For HTML files with ``rich_html=True``, performs deep quality validation:
    responsive design, semantic structure, accessibility, and real content.
    """
    target = (root / path).resolve()
    if not target.exists() or not target.is_file():
        return f"Generated file is missing: {path}"
    try:
        content = target.read_text(encoding="utf-8")
    except OSError as exc:
        return f"Could not read generated file {path}: {exc}"
    suffix = target.suffix.lower()
    if suffix in {".html", ".htm"}:
        lowered = content.lower()
        required = ("<!doctype html", "<html", "</html>", "<head", "</head>", "<title", "</title>", "<body", "</body>")
        missing = [marker for marker in required if marker not in lowered]
        if missing:
            return f"Incomplete HTML document in {path}; missing: {', '.join(missing)}"
        if content.rfind("<") > content.rfind(">"):
            return f"Incomplete HTML tag at end of {path}; rewrite the full document"
        if rich_html:
            errors = _validate_rich_html(content, lowered, path)
            if errors:
                return errors
    elif suffix == ".css":
        return _validate_css(content, path)
    elif suffix == ".py":
        try:
            ast.parse(content, filename=path)
        except SyntaxError as exc:
            return f"Python syntax error in {path}: {exc.msg} at line {exc.lineno}"
    elif suffix == ".json":
        try:
            json.loads(content)
        except json.JSONDecodeError as exc:
            return f"Invalid JSON in {path}: {exc.msg}"
    elif suffix == ".js":
        # Basic JS syntax check — balanced braces
        if content.count("{") != content.count("}"):
            return f"Unbalanced braces in {path} — possible syntax error"
        js_ref_error = _validate_js_references_against_siblings(content, root, path)
        if js_ref_error:
            return js_ref_error
    return None


def validate_responsive_render(path: str, root: Path) -> str | None:
    """Check a page at desktop and mobile widths when the visual extra exists.

    Returns a repairable diagnostic for horizontal overflow. On installations
    without Playwright, retain the static quality gate and log that a browser
    pass was unavailable rather than making all HTML work unusable.
    """
    target = (root / path).resolve()
    if root.resolve() not in target.parents or target.suffix.lower() not in {".html", ".htm"}:
        return None
    if not target.is_file():
        return f"Responsive preview could not find {path}."
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        logger.info("Skipping browser responsive check for %s; Playwright visual extra is not installed", path)
        return None

    import functools
    import http.server
    import threading
    from urllib.parse import quote

    class QuietHandler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, format: str, *args: object) -> None:
            return

    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0),
        functools.partial(QuietHandler, directory=str(root.resolve())),
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    relative_path = target.relative_to(root.resolve()).as_posix()
    url = f"http://127.0.0.1:{server.server_port}/{quote(relative_path, safe='/')}"
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel="chromium")
            try:
                issues: list[str] = []
                for label, width, height in (("desktop", 1440, 1000), ("mobile", 390, 844)):
                    page = browser.new_page(viewport={"width": width, "height": height})
                    page.goto(url, wait_until="domcontentloaded", timeout=30_000)
                    page.wait_for_timeout(150)
                    metrics = page.evaluate("""() => ({
                      viewport: document.documentElement.clientWidth,
                      document: document.documentElement.scrollWidth
                    })""")
                    if metrics["document"] > metrics["viewport"] + 1:
                        issues.append(
                            f"{label} layout overflows horizontally: content is "
                            f"{metrics['document']}px wide in a {metrics['viewport']}px viewport"
                        )
                    page.close()
                return f"Responsive browser check failed for {path}: " + "; ".join(issues) if issues else None
            finally:
                browser.close()
    except Exception as exc:  # noqa: BLE001 - browser availability varies by installation
        detail = str(exc)
        unavailable_markers = (
            "executable doesn't exist",
            "executable does not exist",
            "chromium distribution",
            "please run the following command",
        )
        if any(marker in detail.lower() for marker in unavailable_markers):
            logger.warning("Browser responsive check unavailable for %s: %s", path, detail)
            return None
        logger.warning("Browser responsive check failed for %s: %s", path, detail)
        return f"Responsive browser check could not render {path}: {detail}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


# ---------------------------------------------------------------------------
# Deep HTML/CSS validation for website tasks
# ---------------------------------------------------------------------------

# Minimum content thresholds
_MIN_HTML_SIZE = 1200      # A real page needs at least ~1.2KB
_MIN_CSS_SIZE = 500        # Real styling needs at least 500 bytes
_MIN_CSS_RULES = 8         # A styled page has at least 8 CSS rules
_MIN_HTML_ELEMENTS = 15    # A real page has at least 15 HTML elements


def _validate_rich_html(content: str, lowered: str, path: str) -> str | None:
    """Deep validation for website HTML artifacts."""
    import re as _re
    issues: list[str] = []

    # --- Size check ---
    if len(content) < _MIN_HTML_SIZE:
        issues.append(f"file is only {len(content)} bytes (minimum {_MIN_HTML_SIZE} for a real page)")

    # --- Responsive design ---
    has_viewport = '<meta name="viewport"' in lowered
    if not has_viewport:
        issues.append("missing viewport meta tag (required for responsive design)")

    # --- Semantic HTML ---
    semantic_elements = ('<header', '<main', '<footer', '<nav', '<section', '<article', '<aside')
    present_semantic = [e for e in semantic_elements if e in lowered]
    if len(present_semantic) < 2:
        issues.append(f"too few semantic HTML elements ({len(present_semantic)} found, need at least 2 of: header, main, footer, nav, section, article)")

    # --- Accessibility basics ---
    has_lang = 'lang=' in lowered
    has_alt = 'alt=' in lowered
    has_labels = '<label' in lowered or 'aria-label' in lowered or 'aria-labelledby' in lowered
    has_focus = ':focus' in lowered or 'focus-visible' in lowered
    if not has_lang:
        issues.append("missing lang attribute on <html> (accessibility)")
    if '<img' in lowered and not has_alt:
        issues.append("images missing alt attributes (accessibility)")
    if '<input' in lowered and not has_labels:
        issues.append("form inputs missing labels (accessibility)")

    # --- Real content check ---
    placeholder_patterns = (
        'lorem ipsum', 'placeholder', 'sample text', 'todo', 'add content here',
        'rest of', 'will be populat', 'coming soon', 'insert image', 'add image here',
    )
    placeholders_found = [p for p in placeholder_patterns if p in lowered]
    if placeholders_found:
        issues.append(f"contains placeholder content: {', '.join(placeholders_found)} — write real content")

    # --- Empty media wrappers (image slot with nothing in it) ---
    for match in _re.finditer(
        r'<(div|figure|picture)[^>]*class="[^"]*(image|media|picture|photo|gallery)[^"]*"[^>]*>(.*?)</\1>',
        lowered, _re.DOTALL,
    ):
        raw_inner = match.group(3)
        # Void media elements count as real content even though they hold no text.
        if _re.search(r'<(img|video|canvas|svg|picture|source)\b', raw_inner):
            continue
        inner = _re.sub(r'<!--.*?-->', '', raw_inner, flags=_re.DOTALL).strip()
        inner = _re.sub(r'<[^>]+>', '', inner).strip()
        if not inner:
            issues.append(
                "empty image/media wrapper with no real content — "
                "use search_images for a real photo or remove the slot"
            )
            break

    # --- Structure checks ---
    has_title_tag = '<title>' in lowered and '</title>' in lowered
    if not has_title_tag:
        issues.append("missing <title> tag")

    # Check for unescaped content (model output as JSON text in HTML)
    if '"model_text"' in content or '"tool_calls"' in content:
        issues.append("contains raw JSON/tool output — this is not valid HTML")

    # Check for verification hacks — dummy media queries, hidden test divs
    if _re.search(r'(?i)(dummy|fake|satisfy.*verifier|hack.*verifier)', content):
        issues.append(
            "contains verification hack (dummy media query / fake element) — "
            "build REAL responsive design instead of gaming the validator"
        )
    if _re.search(r'(?i)<[^>]*class="[^"]*responsive-test[^"]*"[^>]*style="[^"]*display:\s*none', content):
        issues.append(
            "contains hidden test div to fake responsiveness — "
            "remove it and add actual responsive CSS"
        )
    # Validator-gaming class: slapping class="responsive" on <body>/<html>
    # to satisfy the responsive check without real responsive design.
    if _re.search(r'(?i)<(body|html)[^>]*class="[^"]*\bresponsive\b[^"]*"', content):
        issues.append(
            "class=\"responsive\" on <body>/<html> games the validator — "
            "remove it and add real @media queries / flexbox / grid"
        )

    # Check for too many inline styles (should be in <style> or external CSS)
    inline_count = content.count('style="') + content.count("style='")
    if inline_count > 10:
        issues.append(f"{inline_count} inline styles — move CSS to <style> block or external file")

    # --- Layout quality checks ---
    layout_issues = _validate_layout_quality_html(content, lowered)
    issues.extend(layout_issues)

    # --- Motion P0 checks (feel-breaking only; style issues are warnings) ---
    issues.extend(_motion_p0_errors(content, lowered, path))

    if issues:
        return f"HTML quality issues in {path}:\n  - " + "\n  - ".join(issues)
    return None


# ---------------------------------------------------------------------------
# Layout quality validation
# ---------------------------------------------------------------------------

# Section-level selectors that should have varied padding
_SECTION_SELECTORS = (
    '.hero', '.features', '.pricing', '.testimonials', '.cta',
    '.code-preview-section', '.demo', '.about', '.contact',
)

# Container selectors that need flex/grid for horizontal layouts
_HORIZONTAL_CONTAINERS = (
    ('.header .container', '.header'),
    ('.hero .container', '.hero'),
    ('.navbar .container', '.navbar'),
    ('.nav-container', '.nav'),
)


def _validate_layout_quality_css(content: str) -> list[str]:
    """Check CSS for common layout anti-patterns.

    Catches: missing flex on containers, centering slop, uniform spacing.
    Returns a list of issue strings (empty if no problems found).
    """
    import re as _re
    issues: list[str] = []
    lowered = content.lower()

    # --- Check 1: Missing flex on horizontal containers ---
    for container_selector, _label in _HORIZONTAL_CONTAINERS:
        # Check if this selector exists and has display: flex or display: grid
        # Pattern: .header .container { ... display: flex ... }
        selector_escaped = _re.escape(container_selector)
        # Match the selector block and its content
        pattern = rf'{selector_escaped}\s*\{{([^}}]*)\}}'
        match = _re.search(pattern, lowered)
        if match:
            block = match.group(1)
            if 'display' in block and ('flex' in block or 'grid' in block):
                continue  # Has layout — good
        # If selector exists in CSS but has no flex/grid, flag it
        if container_selector in lowered:
            has_flex_in_file = f'{container_selector}' in lowered and (
                'display: flex' in lowered or 'display:flex' in lowered
            )
            # Only flag if the file has flex somewhere (means they know about flex)
            # but didn't apply it to this container
            if has_flex_in_file:
                issues.append(
                    f"missing display:flex on {container_selector} -- "
                    "children will stack vertically by default. "
                    f"Add: {container_selector} {{ display: flex; align-items: center; }}"
                )

    # --- Check 2: Centering slop — too many text-align: center ---
    center_count = len(_re.findall(r'text-align\s*:\s*center', lowered))
    if center_count > 3:
        issues.append(
            f"text-align: center appears {center_count} times -- "
            "this is centering-everything slop. Left-align feature cards, "
            "pricing lists, testimonials, and body text. Reserve center "
            "alignment for CTAs and formal heroes only."
        )

    # --- Check 3: Uniform section padding ---
    # Find all padding values on section selectors
    section_paddings: list[str] = []
    for selector in _SECTION_SELECTORS:
        selector_escaped = _re.escape(selector)
        pattern = rf'{selector_escaped}\s*\{{([^}}]*)\}}'
        match = _re.search(pattern, lowered)
        if match:
            block = match.group(1)
            # Extract padding value (e.g., "padding: 6rem 0" → "6rem")
            pad_match = _re.search(r'padding\s*:\s*(\d+(?:\.\d+)?(?:rem|px|em))', block)
            if pad_match:
                section_paddings.append(pad_match.group(1))

    if len(section_paddings) >= 3:
        # Check if most sections use the same padding
        from collections import Counter
        counts = Counter(section_paddings)
        most_common_val, most_common_count = counts.most_common(1)[0]
        if most_common_count >= len(section_paddings) * 0.6 and most_common_count >= 3:
            issues.append(
                f"uniform section padding ({most_common_val} on {most_common_count}/{len(section_paddings)} sections) -- "
                "section spacing MUST vary to create visual rhythm. "
                "Use different padding per section (e.g., hero 8rem, features 6rem, "
                "demo 4rem, pricing 6rem, cta 5rem, footer 3rem)."
            )

    return issues


def _validate_layout_quality_html(content: str, lowered: str) -> list[str]:
    """Check HTML for layout anti-patterns.

    Returns a list of issue strings (empty if no problems found).
    """
    import re as _re
    issues: list[str] = []

    # --- Check 1: Header without horizontal layout hint ---
    has_header = '<header' in lowered
    has_nav = '<nav' in lowered
    if has_header and has_nav:
        # Check if there's a container with flex-related classes
        header_section = lowered[lowered.find('<header'):lowered.find('</header>') + 100] if '</header>' in lowered else ''
        if header_section and 'flex' not in header_section and 'grid' not in header_section:
            # The CSS should handle this, but flag if inline styles don't have it
            pass  # CSS handles this — HTML check is secondary

    # --- Check 2: Feature grid (uniform cards = anti-pattern) ---
    # Detect uniform card grids: 3+ elements with same class in a container
    feature_cards = _re.findall(r'class="([^"]*feature-card[^"]*)"', lowered)
    if len(feature_cards) >= 3:
        issues.append(
            f"{len(feature_cards)} identical feature cards detected -- "
            "uniform icon+heading+text card grids are the #1 AI template tell. "
            "Use alternating asymmetric rows with real visuals instead. "
            "See layout.md -> Required CSS Patterns -> Feature alternating rows."
        )

    # --- Check 3: Pricing cards (check for popular card scaling) ---
    pricing_cards = _re.findall(r'class="([^"]*pricing-card[^"]*)"', lowered)
    if len(pricing_cards) >= 3:
        has_popular = any('popular' in card for card in pricing_cards)
        if not has_popular:
            issues.append(
                f"{len(pricing_cards)} pricing cards but none highlighted as popular -- "
                "one card should be visually dominant (scale, border, badge)."
            )

    # --- Check 4: Emoji-as-icon (blocking) ---
    # An element whose class says "icon" but whose entire content is emoji.
    # General prose emoji stays advisory (see collect_design_warnings).
    _EMOJI_CHARS = (
        r'\U0001F300-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\u2300-\u23FF'
        r'\u2640\u2642\u2699\uFE0F\u200D\s'
    )
    for match in _re.finditer(
        r'<([a-zA-Z][a-zA-Z0-9]*)[^>]*class="[^"]*icon[^"]*"[^>]*>(.*?)</\1>',
        lowered, _re.DOTALL,
    ):
        inner = _re.sub(r'<[^>]+>', '', match.group(2)).strip()
        # U+231A (watch) lives in U+2300-23FF, outside the 2600 block.
        if inner and _re.search(r'[\U0001F300-\U0001FAFF\u2600-\u27BF\u2300-\u23FF]', inner) \
                and _re.fullmatch(f'[{_EMOJI_CHARS}]+', inner):
            issues.append(
                "emoji used as an icon — draw a real inline SVG icon "
                "(single stroke) instead of emoji"
            )
            break

    # --- Check 5: Uniform spec/testimonial grids (blocking at 4+) ---
    # 4+ blocks sharing an identical stem with no variance is the template
    # tell. Counts block-level class attributes only. Nav lists etc. are not
    # in these stems.
    for stem in ('spec-item', 'spec-value', 'testimonial'):
        found = _re.findall(rf'class="{stem}(?:\s|")', lowered)
        if len(found) >= 4:
            issues.append(
                f"{len(found)} identical .{stem} blocks — uniform repeated "
                "grids read as AI slop. Vary the blocks (alternating rows, "
                "mixed sizes, real visuals) instead of stamping one pattern."
            )
            break

    # --- Check 5b: Uniform feature rows, single-file pages ---
    # Same rule for .feature-row, judged on the embedded <style> (split-file
    # pages defer to validate_layout_pair, which sees the external CSS and
    # honors :nth-child alternation like agents-landing-page uses).
    rows = _re.findall(r'class="feature-row(?:\s|")', lowered)
    if len(rows) >= 4 and '<style' in lowered \
            and 'feature-row:nth-child' not in lowered:
        issues.append(
            f"{len(rows)} identical .feature-row blocks with no :nth-child "
            "alternation in the page CSS — alternate row composition instead "
            "of stamping one pattern."
        )

    # --- Check 6: Fake alternation (every row carries --alt) ---
    rows = _re.findall(r'class="([^"]*feature-row[^"]*)"', lowered)
    if len(rows) >= 2 and all('--alt' in row for row in rows):
        issues.append(
            "every feature row uses --alt: nothing actually alternates. "
            "Alternate the modifier (or vary row composition) so rows differ."
        )

    return issues


def _strip_css_comments(content: str) -> tuple[str, bool, int]:
    """Strip comments and count CSS-looking blocks hidden inside them."""
    import re as _re
    output: list[str] = []
    hidden_rules = 0
    quote: str | None = None
    escaped = False
    index = 0
    while index < len(content):
        char = content[index]
        if quote:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            index += 1
            continue
        if char in ("'", '"'):
            quote = char
            output.append(char)
            index += 1
            continue
        if content.startswith("/*", index):
            end = content.find("*/", index + 2)
            if end < 0:
                return "".join(output), True, hidden_rules
            comment = content[index:end + 2]
            selectors = _re.findall(
                r"(?:^|\n)\s*(?:[.#][\w-]+|[a-z][\w-]*(?:[.#][\w-]+)?)(?:[^{};\r\n]*)\s*\{\s*(?=[^}]*\})",
                comment,
                _re.IGNORECASE,
            )
            declarations = _re.findall(
                r"(?:--[\w-]+|[\w-]+)\s*:\s*[^;{}\r\n]+;",
                comment,
            )
            if len(selectors) >= 2 and len(declarations) >= 2:
                hidden_rules += len(selectors)
            output.append("".join("\n" if c == "\n" else "\r" if c == "\r" else " " for c in comment))
            index = end + 2
            continue
        output.append(char)
        index += 1
    return "".join(output), False, hidden_rules


def _validate_css(content: str, path: str) -> str | None:
    """Validate CSS files for quality and correctness."""
    issues: list[str] = []
    css_code, unclosed_comment, hidden_rules = _strip_css_comments(content)
    if unclosed_comment:
        issues.append("unclosed CSS block comment (missing */); the rest of the stylesheet would be ignored")
    if hidden_rules:
        issues.append(f"{hidden_rules} CSS rule blocks appear inside a comment; check for a misplaced */ that is hiding stylesheet rules")

    # --- Basic syntax ---
    if css_code.count('{') != css_code.count('}'):
        issues.append(f"unbalanced braces ({css_code.count('{')} open, {css_code.count('}')} close)")

    # --- Broken var() calls ---
    # Detect: var-radius-sm) or var-radius-sm without opening paren
    import re as _re
    broken_vars = _re.findall(r'\bvar-[a-zA-Z]', css_code)
    if broken_vars:
        issues.append(
            f"broken CSS var() syntax: found {broken_vars[:3]} — "
            "use var(--name) format with double-dash prefix"
        )
    # Also detect unclosed var() — opening without closing
    unclosed = _re.findall(r'var\([^)]*$', css_code, _re.MULTILINE)
    if unclosed:
        issues.append("unclosed var() function call — missing closing parenthesis")

    # --- Size check ---
    if len(css_code) < _MIN_CSS_SIZE:
        issues.append(f"file is only {len(css_code)} bytes (minimum {_MIN_CSS_SIZE} for real styling)")

    # --- Rule count ---
    rule_count = css_code.count('{')
    if rule_count < _MIN_CSS_RULES:
        issues.append(f"only {rule_count} CSS rules (minimum {_MIN_CSS_RULES} for a styled page)")

    # --- Consistent spacing ---
    pixel_values = _re.findall(r'\b(\d+)px', css_code)
    if pixel_values:
        spacing_scale = {4, 8, 12, 16, 24, 32, 48, 64}
        off_scale = [v for v in pixel_values if int(v) not in spacing_scale and int(v) > 2]
        if len(off_scale) > len(pixel_values) * 0.5:
            issues.append("many pixel values not on the 4/8/12/16/24/32/48/64px spacing scale")

    # --- Color contrast hint ---
    hex_colors = _re.findall(r'#[0-9a-fA-F]{3,6}\b', css_code)
    # Check for common low-contrast pairs
    if '#888' in css_code.lower() or '#999' in css_code.lower() or '#aaa' in css_code.lower():
        issues.append("light gray text (#888/#999/#aaa) may have poor contrast — verify readability")

    # --- Layout quality checks ---
    layout_issues = _validate_layout_quality_css(css_code)
    issues.extend(layout_issues)

    # --- Motion P0 checks (feel-breaking only; style issues are warnings) ---
    issues.extend(_motion_p0_css_errors(css_code, path))

    if issues:
        return f"CSS quality issues in {path}:\n  - " + "\n  - ".join(issues)
    return None


# ---------------------------------------------------------------------------
# Motion P0 validators (blocking) + design warnings (advisory)
# ---------------------------------------------------------------------------
#
# Tiering rule: only feel-breaking / performance / accessibility motion bugs
# fail verification. Taste-level slop, type guards, token usage, and state
# coverage are reported via collect_design_warnings() and never block.

# Focal-entrance ceiling: UI chrome must stay under 300ms; one authored
# focal moment may run up to 800ms. Anything slower fails.
_MOTION_P0_UI_CAP_MS = 300
_MOTION_P0_FOCAL_CAP_MS = 800

# Banned display faces (AI-template tells) — warning only.
_BANNED_DISPLAY_FACES = (
    "fraunces", "playfair", "cormorant", "lora", "newsreader", "syne",
    "space grotesk", "space mono", "ibm plex", "dm sans", "dm serif",
    "outfit", "plus jakarta", "instrument",
)


def _iter_css_texts(content: str, lowered: str) -> list[str]:
    """Return standalone CSS text plus any embedded <style> blocks."""
    texts = [content]
    for match in re.finditer(r'<style[^>]*>(.*?)</style>', lowered, re.DOTALL):
        texts.append(match.group(1))
    return texts


def _durations_ms(declaration: str) -> list[float]:
    """Extract durations from a transition/animation declaration in ms."""
    out: list[float] = []
    for value, unit in re.findall(r'(\d+(?:\.\d+)?)\s*(ms|s)\b', declaration):
        out.append(float(value) if unit == 'ms' else float(value) * 1000)
    return out


def _motion_p0_css_errors(css_text: str, path: str) -> list[str]:
    """Blocking motion checks over a CSS text (file or <style> block)."""
    errors: list[str] = []
    lowered = css_text.lower()

    # M1: transition: all — animates random props, drops frames.
    if re.search(r'transition\s*:[^;{]*\ball\b', lowered):
        errors.append(
            "transition: all detected — list exact properties instead "
            "(e.g. transition: transform 250ms var(--ease-out), opacity 250ms)"
        )

    # M2: scale(0) start — pops in from nothing.
    if re.search(r'scale\(\s*0(\.0+)?\s*[,)]', lowered):
        errors.append(
            "scale(0) detected — start at scale(0.95) + opacity:0 instead"
        )

    # M3: bare ease-in (not ease-in-out) in transitions — dead on arrival.
    for match in re.finditer(r'(?:transition|animation)[^;{]*', lowered):
        decl = match.group(0)
        if re.search(r'\bease-in\b(?!-out)', decl):
            errors.append(
                "ease-in on UI motion — use ease-out for enters/exits "
                "(ease-in-out only for moves/morphs)"
            )
            break

    # M4: duration ceiling — >800ms fails; 300-800ms is a warning (see below).
    slow_hard = False
    for match in re.finditer(r'(?:transition|animation)\s*:[^;{]*', lowered):
        if any(d > _MOTION_P0_FOCAL_CAP_MS for d in _durations_ms(match.group(0))):
            slow_hard = True
            break
    if slow_hard:
        errors.append(
            f"animation slower than {_MOTION_P0_FOCAL_CAP_MS}ms — even focal "
            "entrances must finish within 800ms (UI chrome: 300ms)"
        )

    # M5: layout-property animation — width/top/left jank (height: accordion only).
    for match in re.finditer(r'transition(?:-property)?\s*:[^;{]*', lowered):
        decl = match.group(0)
        bad = [p for p in ('width', 'top', 'left') if re.search(rf'\b{p}\b', decl)]
        if bad:
            errors.append(
                f"animating layout propert{'y' if len(bad) == 1 else 'ies'} "
                f"({', '.join(bad)}) — animate transform/opacity/clip-path instead"
            )
            break

    # M6: animated blur over 20px — blur jank (scoped to animated lines only).
    for line in lowered.splitlines():
        if ('transition' in line or 'animation' in line or 'filter' in line) \
                and re.search(r'blur\(\s*([2-9]\d|\d{3,})px', line):
            errors.append(
                "animated blur() over 20px — bound blur, isolate the layer, "
                "or use opacity crossfade instead"
            )
            break

    return errors


def _motion_p0_errors(content: str, lowered: str, path: str) -> list[str]:
    """Blocking motion checks for HTML (delegates CSS text to css checker)."""
    errors: list[str] = []
    for css_text in _iter_css_texts(content, lowered):
        errors.extend(_motion_p0_css_errors(css_text, path))

    # M9: motion without a reduced-motion alternative — accessibility blocker.
    has_motion = bool(re.search(
        r'(transition\s*:|animation\s*:|@keyframes|element\.animate\()', lowered
    ))
    if has_motion and 'prefers-reduced-motion' not in lowered:
        errors.append(
            "motion without prefers-reduced-motion alternative — add a "
            "reduce (not erase) block for all animation"
        )
    return errors


def _warn_completeness(content: str, lowered: str) -> list[str]:
    """Advisory page-completeness checks (never blocking).

    Catches thin first passes: too few sections, thin footer, hero without
    proof/CTAs. Blocking would break generic pages, so these warn — the
    prompt + router pinning enforce richness, this surfaces drift.
    """
    warnings: list[str] = []
    sections = len(re.findall(r'<section\b', lowered))
    if '<main' in lowered and sections < 3:
        warnings.append(
            f"only {sections} <section> blocks — landing pages need >=5 "
            "content sections (proof strip, 2-3 feature rows, social proof, "
            "pricing, FAQ, final CTA); see page-completeness.md"
        )
    if '<footer' in lowered:
        footer = lowered[lowered.find('<footer'):lowered.find('</footer>') + 9] if '</footer>' in lowered else ''
        cols = len(re.findall(r'<(div|nav|ul|section)[^>]*(col|group|link)', footer))
        links = len(re.findall(r'<a\b', footer))
        if links < 6:
            warnings.append(
                f"thin footer (~{links} links) — rich footer needs brand col + "
                ">=3 link groups + legal bar (>=6 links total)"
            )
    if 'hero' in lowered:
        hero = lowered[lowered.find('hero'):lowered.find('hero') + 4000]
        has_cta = 'cta' in hero or '<button' in hero or '<a' in hero
        has_proof = any(w in hero for w in ('avatar', 'rating', 'trusted', 'proof', '<img', '<svg'))
        if not (has_cta and has_proof):
            warnings.append(
                "hero without proof + CTAs — add primary/ghost CTA and a "
                "trust signal (avatars, stat, product visual)"
            )
    words = len(re.findall(r'[a-z]{2,}', lowered))
    if '<main' in lowered and words < 300:
        warnings.append(
            f"thin copy (~{words} words) — feature rows need real specifics, "
            ">=2 quotes, >=4 FAQ answers; never placeholders"
        )
    return warnings


def _warn_states(lowered: str) -> list[str]:
    """Advisory: interactive-state coverage (never blocking)."""
    warnings: list[str] = []
    states = (
        ('hover', (':hover', 'data-hover')),
        ('disabled', (':disabled', '[disabled]', 'aria-disabled')),
        ('loading', ('loading', 'skeleton', 'spinner', 'aria-busy')),
        ('error', ('error', 'invalid', 'role="alert"', 'aria-invalid')),
        ('empty', ('empty', 'empty-state', 'no-results', 'zero-state')),
        ('focus-visible', (':focus', 'focus-visible')),
    )
    for name, markers in states:
        if not any(m in lowered for m in markers):
            warnings.append(f"no {name} state styles detected — add {name} coverage")
    return warnings


def _warn_slop_html(content: str, lowered: str) -> list[str]:
    """Advisory slop/type checks for HTML (never blocking)."""
    warnings: list[str] = []
    # S4: eyebrow/kicker above heading.
    if re.search(r'class="[^"]*(eyebrow|kicker)[^"]*"', lowered):
        warnings.append("eyebrow/kicker class above heading — fold the label into the heading block")
    # S5: 01/02/03 section numbers.
    if re.search(r'>\s*0[1-9]\s*<', content):
        warnings.append("numbered-section tell (01/02/…) — use real headings instead")
    # S6: modal without dialog semantics.
    if re.search(r'class="[^"]*modal[^"]*"', lowered) and 'role="dialog"' not in lowered:
        warnings.append("modal without role=\"dialog\" — add dialog semantics + focus trap")
    # S3: hero stat cluster (hero-metric template).
    if 'hero' in lowered and len(re.findall(r'class="[^"]*\bstat\b[^"]*"', lowered)) >= 3:
        warnings.append("hero stat cluster — the hero-metric template reads as AI slop")
    # S2: nested cards (card inside card).
    if re.search(
        r'class="[^"]*\bcard\b[^"]*"[^>]*>(?:(?!</div>).)*class="[^"]*\bcard\b',
        lowered, re.DOTALL,
    ):
        warnings.append("nested card detected — cards-in-cards are always wrong")
    # S10: emoji icons.
    if re.search(r'[\U0001F300-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF]', content):
        warnings.append("emoji used as icon — use drawn inline SVG (single stroke)")
    return warnings


def _warn_slop_css(css_text: str) -> list[str]:
    """Advisory slop/motion/type checks for CSS text (never blocking)."""
    warnings: list[str] = []
    lowered = css_text.lower()
    # M4 soft band: 300-800ms UI motion (fine only for focal entrances).
    for match in re.finditer(r'(?:transition|animation)\s*:[^;{]*', lowered):
        if any(_MOTION_P0_UI_CAP_MS < d <= _MOTION_P0_FOCAL_CAP_MS
               for d in _durations_ms(match.group(0))):
            warnings.append(
                "motion over 300ms — acceptable only for one focal entrance "
                "(UI chrome must stay under 300ms)"
            )
            break
    # M7: keyframes driving toasts/toggles (should be interruptible transitions).
    if '@keyframes' in lowered and re.search(r'\.(toast|toggle|switch)\b', lowered):
        warnings.append("keyframes on toast/toggle — use interruptible transitions instead")
    # M8: centered transform origin (popovers need trigger-anchored origins).
    if re.search(r'transform-origin\s*:\s*center', lowered):
        warnings.append(
            "transform-origin:center — popovers need var(--transform-origin) from the trigger"
        )
    # M10: ungated hover (touch devices get stuck hover).
    if ':hover' in lowered and '(hover:hover)' not in lowered:
        warnings.append("hover styles without (hover:hover) and (pointer:fine) gate")
    # S7: gradient text.
    if 'background-clip' in lowered and 'text' in lowered:
        warnings.append("gradient text — flat ink almost always wins")
    # S9: thick side-stripe borders.
    stripe = re.search(r'border-(?:left|right)\s*:\s*(\d+)px', lowered)
    if stripe and int(stripe.group(1)) > 1:
        warnings.append("thick side-stripe border — use spacing/hierarchy instead")
    # Type guards: banned display faces, body floor, display ceiling, tracking floor.
    for face in _BANNED_DISPLAY_FACES:
        if face in lowered:
            warnings.append(f"banned display face '{face}' — pick a less guessable typeface")
            break
    body_fs = re.search(r'body\s*\{[^}]*?font-size\s*:\s*(\d+(?:\.\d+)?)px', lowered)
    if body_fs and float(body_fs.group(1)) < 16:
        warnings.append("body text under 16px — iOS zooms and readability suffers")
    big_fs = re.search(r'font-size\s*:\s*(\d+(?:\.\d+)?)rem', lowered)
    if big_fs and float(big_fs.group(1)) > 6:
        warnings.append("display type over 6rem — cap the top of the ramp")
    tight = re.search(r'letter-spacing\s*:\s*(-\d+(?:\.\d+)?)em', lowered)
    if tight and float(tight.group(1)) < -0.04:
        warnings.append("tracking tighter than -0.04em — letters will collide")
    return warnings


def _warn_tokens_used(css_text: str, path: str, root: Path | None) -> list[str]:
    """Advisory: raw values while a tokens file exists (never blocking)."""
    warnings: list[str] = []
    if root is None:
        return warnings
    try:
        has_tokens_file = any(root.rglob('*tokens*.css'))
    except OSError:
        return warnings
    if not has_tokens_file:
        return warnings
    if 'tokens' in Path(path).name.lower():
        return warnings
    lowered = css_text.lower()
    if 'oklch(' in lowered:
        warnings.append("raw oklch() outside the tokens file — reference via var()")
    if 'font-size:' in lowered:
        warnings.append("hand-typed font-size outside the tokens file — use the type ramp")
    return warnings


def collect_design_warnings(root: Path, path: str) -> list[str]:
    """Collect advisory design warnings for a generated file (never blocking).

    Covers taste-level slop, type guards, token usage, and state coverage.
    Callers must surface these WITHOUT failing verification.
    """
    target = (root / path).resolve()
    if not target.exists() or not target.is_file():
        return []
    try:
        content = target.read_text(encoding='utf-8')
    except OSError:
        return []
    lowered = content.lower()
    suffix = target.suffix.lower()
    warnings: list[str] = []

    # Sparse-page revival of the dead _MIN_HTML_ELEMENTS constant (advisory).
    element_count = len(re.findall(r'<[a-zA-Z][^>]*>', content))
    if suffix in {'.html', '.htm'} and element_count and element_count < _MIN_HTML_ELEMENTS:
        warnings.append(
            f"only ~{element_count} HTML elements (minimum {_MIN_HTML_ELEMENTS} for a real page)"
        )

    if suffix in {'.html', '.htm'}:
        warnings.extend(_warn_states(lowered))
        warnings.extend(_warn_slop_html(content, lowered))
        warnings.extend(_warn_completeness(content, lowered))
        for css_text in _iter_css_texts(content, lowered):
            warnings.extend(_warn_slop_css(css_text))
            warnings.extend(_warn_tokens_used(css_text, path, root))
    elif suffix == '.css':
        warnings.extend(_warn_states(lowered))
        warnings.extend(_warn_slop_css(content))
        warnings.extend(_warn_tokens_used(content, path, root))
    return warnings


# ---------------------------------------------------------------------------
# Cross-file consistency validation (HTML ↔ CSS)
# ---------------------------------------------------------------------------

def _extract_html_classes(html_content: str) -> set[str]:
    """Extract all CSS class names referenced in an HTML file."""
    classes: set[str] = set()
    # Match class="..." and class='...'
    for match in re.finditer(r'class=["\']([^"\']*)["\']', html_content):
        for cls in match.group(1).split():
            if cls.strip():
                classes.add(cls.strip())
    return classes


def _extract_css_classes(css_content: str) -> set[str]:
    """Extract all CSS class selectors (e.g. .hero, .btn-primary) from a CSS file."""
    classes: set[str] = set()
    # Remove CSS comments
    cleaned = re.sub(r'/\*.*?\*/', '', css_content, flags=re.DOTALL)
    # Match .classname patterns (not inside attribute selectors or strings)
    for match in re.finditer(r'\.(?<=[\s{,:>+~])\s*([a-zA-Z_][\w-]*)', cleaned):
        classes.add(match.group(1))
    # Also match .classname at start of line or after whitespace
    for match in re.finditer(r'^\s*\.([a-zA-Z_][\w-]*)', cleaned, re.MULTILINE):
        classes.add(match.group(1))
    # Match .classname after { selector } patterns like: .foo .bar, .foo > .bar
    for match in re.finditer(r'\.([a-zA-Z_][\w-]*)', cleaned):
        classes.add(match.group(1))
    return classes


def _extract_inline_style_classes(html_content: str) -> set[str]:
    """Extract class names from inline style attributes (style="...")."""
    # These classes are defined inline, not in external CSS
    return set()  # Inline styles don't create named class selectors


def validate_cross_file_consistency(root: Path, changed_files: list[str]) -> str | None:
    """Check that HTML class names match CSS selectors across changed files.

    Returns an error string if mismatches are found, or None if consistent.
    """
    if not changed_files:
        return None

    # Find HTML and CSS files among changed files
    html_files: list[tuple[str, str]] = []  # (path, content)
    css_files: list[tuple[str, str]] = []  # (path, content)

    for fpath in changed_files:
        target = (root / fpath).resolve()
        if not target.exists():
            continue
        try:
            content = target.read_text(encoding="utf-8")
        except OSError:
            continue
        suffix = target.suffix.lower()
        if suffix in {".html", ".htm"}:
            html_files.append((fpath, content))
        elif suffix == ".css":
            css_files.append((fpath, content))

    if not html_files or not css_files:
        return None

    # Collect all classes from HTML files
    all_html_classes: set[str] = set()
    for fpath, content in html_files:
        all_html_classes.update(_extract_html_classes(content))

    # Collect all classes from CSS files
    all_css_classes: set[str] = set()
    for fpath, content in css_files:
        all_css_classes.update(_extract_css_classes(content))

    errors: list[str] = []

    # --- Check 1: HTML classes missing from CSS ---
    _IGNORE_CLASSES = {
        'container', 'row', 'col', 'flex', 'grid', 'hidden', 'visible',
        'active', 'disabled', 'hover', 'focus', 'open', 'closed',
        'selected', 'checked', 'required', 'optional', 'valid', 'invalid',
        'loading', 'error', 'success', 'warning', 'info', 'dark', 'light',
        'wrapper', 'inner', 'outer', 'clearfix', 'sr-only',
        'visually-hidden', 'screen-reader-only',
    }
    html_only = (all_html_classes - all_css_classes) - _IGNORE_CLASSES

    if html_only:
        sample = sorted(html_only)[:12]
        sample_str = ", ".join(f".{c}" for c in sample)
        more = f" (+ {len(html_only) - 12} more)" if len(html_only) > 12 else ""
        errors.append(
            f"{len(html_only)} HTML class(es) have NO matching CSS rule: {sample_str}{more}. "
            f"Add a .classname rule in CSS for EVERY class used in the HTML."
        )

    # --- Check 2: CSS classes not used in HTML (unused selectors) ---
    _CSS_ONLY_PATTERNS = {
        'root', 'before', 'after', 'first-child', 'last-child', 'nth-child',
        'focus', 'hover', 'active', 'visited', 'link',
        'first', 'last', 'odd', 'even', 'not', 'where', 'is', 'has',
        'placeholder', 'selection', 'marker',
    }
    css_only = all_css_classes - all_html_classes - _CSS_ONLY_PATTERNS
    # Remove utility classes that might be used dynamically
    css_only -= _IGNORE_CLASSES
    # Remove classes that look like element/tag selectors or pseudo-elements
    css_only = {c for c in css_only if not c.startswith('btn-') or c in all_html_classes}

    if css_only and len(css_only) > 3:
        sample = sorted(css_only)[:10]
        sample_str = ", ".join(f".{c}" for c in sample)
        errors.append(
            f"{len(css_only)} CSS class(es) defined but never used in HTML: {sample_str}. "
            f"Remove unused CSS or add the classes to the HTML."
        )

    if errors:
        return "HTML/CSS consistency errors:\n  - " + "\n  - ".join(errors)
    return None


def validate_layout_pair(html_content: str, css_content: str, html_path: str) -> str | None:
    """Validate HTML+CSS pair for layout quality issues.

    Checks cross-file layout concerns: missing flex on containers that
    need horizontal layout, centering slop, and uniform spacing.
    Returns an error string or None.
    """
    import re as _re
    issues: list[str] = []
    css_lower = css_content.lower()

    # Check for header flex container
    if '<header' in html_content.lower():
        # Check if CSS has display: flex on header container
        header_has_flex = bool(_re.search(
            r'\.header\s+\.container\s*\{[^}]*display\s*:\s*(flex|grid)',
            css_lower
        ))
        if not header_has_flex and '.header' in css_lower:
            issues.append(
                "header exists in HTML but CSS has no display:flex on .header .container -- "
                "logo, nav, and hamburger will stack vertically. "
                "Add: .header .container { display: flex; align-items: center; justify-content: space-between; }"
            )

    # Check for navbar flex container (logo + links stack without it)
    if '<nav' in html_content.lower():
        navbar_has_flex = bool(_re.search(
            r'\.navbar\s+\.container\s*\{[^}]*display\s*:\s*(flex|grid)',
            css_lower
        ))
        if not navbar_has_flex and '.navbar' in css_lower:
            issues.append(
                "nav exists in HTML but CSS has no display:flex on .navbar .container -- "
                "logo and links will stack vertically. "
                "Add: .navbar .container { display: flex; align-items: center; justify-content: space-between; }"
            )

    # Check for hero flex container
    if '<section' in html_content.lower() and 'hero' in html_content.lower():
        hero_has_flex = bool(_re.search(
            r'\.hero\s+\.container\s*\{[^}]*display\s*:\s*(flex|grid)',
            css_lower
        ))
        if not hero_has_flex and '.hero' in css_lower:
            issues.append(
                "hero section exists in HTML but CSS has no display:flex on .hero .container -- "
                "hero content and image will stack vertically on desktop. "
                "Add: .hero .container { display: flex; align-items: center; gap: clamp(2rem, 4vw, 4rem); }"
            )

    # Check for feature card uniformity (cross-file)
    feature_card_count = html_content.lower().count('feature-card')
    if feature_card_count >= 3:
        # Check if CSS has alternating row layout (grid with 2 columns)
        has_alternating = bool(_re.search(
            r'\.feature-(row|text|visual)\s*\{', css_lower
        ))
        if not has_alternating:
            issues.append(
                f"{feature_card_count} feature cards with uniform layout -- "
                "use alternating asymmetric rows instead. "
                "See layout.md -> Required CSS Patterns -> Feature alternating rows."
            )

    # Check for uniform feature rows (cross-file — CSS decides legitimacy).
    # 4+ .feature-row blocks fail UNLESS rows genuinely alternate: mixed
    # --alt modifiers in HTML or :nth-child alternation rules in CSS
    # (agents-landing-page pattern). All---alt or no alternation = slop.
    row_count = len(_re.findall(r'class="feature-row(?:\s|")', html_content.lower()))
    if row_count >= 4:
        rows = _re.findall(r'class="([^"]*feature-row[^"]*)"', html_content.lower())
        mixed_alt = any('--alt' in row for row in rows) and not all('--alt' in row for row in rows)
        css_alternates = 'feature-row:nth-child' in css_lower
        if not mixed_alt and not css_alternates:
            issues.append(
                f"{row_count} identical .feature-row blocks with no real "
                "alternation -- alternate row composition (mixed --alt "
                "modifiers or :nth-child CSS rules), not one stamped pattern."
            )

    if issues:
        return "Layout quality issues:\n  - " + "\n  - ".join(issues)
    return None


def _validate_js_references_against_siblings(
    js_content: str, root: Path, js_path: str
) -> str | None:
    """Check JS DOM references resolve against sibling HTML files.

    Catches dead animation/query code: querySelector targets, getElementById
    ids, and data-* reads that match nothing in the page. Skipped when the
    JS file has no HTML siblings (non-web script).
    """
    target = (root / js_path).resolve()
    try:
        siblings = [
            f for f in target.parent.iterdir()
            if f.suffix.lower() in {'.html', '.htm'} and f.is_file()
        ]
    except OSError:
        return None
    if not siblings:
        return None

    html_all = ""
    for sibling in siblings:
        try:
            html_all += sibling.read_text(encoding='utf-8', errors='replace') + "\n"
        except OSError:
            continue
    html_classes = _extract_html_classes(html_all)
    html_ids = set(re.findall(r'id="([^"]*)"', html_all))
    html_data = set(re.findall(r'data-([a-zA-Z][\w-]*)', html_all))

    missing: list[str] = []
    for selector in re.findall(
        r'querySelector(?:All)?\(\s*[\'"]([^\'"]+)[\'"]', js_content
    ):
        # Resolve the simple case: every .class / #id token in a compound
        # selector must exist in the page (pseudo-classes can't be checked).
        tokens = re.findall(r'[.#]([A-Za-z_][\w-]*)', selector)
        if tokens and all(
            token in html_classes or token in html_ids for token in tokens
        ):
            continue
        if tokens:
            missing.append(f"selector '{selector}' matches nothing in HTML")
    for element_id in re.findall(
        r'getElementById\(\s*[\'"]([^\'"]+)[\'"]', js_content
    ):
        if element_id not in html_ids:
            missing.append(f"getElementById('{element_id}') matches nothing in HTML")
    for data_key in re.findall(
        r'getAttribute\(\s*[\'"]data-([^\'"]+)[\'"]', js_content
    ):
        if data_key not in html_data:
            missing.append(f"data-{data_key} read in JS but never set in HTML")

    if missing:
        sample = "; ".join(list(dict.fromkeys(missing))[:5])
        return (
            f"Dead JS references in {js_path}: {sample}. "
            "Wire the JS to classes/ids/data attributes that actually exist, "
            "or remove the dead code."
        )
    return None
