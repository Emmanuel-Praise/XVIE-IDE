"""Backward-compatible error re-exports.

The canonical location is now ``xvie_agent.providers.base``.  This module
re-exports everything so existing ``from xvie_agent.errors import ...``
statements keep working.
"""

from xvie_agent.providers.base import (  # noqa: F401
    AuthError,
    ModelDoesNotSupportToolsError,
    OutOfCreditsError,
    ProviderError,
    RateLimitedError,
)

# Legacy aliases
OpenRouterError = ProviderError
RateLimitError = RateLimitedError
ModelDoesNotSupportTools = ModelDoesNotSupportToolsError
