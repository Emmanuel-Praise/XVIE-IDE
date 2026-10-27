"""Tests for oversized-request handling (HTTP 400 size failures).

Background: NVIDIA NIM reports an oversized request body as 400
``missing field 'content'`` — the same 400 it uses when a model rejects
the tools payload. These tests pin the distinction: size failures must
NEVER be classified as no-tool-support, history must be compacted before
sending, and the user must get an honest message (not "rate-limiting").
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from xvie_agent.agent import (
    MAX_REQUEST_CHARS,
    _all_attempts_payload_too_large,
    _compact_messages_for_request,
    _prepare_messages_for_provider,
    _rollover_messages_for_request,
    _request_size_chars,
)
from xvie_agent.providers.base import (
    ModelDoesNotSupportToolsError,
    PayloadTooLargeError,
    ProviderClient,
    ProviderConfig,
)
from xvie_agent.router import AllModelsExhaustedError, ModelRouter, RoutingPolicy
from xvie_agent.types import AssistantTurn, ModelSpec, UsageStats


BASE_URL = "https://integrate.api.nvidia.com/v1"

MISSING_FIELD_BODY = (
    '{"message":"Failed to deserialize the JSON body into the target type: '
    'missing field `content` at line 1 column 195804","type":"Bad Request","code":400}'
)


def _make_client(handler, name: str = "nvidia") -> ProviderClient:
    config = ProviderConfig(name=name, api_key="nvapi-test-key", base_url=BASE_URL)
    transport = httpx.MockTransport(handler)
    http_client = httpx.Client(transport=transport, base_url=BASE_URL)
    return ProviderClient(config=config, client=http_client)


def _ok_response() -> dict:
    return {
        "id": "chatcmpl-test",
        "model": "test-model",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": "done"},
            "finish_reason": "stop",
        }],
        "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7},
    }


# ---------------------------------------------------------------------------
# 400 classification: size vs tools refusal
# ---------------------------------------------------------------------------


class TestMissingFieldClassification:
    def test_small_body_stays_no_tool_support(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(400, text=MISSING_FIELD_BODY)

        client = _make_client(handler)
        with pytest.raises(ModelDoesNotSupportToolsError):
            client.complete(
                model="m",
                messages=[{"role": "user", "content": "hi"}],
            )

    def test_oversized_body_is_payload_too_large(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(400, text=MISSING_FIELD_BODY)

        client = _make_client(handler)
        big = [{"role": "user", "content": "x" * 200_000}]
        with pytest.raises(PayloadTooLargeError):
            client.complete(model="m", messages=big)

    def test_other_400_stays_provider_error(self):
        from xvie_agent.providers.base import ProviderError

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(400, text='{"error": "bad request"}')

        client = _make_client(handler)
        with pytest.raises(ProviderError):
            client.complete(
                model="m",
                messages=[{"role": "user", "content": "hi"}],
            )


# ---------------------------------------------------------------------------
# Compaction helper
# ---------------------------------------------------------------------------


def _big_conversation() -> list[dict]:
    msgs: list[dict] = [{"role": "system", "content": "SYSTEM" + "x" * 5000}]
    for i in range(6):
        msgs.append({"role": "user", "content": f"do step {i}"})
        msgs.append({
            "role": "assistant",
            "content": "thinking " * 2000,
            "tool_calls": [{
                "id": f"c{i}",
                "type": "function",
                "function": {
                    "name": "read_file",
                    "arguments": '{"path": "f.css", "pad": "' + "y" * 5000 + '"}',
                },
            }],
        })
        msgs.append({
            "role": "tool",
            "tool_call_id": f"c{i}",
            "content": "file contents " + "z" * 15000,
        })
    msgs.append({"role": "user", "content": "finish now"})
    return msgs


class TestCompactMessages:
    def test_system_prompt_intact(self):
        out = _compact_messages_for_request(_big_conversation())
        assert out[0] == {"role": "system", "content": "SYSTEM" + "x" * 5000}

    def test_old_tool_results_tombstoned_recent_kept(self):
        out = _compact_messages_for_request(_big_conversation(), keep_turns=4)
        tool_msgs = [m for m in out if m.get("role") == "tool"]
        tombstoned = [m for m in tool_msgs if str(m.get("content", "")).startswith("[tool result omitted")]
        # 7 user turns (6 steps + final prompt) - 4 kept = 3 tombstoned
        assert {m.get("tool_call_id") for m in tombstoned} == {"c0", "c1", "c2"}
        kept = [m for m in tool_msgs if not str(m.get("content", "")).startswith("[tool result omitted")]
        assert {m.get("tool_call_id") for m in kept} == {"c3", "c4", "c5"}

    def test_assistant_content_truncated_calls_kept(self):
        out = _compact_messages_for_request(_big_conversation(), keep_turns=2)
        assistants = [m for m in out if m.get("role") == "assistant"]
        # tool_calls structure survives everywhere (conversation must replay)
        assert all(m.get("tool_calls") for m in assistants)
        # Old assistants compacted (content + args); newest content stays intact
        old = [m for m in assistants if "truncated" in str(m.get("content", ""))]
        assert len(old) >= 1
        newest = assistants[-1]
        assert "truncated" not in str(newest.get("content", ""))
        assert any("compacted" in str(m["tool_calls"][0]["function"]["arguments"]) for m in assistants)
        import json
        assert all(
            isinstance(json.loads(m["tool_calls"][0]["function"]["arguments"]), dict)
            for m in assistants
        )

    def test_control_characters_and_large_arguments_stay_valid_json(self):
        import json

        messages = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "old"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": "write-1",
                    "type": "function",
                    "function": {
                        "name": "write_file",
                        "arguments": json.dumps({
                            "path": "page.html",
                            "content": "first line\nsecond line\x00" + "x" * 8000,
                        }),
                    },
                }],
            },
            {"role": "tool", "tool_call_id": "write-1", "content": "saved"},
            {"role": "user", "content": "continue"},
        ]
        compacted = _compact_messages_for_request(messages, keep_turns=1)
        prepared = _prepare_messages_for_provider(compacted)
        assistant = next(m for m in prepared if m.get("role") == "assistant")
        arguments = assistant["tool_calls"][0]["function"]["arguments"]
        assert isinstance(json.loads(arguments), dict)
        assert not any(ord(char) < 32 for char in arguments)
        assert any(m.get("tool_call_id") == "write-1" for m in prepared)

    def test_preflight_repairs_unparseable_historical_arguments(self):
        import json

        messages = [{
            "role": "assistant",
            "content": "",
            "tool_calls": [{
                "id": "broken-1",
                "type": "function",
                "function": {"name": "write_file", "arguments": '{"content":"line 1\nline 2"}'},
            }],
        }]

        prepared = _prepare_messages_for_provider(messages)
        arguments = prepared[0]["tool_calls"][0]["function"]["arguments"]
        parsed = json.loads(arguments)

        assert isinstance(parsed, dict)
        assert "_raw" in parsed
        assert not any(ord(char) < 32 for char in arguments)

    def test_originals_unmutated(self):
        msgs = _big_conversation()
        before = [(m.get("role"), len(str(m.get("content") or ""))) for m in msgs]
        _compact_messages_for_request(msgs)
        after = [(m.get("role"), len(str(m.get("content") or ""))) for m in msgs]
        assert before == after

    def test_request_size_estimator(self):
        assert _request_size_chars([{"role": "user", "content": "hi"}], None) > 0
        assert _request_size_chars([], None) == 2  # "[]"
        # Env-tunable wire cap (default 90K, was 120K): smaller payloads =
        # fewer provider rejections mid-build.
        assert MAX_REQUEST_CHARS >= 30_000

    def test_rollover_preserves_task_and_drops_optional_context(self):
        messages = [
            {
                "role": "system",
                "content": (
                    "Instructions\n## Loaded references\n" + "ref " * 5000
                    + "\n<project-context>" + "context " * 2000 + "</project-context>"
                ),
            },
            {"role": "user", "content": "Original task: finish the landing page"},
            {"role": "user", "content": "Continue the remaining footer work"},
        ]
        out = _rollover_messages_for_request(messages)
        assert "Instructions" in out[0]["content"]
        assert "## Loaded references" not in out[0]["content"]
        assert "<project-context>" not in out[0]["content"]
        assert "Original task" in out[1]["content"]
        assert "footer work" in out[2]["content"]


# ---------------------------------------------------------------------------
# Agent: preemptive compaction, retry-after-compact, honest stop reason
# ---------------------------------------------------------------------------


class TestAgentRequestSize:
    def _loop(self, fake, tmp_path: Path):
        from xvie_agent.agent import AgentLoop
        from xvie_agent.tools import ToolContext, build_default_registry

        ctx = ToolContext(workspace_root=tmp_path, allow_write=False, allow_shell=False)
        return AgentLoop(client=fake, model="m", tools=build_default_registry(ctx), tool_ctx=ctx)

    def test_preemptive_compaction_before_send(self, tmp_path: Path):
        from xvie_agent.types import ToolCall

        sent: list[list[dict]] = []

        class CaptureClient:
            provider_name = "fake"

            def complete(self, model, messages, tools=None, **kwargs):
                sent.append(messages)
                return AssistantTurn(content="ok", usage=UsageStats(input_tokens=1, output_tokens=1))

            def close(self):
                pass

        msgs = _big_conversation()
        original_len = len(str(msgs[3].get("content") or ""))
        assert original_len > 5000
        loop = self._loop(CaptureClient(), tmp_path)
        loop._call_model(msgs, None)
        assert len(sent) == 1
        # Old tool results compacted on the wire...
        wire_tools = [m for m in sent[0] if m.get("role") == "tool"]
        assert any(str(m.get("content", "")).startswith("[tool result omitted") for m in wire_tools)
        # ...but the live history is untouched
        assert len(str(msgs[3].get("content") or "")) == original_len
        assert [m.get("role") for m in msgs] == [m.get("role") for m in sent[0]]

    def test_small_requests_untouched(self, tmp_path: Path):
        sent: list[list[dict]] = []

        class CaptureClient:
            provider_name = "fake"

            def complete(self, model, messages, tools=None, **kwargs):
                sent.append(messages)
                return AssistantTurn(content="ok", usage=UsageStats(input_tokens=1, output_tokens=1))

            def close(self):
                pass

        msgs = [{"role": "system", "content": "sys"}, {"role": "user", "content": "hi"}]
        loop = self._loop(CaptureClient(), tmp_path)
        loop._call_model(msgs, None)
        assert sent[0] == msgs

    def test_payload_error_retries_once_then_completes(self, tmp_path: Path):
        from xvie_agent.loop import run_agent

        calls: list[int] = []

        class FlakyClient:
            provider_name = "fake"

            def complete(self, model, messages, tools=None, **kwargs):
                calls.append(1)
                if len(calls) == 1:
                    raise PayloadTooLargeError("too big", status_code=400, body="missing field")
                return AssistantTurn(content="recovered", usage=UsageStats(input_tokens=1, output_tokens=1))

            def close(self):
                pass

        result = run_agent("summarize the workspace structure", "m", tmp_path, provider=FlakyClient())
        assert result.stop_reason == "completed"
        assert len(calls) == 2

    def test_persistent_payload_error_is_honest(self, tmp_path: Path):
        from xvie_agent.loop import run_agent

        class AlwaysBigClient:
            provider_name = "fake"

            def complete(self, model, messages, tools=None, **kwargs):
                raise PayloadTooLargeError("too big", status_code=400, body="missing field")

            def close(self):
                pass

        result = run_agent("fix the bug in utils.py", "m", tmp_path, provider=AlwaysBigClient())
        assert result.stop_reason == "payload_too_large"
        assert "couldn't reconnect" in result.final_output.lower()
        assert "progress are saved" in result.final_output.lower()
        assert "rate-limit" not in result.final_output.lower()

    def test_routed_payload_failure_rolls_over_and_resumes(self, tmp_path: Path):
        from xvie_agent.loop import run_agent

        class FlakyRouter:
            def __init__(self):
                self.calls = 0

            def complete_with_fallback(self, *, lane, messages, tools=None):
                self.calls += 1
                if self.calls == 1:
                    raise AllModelsExhaustedError(lane=lane, attempts=[
                        SimpleNamespace(
                            provider="test", model="m", error_type="payload_too_large",
                            error_message="provider rejected request",
                        )
                    ])
                return AssistantTurn(
                    content="continued",
                    usage=UsageStats(input_tokens=1, output_tokens=1),
                )

        class DummyProvider:
            provider_name = "test"

        router = FlakyRouter()
        events = []
        result = run_agent(
            "Continue the current task", "m", tmp_path,
            provider=DummyProvider(),  # type: ignore[arg-type]
            router=router, lane="coding",
            event_callback=events.append,
        )
        assert result.stop_reason == "completed"
        assert result.final_output == "continued"
        assert router.calls == 2
        assert any("Refreshing working context" in event.message for event in events)


# ---------------------------------------------------------------------------
# Router records size failures distinctly (never no_tool_support)
# ---------------------------------------------------------------------------


def _spec(model_id: str) -> ModelSpec:
    return ModelSpec(provider="nvidia", id=model_id, display_name=model_id)


class TestRouterPayloadHandling:
    def test_payload_error_recorded_distinctly(self):
        from xvie_agent.router import _ModelAttempt  # noqa: F401  (shape check)

        exc = AllModelsExhaustedError(lane="coding", attempts=[
            SimpleNamespace(provider="nvidia", model="m1", error_type="payload_too_large", error_message="big"),
            SimpleNamespace(provider="nvidia", model="m2", error_type="payload_too_large", error_message="big"),
        ])
        assert _all_attempts_payload_too_large(exc) is True

    def test_mixed_attempts_not_all_payload(self):
        exc = AllModelsExhaustedError(lane="coding", attempts=[
            SimpleNamespace(provider="nvidia", model="m1", error_type="payload_too_large", error_message="big"),
            SimpleNamespace(provider="nvidia", model="m2", error_type="rate_limited", error_message="slow"),
        ])
        assert _all_attempts_payload_too_large(exc) is False

    def test_empty_attempts_not_payload(self):
        assert _all_attempts_payload_too_large(ValueError("x")) is False

    def test_fallback_marks_payload_not_no_tool_support(self):
        class SizeFailClient:
            provider_name = "nvidia"

            def complete(self, model, messages, tools=None, **kwargs):
                raise PayloadTooLargeError("too big", status_code=400, body="missing field")

            def close(self):
                pass

        policy = RoutingPolicy(lanes={"coding": (_spec("m1"),)})
        router = ModelRouter(providers={"nvidia": SizeFailClient()}, policy=policy)
        with pytest.raises(AllModelsExhaustedError) as exc_info:
            router.complete_with_fallback("coding", [{"role": "user", "content": "hi"}])
        types = {a.error_type for a in exc_info.value.attempts}
        assert "payload_too_large" in types
        assert "no_tool_support" not in types
