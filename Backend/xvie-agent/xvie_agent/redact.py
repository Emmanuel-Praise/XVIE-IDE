"""Secret redaction for tool outputs.

Applies regex-based replacement to strip common secret patterns from text
before it enters the model context window.  This prevents accidental leakage
of API keys, tokens, and credentials through tool results.

The redactor is intentionally aggressive — false positives on legitimate
secrets are far safer than leaking real ones.
"""

from __future__ import annotations

import re


# ---------------------------------------------------------------------------
# Patterns — ordered most-specific to least-specific
# ---------------------------------------------------------------------------

_PATTERNS: list[tuple[str, str]] = [
    # NVIDIA NIM keys
    (r"nvapi-[A-Za-z0-9_-]{20,}", "[REDACTED]"),
    # OpenAI-style API keys
    (r"sk-[A-Za-z0-9_-]{20,}", "[REDACTED]"),
    # OpenRouter keys
    (r"sk-or-[A-Za-z0-9_-]{20,}", "[REDACTED]"),
    # AWS access key IDs
    (r"AKIA[0-9A-Z]{16}", "[REDACTED]"),
    # GitHub personal access tokens (classic)
    (r"ghp_[A-Za-z0-9]{36,}", "[REDACTED]"),
    # GitHub fine-grained tokens
    (r"gho_[A-Za-z0-9]{36,}", "[REDACTED]"),
    # GitHub OAuth tokens
    (r"ghu_[A-Za-z0-9]{36,}", "[REDACTED]"),
    # GitHub refresh tokens
    (r"ghr_[A-Za-z0-9]{36,}", "[REDACTED]"),
    # Google API keys
    (r"AIza[0-9A-Za-z_-]{35}", "[REDACTED]"),
    # Bearer tokens in headers (Authorization: Bearer <token>)
    (r"(Bearer\s+)[A-Za-z0-9._-]{20,}", r"\1[REDACTED]"),
    # Generic hex/base64 secrets assigned to *_KEY, *_SECRET, *_TOKEN variables
    # Matches lines like:  API_KEY = "abc123def456..." or MY_SECRET=xyz
    (r'((?:_KEY|_SECRET|_TOKEN|_PASSWORD|_CREDENTIAL)\s*[=:]\s*["\']?)[A-Za-z0-9/+=._-]{20,}(["\']?)', r"\1[REDACTED]\2"),
    # Generic hex strings of 32+ chars (likely hashes/tokens)
    (r'\b[0-9a-f]{32,}\b', "[REDACTED]"),
]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def redact_secrets(text: str) -> str:
    """Replace common secret patterns with ``[REDACTED]``.

    Applies patterns in order.  Each pattern is applied independently so
    overlapping matches don't interfere.

    Args:
        text: Raw tool output that may contain secrets.

    Returns:
        Sanitized text with all detected secrets replaced.
    """
    if not text:
        return text
    result = text
    for pattern, replacement in _PATTERNS:
        result = re.sub(pattern, replacement, result)
    return result
