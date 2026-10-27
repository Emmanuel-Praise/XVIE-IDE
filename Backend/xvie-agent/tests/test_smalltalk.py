"""Regressions: small-talk fast path + streaming error handling."""

from __future__ import annotations

import httpx
import pytest

from xvie_agent.agent import AgentLoop, _is_small_talk
from xvie_agent.providers.base import ProviderError, _raise_for_status
from xvie_agent.tools import ToolContext, build_default_registry
from xvie_agent.types import AssistantTurn, UsageStats

from test_thinking import _StubClient


# ---------------------------------------------------------------------------
# Small talk detection
# ---------------------------------------------------------------------------


class TestSmallTalkDetection:
    def test_greetings_detected(self):
        for msg in (
            "hello", "Hello!", "hey", "HI", "thanks", "thank you so much",
            "how are you?", "ok", "got it", "bye", "good morning",
        ):
            assert _is_small_talk(msg), msg

    def test_tasks_not_detected(self):
        for msg in (
            "Build a website", "fix the bug in main.py", "hello world program",
            "add a hello function", "what is 2+2?", "explain this code",
        ):
            assert not _is_small_talk(msg), msg


# ---------------------------------------------------------------------------
# Fast path behavior in the loop
# ---------------------------------------------------------------------------


class TestSmallTalkFastPath:
    def test_greeting_skips_tools(self, tmp_path):
        """A greeting must be answered with zero tool calls."""
        ctx = ToolContext(workspace_root=tmp_path, allow_write=True)
        client = _StubClient([
            AssistantTurn(
                "Hello! I can build and edit code in your workspace. What would you like?",
                usage=UsageStats(),
            ),
        ])
        events = []
        loop = AgentLoop(client, "test", tools=build_default_registry(ctx), tool_ctx=ctx,
                         event_callback=events.append)
        result = loop.run("hello")

        assert result.stop_reason == "completed"
        assert result.tool_calls == ()
        assert "Hello" in result.final_output
        assert any(e.kind == "smalltalk" for e in events)
        # Tools must NOT be advertised on the small-talk call.
        assert client.calls[0]["tools"] is None


# ---------------------------------------------------------------------------
# Streaming error handling (the chat-session crash)
# ---------------------------------------------------------------------------


class _StreamErrorClient:
    """Streaming client whose server returns an HTTP error status."""

    def __init__(self, status_code: int = 429):
        self.status_code = status_code
        self.calls: list[dict] = []

    def stream(self, model, messages, tools=None, temperature=0.0, max_tokens=None):
        self.calls.append({"model": model})
        request = httpx.Request("POST", "https://example.test/v1/chat/completions")
        response = httpx.Response(
            self.status_code,
            headers={"content-type": "application/json"},
            json={"error": {"message": "boom"}},
            request=request,
        )
        if not response.is_success:
            response.read()
        _raise_for_status(response, "test")
        return iter(())

    def complete(self, model, messages, tools=None, temperature=0.0, max_tokens=None):
        raise AssertionError("complete() should not be called")

    def close(self):
        pass


class TestStreamErrorHandling:
    @pytest.mark.parametrize("status", [429, 500, 503])
    def test_stream_error_raises_provider_error(self, status):
        """Errors on streamed calls must become ProviderError — never leak
        httpx.ResponseNotRead (which crashed whole chat sessions)."""
        client = _StreamErrorClient(status_code=status)
        with pytest.raises(ProviderError):
            list(client.stream("m", [{"role": "user", "content": "hi"}]))
