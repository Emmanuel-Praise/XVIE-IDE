"""Tests for Phase 16 — UI/design quality upgrade."""

from __future__ import annotations

from pathlib import Path

import pytest

from xvie_agent.design_guidance import DESIGN_PRINCIPLES, inject_design_principles
from xvie_agent.tools import ToolContext, _check_contrast, _preview_artifact


# ---------------------------------------------------------------------------
# DESIGN_PRINCIPLES injection
# ---------------------------------------------------------------------------


class TestDesignPrinciples:
    def test_injected_for_ui_design_role(self):
        prompt = "You are a coding assistant."
        result = inject_design_principles(prompt, "ui_design")
        # Layer 1: the agent-kit core taste prompt is injected
        assert "UI Design System" in result or "Core Taste" in result
        assert result.startswith("You are a coding assistant.")

    def test_always_on_design_guidance_is_compact_but_actionable(self):
        result = inject_design_principles("base", "ui_design")
        assert len(result) < 5_000
        for principle in ("hierarchy", "spacing", "responsive", "reduced-motion"):
            assert principle in result
        assert "3-tier pricing" not in result

    def test_legacy_principles_still_available(self):
        """The legacy DESIGN_PRINCIPLES constant is still importable."""
        from xvie_agent.design_guidance import DESIGN_PRINCIPLES
        assert "check_contrast" in DESIGN_PRINCIPLES

    def test_not_injected_for_coding_role(self):
        prompt = "You are a coding assistant."
        result = inject_design_principles(prompt, "coding")
        assert DESIGN_PRINCIPLES not in result
        assert result == prompt

    def test_not_injected_for_fast_edit(self):
        prompt = "You are a coding assistant."
        result = inject_design_principles(prompt, "fast_edit")
        assert DESIGN_PRINCIPLES not in result

    def test_not_injected_for_planning(self):
        prompt = "You are a coding assistant."
        result = inject_design_principles(prompt, "planning")
        assert DESIGN_PRINCIPLES not in result

    def test_not_injected_for_reasoning(self):
        prompt = "You are a coding assistant."
        result = inject_design_principles(prompt, "reasoning")
        assert DESIGN_PRINCIPLES not in result

    def test_not_injected_for_empty_role(self):
        prompt = "You are a coding assistant."
        result = inject_design_principles(prompt, "")
        assert DESIGN_PRINCIPLES not in result

    def test_principles_contain_spacing_scale(self):
        assert "4, 8, 12, 16, 24, 32, 48, 64px" in DESIGN_PRINCIPLES

    def test_principles_contain_contrast_instruction(self):
        assert "check_contrast" in DESIGN_PRINCIPLES

    def test_principles_contain_dont_default_list(self):
        assert "lorem ipsum" in DESIGN_PRINCIPLES.lower()
        assert "purple-gradient" in DESIGN_PRINCIPLES.lower()

    def test_design_guidance_states_which_rules_are_advisory(self):
        from xvie_agent.design_guidance import inject_design_principles
        result = inject_design_principles("base prompt", "ui_design")
        assert "## Design guidance (partly advisory)" in result
        assert "existing project stack and tokens" in result
        assert "not enforced automatically" in result
        assert "review_ui_render" in result

    def test_build_rules_not_in_base_prompt(self):
        from xvie_agent.prompting import build_system_prompt
        prompt = build_system_prompt(memory="", context_snapshot={}, tool_names=[])
        assert "TOKENS ARE LAW" not in prompt


