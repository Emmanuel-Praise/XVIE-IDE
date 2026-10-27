"""Transient error detection and retry policy for provider calls.

Auto wait-and-retry on the direct client path (no router lane): when the
provider rate-limits us (429), hits a transient 5xx, or times out / drops the
connection (status 0), the agent sleeps with exponential backoff and tries
again instead of failing immediately. Every wait emits a
``rate_limit_wait``/``retrying`` progress event so the run never stalls
silently.

Tunables (env):
    XVIE_RETRY_MAX          Max retries before giving up (default 3)
    XVIE_RETRY_BASE_DELAY   Base sleep in seconds (default 1.0, doubles each try)
    XVIE_RETRY_CAP          Max single sleep in seconds (default 10.0)
"""

from __future__ import annotations

import os
import random
import math
from dataclasses import dataclass

from xvie_agent.providers.base import (
    ModelDoesNotSupportToolsError,
    ProviderError,
    RateLimitedError,
)

# ProviderError status codes that are safe to retry.  0 signals a network
# timeout / connection failure (no HTTP response at all).
_TRANSIENT_STATUS_CODES = {0, 408, 500, 502, 503, 504}


@dataclass(frozen=True)
class RetryPolicy:
    """Backoff parameters for transient-error retries."""

    max_retries: int = 5
    base_delay: float = 2.0
    factor: float = 2.0
    cap: float = 60.0
    jitter: float = 0.2

    @classmethod
    def from_env(cls) -> "RetryPolicy":
        def _int(name: str, default: int) -> int:
            raw = os.getenv(name, "")
            if not raw:
                return default
            try:
                return max(0, int(raw))
            except ValueError:
                return default

        def _float(name: str, default: float) -> float:
            raw = os.getenv(name, "")
            if not raw:
                return default
            try:
                return max(0.0, float(raw))
            except ValueError:
                return default

        return cls(
            max_retries=_int("XVIE_RETRY_MAX", 3),
            base_delay=_float("XVIE_RETRY_BASE_DELAY", 1.0),
            cap=_float("XVIE_RETRY_CAP", 10.0),
        )


def is_transient_error(exc: Exception) -> bool:
    """True when the provider error is worth waiting for and retrying."""
    if isinstance(exc, ModelDoesNotSupportToolsError):
        # Retrying tool support errors just burns quota — the model cannot
        # do what we asked, no amount of waiting changes that.
        return False
    if isinstance(exc, RateLimitedError):
        return True
    if isinstance(exc, ProviderError):
        return exc.status_code in _TRANSIENT_STATUS_CODES
    return False


def retry_delay(
    policy: RetryPolicy,
    attempt: int,
    retry_after: float | None = None,
) -> float:
    """Seconds to sleep before retry *attempt* (1-based).

    Honors the provider's ``Retry-After`` header when present, otherwise
    exponential backoff (base * factor^(attempt-1)) — both capped and jittered.
    """
    if policy.cap <= 0:
        raw = 0.0
    elif retry_after is not None and retry_after > 0:
        raw = min(retry_after, policy.cap)
    else:
        if policy.base_delay <= 0:
            raw = 0.0
        elif policy.factor <= 1 or attempt <= 1:
            raw = min(policy.base_delay, policy.cap)
        else:
            saturation = math.log(policy.cap / policy.base_delay, policy.factor)
            raw = policy.cap if attempt - 1 >= saturation else policy.base_delay * (policy.factor ** (attempt - 1))
    lo = max(0.0, raw * (1 - policy.jitter))
    hi = raw * (1 + policy.jitter)
    return random.uniform(lo, hi)
