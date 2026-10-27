"""Tests for xvie_agent.tools — all 7 tools, security, and edge cases."""

from __future__ import annotations

import time
import json
import io
import urllib.request
from pathlib import Path

import pytest

from xvie_agent.tools import (
    MAX_WRITE_CONTENT_CHARS,
    ToolContext,
    ToolOutput,
    _append_file,
    _bash,
    _edit_file,
    _file_size,
    _glob_search,
    _grep_search,
    _list_dir,
    _mark_task_done,
    _move_file,
    _delete_file,
    _apply_patch,
    _read_file,
    _verify_file,
    _write_file,
    _write_plan,
    _search_images,
    build_default_registry,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def sandbox(tmp_path: Path) -> Path:
    """Create a temp workspace with a few sample files."""
    (tmp_path / "hello.txt").write_text("Hello, world!\nLine 2\nLine 3\n")
    (tmp_path / "code.py").write_text("def foo():\n    return 42\n")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "nested.txt").write_text("nested content\n")
    return tmp_path


@pytest.fixture()
def ctx(sandbox: Path) -> ToolContext:
    """ToolContext with write + shell enabled."""
    return ToolContext(workspace_root=sandbox, allow_write=True, allow_shell=True)


def test_search_images_uses_wikimedia_when_pexels_key_is_missing(monkeypatch, ctx: ToolContext) -> None:
    payload = {"query": {"pages": [{
        "title": "File:Fresh tomato.jpg",
        "imageinfo": [{
            "url": "https://upload.wikimedia.org/fresh-tomato.jpg",
            "thumburl": "https://upload.wikimedia.org/thumb/fresh-tomato.jpg",
            "width": 1600,
            "height": 900,
            "extmetadata": {
                "ImageDescription": {"value": "Fresh tomatoes"},
                "Artist": {"value": "<a>Photographer</a>"},
                "LicenseShortName": {"value": "CC BY-SA 4.0"},
            },
        }],
    }]}}
    monkeypatch.delenv("PEXELS_API_KEY", raising=False)
    monkeypatch.setattr(urllib.request, "urlopen", lambda *args, **kwargs: io.BytesIO(json.dumps(payload).encode()))

    result = _search_images({"query": "tomato", "per_page": 1}, ctx)

    assert result.ok
    assert "https://upload.wikimedia.org/thumb/fresh-tomato.jpg" in result.content
    assert "Photographer / Wikimedia Commons (CC BY-SA 4.0)" in result.content


def test_search_images_falls_back_to_wikimedia_when_pexels_fails(monkeypatch, ctx: ToolContext) -> None:
    payload = {"query": {"pages": [{
        "title": "File:Fresh tomato.jpg",
        "imageinfo": [{
            "url": "https://upload.wikimedia.org/fresh-tomato.jpg",
            "thumburl": "https://upload.wikimedia.org/thumb/fresh-tomato.jpg",
            "width": 1600,
            "height": 900,
            "extmetadata": {"ImageDescription": {"value": "Fresh tomatoes"}},
        }],
    }]}}
    monkeypatch.setenv("PEXELS_API_KEY", "configured-but-expired")

    def fake_urlopen(request, timeout=0):
        url = request.full_url if hasattr(request, "full_url") else str(request)
        if "api.pexels.com" in url:
            raise urllib.error.HTTPError(url, 401, "Unauthorized", hdrs=None, fp=io.BytesIO(b"invalid key"))
        return io.BytesIO(json.dumps(payload).encode())

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    result = _search_images({"query": "tomato", "per_page": 1}, ctx)

    assert result.ok
    assert "Pexels was unavailable (HTTP 401: Unauthorized)" in result.content
    assert "https://upload.wikimedia.org/thumb/fresh-tomato.jpg" in result.content


def test_search_images_handles_non_string_query_as_missing(monkeypatch, ctx: ToolContext) -> None:
    monkeypatch.setenv("PEXELS_API_KEY", "unused")
    result = _search_images({"query": None}, ctx)
    assert not result.ok
    assert result.error_kind == "missing_argument"


