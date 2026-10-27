"""Tests for xvie_agent.provider_client — all mocked, no network calls."""

from __future__ import annotations

import json

import httpx
import pytest

from xvie_agent.providers.base import (
    AuthError,
    ModelDoesNotSupportToolsError,
    OutOfCreditsError,
    ProviderClient,
    ProviderConfig,
    ProviderError,
    RateLimitedError,
)
from xvie_agent.types import AssistantTurn, StreamEvent, ToolCall, UsageStats


# ---------------------------------------------------------------------------
# Helpers — mock transport factories
# ---------------------------------------------------------------------------

BASE_URL = "https://integrate.api.nvidia.com/v1"


def _make_client(handler, provider_name: str = "nvidia") -> ProviderClient:
    """Create a ProviderClient backed by a custom httpx.MockTransport."""
    config = ProviderConfig(name=provider_name, api_key="nvapi-test-key", base_url=BASE_URL)
    transport = httpx.MockTransport(handler)
    http_client = httpx.Client(
        transport=transport,
        base_url=BASE_URL,
        headers={
            "Authorization": "Bearer nvapi-test-key",
            "Content-Type": "application/json",
        },
    )
    return ProviderClient(config=config, client=http_client)


# A successful completion response
SUCCESS_RESPONSE = {
    "id": "chatcmpl-test-123",
    "model": "meta/llama-3.1-8b-instruct",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "Hello! I'm ready to help.",
            },
            "finish_reason": "stop",
        }
    ],
    "usage": {
        "prompt_tokens": 12,
        "completion_tokens": 8,
        "total_tokens": 20,
    },
}


def _success_handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json=SUCCESS_RESPONSE)


def _rate_limit_handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        429,
        json={"error": {"message": "Rate limit exceeded", "code": "rate_limit_exceeded"}},
    )


def _out_of_credits_handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        402,
        json={"error": {"message": "Insufficient credits", "code": "insufficient_credits"}},
    )


def _auth_error_handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        401,
        json={"error": {"message": "Invalid API key", "code": "invalid_api_key"}},
    )


def _server_error_handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(500, text="Internal Server Error")


def _tool_calls_response_handler(request: httpx.Request) -> httpx.Response:
    resp = {
        "id": "chatcmpl-tools-1",
        "model": "meta/llama-3.1-8b-instruct",
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call_abc123",
                            "type": "function",
                            "function": {
                                "name": "read_file",
                                "arguments": json.dumps({"path": "main.py"}),
                            },
                        }
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ],
        "usage": {
            "prompt_tokens": 50,
            "completion_tokens": 15,
            "total_tokens": 65,
        },
    }
    return httpx.Response(200, json=resp)


def _no_tools_model_handler(request: httpx.Request) -> httpx.Response:
    """Simulates a model that returns an error when tools are passed."""
    resp = {
        "error": {
            "message": "This model does not support function calling",
            "code": "model_does_not_support_tools",
        },
        "choices": [],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }
    return httpx.Response(200, json=resp)


def _missing_content_field_handler(request: httpx.Request) -> httpx.Response:
    """NVIDIA NIM quirk: a 400 whose body mentions the missing `content`
    field — raised when tools are sent to a model that can't take them."""
    return httpx.Response(
        400,
        json={
            "error": {
                "message": "missing field `content`",
                "type": "Bad Request",
                "code": 400,
            }
        },
    )


# ---------------------------------------------------------------------------
# Tests — non-streaming complete()
# ---------------------------------------------------------------------------


