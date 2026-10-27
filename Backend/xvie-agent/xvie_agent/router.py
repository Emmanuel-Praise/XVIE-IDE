"""Model router — the main differentiator of xvie-agent.

Instead of one fixed model, the router picks the right model per task and
falls back cleanly — across models, and across providers — when something
is rate-limited, refuses tool use, or errors.

The routing policy is loaded from ``routing.yaml`` (or a custom path) so
you can tune it without redeploying.
"""

from __future__ import annotations

import logging
import os
import random
import re
import time
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Sequence

import yaml
import httpx

from xvie_agent.providers.base import (
    ModelDoesNotSupportToolsError,
    PayloadTooLargeError,
    ProviderClient,
    ProviderError,
    RateLimitedError,
)
from xvie_agent.token_budget import estimate_tokens
from xvie_agent.types import AssistantTurn, ModelSpec, StreamEvent, ToolCall, UsageStats

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Routing policy
# ---------------------------------------------------------------------------

# Default config file (relative to project root)
DEFAULT_ROUTING_CONFIG = Path(__file__).resolve().parent.parent / "routing.yaml"

@dataclass(frozen=True)
class RoleConfig:
    """Configuration for a single role (capability-based model assignment).

    Attributes:
        requires: Dict of model capabilities that MUST be True.
        temperature: Sampling temperature for this role.
        max_tokens: Cap on output tokens.
    """

    requires: dict[str, bool] = field(default_factory=dict)
    temperature: float = 0.0
    max_tokens: int | None = None


@dataclass(frozen=True)
class RoutingPolicy:
    """A mapping of lane names to ordered lists of :class:`ModelSpec` entries,
    plus per-role configuration (requires, temperature, max_tokens).

    Each lane represents a *class of task* (e.g. ``"coding"``,
    ``"planning"``, ``"fast_edit"``).  Within a lane, models are tried in
    order — the first entry is the preferred model; the rest are fallbacks.

    ``lane_aliases`` maps lane names to role names (the ``lanes`` block
    in routing.yaml).  ``role_configs`` stores per-role tuning.
    """

    lanes: dict[str, tuple[ModelSpec, ...]] = field(default_factory=dict)
    lane_aliases: dict[str, str] = field(default_factory=dict)
    role_configs: dict[str, RoleConfig] = field(default_factory=dict)

    def resolve_lane(self, name: str) -> tuple[ModelSpec, RoleConfig]:
        """Resolve a lane name to its model list and role config.

        Checks ``lane_aliases`` first (maps lane name → role name),
        then falls back to looking up the name directly as a role.

        Returns:
            (model_specs, role_config)

        Raises:
            KeyError: If the lane/role is not found.
        """
        role_name = self.lane_aliases.get(name, name)
        if role_name not in self.lanes:
            available = ", ".join(sorted(self.lanes.keys())) or "(none)"
            raise KeyError(
                f"Lane '{name}' (role '{role_name}') not found in routing config. "
                f"Available roles: {available}"
            )
        return self.lanes[role_name], self.role_configs.get(role_name, RoleConfig())

    def get_lane(self, name: str) -> tuple[ModelSpec, ...]:
        """Return the ordered model list for a lane, or raise KeyError."""
        specs, _ = self.resolve_lane(name)
        return specs


