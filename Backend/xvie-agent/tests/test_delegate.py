"""Tests for xvie_agent.delegate — sub-agent delegation with fake clients."""

from __future__ import annotations

from pathlib import Path

import pytest

from xvie_agent.delegate import (
    SubtaskRequest,
    SubtaskResult,
    _run_subtask,
    delegate_handler,
)
from xvie_agent.tools import ToolContext


# ---------------------------------------------------------------------------
# Fake run_agent for testing
# ---------------------------------------------------------------------------

_original_run = None


def _make_fake_run_agent(responses: list[tuple[str, str]]):
    """Create a fake run_agent that returns canned (stop_reason, final_output) pairs."""
    from xvie_agent.types import AgentRunResult, UsageStats

    call_count = 0

    def fake_run_agent(**kwargs):
        nonlocal call_count
        if call_count >= len(responses):
            stop, output = "completed", "default"
        else:
            stop, output = responses[call_count]
        call_count += 1
        return AgentRunResult(
            final_output=output,
            turns=1,
            tool_calls=(),
            usage=UsageStats(input_tokens=10, output_tokens=5),
            stop_reason=stop,
        )

    return fake_run_agent


# ---------------------------------------------------------------------------
# delegate_handler tests
# ---------------------------------------------------------------------------

@pytest.fixture()
def sandbox(tmp_path: Path) -> Path:
    (tmp_path / "test.py").write_text("x = 1\n")
    return tmp_path


class TestDelegateHandler:
    def test_no_subtasks(self, sandbox: Path) -> None:
        ctx = ToolContext(workspace_root=sandbox)
        result = delegate_handler({"subtasks": []}, ctx, api_key="fake")
        assert result.ok is False
        assert result.error_kind == "missing_argument"

    def test_no_api_key(self, sandbox: Path) -> None:
        ctx = ToolContext(workspace_root=sandbox)
        result = delegate_handler(
            {"subtasks": [{"prompt": "do stuff"}]},
            ctx,
            api_key="",
        )
        assert result.ok is False
        assert result.error_kind == "no_api_key"

    def test_single_subtask_ok(self, sandbox: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        fake = _make_fake_run_agent([("completed", "Task done")])
        monkeypatch.setattr("xvie_agent.loop.run_agent", fake)

        ctx = ToolContext(workspace_root=sandbox)
        result = delegate_handler(
            {"subtasks": [{"prompt": "Summarize files"}]},
            ctx,
            api_key="fake",
        )
        assert result.ok is True
        assert "1 succeeded" in result.content
        assert "Task done" in result.content

    def test_partial_failure(self, sandbox: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """2 ok, 1 failed — should not crash."""
        fake = _make_fake_run_agent([
            ("completed", "Result A"),
            ("model_error", ""),
            ("completed", "Result C"),
        ])
        monkeypatch.setattr("xvie_agent.loop.run_agent", fake)

        ctx = ToolContext(workspace_root=sandbox)
        result = delegate_handler(
            {
                "subtasks": [
                    {"prompt": "Task A"},
                    {"prompt": "Task B"},
                    {"prompt": "Task C"},
                ]
            },
            ctx,
            api_key="fake",
        )
        assert result.ok is True
        assert "2 succeeded" in result.content
        assert "1 failed" in result.content

    def test_all_fail(self, sandbox: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        fake = _make_fake_run_agent([
            ("rate_limited", ""),
            ("model_error", ""),
        ])
        monkeypatch.setattr("xvie_agent.loop.run_agent", fake)

        ctx = ToolContext(workspace_root=sandbox)
        result = delegate_handler(
            {"subtasks": [{"prompt": "A"}, {"prompt": "B"}]},
            ctx,
            api_key="fake",
        )
        assert result.ok is True  # delegate itself doesn't crash
        assert "0 succeeded" in result.content
        assert "2 failed" in result.content

    def test_subtask_exception_caught(self, sandbox: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        def exploding_run(**kwargs):
            raise RuntimeError("Unexpected boom")

        monkeypatch.setattr("xvie_agent.loop.run_agent", exploding_run)

        ctx = ToolContext(workspace_root=sandbox)
        result = delegate_handler(
            {"subtasks": [{"prompt": "Crash"}]},
            ctx,
            api_key="fake",
        )
        assert result.ok is True
        assert "1 failed" in result.content
        assert "boom" in result.content
