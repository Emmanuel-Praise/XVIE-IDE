"""Tests for Phase 13 — thinking mode (visible reasoning)."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from xvie_agent.providers.base import (
    ProviderClient,
    ProviderConfig,
    _extract_think_block,
)
from xvie_agent.session import AgentMessage, SessionState
from xvie_agent.types import AssistantTurn, ModelSpec, UsageStats


# ---------------------------------------------------------------------------
# Think block extraction
# ---------------------------------------------------------------------------


class TestExtractThinkBlock:
    def test_extracts_reasoning_and_remainder(self):
        text = "<think>Let me think about this...</think>\nThe answer is 42."
        reasoning, remainder = _extract_think_block(text)
        assert reasoning == "Let me think about this..."
        assert remainder == "The answer is 42."

    def test_no_think_block(self):
        text = "Just a normal response."
        reasoning, remainder = _extract_think_block(text)
        assert reasoning == ""
        assert remainder == "Just a normal response."

    def test_think_block_only(self):
        text = "<think>Internal reasoning here.</think>"
        reasoning, remainder = _extract_think_block(text)
        assert reasoning == "Internal reasoning here."
        assert remainder == ""

    def test_multiline_think_block(self):
        text = "<think>\nLine 1\nLine 2\nLine 3\n</think>\nFinal answer."
        reasoning, remainder = _extract_think_block(text)
        assert "Line 1" in reasoning
        assert "Line 3" in reasoning
        assert remainder == "Final answer."

    def test_think_block_with_leading_whitespace(self):
        text = " <think>Thinking...</think> Answer"
        reasoning, remainder = _extract_think_block(text)
        assert reasoning == "Thinking..."
        assert remainder == "Answer"


# ---------------------------------------------------------------------------
# Provider response parsing — reasoning_content field
# ---------------------------------------------------------------------------


class TestProviderReasoningContent:
    """Test that reasoning_content is parsed from provider responses."""

    def _make_response(self, message: dict) -> dict:
        return {"choices": [{"message": message, "finish_reason": "stop"}], "model": "test"}

    def _get_client(self, response_data: dict) -> ProviderClient:
        """Build a ProviderClient with a MockTransport."""

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=response_data)

        transport = httpx.MockTransport(handler)
        client = httpx.Client(transport=transport)
        return ProviderClient(
            config=ProviderConfig(name="test", api_key="fake", base_url="http://test"),
            client=client,
        )

    def test_explicit_reasoning_content(self):
        """reasoning_content field on message -> AssistantTurn.reasoning."""
        client = self._get_client(self._make_response({
            "content": "The answer is 42.",
            "reasoning_content": "Let me think step by step...",
        }))
        turn = client.complete(model="m", messages=[{"role": "user", "content": "hi"}])
        assert turn.reasoning == "Let me think step by step..."
        assert turn.content == "The answer is 42."

    def test_explicit_reasoning_field(self):
        """'reasoning' field (alternative spelling) -> AssistantTurn.reasoning."""
        client = self._get_client(self._make_response({
            "content": "42",
            "reasoning": "Deep reasoning here.",
        }))
        turn = client.complete(model="m", messages=[{"role": "user", "content": "hi"}])
        assert turn.reasoning == "Deep reasoning here."

    def test_think_block_in_content(self):
        """<think> block in content -> split into reasoning + content."""
        client = self._get_client(self._make_response({
            "content": "<think>\nLet me think.\n</think>\n\nThe answer is yes.",
        }))
        turn = client.complete(model="m", messages=[{"role": "user", "content": "hi"}])
        assert turn.reasoning == "Let me think."
        assert turn.content == "The answer is yes."
        assert "<think>" not in turn.content

    def test_no_reasoning(self):
        """Normal response without reasoning -> reasoning is None."""
        client = self._get_client(self._make_response({
            "content": "Hello!",
        }))
        turn = client.complete(model="m", messages=[{"role": "user", "content": "hi"}])
        assert turn.reasoning is None
        assert turn.content == "Hello!"


# ---------------------------------------------------------------------------
# ModelSpec.supports_reasoning
# ---------------------------------------------------------------------------


class TestModelSpecReasoning:
    def test_supports_reasoning_field(self):
        spec = ModelSpec(
            id="deepseek-r1",
            provider="nvidia",
            supports_reasoning=True,
        )
        assert spec.supports_reasoning is True

    def test_default_is_false(self):
        spec = ModelSpec(id="llama", provider="nvidia")
        assert spec.supports_reasoning is False


# ---------------------------------------------------------------------------
# Session reasoning persistence
# ---------------------------------------------------------------------------


class TestSessionReasoning:
    def test_reasoning_round_trip(self):
        session = SessionState(system_prompt="test")
        session.append_user("Think about this")
        msg = session.append_assistant(
            content="The answer is 42.",
            reasoning="Let me reason through this step by step...",
        )
        assert msg.reasoning == "Let me reason through this step by step..."

        # Serialize and deserialize
        raw = session.to_json()
        restored = SessionState.from_json(raw)

        # Find the assistant message
        assistant_msgs = [m for m in restored.messages if m.role == "assistant"]
        assert len(assistant_msgs) == 1
        assert assistant_msgs[0].reasoning == "Let me reason through this step by step..."
        assert assistant_msgs[0].content == "The answer is 42."

    def test_reasoning_in_transcript(self):
        session = SessionState(system_prompt="test")
        session.append_user("hi")
        session.append_assistant(content="hello", reasoning="thinking...")
        msgs = session.to_openai_messages()
        # Reasoning should NOT appear in OpenAI messages (it's internal)
        assistant_msgs = [m for m in msgs if m["role"] == "assistant"]
        assert len(assistant_msgs) == 1
        assert "reasoning" not in assistant_msgs[0]


# ---------------------------------------------------------------------------
# Redaction on reasoning text
# ---------------------------------------------------------------------------


class TestReasoningRedaction:
    def test_redact_secrets_in_reasoning(self):
        """Secrets in reasoning text should be redacted just like tool output."""
        from xvie_agent.redact import redact_secrets

        reasoning_with_secret = (
            "The file contains OPENAI_API_KEY=sk-abc123def456ghi789jkl012mno345pqr678. "
            "I should not reveal this."
        )
        redacted = redact_secrets(reasoning_with_secret)
        assert "sk-abc123" not in redacted
        assert "[REDACTED]" in redacted

    def test_normal_reasoning_not_redacted(self):
        from xvie_agent.redact import redact_secrets

        reasoning = "Let me analyze the code structure and find the bug."
        assert redact_secrets(reasoning) == reasoning


# ---------------------------------------------------------------------------
# Prompt-based "Thought:" line extraction (agent loop, works with any model)
# ---------------------------------------------------------------------------

from xvie_agent.agent import AgentLoop, _extract_thought
from xvie_agent.tools import ToolContext


class TestExtractThoughtLine:
    def test_extracts_leading_thought(self):
        thought, rest = _extract_thought("Thought: Listing files first.\n\nAll done.")
        assert thought == "Listing files first."
        assert rest == "All done."

    def test_bold_thought_marker(self):
        thought, rest = _extract_thought("**Thought:** Reading the config.")
        assert thought == "Reading the config."

    def test_case_insensitive(self):
        thought, _ = _extract_thought("thought: checking the schema")
        assert thought == "checking the schema"

    def test_no_thought_line_unchanged(self):
        thought, rest = _extract_thought("Just a normal answer.")
        assert thought == ""
        assert rest == "Just a normal answer."

    def test_empty_content(self):
        assert _extract_thought("") == ("", "")


class _StubClient:
    """Minimal fake ProviderClient for AgentLoop tests."""

    def __init__(self, responses):
        self._responses = list(responses)
        self._idx = 0
        self.calls: list[dict] = []

    def complete(self, model, messages, tools=None, temperature=0.0, max_tokens=None):
        self.calls.append({"model": model, "messages": messages, "tools": tools})
        if self._idx >= len(self._responses):
            raise RuntimeError("StubClient: exhausted responses")
        resp = self._responses[self._idx]
        self._idx += 1
        return resp

    def close(self):
        pass


class TestAgentLoopThoughtEvents:
    def test_thought_line_emitted_and_stripped(self, tmp_path):
        ctx = ToolContext(workspace_root=tmp_path)
        client = _StubClient([
            AssistantTurn(
                content="Thought: I will answer from what I know.\nThe file says hi.",
                usage=UsageStats(),
            ),
        ])
        events = []
        loop = AgentLoop(client, "test", tool_ctx=ctx, event_callback=events.append)
        result = loop.run("What is in notes.txt?")

        thoughts = [e for e in events if e.kind == "thought"]
        assert len(thoughts) == 1
        assert "answer from what I know" in thoughts[0].message
        assert "duration_ms" in thoughts[0].data
        # The thought line must not leak into the final answer.
        assert "Thought:" not in result.final_output
        assert result.final_output == "The file says hi."

    def test_native_reasoning_is_not_exposed_as_thought_event(self, tmp_path):
        ctx = ToolContext(workspace_root=tmp_path)
        client = _StubClient([
            AssistantTurn(content="Answer.", reasoning="Step by step reasoning.", usage=UsageStats()),
        ])
        events = []
        loop = AgentLoop(client, "test", tool_ctx=ctx, event_callback=events.append)
        loop.run("Summarize the workspace")

        thoughts = [e for e in events if e.kind == "thought"]
        assert thoughts == []

    def test_thought_only_output_is_not_exposed_as_answer(self, tmp_path):
        """A model that emits only a "Thought:" line and then stops must not
        produce an empty "No response" turn — the thought becomes the answer."""
        ctx = ToolContext(workspace_root=tmp_path)
        client = _StubClient([
            AssistantTurn(content="Thought: The user said hello. I should reply politely.", usage=UsageStats()),
        ])
        events = []
        loop = AgentLoop(client, "test", tool_ctx=ctx, event_callback=events.append)
        result = loop.run("hello")

        assert result.final_output.strip()
        assert "reply politely" not in result.final_output
        assert result.final_output == "Hi! What would you like to work on?"
        assert result.stop_reason == "completed"

    def test_thought_only_output_after_truncation_stays_private(self, tmp_path):
        """Regression: truncated final turn with only a stripped thought must
        still produce non-empty output, even after the auto-continue path."""
        ctx = ToolContext(workspace_root=tmp_path)
        # Auto-continue fires up to 3 times on truncated turns; each produces
        # only a "Thought:" line, and the last one has nothing else at all.
        client = _StubClient([
            AssistantTurn(
                content="Thought: First I need to understand the problem.",
                usage=UsageStats(),
                truncated=True,
            ),
            AssistantTurn(
                content="Thought: Still thinking through the solution.",
                usage=UsageStats(),
                truncated=True,
            ),
            AssistantTurn(
                content="Thought: Considering the options one more time.",
                usage=UsageStats(),
                truncated=True,
            ),
            AssistantTurn(
                content="Thought: Let me just answer rather than keep thinking.",
                usage=UsageStats(),
            ),
        ])
        events = []
        loop = AgentLoop(client, "test", tool_ctx=ctx, event_callback=events.append)
        result = loop.run("Explain the problem")

        assert result.final_output.strip()
        assert "just answer rather than keep thinking" not in result.final_output
        assert "couldn't produce a clear answer" in result.final_output


# ---------------------------------------------------------------------------
# The think tool — visible reasoning via tool arguments
# ---------------------------------------------------------------------------

from xvie_agent.tools import ToolContext, build_default_registry
from xvie_agent.types import ToolCall


class TestThinkTool:
    def test_registered(self, tmp_path):
        ctx = ToolContext(workspace_root=tmp_path)
        names = set(build_default_registry(ctx))
        assert "think" in names

    def test_handler_ok_and_missing_arg(self, tmp_path):
        from xvie_agent.tools import ToolContext, _think

        ctx = ToolContext(workspace_root=tmp_path)
        out = _think({"thought": "Reading config first."}, ctx)
        assert out.ok is True
        assert "Thought noted" in out.content

        missing = _think({}, ctx)
        assert missing.ok is False
        assert "thought" in missing.content.lower()

    def test_loop_emits_thought_event_for_think_call(self, tmp_path):
        ctx = ToolContext(workspace_root=tmp_path)
        client = _StubClient([
            AssistantTurn(
                content="",
                tool_calls=[ToolCall(id="t1", name="think", arguments={"thought": "Listing files before planning."})],
                usage=UsageStats(),
            ),
            AssistantTurn(content="Done.", usage=UsageStats()),
        ])
        events = []
        loop = AgentLoop(client, "test", tool_ctx=ctx, event_callback=events.append)
        result = loop.run("Create the config file")

        thoughts = [e for e in events if e.kind == "thought"]
        assert len(thoughts) == 1
        assert thoughts[0].message == "Listing files before planning."
        assert result.final_output == "Done."

    def test_think_advertised_even_when_writes_denied(self, tmp_path):
        """think must stay available even in read-only mode."""
        from xvie_agent.agent import _tools_to_openai_format

        ctx = ToolContext(workspace_root=tmp_path, allow_write=False)
        advertised = {t["function"]["name"] for t in _tools_to_openai_format(build_default_registry(ctx), tool_ctx=ctx)}
        assert "think" in advertised
        assert "write_file" not in advertised


# ---------------------------------------------------------------------------
# JSON-as-text tool calls: parsing + garbage-answer refusal
# ---------------------------------------------------------------------------

from xvie_agent.agent import _looks_like_json_tool_call, _parse_text_tool_calls
from xvie_agent.types import ToolCall as _TC


class TestJsonTextToolCalls:
    def test_parses_wellformed_json_tool_call(self):
        content = '{"name": "write_file", "parameters": {"path": "a.html", "content": "<p>hi</p>"}}'
        calls = _parse_text_tool_calls(content, {"write_file"})
        assert len(calls) == 1
        assert calls[0].name == "write_file"
        assert calls[0].arguments["path"] == "a.html"

    def test_parses_nested_braces_in_content(self):
        content = ('{"name": "write_file", "parameters": {"path": "x.html", '
                   '"content": "<style>body{margin:0}</style>"}}')
        calls = _parse_text_tool_calls(content, {"write_file"})
        assert len(calls) == 1
        assert "margin:0" in calls[0].arguments["content"]

    def test_malformed_json_not_parsed(self):
        content = '{"name": "write_file", "parameters": {"path": "a", "content": "<div class=", "x">"}}'
        assert _parse_text_tool_calls(content, {"write_file"}) == []

    def test_unknown_tool_ignored(self):
        content = '{"name": "nope", "parameters": {}}'
        assert _parse_text_tool_calls(content, {"write_file"}) == []

    def test_looks_like_json_detects_garbage(self):
        garbage = '{"name": "write_file", "parameters": {"path": "a", "content": "<div class=", "x">}}'
        assert _looks_like_json_tool_call(garbage, {"write_file"}) is True
        assert _looks_like_json_tool_call("A normal answer.", {"write_file"}) is False

    def test_wellformed_json_text_call_executes(self, tmp_path):
        """A well-formed JSON tool call in text is parsed and executed."""
        # Pre-create a completed plan so the plan gate and plan guard don't interfere
        plans_dir = tmp_path / ".xvie" / "plans"
        plans_dir.mkdir(parents=True, exist_ok=True)
        (plans_dir / "plan.md").write_text("# Plan\n\n## Steps\n\n- [x] **Task** - Do something\n", encoding='utf-8')
        client = _StubClient([
            AssistantTurn(
                content='{"name": "write_file", "parameters": {"path": "ok.txt", "content": "fine"}}',
                usage=UsageStats(),
            ),
            AssistantTurn("Wrote the file.", usage=UsageStats()),
        ])
        events = []
        ctx = ToolContext(workspace_root=tmp_path, allow_write=True)
        from xvie_agent.tools import build_default_registry
        loop = AgentLoop(client, "test", tools=build_default_registry(ctx), tool_ctx=ctx,
                         event_callback=events.append)
        result = loop.run("create ok.txt")

        assert (tmp_path / "ok.txt").exists()
        assert result.final_output == "Wrote the file."

    def test_loop_refuses_json_garbage_answer(self, tmp_path):
        """Malformed raw-JSON tool call as final answer must trigger a retry nudge."""
        # Pre-create a completed plan so the plan gate and plan guard don't interfere
        plans_dir = tmp_path / ".xvie" / "plans"
        plans_dir.mkdir(parents=True, exist_ok=True)
        (plans_dir / "plan.md").write_text("# Plan\n\n## Steps\n\n- [x] **Task** - Do something\n", encoding='utf-8')
        garbage = '{"name": "write_file", "parameters": {"path": "ok.txt", "content": "<div class=", "x">}}'
        client = _StubClient([
            AssistantTurn(content=garbage, usage=UsageStats()),
            AssistantTurn("", (ToolCall(id="t9", name="write_file",
                                       arguments={"path": "ok.txt", "content": "fine"}),), UsageStats()),
            AssistantTurn("Wrote the file.", usage=UsageStats()),
        ])
        events = []
        ctx = ToolContext(workspace_root=tmp_path, allow_write=True)
        from xvie_agent.tools import build_default_registry
        loop = AgentLoop(client, "test", tools=build_default_registry(ctx), tool_ctx=ctx,
                         event_callback=events.append)
        result = loop.run("create ok.txt")

        retries = [e for e in events if e.kind == "retrying" and "raw JSON" in e.message]
        assert len(retries) == 1
        assert result.final_output == "Wrote the file."
        assert (tmp_path / "ok.txt").exists()
