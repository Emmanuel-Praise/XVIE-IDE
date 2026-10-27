"""Tests for xvie_agent.router — model routing with fallback."""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Iterator
from unittest.mock import MagicMock

import pytest

from xvie_agent.providers.base import (
    ModelDoesNotSupportToolsError,
    ProviderClient,
    ProviderConfig,
    ProviderError,
    RateLimitedError,
)
from xvie_agent.router import (
    AllModelsExhaustedError,
    CooldownTracker,
    ModelRouter,
    RoutingPolicy,
    _ModelAttempt,
    classify_task,
    load_routing_config,
)
from xvie_agent.types import AssistantTurn, ModelSpec, UsageStats


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class FakeClient:
    """Fake provider client that returns scripted responses."""

    def __init__(self, responses: list[AssistantTurn | Exception], provider_name: str = "fake"):
        self._responses = list(responses)
        self._call_count = 0
        self._provider_name = provider_name

    @property
    def provider_name(self) -> str:
        return self._provider_name

    def complete(self, model: str, messages: list[dict], tools=None, **kwargs):
        if self._call_count >= len(self._responses):
            raise RuntimeError(f"FakeClient ran out of responses (call {self._call_count})")
        resp = self._responses[self._call_count]
        self._call_count += 1
        if isinstance(resp, Exception):
            raise resp
        return resp

    def close(self):
        pass


def _make_turn(content: str = "hello", model: str = "test-model") -> AssistantTurn:
    return AssistantTurn(
        content=content,
        tool_calls=(),
        usage=UsageStats(input_tokens=10, output_tokens=5),
        model=model,
    )


def _make_policy(*specs_per_lane: tuple[str, list[ModelSpec]]) -> RoutingPolicy:
    lanes = {}
    for lane_name, specs in specs_per_lane:
        lanes[lane_name] = tuple(specs)
    return RoutingPolicy(lanes=lanes)


# ---------------------------------------------------------------------------
# classify_task
# ---------------------------------------------------------------------------


class TestClassifyTask:
    def test_planning_question(self):
        assert classify_task("What does the config.py file do?") == "planning"

    def test_coding_verb_with_file(self):
        assert classify_task("Fix the bug in main.py") == "coding"
        assert classify_task("Add a login function to auth.py") == "coding"

    def test_coding_verb_without_file(self):
        assert classify_task("Implement error handling") == "coding"

    def test_fast_edit_on_later_turn(self):
        assert classify_task("run tests", turn_number=3) == "fast_edit"
        assert classify_task("now lint it", turn_number=2) == "fast_edit"

    def test_short_followup_on_later_turn(self):
        assert classify_task("yes", turn_number=1) == "fast_edit"
        assert classify_task("ok do it", turn_number=2) == "fast_edit"

    def test_default_is_coding(self):
        assert classify_task("something random") == "coding"

    def test_explain_goes_to_planning(self):
        assert classify_task("Explain how the router works") == "planning"

    def test_summary_goes_to_planning(self):
        assert classify_task("Summarize this codebase") == "planning"


# ---------------------------------------------------------------------------
# CooldownTracker
# ---------------------------------------------------------------------------


class TestCooldownTracker:
    def test_available_by_default(self):
        ct = CooldownTracker()
        assert ct.is_available("nvidia", "llama") is True

    def test_mark_limited_makes_unavailable(self):
        ct = CooldownTracker()
        ct.mark_limited("nvidia", "llama")
        assert ct.is_available("nvidia", "llama") is False

    def test_clear_resets(self):
        ct = CooldownTracker()
        ct.mark_limited("nvidia", "llama")
        ct.clear("nvidia", "llama")
        assert ct.is_available("nvidia", "llama") is True

    def test_different_providers_independent(self):
        ct = CooldownTracker()
        ct.mark_limited("nvidia", "llama")
        assert ct.is_available("openrouter", "llama") is True


# ---------------------------------------------------------------------------
# RoutingPolicy
# ---------------------------------------------------------------------------


class TestRoutingPolicy:
    def test_get_lane(self):
        policy = _make_policy(
            ("coding", [
                ModelSpec(id="m1", provider="nvidia"),
                ModelSpec(id="m2", provider="nvidia"),
            ]),
        )
        lane = policy.get_lane("coding")
        assert len(lane) == 2
        assert lane[0].id == "m1"

    def test_get_lane_missing(self):
        policy = _make_policy()
        with pytest.raises(KeyError, match="not found"):
            policy.get_lane("nonexistent")


