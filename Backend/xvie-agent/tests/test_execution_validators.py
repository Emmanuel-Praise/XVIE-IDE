"""Tests for tiered motion/slop validators + advisory warnings channel.

Tiering rule: feel-breaking / performance / accessibility motion bugs FAIL
verification (P0). Taste-level slop, type guards, token usage, and state
coverage are advisory via collect_design_warnings() and NEVER fail.
"""

from __future__ import annotations

from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace

from xvie_agent.execution import (
    collect_design_warnings,
    validate_changed_file,
    validate_layout_pair,
    validate_responsive_render,
)


def _write(tmp_path: Path, name: str, content: str) -> str:
    (tmp_path / name).write_text(content, encoding="utf-8")
    return name


RICH_HTML_HEAD = (
    '<!DOCTYPE html><html lang="en"><head><title>T</title>'
    '<meta name="viewport" content="width=device-width, initial-scale=1">'
)


def _page(style: str, body: str) -> str:
    return (
        f"{RICH_HTML_HEAD}<style>{style}</style></head><body>"
        "<header><nav>Nav</nav></header><main>"
        f"{body}</main><footer>Foot</footer></body></html>"
    )


BASE_STYLE = (
    "body{margin:0;display:flex;flex-direction:column;min-height:100vh}"
    "header{background:#222;color:#fff;padding:1rem;}"
    "main{padding:2rem;flex:1;}footer{background:#eee;padding:1rem;}"
    "a:hover{color:#fff}a:focus-visible{outline:2px solid #fff}"
    "button:disabled{opacity:.5}.loading{opacity:.5}.error{color:red}"
    ".empty{color:gray}"
    "@media(max-width:768px){main{padding:1rem}}"
    "@media (prefers-reduced-motion: reduce){*{transition-duration:.01ms !important}}"
)
BASE_BODY = "<p>" + ("Real content sentence. " * 40) + "</p>"


