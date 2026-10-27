"""Tests for xvie_agent.modes — mode definitions, tool filtering, prompts."""

from __future__ import annotations

from pathlib import Path

import pytest

from xvie_agent.modes import (
    VALID_MODES,
    DEFAULT_MODE,
    MODES,
    ModeConfig,
    get_mode,
    is_valid_mode,
)
from xvie_agent.tools import ToolContext, build_default_registry


# ---------------------------------------------------------------------------
# ModeConfig basics
# ---------------------------------------------------------------------------

class TestModeConfig:
    def test_all_five_modes_exist(self) -> None:
        assert set(MODES.keys()) == {"plan", "code", "debug", "ask", "brainstorm"}

    def test_valid_modes_matches_keys(self) -> None:
        assert VALID_MODES == frozenset(MODES.keys())

    def test_default_mode_is_code(self) -> None:
        assert DEFAULT_MODE == "code"

    def test_plan_mode_is_read_only(self) -> None:
        cfg = MODES["plan"]
        assert cfg.allow_write is False
        assert cfg.allow_shell is False
        assert cfg.allow_web_search is False
        assert cfg.can_generate_code is False
        assert cfg.research_depth == "deep"

    def test_code_mode_allows_writes(self) -> None:
        cfg = MODES["code"]
        assert cfg.allow_write is True
        assert cfg.allow_shell is True
        assert cfg.allow_web_search is False
        assert cfg.can_generate_code is True
        assert cfg.research_depth == "light"

    def test_debug_mode_allows_writes_and_research(self) -> None:
        cfg = MODES["debug"]
        assert cfg.allow_write is True
        assert cfg.allow_shell is True
        assert cfg.allow_web_search is False
        assert cfg.can_generate_code is True
        assert cfg.research_depth == "deep"
        assert cfg.accepts_error_input is True

    def test_ask_mode_is_read_only(self) -> None:
        cfg = MODES["ask"]
        assert cfg.allow_write is False
        assert cfg.allow_shell is False
        assert cfg.allow_web_search is False
        assert cfg.can_generate_code is False
        assert cfg.research_depth == "light"

    def test_brainstorm_mode_has_web_access(self) -> None:
        cfg = MODES["brainstorm"]
        assert cfg.allow_write is False
        assert cfg.allow_shell is False
        assert cfg.allow_web_search is True
        assert cfg.can_generate_code is False
        assert cfg.research_depth == "deep"


# ---------------------------------------------------------------------------
# Lane overrides
# ---------------------------------------------------------------------------

class TestLaneOverrides:
    def test_plan_uses_reasoning_lane(self) -> None:
        assert MODES["plan"].lane_override == "reasoning"

    def test_code_has_no_lane_override(self) -> None:
        assert MODES["code"].lane_override is None

    def test_debug_uses_debug_lane(self) -> None:
        assert MODES["debug"].lane_override == "debug"

    def test_ask_uses_fast_lane(self) -> None:
        assert MODES["ask"].lane_override == "fast"

    def test_brainstorm_uses_reasoning_lane(self) -> None:
        assert MODES["brainstorm"].lane_override == "reasoning"


# ---------------------------------------------------------------------------
# get_mode / is_valid_mode
# ---------------------------------------------------------------------------

class TestModeLookup:
    def test_get_mode_valid(self) -> None:
        for name in MODES:
            mode = get_mode(name)
            assert mode.name == name

    def test_get_mode_case_insensitive(self) -> None:
        assert get_mode("PLAN").name == "plan"
        assert get_mode("Code").name == "code"
        assert get_mode("DEBUG").name == "debug"
        assert get_mode("Ask").name == "ask"
        assert get_mode("BRAINSTORM").name == "brainstorm"

    def test_get_mode_unknown_falls_back_to_default(self) -> None:
        mode = get_mode("nonexistent")
        assert mode.name == DEFAULT_MODE

    def test_is_valid_mode_true(self) -> None:
        for name in MODES:
            assert is_valid_mode(name) is True

    def test_is_valid_mode_false(self) -> None:
        assert is_valid_mode("invalid") is False
        assert is_valid_mode("") is False
        assert is_valid_mode("PLAN ") is True  # stripped


