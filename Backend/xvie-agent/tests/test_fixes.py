"""Regression tests for the agentic-quality fixes.

Covers:
- IndexError crash on SSE chunks with empty ``choices`` lists
- Truncation detection (finish_reason == "length")
- Fuzzy edit_file matching and closest-snippet error hints
- Prompt-based design guidance detection
- Context-window history trimming
"""

from __future__ import annotations

import httpx
import pytest

from xvie_agent.agent import _trim_to_fit, _split_exchange_blocks
from xvie_agent.design_guidance import DESIGN_PRINCIPLES, prompt_needs_design_guidance
from xvie_agent.providers.base import ProviderClient, ProviderConfig
from xvie_agent.tools import ToolContext, _edit_file


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

BASE_URL = "https://integrate.api.nvidia.com/v1"


def _make_client(handler) -> ProviderClient:
    config = ProviderConfig(name="nvidia", api_key="nvapi-test-key", base_url=BASE_URL)
    transport = httpx.MockTransport(handler)
    http_client = httpx.Client(
        transport=transport,
        base_url=BASE_URL,
        headers={"Authorization": "Bearer nvapi-test-key"},
    )
    return ProviderClient(config=config, client=http_client)


def _sse(lines: list[str]) -> httpx.Response:
    body = "\n".join(lines)
    return httpx.Response(
        200,
        stream=httpx.ByteStream(body.encode()),
        headers={"content-type": "text/event-stream"},
    )


# ---------------------------------------------------------------------------
# Streaming robustness — the IndexError crash
# ---------------------------------------------------------------------------


class TestEmptyChoicesChunk:
    def test_empty_choices_chunk_does_not_crash(self) -> None:
        """A usage-only chunk with ``choices: []`` must be skipped, not crash."""
        sse_lines = [
            'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}',
            'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}',
            'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
            "data: [DONE]",
        ]

        def handler(request: httpx.Request) -> httpx.Response:
            return _sse(sse_lines)

        client = _make_client(handler)
        events = list(client.stream(model="m", messages=[{"role": "user", "content": "Hi"}]))
        text = "".join(e.text_delta for e in events if e.text_delta)
        assert text == "Hi"
        done = [e for e in events if e.done]
        assert len(done) == 1
        # Usage from the empty-choices chunk is still harvested.
        assert done[0].usage.input_tokens == 7
        client.close()

    def test_missing_choices_key_does_not_crash(self) -> None:
        sse_lines = [
            'data: {"id":"c1"}',
            'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}',
            "data: [DONE]",
        ]

        def handler(request: httpx.Request) -> httpx.Response:
            return _sse(sse_lines)

        client = _make_client(handler)
        events = list(client.stream(model="m", messages=[{"role": "user", "content": "x"}]))
        assert "".join(e.text_delta for e in events if e.text_delta) == "ok"
        client.close()

    def test_malformed_chunk_does_not_crash(self) -> None:
        sse_lines = [
            "data: not-json-at-all",
            'data: ["also", "not", "an", "object"]',
            'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"fine"},"finish_reason":"stop"}]}',
            "data: [DONE]",
        ]

        def handler(request: httpx.Request) -> httpx.Response:
            return _sse(sse_lines)

        client = _make_client(handler)
        events = list(client.stream(model="m", messages=[{"role": "user", "content": "x"}]))
        assert "".join(e.text_delta for e in events if e.text_delta) == "fine"
        client.close()


# ---------------------------------------------------------------------------
# Truncation detection
# ---------------------------------------------------------------------------


class TestTruncationDetection:
    def test_stream_length_finish_reason_sets_truncated(self) -> None:
        sse_lines = [
            'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"partial outp"},"finish_reason":null}]}',
            'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"length"}]}',
            "data: [DONE]",
        ]

        def handler(request: httpx.Request) -> httpx.Response:
            return _sse(sse_lines)

        client = _make_client(handler)
        events = list(client.stream(model="m", messages=[{"role": "user", "content": "go"}]))
        done = [e for e in events if e.done]
        assert done and done[0].truncated is True
        client.close()

    def test_complete_length_finish_reason_sets_truncated(self) -> None:
        payload = {
            "model": "m",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "cut off mid-sente"},
                    "finish_reason": "length",
                }
            ],
            "usage": {"prompt_tokens": 5, "completion_tokens": 900, "total_tokens": 905},
        }

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=payload)

        client = _make_client(handler)
        turn = client.complete(model="m", messages=[{"role": "user", "content": "go"}])
        assert turn.truncated is True
        client.close()

    def test_normal_stop_not_truncated(self) -> None:
        payload = {
            "model": "m",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "done"},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
        }

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=payload)

        client = _make_client(handler)
        turn = client.complete(model="m", messages=[{"role": "user", "content": "go"}])
        assert turn.truncated is False
        client.close()


# ---------------------------------------------------------------------------
# edit_file fuzzy matching + hints
# ---------------------------------------------------------------------------