class TestMotionP0Blocking:
    def test_css_unclosed_block_comment_is_rejected(self, tmp_path: Path):
        name = _write(tmp_path, "broken.css", ".card { color: red; }\n/* unfinished\n.hidden { display: none; }")
        error = validate_changed_file(name, tmp_path)
        assert error is not None and "unclosed css block comment" in error.lower()

    def test_css_comment_markers_inside_strings_are_ignored(self, tmp_path: Path):
        name = _write(tmp_path, "strings.css", '.card::after { content: "/* not a comment */"; }')
        # Existing quality thresholds can report this short sample; the assertion
        # specifically protects the scanner from misclassifying its string.
        error = validate_changed_file(name, tmp_path)
        assert error is None or "unclosed CSS block comment" not in error.lower()

    def test_css_closed_multiline_comment_is_accepted(self, tmp_path: Path):
        name = _write(tmp_path, "comment.css", "/* heading\n * explanation\n */\n.card { color: red; }")
        error = validate_changed_file(name, tmp_path)
        assert error is None or "unclosed CSS block comment" not in error.lower()

    def test_css_universal_selector_passes_and_rules_hidden_in_closed_comment_fail(self, tmp_path: Path):
        css_rules = "* { box-sizing: border-box; }" + "".join(
            f"\n.item-{i} {{ color: #{i:06x}; padding: 1rem; }}" for i in range(20)
        )
        valid = _write(tmp_path, "universal.css", css_rules)
        assert validate_changed_file(valid, tmp_path) is None
        swallowed = _write(
            tmp_path,
            "swallowed.css",
            "/* Header /\n.site-header { position: sticky; }\n.brand { display: flex; color: red; }\n/ Hero /\n.hero { padding: 2rem; }\n/ Layout */",
        )
        error = validate_changed_file(swallowed, tmp_path)
        assert error is not None and "CSS rule blocks appear inside a comment" in error

    def test_css_responsive_check_does_not_require_media_flex_or_grid_tokens(self, tmp_path: Path):
        rules = "".join(f".item-{i}{{color:#{i:06x};}}" for i in range(20))
        css = "img{max-width:100%;height:auto;}" + rules
        name = _write(tmp_path, "fluid.css", css)
        assert validate_changed_file(name, tmp_path) is None

    def test_responsive_browser_check_detects_mobile_overflow(self, tmp_path: Path, monkeypatch):
        class FakePage:
            def __init__(self, width: int):
                self.width = width

            def goto(self, *_args, **_kwargs):
                pass

            def wait_for_timeout(self, _milliseconds):
                pass

            def evaluate(self, _script):
                return {"viewport": self.width, "document": self.width + (24 if self.width == 390 else 0)}

            def close(self):
                pass

        class FakeBrowser:
            def new_page(self, viewport, **_kwargs):
                return FakePage(viewport["width"])

            def close(self):
                pass

        class FakePlaywright:
            chromium = SimpleNamespace(launch=lambda **_kwargs: FakeBrowser())

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                pass

        package = ModuleType("playwright")
        package.__path__ = []
        sync_api = ModuleType("playwright.sync_api")
        sync_api.sync_playwright = FakePlaywright
        monkeypatch.setitem(sys.modules, "playwright", package)
        monkeypatch.setitem(sys.modules, "playwright.sync_api", sync_api)
        _write(tmp_path, "page.html", "<!doctype html><html></html>")

        error = validate_responsive_render("page.html", tmp_path)

        assert error is not None
        assert "mobile layout overflows" in error

    def test_responsive_browser_check_passes_without_overflow(self, tmp_path: Path, monkeypatch):
        class FakePage:
            def __init__(self, width: int):
                self.width = width

            def goto(self, *_args, **_kwargs):
                pass

            def wait_for_timeout(self, _milliseconds):
                pass

            def evaluate(self, _script):
                return {"viewport": self.width, "document": self.width}

            def close(self):
                pass

        class FakeBrowser:
            def new_page(self, viewport, **_kwargs):
                return FakePage(viewport["width"])

            def close(self):
                pass

        class FakePlaywright:
            chromium = SimpleNamespace(launch=lambda **_kwargs: FakeBrowser())

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                pass

        package = ModuleType("playwright")
        package.__path__ = []
        sync_api = ModuleType("playwright.sync_api")
        sync_api.sync_playwright = FakePlaywright
        monkeypatch.setitem(sys.modules, "playwright", package)
        monkeypatch.setitem(sys.modules, "playwright.sync_api", sync_api)
        _write(tmp_path, "page.html", "<!doctype html><html></html>")

        assert validate_responsive_render("page.html", tmp_path) is None

    def test_transition_all_fails(self, tmp_path: Path):
        name = _write(tmp_path, "a.html", _page(BASE_STYLE + ".x{transition: all .3s ease;}", BASE_BODY))
        error = validate_changed_file(name, tmp_path, rich_html=True)
        assert error is not None and "transition: all" in error

    def test_scale_zero_fails(self, tmp_path: Path):
        name = _write(tmp_path, "a.html", _page(BASE_STYLE + ".x{transform: scale(0);}", BASE_BODY))
        error = validate_changed_file(name, tmp_path, rich_html=True)
        assert error is not None and "scale(0)" in error

    def test_scale_095_passes(self, tmp_path: Path):
        name = _write(tmp_path, "a.html", _page(BASE_STYLE + ".x{transform: scale(0.95);}", BASE_BODY))
        assert validate_changed_file(name, tmp_path, rich_html=True) is None

    def test_ease_in_fails(self, tmp_path: Path):
        name = _write(tmp_path, "a.html", _page(BASE_STYLE + ".x{transition: opacity 200ms ease-in;}", BASE_BODY))
        error = validate_changed_file(name, tmp_path, rich_html=True)
        assert error is not None and "ease-in" in error

    def test_ease_in_out_passes(self, tmp_path: Path):
        name = _write(tmp_path, "a.html", _page(BASE_STYLE + ".x{transition: opacity 200ms ease-in-out;}", BASE_BODY))
        assert validate_changed_file(name, tmp_path, rich_html=True) is None

    def test_layout_prop_animation_fails(self, tmp_path: Path):
        name = _write(tmp_path, "a.html", _page(BASE_STYLE + ".x{transition: width 200ms ease-out;}", BASE_BODY))
        error = validate_changed_file(name, tmp_path, rich_html=True)
        assert error is not None and "width" in error

    def test_over_800ms_fails(self, tmp_path: Path):
        name = _write(tmp_path, "a.html", _page(BASE_STYLE + ".x{transition: opacity 2s ease-out;}", BASE_BODY))
        error = validate_changed_file(name, tmp_path, rich_html=True)
        assert error is not None and "800ms" in error

    def test_motion_without_reduced_motion_fails(self, tmp_path: Path):
        style = BASE_STYLE.replace("@media (prefers-reduced-motion: reduce){*{transition-duration:.01ms !important}}", "")
        style += ".x{transition: opacity 200ms ease-out;}"
        name = _write(tmp_path, "a.html", _page(style, BASE_BODY))
        error = validate_changed_file(name, tmp_path, rich_html=True)
        assert error is not None and "prefers-reduced-motion" in error

    def test_css_file_motion_p0(self, tmp_path: Path):
        name = _write(
            tmp_path, "s.css",
            "body{margin:0;display:flex;flex-direction:column;min-height:100vh}"
            "header{padding:1rem}main{padding:2rem}footer{padding:1rem}"
            "a{color:#fff}b{color:#eee}c{color:#ddd}d{color:#ccc}"
            "e{margin:4px}f{margin:8px}g{margin:12px}h{margin:16px}"
            "@media(max-width:768px){main{padding:1rem}}"
            ".x{transition: all .3s ease;}",
        )
        error = validate_changed_file(name, tmp_path)
        assert error is not None and "transition: all" in error


