"""Token estimation and budget management.

Provides lightweight token counting (heuristic-based by default, swappable
for tiktoken later) and budget calculations that determine when the context
window is getting full.
"""

from __future__ import annotations

from typing import Callable


# ---------------------------------------------------------------------------
# Token estimation
# ---------------------------------------------------------------------------

def _heuristic_token_count(text: str) -> int:
    """Estimate token count using a simple character-based heuristic.

    ~4 characters per token is a reasonable average for English text
    across most tokenizers (GPT-4, Llama, Mistral, etc.).
    """
    return len(text) // 4


# Pluggable token counter — swap this for tiktoken later
_token_counter: Callable[[str], int] = _heuristic_token_count


def resolve_token_counter() -> Callable[[str], int]:
    """Return the current token counting function."""
    return _token_counter


def set_token_counter(fn: Callable[[str], int]) -> None:
    """Override the token counting function (e.g. for tiktoken)."""
    global _token_counter
    _token_counter = fn


def estimate_tokens(text: str) -> int:
    """Estimate the number of tokens in *text*."""
    return _token_counter(text)


# ---------------------------------------------------------------------------
# Budget calculation
# ---------------------------------------------------------------------------

def estimate_messages_tokens(messages: list[dict]) -> int:
    """Estimate total tokens across a list of OpenAI-format messages.

    Each message is estimated as: role overhead (~4 tokens) + content tokens.
    """
    total = 0
    for msg in messages:
        total += 4  # role/message overhead
        content = msg.get("content", "")
        if content:
            total += estimate_tokens(content)
        # Tool calls add overhead
        if "tool_calls" in msg:
            for tc in msg["tool_calls"]:
                fn = tc.get("function", {})
                total += estimate_tokens(fn.get("name", "")) + estimate_tokens(fn.get("arguments", ""))
        # Tool result content
        if msg.get("role") == "tool":
            total += estimate_tokens(content)
    return total


def _default_reserved_output() -> int:
    """Tokens reserved for the model's response (env XVIE_RESERVED_OUTPUT)."""
    import os as _os
    try:
        return max(2000, int(_os.getenv("XVIE_RESERVED_OUTPUT", "4000")))
    except ValueError:
        return 4000


def calculate_budget(
    messages: list[dict],
    context_window: int,
    reserved_output: int | None = None,
) -> dict:
    """Calculate remaining token budget for the context window.

    Args:
        messages: The current message list (OpenAI format).
        context_window: Maximum context window size in tokens.
        reserved_output: Tokens reserved for the model's response.

    Returns:
        Dict with ``used_tokens``, ``remaining_tokens``,
        ``exceeds_soft_limit``, ``exceeds_hard_limit``.
    """
    used = estimate_messages_tokens(messages)
    if reserved_output is None:
        reserved_output = _default_reserved_output()
    remaining = context_window - used - reserved_output

    soft_threshold = int(context_window * 0.15)  # < 15% remaining

    return {
        "used_tokens": used,
        "remaining_tokens": remaining,
        "exceeds_soft_limit": remaining < soft_threshold,
        "exceeds_hard_limit": remaining <= 0,
        "context_window": context_window,
        "reserved_output": reserved_output,
    }