@pytest.fixture()
def read_only_ctx(sandbox: Path) -> ToolContext:
    """ToolContext with write and shell disabled."""
    return ToolContext(workspace_root=sandbox, allow_write=False, allow_shell=False)


# ---------------------------------------------------------------------------
# build_default_registry
# ---------------------------------------------------------------------------

class TestRegistry:
    def test_all_tools_registered(self, ctx: ToolContext) -> None:
        reg = build_default_registry(ctx)
        expected = {"list_dir", "read_file", "write_file", "edit_file", "glob_search", "grep_search", "bash", "write_plan", "check_contrast", "preview_artifact", "review_ui_render", "move_file", "delete_file", "apply_patch", "diff_preview", "run_code", "append_file", "file_size", "verify_file", "mark_task_done", "think", "read_ui_reference", "search_images", "ask_question"}
        assert set(reg.keys()) == expected

    def test_all_handlers_callable(self, ctx: ToolContext) -> None:
        reg = build_default_registry(ctx)
        for name, tool in reg.items():
            assert callable(tool.handler), f"{name} handler not callable"

    def test_all_schemas_have_properties(self, ctx: ToolContext) -> None:
        reg = build_default_registry(ctx)
        for name, tool in reg.items():
            assert "properties" in tool.json_schema, f"{name} schema missing 'properties'"


# ---------------------------------------------------------------------------
# list_dir
# ---------------------------------------------------------------------------

class TestListDir:
    def test_list_root(self, ctx: ToolContext) -> None:
        out = _list_dir({}, ctx)
        assert out.ok is True
        assert "hello.txt" in out.content
        assert "code.py" in out.content
        assert "d sub" in out.content  # directory prefix

    def test_list_subdir(self, ctx: ToolContext) -> None:
        out = _list_dir({"path": "sub"}, ctx)
        assert out.ok is True
        assert "nested.txt" in out.content

    def test_path_traversal_blocked(self, ctx: ToolContext) -> None:
        out = _list_dir({"path": "../../etc"}, ctx)
        assert out.ok is False
        assert out.error_kind == "path_traversal"

    def test_nonexistent_path(self, ctx: ToolContext) -> None:
        out = _list_dir({"path": "no_such_dir"}, ctx)
        assert out.ok is False
        assert out.error_kind == "not_found"

    def test_list_file_not_dir(self, ctx: ToolContext) -> None:
        out = _list_dir({"path": "hello.txt"}, ctx)
        assert out.ok is False
        assert out.error_kind == "not_a_directory"


# ---------------------------------------------------------------------------
# read_file
# ---------------------------------------------------------------------------

class TestReadFile:
    def test_read_full(self, ctx: ToolContext) -> None:
        out = _read_file({"path": "hello.txt"}, ctx)
        assert out.ok is True
        assert "Hello, world!" in out.content

    def test_read_with_line_range(self, ctx: ToolContext) -> None:
        out = _read_file({"path": "hello.txt", "start_line": 2, "end_line": 2}, ctx)
        assert out.ok is True
        assert "Line 2" in out.content
        assert "Hello" not in out.content

    def test_path_traversal_blocked(self, ctx: ToolContext) -> None:
        out = _read_file({"path": "../../etc/passwd"}, ctx)
        assert out.ok is False
        assert out.error_kind == "path_traversal"

    def test_file_not_found(self, ctx: ToolContext) -> None:
        out = _read_file({"path": "missing.txt"}, ctx)
        assert out.ok is False
        assert out.error_kind == "not_found"

    def test_is_directory(self, ctx: ToolContext) -> None:
        out = _read_file({"path": "sub"}, ctx)
        assert out.ok is False
        assert out.error_kind == "is_directory"

    def test_missing_path_argument(self, ctx: ToolContext) -> None:
        out = _read_file({}, ctx)
        assert out.ok is False
        assert out.error_kind == "missing_argument"


