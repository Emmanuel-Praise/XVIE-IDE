"""Tests for the plan-before-write gate in agent.py.

A fake model attempting write_file/edit_file before write_plan on a multi-step
task must be rejected with a specific error telling the model to plan first.
The model gets that error back as a tool result so it can self-correct.
"""

from __future__ import annotations

from pathlib import Path
from typing import Sequence

import pytest

from xvie_agent.agent import AgentLoop
from xvie_agent.tools import ToolContext, build_default_registry
from xvie_agent.types import AssistantTurn, BudgetConfig, ToolCall, UsageStats


class StubClient:
    """A fake ProviderClient that returns pre-configured responses, then empty text."""

    def __init__(self, responses: Sequence[AssistantTurn]) -> None:
        self._responses = list(responses)
        self._call_index = 0
        self.calls: list[dict] = []

    def complete(self, model: str, messages: list[dict], tools=None, temperature=0.0):
        self.calls.append({"model": model, "messages": messages, "tools": tools})
        if self._call_index < len(self._responses):
            resp = self._responses[self._call_index]
            self._call_index += 1
            return resp
        # After configured responses, return empty text to stop the loop
        return AssistantTurn(content="", usage=UsageStats())

    def close(self):
        pass


@pytest.fixture()
def sandbox(tmp_path: Path) -> Path:
    return tmp_path


@pytest.fixture()
def tool_ctx(sandbox: Path) -> ToolContext:
    return ToolContext(workspace_root=sandbox, allow_write=True, allow_shell=True)


@pytest.fixture()
def tools(tool_ctx: ToolContext) -> dict:
    return build_default_registry(tool_ctx)


