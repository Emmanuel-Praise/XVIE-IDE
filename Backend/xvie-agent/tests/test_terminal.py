"""Tests for Phase 18 — code execution and persistent shell."""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from xvie_agent.tools import ToolContext, _run_code
from xvie_agent.terminal import PersistentShell, get_or_create_shell, close_shell


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _ctx(tmp_path: Path, shell: bool = True) -> ToolContext:
    return ToolContext(workspace_root=tmp_path, allow_write=True, allow_shell=shell)


# ---------------------------------------------------------------------------
# run_code tool
# ---------------------------------------------------------------------------


class TestRunCode:
    def test_python_snippet(self, tmp_path: Path):
        ctx = _ctx(tmp_path)
        result = _run_code(
            {"language": "python", "code": "print(2 + 2)"},
            ctx,
        )
        assert result.ok is True
        assert "4" in result.content

    def test_python_with_output(self, tmp_path: Path):
        ctx = _ctx(tmp_path)
        result = _run_code(
            {"language": "python", "code": "import sys; print('hello', file=sys.stderr)"},
            ctx,
        )
        assert result.ok is True
        assert "hello" in result.content

    def test_bash_snippet(self, tmp_path: Path):
        ctx = _ctx(tmp_path)
        result = _run_code(
            {"language": "bash", "code": "echo hello"},
            ctx,
        )
        assert result.ok is True
        assert "hello" in result.content

    def test_missing_code(self, tmp_path: Path):
        ctx = _ctx(tmp_path)
        result = _run_code({"language": "python"}, ctx)
        assert result.ok is False
        assert result.error_kind == "missing_argument"

    def test_permission_denied(self, tmp_path: Path):
        ctx = _ctx(tmp_path, shell=False)
        result = _run_code({"language": "python", "code": "print(1)"}, ctx)
        assert result.ok is False

    def test_no_temp_file_left_behind(self, tmp_path: Path):
        """The temp file should be cleaned up after execution."""
        ctx = _ctx(tmp_path)
        _run_code({"language": "python", "code": "print('hi')"}, ctx)
        # Only the original files should exist
        py_files = list(tmp_path.glob("*.py"))
        assert len(py_files) == 0


# ---------------------------------------------------------------------------
# PersistentShell
# ---------------------------------------------------------------------------


class TestPersistentShell:
    def test_execute_returns_output(self, tmp_path: Path):
        shell = PersistentShell(session_id="test1", command_timeout=5)
        try:
            result = shell.execute("echo hello_persistent")
            assert "hello_persistent" in result.stdout
            assert result.exit_code == 0
        finally:
            shell.close()

    def test_state_persists_across_calls(self, tmp_path: Path):
        """cd in one call should affect the next call."""
        shell = PersistentShell(session_id="test2", command_timeout=5)
        try:
            target = tmp_path / "subdir"
            target.mkdir()
            shell.execute(f"cd {target.as_posix()}")
            result = shell.execute("pwd")
            # The pwd should reflect the cd
            assert target.name in result.stdout or target.as_posix() in result.stdout
        finally:
            shell.close()

    def test_shell_restarts_after_close(self, tmp_path: Path):
        shell = PersistentShell(session_id="test3", command_timeout=5)
        shell.execute("export MY_VAR=hello")
        shell.close()
        # After close, a new shell should be fresh
        shell2 = PersistentShell(session_id="test3", command_timeout=5)
        try:
            result = shell2.execute("echo $MY_VAR")
            # Variable should NOT persist across close
            assert "hello" not in result.stdout.strip()
        finally:
            shell2.close()

    def test_alive_property(self, tmp_path: Path):
        shell = PersistentShell(session_id="test4", command_timeout=5)
        assert shell.alive is True
        shell.close()
        assert shell.alive is False


# ---------------------------------------------------------------------------
# get_or_create_shell
# ---------------------------------------------------------------------------


class TestGetOrCreateShell:
    def test_returns_same_shell(self, tmp_path: Path):
        s1 = get_or_create_shell("sess1", command_timeout=5)
        s2 = get_or_create_shell("sess1", command_timeout=5)
        assert s1 is s2
        s1.close()

    def test_different_sessions(self, tmp_path: Path):
        s1 = get_or_create_shell("sess_a", command_timeout=5)
        s2 = get_or_create_shell("sess_b", command_timeout=5)
        assert s1 is not s2
        s1.close()
        s2.close()