# ---------------------------------------------------------------------------
# write_file
# ---------------------------------------------------------------------------

class TestWriteFile:
    def test_write_new_file(self, ctx: ToolContext) -> None:
        out = _write_file({"path": "new.txt", "content": "brand new"}, ctx)
        assert out.ok is True
        assert (ctx.workspace_root / "new.txt").read_text() == "brand new"

    def test_write_creates_parent_dirs(self, ctx: ToolContext) -> None:
        out = _write_file({"path": "a/b/c.txt", "content": "deep"}, ctx)
        assert out.ok is True
        assert (ctx.workspace_root / "a" / "b" / "c.txt").read_text() == "deep"

    def test_write_permission_denied(self, read_only_ctx: ToolContext) -> None:
        out = _write_file({"path": "x.txt", "content": "y"}, read_only_ctx)
        assert out.ok is False
        assert out.error_kind == "permission_denied"

    def test_path_traversal_blocked(self, ctx: ToolContext) -> None:
        out = _write_file({"path": "../evil.txt", "content": "bad"}, ctx)
        assert out.ok is False
        assert out.error_kind == "path_traversal"

    def test_path_traversal_deep(self, ctx: ToolContext) -> None:
        out = _write_file({"path": "../../etc/passwd", "content": "bad"}, ctx)
        assert out.ok is False
        assert out.error_kind == "path_traversal"


# ---------------------------------------------------------------------------
# edit_file
# ---------------------------------------------------------------------------

class TestEditFile:
    def test_edit_replaces_string(self, ctx: ToolContext) -> None:
        out = _edit_file(
            {"path": "hello.txt", "old_str": "Hello, world!", "new_str": "Goodbye, world!"},
            ctx,
        )
        assert out.ok is True
        assert "Replaced 1 occurrence" in out.content
        assert "Goodbye, world!" in (ctx.workspace_root / "hello.txt").read_text()

    def test_edit_no_match(self, ctx: ToolContext) -> None:
        out = _edit_file(
            {"path": "hello.txt", "old_str": "NONEXISTENT STRING", "new_str": "x"},
            ctx,
        )
        assert out.ok is False
        assert "matched 0 times" in out.content
        assert out.error_kind == "no_match"

    def test_edit_multiple_matches(self, ctx: ToolContext) -> None:
        # Create a file with duplicate strings
        (ctx.workspace_root / "dup.txt").write_text("aaa bbb aaa")
        out = _edit_file(
            {"path": "dup.txt", "old_str": "aaa", "new_str": "zzz"},
            ctx,
        )
        assert out.ok is False
        assert "matched 2 times" in out.content
        assert out.error_kind == "multiple_matches"

    def test_edit_permission_denied(self, read_only_ctx: ToolContext) -> None:
        out = _edit_file(
            {"path": "hello.txt", "old_str": "Hello", "new_str": "Hi"},
            read_only_ctx,
        )
        assert out.ok is False
        assert out.error_kind == "permission_denied"

    def test_edit_file_not_found(self, ctx: ToolContext) -> None:
        out = _edit_file(
            {"path": "missing.txt", "old_str": "a", "new_str": "b"},
            ctx,
        )
        assert out.ok is False
        assert out.error_kind == "not_found"

    def test_edit_path_traversal(self, ctx: ToolContext) -> None:
        out = _edit_file(
            {"path": "../../etc/hosts", "old_str": "a", "new_str": "b"},
            ctx,
        )
        assert out.ok is False
        assert out.error_kind == "path_traversal"

    def test_edit_empty_old_str(self, ctx: ToolContext) -> None:
        out = _edit_file(
            {"path": "hello.txt", "old_str": "", "new_str": "x"},
            ctx,
        )
        assert out.ok is False
        assert out.error_kind == "missing_argument"


# ---------------------------------------------------------------------------
# glob_search
# ---------------------------------------------------------------------------