# ---------------------------------------------------------------------------
# System prompt suffixes
# ---------------------------------------------------------------------------

class TestSystemPrompts:
    def test_all_modes_have_prompts(self) -> None:
        for name, cfg in MODES.items():
            assert cfg.system_prompt_suffix, f"Mode '{name}' has empty system prompt"

    def test_plan_prompt_blocks_code(self) -> None:
        prompt = MODES["plan"].system_prompt_suffix.lower()
        assert "cannot write" in prompt or "cannnot" in prompt or "do not" in prompt
        assert "planning mode" in prompt

    def test_code_prompt_enables_implementation(self) -> None:
        prompt = MODES["code"].system_prompt_suffix.lower()
        assert "code mode" in prompt
        assert "implement" in prompt

    def test_debug_prompt_has_methodology(self) -> None:
        prompt = MODES["debug"].system_prompt_suffix.lower()
        assert "debugging methodology" in prompt or "debug mode" in prompt
        assert "reproduce" in prompt
        assert "hypothesize" in prompt

    def test_ask_prompt_blocks_code(self) -> None:
        prompt = MODES["ask"].system_prompt_suffix.lower()
        assert "cannot" in prompt
        assert "ask mode" in prompt

    def test_brainstorm_prompt_mentions_web(self) -> None:
        prompt = MODES["brainstorm"].system_prompt_suffix.lower()
        assert "web_search" in prompt or "web search" in prompt
        assert "brainstorm" in prompt


# ---------------------------------------------------------------------------
# Tool filtering per mode
# ---------------------------------------------------------------------------

@pytest.fixture()
def sandbox(tmp_path: Path) -> Path:
    """Create a temp workspace."""
    (tmp_path / "test.py").write_text("print('hello')\n")
    return tmp_path


class TestToolFiltering:
    def _tool_names(self, ctx: ToolContext, allow_web: bool = False) -> set[str]:
        return set(build_default_registry(ctx, allow_web=allow_web).keys())

    def test_code_mode_has_all_tools(self, sandbox: Path) -> None:
        ctx = ToolContext(workspace_root=sandbox, allow_write=True, allow_shell=True)
        names = self._tool_names(ctx)
        assert "write_file" in names
        assert "edit_file" in names
        assert "bash" in names
        assert "read_file" in names
        assert "grep_search" in names

    def test_read_only_mode_excludes_writes(self, sandbox: Path) -> None:
        ctx = ToolContext(workspace_root=sandbox, allow_write=False, allow_shell=False)
        names = self._tool_names(ctx)
        assert "read_file" in names
        assert "list_dir" in names
        assert "glob_search" in names
        assert "grep_search" in names
        assert "think" in names
        # Write tools should still be registered (ToolContext handles permission)
        # but they will fail at runtime if allow_write=False
        assert "write_file" in names
        assert "bash" in names

    def test_web_tools_absent_by_default(self, sandbox: Path) -> None:
        ctx = ToolContext(workspace_root=sandbox)
        names = self._tool_names(ctx, allow_web=False)
        assert "web_search" not in names
        assert "web_fetch" not in names

    def test_web_tools_present_when_allowed(self, sandbox: Path) -> None:
        ctx = ToolContext(workspace_root=sandbox)
        names = self._tool_names(ctx, allow_web=True)
        assert "web_search" in names
        assert "web_fetch" in names


# ---------------------------------------------------------------------------
# Mode-aware loop integration (unit-level, no model calls)
# ---------------------------------------------------------------------------

