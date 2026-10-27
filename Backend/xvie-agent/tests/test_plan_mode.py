"""Tests for Phase 14 — plan mode (structured planning, Markdown output)."""

from __future__ import annotations

from pathlib import Path

import pytest

from xvie_agent.planning import plan_to_run_requests
from xvie_agent.tools import ToolContext, build_default_registry


# ---------------------------------------------------------------------------
# write_plan tool
# ---------------------------------------------------------------------------


class TestWritePlanTool:
    def test_write_plan_creates_file(self, tmp_path: Path):
        """write_plan creates a .md file in .xvie/plans/."""
        from xvie_agent.tools import _write_plan

        ctx = ToolContext(workspace_root=tmp_path, allow_write=True, allow_shell=False)
        result = _write_plan(
            {
                "title": "Add Pagination",
                "summary": "Add cursor-based pagination to the API.",
                "steps": [
                    {"title": "Add pagination params", "description": "Accept cursor and limit.", "files_touched": ["api.py"]},
                    {"title": "Update query", "description": "Filter by cursor.", "files_touched": ["db.py"]},
                ],
                "risks": ["Backwards compatibility"],
            },
            ctx,
        )
        assert result.ok is True
        assert ".xvie" in result.content
        assert "plans" in result.content

        # Verify the file exists and has the right content
        plans_dir = tmp_path / ".xvie" / "plans"
        assert plans_dir.exists()
        plan_files = list(plans_dir.glob("*.md"))
        assert len(plan_files) == 1

        content = plan_files[0].read_text(encoding="utf-8")
        assert "# Add Pagination" in content
        assert "cursor-based pagination" in content
        assert "## Steps" in content
        assert "**Add pagination params**" in content
        assert "`api.py`" in content
        assert "## Risks & open questions" in content
        assert "Backwards compatibility" in content
        assert "## Files touched" in content

    def test_write_plan_fails_without_steps(self, tmp_path: Path):
        from xvie_agent.tools import _write_plan

        ctx = ToolContext(workspace_root=tmp_path, allow_write=True, allow_shell=False)
        result = _write_plan({"title": "Empty", "summary": "No steps", "steps": []}, ctx)
        assert result.ok is False
        assert result.error_kind == "missing_argument"

    def test_write_plan_markdown_is_valid_structure(self, tmp_path: Path):
        """Generated plan has all four required sections."""
        from xvie_agent.tools import _write_plan

        ctx = ToolContext(workspace_root=tmp_path, allow_write=True, allow_shell=False)
        _write_plan(
            {
                "title": "Test Plan",
                "summary": "A test plan.",
                "steps": [{"title": "Step 1", "description": "Do something."}],
                "risks": ["Risk 1"],
            },
            ctx,
        )

        plan_file = list((tmp_path / ".xvie" / "plans").glob("*.md"))[0]
        content = plan_file.read_text(encoding="utf-8")

        assert content.startswith("# ")
        assert "## Steps" in content
        assert "- [ ]" in content
        assert "## Risks & open questions" in content


# ---------------------------------------------------------------------------
# Plan mode strips write tools
# ---------------------------------------------------------------------------


class TestPlanModeToolStripping:
    def test_plan_mode_excludes_write_tools(self, tmp_path: Path):
        """In plan mode, write/edit/bash tools are absent from the registry."""
        ctx = ToolContext(workspace_root=tmp_path, allow_write=True, allow_shell=True)
        all_tools = build_default_registry(ctx)

        # Simulate plan mode filtering
        _PLAN_ONLY_TOOLS = {"read_file", "list_dir", "glob_search", "grep_search", "write_plan"}
        plan_tools = {k: v for k, v in all_tools.items() if k in _PLAN_ONLY_TOOLS}

        # Write tools should be excluded
        assert "write_file" not in plan_tools
        assert "edit_file" not in plan_tools
        assert "bash" not in plan_tools

        # Read-only tools + write_plan should be present
        assert "read_file" in plan_tools
        assert "list_dir" in plan_tools
        assert "glob_search" in plan_tools
        assert "grep_search" in plan_tools
        assert "write_plan" in plan_tools


# ---------------------------------------------------------------------------
# plan_to_run_requests parsing
# ---------------------------------------------------------------------------


