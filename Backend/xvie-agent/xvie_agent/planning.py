"""Plan parsing — extract step prompts from a generated plan Markdown file.

Provides ``plan_to_run_requests(plan_path)`` which parses a plan generated
by the ``write_plan`` tool back into an ordered list of step prompts suitable
for feeding one at a time into a normal "act" mode run.
"""

from __future__ import annotations

import re
from pathlib import Path


def plan_to_run_requests(plan_path: Path) -> list[str]:
    """Parse a plan Markdown file into a list of step prompts.

    This is a **round-trip parser** for the specific Markdown template
    produced by the ``write_plan`` tool — it does NOT try to parse
    arbitrary Markdown.

    The expected format is::

        # Title
        Summary paragraph.
        ## Steps
        - [ ] **Step title** — Description  (files: `a.py`, `b.py`)
        - [ ] **Another step** — More description
        ## Risks & open questions
        - Risk 1

    Args:
        plan_path: Path to the plan ``.md`` file.

    Returns:
        An ordered list of step prompt strings, each combining the step
        title and description into a natural-language instruction.
    """
    raw = plan_path.read_text(encoding="utf-8")
    return _parse_plan_steps(raw)


def _parse_plan_steps(raw: str) -> list[str]:
    """Extract step prompts from plan Markdown content."""
    steps: list[str] = []

    # Find the ## Steps section
    steps_match = re.search(r"^## Steps\s*$", raw, re.MULTILINE)
    if not steps_match:
        return steps

    # Extract everything between ## Steps and the next ## or end of file
    after_steps = raw[steps_match.end():]
    next_section = re.search(r"^## ", after_steps, re.MULTILINE)
    if next_section:
        steps_text = after_steps[:next_section.start()]
    else:
        steps_text = after_steps

    # Parse individual steps: "- [ ] **Title** — Description (files: ...)"
    # Accept em-dash, en-dash, or hyphen separators (weak models mix them).
    step_pattern = re.compile(
        r"^-\s*\[\s*\]\s*\*\*(.+?)\*\*\s*[—–-]\s*(.+?)(?:\s*\(files:.*\))?\s*$",
        re.MULTILINE,
    )

    for match in step_pattern.finditer(steps_text):
        title = match.group(1).strip()
        description = match.group(2).strip()
        prompt = f"{title}: {description}"
        steps.append(prompt)

    return steps
