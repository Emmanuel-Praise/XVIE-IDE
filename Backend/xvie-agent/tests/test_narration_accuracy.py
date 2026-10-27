"""Tests for narration accuracy in agent.py.

The narration events (editing, edit_failed, tool_finished) must reflect the
actual outcome of tool calls, not generic success-shaped lines.
"""

from __future__ import annotations

from pathlib import Path
from typing import Sequence

import pytest

from xvie_agent.agent import AgentLoop
from xvie_agent.tools import ToolContext, build_default_registry
from xvie_agent.types import AssistantTurn, ToolCall, UsageStats


class StubClient:
    """A fake ProviderClient that returns pre-configured responses, then empty text."""

    def __init__(self, responses: Sequence[AssistantTurn]) -> None:
        self._responses = list(responses)
        self._call_index = 0

    def complete(self, model: str, messages: list[dict], tools=None, temperature=0.0):
        if self._call_index < len(self._responses):
            resp = self._responses[self._call_index]
            self._call_index += 1
            return resp
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


class TestNarrationAccuracy:
    """Narration events must reflect actual tool outcomes."""

    def test_successful_write_emits_editing_success(self, tools: dict, tool_ctx: ToolContext) -> None:
        """A successful write_file emits an 'editing' event with success message."""
        events = []

        def on_event(e):
            events.append(e)

        client = StubClient([
            # write_plan first
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c0", name="write_plan", arguments={
                    "title": "Build",
                    "summary": "One file.",
                    "steps": [{"title": "Create file", "description": "Write it", "files_touched": ["test.txt"]}],
                }),),
                usage=UsageStats(input_tokens=20, output_tokens=5),
            ),
            # Successful write_file
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c1", name="write_file", arguments={"path": "test.txt", "content": "hello"}),),
                usage=UsageStats(input_tokens=30, output_tokens=10),
            ),
            # mark_task_done
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c2", name="mark_task_done", arguments={"title": "Create file"}),),
                usage=UsageStats(input_tokens=40, output_tokens=10),
            ),
            AssistantTurn(
                content="Done.",
                usage=UsageStats(input_tokens=50, output_tokens=10),
            ),
        ])
        loop = AgentLoop(
            client=client, model="m", tools=tools, tool_ctx=tool_ctx,
            event_callback=on_event,
        )
        loop.run("Create a file")

        # Find editing events for write_file
        editing_events = [e for e in events if e.kind == "editing"]
        write_editing = [e for e in editing_events if e.data.get("tool") == "write_file"]
        assert len(write_editing) >= 1
        # New narration shows file path + line stats (e.g. "✏ test.txt (1 lines, 5 chars)")
        msg = write_editing[0].message.lower()
        assert "test.txt" in msg or "successfully" in msg, f"Unexpected editing message: {msg}"

    def test_failed_edit_emits_edit_failed(self, tools: dict, tool_ctx: ToolContext) -> None:
        """A failed edit_file emits an 'edit_failed' event, not a success-shaped one."""
        events = []

        def on_event(e):
            events.append(e)

        client = StubClient([
            # write_plan first
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c0", name="write_plan", arguments={
                    "title": "Build",
                    "summary": "One file.",
                    "steps": [{"title": "Edit file", "description": "Edit it", "files_touched": ["nonexistent.txt"]}],
                }),),
                usage=UsageStats(input_tokens=20, output_tokens=5),
            ),
            # edit_file on a non-existent file → fails
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c1", name="edit_file", arguments={"path": "nonexistent.txt", "old_str": "a", "new_str": "b"}),),
                usage=UsageStats(input_tokens=30, output_tokens=10),
            ),
            AssistantTurn(
                content="File not found.",
                usage=UsageStats(input_tokens=40, output_tokens=10),
            ),
        ])
        loop = AgentLoop(
            client=client, model="m", tools=tools, tool_ctx=tool_ctx,
            event_callback=on_event,
        )
        loop.run("Edit a file")

        # Should have edit_failed event for edit_file
        edit_failed = [e for e in events if e.kind == "edit_failed" and e.data.get("tool") == "edit_file"]
        assert len(edit_failed) >= 1, (
            f"Expected edit_failed event for edit_file but got: "
            f"{[(e.kind, e.message, e.data) for e in events if e.kind in ('editing', 'edit_failed')]}"
        )

    def test_tool_finished_reflects_failure(self, tools: dict, tool_ctx: ToolContext) -> None:
        """tool_finished event says 'needs attention' on failure, 'completed' on success."""
        events = []

        def on_event(e):
            events.append(e)

        client = StubClient([
            # write_plan
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c0", name="write_plan", arguments={
                    "title": "Build",
                    "summary": "One file.",
                    "steps": [{"title": "Read", "description": "Read file", "files_touched": ["missing.txt"]}],
                }),),
                usage=UsageStats(input_tokens=20, output_tokens=5),
            ),
            # read_file on missing file → fails
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c1", name="read_file", arguments={"path": "missing.txt"}),),
                usage=UsageStats(input_tokens=30, output_tokens=10),
            ),
            # list_dir → succeeds
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c2", name="list_dir", arguments={}),),
                usage=UsageStats(input_tokens=40, output_tokens=10),
            ),
            AssistantTurn(
                content="Done.",
                usage=UsageStats(input_tokens=50, output_tokens=10),
            ),
        ])
        loop = AgentLoop(
            client=client, model="m", tools=tools, tool_ctx=tool_ctx,
            event_callback=on_event,
        )
        loop.run("Read and list")

        tool_finished = [e for e in events if e.kind == "tool_finished"]
        # read_file should say "needs attention"
        read_finished = [e for e in tool_finished if e.data.get("tool") == "read_file"]
        assert len(read_finished) >= 1
        assert "needs attention" in read_finished[0].message.lower()

        # list_dir should say "completed"
        list_finished = [e for e in tool_finished if e.data.get("tool") == "list_dir"]
        assert len(list_finished) >= 1
        assert "completed" in list_finished[0].message.lower()

    def test_approval_denied_emits_action_denied(self, tools: dict, tool_ctx: ToolContext) -> None:
        """When user denies approval, action_denied event is emitted."""
        events = []

        def on_event(e):
            events.append(e)

        def deny_all(description: str) -> bool:
            return False

        client = StubClient([
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c0", name="write_plan", arguments={
                    "title": "Build",
                    "summary": "One file.",
                    "steps": [{"title": "Run test", "description": "Run tests", "files_touched": []}],
                }),),
                usage=UsageStats(input_tokens=20, output_tokens=5),
            ),
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c1", name="bash", arguments={"command": "echo hello"}),),
                usage=UsageStats(input_tokens=30, output_tokens=10),
            ),
            AssistantTurn(
                content="OK, denied.",
                usage=UsageStats(input_tokens=40, output_tokens=10),
            ),
        ])
        loop = AgentLoop(
            client=client, model="m", tools=tools, tool_ctx=tool_ctx,
            event_callback=on_event,
            approval_callback=deny_all,
            approval_required_tools={"bash"},
        )
        loop.run("Run a command")

        action_denied = [e for e in events if e.kind == "action_denied"]
        assert len(action_denied) >= 1
        assert "bash" in action_denied[0].message.lower()