class TestPlanGate:
    """Write tools must be rejected before a plan exists."""

    def test_write_file_rejected_before_plan(self, tools: dict, tool_ctx: ToolContext) -> None:
        """Model tries write_file without calling write_plan first — rejected."""
        client = StubClient([
            # Turn 1: model jumps straight to write_file (no plan) → rejected
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c1", name="write_file", arguments={"path": "index.html", "content": "<html></html>"}),),
                usage=UsageStats(input_tokens=20, output_tokens=5),
            ),
            # Turn 2: model calls write_plan (self-corrects after seeing the error)
            AssistantTurn(
                content="",
                tool_calls=(
                    ToolCall(id="c2", name="write_plan", arguments={
                        "title": "Build site",
                        "summary": "Create a portfolio.",
                        "steps": [
                            {"title": "Create index.html", "description": "Home page", "files_touched": ["index.html"]},
                            {"title": "Create style.css", "description": "Styles", "files_touched": ["style.css"]},
                        ],
                    }),
                ),
                usage=UsageStats(input_tokens=30, output_tokens=10),
            ),
            # Turn 3: model calls write_file again (now allowed after plan)
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c3", name="write_file", arguments={"path": "index.html", "content": "<html><body>Hi</body></html>"}),),
                usage=UsageStats(input_tokens=40, output_tokens=10),
            ),
            # Turn 4: mark first task
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c4", name="mark_task_done", arguments={"title": "Create index.html"}),),
                usage=UsageStats(input_tokens=50, output_tokens=10),
            ),
            # Turn 5: final
            AssistantTurn(
                content="Created the site.",
                usage=UsageStats(input_tokens=60, output_tokens=10),
            ),
        ])
        loop = AgentLoop(client=client, model="m", tools=tools, tool_ctx=tool_ctx)
        result = loop.run("Build a portfolio site with 2 files")

        # The first write_file (c1) should have been rejected
        # Find the tool result for c1 in the conversation
        for call_data in client.calls:
            for msg in call_data["messages"]:
                if msg.get("role") == "tool" and msg.get("tool_call_id") == "c1":
                    assert "plan" in msg["content"].lower()
                    assert "write_plan" in msg["content"]
                    break

        assert result.stop_reason == "completed"

    def test_edit_file_rejected_before_plan(self, tools: dict, tool_ctx: ToolContext) -> None:
        """edit_file is also rejected before a plan exists."""
        (tool_ctx.workspace_root / "code.py").write_text("def old(): pass\n")

        client = StubClient([
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c1", name="edit_file", arguments={"path": "code.py", "old_str": "old", "new_str": "new"}),),
                usage=UsageStats(input_tokens=20, output_tokens=5),
            ),
            AssistantTurn(
                content="I need to plan first.",
                usage=UsageStats(input_tokens=30, output_tokens=10),
            ),
        ])
        loop = AgentLoop(client=client, model="m", tools=tools, tool_ctx=tool_ctx)
        result = loop.run("Refactor code.py")

        # Find the tool result for c1
        for call_data in client.calls:
            for msg in call_data["messages"]:
                if msg.get("role") == "tool" and msg.get("tool_call_id") == "c1":
                    assert "plan" in msg["content"].lower()
                    return
        pytest.fail("No tool result found for c1")

    def test_write_plan_allows_subsequent_writes(self, tools: dict, tool_ctx: ToolContext) -> None:
        """After write_plan succeeds, write_file is allowed."""
        client = StubClient([
            # Turn 1: model calls write_plan
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c1", name="write_plan", arguments={
                    "title": "Build",
                    "summary": "Two files.",
                    "steps": [{"title": "Create index.html", "description": "Home", "files_touched": ["index.html"]}],
                }),),
                usage=UsageStats(input_tokens=20, output_tokens=5),
            ),
            # Turn 2: model calls write_file — should be allowed now
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c2", name="write_file", arguments={"path": "index.html", "content": "<html></html>"}),),
                usage=UsageStats(input_tokens=30, output_tokens=10),
            ),
            # Turn 3: mark task done
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c3", name="mark_task_done", arguments={"title": "Create index.html"}),),
                usage=UsageStats(input_tokens=40, output_tokens=10),
            ),
            AssistantTurn(
                content="Done.",
                usage=UsageStats(input_tokens=50, output_tokens=10),
            ),
        ])
        loop = AgentLoop(client=client, model="m", tools=tools, tool_ctx=tool_ctx)
        result = loop.run("Build a site")

        # write_file (c2) should have been executed, not rejected
        for call_data in client.calls:
            for msg in call_data["messages"]:
                if msg.get("role") == "tool" and msg.get("tool_call_id") == "c2":
                    # Should NOT contain plan_required error
                    assert "plan_required" not in msg.get("content", "")
                    return
        pytest.fail("No tool result found for c2")

    def test_pre_existing_plan_bypasses_gate(self, tools: dict, tool_ctx: ToolContext) -> None:
        """If a plan already exists in .xvie/plans/, writes are allowed immediately."""
        plans_dir = tool_ctx.workspace_root / ".xvie" / "plans"
        plans_dir.mkdir(parents=True)
        (plans_dir / "20250101-000000-existing.md").write_text(
            "# Existing Plan\n\n## Steps\n\n- [ ] **Step 1** - Do something\n"
        )

        client = StubClient([
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c1", name="write_file", arguments={"path": "test.txt", "content": "hello"}),),
                usage=UsageStats(input_tokens=20, output_tokens=5),
            ),
            AssistantTurn(
                content="Done.",
                usage=UsageStats(input_tokens=30, output_tokens=10),
            ),
        ])
        loop = AgentLoop(client=client, model="m", tools=tools, tool_ctx=tool_ctx)
        result = loop.run("Write a test file")

        # write_file should have been executed without plan_required error
        for call_data in client.calls:
            for msg in call_data["messages"]:
                if msg.get("role") == "tool" and msg.get("tool_call_id") == "c1":
                    assert "plan_required" not in msg.get("error_kind", "")
                    return


class TestPlanGateEvents:
    """The agent loop should emit plan_required events when gating."""

    def test_plan_required_event_emitted(self, tools: dict, tool_ctx: ToolContext) -> None:
        events = []

        def on_event(e):
            events.append(e)

        client = StubClient([
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c1", name="write_file", arguments={"path": "x.txt", "content": "y"}),),
                usage=UsageStats(input_tokens=10, output_tokens=5),
            ),
            AssistantTurn(
                content="I see.",
                usage=UsageStats(input_tokens=20, output_tokens=5),
            ),
        ])
        loop = AgentLoop(
            client=client, model="m", tools=tools, tool_ctx=tool_ctx,
            event_callback=on_event,
        )
        loop.run("Create a file")

        event_kinds = [e.kind for e in events]
        assert "plan_required" in event_kinds