class TestEditFileFuzzy:
    def _ctx(self, tmp_path) -> ToolContext:
        return ToolContext(workspace_root=tmp_path, allow_write=True, allow_shell=False)

    def test_fuzzy_match_ignores_indentation(self, tmp_path) -> None:
        f = tmp_path / "app.py"
        f.write_text("def main():\n    print('hi')\n    return 0\n")
        result = _edit_file(
            {
                "path": "app.py",
                # No indentation — exact match fails, fuzzy must succeed.
                "old_str": "print('hi')\nreturn 0",
                "new_str": "print('bye')\nreturn 1",
            },
            self._ctx(tmp_path),
        )
        assert result.ok is True
        assert "ignoring indentation" in result.content
        assert "print('bye')" in f.read_text()
        assert "return 1" in f.read_text()

    def test_no_match_error_includes_closest_snippet(self, tmp_path) -> None:
        f = tmp_path / "app.py"
        f.write_text("def main():\n    print('hello there')\n    return 0\n")
        result = _edit_file(
            {
                "path": "app.py",
                "old_str": "print('goodbye')\nreturn 0",
                "new_str": "x",
            },
            self._ctx(tmp_path),
        )
        assert result.ok is False
        assert result.error_kind == "no_match"
        assert "Closest matching section" in result.content
        assert "hello there" in result.content

    def test_exact_match_still_preferred(self, tmp_path) -> None:
        f = tmp_path / "app.py"
        f.write_text("a = 1\nb = 2\n")
        result = _edit_file({"path": "app.py", "old_str": "b = 2", "new_str": "b = 3"}, self._ctx(tmp_path))
        assert result.ok is True
        assert "ignoring indentation" not in result.content
        assert f.read_text() == "a = 1\nb = 3\n"

    def test_multiple_matches_still_rejected(self, tmp_path) -> None:
        f = tmp_path / "app.py"
        f.write_text("x = 1\nx = 1\n")
        result = _edit_file({"path": "app.py", "old_str": "x = 1", "new_str": "y = 2"}, self._ctx(tmp_path))
        assert result.ok is False
        assert result.error_kind == "multiple_matches"


# ---------------------------------------------------------------------------
# Design guidance detection
# ---------------------------------------------------------------------------


class TestPromptDesignDetection:
    def test_ui_words_detected(self):
        for prompt in (
            "create a landing page for my site",
            "build a dashboard with charts",
            "style this navbar with css",
            "make a responsive form",
        ):
            assert prompt_needs_design_guidance(prompt), prompt

    def test_non_ui_prompts_rejected(self):
        for prompt in (
            "fix the parser bug in utils.py",
            "refactor the router class",
            "what does this function do?",
        ):
            assert not prompt_needs_design_guidance(prompt), prompt

    def test_principles_available_for_injection(self):
        assert "check_contrast" in DESIGN_PRINCIPLES


# ---------------------------------------------------------------------------
# Context-window trimming
# ---------------------------------------------------------------------------


class TestTrimToFit:
    def _msg(self, role: str, content: str, **extra) -> dict:
        m = {"role": role, "content": content}
        m.update(extra)
        return m

    def test_split_blocks_keeps_tool_pairs_together(self):
        msgs = [
            self._msg("assistant", "", tool_calls=[{"id": "t1", "type": "function", "function": {"name": "f", "arguments": "{}"}}]),
            self._msg("tool", "result", tool_call_id="t1"),
            self._msg("assistant", "done"),
        ]
        blocks = _split_exchange_blocks(msgs)
        assert blocks == [(0, 2), (2, 3)]

    def test_trim_drops_old_blocks_keeps_recent_user(self):
        # calculate_budget reserves 2000 tokens for output, so the window must
        # be comfortably larger than that for any trimming state to fit.
        window = 6000
        msgs = [{"role": "system", "content": "sys"}]
        for i in range(10):
            msgs.append(self._msg("user", f"question {i} " + "x" * 3000))
            msgs.append(self._msg("assistant", f"answer {i} " + "y" * 3000))
        trimmed = _trim_to_fit(msgs, window)
        assert trimmed is not None
        assert len(trimmed) < len(msgs)
        assert trimmed[0]["role"] == "system"
        # The most recent user message survives.
        last_user_idx = max(i for i, m in enumerate(trimmed) if m.get("role") == "user")
        assert "question 9" in trimmed[last_user_idx]["content"]

    def test_trim_returns_none_when_minimum_exceeds_window(self):
        huge = "z" * 5000
        msgs = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": huge},
        ]
        assert _trim_to_fit(msgs, 100) is None

    def test_trim_preserves_tool_pair_integrity(self):
        window = 500
        msgs = [
            {"role": "system", "content": "sys"},
            self._msg("user", "q1 " + "a" * 300),
            self._msg("assistant", "", tool_calls=[{"id": "t1", "type": "function", "function": {"name": "read_file", "arguments": "{}"}}]),
            self._msg("tool", "file contents " * 50, tool_call_id="t1"),
            self._msg("assistant", "answer " + "b" * 100),
            self._msg("user", "q2 follow-up"),
        ]
        trimmed = _trim_to_fit(msgs, window)
        if trimmed is None:
            return
        # Any assistant tool_calls message must be followed by its tool result.
        for i, m in enumerate(trimmed):
            if m.get("role") == "assistant" and m.get("tool_calls"):
                assert i + 1 < len(trimmed) and trimmed[i + 1].get("role") == "tool"
