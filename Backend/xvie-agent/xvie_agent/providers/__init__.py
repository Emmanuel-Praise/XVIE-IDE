"""Provider-agnostic client layer for xvie-agent.

This package provides a single ``ProviderClient`` that talks to any
OpenAI-compatible ``/chat/completions`` endpoint.  The provider is
identified by a ``ProviderConfig`` (name + base_url + api_key), not by
subclassing.
"""

from xvie_agent.providers.base import (  # noqa: F401
    ProviderClient,
    ProviderConfig,
    ProviderError,
    RateLimitedError,
    OutOfCreditsError,
    AuthError,
    ModelDoesNotSupportToolsError,
    PayloadTooLargeError,
)
from xvie_agent.providers.registry import (  # noqa: F401
    load_providers_from_env,
    get_provider,
)
