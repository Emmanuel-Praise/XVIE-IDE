"""Tests for xvie_agent.agent — agent loop orchestrator, fully mocked."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Sequence

import pytest

from xvie_agent.agent import (
    AgentLoop,
    BudgetTracker,
    DEFAULT_SYSTEM_PROMPT,
    _tools_to_openai_format,
)
from xvie_agent.providers.base import ProviderError, RateLimitedError
from xvie_agent.retry import RetryPolicy
from xvie_agent.tools import ToolContext, build_default_registry
from xvie_agent.types import (
    AgentRunResult,
    AssistantTurn,
    BudgetConfig,
    ToolCall,
    UsageStats,
)


# ---------------------------------------------------------------------------
# Stub ProviderClient — returns canned responses
# ---------------------------------------------------------------------------

class StubClient:
    """A fake ProviderClient that returns pre-configured responses."""

    def __init__(self, responses: Sequence[AssistantTurn]) -> None:
        self._responses = list(responses)
        self._call_index = 0
        self.calls: list[dict] = []

    def complete(self, model: str, messages: list[dict], tools=None, temperature=0.0):
        self.calls.append({"model": model, "messages": messages, "tools": tools})
        if self._call_index >= len(self._responses):
            raise RuntimeError("StubClient: no more responses configured")
        resp = self._responses[self._call_index]
        self._call_index += 1
        return resp

    def close(self):
        pass


class RateLimitStubClient:
    """Always raises RateLimitedError."""

    def complete(self, *a, **kw):
        raise RateLimitedError("Rate limited", status_code=429, body="{}")

    def close(self):
        pass


class ErrorStubClient:
    """Always raises ProviderError."""

    def complete(self, *a, **kw):
        raise ProviderError("Server error", status_code=500, body="{}")

    def close(self):
        pass


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def sandbox(tmp_path: Path) -> Path:
    (tmp_path / "hello.txt").write_text("Hello, world!\n")
    (tmp_path / "code.py").write_text("def foo():\n    return 42\n")
    return tmp_path


@pytest.fixture()
def tool_ctx(sandbox: Path) -> ToolContext:
    return ToolContext(workspace_root=sandbox, allow_write=True, allow_shell=True)


@pytest.fixture()
def tools(tool_ctx: ToolContext) -> dict:
    return build_default_registry(tool_ctx)


# ---------------------------------------------------------------------------
# BudgetTracker
# ---------------------------------------------------------------------------

class TestBudgetTracker:
    def test_no_limits(self) -> None:
        bt = BudgetTracker(BudgetConfig())
        assert bt.check() is None
        bt.record_model_call("m", UsageStats(input_tokens=10))
        bt.record_tool_call()
        bt.record_turn()
        assert bt.check() is None

    def test_max_turns(self) -> None:
        bt = BudgetTracker(BudgetConfig(max_turns=2))
        bt.record_turn()
        assert bt.check() is None
        bt.record_turn()
        assert bt.check() == "max_turns"

    def test_max_total_tokens(self) -> None:
        bt = BudgetTracker(BudgetConfig(max_total_tokens=100))
        bt.record_model_call("m", UsageStats(input_tokens=50, output_tokens=50))
        assert bt.check() == "budget_exceeded"

    def test_max_tool_calls(self) -> None:
        bt = BudgetTracker(BudgetConfig(max_tool_calls=3))
        bt.record_tool_call()
        bt.record_tool_call()
        assert bt.check() is None
        bt.record_tool_call()
        assert bt.check() == "budget_exceeded"

    def test_max_model_calls(self) -> None:
        bt = BudgetTracker(BudgetConfig(max_model_calls=1))
        bt.record_model_call("m", UsageStats())
        assert bt.check() == "budget_exceeded"

    def test_model_calls_by_model(self) -> None:
        bt = BudgetTracker(BudgetConfig())
        bt.record_model_call("model-a", UsageStats())
        bt.record_model_call("model-a", UsageStats())
        bt.record_model_call("model-b", UsageStats())
        assert bt.model_calls_by_model == {"model-a": 2, "model-b": 1}


# ---------------------------------------------------------------------------
# _tools_to_openai_format
# ---------------------------------------------------------------------------

class TestToolsFormat:
    def test_format_matches_registry(self, tools: dict) -> None:
        formatted = _tools_to_openai_format(tools)
        assert len(formatted) == len(tools)
        names = {f["function"]["name"] for f in formatted}
        assert names == set(tools.keys())

    def test_schema_structure(self, tools: dict) -> None:
        formatted = _tools_to_openai_format(tools)
        for item in formatted:
            assert item["type"] == "function"
            assert "name" in item["function"]
            assert "description" in item["function"]
            assert "parameters" in item["function"]


# ---------------------------------------------------------------------------
# AgentLoop — simple text response (no tools)
# ---------------------------------------------------------------------------

class TestAgentLoopTextOnly:
    def test_simple_text_response(self) -> None:
        client = StubClient([
            AssistantTurn(content="Hello!", usage=UsageStats(input_tokens=10, output_tokens=5)),
        ])
        loop = AgentLoop(client=client, model="m")
        result = loop.run("Say hello")

        assert isinstance(result, AgentRunResult)
        assert result.final_output == "Hello!"
        assert result.stop_reason == "completed"
        assert result.turns == 1
        assert result.usage.input_tokens == 10
        assert result.usage.output_tokens == 5
        assert len(client.calls) == 1

    def test_transcript_contains_system_and_user(self) -> None:
        client = StubClient([
            AssistantTurn(content="OK", usage=UsageStats()),
        ])
        loop = AgentLoop(client=client, model="m")
        result = loop.run("Do something")

        roles = [msg["role"] for msg in result.transcript]
        assert "system" in roles
        assert "user" in roles
        assert "assistant" in roles

    def test_custom_system_prompt(self) -> None:
        client = StubClient([
            AssistantTurn(content="OK", usage=UsageStats()),
        ])
        loop = AgentLoop(client=client, model="m", system_prompt="Custom prompt")
        result = loop.run("Hi")

        system_msgs = [msg for msg in result.transcript if msg["role"] == "system"]
        assert len(system_msgs) == 1
        assert system_msgs[0]["content"] == "Custom prompt"


# ---------------------------------------------------------------------------
# AgentLoop — tool execution
# ---------------------------------------------------------------------------

class TestAgentLoopWithTools:
    def test_identical_successful_read_is_not_repeated(self, tools: dict, tool_ctx: ToolContext) -> None:
        client = StubClient([
            AssistantTurn("", (ToolCall(id="r1", name="list_dir", arguments={"path": "."}),), UsageStats()),
            AssistantTurn("", (ToolCall(id="r2", name="list_dir", arguments={"path": "."}),), UsageStats()),
            AssistantTurn("I already have the directory listing.", usage=UsageStats()),
        ])
        events = []
        loop = AgentLoop(client=client, model="m", tools=tools, tool_ctx=tool_ctx, event_callback=events.append)

        result = loop.run("List the project files")

        finished = [event for event in events if event.kind == "tool_finished" and event.data.get("tool") == "list_dir"]
        assert result.stop_reason == "completed"
        assert [event.data["ok"] for event in finished] == [True, False]

    def test_single_tool_call(self, tools: dict, tool_ctx: ToolContext) -> None:
        """Model asks to read a file, agent executes it and feeds result back."""
        client = StubClient([
            # Turn 1: model requests a tool call
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c1", name="read_file", arguments={"path": "hello.txt"}),),
                usage=UsageStats(input_tokens=20, output_tokens=5),
            ),
            # Turn 2: model sees tool result and responds
            AssistantTurn(
                content="The file says 'Hello, world!'",
                usage=UsageStats(input_tokens=30, output_tokens=10),
            ),
        ])
        loop = AgentLoop(client=client, model="m", tools=tools, tool_ctx=tool_ctx)
        result = loop.run("Read hello.txt")

        assert result.final_output == "The file says 'Hello, world!'"
        assert result.stop_reason == "completed"
        assert result.turns == 2
        assert len(result.tool_calls) == 1
        assert result.tool_calls[0].name == "read_file"
        assert result.usage.total_tokens == 65

    def test_multiple_tool_calls_in_one_turn(self, tools: dict, tool_ctx: ToolContext) -> None:
        """Model issues two tool calls in a single response."""
        client = StubClient([
            AssistantTurn(
                content="",
                tool_calls=(
                    ToolCall(id="c1", name="read_file", arguments={"path": "hello.txt"}),
                    ToolCall(id="c2", name="read_file", arguments={"path": "code.py"}),
                ),
                usage=UsageStats(input_tokens=20, output_tokens=5),
            ),
            AssistantTurn(
                content="Both files read.",
                usage=UsageStats(input_tokens=40, output_tokens=10),
            ),
        ])
        loop = AgentLoop(client=client, model="m", tools=tools, tool_ctx=tool_ctx)
        result = loop.run("Read both files")

        assert result.final_output == "Both files read."
        assert len(result.tool_calls) == 2
        assert result.turns == 2

    def test_tool_error_returned_to_model(self, tools: dict, tool_ctx: ToolContext) -> None:
        """When a tool fails, the error is sent back to the model as a tool message."""
        client = StubClient([
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c1", name="read_file", arguments={"path": "missing.txt"}),),
                usage=UsageStats(input_tokens=20, output_tokens=5),
            ),
            AssistantTurn(
                content="File not found, let me try another approach.",
                usage=UsageStats(input_tokens=30, output_tokens=10),
            ),
        ])
        loop = AgentLoop(client=client, model="m", tools=tools, tool_ctx=tool_ctx)
        result = loop.run("Read missing.txt")

        assert "File not found" in result.final_output
        # Check the tool result message was added to the conversation
        tool_msgs = [m for m in client.calls[1]["messages"] if m.get("role") == "tool"]
        assert len(tool_msgs) == 1
        assert "not found" in tool_msgs[0]["content"].lower()

    def test_unknown_tool(self, tools: dict, tool_ctx: ToolContext) -> None:
        """Model requests a tool that doesn't exist in the registry."""
        client = StubClient([
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c1", name="nonexistent_tool", arguments={}),),
                usage=UsageStats(input_tokens=10, output_tokens=5),
            ),
            AssistantTurn(
                content="That tool doesn't exist.",
                usage=UsageStats(input_tokens=20, output_tokens=5),
            ),
        ])
        loop = AgentLoop(client=client, model="m", tools=tools, tool_ctx=tool_ctx)
        result = loop.run("Use nonexistent_tool")

        assert result.final_output == "That tool doesn't exist."
        tool_msgs = [m for m in client.calls[1]["messages"] if m.get("role") == "tool"]
        assert "Unknown tool" in tool_msgs[0]["content"]