class TestMotionWarningsAdvisory:
    def _warnings(self, tmp_path: Path, content: str, name: str = "a.html") -> list[str]:
        _write(tmp_path, name, content)
        return collect_design_warnings(tmp_path, name)

    def test_focal_band_is_warning_not_error(self, tmp_path: Path):
        page = _page(BASE_STYLE + ".hero{transition: opacity 500ms ease-out;}", BASE_BODY)
        assert validate_changed_file(_write(tmp_path, "a.html", page), tmp_path, rich_html=True) is None
        assert any("300ms" in w for w in self._warnings(tmp_path, page))

    def test_ungated_hover_warns(self, tmp_path: Path):
        page = _page(BASE_STYLE, BASE_BODY)
        assert any("hover:hover" in w for w in self._warnings(tmp_path, page))

    def test_gradient_text_warns(self, tmp_path: Path):
        page = _page(
            BASE_STYLE + ".t{background:linear-gradient(red,blue);background-clip:text;color:transparent;}",
            BASE_BODY,
        )
        assert any("gradient text" in w for w in self._warnings(tmp_path, page))

    def test_thick_side_stripe_warns(self, tmp_path: Path):
        page = _page(BASE_STYLE + ".n{border-left: 4px solid red;}", BASE_BODY)
        assert any("side-stripe" in w for w in self._warnings(tmp_path, page))

    def test_eyebrow_warns(self, tmp_path: Path):
        page = _page(BASE_STYLE, '<p class="eyebrow">Hi</p>' + BASE_BODY)
        assert any("eyebrow" in w for w in self._warnings(tmp_path, page))

    def test_modal_without_dialog_warns(self, tmp_path: Path):
        page = _page(BASE_STYLE, '<div class="modal">Hi</div>' + BASE_BODY)
        assert any("role=\"dialog\"" in w for w in self._warnings(tmp_path, page))

    def test_banned_face_warns(self, tmp_path: Path):
        page = _page(BASE_STYLE + "h1{font-family:'Space Grotesk',sans-serif;}", BASE_BODY)
        assert any("banned display face" in w for w in self._warnings(tmp_path, page))

    def test_warnings_never_fail_verification(self, tmp_path: Path):
        page = _page(
            BASE_STYLE + ".t{background:linear-gradient(red,blue);background-clip:text;}",
            '<p class="eyebrow">Hi</p><div class="modal">M</div>' + BASE_BODY,
        )
        name = _write(tmp_path, "a.html", page)
        assert validate_changed_file(name, tmp_path, rich_html=True) is None
        assert len(collect_design_warnings(tmp_path, name)) >= 3

    def test_tokens_warnings_when_tokens_file_exists(self, tmp_path: Path):
        _write(tmp_path, "theme-tokens.css", ":root{--x: red;}")
        page = _page(BASE_STYLE + ".x{color: oklch(50% .1 200); font-size: 15px;}", BASE_BODY)
        warnings = self._warnings(tmp_path, page)
        assert any("var()" in w for w in warnings)

    def test_no_tokens_file_no_tokens_warnings(self, tmp_path: Path):
        page = _page(BASE_STYLE + ".x{color: oklch(50% .1 200);}", BASE_BODY)
        assert not [w for w in self._warnings(tmp_path, page) if "var()" in w]

    def test_missing_file_returns_empty(self, tmp_path: Path):
        assert collect_design_warnings(tmp_path, "nope.html") == []