def load_routing_config(path: Path | str | None = None) -> RoutingPolicy:
    """Load a :class:`RoutingPolicy` from a YAML file.

    Supports two YAML formats:

    1. **Roles-based** (preferred)::

        roles:
          coding:
            requires: {supports_tools: true}
            temperature: 0.0
            max_tokens: 2000
            models: [...]
        lanes:
          coding: coding   # lane alias → role name

    2. **Legacy lanes** (backward-compatible)::

        lanes:
          coding:
            - {provider: nvidia, id: "..."}

    Args:
        path: Path to ``routing.yaml``.  Defaults to the project-root file.

    Returns:
        A parsed :class:`RoutingPolicy`.

    Raises:
        ValueError: If a model under a role doesn't satisfy its ``requires``.
    """
    if path is None:
        path = DEFAULT_ROUTING_CONFIG
    path = Path(path)

    if not path.exists():
        logger.warning("Routing config not found at %s, returning empty policy", path)
        return RoutingPolicy()

    with open(path, encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}

    lanes: dict[str, tuple[ModelSpec, ...]] = {}
    role_configs: dict[str, RoleConfig] = {}
    lane_aliases: dict[str, str] = {}

    # --- New roles-based format ---
    roles_raw = data.get("roles", {})
    if roles_raw:
        for role_name, role_data in roles_raw.items():
            if not isinstance(role_data, dict):
                continue

            requires = role_data.get("requires", {})
            temperature = role_data.get("temperature", 0.0)
            max_tokens = role_data.get("max_tokens")
            role_configs[role_name] = RoleConfig(
                requires=requires,
                temperature=temperature,
                max_tokens=max_tokens,
            )

            specs: list[ModelSpec] = []
            for entry in role_data.get("models", []):
                if not isinstance(entry, dict):
                    continue
                spec = ModelSpec(
                    id=entry.get("id", ""),
                    provider=entry.get("provider", ""),
                    display_name=entry.get("display_name", ""),
                    context_window=entry.get("context_window", 8192),
                    supports_tools=entry.get("supports_tools", False),
                    supports_reasoning=entry.get("supports_reasoning", False),
                    role_tags=tuple(entry.get("role_tags", [])),
                    plan_compliance=entry.get("plan_compliance", "unknown"),
                )
                # Validate requires
                for req_key, req_val in requires.items():
                    spec_val = getattr(spec, req_key, None)
                    if spec_val is not None and spec_val != req_val:
                        raise ValueError(
                            f"Model '{spec.id}' under role '{role_name}' does not satisfy "
                            f"requires.{req_key}={req_val} (model has {req_key}={spec_val})."
                        )
                specs.append(spec)
            if specs:
                lanes[role_name] = tuple(specs)

        # Lane aliases
        aliases_raw = data.get("lanes", {})
        if isinstance(aliases_raw, dict):
            for alias, role_name in aliases_raw.items():
                if isinstance(role_name, str) and role_name in lanes:
                    lane_aliases[alias] = role_name

        return RoutingPolicy(
            lanes=lanes,
            lane_aliases=lane_aliases,
            role_configs=role_configs,
        )

    # --- Legacy lanes format (backward-compatible) ---
    lanes_raw = data.get("lanes", {})
    for lane_name, models_raw in lanes_raw.items():
        if not isinstance(models_raw, list):
            continue
        specs = []
        for entry in models_raw:
            if not isinstance(entry, dict):
                continue
            specs.append(
                ModelSpec(
                    id=entry.get("id", ""),
                    provider=entry.get("provider", ""),
                    display_name=entry.get("display_name", ""),
                    context_window=entry.get("context_window", 8192),
                    supports_tools=entry.get("supports_tools", False),
                    supports_reasoning=entry.get("supports_reasoning", False),
                    role_tags=tuple(entry.get("role_tags", [])),
                    plan_compliance=entry.get("plan_compliance", "unknown"),
                )
            )
        if specs:
            lanes[lane_name] = tuple(specs)

    return RoutingPolicy(lanes=lanes)


# ---------------------------------------------------------------------------
# Task classifier (cheap heuristic, no model call)
# ---------------------------------------------------------------------------

# Trigger words / patterns for classification
_PLANNING_SIGNALS = re.compile(
    r"\b(explain|describe|summarize|review|analyze|plan|design|overview|"
    r"what (is|are|does|do)|how (does|do|is|are)|why|compare|evaluate|"
    r"walk me|tell me|help me understand|give me an overview)\b",
    re.IGNORECASE,
)

_CODING_SIGNALS = re.compile(
    r"\b(implement|fix|add|create|write|build|modify|change|refactor|"
    r"update|insert|delete|remove|append|prepend|replace|"
    r"debug|patch|rename|move|extract|inline)\b",
    re.IGNORECASE,
)

_FAST_SIGNALS = re.compile(
    r"\b(run|execute|test|lint|format|check|verify|"
    r"now |then |also |next |quickly |just |simply )\b",
    re.IGNORECASE,
)