# ---------------------------------------------------------------------------
# ModelRouter — core routing
# ---------------------------------------------------------------------------


class TestModelRouter:
    def test_transient_network_failures_wait_and_retry(self, monkeypatch):
        import time as _time

        client = FakeClient([
            ProviderError("TLS handshake timed out", status_code=0),
            _make_turn("recovered", "m1"),
        ], "nvidia")
        policy = _make_policy(("coding", [ModelSpec(id="m1", provider="nvidia")]))
        router = ModelRouter(providers={"nvidia": client}, policy=policy)
        sleeps = []
        monkeypatch.setattr(_time, "sleep", lambda seconds: sleeps.append(seconds))

        turn = router.complete_with_fallback("coding", [{"role": "user", "content": "continue"}])

        assert turn.content == "recovered"
        assert client._call_count == 2
        assert sleeps and sleeps[0] >= 1

    def test_first_model_succeeds(self):
        """When the first model works, use it directly — no fallback."""
        client1 = FakeClient([_make_turn("from-model-1", "m1")])
        policy = _make_policy(
            ("coding", [ModelSpec(id="m1", provider="p1")]),
        )
        router = ModelRouter(providers={"p1": client1}, policy=policy)

        turn = router.complete_with_fallback("coding", [{"role": "user", "content": "hi"}])
        assert turn.content == "from-model-1"
        assert turn.model == "m1"

    def test_first_fails_second_succeeds(self):
        """Rate-limited on first model → fallback to second."""
        client1 = FakeClient([RateLimitedError("429")])
        client2 = FakeClient([_make_turn("from-model-2", "m2")])

        policy = _make_policy(
            ("coding", [
                ModelSpec(id="m1", provider="p1"),
                ModelSpec(id="m2", provider="p2"),
            ]),
        )
        router = ModelRouter(providers={"p1": client1, "p2": client2}, policy=policy)

        turn = router.complete_with_fallback("coding", [{"role": "user", "content": "hi"}])
        assert turn.content == "from-model-2"
        assert turn.model == "m2"

    def test_cross_provider_fallback(self):
        """First provider 429s → fallback to a completely different provider."""
        nvidia_client = FakeClient([RateLimitedError("429")], "nvidia")
        openrouter_client = FakeClient([_make_turn("fallback-ok", "or-model")], "openrouter")

        policy = _make_policy(
            ("coding", [
                ModelSpec(id="nvidia/model-a", provider="nvidia"),
                ModelSpec(id="openrouter/model-b", provider="openrouter"),
            ]),
        )
        router = ModelRouter(
            providers={"nvidia": nvidia_client, "openrouter": openrouter_client},
            policy=policy,
        )

        turn = router.complete_with_fallback("coding", [{"role": "user", "content": "fix bug"}])
        assert turn.content == "fallback-ok"
        assert turn.model == "or-model"

    def test_all_models_fail_raises(self):
        """Permanent model failures still raise AllModelsExhaustedError."""
        client1 = FakeClient([ProviderError("bad request", status_code=400)])
        client2 = FakeClient([ProviderError("invalid request", status_code=400)])

        policy = _make_policy(
            ("coding", [
                ModelSpec(id="m1", provider="p1"),
                ModelSpec(id="m2", provider="p2"),
            ]),
        )
        router = ModelRouter(providers={"p1": client1, "p2": client2}, policy=policy)

        with pytest.raises(AllModelsExhaustedError) as exc_info:
            router.complete_with_fallback("coding", [{"role": "user", "content": "hi"}])

        assert "coding" in str(exc_info.value)
        assert len(exc_info.value.attempts) == 2
        assert exc_info.value.attempts[0].error_type == "http_400"
        assert exc_info.value.attempts[1].error_type == "http_400"

    def test_model_no_tools_fallback(self):
        """ModelDoesNotSupportToolsError triggers fallback."""
        client1 = FakeClient([ModelDoesNotSupportToolsError("no tools")])
        client2 = FakeClient([_make_turn("tool-ok", "m2")])

        policy = _make_policy(
            ("coding", [
                ModelSpec(id="m1", provider="p1"),
                ModelSpec(id="m2", provider="p2"),
            ]),
        )
        router = ModelRouter(providers={"p1": client1, "p2": client2}, policy=policy)

        turn = router.complete_with_fallback("coding", [{"role": "user", "content": "hi"}])
        assert turn.content == "tool-ok"