class TestTasteP0Blocking:
    """Taste defects that now FAIL verification (DesignTest forensics)."""

    def test_emoji_icon_fails(self, tmp_path: Path):
        body = '<div class="feature-icon-large">⌚</div>' + BASE_BODY
        name = _write(tmp_path, "a.html", _page(BASE_STYLE, body))
        error = validate_changed_file(name, tmp_path, rich_html=True)
        assert error is not None and "emoji" in error.lower()

    def test_svg_icon_passes(self, tmp_path: Path):
        body = (
            '<div class="feature-icon-large">'
            '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>'
            "</div>" + BASE_BODY
        )
        name = _write(tmp_path, "a.html", _page(BASE_STYLE, body))
        assert validate_changed_file(name, tmp_path, rich_html=True) is None

    def test_prose_emoji_passes(self, tmp_path: Path):
        body = "<p>We love watches ⌚ truly.</p>" + BASE_BODY
        name = _write(tmp_path, "a.html", _page(BASE_STYLE, body))
        assert validate_changed_file(name, tmp_path, rich_html=True) is None

    def test_four_identical_spec_items_fail(self, tmp_path: Path):
        specs = "".join(
            f'<div class="spec-item"><div class="spec-value">{i}mm</div></div>'
            for i in range(4)
        )
        name = _write(tmp_path, "a.html", _page(BASE_STYLE, specs + BASE_BODY))
        error = validate_changed_file(name, tmp_path, rich_html=True)
        assert error is not None and "spec-item" in error

    def test_three_spec_items_pass(self, tmp_path: Path):
        specs = "".join(
            f'<div class="spec-item"><div class="spec-value">{i}mm</div></div>'
            for i in range(3)
        )
        name = _write(tmp_path, "a.html", _page(BASE_STYLE, specs + BASE_BODY))
        assert validate_changed_file(name, tmp_path, rich_html=True) is None

    def test_all_alt_rows_fail(self, tmp_path: Path):
        rows = "".join(
            f'<div class="feature-row feature-row--alt"><h3>R{i}</h3><p>Text.</p></div>'
            for i in range(2)
        )
        name = _write(tmp_path, "a.html", _page(BASE_STYLE, rows + BASE_BODY))
        error = validate_changed_file(name, tmp_path, rich_html=True)
        assert error is not None and "alternat" in error.lower()

    def test_mixed_rows_pass(self, tmp_path: Path):
        rows = (
            '<div class="feature-row"><h3>A</h3><p>Text.</p></div>'
            '<div class="feature-row feature-row--alt"><h3>B</h3><p>Text.</p></div>'
        )
        name = _write(tmp_path, "a.html", _page(BASE_STYLE, rows + BASE_BODY))
        assert validate_changed_file(name, tmp_path, rich_html=True) is None

    def test_populated_by_comment_fails(self, tmp_path: Path):
        body = "<!-- Image will be populated by search -->" + BASE_BODY
        name = _write(tmp_path, "a.html", _page(BASE_STYLE, body))
        error = validate_changed_file(name, tmp_path, rich_html=True)
        assert error is not None and "placeholder" in error.lower()

    def test_empty_image_wrapper_fails(self, tmp_path: Path):
        body = '<div class="cta-image-wrapper"><!-- empty --></div>' + BASE_BODY
        name = _write(tmp_path, "a.html", _page(BASE_STYLE, body))
        error = validate_changed_file(name, tmp_path, rich_html=True)
        assert error is not None and "empty image" in error.lower()

    def test_image_wrapper_with_img_passes(self, tmp_path: Path):
        body = '<div class="cta-image-wrapper"><img src="w.jpg" alt="Watch"></div>' + BASE_BODY
        name = _write(tmp_path, "a.html", _page(BASE_STYLE, body))
        assert validate_changed_file(name, tmp_path, rich_html=True) is None

    def test_body_responsive_class_fails(self, tmp_path: Path):
        page = _page(BASE_STYLE, BASE_BODY).replace("<body>", '<body class="responsive">')
        name = _write(tmp_path, "a.html", page)
        error = validate_changed_file(name, tmp_path, rich_html=True)
        assert error is not None and "games the validator" in error

    def test_navbar_pair_requires_flex(self):
        html = "<nav class=\"navbar\"><div class=\"container\">x</div></nav>"
        css = ".navbar .container { color: red; } .navbar { display: flex; }"
        error = validate_layout_pair(html, css, "a.html")
        assert error is not None and ".navbar .container" in error

    def test_navbar_pair_passes_with_flex(self):
        html = "<nav class=\"navbar\"><div class=\"container\">x</div></nav>"
        css = ".navbar .container { display: flex; align-items: center; }"
        assert validate_layout_pair(html, css, "a.html") is None

    def test_pair_uniform_rows_fail_without_alternation(self):
        rows = "".join(
            f'<div class="feature-row feature-row--alt"><h3>R{i}</h3></div>'
            for i in range(4)
        )
        css = ".feature-row { display: grid; }"
        error = validate_layout_pair(rows, css, "a.html")
        assert error is not None and "feature-row" in error

    def test_pair_mixed_alt_rows_pass(self):
        rows = "".join(
            f'<div class="feature-row{" feature-row--alt" if i % 2 else ""}"><h3>R{i}</h3></div>'
            for i in range(4)
        )
        css = ".feature-row { display: grid; }"
        assert validate_layout_pair(rows, css, "a.html") is None

    def test_pair_nth_child_alternation_passes(self):
        rows = "".join(
            f'<div class="feature-row"><h3>R{i}</h3></div>' for i in range(4)
        )
        css = (
            ".feature-row { display: grid; }"
            ".feature-row:nth-child(even) .feature-text { order: 2; }"
        )
        assert validate_layout_pair(rows, css, "a.html") is None

    def test_single_file_nth_child_exempt(self, tmp_path: Path):
        rows = "".join(
            f'<div class="feature-row"><h3>R{i}</h3></div>' for i in range(4)
        )
        style = ".feature-row{display:grid}.feature-row:nth-child(even){order:2}"
        name = _write(tmp_path, "a.html", _page(style, rows + BASE_BODY))
        assert validate_changed_file(name, tmp_path, rich_html=True) is None


