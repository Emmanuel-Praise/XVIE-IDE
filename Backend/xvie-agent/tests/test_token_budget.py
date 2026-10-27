"""Tests for xvie_agent.token_budget and session tombstoning."""

from __future__ import annotations

from pathlib import Path

import pytest

from xvie_agent.session import AgentMessage, SessionState
from xvie_agent.token_budget import (
    calculate_budget,
    estimate_messages_tokens,
    estimate_tokens,
    set_token_counter,
)
from xvie_agent.types import ToolCall, UsageStats


# ---------------------------------------------------------------------------
# Token estimation
# ---------------------------------------------------------------------------

class TestEstimateTokens:
    def test_empty_string(self) -> None:
        assert estimate_tokens("") == 0

    def test_english_text(self) -> None:
        # 4 chars ≈ 1 token, so 100 chars ≈ 25 tokens
        text = "a" * 100
        assert estimate_tokens(text) == 25

    def test_single_char(self) -> None:
        assert estimate_tokens("a") == 0  # len("a") // 4 = 0

    def test_custom_counter(self) -> None:
        original = estimate_tokens  # save
        try:
            set_token_counter(lambda t: len(t))  # char count
            assert estimate_tokens("hello") == 5
        finally:
            set_token_counter(lambda t: len(t) // 4)  # restore


# ---------------------------------------------------------------------------
# Budget calculation
# ---------------------------------------------------------------------------

class TestCalculateBudget:
    def test_empty_messages(self) -> None:
        budget = calculate_budget([], context_window=8000)
        assert budget["used_tokens"] == 0
        assert budget["remaining_tokens"] == 4000  # 8000 - 0 - 4000 reserved
        assert budget["exceeds_soft_limit"] is False
        assert budget["exceeds_hard_limit"] is False

    def test_messages_with_content(self) -> None:
        messages = [
            {"role": "system", "content": "You are helpful."},  # ~4 + ~1 = 5 tokens
            {"role": "user", "content": "a" * 1000},  # ~4 + 250 = 254
        ]
        budget = calculate_budget(messages, context_window=8000)
        assert budget["used_tokens"] > 250
        assert budget["remaining_tokens"] > 3000

    def test_soft_limit_exceeded(self) -> None:
        # 8000 * 15% = 1200, so if remaining < 1200, soft limit exceeded
        # Used = 8000 - 2000 (reserved) - 1199 = 4801
        messages = [{"role": "user", "content": "a" * (4801 * 4)}]
        budget = calculate_budget(messages, context_window=8000)
        assert budget["exceeds_soft_limit"] is True

    def test_hard_limit_exceeded(self) -> None:
        # If used + reserved > context_window, hard limit exceeded
        messages = [{"role": "user", "content": "a" * (7000 * 4)}]
        budget = calculate_budget(messages, context_window=8000)
        assert budget["exceeds_hard_limit"] is True

    def test_tool_calls_add_overhead(self) -> None:
        messages = [
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "c1",
                        "type": "function",
                        "function": {
                            "name": "read_file",
                            "arguments": '{"path": "main.py"}',
                        },
                    }
                ],
            },
        ]
        budget = calculate_budget(messages, context_window=8000)
        assert budget["used_tokens"] >= 10  # Should have some overhead


# ---------------------------------------------------------------------------
# Session tombstoning
# ---------------------------------------------------------------------------

class TestTombstoning:
    def _build_session_with_turns(self, n_turns: int) -> SessionState:
        """Build a session with n_turns user-assistant-tool round trips."""
        s = SessionState(system_prompt="System")
        s.append_user("Turn 0")
        for i in range(n_turns):
            tc = ToolCall(id=f"c{i}", name="read_file", arguments={"path": f"file_{i}.py"})
            s.append_assistant("", tool_calls=[tc])
            s.append_tool_result(
                tool_call_id=f"c{i}",
                content=f"Contents of file_{i}.py: " + "x" * 500,
                name="read_file",
            )
            s.append_assistant(f"Summary of file {i}")
            if i < n_turns - 1:
                s.append_user(f"Turn {i + 1}")
        return s

    def test_no_tombstoning_when_few_turns(self) -> None:
        s = self._build_session_with_turns(3)
        s.tombstone_oldest_tool_results(keep_last_n_turns=4)
        # All tool results should still have full content
        for msg in s.messages:
            if msg.role == "tool":
                assert "Contents of file_" in msg.content

    def test_tombstoning_replaces_old_results(self) -> None:
        s = self._build_session_with_turns(8)
        s.tombstone_oldest_tool_results(keep_last_n_turns=4)
        # Old tool results should be tombstoned
        tombstoned = [m for m in s.messages if m.role == "tool" and m.content.startswith("[tool result omitted")]
        intact = [m for m in s.messages if m.role == "tool" and "Contents of file_" in m.content]
        assert len(tombstoned) > 0
        assert len(intact) == 4  # last 4 turns kept

    def test_tombstoning_reduces_tokens(self) -> None:
        s = self._build_session_with_turns(10)
        messages_before = s.to_openai_messages()
        tokens_before = estimate_messages_tokens(messages_before)

        s.tombstone_oldest_tool_results(keep_last_n_turns=4)
        messages_after = s.to_openai_messages()
        tokens_after = estimate_messages_tokens(messages_after)

        assert tokens_after < tokens_before
        savings = tokens_before - tokens_after
        assert savings > 100, f"Expected significant token savings, got {savings}"

    def test_tombstoning_idempotent(self) -> None:
        """Calling tombstone twice shouldn't double-tombstone."""
        s = self._build_session_with_turns(6)
        s.tombstone_oldest_tool_results(keep_last_n_turns=4)
        s.tombstone_oldest_tool_results(keep_last_n_turns=4)
        # No message should be double-tombstoned
        for msg in s.messages:
            assert msg.content.count("[tool result omitted") <= 1

    def test_preserves_user_assistant_messages(self) -> None:
        """User and assistant messages are never touched."""
        s = self._build_session_with_turns(6)
        s.tombstone_oldest_tool_results(keep_last_n_turns=4)
        # Check user messages survived
        user_msgs = [m for m in s.messages if m.role == "user"]
        assert len(user_msgs) > 0
        for m in user_msgs:
            assert "Turn" in m.content

    def test_synthetic_50_turn_session(self) -> None:
        """The spec's test: a 50-turn session should tombstone, not crash."""
        s = self._build_session_with_turns(50)
        # This should not raise
        s.tombstone_oldest_tool_results(keep_last_n_turns=4)
        # Token count should be manageable
        messages = s.to_openai_messages()
        tokens = estimate_messages_tokens(messages)
        assert tokens < 50_000  # Should be well under any context window