# ---------------------------------------------------------------------------
# ModelRouter — streaming with no-tools retry
# ---------------------------------------------------------------------------


class _FakeStreamClient:
    """Streaming client that records the tools it was called with."""

    def __init__(self, script: list, provider_name: str = "fake"):
        self._script = list(script)
        self.provider_name = provider_name
        self.calls: list[dict] = []

    def stream(self, model, messages, tools=None, temperature=0.0, max_tokens=None):
        self.calls.append({"tools": tools})
        if not self._script:
            raise RuntimeError(f"_FakeStreamClient out of responses (call {len(self.calls)})")
        resp = self._script.pop(0)
        if isinstance(resp, Exception):
            raise resp
        return iter(resp)

    def close(self):
        pass


class TestRouterStreamingNoToolsRetry:
    def test_preserves_incomplete_stream_signal(self):
        from xvie_agent.types import StreamEvent

        client = _FakeStreamClient([[
            StreamEvent(text_delta="partial"),
            StreamEvent(usage=UsageStats(input_tokens=1, output_tokens=1), done=True, incomplete=True),
        ]])
        router = ModelRouter(
            providers={"p1": client},
            policy=_make_policy(("coding", [ModelSpec(id="m1", provider="p1")])),
        )

        turn = router.stream_with_fallback("coding", [{"role": "user", "content": "save"}])

        assert turn.content == "partial"
        assert turn.incomplete is True

    def test_retries_same_model_without_tools(self):
        """A streaming model that rejects tools (400 "missing field content")
        must be retried WITHOUT tools on the same client, and succeed."""
        from xvie_agent.types import StreamEvent

        reject = ModelDoesNotSupportToolsError(
            "HTTP 400: missing field `content`", status_code=400
        )
        client = _FakeStreamClient([
            reject,
            [
                StreamEvent(text_delta="saved without tools."),
                StreamEvent(usage=UsageStats(input_tokens=1, output_tokens=2), done=True),
            ],
        ])
        router = ModelRouter(
            providers={"p1": client},
            policy=_make_policy(("coding", [ModelSpec(id="m1", provider="p1")])),
        )
        tools = [{"type": "function", "function": {"name": "write_file"}}]

        turn = router.stream_with_fallback(
            "coding", [{"role": "user", "content": "hi"}], tools=tools
        )

        assert turn.content == "saved without tools."
        assert client.calls[0]["tools"] is tools
        assert client.calls[1]["tools"] is None

    def test_no_tools_retry_fails_then_falls_to_next_model(self):
        """If the no-tools retry also fails, the lane moves to the next model."""
        from xvie_agent.types import StreamEvent

        reject = ModelDoesNotSupportToolsError(
            "HTTP 400: missing field `content`", status_code=400
        )
        c1 = _FakeStreamClient([reject, reject])
        c2 = _FakeStreamClient([
            [
                StreamEvent(text_delta="fallback ok"),
                StreamEvent(usage=UsageStats(input_tokens=1, output_tokens=1), done=True),
            ],
        ])
        router = ModelRouter(
            providers={"p1": c1, "p2": c2},
            policy=_make_policy((
                "coding",
                [ModelSpec(id="m1", provider="p1"), ModelSpec(id="m2", provider="p2")],
            )),
        )
        tools = [{"type": "function", "function": {"name": "write_file"}}]

        turn = router.stream_with_fallback(
            "coding", [{"role": "user", "content": "hi"}], tools=tools
        )

        assert turn.content == "fallback ok"
        # First model tried with tools, then without; second model used tools.
        assert [c["tools"] for c in c1.calls] == [tools, None]
        assert c2.calls[0]["tools"] is tools


# ---------------------------------------------------------------------------
# ModelRouter — unconfigured provider
# ---------------------------------------------------------------------------


class TestRouterValidation:
    def test_unconfigured_provider_raises(self):
        """A lane referencing an unconfigured provider fails at construction."""
        policy = _make_policy(
            ("coding", [
                ModelSpec(id="m1", provider="nonexistent"),
            ]),
        )
        with pytest.raises(ValueError, match="nonexistent"):
            ModelRouter(providers={}, policy=policy)

    def test_missing_lane_raises(self):
        """Requesting a lane that doesn't exist raises KeyError."""
        client1 = FakeClient([_make_turn()])
        policy = _make_policy()
        router = ModelRouter(providers={"p1": client1}, policy=policy)

        with pytest.raises(KeyError, match="nonexistent"):
            router.complete_with_fallback("nonexistent", [])


