"""Tests for multi-file mark_task_done verification in tools.py.

For a task whose files_touched lists multiple files, mark_task_done must
confirm EVERY listed file actually changed before accepting. Partial
completion (e.g., 2 of 3 files touched) must be rejected with a message
naming exactly which file(s) are still missing.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from xvie_agent.tools import (
    ToolContext,
    _mark_task_done,
    _write_plan,
)


@pytest.fixture()
def workspace(tmp_path: Path) -> Path:
    return tmp_path


def _ctx(workspace: Path) -> ToolContext:
    return ToolContext(workspace_root=workspace, allow_write=True)


def _create_three_file_plan(ctx: ToolContext) -> None:
    """Create a plan with a task that touches 3 files."""
    out = _write_plan(
        {
            "title": "Build portfolio",
            "summary": "Three HTML pages.",
            "steps": [
                {
                    "title": "Create all pages",
                    "description": "Build index.html, about.html, contact.html",
                    "files_touched": ["index.html", "about.html", "contact.html"],
                },
                {
                    "title": "Add styles",
                    "description": "Create style.css",
                    "files_touched": ["style.css"],
                },
            ],
        },
        ctx,
    )
    assert out.ok, f"write_plan failed: {out.content}"


class TestMultifileVerification:
    """mark_task_done must verify all files_touched were modified."""

    def test_partial_completion_rejected(self, workspace: Path) -> None:
        """Only 2 of 3 files changed → rejected, names the missing file."""
        ctx = _ctx(workspace)
        _create_three_file_plan(ctx)

        # Simulate: only index.html and about.html were changed
        changed_files = ["index.html", "about.html"]

        out = _mark_task_done({"title": "Create all pages", "changed_files": changed_files}, ctx)
        assert out.ok is False
        assert out.error_kind == "incomplete_files"
        assert "contact.html" in out.content
        assert "index.html" not in out.content.split("were not changed")[0]  # index.html is NOT missing

    def test_all_files_changed_accepted(self, workspace: Path) -> None:
        """All 3 files changed → accepted."""
        ctx = _ctx(workspace)
        _create_three_file_plan(ctx)

        changed_files = ["index.html", "about.html", "contact.html"]

        out = _mark_task_done({"title": "Create all pages", "changed_files": changed_files}, ctx)
        assert out.ok is True
        assert "done" in out.content.lower()

    def test_no_files_touched_skips_verification(self, workspace: Path) -> None:
        """Task without files_touched → no verification, accepted."""
        ctx = _ctx(workspace)
        _create_three_file_plan(ctx)

        # Second task has files_touched, but let's test a task without it
        # by creating a plan with a step that has no files_touched
        _write_plan(
            {
                "title": "Research",
                "summary": "Just read files.",
                "steps": [{"title": "Investigate codebase", "description": "Read files"}],
            },
            ctx,
        )

        out = _mark_task_done({"title": "Investigate codebase", "changed_files": []}, ctx)
        # No files_touched on the step, so no verification needed
        assert out.ok is True

    def test_empty_changed_files_rejects(self, workspace: Path) -> None:
        """Task with files_touched but empty changed_files → rejected."""
        ctx = _ctx(workspace)
        _create_three_file_plan(ctx)

        out = _mark_task_done({"title": "Create all pages", "changed_files": []}, ctx)
        assert out.ok is False
        assert out.error_kind == "incomplete_files"
        # All 3 files should be listed as missing
        assert "index.html" in out.content
        assert "about.html" in out.content
        assert "contact.html" in out.content

    def test_two_of_three_rejected(self, workspace: Path) -> None:
        """Exactly 2 of 3 files touched → rejected with the 1 missing."""
        ctx = _ctx(workspace)
        _create_three_file_plan(ctx)

        changed_files = ["index.html", "contact.html"]
        out = _mark_task_done({"title": "Create all pages", "changed_files": changed_files}, ctx)
        assert out.ok is False
        assert "about.html" in out.content

    def test_single_file_task_accepted(self, workspace: Path) -> None:
        """Single-file task → accepted when that file is in changed_files."""
        ctx = _ctx(workspace)
        _create_three_file_plan(ctx)

        # Mark first task done (skip it for simplicity)
        _mark_task_done({"title": "Create all pages", "changed_files": ["index.html", "about.html", "contact.html"]}, ctx)

        # Second task: single file
        out = _mark_task_done({"title": "Add styles", "changed_files": ["style.css"]}, ctx)
        assert out.ok is True


class TestMultifileVerificationEdgeCases:
    """Edge cases for the multi-file verification."""

    def test_case_insensitive_comparison(self, workspace: Path) -> None:
        """File paths are compared case-insensitively."""
        ctx = _ctx(workspace)
        _create_three_file_plan(ctx)

        # Use different casing
        changed_files = ["Index.HTML", "ABOUT.html", "Contact.Html"]
        out = _mark_task_done({"title": "Create all pages", "changed_files": changed_files}, ctx)
        assert out.ok is True

    def test_backslash_normalization(self, workspace: Path) -> None:
        """Windows-style backslash paths are normalized."""
        ctx = _ctx(workspace)
        _create_three_file_plan(ctx)

        changed_files = ["index.html", "about.html", "contact.html"]
        out = _mark_task_done({"title": "Create all pages", "changed_files": changed_files}, ctx)
        assert out.ok is True

    def test_error_message_lists_all_missing(self, workspace: Path) -> None:
        """When multiple files are missing, all are listed in the error."""
        ctx = _ctx(workspace)
        _create_three_file_plan(ctx)

        out = _mark_task_done({"title": "Create all pages", "changed_files": ["style.css"]}, ctx)
        assert out.ok is False
        # All 3 files should be listed as missing
        assert "index.html" in out.content
        assert "about.html" in out.content
        assert "contact.html" in out.content

    def test_second_task_independent_verification(self, workspace: Path) -> None:
        """Each task's verification is independent."""
        ctx = _ctx(workspace)
        _create_three_file_plan(ctx)

        # First task: pass
        out1 = _mark_task_done(
            {"title": "Create all pages", "changed_files": ["index.html", "about.html", "contact.html"]},
            ctx,
        )
        assert out1.ok is True

        # Second task: only partial
        out2 = _mark_task_done(
            {"title": "Add styles", "changed_files": []},
            ctx,
        )
        assert out2.ok is False
        assert "style.css" in out2.content
