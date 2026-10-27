"""Sub-agent delegation for parallel specialist tasks.

Provides a ``delegate`` tool that fans subtasks out to isolated agent loops
running concurrently via :class:`concurrent.futures.ThreadPoolExecutor`.

Each sub-agent gets its own session, tool registry (read-only by default),
and a hard-capped budget so a runaway sub-agent can't consume the parent's
resources.
"""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from xvie_agent.tools import ToolContext, ToolOutput, build_default_registry
from xvie_agent.types import BudgetConfig

logger = logging.getLogger(__name__)


@dataclass
class SubtaskRequest:
    """A single subtask to be delegated."""

    prompt: str
    lane: str = "default"
    allow_write: bool = False


@dataclass
class SubtaskResult:
    """Result of a single delegated subtask."""

    prompt: str
    ok: bool
    output: str
    model: str = ""
    error: str | None = None


# ---------------------------------------------------------------------------
# Default budgets for sub-agents (much tighter than parent)
# ---------------------------------------------------------------------------

SUBTASK_BUDGET = BudgetConfig(
    max_turns=5,
    max_tool_calls=10,
    max_model_calls=5,
)

MAX_PARALLEL = 3


def _run_subtask(
    req: SubtaskRequest,
    workspace_root: Path,
    api_key: str,
    model: str,
) -> SubtaskResult:
    """Run a single subtask in an isolated agent loop.

    """
    from xvie_agent import loop as _loop
    run_agent = _loop.run_agent

    try:
        result = run_agent(
            prompt=req.prompt,
            model=model,
            workspace_root=workspace_root,
            allow_write=req.allow_write,
            allow_shell=False,
            budget=SUBTASK_BUDGET,
            max_turns=5,
            api_key=api_key,
        )
        return SubtaskResult(
            prompt=req.prompt,
            ok=result.stop_reason == "completed",
            output=result.final_output,
            model=model,
            error=None if result.stop_reason == "completed" else f"stop_reason={result.stop_reason}",
        )
    except Exception as exc:
        return SubtaskResult(
            prompt=req.prompt,
            ok=False,
            output="",
            model=model,
            error=str(exc),
        )


def delegate_handler(
    args: dict,
    ctx: ToolContext,
    *,
    api_key: str = "",
    model: str = "nvidia/nemotron-3-ultra-550b-a55b",
    max_parallel: int = MAX_PARALLEL,
) -> ToolOutput:
    """Tool handler for the ``delegate`` function.

    Expects ``args["subtasks"]`` to be a list of dicts with ``prompt`` and
    optional ``lane`` and ``allow_write`` keys.
    """
    raw_subtasks = args.get("subtasks", [])
    if not raw_subtasks:
        return ToolOutput(ok=False, content="No subtasks provided", error_kind="missing_argument")

    if not api_key:
        return ToolOutput(ok=False, content="No API key for sub-agents", error_kind="no_api_key")

    requests: list[SubtaskRequest] = []
    for st in raw_subtasks:
        if isinstance(st, dict) and "prompt" in st:
            requests.append(SubtaskRequest(
                prompt=st["prompt"],
                lane=st.get("lane", "default"),
                allow_write=st.get("allow_write", False),
            ))

    if not requests:
        return ToolOutput(ok=False, content="No valid subtasks found", error_kind="invalid_input")

    # Cap parallelism
    actual_parallel = min(max_parallel, len(requests))

    # Execute subtasks concurrently
    results: list[SubtaskResult] = []
    with ThreadPoolExecutor(max_workers=actual_parallel) as executor:
        futures = {
            executor.submit(
                _run_subtask,
                req,
                ctx.workspace_root,
                api_key,
                model,
            ): req
            for req in requests
        }
        for future in as_completed(futures):
            results.append(future.result())

    # Aggregate results
    ok_count = sum(1 for r in results if r.ok)
    fail_count = len(results) - ok_count

    parts: list[str] = []
    parts.append(f"Delegated {len(results)} subtask(s): {ok_count} succeeded, {fail_count} failed.")
    parts.append("")

    for i, r in enumerate(results, 1):
        status = "OK" if r.ok else "FAILED"
        parts.append(f"--- Subtask {i} ({status}) ---")
        parts.append(f"Prompt: {r.prompt[:120]}")
        if r.model:
            parts.append(f"Model: {r.model}")
        if r.error:
            parts.append(f"Error: {r.error}")
        if r.output:
            parts.append(f"Result:\n{r.output[:2000]}")
        parts.append("")

    return ToolOutput(ok=True, content="\n".join(parts))


# ---------------------------------------------------------------------------
# Tool schema for registration
# ---------------------------------------------------------------------------

DELEGATE_TOOL_SCHEMA = {
    "name": "delegate",
    "description": (
        "Delegate subtasks to parallel specialist agents. Each subtask runs "
        "in isolation with its own session and limited budget. Use for tasks "
        "that benefit from parallel execution (e.g., exploring different parts "
        "of a codebase simultaneously)."
    ),
    "json_schema": {
        "type": "object",
        "properties": {
            "subtasks": {
                "type": "array",
                "description": "List of subtasks to delegate",
                "items": {
                    "type": "object",
                    "properties": {
                        "prompt": {
                            "type": "string",
                            "description": "The prompt/instruction for this subtask",
                        },
                        "lane": {
                            "type": "string",
                            "description": "Optional lane hint (e.g. 'planning', 'coding')",
                            "default": "default",
                        },
                        "allow_write": {
                            "type": "boolean",
                            "description": "Whether this subtask can write files (default: false)",
                            "default": False,
                        },
                    },
                    "required": ["prompt"],
                },
            }
        },
        "required": ["subtasks"],
    },
}