class TestComplete:
    def test_successful_call(self) -> None:
        client = _make_client(_success_handler)
        turn = client.complete(
            model="meta/llama-3.1-8b-instruct",
            messages=[{"role": "user", "content": "Say hi"}],
        )
        assert isinstance(turn, AssistantTurn)
        assert turn.content == "Hello! I'm ready to help."
        assert turn.tool_calls == ()
        assert turn.usage.input_tokens == 12
        assert turn.usage.output_tokens == 8
        assert turn.usage.total_tokens == 20
        assert turn.model == "meta/llama-3.1-8b-instruct"
        client.close()

    def test_tool_calls_parsed(self) -> None:
        client = _make_client(_tool_calls_response_handler)
        turn = client.complete(
            model="meta/llama-3.1-8b-instruct",
            messages=[{"role": "user", "content": "Read main.py"}],
        )
        assert len(turn.tool_calls) == 1
        tc = turn.tool_calls[0]
        assert tc.id == "call_abc123"
        assert tc.name == "read_file"
        assert tc.arguments == {"path": "main.py"}
        client.close()

    def test_rate_limit_raises(self) -> None:
        client = _make_client(_rate_limit_handler)
        with pytest.raises(RateLimitedError) as exc_info:
            client.complete(
                model="meta/llama-3.1-8b-instruct",
                messages=[{"role": "user", "content": "Hi"}],
            )
        assert exc_info.value.status_code == 429
        client.close()

    def test_out_of_credits_raises(self) -> None:
        client = _make_client(_out_of_credits_handler)
        with pytest.raises(OutOfCreditsError) as exc_info:
            client.complete(
                model="meta/llama-3.1-8b-instruct",
                messages=[{"role": "user", "content": "Hi"}],
            )
        assert exc_info.value.status_code == 402
        client.close()

    def test_auth_error_raises(self) -> None:
        client = _make_client(_auth_error_handler)
        with pytest.raises(AuthError) as exc_info:
            client.complete(
                model="meta/llama-3.1-8b-instruct",
                messages=[{"role": "user", "content": "Hi"}],
            )
        assert exc_info.value.status_code in (401, 403)
        client.close()

    def test_server_error_raises_provider_error(self) -> None:
        client = _make_client(_server_error_handler)
        with pytest.raises(ProviderError) as exc_info:
            client.complete(
                model="meta/llama-3.1-8b-instruct",
                messages=[{"role": "user", "content": "Hi"}],
            )
        assert exc_info.value.status_code == 500
        client.close()

    def test_model_without_tools_support(self) -> None:
        client = _make_client(_no_tools_model_handler)
        with pytest.raises(ModelDoesNotSupportToolsError) as exc_info:
            client.complete(
                model="some-unsupported-model",
                messages=[{"role": "user", "content": "Do stuff"}],
                tools=[{"type": "function", "function": {"name": "ls"}}],
            )
        assert "some-unsupported-model" in str(exc_info.value)
        client.close()

    def test_missing_content_field_400_is_tool_support_error(self) -> None:
        """A 400 mentioning the missing `content` field must be classified as
        ModelDoesNotSupportToolsError so the router retries without tools."""
        client = _make_client(_missing_content_field_handler)
        with pytest.raises(ModelDoesNotSupportToolsError) as exc_info:
            client.complete(
                model="some-unsupported-model",
                messages=[{"role": "user", "content": "Do stuff"}],
                tools=[{"type": "function", "function": {"name": "ls"}}],
            )
        assert exc_info.value.status_code == 400
        assert "missing field" in str(exc_info.value)
        client.close()

    def test_provider_name_in_error_message(self) -> None:
        """Verify provider name appears in error messages for debugging."""
        client = _make_client(_server_error_handler, provider_name="my-provider")
        with pytest.raises(ProviderError) as exc_info:
            client.complete(
                model="m",
                messages=[{"role": "user", "content": "Hi"}],
            )
        assert "my-provider" in str(exc_info.value)
        client.close()

    def test_headers_set_correctly(self) -> None:
        """Verify the client sends the required headers."""
        captured_headers: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured_headers.update(dict(request.headers))
            return httpx.Response(200, json=SUCCESS_RESPONSE)

        client = _make_client(handler)
        client.complete(
            model="meta/llama-3.1-8b-instruct",
            messages=[{"role": "user", "content": "Hi"}],
        )
        assert "authorization" in captured_headers
        assert captured_headers["authorization"] == "Bearer nvapi-test-key"
        client.close()

    def test_provider_name_property(self) -> None:
        client = _make_client(_success_handler, provider_name="test-prov")
        assert client.provider_name == "test-prov"
        client.close()