class TestPlanToRunRequests:
    def test_parses_plan_steps(self, tmp_path: Path):
        """Parse a generated plan back into step prompts."""
        plan_content = """# Add Pagination

Add cursor-based pagination to the API.

## Steps

- [ ] **Add pagination params** — Accept cursor and limit query parameters (files: `api.py`, `models.py`)
- [ ] **Update database query** — Filter results by cursor value (files: `db.py`)
- [ ] **Add tests** — Write integration tests for pagination

## Risks & open questions

- Backwards compatibility with existing clients

## Files touched

- `api.py`
- `db.py`
- `models.py`
"""
        plan_path = tmp_path / "plan.md"
        plan_path.write_text(plan_content, encoding="utf-8")

        steps = plan_to_run_requests(plan_path)
        assert len(steps) == 3
        assert "Add pagination params" in steps[0]
        assert "cursor" in steps[0]
        assert "Update database query" in steps[1]
        assert "Add tests" in steps[2]

    def test_empty_plan(self, tmp_path: Path):
        """A plan with no steps section returns empty list."""
        plan_path = tmp_path / "empty.md"
        plan_path.write_text("# No Steps\n\nJust a summary.\n", encoding="utf-8")
        steps = plan_to_run_requests(plan_path)
        assert steps == []

    def test_hyphen_separator_parses(self, tmp_path: Path):
        """Weak models mix dash styles — hyphen and en-dash must parse too."""
        plan_path = tmp_path / "dashes.md"
        plan_path.write_text(
            "# Dashes\n\n## Steps\n\n"
            "- [ ] **One** - Hyphen separator (files: `a.py`)\n"
            "- [ ] **Two** – En-dash separator\n",
            encoding="utf-8",
        )
        steps = plan_to_run_requests(plan_path)
        assert len(steps) == 2
        assert "One" in steps[0] and "Hyphen separator" in steps[0]
        assert "Two" in steps[1]

    def test_design_brief_section_round_trip(self, tmp_path: Path):
        """design_brief renders a ## Design section without breaking step parsing."""
        from xvie_agent.tools import _write_plan

        ctx = ToolContext(workspace_root=tmp_path, allow_write=True, allow_shell=False)
        result = _write_plan(
            {
                "title": "Landing page",
                "summary": "Build it.",
                "steps": [
                    {"title": "Tokens", "description": "Seed tokens."},
                    {"title": "Build", "description": "Write files.", "files_touched": ["index.html"]},
                ],
                "design_brief": {
                    "tokens": "design-tokens-starter.css",
                    "thesis": "Calm because fintech",
                    "motion_budget": "one focal ≤800ms, chrome <300ms",
                    "stack": "vanilla",
                    "bogus": "ignored",
                },
            },
            ctx,
        )
        assert result.ok
        assert "## Design" in result.content
        assert "thesis: Calm because fintech" in result.content
        assert "bogus" not in result.content
        plan_files = list((tmp_path / ".xvie" / "plans").glob("*.md"))
        steps = plan_to_run_requests(plan_files[0])
        assert len(steps) == 2

    def test_round_trip(self, tmp_path: Path):
        """Write a plan, parse it back, verify steps match."""
        from xvie_agent.tools import _write_plan

        ctx = ToolContext(workspace_root=tmp_path, allow_write=True, allow_shell=False)
        result = _write_plan(
            {
                "title": "Fix Bug",
                "summary": "Fix the login bug.",
                "steps": [
                    {"title": "Reproduce", "description": "Write a failing test."},
                    {"title": "Fix", "description": "Patch auth.py.", "files_touched": ["auth.py"]},
                    {"title": "Verify", "description": "Run the test suite."},
                ],
                "risks": ["Might break other tests"],
            },
            ctx,
        )

        # Find the plan file
        plan_files = list((tmp_path / ".xvie" / "plans").glob("*.md"))
        assert len(plan_files) == 1

        # Parse it back
        steps = plan_to_run_requests(plan_files[0])
        assert len(steps) == 3
        assert "Reproduce" in steps[0]
        assert "Fix" in steps[1]
        assert "auth.py" in steps[1]
        assert "Verify" in steps[2]
