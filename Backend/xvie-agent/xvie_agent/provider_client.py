"""Backward-compatible client re-exports.

The canonical location is now ``xvie_agent.providers.base``.  This module
re-exports ``ProviderClient`` so existing imports keep working.
"""

from xvie_agent.providers.base import ProviderClient  # noqa: F401
