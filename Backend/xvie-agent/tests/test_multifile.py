"""Tests for Phase 17 — multi-file edit and review capabilities."""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from xvie_agent.tools import (
    ToolContext,
    _apply_patch,
    _diff_preview,
    _move_file,
    _delete_file,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _ctx(tmp_path: Path, write: bool = True, shell: bool = False) -> ToolContext:
    return ToolContext(workspace_root=tmp_path, allow_write=write, allow_shell=shell)


# ---------------------------------------------------------------------------
# apply_patch — atomic multi-file edits
# ---------------------------------------------------------------------------


class TestApplyPatch:
    def test_all_three_files_change(self, tmp_path: Path):
        """When all old_str matches, all files are updated."""
        (tmp_path / "a.py").write_text("def add(a, b): return a + b\n")
        (tmp_path / "b.py").write_text("def add(a, b): return a + b\n")
        (tmp_path / "c.py").write_text("def add(a, b): return a + b\n")

        ctx = _ctx(tmp_path)
        result = _apply_patch(
            {
                "files": [
                    {"path": "a.py", "old_str": "def add(a, b): return a + b", "new_str": "def sum_two(a, b): return a + b"},
                    {"path": "b.py", "old_str": "def add(a, b): return a + b", "new_str": "def sum_two(a, b): return a + b"},
                    {"path": "c.py", "old_str": "def add(a, b): return a + b", "new_str": "def sum_two(a, b): return a + b"},
                ]
            },
            ctx,
        )
        assert result.ok is True
        assert "3 files patched" in result.content
        for f in ["a.py", "b.py", "c.py"]:
            assert "sum_two" in (tmp_path / f).read_text()

    def test_one_file_fails_no_files_change(self, tmp_path: Path):
        """When one old_str doesn't match, ALL files are rolled back."""
        (tmp_path / "a.py").write_text("def add(a, b): return a + b\n")
        (tmp_path / "b.py").write_text("def add(a, b): return a + b\n")
        (tmp_path / "c.py").write_text("def add(a, b): return a + b\n")

        ctx = _ctx(tmp_path)
        result = _apply_patch(
            {
                "files": [
                    {"path": "a.py", "old_str": "def add(a, b): return a + b", "new_str": "def sum_two(a, b): return a + b"},
                    {"path": "b.py", "old_str": "THIS DOES NOT MATCH", "new_str": "def sum_two(a, b): return a + b"},
                    {"path": "c.py", "old_str": "def add(a, b): return a + b", "new_str": "def sum_two(a, b): return a + b"},
                ]
            },
            ctx,
        )
        assert result.ok is False
        assert "b.py" in result.content
        # Verify no files were changed
        for f in ["a.py", "b.py", "c.py"]:
            assert "def add" in (tmp_path / f).read_text()

    def test_multiple_matches_fails(self, tmp_path: Path):
        """When old_str matches multiple times, it fails (same as edit_file)."""
        (tmp_path / "a.py").write_text("x\nx\n")
        ctx = _ctx(tmp_path)
        result = _apply_patch(
            {"files": [{"path": "a.py", "old_str": "x", "new_str": "y"}]},
            ctx,
        )
        assert result.ok is False
        assert "matched 2 times" in result.content

    def test_permission_denied(self, tmp_path: Path):
        ctx = _ctx(tmp_path, write=False)
        result = _apply_patch(
            {"files": [{"path": "a.py", "old_str": "x", "new_str": "y"}]},
            ctx,
        )
        assert result.ok is False

    def test_empty_files_list(self, tmp_path: Path):
        ctx = _ctx(tmp_path)
        result = _apply_patch({"files": []}, ctx)
        assert result.ok is False


# ---------------------------------------------------------------------------
# diff_preview
# ---------------------------------------------------------------------------


class TestDiffPreview:
    def test_diff_shows_change(self, tmp_path: Path):
        (tmp_path / "code.py").write_text("line 1\nline 2\nline 3\n")
        ctx = _ctx(tmp_path)
        result = _diff_preview(
            {"path": "code.py", "new_content": "line 1\nchanged line 2\nline 3\n"},
            ctx,
        )
        assert result.ok is True
        assert "changed line 2" in result.content
        # Original file unchanged
        assert (tmp_path / "code.py").read_text() == "line 1\nline 2\nline 3\n"

    def test_diff_for_new_file(self, tmp_path: Path):
        ctx = _ctx(tmp_path)
        result = _diff_preview(
            {"path": "new.py", "new_content": "print('hello')\n"},
            ctx,
        )
        assert result.ok is True
        # No file was created
        assert not (tmp_path / "new.py").exists()

    def test_file_not_found_shows_addition(self, tmp_path: Path):
        """Nonexistent file shows a 'new file' diff (additions only)."""
        ctx = _ctx(tmp_path)
        result = _diff_preview(
            {"path": "nonexistent.py", "new_content": "x"},
            ctx,
        )
        assert result.ok is True
        assert "+x" in result.content


# ---------------------------------------------------------------------------
# move_file
# ---------------------------------------------------------------------------


class TestMoveFile:
    def test_move_file(self, tmp_path: Path):
        (tmp_path / "old.py").write_text("content")
        ctx = _ctx(tmp_path)
        result = _move_file({"src": "old.py", "dst": "new.py"}, ctx)
        assert result.ok is True
        assert not (tmp_path / "old.py").exists()
        assert (tmp_path / "new.py").read_text() == "content"

    def test_move_outside_workspace(self, tmp_path: Path):
        (tmp_path / "file.py").write_text("content")
        ctx = _ctx(tmp_path)
        result = _move_file({"src": "file.py", "dst": "../evil.py"}, ctx)
        assert result.ok is False

    def test_permission_denied(self, tmp_path: Path):
        ctx = _ctx(tmp_path, write=False)
        result = _move_file({"src": "a.py", "dst": "b.py"}, ctx)
        assert result.ok is False


# ---------------------------------------------------------------------------
# delete_file
# ---------------------------------------------------------------------------


class TestDeleteFile:
    def test_delete_file(self, tmp_path: Path):
        (tmp_path / "to_delete.py").write_text("bye")
        ctx = _ctx(tmp_path)
        result = _delete_file({"path": "to_delete.py"}, ctx)
        assert result.ok is True
        assert not (tmp_path / "to_delete.py").exists()

    def test_delete_outside_workspace(self, tmp_path: Path):
        ctx = _ctx(tmp_path)
        result = _delete_file({"path": "../../etc/passwd"}, ctx)
        assert result.ok is False

    def test_permission_denied(self, tmp_path: Path):
        ctx = _ctx(tmp_path, write=False)
        result = _delete_file({"path": "a.py"}, ctx)
        assert result.ok is False

    def test_file_not_found(self, tmp_path: Path):
        ctx = _ctx(tmp_path)
        result = _delete_file({"path": "nope.py"}, ctx)
        assert result.ok is False