class TestGlobSearch:
    def test_glob_finds_py_files(self, ctx: ToolContext) -> None:
        out = _glob_search({"pattern": "*.py"}, ctx)
        assert out.ok is True
        assert "code.py" in out.content

    def test_glob_no_matches(self, ctx: ToolContext) -> None:
        out = _glob_search({"pattern": "*.rs"}, ctx)
        assert out.ok is True
        assert "no matches" in out.content

    def test_glob_finds_nested(self, ctx: ToolContext) -> None:
        out = _glob_search({"pattern": "*.txt"}, ctx)
        assert out.ok is True
        assert "nested.txt" in out.content

    def test_glob_missing_pattern(self, ctx: ToolContext) -> None:
        out = _glob_search({}, ctx)
        assert out.ok is False
        assert out.error_kind == "missing_argument"


# ---------------------------------------------------------------------------
# grep_search
# ---------------------------------------------------------------------------

class TestGrepSearch:
    def test_grep_finds_match(self, ctx: ToolContext) -> None:
        out = _grep_search({"pattern": "def foo"}, ctx)
        assert out.ok is True
        assert "code.py" in out.content
        assert "def foo" in out.content

    def test_grep_no_matches(self, ctx: ToolContext) -> None:
        out = _grep_search({"pattern": "nonexistent_pattern_xyz"}, ctx)
        assert out.ok is True
        assert "No matches found" in out.content

    def test_grep_path_traversal(self, ctx: ToolContext) -> None:
        out = _grep_search({"pattern": "x", "path": "../../etc"}, ctx)
        assert out.ok is False
        assert out.error_kind == "path_traversal"

    def test_grep_invalid_regex(self, ctx: ToolContext) -> None:
        out = _grep_search({"pattern": "[invalid"}, ctx)
        assert out.ok is False
        assert out.error_kind == "invalid_regex"

    def test_grep_missing_pattern(self, ctx: ToolContext) -> None:
        out = _grep_search({}, ctx)
        assert out.ok is False
        assert out.error_kind == "missing_argument"

    def test_grep_single_file(self, ctx: ToolContext) -> None:
        out = _grep_search({"pattern": "Hello", "path": "hello.txt"}, ctx)
        assert out.ok is True
        assert "hello.txt" in out.content


# ---------------------------------------------------------------------------
# bash
# ---------------------------------------------------------------------------

class TestBash:
    def test_bash_echo(self, ctx: ToolContext) -> None:
        out = _bash({"command": "echo hello"}, ctx)
        assert out.ok is True
        assert "hello" in out.content

    def test_bash_failing_command(self, ctx: ToolContext) -> None:
        import platform
        # "false" is Unix-only; use "exit 1" which works everywhere via shell
        out = _bash({"command": "exit 1"}, ctx)
        assert out.ok is True  # bash tool always returns ok
        if platform.system() != "Windows":
            assert "exit code: 1" in out.content

    def test_bash_timeout(self, ctx: ToolContext) -> None:
        import platform
        fast_ctx = ToolContext(
            workspace_root=ctx.workspace_root,
            allow_write=True,
            allow_shell=True,
            command_timeout_seconds=1,
        )
        # Use a command that hangs for longer than the timeout.
        # On Windows, use a Python sleep since "sleep" may not exist.
        if platform.system() == "Windows":
            cmd = "python -c \"import time; time.sleep(10)\""
        else:
            cmd = "sleep 10"
        start = time.monotonic()
        out = _bash({"command": cmd}, fast_ctx)
        elapsed = time.monotonic() - start
        assert out.ok is False
        assert out.error_kind == "timeout"
        # On Windows, subprocess tree-kill can take a few extra seconds.
        # We just need to confirm it didn't wait the full 10s.
        assert elapsed < 8, f"Bash timeout took {elapsed:.1f}s — should have been ~1s"

    def test_bash_permission_denied(self, read_only_ctx: ToolContext) -> None:
        out = _bash({"command": "echo hi"}, read_only_ctx)
        assert out.ok is False
        assert out.error_kind == "permission_denied"

    def test_bash_missing_command(self, ctx: ToolContext) -> None:
        out = _bash({}, ctx)
        assert out.ok is False
        assert out.error_kind == "missing_argument"

    def test_bash_output_truncation(self, ctx: ToolContext) -> None:
        tiny_ctx = ToolContext(
            workspace_root=ctx.workspace_root,
            allow_write=True,
            allow_shell=True,
            max_output_chars=50,
        )
        out = _bash({"command": "python3 -c \"print('x' * 500)\""}, tiny_ctx)
        assert out.ok is True
        assert "truncated" in out.content
        assert len(out.content) <= 120  # 50 + truncation notice


