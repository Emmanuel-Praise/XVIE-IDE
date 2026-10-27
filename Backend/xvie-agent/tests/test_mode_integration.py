"""Integration tests for mode-aware agent loop — verifies modes filter
tools, inject prompts, and override lanes correctly.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from xvie_agent.loop import run_agent
from xvie_agent.modes import get_mode, MODES
from xvie_agent.providers.base import ProviderClient, ProviderConfig
from xvie_agent.types import BudgetConfig, UsageStats


# ---------------------------------------------------------------------------
# Fake provider that records what tools it was asked to use
# ---------------------------------------------------------------------------

class FakeProvider:
    """Minimal provider that returns a canned response — records calls.

    Intentionally does NOT implement stream() so the agent loop falls
    back to complete() which we CAN record.
    """

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def complete(self, *, model: str, messages: list[dict], tools=None, **kw):
        self.calls.append({"model": model, "messages": messages, "tools": tools})
        from xvie_agent.types import AssistantTurn
        return AssistantTurn(
            content="Done.",
            tool_calls=(),
            usage=UsageStats(input_tokens=10, output_tokens=5),
            model=model,
        )

    @property
    def provider_name(self) -> str:
        return "fake"


@pytest.fixture()
def workspace(tmp_path: Path) -> Path:
    (tmp_path / "app.py").write_text("print('hello')\n")
    return tmp_path


# ---------------------------------------------------------------------------
# Plan mode integration
# ---------------------------------------------------------------------------

class TestPlanModeIntegration:
    def test_plan_mode_blocks_write_tools(self, workspace: Path) -> None:
        """Plan mode must NOT allow write_file, edit_file, bash in the tool list."""
        provider = FakeProvider()
        result = run_agent(
            prompt="build me a website",
            model="test-model",
            workspace_root=workspace,
            provider=provider,  # type: ignore
            mode="plan",
            allow_write=True,  # Even if caller allows, mode should block
            allow_shell=True,
            max_turns=3,
            budget=BudgetConfig(max_turns=3),
        )
        # The provider should have been called with tools that DON'T include write/bash
        assert provider.calls, "Provider was not called"
        last_call = provider.calls[-1]
        tool_defs = last_call.get("tools") or []
        tool_names = [t["function"]["name"] for t in tool_defs]
        assert "write_file" not in tool_names
        assert "edit_file" not in tool_names
        assert "bash" not in tool_names
        assert "read_file" in tool_names
        assert "list_dir" in tool_names

    def test_plan_mode_injects_planning_prompt(self, workspace: Path) -> None:
        """Plan mode must inject PLANNING MODE into the system prompt."""
        provider = FakeProvider()
        result = run_agent(
            prompt="analyze the codebase",
            model="test-model",
            workspace_root=workspace,
            provider=provider,  # type: ignore
            mode="plan",
            max_turns=2,
            budget=BudgetConfig(max_turns=2),
        )
        # Check that the system message contains PLANNING MODE
        assert provider.calls
        messages = provider.calls[0]["messages"]
        system_msg = messages[0]
        assert system_msg["role"] == "system"
        assert "PLANNING MODE" in system_msg["content"]


# ---------------------------------------------------------------------------
# Code mode integration
# ---------------------------------------------------------------------------

class TestCodeModeIntegration:
    def test_code_mode_allows_write_tools(self, workspace: Path) -> None:
        """Code mode must include write_file, edit_file, bash."""
        provider = FakeProvider()
        result = run_agent(
            prompt="create a test file",
            model="test-model",
            workspace_root=workspace,
            provider=provider,  # type: ignore
            mode="code",
            allow_write=True,
            allow_shell=True,
            max_turns=3,
            budget=BudgetConfig(max_turns=3),
        )
        assert provider.calls
        tool_defs = provider.calls[0].get("tools") or []
        tool_names = [t["function"]["name"] for t in tool_defs]
        assert "write_file" in tool_names
        assert "bash" in tool_names

    def test_code_mode_no_extra_mode_prompt(self, workspace: Path) -> None:
        """Code mode should not add a mode-specific system prompt section."""
        provider = FakeProvider()
        result = run_agent(
            prompt="hello",
            model="test-model",
            workspace_root=workspace,
            provider=provider,  # type: ignore
            mode="code",
            max_turns=1,
            budget=BudgetConfig(max_turns=1),
        )
        assert provider.calls
        messages = provider.calls[0]["messages"]
        system_msg = messages[0]
        # Code mode should NOT inject "CODE MODE" header
        assert "CODE MODE" not in system_msg["content"]


# ---------------------------------------------------------------------------
# Debug mode integration
# ---------------------------------------------------------------------------

class TestDebugModeIntegration:
    def test_debug_mode_allows_write_and_shell(self, workspace: Path) -> None:
        """Debug mode must have write and shell access."""
        provider = FakeProvider()
        result = run_agent(
            prompt="find and fix the bug in app.py",
            model="test-model",
            workspace_root=workspace,
            provider=provider,  # type: ignore
            mode="debug",
            allow_write=True,
            allow_shell=True,
            max_turns=3,
            budget=BudgetConfig(max_turns=3),
        )
        assert provider.calls
        tool_defs = provider.calls[0].get("tools") or []
        tool_names = [t["function"]["name"] for t in tool_defs]
        assert "write_file" in tool_names
        assert "bash" in tool_names

    def test_debug_mode_injects_debugging_prompt(self, workspace: Path) -> None:
        """Debug mode must inject DEBUG MODE into the system prompt."""
        provider = FakeProvider()
        result = run_agent(
            prompt="fix the ImportError in my code",
            model="test-model",
            workspace_root=workspace,
            provider=provider,  # type: ignore
            mode="debug",
            allow_write=True,
            allow_shell=True,
            max_turns=2,
            budget=BudgetConfig(max_turns=2),
        )
        assert provider.calls
        messages = provider.calls[0]["messages"]
        system_msg = messages[0]
        assert "DEBUG MODE" in system_msg["content"]


# ---------------------------------------------------------------------------
# Ask mode integration
# ---------------------------------------------------------------------------

class TestAskModeIntegration:
    def test_ask_mode_blocks_writes(self, workspace: Path) -> None:
        """Ask mode must NOT include write/bash tools."""
        provider = FakeProvider()
        result = run_agent(
            prompt="how does the router work?",
            model="test-model",
            workspace_root=workspace,
            provider=provider,  # type: ignore
            mode="ask",
            max_turns=3,
            budget=BudgetConfig(max_turns=3),
        )
        assert provider.calls
        tool_defs = provider.calls[0].get("tools") or []
        tool_names = [t["function"]["name"] for t in tool_defs]
        assert "write_file" not in tool_names
        assert "bash" not in tool_names
        assert "read_file" in tool_names

    def test_ask_mode_injects_ask_prompt(self, workspace: Path) -> None:
        """Ask mode must inject ASK MODE into the system prompt."""
        provider = FakeProvider()
        result = run_agent(
            prompt="what is the purpose of the router?",
            model="test-model",
            workspace_root=workspace,
            provider=provider,  # type: ignore
            mode="ask",
            max_turns=2,
            budget=BudgetConfig(max_turns=2),
        )
        assert provider.calls
        messages = provider.calls[0]["messages"]
        system_msg = messages[0]
        assert "ASK MODE" in system_msg["content"]


# ---------------------------------------------------------------------------
# Brainstorm mode integration
# ---------------------------------------------------------------------------

class TestBrainstormModeIntegration:
    def test_brainstorm_mode_has_web_tools(self, workspace: Path) -> None:
        """Brainstorm mode must include web_search and web_fetch."""
        provider = FakeProvider()
        result = run_agent(
            prompt="what are best practices for rate limiting?",
            model="test-model",
            workspace_root=workspace,
            provider=provider,  # type: ignore
            mode="brainstorm",
            max_turns=3,
            budget=BudgetConfig(max_turns=3),
        )
        assert provider.calls
        tool_defs = provider.calls[0].get("tools") or []
        tool_names = [t["function"]["name"] for t in tool_defs]
        assert "web_search" in tool_names
        assert "web_fetch" in tool_names

    def test_brainstorm_mode_blocks_writes(self, workspace: Path) -> None:
        """Brainstorm mode must NOT include write/bash tools."""
        provider = FakeProvider()
        result = run_agent(
            prompt="suggest improvements",
            model="test-model",
            workspace_root=workspace,
            provider=provider,  # type: ignore
            mode="brainstorm",
            max_turns=3,
            budget=BudgetConfig(max_turns=3),
        )
        assert provider.calls
        tool_defs = provider.calls[0].get("tools") or []
        tool_names = [t["function"]["name"] for t in tool_defs]
        assert "write_file" not in tool_names
        assert "bash" not in tool_names

    def test_brainstorm_mode_injects_brainstorm_prompt(self, workspace: Path) -> None:
        """Brainstorm mode must inject BRAINSTORM MODE into the system prompt."""
        provider = FakeProvider()
        result = run_agent(
            prompt="what frameworks should I use?",
            model="test-model",
            workspace_root=workspace,
            provider=provider,  # type: ignore
            mode="brainstorm",
            max_turns=2,
            budget=BudgetConfig(max_turns=2),
        )
        assert provider.calls
        messages = provider.calls[0]["messages"]
        system_msg = messages[0]
        assert "BRAINSTORM MODE" in system_msg["content"]


# ---------------------------------------------------------------------------
# Lane override integration
# ---------------------------------------------------------------------------

class TestLaneOverrideIntegration:
    def test_plan_mode_forces_reasoning_lane(self, workspace: Path) -> None:
        """Plan mode should use the reasoning lane even if workflow would suggest otherwise."""
        provider = FakeProvider()
        # "create a website" would normally route to coding, but plan mode overrides
        result = run_agent(
            prompt="create a website",
            model="test-model",
            workspace_root=workspace,
            provider=provider,  # type: ignore
            mode="plan",
            max_turns=2,
            budget=BudgetConfig(max_turns=2),
        )
        # Verify the mode config says reasoning lane
        cfg = get_mode("plan")
        assert cfg.lane_override == "reasoning"


# ---------------------------------------------------------------------------
# Regression: read-only modes must never advertise or order file writes
# ---------------------------------------------------------------------------

class _ScriptedProvider(FakeProvider):
    """FakeProvider variant that replays scripted AssistantTurns."""

    def __init__(self, responses):
        super().__init__()
        self._responses = list(responses)
        self._idx = 0

    def complete(self, *, model: str, messages: list[dict], tools=None, **kw):
        self.calls.append({"model": model, "messages": messages, "tools": tools})
        if self._idx >= len(self._responses):
            raise RuntimeError("_ScriptedProvider: exhausted responses")
        resp = self._responses[self._idx]
        self._idx += 1
        return resp


class TestReadOnlyModePromptAdvertising:
    def test_plan_mode_prompt_does_not_advertise_write_tools(self, workspace: Path) -> None:
        """Plan mode's system prompt must not hand the model write tool names."""
        provider = FakeProvider()
        run_agent(
            prompt="analyze the codebase",
            model="test-model",
            workspace_root=workspace,
            provider=provider,  # type: ignore
            mode="plan",
            max_turns=2,
            budget=BudgetConfig(max_turns=2),
        )
        assert provider.calls
        system_msg = provider.calls[0]["messages"][0]
        content = system_msg["content"]
        # Read-only framing + the denied-tool warning are present.
        assert "READ-ONLY" in content
        assert "You have ONLY these tools" in content
        assert "Do not attempt write or shell tools" in content
        # The code-mode write rules/guide and the write-ordering compliance
        # nudge must be absent in read-only sessions.
        assert "always write code" not in content
        assert "write each file COMPLETELY" not in content
        assert "STRICT PLAN MODE" not in content
        assert "write_file / append_file / edit_file: write code" not in content

    def test_ask_mode_prompt_does_not_advertise_write_tools(self, workspace: Path) -> None:
        """Ask mode's system prompt must list only the tools it actually has."""
        provider = FakeProvider()
        run_agent(
            prompt="how does the router work?",
            model="test-model",
            workspace_root=workspace,
            provider=provider,  # type: ignore
            mode="ask",
            max_turns=2,
            budget=BudgetConfig(max_turns=2),
        )
        assert provider.calls
        system_msg = provider.calls[0]["messages"][0]
        content = system_msg["content"]
        assert "READ-ONLY" in content
        assert "write_file" not in content
        assert "edit_file" not in content
        assert "write each file COMPLETELY" not in content