_UI_SIGNALS = re.compile(
    r"\b(component|page|layout|UI|design|styling|form|dashboard|"
    r"landing\s+page|pricing\s+page|header|footer|sidebar|"
    r"modal|dialog|button|navbar|hero|section)\b",
    re.IGNORECASE,
)

_REASONING_SIGNALS = re.compile(
    r"\b(think|reason|analyze|consider|evaluate|weigh|compare|"
    r"pros\s+and\s+cons|trade-?offs?|approach|strategy)\b",
    re.IGNORECASE,
)


def classify_task(prompt: str, turn_number: int = 0) -> str:
    """Classify a prompt into a routing lane using a cheap heuristic.

    Rules (checked in order):
    1. Later turn + short/follow-up prompt → ``"fast_edit"``
    2. UI/design trigger words → ``"ui_design"``
    3. Reasoning-heavy verbs → ``"reasoning"``
    4. Specific file mention + coding verb → ``"coding"``
    5. Question/explanation words → ``"planning"``
    6. Default → ``"coding"``

    Args:
        prompt: The user's prompt text.
        turn_number: Current turn number (0-indexed).  Higher numbers
            suggest the conversation is mid-flight and the user is
            issuing a follow-up.

    Returns:
        A lane name string.
    """
    # Later turns with short prompts are likely follow-ups / mechanical edits
    if turn_number > 0 and len(prompt.split()) <= 8:
        return "fast_edit"

    # Check for signals
    has_coding = bool(_CODING_SIGNALS.search(prompt))
    has_planning = bool(_PLANNING_SIGNALS.search(prompt))
    has_fast = bool(_FAST_SIGNALS.search(prompt))
    has_ui = bool(_UI_SIGNALS.search(prompt))
    has_reasoning = bool(_REASONING_SIGNALS.search(prompt))

    # Strong coding signal (verb + file-like reference) — highest priority
    has_file_ref = bool(re.search(r"\.\w{1,5}\b", prompt))
    if has_coding and has_file_ref:
        return "coding"

    # UI/design tasks (takes priority over generic coding verbs without file ref)
    if has_ui:
        return "ui_design"

    # Reasoning-heavy tasks (but not when combined with explicit coding verbs)
    if has_reasoning and not has_coding:
        return "reasoning"

    # Planning / explanation
    if has_planning and not has_coding:
        return "planning"

    # Fast / mechanical
    if has_fast and not has_coding and not has_planning:
        return "fast_edit"

    # Coding verb without file ref still defaults to coding
    if has_coding:
        return "coding"

    return "coding"


# ---------------------------------------------------------------------------
# Cooldown tracker
# ---------------------------------------------------------------------------

@dataclass
class _CooldownEntry:
    """Tracks when a (provider, model) pair was last rate-limited."""

    expires_at: float = 0.0
    consecutive_failures: int = 0


