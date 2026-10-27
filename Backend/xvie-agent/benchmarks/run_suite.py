"""Benchmark suite for xvie-agent.

Runs a set of predefined tasks against the agent and reports pass/fail,
tokens used, and latency per task.  Results are stored as JSON for
comparison over time.

Usage:
    python -m benchmarks.run_suite --limit 5
    python -m benchmarks.run_suite --lane coding --limit 10
    python -m benchmarks.run_suite --limit 5 -o benchmarks/results/before.json
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

import yaml


# ---------------------------------------------------------------------------
# Task loading
# ---------------------------------------------------------------------------

TASKS_DIR = Path(__file__).resolve().parent / "tasks"


@dataclass
class Task:
    """A single benchmark task."""

    id: str
    name: str
    lane: str
    prompt: str
    fixtures: list[dict[str, str]]
    checkers: list[dict[str, Any]]


def load_tasks(lane: str | None = None) -> list[Task]:
    """Load all task YAML files, optionally filtered by lane."""
    tasks: list[Task] = []
    for path in sorted(TASKS_DIR.glob("*.yaml")):
        with open(path, encoding="utf-8") as f:
            data = yaml.safe_load(f)
        task = Task(
            id=data.get("id", path.stem),
            name=data.get("name", path.stem),
            lane=data.get("lane", "coding"),
            prompt=data.get("prompt", ""),
            fixtures=data.get("fixtures", []),
            checkers=data.get("checkers", []),
        )
        if lane is None or task.lane == lane:
            tasks.append(task)
    return tasks


# ---------------------------------------------------------------------------
# Fixture setup
# ---------------------------------------------------------------------------


def setup_fixtures(fixtures: list[dict[str, str]], workspace: Path) -> None:
    """Write fixture files into the workspace directory."""
    workspace.mkdir(parents=True, exist_ok=True)
    for fixture in fixtures:
        path = workspace / fixture["path"]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(fixture["content"], encoding="utf-8")


# ---------------------------------------------------------------------------
# Checker evaluation
# ---------------------------------------------------------------------------


def evaluate_checker(checker: dict, result: Any, workspace: Path) -> tuple[bool, str]:
    """Evaluate a single checker against the agent result.

    Returns (passed, detail_message).
    """
    ctype = checker.get("type", "")

    if ctype == "output_contains":
        expected = checker.get("expected", "")
        if expected.lower() in (result.final_output or "").lower():
            return True, f"Output contains '{expected}'"
        return False, f"Output missing '{expected}'"

    elif ctype == "file_contains":
        filepath = workspace / checker.get("file", "")
        expected = checker.get("expected", "")
        if not filepath.exists():
            return False, f"File {filepath.name} does not exist"
        content = filepath.read_text(encoding="utf-8")
        if expected.lower() in content.lower():
            return True, f"{filepath.name} contains '{expected}'"
        return False, f"{filepath.name} missing '{expected}'"

    elif ctype == "not_error":
        if result.stop_reason in ("completed", "max_turns"):
            return True, f"Stop reason: {result.stop_reason}"
        return False, f"Unexpected stop reason: {result.stop_reason}"

    return False, f"Unknown checker type: {ctype}"


# ---------------------------------------------------------------------------
# Task runner
# ---------------------------------------------------------------------------


@dataclass
class TaskResult:
    """Result of running a single benchmark task."""

    task_id: str
    task_name: str
    lane: str
    passed: bool
    check_results: list[dict[str, Any]]
    turns: int = 0
    tool_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    cost_usd: float = 0.0
    latency_seconds: float = 0.0
    model_calls: dict[str, int] = field(default_factory=dict)
    stop_reason: str = ""
    stage_timings: dict[str, float] = field(default_factory=dict)


def run_task(
    task: Task,
    *,
    allow_write: bool = True,
    allow_shell: bool = False,
    api_key: str = "",
    provider_name: str = "",
    base_url: str = "",
    model: str = "nvidia/nemotron-3-ultra-550b-a55b",
) -> TaskResult:
    """Run a single benchmark task and evaluate its checkers."""
    from xvie_agent.loop import run_agent
    from xvie_agent.types import BudgetConfig

    with tempfile.TemporaryDirectory(prefix="forge-bench-") as tmpdir:
        workspace = Path(tmpdir)
        setup_fixtures(task.fixtures, workspace)

        start = time.monotonic()
        result = run_agent(
            prompt=task.prompt,
            model=model,
            workspace_root=workspace,
            allow_write=allow_write,
            allow_shell=allow_shell,
            budget=BudgetConfig(max_turns=10, max_tool_calls=15),
            max_turns=10,
            api_key=api_key,
            provider_name=provider_name,
            base_url=base_url,
            lane=task.lane,
        )
        latency = time.monotonic() - start
        # Check generated artifacts before TemporaryDirectory removes them.
        check_results = []
        all_passed = True
        for checker in task.checkers:
            passed, detail = evaluate_checker(checker, result, workspace)
            check_results.append({
                "type": checker.get("type", ""),
                "passed": passed,
                "detail": detail,
            })
            if not passed:
                all_passed = False

    # If no checkers, default to checking it completed
    if not check_results:
        passed = result.stop_reason in ("completed", "max_turns")
        check_results.append({
            "type": "not_error",
            "passed": passed,
            "detail": f"Stop reason: {result.stop_reason}",
        })
        all_passed = passed

    # Cost estimate (NVIDIA pricing)
    cost = (result.usage.input_tokens * 0.15 + result.usage.output_tokens * 0.60) / 1_000_000

    return TaskResult(
        task_id=task.id,
        task_name=task.name,
        lane=task.lane,
        passed=all_passed,
        check_results=check_results,
        turns=result.turns,
        tool_calls=len(result.tool_calls),
        input_tokens=result.usage.input_tokens,
        output_tokens=result.usage.output_tokens,
        total_tokens=result.usage.total_tokens,
        cost_usd=cost,
        latency_seconds=round(latency, 2),
        model_calls=result.model_calls_by_model,
        stop_reason=result.stop_reason,
        stage_timings=result.timings,
    )


# ---------------------------------------------------------------------------
# Suite runner
# ---------------------------------------------------------------------------


def run_suite(
    *,
    lane: str | None = None,
    limit: int | None = None,
    output: str | None = None,
    api_key: str = "",
    provider_name: str = "",
    base_url: str = "",
    model: str = "nvidia/nemotron-3-ultra-550b-a55b",
) -> dict:
    """Run the benchmark suite and print results.

    Returns a summary dict suitable for JSON serialization.
    """
    tasks = load_tasks(lane=lane)
    if limit:
        tasks = tasks[:limit]

    if not tasks:
        print("No tasks found.")
        return {"tasks": [], "total": 0, "passed": 0, "failed": 0}

    print(f"Running {len(tasks)} benchmark tasks" + (f" (lane={lane})" if lane else "") + "...")
    print()

    results: list[TaskResult] = []
    total_tokens = 0
    passed_count = 0

    for task in tasks:
        print(f"  [{task.id}] {task.name} ... ", end="", flush=True)
        try:
            result = run_task(
                task,
                api_key=api_key,
                provider_name=provider_name,
                base_url=base_url,
                model=model,
            )
            results.append(result)
            total_tokens += result.total_tokens

            if result.passed:
                passed_count += 1
                print(f"PASS ({result.latency_seconds}s, {result.total_tokens} tokens)")
            else:
                failed_checks = [c for c in result.check_results if not c["passed"]]
                reason = failed_checks[0]["detail"] if failed_checks else "unknown"
                print(f"FAIL ({result.latency_seconds}s) — {reason}")

        except Exception as exc:
            print(f"ERROR — {exc}")
            results.append(TaskResult(
                task_id=task.id,
                task_name=task.name,
                lane=task.lane,
                passed=False,
                check_results=[{"type": "error", "passed": False, "detail": str(exc)}],
                stop_reason="exception",
            ))

    # Summary
    failed_count = len(results) - passed_count
    pass_rate = passed_count / len(results) * 100 if results else 0
    total_cost = sum(r.cost_usd for r in results)
    total_latency = sum(r.latency_seconds for r in results)

    print()
    print(f"Results: {passed_count}/{len(results)} passed ({pass_rate:.0f}%)")
    print(f"Total tokens: {total_tokens:,}")
    print(f"Total cost: ${total_cost:.4f}")
    print(f"Total latency: {total_latency:.1f}s")

    # Aggregate model usage
    all_model_calls: dict[str, int] = {}
    for r in results:
        for model_name, count in r.model_calls.items():
            all_model_calls[model_name] = all_model_calls.get(model_name, 0) + count
    if all_model_calls:
        print("Model usage:")
        for model_name, count in sorted(all_model_calls.items()):
            print(f"  {model_name}: {count} calls")

    # Build output dict
    summary = {
        "total": len(results),
        "passed": passed_count,
        "failed": failed_count,
        "pass_rate": round(pass_rate, 1),
        "total_tokens": total_tokens,
        "total_cost_usd": round(total_cost, 6),
        "total_latency_seconds": round(total_latency, 2),
        "model_usage": all_model_calls,
        "tasks": [asdict(r) for r in results],
    }

    # Save results
    if output:
        output_path = Path(output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(summary, f, indent=2, default=str)
        print(f"\nResults saved to {output_path}")

    return summary


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description="xvie-agent benchmark suite")
    parser.add_argument("--lane", default=None, help="Filter by routing lane")
    parser.add_argument("--limit", type=int, default=None, help="Max tasks to run")
    parser.add_argument("-o", "--output", default=None, help="Output JSON file path")
    parser.add_argument("--model", default="nvidia/nemotron-3-ultra-550b-a55b")
    parser.add_argument("--api-key", default="")
    parser.add_argument("--provider", default="", dest="provider_name")
    parser.add_argument("--base-url", default="")
    args = parser.parse_args()

    # Load API key from env if not provided
    if not args.api_key:
        from dotenv import load_dotenv
        import os
        load_dotenv()
        args.api_key = os.getenv("FORGE_PROVIDER_NVIDIA_API_KEY", "")

    run_suite(
        lane=args.lane,
        limit=args.limit,
        output=args.output,
        api_key=args.api_key,
        provider_name=args.provider_name,
        base_url=args.base_url,
        model=args.model,
    )


if __name__ == "__main__":
    main()