class TestReadOnlyLoopNoWriteNudges:
    def test_plan_mode_stall_nudge_never_orders_writes(self, workspace: Path) -> None:
        """A read-only loop that stalls must prompt for text, never for writes."""
        from xvie_agent.types import AssistantTurn, ToolCall

        star = lambda: (ToolCall(id="r1", name="read_file", arguments={"path": "app.py"}),)
        provider = _ScriptedProvider([
            # Empty tool-call turn (no text) → executing read_file
            AssistantTurn("", star(), UsageStats(input_tokens=10, output_tokens=1), model="test-model"),
            # Empty answer → stall detection fires the read-only nudge
            AssistantTurn("", usage=UsageStats(input_tokens=10, output_tokens=1), model="test-model"),
            AssistantTurn("", star(), UsageStats(input_tokens=10, output_tokens=1), model="test-model"),
            AssistantTurn("", usage=UsageStats(input_tokens=10, output_tokens=1), model="test-model"),
            AssistantTurn("Plan: 1. Update app.py styles. 2. Save.", usage=UsageStats(), model="test-model"),
        ])
        result = run_agent(
            prompt="make the design better",
            model="test-model",
            workspace_root=workspace,
            provider=provider,  # type: ignore
            mode="plan",
            max_turns=10,
            budget=BudgetConfig(max_turns=10),
        )
        assert result.stop_reason == "completed"
        assert "Plan:" in result.final_output
        # Inspect the messages the agent actually handed back to the model —
        # injected user nudges live there, not in the transcript.
        user_messages: list[str] = []
        for call in provider.calls:
            for m in call["messages"]:
                if m.get("role") == "user":
                    user_messages.append(str(m.get("content", "")))
        joined = "\n".join(user_messages)
        assert "write_file" not in joined
        assert "start writing" not in joined
        assert "STOP INSPECTING" not in joined
        # The read-only nudge explicitly tells the model to deliver text.
        assert "read-only" in joined

    def test_plan_mode_loop_tools_are_read_only(self, workspace: Path) -> None:
        """Plan mode's loop tool schema contains zero write/shell tools."""
        provider = FakeProvider()
        run_agent(
            prompt="build me a website",
            model="test-model",
            workspace_root=workspace,
            provider=provider,  # type: ignore
            mode="plan",
            allow_write=True,
            allow_shell=True,
            max_turns=3,
            budget=BudgetConfig(max_turns=3),
        )
        assert provider.calls
        tool_defs = provider.calls[0].get("tools") or []
        tool_names = {t["function"]["name"] for t in tool_defs}
        assert not (tool_names & {
            "write_file", "edit_file", "append_file", "apply_patch",
            "move_file", "delete_file", "bash", "run_code",
        })
        # Plan-tracking tools stay available (they don't touch user code).
        assert "write_plan" in tool_names
        assert "mark_task_done" in tool_names


# ---------------------------------------------------------------------------
# Default mode behavior
# ---------------------------------------------------------------------------

class TestDefaultMode:
    def test_default_mode_is_code(self) -> None:
        from xvie_agent.modes import DEFAULT_MODE
        assert DEFAULT_MODE == "code"

    def test_unknown_mode_falls_back_to_code(self) -> None:
        mode = get_mode("unknown_mode")
        assert mode.name == "code"
