"""Configuration loading — provider-agnostic, env-var driven.

Provider keys follow the convention::

    FORGE_PROVIDER_<NAME>_API_KEY=nvapi-...
    FORGE_PROVIDER_<NAME>_BASE_URL=https://integrate.api.nvidia.com/v1

Every provider gets exactly two env vars.  The ``<NAME>`` part becomes
the ``provider`` field on :class:`ProviderConfig` and is case-insensitive
(stored lowercase internally).

Multiple providers can coexist — the router (Phase 8) decides which one
to use per turn.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from dotenv import load_dotenv


@dataclass(frozen=True)
class ProviderConfig:
    """Connection details for a single provider."""

    name: str
    api_key: str
    base_url: str


@dataclass
class Config:
    """Central configuration for the agent engine.

    ``providers`` is a dict keyed by lowercase provider name (e.g.
    ``"nvidia"``, ``"openrouter"``).  Each entry carries the API key
    and base URL for that provider.
    """

    providers: dict[str, ProviderConfig] = field(default_factory=dict)
    default_model: str = "nvidia/nemotron-3-ultra-550b-a55b"
    default_provider: str = "nvidia"
    max_turns: int = 50
    budget_tokens: int = 100_000
    log_level: str = "INFO"

    # --- Convenience accessors ---

    def get_provider(self, name: str) -> ProviderConfig | None:
        """Look up a provider by name (case-insensitive)."""
        return self.providers.get(name.lower())

    def primary_provider(self) -> ProviderConfig | None:
        """Return the default provider, or the first configured one."""
        p = self.providers.get(self.default_provider)
        if p:
            return p
        # Fall back to first configured provider
        return next(iter(self.providers.values()), None)


def _discover_providers() -> dict[str, ProviderConfig]:
    """Scan env vars for FORGE_PROVIDER_<NAME>_API_KEY / _BASE_URL pairs."""
    providers: dict[str, ProviderConfig] = {}
    prefix = "FORGE_PROVIDER_"

    # Collect all provider names from API_KEY vars
    for key, value in os.environ.items():
        if not key.startswith(prefix) or not key.endswith("_API_KEY") or not value:
            continue
        # Extract provider name: FORGE_PROVIDER_NVIDIA_API_KEY → "nvidia"
        name = key[len(prefix) : -len("_API_KEY")].lower()
        base_url_key = f"{prefix}{name.upper()}_BASE_URL"
        base_url = os.getenv(base_url_key, "")
        if base_url:
            providers[name] = ProviderConfig(name=name, api_key=value, base_url=base_url)

    return providers


def load_config(env_file: str | None = None) -> Config:
    """Load configuration from .env (if present) and environment variables.

    This function:
    1. Loads the .env file if it exists.
    2. Discovers all ``FORGE_PROVIDER_<NAME>_*`` pairs.
    3. Falls back to legacy ``OPENROUTER_API_KEY`` / ``NVIDIA_API_KEY`` env
       vars for backward compatibility.
    """
    load_dotenv(env_file or ".env")

    providers = _discover_providers()

    # --- Backward-compatible fallbacks for legacy single-key env vars ---
    # If someone still has NVIDIA_API_KEY set without the FORGE_ prefix,
    # synthesise a provider config from it.
    if "nvidia" not in providers:
        nvidia_key = os.getenv("NVIDIA_API_KEY", "")
        nvidia_url = os.getenv("NVIDIA_BASE_URL", "")
        if nvidia_key and nvidia_url:
            providers["nvidia"] = ProviderConfig(
                name="nvidia", api_key=nvidia_key, base_url=nvidia_url,
            )

    if "openrouter" not in providers:
        or_key = os.getenv("OPENROUTER_API_KEY", "")
        if or_key:
            providers["openrouter"] = ProviderConfig(
                name="openrouter",
                api_key=or_key,
                base_url="https://openrouter.ai/api/v1",
            )

    # --- Detect default provider ---
    default_provider = os.getenv("FORGE_DEFAULT_PROVIDER", "")
    if not default_provider:
        # Heuristic: if nvidia is configured, prefer it; else first available
        if "nvidia" in providers:
            default_provider = "nvidia"
        else:
            default_provider = next(iter(providers), "nvidia")

    return Config(
        providers=providers,
        default_model=os.getenv(
            "DEFAULT_MODEL",
            os.getenv("FORGE_DEFAULT_MODEL", "nvidia/nemotron-3-ultra-550b-a55b"),
        ),
        default_provider=default_provider,
        max_turns=int(os.getenv("MAX_TURNS", "50")),
        budget_tokens=int(os.getenv("BUDGET_TOKENS", "100000")),
        log_level=os.getenv("LOG_LEVEL", "INFO"),
    )