# ---------------------------------------------------------------------------
# Security — path traversal (THE most important test)
# ---------------------------------------------------------------------------

class TestSecurity:
    """Path traversal must be blocked in every tool that accepts a path."""

    @pytest.mark.parametrize("tool_fn,args_key", [
        (_list_dir, "path"),
        (_read_file, "path"),
        (_write_file, "path"),
        (_edit_file, "path"),
    ])
    def test_path_traversal_direct(self, tool_fn, args_key: str, ctx: ToolContext) -> None:
        out = tool_fn({args_key: "../evil.txt"}, ctx)
        assert out.ok is False
        assert out.error_kind == "path_traversal"

    @pytest.mark.parametrize("tool_fn,args_key", [
        (_list_dir, "path"),
        (_read_file, "path"),
        (_write_file, "path"),
        (_edit_file, "path"),
    ])
    def test_path_traversal_deep(self, tool_fn, args_key: str, ctx: ToolContext) -> None:
        out = tool_fn({args_key: "../../etc/passwd"}, ctx)
        assert out.ok is False
        assert out.error_kind == "path_traversal"

    @pytest.mark.parametrize("tool_fn,args_key", [
        (_list_dir, "path"),
        (_read_file, "path"),
        (_write_file, "path"),
        (_edit_file, "path"),
    ])
    def test_path_traversal_dot_dot_slash(self, tool_fn, args_key: str, ctx: ToolContext) -> None:
        out = tool_fn({args_key: "../"}, ctx)
        assert out.ok is False
        assert out.error_kind == "path_traversal"

    def test_mutating_tools_reject_sibling_prefix_paths(self, ctx: ToolContext) -> None:
        outside = ctx.workspace_root.parent / (ctx.workspace_root.name + "-escape")
        outside.mkdir()
        (outside / "victim.txt").write_text("safe")
        relative = f"../{outside.name}/victim.txt"

        move = _move_file({"src": "hello.txt", "dst": relative}, ctx)
        delete = _delete_file({"path": relative}, ctx)
        patch = _apply_patch({"files": [{"path": relative, "old_str": "safe", "new_str": "changed"}]}, ctx)

        assert move.error_kind == "path_traversal"
        assert delete.error_kind == "path_traversal"
        assert patch.error_kind == "path_traversal"
        assert (outside / "victim.txt").read_text() == "safe"

    def test_mutating_tools_allow_paths_inside_workspace(self, ctx: ToolContext) -> None:
        (ctx.workspace_root / "source.txt").write_text("old")
        (ctx.workspace_root / "patch.txt").write_text("before")

        assert _move_file({"src": "source.txt", "dst": "renamed.txt"}, ctx).ok
        assert _delete_file({"path": "renamed.txt"}, ctx).ok
        assert _apply_patch({"files": [{"path": "patch.txt", "old_str": "before", "new_str": "after"}]}, ctx).ok
        assert not (ctx.workspace_root / "renamed.txt").exists()
        assert (ctx.workspace_root / "patch.txt").read_text() == "after"

    def test_grep_path_traversal(self, ctx: ToolContext) -> None:
        out = _grep_search({"pattern": "x", "path": "../secret"}, ctx)
        assert out.ok is False
        assert out.error_kind == "path_traversal"

    def test_write_file_really_blocked(self, ctx: ToolContext) -> None:
        """THE critical test — make sure write_file doesn't write outside workspace."""
        out = _write_file({"path": "../evil.txt", "content": "EVIL"}, ctx)
        assert out.ok is False
        assert not (ctx.workspace_root.parent / "evil.txt").exists()