class CooldownTracker:
    """In-memory cooldown per (provider, model) pair.

    When a pair 429s, it's put on cooldown for an exponentially increasing
    duration (starting at 10s, capped at 300s).  The router skips pairs
    that are currently on cooldown.
    """

    BASE_COOLDOWN = 10.0  # seconds
    MAX_COOLDOWN = 300.0  # 5 minutes
    TRANSIENT_COOLDOWN = 30.0  # seconds — for timeouts / 5xx

    def __init__(self) -> None:
        self._entries: dict[tuple[str, str], _CooldownEntry] = {}

    def _mark(
        self,
        provider: str,
        model: str,
        base: float,
        reason: str,
        retry_after: float | None = None,
    ) -> None:
        key = (provider, model)
        entry = self._entries.get(key, _CooldownEntry())
        entry.consecutive_failures += 1
        # Exponential backoff: base, base*2, base*4, ... capped at MAX_COOLDOWN
        backoff = min(
            base * (2 ** (entry.consecutive_failures - 1)),
            self.MAX_COOLDOWN,
        )
        # Honor the provider's Retry-After hint when given; add ±20% jitter
        # so cooldowns don't re-synchronize across models sharing a bucket.
        cooldown = max(backoff, retry_after or 0.0) * random.uniform(0.8, 1.2)
        entry.expires_at = time.monotonic() + cooldown
        self._entries[key] = entry
        logger.warning(
            "Cooldown: %s/%s on cooldown for %.0fs (%s, attempt %d)",
            provider, model, cooldown, reason, entry.consecutive_failures,
        )

    def mark_limited(
        self,
        provider: str,
        model: str,
        retry_after: float | None = None,
    ) -> None:
        """Record that this pair was rate-limited."""
        self._mark(provider, model, self.BASE_COOLDOWN, "rate limited", retry_after=retry_after)

    def mark_transient(self, provider: str, model: str) -> None:
        """Record a transient failure (timeout / 5xx).

        Without this, a stalled or overloaded model is retried every turn and
        each attempt burns the full read timeout before failing over.
        """
        self._mark(provider, model, self.TRANSIENT_COOLDOWN, "transient error")

    def is_available(self, provider: str, model: str) -> bool:
        """Return True if the pair is NOT on cooldown."""
        key = (provider, model)
        entry = self._entries.get(key)
        if entry is None:
            return True
        if time.monotonic() >= entry.expires_at:
            # Cooldown expired — allow retry
            return True
        return False

    def clear(self, provider: str, model: str) -> None:
        """Reset cooldown for a pair (e.g. after a successful call)."""
        key = (provider, model)
        entry = self._entries.get(key)
        if entry is not None:
            entry.consecutive_failures = 0
            entry.expires_at = 0.0

    def seconds_until_available(self, provider: str, model: str) -> float:
        """Return seconds until this pair exits cooldown (0 if available)."""
        key = (provider, model)
        entry = self._entries.get(key)
        if entry is None:
            return 0.0
        remaining = entry.expires_at - time.monotonic()
        return max(remaining, 0.0)

    def provider_cooldown_remaining(self, provider: str) -> float:
        """Return the shortest cooldown remaining for any model under this provider.

        When all models share a provider rate limit, waiting for the shortest
        cooldown is sufficient — once any model's cooldown expires, the
        provider's RPM bucket has freed up enough for a retry.
        """
        remaining_times: list[float] = []
        for (p, _m), entry in self._entries.items():
            if p == provider:
                remaining = max(entry.expires_at - time.monotonic(), 0.0)
                if remaining > 0:
                    remaining_times.append(remaining)
        return min(remaining_times, default=0.0)


# ---------------------------------------------------------------------------
# Rate limiter (token-bucket per provider)
# ---------------------------------------------------------------------------

class RateLimiter:
    """Simple token-bucket rate limiter.

    Each provider gets its own limiter.  Default: 35 requests/minute.
    """

    def __init__(self, rpm: float = 35.0) -> None:
        self._rpm = rpm
        self._interval = 60.0 / rpm
        self._last_call = 0.0

    def peek_wait(self) -> float:
        """Seconds until a slot is free (0 if ready now). No sleeping."""
        now = time.monotonic()
        return max(0.0, self._last_call + self._interval - now)

    def acquire(self) -> float:
        """Block until a request slot is available.  Returns wait time."""
        wait = self.peek_wait()
        if wait > 0:
            time.sleep(wait)
        self._last_call = time.monotonic()
        return max(wait, 0.0)


# ---------------------------------------------------------------------------
# All-models-exhausted error
# ---------------------------------------------------------------------------

@dataclass
class _ModelAttempt:
    """Record of one failed model attempt within a lane."""

    provider: str
    model: str
    error_type: str
    error_message: str


class AllModelsExhaustedError(Exception):
    """Every model in a lane failed.

    Attributes:
        lane: The lane name that was exhausted.
        attempts: List of :class:`_ModelAttempt` describing each failure.
    """

    def __init__(self, lane: str, attempts: list[_ModelAttempt]) -> None:
        self.lane = lane
        self.attempts = attempts
        lines = [f"All models in lane '{lane}' failed:"]
        for a in attempts:
            lines.append(f"  - {a.provider}/{a.model}: [{a.error_type}] {a.error_message}")
        super().__init__("\n".join(lines))


# ---------------------------------------------------------------------------
# ModelRouter
# ---------------------------------------------------------------------------