# ---------------------------------------------------------------------------
# Cooldown behavior in router
# ---------------------------------------------------------------------------


class TestRouterCooldown:
    def test_rate_limited_model_gets_cooldown(self):
        """After a 429, the model should be skipped on subsequent calls."""
        # m1 always 429s, m2 always succeeds (called twice — once per request)
        client1 = FakeClient([RateLimitedError("429"), _make_turn("should-not-reach")])
        client2 = FakeClient([_make_turn("from-m2", "m2"), _make_turn("from-m2-again", "m2")])

        policy = _make_policy(
            ("coding", [
                ModelSpec(id="m1", provider="p1"),
                ModelSpec(id="m2", provider="p2"),
            ]),
        )
        router = ModelRouter(providers={"p1": client1, "p2": client2}, policy=policy)

        # First call: m1 429s, falls back to m2
        turn = router.complete_with_fallback("coding", [{"role": "user", "content": "hi"}])
        assert turn.model == "m2"

        # Second call: m1 is on cooldown, m2 used directly
        turn2 = router.complete_with_fallback("coding", [{"role": "user", "content": "hi2"}])
        assert turn2.model == "m2"
        # client1 should have been called only once (first time only)
        assert client1._call_count == 1


# ---------------------------------------------------------------------------
# load_routing_config
# ---------------------------------------------------------------------------


class TestLoadRoutingConfig:
    def test_load_from_yaml(self, tmp_path: Path):
        yaml_content = """
lanes:
  coding:
    - provider: nvidia
      id: "meta/llama-3.1-8b-instruct"
      display_name: "Llama 8B"
      context_window: 131072
      supports_tools: true
      role_tags: [coding]
      max_tokens: 2000
"""
        config_file = tmp_path / "routing.yaml"
        config_file.write_text(yaml_content)

        policy = load_routing_config(config_file)
        assert "coding" in policy.lanes
        specs = policy.get_lane("coding")
        assert len(specs) == 1
        assert specs[0].id == "meta/llama-3.1-8b-instruct"
        assert specs[0].provider == "nvidia"

    def test_missing_file_returns_empty(self, tmp_path: Path):
        policy = load_routing_config(tmp_path / "nonexistent.yaml")
        assert len(policy.lanes) == 0

    def test_multi_lane(self, tmp_path: Path):
        yaml_content = """
lanes:
  planning:
    - provider: nvidia
      id: "llama-70b"
      context_window: 131072
  coding:
    - provider: nvidia
      id: "llama-8b"
      context_window: 131072
  fast_edit:
    - provider: nvidia
      id: "nemotron-mini"
      context_window: 4096
"""
        config_file = tmp_path / "routing.yaml"
        config_file.write_text(yaml_content)

        policy = load_routing_config(config_file)
        assert set(policy.lanes.keys()) == {"planning", "coding", "fast_edit"}


# ---------------------------------------------------------------------------
# Rate-limit retry behavior
# ---------------------------------------------------------------------------