# ---------------------------------------------------------------------------
# append_file — chunked large-file generation
# ---------------------------------------------------------------------------

class TestAppendFile:
    def test_append_reports_total_size(self, ctx: ToolContext) -> None:
        (ctx.workspace_root / "big.txt").write_text("line one\n")
        out = _append_file({"path": "big.txt", "content": "line two\n"}, ctx)
        assert out.ok is True
        text = (ctx.workspace_root / "big.txt").read_text()
        assert text == "line one\nline two\n"
        assert "File now has 18 chars" in out.content

    def test_append_requires_existing_file(self, ctx: ToolContext) -> None:
        out = _append_file({"path": "missing.txt", "content": "x"}, ctx)
        assert out.ok is False
        assert out.error_kind == "not_found"

    def test_append_permission_denied(self, read_only_ctx: ToolContext) -> None:
        out = _append_file({"path": "hello.txt", "content": "x"}, read_only_ctx)
        assert out.ok is False
        assert out.error_kind == "permission_denied"

    def test_append_path_traversal(self, ctx: ToolContext) -> None:
        out = _append_file({"path": "../evil.txt", "content": "x"}, ctx)
        assert out.ok is False
        assert out.error_kind == "path_traversal"

    def test_append_missing_args(self, ctx: ToolContext) -> None:
        assert _append_file({}, ctx).error_kind == "missing_argument"
        assert _append_file({"path": "hello.txt"}, ctx).error_kind == "missing_argument"


# ---------------------------------------------------------------------------
# file_size
# ---------------------------------------------------------------------------

class TestFileSize:
    def test_reports_chars_and_lines(self, ctx: ToolContext) -> None:
        (ctx.workspace_root / "sample.txt").write_text("a\nb\nc\n")
        out = _file_size({"path": "sample.txt"}, ctx)
        assert out.ok is True
        assert "6 chars" in out.content
        assert "3 lines" in out.content

    def test_missing_file(self, ctx: ToolContext) -> None:
        out = _file_size({"path": "nope.txt"}, ctx)
        assert out.ok is False
        assert out.error_kind == "not_found"

    def test_path_traversal(self, ctx: ToolContext) -> None:
        out = _file_size({"path": "../evil.txt"}, ctx)
        assert out.ok is False
        assert out.error_kind == "path_traversal"


# ---------------------------------------------------------------------------
# Content-size cap — prevents single oversized write calls that exceed the
# provider output-token cap and get silently truncated.
# ---------------------------------------------------------------------------