class ModelRouter:
    """Routes model calls across providers with automatic fallback.

    Parameters:
        providers: Dict of configured provider clients (from
            ``load_providers_from_env()``).
        policy: A :class:`RoutingPolicy` with lane definitions.
    """

    def __init__(
        self,
        providers: dict[str, ProviderClient],
        policy: RoutingPolicy,
        on_rate_limit_wait: Callable[[str], None] | None = None,
        cancel_event: threading.Event | None = None,
    ) -> None:
        self._providers = providers
        self._policy = policy
        self._on_rate_limit_wait = on_rate_limit_wait
        self._cancel_event = cancel_event

        # Per-provider rate limiters
        self._limiters: dict[str, RateLimiter] = {}
        self._cooldown = CooldownTracker()

        # Validate that all lane entries reference configured providers
        for lane_name, specs in policy.lanes.items():
            for spec in specs:
                if spec.provider not in providers:
                    available = ", ".join(sorted(providers.keys())) or "(none)"
                    raise ValueError(
                        f"Lane '{lane_name}' references provider '{spec.provider}' "
                        f"which is not configured. Available providers: {available}. "
                        f"Set FORGE_PROVIDER_{spec.provider.upper()}_API_KEY and "
                        f"FORGE_PROVIDER_{spec.provider.upper()}_BASE_URL in your "
                        f".env file."
                    )

    def _get_limiter(self, provider_name: str) -> RateLimiter:
        """Get or create a rate limiter for a provider.

        RPM is configurable via ``RATE_LIMIT_RPM`` (default 35, NVIDIA's free
        tier allows 40 — staying a bit under avoids server-side throttling).
        """
        if provider_name not in self._limiters:
            try:
                rpm = float(os.getenv("RATE_LIMIT_RPM") or "")
            except ValueError:
                rpm = 35.0
            if rpm <= 0:
                rpm = 35.0
            self._limiters[provider_name] = RateLimiter(rpm=rpm)
        return self._limiters[provider_name]

    def complete_with_fallback(
        self,
        lane: str,
        messages: list[dict],
        tools: list[dict] | None = None,
    ) -> AssistantTurn:
        """Try each model in the lane's fallback list until one succeeds.

        Resolves the lane to its role config and threads ``temperature``
        and ``max_tokens`` from the role into each provider call.

        Args:
            lane: The routing lane name (e.g. ``"coding"``).
            messages: Chat history in OpenAI format.
            tools: Optional tool definitions.

        Returns:
            The successful :class:`AssistantTurn`.

        Raises:
            AllModelsExhaustedError: If every model in the lane failed.
        """
        specs, role_config = self._policy.resolve_lane(lane)
        attempts: list[_ModelAttempt] = []

        retry_round = 0
        while True:
            retry_round += 1
            round_attempts: list[_ModelAttempt] = []
            turn = self._try_specs(specs, role_config, messages, tools, round_attempts)
            if turn is not None:
                return turn
            attempts.extend(round_attempts)

            # Decide from this pass only. A permanent failure from a previous
            # pass must not poison recovery after the affected model has
            # recovered, and prior transient errors must not hide a new 400.
            if self._are_all_retryable(round_attempts):
                providers = {attempt.provider for attempt in round_attempts}
                waits = [(self._cooldown.provider_cooldown_remaining(provider), provider) for provider in providers]
                wait, wait_provider = min((item for item in waits if item[0] > 0), default=(0.0, ""))
                if wait > 0:
                    actual_wait = max(1.0, wait)
                    rate_limited = all(a.error_type in {"rate_limited", "cooldown"} for a in round_attempts)
                    logger.warning("All models temporarily unavailable on %s — waiting %.0fs, round %d", wait_provider, actual_wait, retry_round)
                    if self._on_rate_limit_wait:
                        self._on_rate_limit_wait(
                            f"{'Rate limit' if rate_limited else 'Temporary model/network error'} on {wait_provider} — "
                            f"retrying in {actual_wait:.0f}s "
                            f"(retry {retry_round})"
                        )
                    if self._cancel_event is not None:
                        if self._cancel_event.wait(actual_wait):
                            return AssistantTurn("")
                    else:
                        time.sleep(actual_wait)
                    for spec in specs:
                        if spec.provider == wait_provider and self._cooldown.seconds_until_available(spec.provider, spec.id) <= actual_wait:
                            self._cooldown.clear(spec.provider, spec.id)
                    continue
            break

        raise AllModelsExhaustedError(lane=lane, attempts=attempts)

    def _try_specs(
        self,
        specs: tuple[ModelSpec, ...],
        role_config: RoleConfig,
        messages: list[dict],
        tools: list[dict] | None,
        attempts: list[_ModelAttempt],
    ) -> AssistantTurn | None:
        """Try each model in the lane once.

        Failures are appended to ``attempts`` so the retry loop (and the final
        :class:`AllModelsExhaustedError`) reports every failure. Returns the
        first successful turn or ``None`` if every model failed.
        """
        for spec in specs:
            client = self._providers[spec.provider]

            # Skip if on cooldown
            if not self._cooldown.is_available(spec.provider, spec.id):
                logger.info(
                    "Skipping %s/%s (on cooldown)", spec.provider, spec.id,
                )
                attempts.append(_ModelAttempt(
                    provider=spec.provider,
                    model=spec.id,
                    error_type="cooldown",
                    error_message="Model is on cooldown after previous rate limit",
                ))
                continue

            # Rate-limit this provider — announce BEFORE sleeping so the
            # spinner reads "pacing…" instead of freezing with no output.
            limiter = self._get_limiter(spec.provider)
            pending = limiter.peek_wait()
            if pending >= 0.75 and self._on_rate_limit_wait:
                self._on_rate_limit_wait(
                    f"Pacing {spec.provider} requests — waiting {pending:.0f}s"
                )
            wait_time = limiter.acquire()
            if wait_time > 0:
                logger.debug(
                    "Waited %.1fs for rate limiter on %s", wait_time, spec.provider,
                )

            # Determine max_tokens: role config overrides, then spec, then None
            effective_max_tokens = role_config.max_tokens

            # Try the model
            try:
                turn = client.complete(
                    model=spec.id,
                    messages=messages,
                    tools=tools,
                    temperature=role_config.temperature,
                    max_tokens=effective_max_tokens,
                )
                # Success — clear any cooldown
                self._cooldown.clear(spec.provider, spec.id)
                logger.info(
                    "Router: %s/%s served the request (%d input, %d output tokens, "
                    "temp=%.1f, max_tokens=%s)",
                    spec.provider, spec.id,
                    turn.usage.input_tokens, turn.usage.output_tokens,
                    role_config.temperature, effective_max_tokens,
                )
                return turn

            except RateLimitedError as exc:
                self._cooldown.mark_limited(
                    spec.provider, spec.id, retry_after=exc.retry_after
                )
                attempts.append(_ModelAttempt(
                    provider=spec.provider,
                    model=spec.id,
                    error_type="rate_limited",
                    error_message=str(exc),
                ))
                logger.warning(
                    "Router: %s/%s rate limited, trying next model",
                    spec.provider, spec.id,
                )
                continue

            except PayloadTooLargeError as exc:
                # Oversized request — retrying without tools cannot help and
                # the agent layer compacts + retries. Record and move on.
                attempts.append(_ModelAttempt(
                    provider=spec.provider,
                    model=spec.id,
                    error_type="payload_too_large",
                    error_message=str(exc),
                ))
                logger.warning(
                    "Router: %s/%s rejected oversized request, trying next model",
                    spec.provider, spec.id,
                )
                continue

            except ModelDoesNotSupportToolsError as exc:
                attempts.append(_ModelAttempt(
                    provider=spec.provider,
                    model=spec.id,
                    error_type="no_tool_support",
                    error_message=str(exc),
                ))
                logger.warning(
                    "Router: %s/%s doesn't support tools, trying next model",
                    spec.provider, spec.id,
                )
                continue

            except ProviderError as exc:
                # 5xx or other transient errors — cool the model down so a
                # stalled endpoint isn't re-tried (and re-stalled) every turn.
                if exc.status_code == 0 or exc.status_code >= 500:
                    self._cooldown.mark_transient(spec.provider, spec.id)
                attempts.append(_ModelAttempt(
                    provider=spec.provider,
                    model=spec.id,
                    error_type=f"http_{exc.status_code}",
                    error_message=str(exc),
                ))
                logger.warning(
                    "Router: %s/%s error %d, trying next model",
                    spec.provider, spec.id, exc.status_code,
                )
                continue

        return None

    def _are_all_retryable(
        self, attempts: list[_ModelAttempt]
    ) -> bool:
        """Check whether the lane only has failures that can recover with time."""
        if not attempts:
            return False
        return all(
            attempt.error_type in {"rate_limited", "cooldown", "network", "http_0", "http_408", "http_500", "http_502", "http_503", "http_504"}
            or attempt.error_type.startswith("http_5")
            for attempt in attempts
        )

    def stream_with_fallback(
        self,
        lane: str,
        messages: list[dict],
        tools: list[dict] | None = None,
        on_event: Callable[[StreamEvent], None] | None = None,
    ) -> AssistantTurn:
        """Stream a turn from the first viable model with lane fallback.

        When every model in the lane has a transient failure, wait for the
        shortest affected provider cooldown and retry until recovery or cancel.
        """
        specs, role_config = self._policy.resolve_lane(lane)
        attempts: list[_ModelAttempt] = []

        retry_round = 0
        while True:
            retry_round += 1
            round_attempts: list[_ModelAttempt] = []
            turn = self._try_specs_stream(
                specs, role_config, messages, tools, round_attempts, on_event
            )
            if turn is not None:
                return turn
            attempts.extend(round_attempts)

            if self._are_all_retryable(round_attempts):
                providers = {attempt.provider for attempt in round_attempts}
                waits = [(self._cooldown.provider_cooldown_remaining(provider), provider) for provider in providers]
                wait, wait_provider = min((item for item in waits if item[0] > 0), default=(0.0, ""))
                if wait > 0:
                    actual_wait = max(1.0, wait)
                    rate_limited = all(a.error_type in {"rate_limited", "cooldown"} for a in round_attempts)
                    logger.warning("All models temporarily unavailable on %s (stream) — waiting %.0fs, round %d", wait_provider, actual_wait, retry_round)
                    if self._on_rate_limit_wait:
                        self._on_rate_limit_wait(
                            f"{'Rate limit' if rate_limited else 'Temporary model/network error'} on {wait_provider} — "
                            f"retrying in {actual_wait:.0f}s "
                            f"(retry {retry_round})"
                        )
                    if self._cancel_event is not None:
                        if self._cancel_event.wait(actual_wait):
                            return AssistantTurn("")
                    else:
                        time.sleep(actual_wait)
                    for spec in specs:
                        if spec.provider == wait_provider and self._cooldown.seconds_until_available(spec.provider, spec.id) <= actual_wait:
                            self._cooldown.clear(spec.provider, spec.id)
                    continue
            break

        raise AllModelsExhaustedError(lane=lane, attempts=attempts)

    def _try_specs_stream(
        self,
        specs: tuple[ModelSpec, ...],
        role_config: RoleConfig,
        messages: list[dict],
        tools: list[dict] | None,
        attempts: list[_ModelAttempt],
        on_event: Callable[[StreamEvent], None] | None,
    ) -> AssistantTurn | None:
        """Try each model in the lane once with streaming.

        Returns the first successful turn or ``None`` if every model failed.
        Failures are appended to ``attempts`` for the retry loop.
        """
        for spec in specs:
            client = self._providers[spec.provider]

            # Skip if on cooldown
            if not self._cooldown.is_available(spec.provider, spec.id):
                logger.info(
                    "Skipping %s/%s (on cooldown)", spec.provider, spec.id,
                )
                attempts.append(_ModelAttempt(
                    provider=spec.provider,
                    model=spec.id,
                    error_type="cooldown",
                    error_message="Model is on cooldown after previous rate limit",
                ))
                continue

            # Rate-limit this provider — announce BEFORE sleeping so the
            # spinner reads "pacing…" instead of freezing with no output.
            limiter = self._get_limiter(spec.provider)
            pending = limiter.peek_wait()
            if pending >= 0.75 and self._on_rate_limit_wait:
                self._on_rate_limit_wait(
                    f"Pacing {spec.provider} requests — waiting {pending:.0f}s"
                )
            wait_time = limiter.acquire()
            if wait_time > 0:
                logger.debug(
                    "Waited %.1fs for rate limiter on %s", wait_time, spec.provider,
                )

            # Retry the SAME model without tools if it rejects tool calling;
            # otherwise a 400 on every model in the lane just burns the turn.
            model_tools = tools
            retried_without_tools = False
            while True:
                try:
                    content: list[str] = []
                    reasoning: list[str] = []
                    calls: list[ToolCall] = []
                    usage = UsageStats()
                    truncated = False
                    incomplete = False
                    for event in client.stream(spec.id, messages, model_tools, role_config.temperature, role_config.max_tokens):
                        if on_event:
                            on_event(event)
                        if event.text_delta:
                            content.append(event.text_delta)
                        if event.reasoning_delta:
                            reasoning.append(event.reasoning_delta)
                        if event.tool_call:
                            calls.append(event.tool_call)
                        if event.usage:
                            usage = event.usage
                        if event.truncated:
                            truncated = True
                        if event.incomplete:
                            incomplete = True
                    self._cooldown.clear(spec.provider, spec.id)
                    # Some providers (e.g. NVIDIA NIM) never send a usage chunk
                    # when streaming — estimate locally so the display isn't 0.
                    if usage.input_tokens == 0 and usage.output_tokens == 0:
                        est_in = sum(
                            estimate_tokens(str(m.get("content") or "")) for m in messages
                        )
                        est_out = estimate_tokens("".join(content))
                        usage = UsageStats(input_tokens=est_in, output_tokens=est_out)
                    return AssistantTurn(
                        "".join(content),
                        tuple(calls),
                        usage,
                        spec.id,
                        "".join(reasoning) or None,
                        truncated,
                        incomplete,
                    )
                except PayloadTooLargeError as exc:
                    # Size failure, not a tools refusal — dropping tools
                    # cannot fix it. Record and stop this lane cleanly.
                    attempts.append(_ModelAttempt(spec.provider, spec.id, "payload_too_large", str(exc)))
                    logger.info(
                        "Router: %s/%s rejected oversized request — not retrying without tools",
                        spec.provider, spec.id,
                    )
                    break
                except ModelDoesNotSupportToolsError as exc:
                    attempts.append(_ModelAttempt(spec.provider, spec.id, "no_tool_support", str(exc)))
                    logger.info(
                        "Router: %s/%s rejects tools — retrying without them",
                        spec.provider, spec.id,
                    )
                    if model_tools and not retried_without_tools:
                        model_tools = None
                        retried_without_tools = True
                        continue
                    break
                except RateLimitedError as exc:
                    self._cooldown.mark_limited(
                        spec.provider, spec.id, retry_after=exc.retry_after
                    )
                    attempts.append(_ModelAttempt(spec.provider, spec.id, "rate_limited", str(exc)))
                    break
                except ProviderError as exc:
                    # Timeouts (status 0) and 5xx get a cooldown so a stalled
                    # endpoint isn't re-tried — and re-stalled — every turn.
                    if exc.status_code == 0 or exc.status_code >= 500:
                        self._cooldown.mark_transient(spec.provider, spec.id)
                    attempts.append(_ModelAttempt(spec.provider, spec.id, f"http_{exc.status_code}", str(exc)))
                    break
                except httpx.HTTPError as exc:
                    self._cooldown.mark_transient(spec.provider, spec.id)
                    attempts.append(_ModelAttempt(spec.provider, spec.id, "network", str(exc)))
                    break
                except Exception as exc:  # noqa: BLE001 — one bad model must never kill the session
                    logger.exception("Unexpected error from %s/%s", spec.provider, spec.id)
                    attempts.append(_ModelAttempt(spec.provider, spec.id, "unexpected", f"{type(exc).__name__}: {exc}"))
                    break

        return None
