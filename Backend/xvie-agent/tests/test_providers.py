"""Tests for xvie_agent.providers — all mocked, no network calls."""

from __future__ import annotations

import json
import os
from pathlib import Path

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
from xvie_agent.providers.registry import get_provider, load_providers_from_env
from xvie_agent.types import AssistantTurn, StreamEvent, ToolCall, UsageStats


# ---------------------------------------------------------------------------
# Helpers — mock transport factories
# ---------------------------------------------------------------------------

BASE_URL = "https://integrate.api.nvidia.com/v1"


def _make_client(handler, name: str = "nvidia") -> ProviderClient:
    """Create a ProviderClient backed by a custom httpx.MockTransport."""
    config = ProviderConfig(name=name, api_key="nvapi-test-key", base_url=BASE_URL)
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
        json={"error": {"message": "Rate limit exceeded"}},
        headers={"retry-after": "30"},
    )


def _rate_limit_no_retry_after_handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        429,
        json={"error": {"message": "Rate limit exceeded"}},
    )


def _out_of_credits_handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        402,
        json={"error": {"message": "Insufficient credits"}},
    )


def _auth_error_handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        401,
        json={"error": {"message": "Invalid API key"}},
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


def _function_call_response_handler(request: httpx.Request) -> httpx.Response:
    """Simulates a model using the legacy function_call format."""
    resp = {
        "id": "chatcmpl-fc-1",
        "model": "some-legacy-model",
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": None,
                    "function_call": {
                        "name": "read_file",
                        "arguments": json.dumps({"path": "old.py"}),
                    },
                },
                "finish_reason": "function_call",
            }
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
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

    def test_max_tokens_sent(self) -> None:
        """Verify max_tokens is included in the payload when provided."""
        captured_payload: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured_payload.update(json.loads(request.content))
            return httpx.Response(200, json=SUCCESS_RESPONSE)

        client = _make_client(handler)
        client.complete(
            model="m",
            messages=[{"role": "user", "content": "Hi"}],
            max_tokens=512,
        )
        assert captured_payload.get("max_tokens") == 512
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

    def test_legacy_function_call(self) -> None:
        """Verify legacy function_call format is parsed into a ToolCall."""
        client = _make_client(_function_call_response_handler)
        turn = client.complete(
            model="some-legacy-model",
            messages=[{"role": "user", "content": "Read old.py"}],
        )
        assert len(turn.tool_calls) == 1
        tc = turn.tool_calls[0]
        assert tc.name == "read_file"
        assert tc.arguments == {"path": "old.py"}
        client.close()

    def test_rate_limit_raises_with_retry_after(self) -> None:
        client = _make_client(_rate_limit_handler)
        with pytest.raises(RateLimitedError) as exc_info:
            client.complete(
                model="m",
                messages=[{"role": "user", "content": "Hi"}],
            )
        assert exc_info.value.status_code == 429
        assert exc_info.value.retry_after == 30.0
        client.close()

    def test_rate_limit_without_retry_after(self) -> None:
        client = _make_client(_rate_limit_no_retry_after_handler)
        with pytest.raises(RateLimitedError) as exc_info:
            client.complete(
                model="m",
                messages=[{"role": "user", "content": "Hi"}],
            )
        assert exc_info.value.retry_after is None
        client.close()

    def test_out_of_credits_raises(self) -> None:
        client = _make_client(_out_of_credits_handler)
        with pytest.raises(OutOfCreditsError) as exc_info:
            client.complete(
                model="m",
                messages=[{"role": "user", "content": "Hi"}],
            )
        assert exc_info.value.status_code == 402
        client.close()

    def test_auth_error_raises(self) -> None:
        client = _make_client(_auth_error_handler)
        with pytest.raises(AuthError) as exc_info:
            client.complete(
                model="m",
                messages=[{"role": "user", "content": "Hi"}],
            )
        assert exc_info.value.status_code == 401
        client.close()

    def test_server_error_raises_provider_error(self) -> None:
        client = _make_client(_server_error_handler)
        with pytest.raises(ProviderError) as exc_info:
            client.complete(
                model="m",
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

    def test_provider_name_in_error_message(self) -> None:
        client = _make_client(_server_error_handler, name="my-provider")
        with pytest.raises(ProviderError) as exc_info:
            client.complete(model="m", messages=[{"role": "user", "content": "Hi"}])
        assert "my-provider" in str(exc_info.value)
        client.close()

    def test_provider_name_property(self) -> None:
        client = _make_client(_success_handler, name="test-prov")
        assert client.provider_name == "test-prov"
        client.close()

    def test_config_property(self) -> None:
        config = ProviderConfig(name="x", api_key="k", base_url="http://x")
        client = ProviderClient(config=config)
        assert client.config.name == "x"
        client.close()


# ---------------------------------------------------------------------------
# Tests — streaming stream()
# ---------------------------------------------------------------------------


class TestStream:
    def _make_sse_response(self, lines: list[str]) -> httpx.Response:
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
        events = list(client.stream(model="m", messages=[{"role": "user", "content": "Hi"}]))
        text_parts = [e.text_delta for e in events if e.text_delta]
        assert "".join(text_parts) == "Hello world"
        done_events = [e for e in events if e.done]
        assert len(done_events) == 1
        assert done_events[0].usage is not None
        assert done_events[0].usage.input_tokens == 5
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
        events = list(client.stream(model="m", messages=[{"role": "user", "content": "ls"}]))
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
            list(client.stream(model="m", messages=[{"role": "user", "content": "Hi"}]))
        client.close()

    def test_stream_max_tokens_sent(self) -> None:
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured.update(json.loads(request.content))
            return httpx.Response(
                200,
                stream=httpx.ByteStream(
                    b'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\ndata: [DONE]'
                ),
                headers={"content-type": "text/event-stream"},
            )

        client = _make_client(handler)
        list(client.stream(model="m", messages=[{"role": "user", "content": "Hi"}], max_tokens=256))
        assert captured.get("max_tokens") == 256
        client.close()


# ---------------------------------------------------------------------------
# Tests — load_providers_from_env()
# ---------------------------------------------------------------------------


class TestLoadProvidersFromEnv:
    def test_meterless_runtime_token_is_discovered(self, monkeypatch: pytest.MonkeyPatch) -> None:
        token_file = Path.cwd() / ".pytest-run" / "meterless-test" / "proxy-token"
        token_file.parent.mkdir(parents=True, exist_ok=True)
        token_file.write_text("meterless-test-token\n", encoding="utf-8")
        monkeypatch.setattr("xvie_agent.providers.registry.load_dotenv", lambda *a, **kw: None)
        monkeypatch.setenv("METERLESS_TOKEN_PATH", str(token_file))
        monkeypatch.setenv("METERLESS_BASE_URL", "http://127.0.0.1:8088/v1/")
        monkeypatch.delenv("LOCALAPPDATA", raising=False)
        for key in list(os.environ):
            if key.startswith("FORGE_PROVIDER_"):
                monkeypatch.delenv(key, raising=False)

        try:
            providers = load_providers_from_env()
            assert "meterless" in providers
            assert providers["meterless"].config.api_key == "meterless-test-token"
            assert providers["meterless"].config.base_url == "http://127.0.0.1:8088/v1"
        finally:
            token_file.unlink(missing_ok=True)

    def test_meterless_runtime_missing_token_is_skipped(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("xvie_agent.providers.registry.load_dotenv", lambda *a, **kw: None)
        monkeypatch.setenv("METERLESS_TOKEN_PATH", str(Path.cwd() / ".pytest-run" / "missing-token"))
        monkeypatch.delenv("LOCALAPPDATA", raising=False)
        for key in list(os.environ):
            if key.startswith("FORGE_PROVIDER_"):
                monkeypatch.delenv(key, raising=False)

        assert "meterless" not in load_providers_from_env()

    def test_two_providers_from_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("FORGE_PROVIDER_NVIDIA_API_KEY", "nvapi-abc")
        monkeypatch.setenv("FORGE_PROVIDER_NVIDIA_BASE_URL", "https://nvidia.example/v1")
        monkeypatch.setenv("FORGE_PROVIDER_OPENROUTER_API_KEY", "sk-or-xyz")
        monkeypatch.setenv("FORGE_PROVIDER_OPENROUTER_BASE_URL", "https://openrouter.example/v1")

        providers = load_providers_from_env()
        assert "nvidia" in providers
        assert "openrouter" in providers
        assert providers["nvidia"].provider_name == "nvidia"
        assert providers["openrouter"].provider_name == "openrouter"

    def test_known_default_base_url(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """When BASE_URL is omitted for a known provider, use the default."""
        monkeypatch.setenv("FORGE_PROVIDER_NVIDIA_API_KEY", "nvapi-abc")
        monkeypatch.delenv("FORGE_PROVIDER_NVIDIA_BASE_URL", raising=False)

        providers = load_providers_from_env()
        assert "nvidia" in providers
        assert providers["nvidia"].config.base_url == "https://integrate.api.nvidia.com/v1"

    def test_unknown_provider_needs_base_url(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Unknown provider without BASE_URL is skipped."""
        monkeypatch.setenv("FORGE_PROVIDER_FOO_API_KEY", "key123")
        monkeypatch.delenv("FORGE_PROVIDER_FOO_BASE_URL", raising=False)

        providers = load_providers_from_env()
        assert "foo" not in providers

    def test_empty_api_key_skipped(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("FORGE_PROVIDER_NVIDIA_API_KEY", "")
        monkeypatch.setenv("FORGE_PROVIDER_NVIDIA_BASE_URL", "https://nvidia.example/v1")

        providers = load_providers_from_env()
        assert "nvidia" not in providers

    def test_empty_providers_dict(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Prevent load_dotenv from loading the real .env
        monkeypatch.setattr("xvie_agent.providers.registry.load_dotenv", lambda *a, **kw: None)
        monkeypatch.delenv("LOCALAPPDATA", raising=False)
        monkeypatch.delenv("METERLESS_TOKEN_PATH", raising=False)
        for key in list(os.environ):
            if key.startswith("FORGE_PROVIDER_"):
                monkeypatch.delenv(key, raising=False)
        providers = load_providers_from_env()
        assert providers == {}


# ---------------------------------------------------------------------------
# Tests — get_provider()
# ---------------------------------------------------------------------------


class TestGetProvider:
    def test_existing_provider(self) -> None:
        config = ProviderConfig(name="nvidia", api_key="k", base_url="http://n")
        providers = {"nvidia": ProviderClient(config=config)}
        result = get_provider("nvidia", providers)
        assert result.provider_name == "nvidia"

    def test_case_insensitive(self) -> None:
        config = ProviderConfig(name="nvidia", api_key="k", base_url="http://n")
        providers = {"nvidia": ProviderClient(config=config)}
        result = get_provider("NVIDIA", providers)
        assert result.provider_name == "nvidia"

    def test_missing_provider_raises_key_error(self) -> None:
        with pytest.raises(KeyError, match="not configured"):
            get_provider("nonexistent", {})

    def test_missing_provider_lists_available(self) -> None:
        config = ProviderConfig(name="nvidia", api_key="k", base_url="http://n")
        providers = {"nvidia": ProviderClient(config=config)}
        with pytest.raises(KeyError, match="Available providers: nvidia"):
            get_provider("openrouter", providers)
