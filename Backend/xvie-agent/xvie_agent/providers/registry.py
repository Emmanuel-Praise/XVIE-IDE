"""Provider registry — discover and instantiate providers from environment.

Scans ``FORGE_PROVIDER_<NAME>_API_KEY`` / ``FORGE_PROVIDER_<NAME>_BASE_URL``
pairs and builds a ``ProviderClient`` per matched pair.  This is how "any API
key the user provides" gets picked up — set two env vars and it's live, no
code touched.
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

from xvie_agent.providers.base import (
    ProviderClient,
    ProviderConfig,
    _KNOWN_DEFAULTS,
)


def load_providers_from_env() -> dict[str, ProviderClient]:
    """Scan env vars and build a ``ProviderClient`` per configured provider.

    Calls ``load_dotenv()`` first so ``.env`` files are picked up.

    Looks for ``FORGE_PROVIDER_<NAME>_API_KEY`` and
    ``FORGE_PROVIDER_<NAME>_BASE_URL`` pairs.  If ``BASE_URL`` is omitted
    for a well-known provider name (e.g. ``nvidia``, ``openrouter``), falls
    back to that provider's known default base URL.

    Returns:
        A dict keyed by lowercased provider name.
    """
    load_dotenv()

    prefix = "FORGE_PROVIDER_"
    providers: dict[str, ProviderClient] = {}

    # First pass: collect all API keys
    api_keys: dict[str, str] = {}
    for key, value in os.environ.items():
        if not key.startswith(prefix) or not key.endswith("_API_KEY") or not value:
            continue
        name = key[len(prefix):-len("_API_KEY")].lower()
        api_keys[name] = value

    # Second pass: build ProviderConfig + ProviderClient for each
    for name, api_key in api_keys.items():
        base_url_key = f"{prefix}{name.upper()}_BASE_URL"
        base_url = os.getenv(base_url_key, "")

        # Fall back to known defaults if BASE_URL is missing
        if not base_url:
            base_url = _KNOWN_DEFAULTS.get(name, "")

        if not base_url:
            # Can't build a client without a base URL
            continue

        config = ProviderConfig(name=name, api_key=api_key, base_url=base_url)
        providers[name] = ProviderClient(config=config)

    # Meterless/Nightshift exposes an OpenAI-compatible local endpoint and
    # writes its short-lived bearer token to this per-user runtime file.
    # Discover it automatically so users can select it without copying the
    # token into Xvie settings or source-controlled configuration.
    local_app_data = os.getenv("LOCALAPPDATA", "")
    token_path = os.getenv("METERLESS_TOKEN_PATH", "")
    if not token_path and local_app_data:
        token_path = str(Path(local_app_data) / "ai.meterless.runtime" / "proxy-token")
    if token_path:
        try:
            token = Path(token_path).read_text(encoding="utf-8").strip()
        except OSError:
            token = ""
        if token:
            providers["meterless"] = ProviderClient(config=ProviderConfig(
                name="Meterless",
                api_key=token,
                base_url=os.getenv("METERLESS_BASE_URL", "http://127.0.0.1:8088/v1").rstrip("/"),
            ))

    return providers


def get_provider(name: str, providers: dict[str, ProviderClient]) -> ProviderClient:
    """Look up a provider by name with a clear error if not found.

    Args:
        name: Provider name (case-insensitive).
        providers: Dict of configured providers (from ``load_providers_from_env``).

    Returns:
        The matching ``ProviderClient``.

    Raises:
        KeyError: With a descriptive message listing available providers.
    """
    key = name.lower()
    if key not in providers:
        available = ", ".join(sorted(providers.keys())) or "(none configured)"
        raise KeyError(
            f"Provider '{name}' is not configured. "
            f"Available providers: {available}. "
            f"Set FORGE_PROVIDER_{name.upper()}_API_KEY and "
            f"FORGE_PROVIDER_{name.upper()}_BASE_URL to add it."
        )
    return providers[key]
