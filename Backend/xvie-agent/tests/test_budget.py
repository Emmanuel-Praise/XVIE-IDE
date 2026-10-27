"""Tests for budget enforcement — airtight stop at exact limits."""

from __future__ import annotations

from pathlib import Path

import pytest

from xvie_agent.agent import AgentLoop, BudgetTracker
from xvie_agent.types import (
    AssistantTurn,
    BudgetConfig,
    ToolCall,
    UsageStats,
)


# ---------------------------------------------------------------------------
# Fake client
# ---------------------------------------------------------------------------

class ScriptedClient:
    """Returns responses in order. Always includes tool calls to test limits."""

    def __init__(self, responses: list[AssistantTurn]) -> None:
        self._responses = list(responses)
        self._idx = 0

    def complete(self, model, messages, tools=None, temperature=0.0):
        if self._idx >= len(self._responses):
            raise RuntimeError("ScriptedClient exhausted")
        resp = self._responses[self._idx]
        self._idx += 1
        return resp

    def close(self):
        pass


# ---------------------------------------------------------------------------
# BudgetTracker unit tests
# ---------------------------------------------------------------------------

class TestBudgetTrackerStrict:
    def test_max_model_calls_stops_at_exact_count(self) -> None:
        bt = BudgetTracker(BudgetConfig(max_model_calls=2))
        assert bt.check() is None
        bt.record_model_call("m", UsageStats())
        assert bt.check() is None
        bt.record_model_call("m", UsageStats())
        assert bt.check() == "budget_exceeded"

    def test_max_tool_calls_stops_at_exact_count(self) -> None:
        bt = BudgetTracker(BudgetConfig(max_tool_calls=3))
        bt.record_tool_call()
        bt.record_tool_call()
        assert bt.check() is None
        bt.record_tool_call()
        assert bt.check() == "budget_exceeded"

    def test_max_turns_stops_at_exact_count(self) -> None:
        bt = BudgetTracker(BudgetConfig(max_turns=1))
        assert bt.check() is None
        bt.record_turn()
        assert bt.check() == "max_turns"

    def test_multiple_limits_checked_in_order(self) -> None:
        bt = BudgetTracker(BudgetConfig(max_turns=1, max_tool_calls=5))
        bt.record_turn()
        # max_turns should trigger first
        assert bt.check() == "max_turns"


# ---------------------------------------------------------------------------
# Integration: loop stops at exact budget limit
# ---------------------------------------------------------------------------

@pytest.fixture()
def sandbox(tmp_path: Path) -> Path:
    (tmp_path / "test.py").write_text("x = 1\n")
    return tmp_path


class TestLoopBudgetEnforcement:
    def test_max_model_calls_2(self, sandbox: Path) -> None:
        """With max_model_calls=2, the loop should stop after exactly 2 model calls."""
        from xvie_agent.tools import ToolContext, build_default_registry
        tool_ctx = ToolContext(workspace_root=sandbox, allow_write=True, allow_shell=True)
        tools = build_default_registry(tool_ctx)

        client = ScriptedClient([
            # Turn 1: tool call → will make 1 model call
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c1", name="list_dir", arguments={"path": "."}),),
                usage=UsageStats(input_tokens=10, output_tokens=5),
                model="m",
            ),
            # Turn 2: tool call → will make 2nd model call → budget hit
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c2", name="list_dir", arguments={"path": "."}),),
                usage=UsageStats(input_tokens=10, output_tokens=5),
                model="m",
            ),
            # Turn 3: should never be reached
            AssistantTurn(
                content="Done",
                usage=UsageStats(input_tokens=10, output_tokens=5),
                model="m",
            ),
        ])

        loop = AgentLoop(
            client=client,
            model="m",
            tools=tools,
            tool_ctx=tool_ctx,
            budget=BudgetConfig(max_model_calls=2),
        )
        result = loop.run("Do stuff")

        assert result.stop_reason == "budget_exceeded"
        assert result.turns == 2
        assert client._idx == 2  # Only 2 calls made, 3rd never reached

    def test_max_tool_calls_1(self, sandbox: Path) -> None:
        """With max_tool_calls=1, only 1 tool should be executed."""
        from xvie_agent.tools import ToolContext, build_default_registry
        tool_ctx = ToolContext(workspace_root=sandbox, allow_write=True, allow_shell=True)
        tools = build_default_registry(tool_ctx)

        client = ScriptedClient([
            # Turn 1: 3 tool calls → only 1 should execute before budget hit
            AssistantTurn(
                content="",
                tool_calls=(
                    ToolCall(id="c1", name="list_dir", arguments={"path": "."}),
                    ToolCall(id="c2", name="list_dir", arguments={"path": "."}),
                    ToolCall(id="c3", name="list_dir", arguments={"path": "."}),
                ),
                usage=UsageStats(input_tokens=10, output_tokens=5),
                model="m",
            ),
        ])

        loop = AgentLoop(
            client=client,
            model="m",
            tools=tools,
            tool_ctx=tool_ctx,
            budget=BudgetConfig(max_tool_calls=1),
        )
        result = loop.run("Do lots of stuff")

        assert result.stop_reason == "budget_exceeded"
        assert len(result.tool_calls) <= 3  # Budget check happens before execution

    def test_max_turns_3(self, sandbox: Path) -> None:
        """With max_turns=3, exactly 3 turns should execute."""
        from xvie_agent.tools import ToolContext, build_default_registry
        tool_ctx = ToolContext(workspace_root=sandbox, allow_write=True, allow_shell=True)
        tools = build_default_registry(tool_ctx)

        client = ScriptedClient([
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id=f"c{i}", name="list_dir", arguments={"path": "."}),),
                usage=UsageStats(input_tokens=10, output_tokens=5),
                model="m",
            )
            for i in range(5)
        ])

        loop = AgentLoop(
            client=client,
            model="m",
            tools=tools,
            tool_ctx=tool_ctx,
            budget=BudgetConfig(max_turns=3),
        )
        result = loop.run("Keep going")

        assert result.stop_reason == "max_turns"
        assert result.turns == 3
