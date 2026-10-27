from __future__ import annotations

from types import SimpleNamespace

from benchmarks.run_suite import Task, run_task
from xvie_agent.types import UsageStats


def test_file_checkers_run_before_temporary_workspace_is_removed(monkeypatch) -> None:
    def fake_run_agent(*, workspace_root, **kwargs):
        (workspace_root / "result.txt").write_text("created artifact", encoding="utf-8")
        return SimpleNamespace(
            final_output="Done",
            stop_reason="completed",
            turns=1,
            tool_calls=(),
            usage=UsageStats(input_tokens=10, output_tokens=4),
            model_calls_by_model={"test-model": 1},
            timings={"provider_seconds": 0.2, "tool_seconds": 0.1},
        )

    monkeypatch.setattr("xvie_agent.loop.run_agent", fake_run_agent)
    task = Task(
        id="artifact",
        name="Write artifact",
        lane="coding",
        prompt="Create result.txt",
        fixtures=[],
        checkers=[{"type": "file_contains", "file": "result.txt", "expected": "artifact"}],
    )

    result = run_task(task, model="test-model")

    assert result.passed
    assert result.check_results[0]["passed"]
    assert result.stage_timings["provider_seconds"] == 0.2