class TestAgentLoopTruncatedToolCall:
    def test_truncated_raw_call_dropped_with_chunk_nudge(
        self, tools: dict, tool_ctx: ToolContext
    ) -> None:
        """A tool call cut off by the output cap (delivered as _raw json) must
        NOT be executed; the model is nudged to write in chunks instead."""
        # Seed a plan so the write tools aren't blocked by the plan gate.
        plans_dir = tool_ctx.workspace_root / ".xvie" / "plans"
        plans_dir.mkdir(parents=True, exist_ok=True)
        (plans_dir / "plan.md").write_text("# Build note.txt\n")

        client = StubClient([
            # Turn 1: response hit the cap while emitting write_file args.
            AssistantTurn(
                content="Let me write the whole thing...",
                tool_calls=(ToolCall(
                    id="c1",
                    name="write_file",
                    arguments={"_raw": '{"path": "note.txt", "content": "{"'},
                ),),
                usage=UsageStats(input_tokens=10, output_tokens=5),
                truncated=True,
            ),
            # Turn 2: model follows the chunking nudge.
            AssistantTurn(
                content="I'll write in chunks.",
                tool_calls=(ToolCall(
                    id="c2",
                    name="write_file",
                    arguments={"path": "note.txt", "content": "first part"},
                ),),
                usage=UsageStats(input_tokens=20, output_tokens=5),
            ),
            # Turn 3: appends the rest.
            AssistantTurn(
                content="Appending more.",
                tool_calls=(ToolCall(
                    id="c3",
                    name="append_file",
                    arguments={"path": "note.txt", "content": "second part"},
                ),),
                usage=UsageStats(input_tokens=30, output_tokens=5),
            ),
            # Turn 4: final summary.
            AssistantTurn(
                content="note.txt is complete.",
                usage=UsageStats(input_tokens=40, output_tokens=5),
            ),
        ])
        loop = AgentLoop(client=client, model="m", tools=tools, tool_ctx=tool_ctx)
        result = loop.run("Write out the file note.txt")

        # The truncated raw call was never executed.
        assert [tc.name for tc in result.tool_calls] == ["write_file", "append_file"]
        # Both chunks landed.
        content = (tool_ctx.workspace_root / "note.txt").read_text(encoding="utf-8")
        assert content == "first partsecond part"
        # The model received the chunking nudge on its second model call.
        nudge_msgs = [
            m["content"] for m in client.calls[1]["messages"] if m.get("role") == "user"
        ]
        assert any(
            "did NOT" in c and "chunks" in c.lower() for c in nudge_msgs
        )

    def test_untruncated_raw_is_repair_error(self, tools: dict, tool_ctx: ToolContext) -> None:
        """A non-truncated call with unparseable args is still a plain
        validation error (nothing changes about that path)."""
        client = StubClient([
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c1", name="read_file", arguments={"_raw": "garbage"}),),
                usage=UsageStats(input_tokens=10, output_tokens=5),
            ),
            AssistantTurn(
                content="I'll call it properly.",
                tool_calls=(ToolCall(id="c2", name="read_file", arguments={"path": "hello.txt"}),),
                usage=UsageStats(input_tokens=20, output_tokens=5),
            ),
            AssistantTurn(
                content="Done.",
                usage=UsageStats(input_tokens=30, output_tokens=5),
            ),
        ])
        loop = AgentLoop(client=client, model="m", tools=tools, tool_ctx=tool_ctx)
        result = loop.run("Read hello.txt")
        assert result.final_output == "Done."
        assert [tc.name for tc in result.tool_calls] == ["read_file", "read_file"]
        # The first (untruncated, unparseable) call was a plain repair error —
        # the recovery path must NOT have been triggered.
        repair_msgs = [m for m in client.calls[1]["messages"] if m.get("role") == "tool"]
        assert "not valid JSON" in repair_msgs[0]["content"]
        assert not any("did NOT" in m["content"] for m in client.calls[1]["messages"] if m.get("role") == "user")

    def test_incomplete_stream_raw_call_is_dropped_before_retry(self, tools: dict, tool_ctx: ToolContext) -> None:
        plans_dir = tool_ctx.workspace_root / ".xvie" / "plans"
        plans_dir.mkdir(parents=True, exist_ok=True)
        (plans_dir / "plan.md").write_text("# Build note.txt\n")
        client = StubClient([
            AssistantTurn(
                content="",
                tool_calls=(ToolCall("cut", "write_file", {"_raw": '{"path":"note.txt","content":"half'}),),
                incomplete=True,
            ),
            AssistantTurn(
                content="",
                tool_calls=(ToolCall("write", "write_file", {"path": "note.txt", "content": "complete"}),),
            ),
            AssistantTurn(content="Saved note.txt."),
        ])
        loop = AgentLoop(client=client, model="m", tools=tools, tool_ctx=tool_ctx)
        result = loop.run("Please save note.txt")
        assert (tool_ctx.workspace_root / "note.txt").read_text(encoding="utf-8") == "complete"
        assert [call.name for call in result.tool_calls] == ["write_file"]
        assert result.stop_reason == "completed"
        assert any(
            message.get("role") == "user" and "did NOT run" in message.get("content", "")
            for message in client.calls[1]["messages"]
        )


