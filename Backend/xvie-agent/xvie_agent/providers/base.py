"""Base provider types, error hierarchy, and the universal ``ProviderClient``.

This module is the single source of truth for how xvie-agent talks to any
OpenAI-compatible chat endpoint.  The provider is just a config entry
(base_url + api_key + name) — there is no provider-specific subclassing.

Error hierarchy
---------------
    ProviderError                 — base for all HTTP / API errors
    ├── RateLimitedError (429)    — model or account rate-limited
    ├── OutOfCreditsError (402)   — account balance exhausted
    ├── AuthError (401/403)        — bad or missing API key
    └── ModelDoesNotSupportToolsError — model refused tool calls
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Iterator

import httpx

from xvie_agent.types import AssistantTurn, StreamEvent, ToolCall, UsageStats

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Provider config
# ---------------------------------------------------------------------------

# Well-known default base URLs — used when BASE_URL is omitted in env vars.
_KNOWN_DEFAULTS: dict[str, str] = {
    "nvidia": "https://integrate.api.nvidia.com/v1",
    "openrouter": "https://openrouter.ai/api/v1",
}


@dataclass(frozen=True)
class ProviderConfig:
    """Connection details for a single provider."""

    name: str
    api_key: str
    base_url: str


# ---------------------------------------------------------------------------
# Exception hierarchy
# ---------------------------------------------------------------------------

class ProviderError(Exception):
    """Base exception for all provider API errors.

    Attributes:
        status_code: HTTP status code from the response.
        body: Raw response body text (often JSON).
    """

    def __init__(self, message: str, *, status_code: int = 0, body: str = "") -> None:
        super().__init__(message)
        self.status_code = status_code
        self.body = body


class RateLimitedError(ProviderError):
    """Raised on HTTP 429 — the model or account has been rate-limited.

    Attributes:
        retry_after: Seconds to wait before retrying, if the provider
            supplied a ``Retry-After`` header.
    """

    def __init__(
        self,
        message: str,
        *,
        status_code: int = 429,
        body: str = "",
        retry_after: float | None = None,
    ) -> None:
        super().__init__(message, status_code=status_code, body=body)
        self.retry_after = retry_after


class OutOfCreditsError(ProviderError):
    """Raised on HTTP 402 — the provider account has no remaining credits."""


class AuthError(ProviderError):
    """Raised on HTTP 401/403 — invalid or missing API key."""


class ModelDoesNotSupportToolsError(ProviderError):
    """Raised when a model is called with tools but doesn't support them.

    This is a ``ProviderError`` subclass (not a separate exception) because
    from the caller's perspective it's still a provider-level failure — the
    model refused the request.
    """


class PayloadTooLargeError(ProviderError):
    """Raised on HTTP 400 when the request body itself is too large.

    NVIDIA NIM (and some OpenAI-compatible endpoints) report an oversized
    body as ``missing field 'content'`` — the deserializer gives up deep
    inside a huge payload. That must NOT be mistaken for
    :class:`ModelDoesNotSupportToolsError`: retrying without tools cannot
    fix a size problem, and burning the whole lane on it hides the cause.
    """


# Request bodies above this size (chars) are treated as the cause of a
# "missing field" 400. Observed NIM deserializer failure at ~186-195KB;
# stay well under it.
OVERSIZE_400_BODY_CHARS = 150_000


# ---------------------------------------------------------------------------
# Response parsing helpers
# ---------------------------------------------------------------------------

# Pattern to extract <think>...</think> blocks from content
_THINK_PATTERN = re.compile(r"^\s*<think>(.*?)</think>\s*", re.DOTALL)


def _extract_think_block(content: str) -> tuple[str, str]:
    """Extract a ``<think>...</think>`` block from the beginning of content.

    Returns:
        (reasoning, remainder) — the reasoning text extracted from the
        think block (or empty string if none), and the remaining content
        after the think block (or the original content unchanged).
    """
    match = _THINK_PATTERN.match(content)
    if match:
        reasoning = match.group(1).strip()
        remainder = content[match.end():].strip()
        return reasoning, remainder
    return "", content


def _parse_usage(data: dict) -> UsageStats:
    """Extract UsageStats from an OpenAI-compatible ``usage`` dict.

    Tolerates multiple naming conventions without crashing:
    - ``prompt_tokens`` / ``completion_tokens`` (OpenAI standard)
    - ``prompt_tokens_details`` sub-object (optional)
    """
    usage = data.get("usage") or {}
    details = usage.get("prompt_tokens_details") or {}
    return UsageStats(
        input_tokens=usage.get("prompt_tokens", 0) or usage.get("input_tokens", 0),
        output_tokens=usage.get("completion_tokens", 0) or usage.get("output_tokens", 0),
        cache_read_tokens=details.get("cached_tokens", 0),
        cache_write_tokens=details.get("cache_write_tokens", 0),
    )


def _parse_tool_calls(raw_calls: list[dict]) -> tuple[ToolCall, ...]:
    """Normalise the OpenAI ``tool_calls`` array into :class:`ToolCall` objects."""
    calls: list[ToolCall] = []
    for raw in raw_calls:
        fn = raw.get("function", {})
        args_raw = fn.get("arguments", "{}")
        try:
            args = json.loads(args_raw) if isinstance(args_raw, str) else args_raw
        except json.JSONDecodeError:
            args = {"_raw": args_raw}
        calls.append(
            ToolCall(
                id=raw.get("id", ""),
                name=fn.get("name", ""),
                arguments=args,
            )
        )
    return tuple(calls)


def _parse_function_call(fc: dict) -> ToolCall:
    """Parse a legacy ``function_call`` object into a :class:`ToolCall`."""
    args_raw = fc.get("arguments", "{}")
    try:
        args = json.loads(args_raw) if isinstance(args_raw, str) else args_raw
    except json.JSONDecodeError:
        args = {"_raw": args_raw}
    return ToolCall(
        id="legacy_function_call",
        name=fc.get("name", ""),
        arguments=args,
    )


def _raise_for_status(
    response: httpx.Response, provider_name: str, *, payload_chars: int = 0
) -> None:
    """Raise a specific exception subclass for known HTTP error codes.

    Args:
        response: The HTTP response to inspect.
        provider_name: Provider label for messages.
        payload_chars: Serialized request body size. Required to tell an
            oversized body apart from a genuine tools refusal — both arrive
            as 400 ``missing field 'content'``.
    """
    if response.is_success:
        return

    status = response.status_code
    body = response.text

    if status == 429:
        retry_after: float | None = None
        ra_header = response.headers.get("retry-after")
        if ra_header:
            try:
                retry_after = float(ra_header)
            except (ValueError, TypeError):
                pass
        raise RateLimitedError(
            f"[{provider_name}] Rate limited (429): {body}",
            status_code=status,
            body=body,
            retry_after=retry_after,
        )
    if status == 402:
        raise OutOfCreditsError(
            f"[{provider_name}] Out of credits (402): {body}",
            status_code=status,
            body=body,
        )
    if status in (401, 403):
        raise AuthError(
            f"[{provider_name}] Authentication error ({status}): {body}",
            status_code=status,
            body=body,
        )
    # NVIDIA NIM and some OpenAI-compatible endpoints reject requests that
    # carry a `tools` payload for models that don't actually support tool
    # calling — surfacing "missing field `content`" (a schema quirk) with a
    # 400. Treat that as "model doesn't support tools" so the router can
    # retry the SAME model without tools instead of burning the whole lane.
    # BUT the same 400 surfaces when the request BODY is too large for the
    # deserializer (observed at ~186-195KB chars) — retrying without tools
    # cannot fix that, so classify by payload size first.
    if status == 400 and "missing field" in body.lower():
        if payload_chars > OVERSIZE_400_BODY_CHARS:
            raise PayloadTooLargeError(
                f"[{provider_name}] Request body too large (~{payload_chars} chars) — "
                f"HTTP {status}: {body[:200]}",
                status_code=status,
                body=body,
            )
        raise ModelDoesNotSupportToolsError(
            f"[{provider_name}] HTTP {status}: {body}",
            status_code=status,
            body=body,
        )
    raise ProviderError(
        f"[{provider_name}] HTTP {status}: {body}",
        status_code=status,
        body=body,
    )


# ---------------------------------------------------------------------------
# ProviderClient
# ---------------------------------------------------------------------------

class ProviderClient:
    """Universal client for any OpenAI-compatible chat-completions endpoint.

    One instance talks to one provider (a ``ProviderConfig``).  Multiple
    instances can talk to different providers simultaneously.  No
    provider-specific subclassing — the provider is just a config entry.

    Parameters:
        config: Provider connection details.
        timeout: Default request timeout in seconds.
        app_name: Reported via ``X-Title`` / ``HTTP-Referer`` headers.
        client: Optional pre-configured ``httpx.Client`` (for testing with
            ``httpx.MockTransport``).
    """

    def __init__(
        self,
        config: ProviderConfig,
        *,
        timeout: float | None = None,
        app_name: str = "xvie-agent",
        client: httpx.Client | None = None,
    ) -> None:
        import os as _os

        self._config = config
        self._base_url = config.base_url.rstrip("/")
        if timeout is None:
            try:
                timeout = float(_os.getenv("XVIE_PROVIDER_TIMEOUT", "90"))
            except ValueError:
                timeout = 90.0
            timeout = max(15.0, min(timeout, 300.0))
        self._timeout = timeout
        self._own_client = client is None
        self._client = client or httpx.Client(
            headers={
                "Authorization": f"Bearer {config.api_key}",
                "Content-Type": "application/json",
                # Harmless if the provider ignores them; required by OpenRouter.
                "HTTP-Referer": "https://github.com/xvie-agent",
                "X-Title": app_name,
            },
            # Split timeouts: a dead/unreachable endpoint must fail in seconds,
            # not burn the full read budget.  ``timeout`` only caps reads so
            # long generations still complete.
            timeout=httpx.Timeout(connect=10.0, read=timeout, write=20.0, pool=10.0),
        )

    @property
    def provider_name(self) -> str:
        """Human-readable provider name."""
        return self._config.name

    @property
    def config(self) -> ProviderConfig:
        """The underlying provider configuration."""
        return self._config

    def close(self) -> None:
        """Close the underlying HTTP client if we own it."""
        if self._own_client:
            self._client.close()

    # ------------------------------------------------------------------
    # Non-streaming
    # ------------------------------------------------------------------

    def complete(
        self,
        model: str,
        messages: list[dict],
        tools: list[dict] | None = None,
        temperature: float = 0.0,
        max_tokens: int | None = None,
    ) -> AssistantTurn:
        """Send a chat completion request and return the full response.

        Args:
            model: Model slug as the provider names it.
            messages: Chat history in OpenAI format.
            tools: Optional tool definitions (OpenAI function-calling schema).
            temperature: Sampling temperature.
            max_tokens: Maximum tokens to generate (provider-dependent).

        Returns:
            An :class:`AssistantTurn` with the model's text, tool calls, and usage.

        Raises:
            ProviderError: On any HTTP error from the API.
            ModelDoesNotSupportToolsError: If the model refuses tool definitions.
        """
        payload: dict = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
        }
        if tools:
            payload["tools"] = tools
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens

        try:
            response = self._client.post(
                f"{self._base_url}/chat/completions",
                json=payload,
            )
        except httpx.TimeoutException as exc:
            raise ProviderError(
                f"[{self._config.name}] Timeout after {self._timeout}s: {exc}",
                status_code=0,
            ) from exc
        except httpx.HTTPError as exc:
            raise ProviderError(
                f"[{self._config.name}] Network error: {exc}", status_code=0,
            ) from exc

        _raise_for_status(
            response, self._config.name, payload_chars=len(json.dumps(payload))
        )

        data = response.json()
        return self._parse_complete_response(data, model)

    def _parse_complete_response(self, data: dict, model: str) -> AssistantTurn:
        """Parse a non-streaming chat completion response.

        Handles three reasoning-source patterns (checked in order):
        1. ``reasoning_content`` / ``reasoning`` field on the message
        2. ``<think>...</think>`` block in content
        3. No reasoning (reasoning stays ``None``)
        """
        choices = data.get("choices", [])
        if not choices:
            if "error" in data:
                raise ModelDoesNotSupportToolsError(
                    f"[{self._config.name}] Model '{model}' does not support tools: {data['error']}",
                    status_code=0,
                    body=json.dumps(data),
                )
            raise ProviderError(
                f"[{self._config.name}] No choices returned for model '{model}'",
                status_code=0,
                body=json.dumps(data),
            )
        message = choices[0].get("message", {})

        content = message.get("content") or ""
        raw_tool_calls = message.get("tool_calls") or []

        # Some models return an error object when they don't support tools
        if "error" in data and not content and not raw_tool_calls:
            raise ModelDoesNotSupportToolsError(
                f"[{self._config.name}] Model '{model}' does not support tools: {data.get('error')}",
                status_code=0,
                body=json.dumps(data),
            )

        tool_calls = _parse_tool_calls(raw_tool_calls) if raw_tool_calls else ()

        # Legacy function_call support
        if not tool_calls:
            fc = message.get("function_call")
            if fc:
                tool_calls = (_parse_function_call(fc),)

        usage = _parse_usage(data)

        # --- Reasoning extraction (order matters) ---
        reasoning: str | None = None

        # 1. Explicit reasoning field on the message (DeepSeek, Qwen, etc.)
        reasoning = message.get("reasoning_content") or message.get("reasoning")
        if reasoning:
            reasoning = reasoning.strip()
        else:
            reasoning = None

        # 2. <think>...</think> block in content
        if not reasoning and content:
            extracted, remainder = _extract_think_block(content)
            if extracted:
                reasoning = extracted
                content = remainder

        return AssistantTurn(
            content=content,
            tool_calls=tool_calls,
            usage=usage,
            model=data.get("model", model),
            reasoning=reasoning,
            truncated=choices[0].get("finish_reason") == "length",
        )

    # ------------------------------------------------------------------
    # Streaming
    # ------------------------------------------------------------------

    def stream(
        self,
        model: str,
        messages: list[dict],
        tools: list[dict] | None = None,
        temperature: float = 0.0,
        max_tokens: int | None = None,
    ) -> Iterator[StreamEvent]:
        """Stream a chat completion, yielding :class:`StreamEvent` chunks.

        The iterator terminates with a ``StreamEvent(done=True)`` after all
        data has been sent.

        Args:
            model: Model slug as the provider names it.
            messages: Chat history in OpenAI format.
            tools: Optional tool definitions.
            temperature: Sampling temperature.
            max_tokens: Maximum tokens to generate.

        Yields:
            :class:`StreamEvent` instances (text deltas, tool calls, usage).

        Raises:
            ProviderError: On any HTTP error from the API.
        """
        payload: dict = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "stream": True,
            # Ask the provider to include a final usage chunk — without this
            # many providers report zero tokens for streamed responses.
            "stream_options": {"include_usage": True},
        }
        if tools:
            payload["tools"] = tools
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens

        with self._client.stream(
            "POST",
            f"{self._base_url}/chat/completions",
            json=payload,
        ) as response:
            if not response.is_success:
                # Materialize the body first: accessing .text on an unread
                # error stream raises httpx.ResponseNotRead, which escaped
                # every handler and crashed the session.
                response.read()
            _raise_for_status(
                response, self._config.name, payload_chars=len(json.dumps(payload))
            )

            tool_call_buffers: dict[int, dict] = {}
            last_usage: UsageStats | None = None
            truncated = False
            stream_ended = False

            def parsed_tool_calls() -> list[ToolCall]:
                parsed: list[ToolCall] = []
                for idx in sorted(tool_call_buffers):
                    buf = tool_call_buffers[idx]
                    try:
                        args = json.loads(buf["arguments"]) if buf["arguments"] else {}
                    except json.JSONDecodeError:
                        args = {"_raw": buf["arguments"]}
                    parsed.append(ToolCall(id=buf["id"], name=buf["name"], arguments=args))
                tool_call_buffers.clear()
                return parsed

            for line in response.iter_lines():
                if not line.startswith("data:"):
                    continue
                raw = line[len("data:"):].strip()
                if raw == "[DONE]":
                    stream_ended = True
                    break

                try:
                    chunk = json.loads(raw)
                except json.JSONDecodeError:
                    logger.warning("Skipping unparseable SSE chunk: %s", raw[:120])
                    continue

                if not isinstance(chunk, dict):
                    continue

                # Some providers send usage-only or keep-alive chunks with an
                # empty/missing choices list — skip them safely (no crash).
                choices = chunk.get("choices") or []
                if not choices or not isinstance(choices[0], dict):
                    # Still harvest usage from these terminal chunks.
                    usage_data = chunk.get("usage")
                    if usage_data:
                        last_usage = _parse_usage({"usage": usage_data})
                    continue

                choice = choices[0]
                delta = choice.get("delta") or {}
                if not isinstance(delta, dict):
                    delta = {}
                finish_reason = choice.get("finish_reason")

                # --- Reasoning content (separate from text) ---
                reasoning_text = delta.get("reasoning_content") or delta.get("reasoning")
                if reasoning_text:
                    yield StreamEvent(reasoning_delta=reasoning_text)

                # --- Text content ---
                text = delta.get("content")
                if text:
                    yield StreamEvent(text_delta=text)

                # --- Tool calls (may arrive incrementally) ---
                for tc_delta in delta.get("tool_calls", []):
                    idx = tc_delta.get("index", 0)
                    if idx not in tool_call_buffers:
                        tool_call_buffers[idx] = {
                            "id": tc_delta.get("id", ""),
                            "name": "",
                            "arguments": "",
                        }
                    buf = tool_call_buffers[idx]
                    if tc_delta.get("id"):
                        buf["id"] = tc_delta["id"]
                    fn = tc_delta.get("function", {})
                    if fn.get("name"):
                        buf["name"] = fn["name"]
                    if fn.get("arguments"):
                        buf["arguments"] += fn["arguments"]

                # --- Usage ---
                usage_data = chunk.get("usage")
                if usage_data:
                    last_usage = _parse_usage({"usage": usage_data})

                if finish_reason == "length":
                    truncated = True

                # --- Terminal event ---
                if finish_reason in ("stop", "tool_calls", "length"):
                    for tool_call in parsed_tool_calls():
                        yield StreamEvent(tool_call=tool_call)

                    yield StreamEvent(
                        usage=last_usage or UsageStats(),
                        done=True,
                        truncated=truncated,
                    )
                    return

            # A protocol sentinel is a valid terminal signal even when a
            # provider omits finish_reason. Without either signal, the socket
            # ended early and the agent must resume instead of accepting the
            # partial answer as complete.
            for tool_call in parsed_tool_calls():
                yield StreamEvent(tool_call=tool_call)
            yield StreamEvent(
                usage=last_usage or UsageStats(),
                done=True,
                truncated=truncated,
                incomplete=not stream_ended,
            )