class TestContentSizeCap:
    def test_default_cap_matches_weak_model_emit(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from xvie_agent.tools import _resolve_write_cap
        monkeypatch.delenv("XVIE_MAX_WRITE_CHARS", raising=False)
        assert _resolve_write_cap() == 8000

    def test_env_override_still_wins(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from xvie_agent.tools import _resolve_write_cap
        monkeypatch.setenv("XVIE_MAX_WRITE_CHARS", "20000")
        assert _resolve_write_cap() == 20000

    def test_write_file_rejects_oversized_content(self, ctx: ToolContext) -> None:
        big = "x" * (MAX_WRITE_CONTENT_CHARS + 1)
        out = _write_file({"path": "big.txt", "content": big}, ctx)
        assert out.ok is False
        assert out.error_kind == "content_too_large"
        assert "chunks" in out.content.lower()
        assert not (ctx.workspace_root / "big.txt").exists()

    def test_write_file_accepts_at_cap(self, ctx: ToolContext) -> None:
        content = "y" * MAX_WRITE_CONTENT_CHARS
        out = _write_file({"path": "ok.txt", "content": content}, ctx)
        assert out.ok is True
        assert (ctx.workspace_root / "ok.txt").read_text() == content

    def test_append_file_rejects_oversized_content(self, ctx: ToolContext) -> None:
        (ctx.workspace_root / "base.txt").write_text("seed\n")
        big = "z" * (MAX_WRITE_CONTENT_CHARS + 1)
        out = _append_file({"path": "base.txt", "content": big}, ctx)
        assert out.ok is False
        assert out.error_kind == "content_too_large"
        assert "chunks" in out.content.lower()
        assert (ctx.workspace_root / "base.txt").read_text() == "seed\n"

    def test_edit_file_rejects_oversized_new_str(self, ctx: ToolContext) -> None:
        (ctx.workspace_root / "hello.txt").write_text("Hello, world!\n")
        big = "w" * (MAX_WRITE_CONTENT_CHARS + 1)
        out = _edit_file(
            {"path": "hello.txt", "old_str": "Hello", "new_str": big},
            ctx,
        )
        assert out.ok is False
        assert out.error_kind == "content_too_large"
        assert not big.startswith((ctx.workspace_root / "hello.txt").read_text())


# ---------------------------------------------------------------------------
# verify_file
# ---------------------------------------------------------------------------

class TestVerifyFile:
    def test_valid_python_passes(self, ctx: ToolContext) -> None:
        (ctx.workspace_root / "ok.py").write_text("def f():\n    return 1\n")
        out = _verify_file({"path": "ok.py"}, ctx)
        assert out.ok is True
        assert "PASSED" in out.content

    def test_invalid_python_fails(self, ctx: ToolContext) -> None:
        (ctx.workspace_root / "bad.py").write_text("def f(:\n")
        out = _verify_file({"path": "bad.py"}, ctx)
        assert out.ok is False
        assert out.error_kind == "artifact_validation_failed"

    def test_incomplete_html_fails(self, ctx: ToolContext) -> None:
        (ctx.workspace_root / "page.html").write_text("<html><head><title>X</title>")
        out = _verify_file({"path": "page.html"}, ctx)
        assert out.ok is False
        assert "FAILED" in out.content

    def test_missing_file_fails(self, ctx: ToolContext) -> None:
        out = _verify_file({"path": "missing.py"}, ctx)
        assert out.ok is False


# ---------------------------------------------------------------------------
# mark_task_done — plan re-anchoring (NEXT TASK feedback loop)
# ---------------------------------------------------------------------------

def _make_two_step_plan(tmp_path: Path) -> ToolContext:
    ctx = ToolContext(workspace_root=tmp_path, allow_write=True)
    out = _write_plan(
        {
            "title": "Build site",
            "summary": "Two steps.",
            "steps": [
                {"title": "Create index.html", "description": "Main page"},
                {"title": "Create style.css", "description": "Styles"},
            ],
        },
        ctx,
    )
    assert out.ok
    return ctx


class TestMarkTaskDoneNextTask:
    def test_returns_next_task_and_remaining_list(self, tmp_path: Path) -> None:
        ctx = _make_two_step_plan(tmp_path)
        out = _mark_task_done({"title": "Create index.html"}, ctx)
        assert out.ok
        assert "1 done, 1 remaining" in out.content
        assert "Remaining tasks:" in out.content
        assert "- Create style.css" in out.content
        assert "NEXT TASK: Create style.css — Styles" in out.content
        assert "call mark_task_done again" in out.content

    def test_all_complete_message_when_no_tasks_left(self, tmp_path: Path) -> None:
        ctx = _make_two_step_plan(tmp_path)
        first = _mark_task_done({"title": "Create index.html"}, ctx)
        assert first.ok
        second = _mark_task_done({"title": "Create style.css"}, ctx)
        assert second.ok
        assert "ALL TASKS COMPLETE" in second.content
        assert "NEXT TASK" not in second.content

    def test_next_task_includes_description(self, tmp_path: Path) -> None:
        ctx = _make_two_step_plan(tmp_path)
        out = _mark_task_done({"title": "Create index.html"}, ctx)
        assert "Implement it now" in out.content