class TestRateLimitRetry:
    """When all models in a lane hit the same provider's rate limit,
    the router should wait and retry instead of hard-failing."""

    def test_same_provider_all_rate_limited_waits_and_retries(self, monkeypatch):
        """Two models on same provider both 429 → wait → retry → succeed."""
        import time as _time

        # Both models on same provider 'nvidia' — first pass both 429,
        # second pass (retry) succeeds on m1
        client = FakeClient([
            RateLimitedError("429 m1"),
            RateLimitedError("429 m2"),
            _make_turn("retry-ok", "m1"),
        ])

        policy = _make_policy(
            ("coding", [
                ModelSpec(id="m1", provider="nvidia"),
                ModelSpec(id="m2", provider="nvidia"),
            ]),
        )
        router = ModelRouter(
            providers={"nvidia": client}, policy=policy,
        )

        # Mock time.sleep to avoid actual waiting in tests
        sleep_calls = []
        def fake_sleep(secs):
            sleep_calls.append(secs)
        monkeypatch.setattr(_time, "sleep", fake_sleep)

        turn = router.complete_with_fallback("coding", [{"role": "user", "content": "hi"}])
        assert turn.content == "retry-ok"
        assert turn.model == "m1"
        # Should have retried (some sleeps are from RateLimiter, some from retry)
        # The key assertion: 3 total model calls = 2 fails + 1 retry success
        assert client._call_count == 3
        # At least one sleep was from the retry wait (> 5s)
        assert any(s > 5 for s in sleep_calls)

    def test_retries_repeated_429_until_recovery_and_honors_retry_after(self, monkeypatch):
        import time as _time
        import xvie_agent.router as router_module

        client = FakeClient([
            RateLimitedError("429", retry_after=7),
            RateLimitedError("429", retry_after=7),
            RateLimitedError("429", retry_after=7),
            _make_turn("eventually recovered", "m1"),
        ])
        policy = _make_policy(("coding", [
            ModelSpec(id="m1", provider="nvidia"),
            ModelSpec(id="m2", provider="nvidia"),
        ]))
        waits: list[float] = []
        monkeypatch.setattr(_time, "sleep", waits.append)
        monkeypatch.setattr(router_module.random, "uniform", lambda low, high: 1.0)
        router = ModelRouter(providers={"nvidia": client}, policy=policy)

        turn = router.complete_with_fallback("coding", [{"role": "user", "content": "hi"}])

        assert turn.content == "eventually recovered"
        assert client._call_count == 4
        assert any(wait >= 7 for wait in waits)

    def test_permanent_bad_request_stops_mixed_rate_limit_retry(self, monkeypatch):
        import time as _time

        client1 = FakeClient([RateLimitedError("429", retry_after=30)], "p1")
        client2 = FakeClient([ProviderError("invalid tool arguments", status_code=400)], "p2")
        policy = _make_policy(("coding", [
            ModelSpec(id="m1", provider="p1"),
            ModelSpec(id="m2", provider="p2"),
        ]))
        waits: list[float] = []
        monkeypatch.setattr(_time, "sleep", waits.append)
        router = ModelRouter(providers={"p1": client1, "p2": client2}, policy=policy)

        with pytest.raises(AllModelsExhaustedError):
            router.complete_with_fallback("coding", [{"role": "user", "content": "hi"}])

        assert client1._call_count == client2._call_count == 1
        assert not any(wait >= 30 for wait in waits)

    def test_different_providers_rate_limits_wait_and_retry(self, monkeypatch):
        """Rate limits across providers wait briefly, then retry the lane."""
        import time as _time

        client1 = FakeClient([RateLimitedError("429 p1"), _make_turn("recovered", "m1")], "p1")
        client2 = FakeClient([RateLimitedError("429 p2"), _make_turn("recovered", "m2")], "p2")

        policy = _make_policy(
            ("coding", [
                ModelSpec(id="m1", provider="p1"),
                ModelSpec(id="m2", provider="p2"),
            ]),
        )
        router = ModelRouter(
            providers={"p1": client1, "p2": client2}, policy=policy,
        )

        sleep_calls = []
        def fake_sleep(secs):
            sleep_calls.append(secs)
        monkeypatch.setattr(_time, "sleep", fake_sleep)

        turn = router.complete_with_fallback("coding", [{"role": "user", "content": "hi"}])

        assert turn.content == "recovered"
        assert len(sleep_calls) >= 1

    def test_rate_limit_callback_fired(self, monkeypatch):
        """The on_rate_limit_wait callback fires when waiting for retry."""
        import time as _time

        client = FakeClient([
            RateLimitedError("429 m1"),
            RateLimitedError("429 m2"),
            _make_turn("ok", "m1"),
        ])
        policy = _make_policy(
            ("coding", [
                ModelSpec(id="m1", provider="nvidia"),
                ModelSpec(id="m2", provider="nvidia"),
            ]),
        )

        callback_msgs = []
        router = ModelRouter(
            providers={"nvidia": client}, policy=policy,
            on_rate_limit_wait=lambda msg: callback_msgs.append(msg),
        )

        monkeypatch.setattr(_time, "sleep", lambda s: None)

        turn = router.complete_with_fallback("coding", [{"role": "user", "content": "hi"}])
        assert turn.content == "ok"
        assert len(callback_msgs) >= 1
        assert any("rate limit" in m.lower() for m in callback_msgs)
        assert any("nvidia" in m.lower() for m in callback_msgs)