# ---------------------------------------------------------------------------
# Tests — streaming stream()
# ---------------------------------------------------------------------------


class TestStream:
    def _make_sse_response(self, lines: list[str]) -> httpx.Response:
        """Build a streaming httpx.Response from raw SSE lines."""
        body = "\n".join(lines)
        return httpx.Response(
            200,
            stream=httpx.ByteStream(body.encode()),
            headers={"content-type": "text/event-stream"},
        )

    def test_stream_text_deltas(self) -> None:
        sse_lines = [
            'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
            'data: {"id":"c1","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}',
            'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}',
            "data: [DONE]",
        ]

        def handler(request: httpx.Request) -> httpx.Response:
            return self._make_sse_response(sse_lines)

        client = _make_client(handler)
        events = list(
            client.stream(
                model="m",
                messages=[{"role": "user", "content": "Hi"}],
            )
        )

        text_parts = [e.text_delta for e in events if e.text_delta]
        assert "".join(text_parts) == "Hello world"

        done_events = [e for e in events if e.done]
        assert len(done_events) == 1
        assert done_events[0].usage is not None
        assert done_events[0].usage.input_tokens == 5
        assert done_events[0].usage.output_tokens == 3
        client.close()

    def test_unexpected_stream_eof_is_incomplete(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return self._make_sse_response([
                'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}',
            ])

        client = _make_client(handler)
        events = list(client.stream(model="m", messages=[{"role": "user", "content": "Hi"}]))
        done = [event for event in events if event.done]
        assert len(done) == 1
        assert done[0].incomplete is True
        assert done[0].truncated is False
        client.close()

    def test_unexpected_eof_preserves_partial_tool_call_for_safe_recovery(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            chunk = {
                "id": "c1",
                "choices": [{"index": 0, "delta": {"tool_calls": [{
                    "index": 0,
                    "id": "call_x",
                    "function": {"name": "write_file", "arguments": '{"path":"note.txt","content":"partial'},
                }]}, "finish_reason": None}],
            }
            return self._make_sse_response(["data: " + json.dumps(chunk)])

        client = _make_client(handler)
        events = list(client.stream(model="m", messages=[{"role": "user", "content": "save"}]))
        tool_calls = [event.tool_call for event in events if event.tool_call]
        done = [event for event in events if event.done]
        assert len(tool_calls) == 1
        assert tool_calls[0].name == "write_file"
        assert "_raw" in tool_calls[0].arguments
        assert done[0].incomplete is True
        client.close()

    def test_done_sentinel_without_finish_reason_is_complete(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return self._make_sse_response([
                'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"complete"},"finish_reason":null}]}',
                "data: [DONE]",
            ])

        client = _make_client(handler)
        events = list(client.stream(model="m", messages=[{"role": "user", "content": "Hi"}]))
        done = [event for event in events if event.done]
        assert len(done) == 1
        assert done[0].incomplete is False
        client.close()

    def test_stream_tool_call(self) -> None:
        sse_lines = [
            'data: {"id":"c1","choices":[{"index":0,"delta":{"content":null,"tool_calls":[{"index":0,"id":"call_x","type":"function","function":{"name":"ls","arguments":""}}]},"finish_reason":null}]}',
            'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\".\\"}"}}]},"finish_reason":null}]}',
            'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
            "data: [DONE]",
        ]

        def handler(request: httpx.Request) -> httpx.Response:
            return self._make_sse_response(sse_lines)

        client = _make_client(handler)
        events = list(
            client.stream(
                model="m",
                messages=[{"role": "user", "content": "ls"}],
            )
        )

        tool_events = [e for e in events if e.tool_call is not None]
        assert len(tool_events) == 1
        tc = tool_events[0].tool_call
        assert tc.id == "call_x"
        assert tc.name == "ls"
        assert tc.arguments == {"path": "."}
        client.close()

    def test_stream_rate_limit(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(429, json={"error": "rate limited"})

        client = _make_client(handler)
        with pytest.raises(RateLimitedError):
            list(
                client.stream(
                    model="m",
                    messages=[{"role": "user", "content": "Hi"}],
                )
            )
        client.close()
