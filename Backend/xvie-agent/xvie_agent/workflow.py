"""Deterministic task policy used before the model is called."""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class TaskClassification:
    kind: str
    needs_project_inspection: bool
    needs_write_confirmation: bool
    lane: str


_EDIT = re.compile(r"\b(implement|fix|add|apply|create|write|build|modify|change|refactor|update|patch|delete|remove|rename)\b", re.I)
_SUGGEST = re.compile(r"\b(idea|ideas|improvement|improve|suggest|recommend)\b", re.I)
_PROJECT = re.compile(r"\b(project|codebase|repo|repository|this|files?|code)\b", re.I)
_PLAN = re.compile(r"\b(plan|design|approach|architecture)\b", re.I)


def classify_workflow(prompt: str) -> TaskClassification:
    """Classify request intent without relying on a model response."""
    lowered = prompt.strip().lower()
    # A function named "add" is not an edit request. Require an imperative
    # construction for write-capable workflows rather than keyword presence.
    is_question = lowered.endswith("?") or lowered.startswith((
        "what ", "why ", "how ", "where ", "when ", "who ", "read ",
        "tell ", "explain ", "describe ", "show ",
    ))
    edit_intent = bool(_EDIT.search(prompt)) and not is_question
    if edit_intent:
        return TaskClassification("edit", True, True, "reliable")
    if _SUGGEST.search(prompt):
        return TaskClassification("suggest", True, False, "reliable")
    if _PLAN.search(prompt) and _PROJECT.search(prompt):
        return TaskClassification("plan", True, False, "reasoning")
    if _PROJECT.search(prompt):
        return TaskClassification("inspect", True, False, "reliable")
    return TaskClassification("chat", False, False, "fast")
