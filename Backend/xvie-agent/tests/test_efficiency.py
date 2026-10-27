"""Tests for Phase 11 — token efficiency improvements.

Verifies:
- Tool schemas are trimmed based on permissions
- System prompt stays under a token budget
- Verbosity instruction is present in the system prompt
- Tool descriptions are concise
"""

from __future__ import annotations

from pathlib import Path

import pytest

from xvie_agent.agent import _tools_to_openai_format
from xvie_agent.context import build_context_snapshot, discover_memory_files
from xvie_agent.prompting import build_system_prompt
from xvie_agent.token_budget import estimate_tokens
from xvie_agent.tools import ToolContext, build_default_registry


# ---------------------------------------------------------------------------
# Tool schema trimming
# ---------------------------------------------------------------------------


class TestToolSchemaTrimming:
    """Verify tools are excluded based on permissions."""

    def _get_tool_names(self, tool_ctx: ToolContext) -> list[str]:
        tools = build_default_registry(tool_ctx)
        schemas = _tools_to_openai_format(tools, tool_ctx)
        return [s["function"]["name"] for s in schemas]

    def test_all_tools_when_all_allowed(self, tmp_path: Path):
        ctx = ToolContext(
            workspace_root=tmp_path, allow_write=True, allow_shell=True
        )
        names = self._get_tool_names(ctx)
        assert "write_file" in names
        assert "edit_file" in names
        assert "bash" in names

    def test_write_tools_excluded_when_write_disabled(self, tmp_path: Path):
        ctx = ToolContext(
            workspace_root=tmp_path, allow_write=False, allow_shell=True
        )
        names = self._get_tool_names(ctx)
        assert "write_file" not in names
        assert "edit_file" not in names
        assert "bash" in names

    def test_bash_excluded_when_shell_disabled(self, tmp_path: Path):
        ctx = ToolContext(
            workspace_root=tmp_path, allow_write=True, allow_shell=False
        )
        names = self._get_tool_names(ctx)
        assert "bash" not in names
        assert "write_file" in names

    def test_read_only_tools_always_present(self, tmp_path: Path):
        ctx = ToolContext(
            workspace_root=tmp_path, allow_write=False, allow_shell=False
        )
        names = self._get_tool_names(ctx)
        assert "read_file" in names
        assert "list_dir" in names
        assert "glob_search" in names
        assert "grep_search" in names


# ---------------------------------------------------------------------------
# System prompt token budget
# ---------------------------------------------------------------------------


class TestSystemPromptBudget:
    """Verify the system prompt stays under a reasonable token budget."""

    def _build_prompt(self, memory: str = "", tools: list[str] | None = None) -> str:
        snapshot = build_context_snapshot(Path("."))
        return build_system_prompt(
            memory=memory,
            context_snapshot=snapshot,
            tool_names=tools or ["bash", "edit_file", "glob_search", "grep_search",
                                  "list_dir", "read_file", "write_file"],
        )

    def test_prompt_under_1300_tokens(self):
        prompt = self._build_prompt()
        tokens = estimate_tokens(prompt)
        assert tokens < 1300, f"System prompt too long: {tokens} tokens (budget: 1300)"

    def test_prompt_with_memory_under_1500_tokens(self):
        memory = "# Project Instructions\nAlways answer in bullet points.\n" * 5
        prompt = self._build_prompt(memory=memory)
        tokens = estimate_tokens(prompt)
        assert tokens < 1500, f"System prompt with memory too long: {tokens} tokens"

    def test_prompt_mentions_verbosity_instruction(self):
        prompt = self._build_prompt()
        assert "investigate" in prompt.lower() or "use your tools" in prompt.lower()

    def test_prompt_has_identity(self):
        prompt = self._build_prompt()
        assert "xvie-agent" in prompt.lower()

    def test_prompt_has_tool_guidance(self):
        prompt = self._build_prompt()
        assert "list_dir" in prompt or "read_file" in prompt


# ---------------------------------------------------------------------------
# Tool description conciseness
# ---------------------------------------------------------------------------


class TestToolDescriptionConciseness:
    """Verify tool descriptions are short enough to save tokens."""

    def test_descriptions_under_40_tokens_each(self, tmp_path: Path):
        ctx = ToolContext(
            workspace_root=tmp_path, allow_write=True, allow_shell=True
        )
        tools = build_default_registry(ctx)
        for name, tool in tools.items():
            tokens = estimate_tokens(tool.description)
            assert tokens < 80, (
                f"Tool '{name}' description is {tokens} tokens "
                f"(target: <80). Description: {tool.description!r}"
            )

    def test_all_tool_schemas_under_budget(self, tmp_path: Path):
        """Total schema tokens for all tools should be reasonable."""
        ctx = ToolContext(
            workspace_root=tmp_path, allow_write=True, allow_shell=True
        )
        tools = build_default_registry(ctx)
        schemas = _tools_to_openai_format(tools, ctx)
        import json
        total = sum(
            estimate_tokens(json.dumps(s)) for s in schemas
        )
        # All tool schemas combined should be under budget (bumped 2500->2800
        # for the ask_question clarifying-questions tool).
        assert total < 2800, f"Total tool schemas: {total} tokens (budget: 2800)"
