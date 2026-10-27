"""Unit tests for xvie_agent.retry — transient error detection and backoff."""

from xvie_agent.providers.base import (
    AuthError,
    ModelDoesNotSupportToolsError,
    OutOfCreditsError,
    ProviderError,
    RateLimitedError,
)
from xvie_agent.retry import RetryPolicy, is_transient_error, retry_delay


class TestIsTransientError:
    def test_rate_limited(self) -> None:
        assert is_transient_error(RateLimitedError("429"))

    def test_server_error_500(self) -> None:
        assert is_transient_error(ProviderError("500", status_code=500))

    def test_bad_gateway_502(self) -> None:
        assert is_transient_error(ProviderError("502", status_code=502))

    def test_service_unavailable_503(self) -> None:
        assert is_transient_error(ProviderError("503", status_code=503))

    def test_gateway_timeout_504(self) -> None:
        assert is_transient_error(ProviderError("504", status_code=504))

    def test_network_timeout_status_0(self) -> None:
        assert is_transient_error(ProviderError("timeout", status_code=0))

    def test_auth_error_not_transient(self) -> None:
        assert not is_transient_error(AuthError("401", status_code=401))

    def test_out_of_credits_not_transient(self) -> None:
        assert not is_transient_error(OutOfCreditsError("402", status_code=402))

    def test_model_does_not_support_tools_not_transient(self) -> None:
        assert not is_transient_error(
            ModelDoesNotSupportToolsError("no tools", status_code=0)
        )

    def test_bad_request_not_transient(self) -> None:
        assert not is_transient_error(ProviderError("400", status_code=400))


class TestRetryDelay:
    def test_first_retry_uses_base_delay(self) -> None:
        p = RetryPolicy(max_retries=5, base_delay=2.0, factor=2.0, cap=60.0, jitter=0.0)
        assert retry_delay(p, attempt=1, retry_after=None) == 2.0

    def test_exponential_growth(self) -> None:
        p = RetryPolicy(max_retries=5, base_delay=2.0, factor=2.0, cap=60.0, jitter=0.0)
        assert retry_delay(p, attempt=1) == 2.0
        assert retry_delay(p, attempt=2) == 4.0
        assert retry_delay(p, attempt=3) == 8.0
        assert retry_delay(p, attempt=4) == 16.0
        assert retry_delay(p, attempt=5) == 32.0

    def test_cap_is_respected(self) -> None:
        p = RetryPolicy(max_retries=20, base_delay=1.0, factor=3.0, cap=10.0, jitter=0.0)
        assert retry_delay(p, attempt=100) == 10.0

    def test_retry_after_takes_precedence(self) -> None:
        p = RetryPolicy(max_retries=5, base_delay=2.0, factor=2.0, cap=60.0, jitter=0.0)
        assert retry_delay(p, attempt=1, retry_after=30.0) == 30.0

    def test_retry_after_capped(self) -> None:
        p = RetryPolicy(max_retries=5, base_delay=2.0, factor=2.0, cap=10.0, jitter=0.0)
        assert retry_delay(p, attempt=1, retry_after=100.0) == 10.0

    def test_jitter_adds_variation(self) -> None:
        p = RetryPolicy(max_retries=5, base_delay=10.0, factor=1.0, cap=60.0, jitter=0.5)
        delays = [retry_delay(p, attempt=1) for _ in range(20)]
        # All should be within ±50% of 10.0
        assert all(5.0 <= d <= 15.0 for d in delays)
        # And there should be at least some spread
        assert max(delays) - min(delays) > 1.0