# ---------------------------------------------------------------------------
# AgentLoop — budget limits
# ---------------------------------------------------------------------------

class TestAgentLoopBudget:
    def test_max_turns_stops_loop(self, tools: dict, tool_ctx: ToolContext) -> None:
        """Loop stops after max_turns even if model keeps calling tools."""
        client = StubClient([
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c1", name="list_dir", arguments={}),),
                usage=UsageStats(input_tokens=10, output_tokens=5),
            ),
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c2", name="list_dir", arguments={}),),
                usage=UsageStats(input_tokens=10, output_tokens=5),
            ),
            AssistantTurn(
                content="Still working",
                usage=UsageStats(input_tokens=10, output_tokens=5),
            ),
        ])
        loop = AgentLoop(
            client=client, model="m", tools=tools, tool_ctx=tool_ctx,
            budget=BudgetConfig(max_turns=2),
        )
        result = loop.run("Do lots of things")

        assert result.stop_reason == "max_turns"
        assert result.turns == 2

    def test_token_budget_stops_loop(self, tools: dict, tool_ctx: ToolContext) -> None:
        """Loop stops when total tokens exceed budget."""
        client = StubClient([
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c1", name="list_dir", arguments={}),),
                usage=UsageStats(input_tokens=60, output_tokens=40),
            ),
            AssistantTurn(
                content="Done",
                usage=UsageStats(input_tokens=60, output_tokens=40),
            ),
        ])
        loop = AgentLoop(
            client=client, model="m", tools=tools, tool_ctx=tool_ctx,
            budget=BudgetConfig(max_total_tokens=100),
        )
        result = loop.run("Use lots of tokens")

        assert result.stop_reason == "budget_exceeded"

    def test_tool_budget_stop_has_user_visible_status(self, tools: dict, tool_ctx: ToolContext) -> None:
        client = StubClient([
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c1", name="list_dir", arguments={}),),
                usage=UsageStats(input_tokens=10, output_tokens=5),
            ),
        ])
        loop = AgentLoop(
            client=client, model="m", tools=tools, tool_ctx=tool_ctx,
            budget=BudgetConfig(max_tool_calls=0),
        )
        result = loop.run("List the files")

        assert result.stop_reason == "budget_exceeded"
        assert "tool-call limit" in result.final_output
        assert "before completing" in result.final_output