class TestDesignMemoryStack:
    def test_stack_round_trip(self, tmp_path: Path):
        from xvie_agent.design_memory import (
            format_design_memory,
            load_design_memory,
            save_design_memory,
        )
        saved = save_design_memory(tmp_path, {"stack": "vanilla", "style": "minimal"})
        assert saved["stack"] == "vanilla"
        assert load_design_memory(tmp_path)["stack"] == "vanilla"
        assert "- stack: vanilla" in format_design_memory(load_design_memory(tmp_path))

    def test_unknown_keys_still_dropped(self, tmp_path: Path):
        from xvie_agent.design_memory import load_design_memory, save_design_memory
        saved = save_design_memory(tmp_path, {"nonsense": "x"})
        assert "nonsense" not in saved
        assert "nonsense" not in load_design_memory(tmp_path)

    def test_structured_product_design_blocks(self, tmp_path: Path):
        from xvie_agent.design_memory import (
            format_design_memory,
            load_design_memory,
            save_design_memory,
        )
        saved = save_design_memory(
            tmp_path,
            {
                "product": {"users": "devs", "purpose": "ship"},
                "design": "Restrained, one accent",
                "nonsense": {"x": "y"},
            },
        )
        assert saved["product"] == {"users": "devs", "purpose": "ship"}
        assert saved["design"] == "Restrained, one accent"
        assert "nonsense" not in saved
        text = format_design_memory(load_design_memory(tmp_path))
        assert "- product.users: devs" in text
        assert "- design: Restrained, one accent" in text

    def test_structured_empty_values_dropped(self, tmp_path: Path):
        from xvie_agent.design_memory import save_design_memory
        saved = save_design_memory(tmp_path, {"product": {}, "design": "  "})
        assert "product" not in saved
        assert "design" not in saved

    def test_discovery_asks_stack_when_no_tokens(self, tmp_path: Path):
        from xvie_agent.design_guidance import build_discovery_context
        ctx = build_discovery_context({"has_tokens": False, "inventory": {}})
        assert "vanilla" in ctx.lower() and "tailwind" in ctx.lower()

    def test_discovery_points_at_tokens_when_found(self, tmp_path: Path):
        from xvie_agent.design_guidance import build_discovery_context
        ctx = build_discovery_context({"has_tokens": True, "inventory": {"css_variables": True}})
        assert "var()" in ctx

    def test_reference_reads_are_capped_and_deduplicated(self, tmp_path: Path):
        from xvie_agent.tools import ToolContext, _read_ui_reference

        ctx = ToolContext(workspace_root=tmp_path)
        first = _read_ui_reference({"name": "forms"}, ctx)
        repeated = _read_ui_reference({"name": "forms"}, ctx)
        assert first.ok and len(first.content) <= 6_200
        assert repeated.ok and len(repeated.content) < len(first.content)
        assert "already read" in repeated.content


# ---------------------------------------------------------------------------
# check_contrast tool
# ---------------------------------------------------------------------------


class TestCheckContrast:
    def _ctx(self, tmp_path: Path) -> ToolContext:
        return ToolContext(workspace_root=tmp_path, allow_write=True, allow_shell=False)

    def test_black_on_white(self, tmp_path: Path):
        """Black (#000000) on white (#ffffff) = 21:1 ratio."""
        ctx = self._ctx(tmp_path)
        result = _check_contrast({"fg_hex": "#000000", "bg_hex": "#ffffff"}, ctx)
        assert result.ok is True
        assert "21.00:1" in result.content
        assert "PASS" in result.content

    def test_light_gray_on_white_fails(self, tmp_path: Path):
        """Light gray on white fails AA for normal text."""
        ctx = self._ctx(tmp_path)
        result = _check_contrast({"fg_hex": "#cccccc", "bg_hex": "#ffffff"}, ctx)
        assert result.ok is True
        assert "FAIL" in result.content

    def test_dark_text_on_white_passes(self, tmp_path: Path):
        """Dark text (#1a1a1a) on white passes AA."""
        ctx = self._ctx(tmp_path)
        result = _check_contrast({"fg_hex": "#1a1a1a", "bg_hex": "#ffffff"}, ctx)
        assert result.ok is True
        assert "PASS" in result.content

    def test_missing_args(self, tmp_path: Path):
        ctx = self._ctx(tmp_path)
        result = _check_contrast({}, ctx)
        assert result.ok is False
        assert result.error_kind == "missing_argument"

    def test_invalid_hex(self, tmp_path: Path):
        ctx = self._ctx(tmp_path)
        result = _check_contrast({"fg_hex": "not-a-color", "bg_hex": "#ffffff"}, ctx)
        assert result.ok is False


# ---------------------------------------------------------------------------
# preview_artifact tool
# ---------------------------------------------------------------------------


class TestPreviewArtifact:
    def test_locates_html_file(self, tmp_path: Path):
        ctx = ToolContext(workspace_root=tmp_path, allow_write=True, allow_shell=False)
        (tmp_path / "index.html").write_text("<html><body>Hello</body></html>")
        result = _preview_artifact({"path": "index.html"}, ctx)
        assert result.ok is True
        assert "index.html" in result.content

    def test_rejects_non_web_file(self, tmp_path: Path):
        ctx = ToolContext(workspace_root=tmp_path, allow_write=True, allow_shell=False)
        (tmp_path / "data.py").write_text("x = 1")
        result = _preview_artifact({"path": "data.py"}, ctx)
        assert result.ok is False
        assert result.error_kind == "not_artifact"

    def test_missing_file(self, tmp_path: Path):
        ctx = ToolContext(workspace_root=tmp_path, allow_write=True, allow_shell=False)
        result = _preview_artifact({"path": "nonexistent.html"}, ctx)
        assert result.ok is False
        assert result.error_kind == "file_not_found"

    def test_missing_path(self, tmp_path: Path):
        ctx = ToolContext(workspace_root=tmp_path, allow_write=True, allow_shell=False)
        result = _preview_artifact({}, ctx)
        assert result.ok is False