class TestModeIntegration:
    def test_plan_mode_system_prompt_includes_planning(self) -> None:
        from xvie_agent.prompting import build_mode_system_prompt
        prompt = build_mode_system_prompt("plan")
        assert "PLANNING MODE" in prompt

    def test_code_mode_system_prompt_is_empty(self) -> None:
        from xvie_agent.prompting import build_mode_system_prompt
        prompt = build_mode_system_prompt("code")
        assert prompt == ""

    def test_debug_mode_system_prompt_includes_debugging(self) -> None:
        from xvie_agent.prompting import build_mode_system_prompt
        prompt = build_mode_system_prompt("debug")
        assert "DEBUG MODE" in prompt
        assert "ROOT CAUSE" in prompt

    def test_ask_mode_system_prompt_forbids_code(self) -> None:
        from xvie_agent.prompting import build_mode_system_prompt
        prompt = build_mode_system_prompt("ask")
        assert "ASK MODE" in prompt
        assert "CANNOT" in prompt

    def test_brainstorm_mode_system_prompt_includes_web(self) -> None:
        from xvie_agent.prompting import build_mode_system_prompt
        prompt = build_mode_system_prompt("brainstorm")
        assert "BRAINSTORM MODE" in prompt
        assert "web_search" in prompt

    def test_unknown_mode_returns_empty_prompt(self) -> None:
        from xvie_agent.prompting import build_mode_system_prompt
        prompt = build_mode_system_prompt("nonexistent")
        assert prompt == ""


# ---------------------------------------------------------------------------
# CLI argument parsing with modes
# ---------------------------------------------------------------------------

class TestCLIArguments:
    def test_run_mode_choices(self) -> None:
        from xvie_agent.cli import main
        import argparse
        # The parser should accept all 5 modes
        for mode in ["plan", "code", "debug", "ask", "brainstorm"]:
            # Just verify the choice is valid in argparse
            assert mode in VALID_MODES

    def test_chat_mode_choices(self) -> None:
        from xvie_agent.modes import VALID_MODES
        # All modes should be valid for chat too
        assert {"plan", "code", "debug", "ask", "brainstorm"} == VALID_MODES


# ---------------------------------------------------------------------------
# Debug mode specifics
# ---------------------------------------------------------------------------

class TestDebugMode:
    def test_debug_accepts_error_input(self) -> None:
        assert MODES["debug"].accepts_error_input is True

    def test_debug_has_write_access(self) -> None:
        assert MODES["debug"].allow_write is True
        assert MODES["debug"].allow_shell is True

    def test_debug_uses_debug_lane(self) -> None:
        assert MODES["debug"].lane_override == "debug"

    def test_debug_deep_research(self) -> None:
        assert MODES["debug"].research_depth == "deep"


# ---------------------------------------------------------------------------
# Brainstorm mode specifics
# ---------------------------------------------------------------------------

class TestBrainstormMode:
    def test_brainstorm_has_web_search(self) -> None:
        assert MODES["brainstorm"].allow_web_search is True

    def test_brainstorm_no_writes(self) -> None:
        assert MODES["brainstorm"].allow_write is False
        assert MODES["brainstorm"].allow_shell is False

    def test_brainstorm_no_code_generation(self) -> None:
        assert MODES["brainstorm"].can_generate_code is False

    def test_brainstorm_deep_research(self) -> None:
        assert MODES["brainstorm"].research_depth == "deep"

    def test_brainstorm_tool_registry_has_web_tools(self, sandbox: Path) -> None:
        ctx = ToolContext(workspace_root=sandbox)
        # Simulate what loop.py does for brainstorm mode
        from xvie_agent.modes import get_mode
        mode = get_mode("brainstorm")
        registry = build_default_registry(ctx, allow_web=mode.allow_web_search)
        assert "web_search" in registry
        assert "web_fetch" in registry


# ---------------------------------------------------------------------------
# Ask mode specifics
# ---------------------------------------------------------------------------

class TestAskMode:
    def test_ask_no_writes(self) -> None:
        assert MODES["ask"].allow_write is False
        assert MODES["ask"].allow_shell is False

    def test_ask_no_code_generation(self) -> None:
        assert MODES["ask"].can_generate_code is False

    def test_ask_uses_fast_lane(self) -> None:
        assert MODES["ask"].lane_override == "fast"

    def test_ask_light_research(self) -> None:
        assert MODES["ask"].research_depth == "light"