# ---------------------------------------------------------------------------
# AgentLoop — error handling
# ---------------------------------------------------------------------------

FAST_RETRY = RetryPolicy(max_retries=3, base_delay=0.0, cap=0.0)

class TestAgentLoopErrors:
    def test_rate_limits_keep_retrying_until_recovery(self, monkeypatch) -> None:
        class RecoverAfterRepeatedLimits:
            def __init__(self):
                self.calls = 0
            def complete(self, *a, **kw):
                self.calls += 1
                if self.calls <= 5:
                    raise RateLimitedError("Rate limited", status_code=429, body="{}")
                return AssistantTurn(content="Recovered", usage=UsageStats())
            def close(self):
                pass

        monkeypatch.setattr("xvie_agent.agent.time.sleep", lambda _seconds: None)
        client = RecoverAfterRepeatedLimits()
        loop = AgentLoop(client=client, model="m", retry_policy=FAST_RETRY)
        result = loop.run("Hello")

        assert result.stop_reason == "completed"
        assert result.final_output == "Recovered"
        assert client.calls == 6

    def test_rate_limit_retries_then_succeeds(self) -> None:
        """Transient error followed by a successful response."""
        class FailOnceThenSucceedClient:
            def __init__(self):
                self.calls: list[str] = []
                self._attempts = 0
            def complete(self, *a, **kw):
                self._attempts += 1
                self.calls.append(f"attempt-{self._attempts}")
                if self._attempts <= 2:
                    raise RateLimitedError("Rate limited", status_code=429)
                return AssistantTurn(content="OK", usage=UsageStats())
            def close(self):
                pass

        client = FailOnceThenSucceedClient()
        loop = AgentLoop(client=client, model="m", retry_policy=FAST_RETRY)
        result = loop.run("Hello")

        assert result.stop_reason == "completed"
        assert result.final_output == "OK"
        assert len(client.calls) == 3

    def test_transient_500_retries_until_recovery(self, monkeypatch) -> None:
        class RecoverAfterServerErrors:
            def __init__(self):
                self.calls = 0
            def complete(self, *a, **kw):
                self.calls += 1
                if self.calls <= 5:
                    raise ProviderError("Server error", status_code=500, body="{}")
                return AssistantTurn(content="Recovered", usage=UsageStats())
            def close(self):
                pass

        monkeypatch.setattr("xvie_agent.agent.time.sleep", lambda _seconds: None)
        client = RecoverAfterServerErrors()
        loop = AgentLoop(client=client, model="m", retry_policy=FAST_RETRY)
        result = loop.run("Hello")

        assert result.stop_reason == "completed"
        assert result.final_output == "Recovered"
        assert client.calls == 6

    def test_nontransient_error_propagates_immediately(self) -> None:
        """Non-transient errors (e.g. 401) are NOT retried."""
        class AuthErrorClient:
            def __init__(self):
                self.calls = 0
            def complete(self, *a, **kw):
                self.calls += 1
                from xvie_agent.providers.base import AuthError
                raise AuthError("Bad key", status_code=401)
            def close(self):
                pass

        client = AuthErrorClient()
        loop = AgentLoop(client=client, model="m", retry_policy=FAST_RETRY)
        result = loop.run("Hello")

        assert result.stop_reason == "model_error"
        assert client.calls == 1  # no retry

    def test_model_error_returns_cleanly(self) -> None:
        class BadRequestClient:
            def complete(self, *a, **kw):
                raise ProviderError("Bad request", status_code=400)
            def close(self):
                pass

        client = BadRequestClient()
        loop = AgentLoop(client=client, model="m", retry_policy=FAST_RETRY)
        result = loop.run("Hello")

        assert result.stop_reason == "model_error"
        assert "model service" in result.final_output.lower()
        assert "try again" in result.final_output.lower()
        assert "bad request" not in result.final_output.lower()

    def test_consecutive_tool_errors_stop_loop(self, tools: dict, tool_ctx: ToolContext) -> None:
        """After max_consecutive_tool_errors, the loop stops.

        Each turn has one failing tool call — the loop should stop after
        max_consecutive_tool_errors consecutive failures.
        """
        client = StubClient([
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c1", name="read_file", arguments={"path": "no1.txt"}),),
                usage=UsageStats(input_tokens=10, output_tokens=5),
            ),
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c2", name="read_file", arguments={"path": "no2.txt"}),),
                usage=UsageStats(input_tokens=10, output_tokens=5),
            ),
            # Won't reach here
            AssistantTurn(content="Done", usage=UsageStats()),
        ])
        loop = AgentLoop(
            client=client, model="m", tools=tools, tool_ctx=tool_ctx,
            max_consecutive_tool_errors=2,
        )
        result = loop.run("Read missing files")

        assert result.stop_reason == "too_many_tool_errors"
        assert result.final_output
        assert "repeated tool errors" in result.final_output
        assert "no2.txt" in result.final_output


# ---------------------------------------------------------------------------
# AgentLoop — no tools configured
# ---------------------------------------------------------------------------

class TestAgentLoopNoTools:
    def test_no_tools_means_no_tool_schemas_sent(self) -> None:
        client = StubClient([
            AssistantTurn(content="OK", usage=UsageStats()),
        ])
        loop = AgentLoop(client=client, model="m", tools={})
        result = loop.run("Hi")

        assert result.stop_reason == "completed"
        # tools=None should be passed to the client
        assert client.calls[0]["tools"] is None