class TestJsReferenceChecks:
    def test_dead_selector_fails(self, tmp_path: Path):
        _write(tmp_path, "index.html", _page(BASE_STYLE, BASE_BODY))
        name = _write(
            tmp_path, "app.js",
            "document.querySelectorAll('.ghost-card').forEach(()=>{});",
        )
        error = validate_changed_file(name, tmp_path)
        assert error is not None and ".ghost-card" in error

    def test_dead_getelementbyid_fails(self, tmp_path: Path):
        _write(tmp_path, "index.html", _page(BASE_STYLE, BASE_BODY))
        name = _write(tmp_path, "app.js", "document.getElementById('nope');")
        error = validate_changed_file(name, tmp_path)
        assert error is not None and "nope" in error

    def test_valid_refs_pass(self, tmp_path: Path):
        _write(
            tmp_path, "index.html",
            _page(BASE_STYLE, '<div class="card" id="c1" data-target="5"></div>' + BASE_BODY),
        )
        name = _write(
            tmp_path, "app.js",
            "document.querySelectorAll('.card');"
            "document.getElementById('c1');"
            "el.getAttribute('data-target');",
        )
        assert validate_changed_file(name, tmp_path) is None

    def test_js_without_html_siblings_skipped(self, tmp_path: Path):
        name = _write(tmp_path, "tool.js", "document.querySelector('.anything');")
        assert validate_changed_file(name, tmp_path) is None
