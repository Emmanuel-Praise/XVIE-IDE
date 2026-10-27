"""Tool system for xvie-agent — a small, correct, permissioned tool registry.

Every tool is a self-contained function that catches its own exceptions and
returns a :class:`ToolOutput` (ok/not-ok + content).  The agent loop wraps
these into the frozen :class:`ToolResult` defined in ``types.py``.

Security model
--------------
* All paths are resolved against ``ToolContext.workspace_root`` and must stay
  inside it.  Path-traversal attempts (``../../etc/passwd``) are rejected.
* Write operations require ``allow_write=True``.
* Shell execution requires ``allow_shell=True`` and enforces a timeout.
"""

from __future__ import annotations

import fnmatch
import glob as globmod
import os
import re
import subprocess
import base64
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable


# Maximum characters accepted in a single write/edit call.  Larger payloads are
# rejected so the model writes big files in chunks (write_file + append_file)
# instead of emitting one massive tool call that exceeds the provider's
# output-token cap and gets silently truncated.  The default already covers
# large files in one shot (~5k tokens); override with XVIE_MAX_WRITE_CHARS.
def _resolve_write_cap() -> int:
    # Default 8000, not 20000: the old default described what the SERVER
    # accepts, but weak models cannot EMIT more than ~8-12k chars per turn
    # (thinking + JSON envelope eat the rest). Guidance quoting this cap
    # must match provider reality or models plan unwritable chunks.
    raw = os.getenv("XVIE_MAX_WRITE_CHARS", "")
    if raw:
        try:
            return max(2000, int(raw))
        except ValueError:
            pass
    return 8000


MAX_WRITE_CONTENT_CHARS = _resolve_write_cap()


def _too_large_message(tool: str) -> str:
    """Chunking guidance returned when a single write/edit payload is too big."""
    return (
        f"{tool} content is too large for a single call "
        f"(max {MAX_WRITE_CONTENT_CHARS} chars). The output-token cap will cut "
        f"off larger payloads. Split the content into chunks of at most "
        f"{MAX_WRITE_CONTENT_CHARS} chars each: call write_file with the FIRST "
        f"part first, then append_file to add the remaining parts. Never retry "
        f"one giant call unchanged."
    )


# ---------------------------------------------------------------------------
# Core dataclasses
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ToolOutput:
    """Lightweight result returned by tool handlers.

    The agent loop converts this into a full :class:`ToolResult` from
    ``types.py`` by attaching the ``tool_call_id``.
    """

    ok: bool
    content: str
    error_kind: str | None = None


@dataclass
class ToolContext:
    """Shared context passed to every tool handler.

    Attributes:
        workspace_root: Absolute path to the project root.  All file tools
            resolve paths relative to this and refuse to leave it.
        allow_write: ``True`` to permit write_file / edit_file.
        allow_shell: ``True`` to permit the bash tool.
        command_timeout_seconds: Max seconds for a bash command before kill.
        max_output_chars: Truncate tool output beyond this many characters.
    """

    workspace_root: Path
    allow_write: bool = False
    allow_shell: bool = False
    command_timeout_seconds: int = 30
    max_output_chars: int = 20_000
    ui_references_read: set[str] = field(default_factory=set)
    provider_client: Any = None
    model_name: str = ""
    ui_render_review_calls: int = 0


@dataclass
class Tool:
    """A single tool the agent can invoke.

    Attributes:
        name: Machine-readable name (must match OpenAI function name rules).
        description: Human-readable explanation shown to the model.
        json_schema: OpenAI function-calling format schema for ``parameters``.
        handler: ``(arguments: dict, ctx: ToolContext) -> ToolOutput``.
    """

    name: str
    description: str
    json_schema: dict
    handler: Callable[[dict, ToolContext], ToolOutput]


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

def _resolve_inside_workspace(path_str: str, ctx: ToolContext) -> Path | None:
    """Resolve *path_str* against ``workspace_root``.

    Returns the resolved :class:`Path` if it lives inside the workspace, or
    ``None`` if it would escape.
    """
    target = (ctx.workspace_root / path_str).resolve()
    try:
        target.relative_to(ctx.workspace_root.resolve())
    except ValueError:
        return None
    return target


def _truncate(text: str, limit: int) -> str:
    """Truncate *text* to *limit* characters with a notice."""
    if len(text) <= limit:
        return text
    return (
        text[:limit]
        + f"\n\n… [truncated — output exceeded {limit} chars]"
    )


def _generate_diff(path: str, old_content: str, new_content: str) -> str:
    """Generate a unified diff between old and new file content.

    Returns a compact diff showing exactly what changed, or an empty string
    if the content is identical.
    """
    import difflib
    old_lines = old_content.splitlines(keepends=True)
    new_lines = new_content.splitlines(keepends=True)
    diff = list(difflib.unified_diff(
        old_lines, new_lines,
        fromfile=f"a/{path}",
        tofile=f"b/{path}",
        n=2,
    ))
    if not diff:
        return ""
    # Keep diff compact — cap at 80 lines to avoid flooding the model
    if len(diff) > 80:
        diff = diff[:80] + ["\n… (diff truncated)\n"]
    return "".join(diff)


def _strip_lines(text: str) -> list[str]:
    """Split into lines stripped of surrounding whitespace, dropping blanks."""
    return [ln.strip() for ln in text.splitlines() if ln.strip()]


def _fuzzy_replace(original: str, old_str: str, new_str: str) -> str | None:
    """Whitespace-insensitive single replacement.

    Matches ``old_str`` against the file ignoring per-line indentation and
    blank lines.  Returns the new full content when exactly one normalized
    match exists, else ``None``.
    """
    orig_lines = original.splitlines()
    old_norm = _strip_lines(old_str)
    if not old_norm or len(old_norm) > len(orig_lines):
        return None

    orig_norm = [ln.strip() for ln in orig_lines]
    matches = [
        i
        for i in range(len(orig_lines) - len(old_norm) + 1)
        if orig_norm[i:i + len(old_norm)] == old_norm
    ]
    if len(matches) != 1:
        return None

    start = matches[0]
    first_line = orig_lines[start]
    indent = first_line[:len(first_line) - len(first_line.lstrip())]
    new_lines = [
        (indent + ln) if ln.strip() else ln
        for ln in new_str.splitlines()
    ]
    out = orig_lines[:start] + new_lines + orig_lines[start + len(old_norm):]
    result = "\n".join(out)
    if original.endswith("\n") and not result.endswith("\n"):
        result += "\n"
    return result


def _closest_snippet(original: str, old_str: str, max_lines: int = 12) -> str:
    """Return the chunk of *original* most similar to *old_str* (error hints)."""
    import difflib

    target = _strip_lines(old_str)
    if not target:
        return ""
    lines = [ln for ln in original.splitlines()]
    norm = [ln.strip() for ln in lines]
    n = len(target)
    best_ratio, best = 0.0, ""
    for i in range(max(1, len(norm) - n + 1)):
        chunk_norm = [ln for ln in norm[i:i + n] if ln]
        if not chunk_norm:
            continue
        ratio = difflib.SequenceMatcher(None, "\n".join(chunk_norm), "\n".join(target)).ratio()
        if ratio > best_ratio:
            best_ratio = ratio
            best = "\n".join(lines[i:i + n])
    return "\n".join(("    " + ln) for ln in best.splitlines()[:max_lines])


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------

def _list_dir(args: dict, ctx: ToolContext) -> ToolOutput:
    """List files and directories at the given path."""
    path_str = args.get("path", ".")
    target = _resolve_inside_workspace(path_str, ctx)
    if target is None:
        return ToolOutput(ok=False, content="", error_kind="path_traversal")
    if not target.exists():
        return ToolOutput(ok=False, content=f"Directory not found: {path_str}", error_kind="not_found")
    if not target.is_dir():
        return ToolOutput(ok=False, content=f"Not a directory: {path_str}", error_kind="not_a_directory")
    try:
        entries: list[str] = []
        for entry in sorted(target.iterdir()):
            prefix = "  " if entry.is_file() else "d "
            entries.append(f"{prefix}{entry.name}")
        return ToolOutput(ok=True, content="\n".join(entries) or "(empty directory)")
    except OSError as exc:
        return ToolOutput(ok=False, content=str(exc), error_kind="os_error")


def _read_file(args: dict, ctx: ToolContext) -> ToolOutput:
    """Read file contents, optionally sliced by line range."""
    path_str = args.get("path", "")
    if not path_str:
        return ToolOutput(ok=False, content="Missing required argument: path", error_kind="missing_argument")
    target = _resolve_inside_workspace(path_str, ctx)
    if target is None:
        return ToolOutput(ok=False, content="", error_kind="path_traversal")
    if not target.exists():
        return ToolOutput(ok=False, content=f"File not found: {path_str}", error_kind="not_found")
    if target.is_dir():
        return ToolOutput(ok=False, content=f"Is a directory: {path_str}", error_kind="is_directory")
    try:
        raw = target.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return ToolOutput(ok=False, content=str(exc), error_kind="os_error")

    lines = raw.splitlines(keepends=True)
    start = args.get("start_line")
    end = args.get("end_line")
    if start is not None or end is not None:
        s = max((start or 1) - 1, 0)
        e = end if end is not None else len(lines)
        lines = lines[s:e]

    content = "".join(lines)
    return ToolOutput(ok=True, content=_truncate(content, ctx.max_output_chars))


def _write_file(args: dict, ctx: ToolContext) -> ToolOutput:
    """Write content to a file, creating parent dirs as needed."""
    if not ctx.allow_write:
        return ToolOutput(ok=False, content="Write permission denied", error_kind="permission_denied")
    path_str = args.get("path", "")
    if not path_str:
        return ToolOutput(ok=False, content="Missing required argument: path", error_kind="missing_argument")
    content = args.get("content", "")
    if len(content) > MAX_WRITE_CONTENT_CHARS:
        return ToolOutput(
            ok=False,
            content=_too_large_message("write_file"),
            error_kind="content_too_large",
        )
    target = _resolve_inside_workspace(path_str, ctx)
    if target is None:
        return ToolOutput(ok=False, content="", error_kind="path_traversal")
    # Read old content BEFORE writing for diff generation
    old_content = ""
    if target.exists():
        try:
            old_content = target.read_text(encoding="utf-8", errors="replace")
        except OSError:
            pass
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    except OSError as exc:
        return ToolOutput(ok=False, content=str(exc), error_kind="os_error")
    line_count = len(content.splitlines())
    char_count = len(content)
    # Generate diff showing what changed
    diff = _generate_diff(path_str, old_content, content)
    if old_content:
        # Overwrite — show what changed
        old_lines = len(old_content.splitlines())
        parts = [f"Written {char_count} chars ({line_count} lines) to {path_str} (overwrote {old_lines} lines)"]
    else:
        parts = [f"Created {path_str} ({line_count} lines, {char_count} chars)"]
    if diff:
        parts.append(f"\nChanges:\n{diff}")
    return ToolOutput(ok=True, content="\n".join(parts))


def _append_file(args: dict, ctx: ToolContext) -> ToolOutput:
    """Append content to an existing file — for building large files in chunks.

    Reports the new total char/line count so the model knows how much more
    it still needs to write to reach the target scale.
    """
    if not ctx.allow_write:
        return ToolOutput(ok=False, content="Write permission denied", error_kind="permission_denied")
    path_str = args.get("path", "")
    content = args.get("content", "")
    if not path_str:
        return ToolOutput(ok=False, content="Missing required argument: path", error_kind="missing_argument")
    if not content:
        return ToolOutput(ok=False, content="Missing required argument: content", error_kind="missing_argument")
    if len(content) > MAX_WRITE_CONTENT_CHARS:
        return ToolOutput(
            ok=False,
            content=_too_large_message("append_file"),
            error_kind="content_too_large",
        )
    target = _resolve_inside_workspace(path_str, ctx)
    if target is None:
        return ToolOutput(ok=False, content="", error_kind="path_traversal")
    if not target.exists():
        return ToolOutput(
            ok=False,
            content=f"File not found: {path_str} — use write_file first to create it.",
            error_kind="not_found",
        )
    # Read old content BEFORE appending for diff generation
    try:
        old_content = target.read_text(encoding="utf-8", errors="replace")
    except OSError:
        old_content = ""
    try:
        with open(target, "a", encoding="utf-8") as fh:
            fh.write(content)
    except OSError as exc:
        return ToolOutput(ok=False, content=str(exc), error_kind="os_error")
    total = target.read_text(encoding="utf-8", errors="replace")
    # Generate diff showing what was appended
    diff = _generate_diff(path_str, old_content, total)
    parts = [
        f"Appended {len(content)} chars ({len(content.splitlines())} lines) to {path_str}. "
        f"File now has {len(total)} chars ({len(total.splitlines())} lines)."
    ]
    if diff:
        parts.append(f"\nChanges:\n{diff}")
    return ToolOutput(ok=True, content="\n".join(parts))


def _file_size(args: dict, ctx: ToolContext) -> ToolOutput:
    """Return the current char/line count of a file so the model can track scale."""
    path_str = args.get("path", "")
    if not path_str:
        return ToolOutput(ok=False, content="Missing required argument: path", error_kind="missing_argument")
    target = _resolve_inside_workspace(path_str, ctx)
    if target is None:
        return ToolOutput(ok=False, content="", error_kind="path_traversal")
    if not target.exists():
        return ToolOutput(ok=False, content=f"File not found: {path_str}", error_kind="not_found")
    try:
        total = target.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return ToolOutput(ok=False, content=str(exc), error_kind="os_error")
    return ToolOutput(
        ok=True,
        content=f"{path_str}: {len(total)} chars, {len(total.splitlines())} lines.",
    )


def _verify_file(args: dict, ctx: ToolContext) -> ToolOutput:
    """Run artifact validation on a changed file and report defects for repair.

    Uses the shared validators: py syntax / json parseability / css brace
    balance / complete HTML document (incl. rich website checks).  This is the
    agent's self-check before reporting a task complete.

    For website tasks, also checks cross-file HTML/CSS consistency.
    """
    from xvie_agent.execution import (
        collect_design_warnings,
        is_website_task,
        validate_changed_file,
        validate_cross_file_consistency,
        validate_layout_pair,
        validate_responsive_render,
    )

    path = args.get("path", "")
    if not path:
        return ToolOutput(ok=False, content="Missing required argument: path", error_kind="missing_argument")
    error = validate_changed_file(
        path,
        ctx.workspace_root,
        rich_html=args.get("rich_html", is_website_task(path)),
    )
    if error:
        return ToolOutput(
            ok=False,
            content=f"Verification of {path} FAILED:\n{error}\n\nRepair the file now, then call verify_file again.",
            error_kind="artifact_validation_failed",
        )

    if path.lower().endswith((".html", ".htm")) and args.get("rich_html", is_website_task(path)):
        render_error = validate_responsive_render(path, ctx.workspace_root)
        if render_error:
            return ToolOutput(
                ok=False,
                content=f"Verification of {path} FAILED:\n{render_error}\n\nRepair the layout now, then call verify_file again.",
                error_kind="responsive_render_failed",
            )

    # Cross-file consistency check for HTML/CSS pairs
    suffix = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    if suffix in {"html", "htm", "css"}:
        # Find sibling HTML/CSS files in the same directory
        target = (ctx.workspace_root / path).resolve()
        sibling_dir = target.parent
        changed = []
        try:
            for f in sibling_dir.iterdir():
                if f.suffix.lower() in {".html", ".htm", ".css"}:
                    changed.append(str(f.relative_to(ctx.workspace_root)))
        except OSError:
            pass
        cross_error = validate_cross_file_consistency(ctx.workspace_root, changed)
        if cross_error:
            return ToolOutput(
                ok=False,
                content=f"Cross-file consistency FAILED for {path}:\n{cross_error}\n\nFix the mismatch between HTML and CSS files.",
                error_kind="cross_file_mismatch",
            )

        # Layout quality check for HTML+CSS pairs
        if suffix in {"html", "htm"}:
            html_content = target.read_text(encoding="utf-8", errors="replace") if target.exists() else ""
            # Find the main CSS file among siblings
            for fpath in changed:
                fp = (ctx.workspace_root / fpath).resolve()
                if fp.suffix.lower() == ".css" and fp.exists():
                    try:
                        css_content = fp.read_text(encoding="utf-8", errors="replace")
                        layout_error = validate_layout_pair(html_content, css_content, path)
                        if layout_error:
                            return ToolOutput(
                                ok=False,
                                content=f"Layout quality FAILED for {path}:\n{layout_error}\n\nFix the layout issues, then call verify_file again.",
                                error_kind="layout_quality_failed",
                            )
                    except OSError:
                        pass

    # Advisory design warnings — surfaced, never blocking.
    warn_block = ""
    if suffix in {"html", "htm", "css"}:
        design_warnings = collect_design_warnings(ctx.workspace_root, path)
        if design_warnings:
            seen = list(dict.fromkeys(design_warnings))[:10]
            warn_block = "\n\nDesign warnings (advisory — do not block):\n" + "\n".join(
                f"  - {w}" for w in seen
            )
    return ToolOutput(ok=True, content=f"Verification PASSED: {path} is complete and well-formed.{warn_block}")


def _edit_file(args: dict, ctx: ToolContext) -> ToolOutput:
    """Exact string replacement in a file.  Must match exactly once."""
    if not ctx.allow_write:
        return ToolOutput(ok=False, content="Write permission denied", error_kind="permission_denied")
    path_str = args.get("path", "")
    old_str = args.get("old_str", "")
    new_str = args.get("new_str", "")
    if not path_str:
        return ToolOutput(ok=False, content="Missing required argument: path", error_kind="missing_argument")
    if len(new_str) > MAX_WRITE_CONTENT_CHARS:
        return ToolOutput(
            ok=False,
            content=_too_large_message("edit_file"),
            error_kind="content_too_large",
        )
    # Check path traversal BEFORE other validations — security first.
    target = _resolve_inside_workspace(path_str, ctx)
    if target is None:
        return ToolOutput(ok=False, content="", error_kind="path_traversal")
    if not old_str:
        return ToolOutput(ok=False, content="old_str must not be empty", error_kind="missing_argument")
    if not target.exists():
        return ToolOutput(ok=False, content=f"File not found: {path_str}", error_kind="not_found")
    try:
        original = target.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return ToolOutput(ok=False, content=str(exc), error_kind="os_error")

    count = original.count(old_str)
    if count == 0:
        # Try a whitespace-insensitive match before giving up.
        fuzzy = _fuzzy_replace(original, old_str, new_str)
        if fuzzy is not None:
            try:
                target.write_text(fuzzy, encoding="utf-8")
            except OSError as exc:
                return ToolOutput(ok=False, content=str(exc), error_kind="os_error")
            return ToolOutput(
                ok=True,
                content=f"Replaced 1 occurrence in {path_str} (matched ignoring indentation differences)",
            )
        hint = _closest_snippet(original, old_str)
        msg = (
            f"old_str matched 0 times in {path_str} — no replacement made. "
            "Read the file again and copy the exact text including whitespace."
        )
        if hint:
            msg += f"\nClosest matching section:\n{hint}"
        return ToolOutput(ok=False, content=msg, error_kind="no_match")
    if count > 1:
        return ToolOutput(
            ok=False,
            content=(
                f"old_str matched {count} times in {path_str}, must be exactly 1 — "
                "no replacement made. Include more surrounding lines to make it unique."
            ),
            error_kind="multiple_matches",
        )

    new_content = original.replace(old_str, new_str, 1)
    try:
        target.write_text(new_content, encoding="utf-8")
    except OSError as exc:
        return ToolOutput(ok=False, content=str(exc), error_kind="os_error")
    # Generate diff showing what changed
    diff = _generate_diff(path_str, original, new_content)
    parts = [f"Replaced 1 occurrence in {path_str}"]
    if diff:
        parts.append(f"\nChanges:\n{diff}")
    return ToolOutput(ok=True, content="\n".join(parts))


# Directories to exclude from glob/grep searches
_EXCLUDE_DIRS = {".venv", "node_modules", "__pycache__", ".git", ".xvie-sessions", ".forge-sessions", ".pytest_cache"}


def _should_exclude(path: Path) -> bool:
    """Check if a path is inside an excluded directory."""
    for part in path.parts:
        if part in _EXCLUDE_DIRS or part.startswith("."):
            return True
    return False


def _glob_search(args: dict, ctx: ToolContext) -> ToolOutput:
    """Find files matching a glob pattern relative to workspace_root."""
    pattern = args.get("pattern", "")
    if not pattern:
        return ToolOutput(ok=False, content="Missing required argument: pattern", error_kind="missing_argument")
    try:
        matches = sorted(
            str(p.relative_to(ctx.workspace_root))
            for p in ctx.workspace_root.rglob("*")
            if p.is_file() and not _should_exclude(p.relative_to(ctx.workspace_root)) and (
                fnmatch.fnmatch(p.name, pattern)  # Match against filename
                or fnmatch.fnmatch(str(p.relative_to(ctx.workspace_root)), pattern)  # Match against relative path
            )
        )
    except OSError as exc:
        return ToolOutput(ok=False, content=str(exc), error_kind="os_error")
    content = "\n".join(matches) or "(no matches)"
    return ToolOutput(ok=True, content=_truncate(content, ctx.max_output_chars))


def _grep_search(args: dict, ctx: ToolContext) -> ToolOutput:
    """Search file contents for a regex pattern (ripgrep-style)."""
    pattern = args.get("pattern", "")
    if not pattern:
        return ToolOutput(ok=False, content="Missing required argument: pattern", error_kind="missing_argument")
    search_path = args.get("path", ".")
    target = _resolve_inside_workspace(search_path, ctx)
    if target is None:
        return ToolOutput(ok=False, content="", error_kind="path_traversal")
    try:
        regex = re.compile(pattern)
    except re.error as exc:
        return ToolOutput(ok=False, content=f"Invalid regex: {exc}", error_kind="invalid_regex")

    results: list[str] = []
    files_searched = 0
    try:
        if target.is_file():
            files_to_search = [target]
        else:
            files_to_search = sorted(
                p for p in target.rglob("*")
                if p.is_file() and not _should_exclude(p.relative_to(ctx.workspace_root))
            )
        for fpath in files_to_search:
            files_searched += 1
            try:
                text = fpath.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for i, line in enumerate(text.splitlines(), 1):
                if regex.search(line):
                    rel = str(fpath.relative_to(ctx.workspace_root))
                    results.append(f"{rel}:{i}: {line.strip()}")
                    if len(results) >= 200:
                        results.append("… (search truncated at 200 matches)")
                        content = "\n".join(results)
                        return ToolOutput(ok=True, content=_truncate(content, ctx.max_output_chars))
    except OSError as exc:
        return ToolOutput(ok=False, content=str(exc), error_kind="os_error")

    if not results:
        return ToolOutput(ok=True, content=f"No matches found (searched {files_searched} files)")
    content = "\n".join(results)
    return ToolOutput(ok=True, content=_truncate(content, ctx.max_output_chars))


def _run_code(args: dict, ctx: ToolContext) -> ToolOutput:
    """Execute a code snippet in a temporary file with the appropriate interpreter."""
    if not ctx.allow_shell:
        return ToolOutput(ok=False, content="Shell permission denied", error_kind="permission_denied")

    language = args.get("language", "python")
    code = args.get("code", "")
    if not code:
        return ToolOutput(ok=False, content="Missing code", error_kind="missing_argument")

    import tempfile
    import sys
    import platform
    import subprocess as _sp
    ext_map = {"python": ".py", "javascript": ".js", "bash": ".sh"}
    interp_map = {"python": sys.executable, "javascript": "node", "bash": "bash"}
    ext = ext_map.get(language, ".py")
    interp = interp_map.get(language, "python3")
    tmp_path: str | None = None

    try:
        if language == "bash" and platform.system() == "Windows":
            result = _sp.run(
                ["cmd.exe", "/c", code], capture_output=True, text=True,
                timeout=ctx.command_timeout_seconds, cwd=str(ctx.workspace_root),
            )
            output = (result.stdout or "") + (("\n" if result.stdout else "") + result.stderr if result.stderr else "")
            return ToolOutput(ok=result.returncode == 0, content=_truncate(output, ctx.max_output_chars), error_kind=None if result.returncode == 0 else "exit_code")
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=ext, dir=str(ctx.workspace_root), delete=False
        ) as f:
            f.write(code)
            f.flush()
            tmp_path = f.name

        result = _sp.run(
            [interp, tmp_path],
            capture_output=True,
            text=True,
            timeout=ctx.command_timeout_seconds,
            cwd=str(ctx.workspace_root),
        )
        stdout = result.stdout or ""
        stderr = result.stderr or ""
        output = stdout
        if stderr:
            output += ("\n" if output else "") + stderr
        if result.returncode != 0:
            output += f"\n(exit code: {result.returncode})"
        return ToolOutput(ok=True, content=_truncate(output, ctx.max_output_chars))
    except _sp.TimeoutExpired:
        return ToolOutput(ok=False, content=f"Execution timed out after {ctx.command_timeout_seconds}s", error_kind="timeout")
    except Exception as exc:
        return ToolOutput(ok=False, content=str(exc), error_kind="execution_error")
    finally:
        if tmp_path:
            try:
                import os
                os.unlink(tmp_path)
            except Exception:
                pass


def _bash(args: dict, ctx: ToolContext) -> ToolOutput:
    """Execute a shell command with timeout and output truncation."""
    if not ctx.allow_shell:
        return ToolOutput(ok=False, content="Shell permission denied", error_kind="permission_denied")
    command = args.get("command", "")
    if not command:
        return ToolOutput(ok=False, content="Missing required argument: command", error_kind="missing_argument")

    import platform
    is_windows = platform.system() == "Windows"

    try:
        if is_windows:
            # Use the active interpreter when a task asks for `python`.
            # Windows installations often do not provide a python3 shim.
            import re as _re
            import sys as _sys
            command = _re.sub(r"^(python3?|py)(?=\s)", lambda _: f'"{_sys.executable}"', command, count=1)
            # On Windows, use Popen + killpg-equivalent via taskkill /T
            proc = subprocess.Popen(
                command,
                shell=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=str(ctx.workspace_root),
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
            )
            try:
                stdout, stderr = proc.communicate(timeout=ctx.command_timeout_seconds)
            except subprocess.TimeoutExpired:
                # Kill the entire process tree on Windows
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                    capture_output=True,
                )
                stdout, stderr = proc.communicate(timeout=5)
                return ToolOutput(
                    ok=False,
                    content=f"Command timed out after {ctx.command_timeout_seconds}s: {command}",
                    error_kind="timeout",
                )
        else:
            # On Unix, use start_new_session=True so we can kill the whole process group
            result = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=ctx.command_timeout_seconds,
                cwd=str(ctx.workspace_root),
                start_new_session=True,
            )
            stdout = result.stdout or ""
            stderr = result.stderr or ""

        combined = (stdout or "")
        if stderr:
            combined += ("\n" if combined else "") + stderr
        returncode = proc.returncode if is_windows else result.returncode
        if returncode != 0:
            combined += f"\n(exit code: {returncode})"
        return ToolOutput(ok=True, content=_truncate(combined, ctx.max_output_chars))
    except subprocess.TimeoutExpired:
        return ToolOutput(
            ok=False,
            content=f"Command timed out after {ctx.command_timeout_seconds}s: {command}",
            error_kind="timeout",
        )
    except Exception as exc:
        return ToolOutput(ok=False, content=str(exc), error_kind="execution_error")


def _move_file(args: dict, ctx: ToolContext) -> ToolOutput:
    """Move/rename a file within the workspace."""
    if not ctx.allow_write:
        return ToolOutput(ok=False, content="Write permission denied", error_kind="permission_denied")
    src = args.get("src", "")
    dst = args.get("dst", "")
    if not src or not dst:
        return ToolOutput(ok=False, content="Missing src or dst", error_kind="missing_argument")
    src_path = _resolve_inside_workspace(src, ctx)
    dst_path = _resolve_inside_workspace(dst, ctx)
    if src_path is None:
        return ToolOutput(ok=False, content="Source path outside workspace", error_kind="path_traversal")
    if dst_path is None:
        return ToolOutput(ok=False, content="Destination path outside workspace", error_kind="path_traversal")
    if not src_path.exists():
        return ToolOutput(ok=False, content=f"Source not found: {src}", error_kind="file_not_found")
    try:
        dst_path.parent.mkdir(parents=True, exist_ok=True)
        src_path.rename(dst_path)
        return ToolOutput(ok=True, content=f"Moved {src} -> {dst}")
    except Exception as exc:
        return ToolOutput(ok=False, content=str(exc), error_kind="move_error")


def _delete_file(args: dict, ctx: ToolContext) -> ToolOutput:
    """Delete a file within the workspace."""
    if not ctx.allow_write:
        return ToolOutput(ok=False, content="Write permission denied", error_kind="permission_denied")
    path = args.get("path", "")
    if not path:
        return ToolOutput(ok=False, content="Missing path", error_kind="missing_argument")
    target = _resolve_inside_workspace(path, ctx)
    if target is None:
        return ToolOutput(ok=False, content="Path outside workspace", error_kind="path_traversal")
    if not target.exists():
        return ToolOutput(ok=False, content=f"File not found: {path}", error_kind="file_not_found")
    try:
        target.unlink()
        return ToolOutput(ok=True, content=f"Deleted {path}")
    except Exception as exc:
        return ToolOutput(ok=False, content=str(exc), error_kind="delete_error")


def _apply_patch(args: dict, ctx: ToolContext) -> ToolOutput:
    """Apply multiple exact-string replacements atomically across files.

    Validates ALL replacements first. If any fail, NO files are modified.
    """
    if not ctx.allow_write:
        return ToolOutput(ok=False, content="Write permission denied", error_kind="permission_denied")

    files = args.get("files", [])
    if not files:
        return ToolOutput(ok=False, content="No files provided", error_kind="missing_argument")

    # Phase 1: Validate all replacements
    validated: list[tuple[Path, str, str, str]] = []  # (path, original_content, old_str, new_str)
    for entry in files:
        path_str = entry.get("path", "")
        old_str = entry.get("old_str", "")
        new_str = entry.get("new_str", "")

        if not path_str or not old_str:
            return ToolOutput(
                ok=False,
                content=f"Missing path or old_str in entry: {entry}",
                error_kind="missing_argument",
            )

        target = _resolve_inside_workspace(path_str, ctx)
        if target is None:
            return ToolOutput(ok=False, content=f"Path outside workspace: {path_str}", error_kind="path_traversal")
        if not target.exists():
            return ToolOutput(ok=False, content=f"File not found: {path_str}", error_kind="file_not_found")

        content = target.read_text(encoding="utf-8")
        count = content.count(old_str)
        if count == 0:
            return ToolOutput(
                ok=False,
                content=f"In {path_str}: old_str matched 0 times",
                error_kind="no_match",
            )
        if count > 1:
            return ToolOutput(
                ok=False,
                content=f"In {path_str}: old_str matched {count} times, must be exactly 1",
                error_kind="multiple_matches",
            )
        validated.append((target, content, old_str, new_str))

    # Phase 2: Apply all replacements
    for target, original_content, old_str, new_str in validated:
        new_content = original_content.replace(old_str, new_str, 1)
        target.write_text(new_content, encoding="utf-8")

    return ToolOutput(ok=True, content=f"{len(validated)} files patched successfully.")


def _diff_preview(args: dict, ctx: ToolContext) -> ToolOutput:
    """Show a unified diff between a file and new content WITHOUT writing."""
    import difflib
    path_str = args.get("path", "")
    new_content = args.get("new_content", "")
    if not path_str:
        return ToolOutput(ok=False, content="Missing path", error_kind="missing_argument")

    target = ctx.workspace_root / path_str
    if target.exists():
        old_content = target.read_text(encoding="utf-8")
    else:
        old_content = ""

    diff = difflib.unified_diff(
        old_content.splitlines(keepends=True),
        new_content.splitlines(keepends=True),
        fromfile=f"a/{path_str}",
        tofile=f"b/{path_str}",
    )
    diff_text = "".join(diff)
    if not diff_text:
        return ToolOutput(ok=True, content="No differences.")
    return ToolOutput(ok=True, content=diff_text)


def search_commons_images(query: str, per_page: int = 6) -> list[dict[str, Any]]:
    """Search Wikimedia Commons without credentials and retain attribution metadata."""
    import html
    import json
    import urllib.parse
    import urllib.request

    params = {
        "action": "query", "generator": "search", "gsrnamespace": 6,
        "gsrsearch": query, "gsrlimit": min(max(per_page, 1), 15),
        "prop": "imageinfo", "iiprop": "url|extmetadata", "iiurlwidth": 1200,
        "format": "json", "formatversion": 2,
    }
    request = urllib.request.Request(
        "https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode(params),
        headers={"User-Agent": "XVIE-IDE/1.0 (Wikimedia Commons image search)"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        payload = json.loads(response.read().decode("utf-8"))
    pages = payload.get("query", {}).get("pages", [])
    if isinstance(pages, dict):
        pages = list(pages.values())

    def clean(value: str) -> str:
        return html.unescape(re.sub(r"<[^>]*>", "", value or "")).strip()

    results = []
    for page in pages:
        info = (page.get("imageinfo") or [{}])[0]
        meta = info.get("extmetadata") or {}
        original = info.get("url", "")
        thumb = info.get("thumburl", "") or original
        if not original:
            continue
        title = str(page.get("title", "")).removeprefix("File:")
        description = clean((meta.get("ImageDescription") or {}).get("value", ""))
        artist = clean((meta.get("Artist") or {}).get("value", "")) or "Wikimedia Commons contributor"
        license_name = clean((meta.get("LicenseShortName") or {}).get("value", "")) or "See source page for license"
        source = "https://commons.wikimedia.org/wiki/" + urllib.parse.quote(str(page.get("title", "")).replace(" ", "_"))
        results.append({
            "alt": description[:300] or title,
            "heroUrl": thumb,
            "thumbnailUrl": thumb,
            "sourceUrl": source,
            "photographer": artist[:160],
            "license": license_name[:100],
            "credit": f"{artist} / Wikimedia Commons ({license_name})",
            "width": info.get("width", 0),
            "height": info.get("height", 0),
        })
    return results


def _search_commons_images(query: str, per_page: int, pexels_error: str | None = None) -> ToolOutput:
    try:
        commons = search_commons_images(query, per_page)
    except Exception as exc:
        detail = f"Wikimedia Commons search failed: {type(exc).__name__}: {exc}"
        if pexels_error:
            detail = f"Pexels search failed ({pexels_error}); {detail}"
        return ToolOutput(ok=False, content=f"Image search could not complete. {detail}", error_kind="api_error")
    if not commons:
        reason = f"Pexels was unavailable ({pexels_error}); " if pexels_error else ""
        return ToolOutput(ok=True, content=f"{reason}no Wikimedia Commons images found for '{query}'. Try a more specific query.")
    lines = [f"{i}. {image['alt']}\n   Image URL: {image['heroUrl']}\n   Credit: {image['credit']}\n   Source: {image['sourceUrl']}"
             for i, image in enumerate(commons, 1)]
    reason = f"Pexels was unavailable ({pexels_error}), so this uses Wikimedia Commons. " if pexels_error else ""
    return ToolOutput(ok=True, content=(f"{reason}Found {len(commons)} Wikimedia Commons image(s) for '{query}'. Use the direct image URL, descriptive alt text, loading='lazy', and include each result's credit and source link.\n\n" + "\n\n".join(lines)))


def _search_images(args: dict, ctx: ToolContext) -> ToolOutput:
    """Search for images using the Pexels API and return direct image URLs.

    Returns a list of image results with URLs, dimensions, and photographer
    attribution. The agent can use these URLs directly in HTML <img> tags.
    """
    raw_query = args.get("query", "")
    query = raw_query.strip() if isinstance(raw_query, str) else ""
    if not query:
        return ToolOutput(ok=False, content="Missing required argument: query", error_kind="missing_argument")

    try:
        per_page = min(max(int(args.get("per_page", 6)), 1), 15)
    except (TypeError, ValueError):
        per_page = 6

    import urllib.request
    import urllib.parse
    import json as _json

    # Get API key from environment
    api_key = os.environ.get("PEXELS_API_KEY", "")
    if not api_key:
        return _search_commons_images(query, per_page)

    try:
        url = f"https://api.pexels.com/v1/search?query={urllib.parse.quote(query)}&per_page={per_page}"
        req = urllib.request.Request(url, headers={"Authorization": api_key})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = _json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return _search_commons_images(query, per_page, f"HTTP {exc.code}: {exc.reason}")
    except Exception as exc:
        return _search_commons_images(query, per_page, f"{type(exc).__name__}: {exc}")

    if not isinstance(data, dict) or not isinstance(data.get("photos", []), list):
        return _search_commons_images(query, per_page, "Pexels returned an unexpected response")
    photos = data.get("photos", [])
    if not photos:
        return _search_commons_images(query, per_page, "Pexels returned no matches")

    results: list[str] = []
    for i, photo in enumerate(photos, 1):
        if not isinstance(photo, dict):
            continue
        src = photo.get("src", {})
        if not isinstance(src, dict):
            continue
        photographer = photo.get("photographer", "Unknown")
        photo_url = photo.get("url", "")
        width = photo.get("width", 0)
        height = photo.get("height", 0)
        alt_desc = photo.get("alt", query)
        avg_color = photo.get("avg_color", "")

        # Get multiple sizes for the agent to choose from
        hero_url = src.get("landscape") or src.get("large2x") or src.get("large") or ""
        thumb_url = src.get("medium") or src.get("small") or ""
        original_url = src.get("original") or ""

        if not hero_url and not thumb_url:
            continue  # Skip if no usable URL

        results.append(
            f"{i}. {alt_desc}\n"
            f"   Hero/banner (1200px wide): {hero_url}\n"
            f"   Thumbnail (350px tall): {thumb_url}\n"
            f"   Full size: {original_url}\n"
            f"   Dimensions: {width}x{height}px | Color: {avg_color} | "
            f"Photographer: {photographer} | Source: {photo_url}"
        )

    if not results:
        return _search_commons_images(query, per_page, "Pexels returned no usable image URLs")

    header = (
        f"Found {len(results)} image(s) for '{query}':\n"
        "IMPORTANT: Use the Hero/banner URL for main images and Thumbnail URL for smaller images. "
        "Always add loading='lazy' to <img> tags for performance. "
        "Always add a descriptive alt attribute. "
        "Use image credits for the photographer and link to the returned photo source."
    )
    return ToolOutput(ok=True, content=header + "\n\n".join(results))


def _check_contrast(args: dict, ctx: ToolContext) -> ToolOutput:
    """Compute WCAG contrast ratio between two hex colors."""
    fg = args.get("fg_hex", "")
    bg = args.get("bg_hex", "")
    if not fg or not bg:
        return ToolOutput(ok=False, content="Missing fg_hex or bg_hex", error_kind="missing_argument")

    def _relative_luminance(hex_color: str) -> float:
        hex_color = hex_color.lstrip("#")
        if len(hex_color) != 6:
            raise ValueError(f"Invalid hex color: {hex_color}")
        r, g, b = (int(hex_color[i:i+2], 16) / 255.0 for i in (0, 2, 4))
        # sRGB linearization
        def linearize(c: float) -> float:
            return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
        return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b)

    try:
        l1 = _relative_luminance(fg)
        l2 = _relative_luminance(bg)
    except ValueError as exc:
        return ToolOutput(ok=False, content=str(exc), error_kind="invalid_color")

    lighter = max(l1, l2)
    darker = min(l1, l2)
    ratio = (lighter + 0.05) / (darker + 0.05)

    passes_aa_normal = ratio >= 4.5
    passes_aa_large = ratio >= 3.0
    passes_aaa_normal = ratio >= 7.0

    result = (
        f"Contrast ratio: {ratio:.2f}:1\n"
        f"WCAG AA normal text: {'PASS' if passes_aa_normal else 'FAIL'} (4.5:1 required)\n"
        f"WCAG AA large text:  {'PASS' if passes_aa_large else 'FAIL'} (3.0:1 required)\n"
        f"WCAG AAA normal:     {'PASS' if passes_aaa_normal else 'FAIL'} (7.0:1 required)"
    )
    return ToolOutput(ok=True, content=result)


def _preview_artifact(args: dict, ctx: ToolContext) -> ToolOutput:
    """Open an HTML file in the default browser for live preview.

    Starts a local HTTP server if needed and opens the file so the user
    can see the rendered UI immediately.
    """
    path = args.get("path", "")
    if not path:
        return ToolOutput(ok=False, content="Missing path", error_kind="missing_argument")

    target = ctx.workspace_root / path
    if not target.exists():
        return ToolOutput(ok=False, content=f"File not found: {path}", error_kind="file_not_found")

    # Validate it's a web artifact
    valid_exts = {".html", ".htm", ".css", ".js", ".jsx", ".tsx", ".vue", ".svelte"}
    if target.suffix.lower() not in valid_exts:
        return ToolOutput(
            ok=False,
            content=f"Not a web artifact: {path} (expected {', '.join(valid_exts)})",
            error_kind="not_artifact",
        )

    import webbrowser
    import threading
    import http.server
    import functools
    import socket

    # Find a free port
    def _free_port() -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("", 0))
            return s.getsockname()[1]

    port = _free_port()
    file_url = f"file://{target.resolve()}"

    # For HTML files, start a lightweight server so relative paths work
    if target.suffix.lower() in {".html", ".htm"}:
        handler = functools.partial(
            http.server.SimpleHTTPRequestHandler,
            directory=str(ctx.workspace_root),
        )
        server = http.server.HTTPServer(("127.0.0.1", port), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{port}/{path}"
        webbrowser.open(url)
        return ToolOutput(
            ok=True,
            content=f"Preview opened in browser: {url}\nServer running on port {port} (will stop when the agent exits)."
        )
    else:
        webbrowser.open(file_url)
        return ToolOutput(
            ok=True,
            content=f"Opened {path} in browser."
        )


def _review_ui_render(args: dict, ctx: ToolContext) -> ToolOutput:
    """Capture desktop/mobile renders and report basic browser diagnostics."""
    path = args.get("path", "")
    if not path:
        return ToolOutput(ok=False, content="Missing path", error_kind="missing_argument")
    target = _resolve_inside_workspace(path, ctx)
    if target is None:
        return ToolOutput(ok=False, content="Path must stay inside the workspace", error_kind="path_traversal")
    if not target.is_file() or target.suffix.lower() not in {".html", ".htm"}:
        return ToolOutput(ok=False, content="Expected an HTML file inside the workspace", error_kind="not_artifact")
    if ctx.ui_render_review_calls >= 2:
        return ToolOutput(ok=False, content="Render review limit reached for this run (one critique and one post-repair capture).", error_kind="review_limit")
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return ToolOutput(
            ok=False,
            content="UI render review needs the optional visual extra. Install with `pip install -e .[visual]`, then run `playwright install chromium --no-shell`.",
            error_kind="dependency_missing",
        )
    ctx.ui_render_review_calls += 1

    review_dir = ctx.workspace_root / ".xvie" / "reviews"
    review_dir.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^a-zA-Z0-9_-]+", "-", target.stem).strip("-") or "page"
    diagnostics: list[str] = []
    artifacts: list[str] = []
    review_images: list[bytes] = []
    import functools
    import http.server
    import threading
    from urllib.parse import quote

    class QuietHandler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:
            return

    handler = functools.partial(QuietHandler, directory=str(ctx.workspace_root))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    relative_path = target.relative_to(ctx.workspace_root).as_posix()
    page_url = f"http://127.0.0.1:{server.server_port}/{quote(relative_path, safe='/')}"
    try:
        with sync_playwright() as playwright:
            # The full Chromium build works with modern headless mode and
            # avoids requiring Playwright's separate headless-shell download.
            browser = playwright.chromium.launch(channel="chromium")
            try:
                for label, width, height in (("desktop", 1440, 1000), ("mobile", 390, 844)):
                    page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
                    page.on("pageerror", lambda error: diagnostics.append(f"JavaScript error: {error}"))
                    page.on("console", lambda msg: diagnostics.append(f"Console {msg.type}: {msg.text}") if msg.type == "error" else None)
                    page.goto(page_url, wait_until="domcontentloaded", timeout=30_000)
                    # Let fonts and lightweight entrance effects settle without
                    # hanging on analytics, polling, or long-lived connections.
                    page.wait_for_timeout(500)
                    page.screenshot(path=str(review_dir / f"{stem}-{label}.jpg"), full_page=True, type="jpeg", quality=65)
                    # Send only the initial viewport to the model. Full-page
                    # captures can be extremely tall and inflate API payloads.
                    review_images.append(page.screenshot(type="jpeg", quality=45, full_page=False))
                    metrics = page.evaluate("""() => ({
                      viewport: document.documentElement.clientWidth,
                      document: document.documentElement.scrollWidth,
                      height: document.documentElement.scrollHeight,
                      title: document.title
                    })""")
                    overflow = metrics["document"] > metrics["viewport"] + 1
                    diagnostics.append(
                        f"{label} {width}x{height}: horizontal overflow={'yes' if overflow else 'no'}, "
                        f"document={metrics['document']}px, viewport={metrics['viewport']}px, "
                        f"page-height={metrics['height']}px, title={metrics['title']!r}"
                    )
                    artifacts.append(str((review_dir / f"{stem}-{label}.jpg").relative_to(ctx.workspace_root)))
                    page.close()
            finally:
                browser.close()
    except Exception as exc:
        return ToolOutput(ok=False, content=f"Browser render review failed: {exc}", error_kind="browser_error")
    finally:
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=2)
    vision_review = "Vision critique unavailable; screenshots are saved for human inspection."
    if ctx.provider_client is not None and ctx.model_name and ctx.ui_render_review_calls == 1:
        try:
            image_parts = []
            for image_bytes in review_images:
                encoded = base64.b64encode(image_bytes).decode("ascii")
                image_parts.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{encoded}", "detail": "high"},
                })
            review_message = {
                "role": "user",
                "content": [
                    {"type": "text", "text": (
                        "Review these desktop and mobile screenshots of the same website. "
                        "Name at most three concrete, high-impact visual or responsive defects. "
                        "Prioritize hierarchy, clipping/overlap, spacing, readability, and whether "
                        "the page looks product-specific. Ignore personal taste, avoid requesting "
                        "3D/decorative effects, and return 'No high-impact visual issues found' "
                        "if none are clear. Give file-specific CSS/HTML direction briefly."
                    )},
                    *image_parts,
                ],
            }
            vision_model = os.getenv("XVIE_VISION_MODEL", "").strip() or ctx.model_name
            response = ctx.provider_client.complete(
                model=vision_model,
                messages=[
                    {"role": "system", "content": "You are a concise visual UI reviewer. Judge only visible evidence in the provided screenshots."},
                    review_message,
                ],
                temperature=0,
                max_tokens=500,
            )
            vision_review = f"Vision critique ({vision_model}):\n{response.content.strip() or '(no critique returned)'}"
        except Exception as exc:
            vision_review = (
                "Vision critique unavailable for this provider/model; screenshots and "
                f"browser diagnostics are still available. ({type(exc).__name__}: {exc})"
            )
    elif ctx.ui_render_review_calls > 1:
        vision_review = "Post-repair capture only; the single vision critique for this run has already been used."
    return ToolOutput(
        ok=True,
        content=("Desktop and mobile screenshots captured; browser checks report runtime errors and horizontal overflow.\n"
                 + "\n".join(f"- {item}" for item in artifacts)
                 + "\n\nBrowser diagnostics:\n"
                 + "\n".join(f"- {item}" for item in diagnostics)
                 + "\n\n" + vision_review),
    )


def _latest_plan_path(ctx: ToolContext) -> Path | None:
    """Return the most recently modified plan markdown, or None."""
    plans_dir = ctx.workspace_root / ".xvie" / "plans"
    if not plans_dir.is_dir():
        return None
    plans = sorted(plans_dir.glob("*.md"), key=lambda p: p.stat().st_mtime)
    return plans[-1] if plans else None


_TASK_ITEM = re.compile(r"- \[ \] \*\*(.+?)\*\*")

# Full open-task line including its description: "- [ ] **Title** — Description"
_OPEN_TASK_LINE = re.compile(r"^- \[ \] \*\*(.+?)\*\*\s*—?\s*(.*)$", re.MULTILINE)

# Parse (files: `a.py`, `b.md`) suffix from a task line
_FILES_TOUCHED_RE = re.compile(r"\(files?:\s*(.+?)\)", re.IGNORECASE)


def _parse_files_touched_from_line(line: str) -> list[str]:
    """Extract files_touched list from a plan task line.

    Parses the ``(files: `a.py`, `b.md`)`` suffix.
    Returns a list of file path strings.
    """
    m = _FILES_TOUCHED_RE.search(line)
    if not m:
        return []
    raw = m.group(1)
    # Split on comma, strip backticks and whitespace
    files = [f.strip().strip('`').strip() for f in raw.split(",")]
    return [f for f in files if f]


def _mark_task_done(args: dict, ctx: ToolContext) -> ToolOutput:
    """Flip a plan checklist item from '- [ ]' to '- [x] ✅'.

    Matches by case-insensitive substring against the task titles in the
    most recent plan file under ``.xvie/plans/``.

    Multi-file verification: if the task's line lists files_touched,
    every listed file must appear in the ``changed_files`` argument
    (the session's record of actually-written files). Partial completion
    is rejected with a message naming the missing file(s).
    """
    title = str(args.get("title", "")).strip()
    if not title:
        return ToolOutput(ok=False, content="Missing required argument: title", error_kind="missing_argument")

    # changed_files: list of file paths that were actually written/edited
    # in this session (passed by the agent loop).
    changed_files: list[str] = args.get("changed_files", []) or []

    plan_path = _latest_plan_path(ctx)
    if plan_path is None:
        return ToolOutput(
            ok=False,
            content="No plan file found in .xvie/plans/ — call write_plan first.",
            error_kind="no_plan",
        )

    try:
        text = plan_path.read_text(encoding="utf-8")
    except OSError as exc:
        return ToolOutput(ok=False, content=str(exc), error_kind="os_error")

    needle = title.lower()
    matches = [m for m in _TASK_ITEM.finditer(text) if needle in m.group(1).lower() or m.group(1).lower() in needle]

    if len(matches) > 1:
        candidates = ", ".join(f"'{m.group(1)}'" for m in matches[:5])
        return ToolOutput(
            ok=False,
            content=f"Title '{title}' matches multiple tasks: {candidates}. Use the exact full title.",
            error_kind="ambiguous_match",
        )
    if len(matches) == 0:
        open_tasks = [m.group(1) for m in _TASK_ITEM.finditer(text)]
        listing = "\n".join(f"  - {t}" for t in open_tasks[:10]) or "  (none — all tasks are done)"
        return ToolOutput(
            ok=False,
            content=f"No open task matching '{title}'. Open tasks:\n{listing}",
            error_kind="no_match",
        )

    m = matches[0]

    # --- Multi-file verification ---
    # Get the full line text to extract files_touched
    line_start = text.rfind("\n", 0, m.start()) + 1
    line_end = text.find("\n", m.start())
    line_end = len(text) if line_end == -1 else line_end
    line = text[line_start:line_end]

    files_touched = _parse_files_touched_from_line(line)
    if files_touched:
        # Normalize changed_files for comparison
        normalized_changed = {f.replace(chr(92), '/').lower() for f in changed_files}
        missing = []
        for f in files_touched:
            norm_f = f.replace(chr(92), '/').lower()
            if norm_f not in normalized_changed:
                missing.append(f)
        if missing:
            missing_list = "\n".join(f"  - {f}" for f in missing)
            return ToolOutput(
                ok=False,
                content=(
                    f"Cannot mark '{m.group(1)}' done — the following files listed in the plan "
                    f"were not changed in this session:\n{missing_list}\n\n"
                    f"All files_touched must be modified before marking a task complete. "
                    f"Files that were changed: {', '.join(changed_files) or '(none)'}"
                ),
                error_kind="incomplete_files",
            )

    new_line = line.replace("- [ ]", "- [x]", 1)
    if "✅" not in new_line:
        new_line += " ✅"
    new_text = text[:line_start] + new_line + text[line_end:]
    try:
        plan_path.write_text(new_text, encoding="utf-8")
    except OSError as exc:
        return ToolOutput(ok=False, content=str(exc), error_kind="os_error")

    remaining = new_text.count("- [ ]")
    done = new_text.count("- [x]")
    lines = [f"Marked '{m.group(1)}' done in {plan_path.name}. Progress: {done} done, {remaining} remaining."]

    # Re-anchor the model: list what's left and name the NEXT TASK explicitly
    # so it returns to the plan after every step instead of drifting off-topic.
    open_matches = list(_OPEN_TASK_LINE.finditer(new_text))
    if open_matches:
        lines.append("Remaining tasks:")
        for om in open_matches[:10]:
            desc = om.group(2).strip()
            lines.append(f"  - {om.group(1).strip()}" + (f" — {desc}" if desc else ""))
        nxt = open_matches[0]
        nxt_desc = nxt.group(2).strip()
        next_line = f"NEXT TASK: {nxt.group(1).strip()}"
        if nxt_desc:
            next_line += f" — {nxt_desc}"
        next_line += ". Implement it now, then call mark_task_done again."
        lines.append(next_line)
    else:
        lines.append("ALL TASKS COMPLETE — finish with a short summary of what was built.")
    return ToolOutput(ok=True, content="\n".join(lines))


def _think(args: dict, ctx: ToolContext) -> ToolOutput:
    """Record the agent's reasoning for the current step.

    The thought is surfaced to the user by the agent loop as a visible
    "Thought:" event (opencode-style).  This tool exists because some
    providers (e.g. NVIDIA NIM) drop text content on tool-call turns —
    putting the reasoning in a tool argument guarantees delivery.
    """
    thought = str(args.get("thought", "")).strip()
    if not thought:
        return ToolOutput(ok=False, content="Missing required argument: thought", error_kind="missing_argument")
    return ToolOutput(ok=True, content="Thought noted. Now proceed with your next action.")


def _ask_question(args: dict, ctx: ToolContext) -> ToolOutput:
    """Validate clarifying questions for the pause-and-wait flow.

    The agent loop intercepts this tool BEFORE execution: it emits a
    ``question_required`` event, blocks on ``question_callback``, then feeds
    the user's answers back as the tool result.  This handler only validates
    shape so malformed calls fail fast with a repair hint.
    """
    questions = args.get("questions", [])
    if isinstance(questions, dict):
        questions = [questions]
    if not isinstance(questions, list) or not questions:
        return ToolOutput(
            ok=False,
            content=(
                "Missing required argument: questions (non-empty list). "
                'Example: {"questions": [{"id": "scope", "question": "Which scope?", '
                '"header": "Scope", "options": [{"label": "Whole project"}, '
                '{"label": "Single file"}], "allow_custom": true}]}'
            ),
            error_kind="missing_argument",
        )
    if len(questions) > 4:
        return ToolOutput(
            ok=False,
            content="Ask at most 4 questions per call — keep it focused.",
            error_kind="too_many_questions",
        )
    for i, q in enumerate(questions):
        if not isinstance(q, dict):
            return ToolOutput(ok=False, content=f"Question #{i} must be an object.", error_kind="invalid_argument")
        qid = str(q.get("id", "")).strip()
        text = str(q.get("question", "")).strip()
        if not qid or not text:
            return ToolOutput(
                ok=False,
                content=f"Question #{i} needs both 'id' and 'question'.",
                error_kind="missing_argument",
            )
        options = q.get("options", [])
        if not isinstance(options, list):
            return ToolOutput(ok=False, content=f"Question '{qid}' options must be a list.", error_kind="invalid_argument")
        if len(options) > 5:
            return ToolOutput(ok=False, content=f"Question '{qid}': at most 5 options.", error_kind="too_many_options")
        for opt in options:
            if isinstance(opt, str):
                continue
            if not isinstance(opt, dict) or not str(opt.get("label", "")).strip():
                return ToolOutput(
                    ok=False,
                    content=f"Question '{qid}': each option needs a 'label'.",
                    error_kind="invalid_argument",
                )
    # Reached only when no interactive callback is wired (tests/CLI):
    # surface the questions as text so the model can proceed with a guess.
    lines = ["Questions noted (no interactive UI attached — proceed with your best guess):"]
    for q in questions:
        lines.append(f"- {q.get('question', '')}")
    return ToolOutput(ok=True, content="\n".join(lines), error_kind="awaiting_input")


def _write_plan(args: dict, ctx: ToolContext) -> ToolOutput:
    """Render a structured implementation plan as Markdown and save it."""
    import re as _re
    from datetime import datetime, timezone

    title = args.get("title", "Untitled Plan")
    summary = args.get("summary", "")
    steps = args.get("steps", [])
    risks = args.get("risks", [])
    design_brief = args.get("design_brief", {})
    if not isinstance(design_brief, dict):
        design_brief = {}

    # Handle weak models that stringify the steps array
    if isinstance(steps, str):
        try:
            import json as _json
            steps = _json.loads(steps)
        except (ValueError, TypeError):
            return ToolOutput(
                ok=False,
                content=(
                    'The steps argument must be a list of objects, not a string. '
                    'Example: steps=[{"title": "Create index.html", '
                    '"description": "Build the landing page", '
                    '"files_touched": ["index.html"]}]'
                ),
                error_kind="invalid_argument",
            )
    if isinstance(steps, dict):
        steps = [steps]

    if not steps:
        return ToolOutput(ok=False, content="No steps provided", error_kind="missing_argument")

    # Build Markdown from structured input
    lines: list[str] = []
    lines.append(f"# {title}")
    lines.append("")
    if summary:
        lines.append(summary)
        lines.append("")

    lines.append("## Steps")
    lines.append("")
    for i, step in enumerate(steps, 1):
        step_title = step.get("title", f"Step {i}")
        step_desc = step.get("description", "")
        files = step.get("files_touched", [])
        files_str = "" 
        if files:
            files_str = "  (files: " + ", ".join(f"`{f}`" for f in files) + ")"
        lines.append(f"- [ ] **{step_title}** — {step_desc}{files_str}")
    lines.append("")

    # Optional ## Design section (website tasks): token refs, animation
    # thesis, motion budget, and stack. Rendered after ## Steps so the
    # planning.py step parser (which slices ## Steps to the next ##) is
    # unaffected. Unknown keys are ignored silently.
    if design_brief:
        lines.append("## Design")
        lines.append("")
        for key in ("tokens", "refs", "motion_budget", "thesis", "stack"):
            value = design_brief.get(key, "")
            if value:
                lines.append(f"- {key}: {value}")
        lines.append("")

    if risks:
        lines.append("## Risks & open questions")
        lines.append("")
        for risk in risks:
            lines.append(f"- {risk}")
        lines.append("")

    # Collect all files touched
    all_files: list[str] = []
    for step in steps:
        for f in step.get("files_touched", []):
            if f not in all_files:
                all_files.append(f)
    if all_files:
        lines.append("## Files touched")
        lines.append("")
        for f in all_files:
            lines.append(f"- `{f}`")
        lines.append("")

    md_content = "\n".join(lines)

    # Save to .xvie/plans/<timestamp>-<slug>.md
    slug = _re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:50]
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    plans_dir = ctx.workspace_root / ".xvie" / "plans"
    plans_dir.mkdir(parents=True, exist_ok=True)
    plan_path = plans_dir / f"{ts}-{slug}.md"
    plan_path.write_text(md_content, encoding="utf-8")

    return ToolOutput(ok=True, content=f"Plan saved to {plan_path}\n\n{md_content}")



def _read_ui_reference(args: dict, ctx: ToolContext) -> ToolOutput:
    """Read a UI design reference by name from the agent-kit.

    Consults the routing table for available references and reads the
    requested one. Rejects path traversal attempts.
    """
    name = args.get("name", "")
    if not name:
        return ToolOutput(
            ok=False,
            content="Missing required argument: name",
            error_kind="missing_argument",
        )

    try:
        from xvie_agent.design_router import read_reference, get_reference_names
    except ImportError as exc:
        return ToolOutput(
            ok=False,
            content=f"Design router not available: {exc}",
            error_kind="import_error",
        )

    try:
        ref = read_reference(name)
        content = ref.get("content", "")
        path = ref.get("path", name)
        ref_name = ref.get("name", name)
        if ref_name in ctx.ui_references_read:
            return ToolOutput(
                ok=True,
                content=(
                    f"Reference '{ref_name}' was already read in this run. "
                    "Use the earlier tool result instead of loading it again."
                ),
            )
        ctx.ui_references_read.add(ref_name)
        max_chars = 6_000
        if len(content) > max_chars:
            content = content[:max_chars] + (
                f"\n\n[Reference shortened at {max_chars} characters. "
                "Request a narrower reference if more detail is required.]"
            )
        return ToolOutput(
            ok=True,
            content=f"<!-- {path} -->\n\n{content}",
        )
    except FileNotFoundError:
        available = get_reference_names()
        return ToolOutput(
            ok=False,
            content=(
                f"Reference '{name}' not found. Available references:\n"
                + "\n".join(f"  - {n}" for n in available)
            ),
            error_kind="not_found",
        )
    except ValueError as exc:
        return ToolOutput(
            ok=False,
            content=str(exc),
            error_kind="path_traversal",
        )


# ---------------------------------------------------------------------------
# Web search / fetch tools (brainstorm mode)
# ---------------------------------------------------------------------------

def _web_search(args: dict, ctx: ToolContext) -> ToolOutput:
    """Search the web using a configurable provider.

    Supports multiple backends via environment variables:
      - TAVILY_API_KEY: Uses Tavily Search API (preferred)
      - SERPAPI_API_KEY: Uses SerpAPI
      - BRAVE_API_KEY: Uses Brave Search API

    Falls back to a simple DuckDuckGo HTML scrape if no API key is found.
    """
    import urllib.request
    import urllib.parse
    import json as _json
    import re as _re

    query = args.get("query", "").strip()
    if not query:
        return ToolOutput(ok=False, content="Missing required argument: query", error_kind="missing_argument")

    num_results = min(args.get("num_results", 5), 10)

    # --- Try Tavily ---
    tavily_key = os.environ.get("TAVILY_API_KEY", "")
    if tavily_key:
        try:
            payload = _json.dumps({
                "api_key": tavily_key,
                "query": query,
                "max_results": num_results,
                "search_depth": "basic",
            }).encode("utf-8")
            req = urllib.request.Request(
                "https://api.tavily.com/search",
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = _json.loads(resp.read().decode("utf-8"))
            results = []
            for r in data.get("results", [])[:num_results]:
                results.append(
                    f"- **{r.get('title', '')}**\n"
                    f"  URL: {r.get('url', '')}\n"
                    f"  {r.get('content', '')[:300]}"
                )
            if results:
                return ToolOutput(ok=True, content=f"Search results for '{query}':\n\n" + "\n\n".join(results))
        except Exception:
            pass  # Fall through to next provider

    # --- Try Brave Search ---
    brave_key = os.environ.get("BRAVE_API_KEY", "")
    if brave_key:
        try:
            params = urllib.parse.urlencode({"q": query, "count": num_results})
            req = urllib.request.Request(
                f"https://api.search.brave.com/res/v1/web/search?{params}",
                headers={"Accept": "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": brave_key},
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                import gzip
                raw = resp.read()
                if resp.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                data = _json.loads(raw.decode("utf-8"))
            results = []
            for r in data.get("web", {}).get("results", [])[:num_results]:
                results.append(
                    f"- **{r.get('title', '')}**\n"
                    f"  URL: {r.get('url', '')}\n"
                    f"  {r.get('description', '')[:300]}"
                )
            if results:
                return ToolOutput(ok=True, content=f"Search results for '{query}':\n\n" + "\n\n".join(results))
        except Exception:
            pass

    # --- Fallback: DuckDuckGo HTML lite ---
    try:
        params = urllib.parse.urlencode({"q": query, "t": "h_", "ia": "web"})
        req = urllib.request.Request(
            f"https://html.duckduckgo.com/html/?{params}",
            headers={"User-Agent": "Mozilla/5.0 (xvie-agent)"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read().decode("utf-8", errors="replace")
        # Extract result blocks
        titles = _re.findall(r'class="result__a"[^>]*>(.*?)</a>', html, re.DOTALL)
        snippets = _re.findall(r'class="result__snippet">(.*?)</(?:a|td|div)', html, re.DOTALL)
        urls = _re.findall(r'class="result__url"[^>]*>\s*(.*?)\s*</a>', html, re.DOTALL)
        results = []
        for i in range(min(len(titles), num_results)):
            title = _re.sub(r'<[^>]+>', '', titles[i]).strip()
            snippet = _re.sub(r'<[^>]+>', '', snippets[i]).strip() if i < len(snippets) else ""
            url = _re.sub(r'<[^>]+>', '', urls[i]).strip() if i < len(urls) else ""
            results.append(f"- **{title}**\n  URL: {url}\n  {snippet[:300]}")
        if results:
            return ToolOutput(ok=True, content=f"Search results for '{query}':\n\n" + "\n\n".join(results))
        return ToolOutput(ok=True, content=f"No results found for '{query}'.")
    except Exception as exc:
        return ToolOutput(
            ok=False,
            content=f"Web search failed: {exc}\nSet TAVILY_API_KEY, BRAVE_API_KEY, or SERPAPI_API_KEY for better results.",
            error_kind="search_failed",
        )


def _web_fetch(args: dict, ctx: ToolContext) -> ToolOutput:
    """Fetch and return the text content of a URL.

    Useful for reading documentation, blog posts, or API references
    during brainstorming and research.
    """
    import urllib.request
    import urllib.parse
    import re as _re

    url = args.get("url", "").strip()
    if not url:
        return ToolOutput(ok=False, content="Missing required argument: url", error_kind="missing_argument")
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    max_chars = min(args.get("max_chars", 8000), 20000)

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (xvie-agent)"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            content_type = resp.headers.get("Content-Type", "")
            raw = resp.read()

            if "json" in content_type:
                text = raw.decode("utf-8", errors="replace")
            elif "html" in content_type or "xhtml" in content_type:
                html = raw.decode("utf-8", errors="replace")
                # Strip tags to get readable text
                text = _re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
                text = _re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL | re.IGNORECASE)
                text = _re.sub(r'<[^>]+>', ' ', text)
                text = _re.sub(r'\s+', ' ', text).strip()
            else:
                text = raw.decode("utf-8", errors="replace")

            if len(text) > max_chars:
                text = text[:max_chars] + f"\n\n... [truncated at {max_chars} chars]"

            return ToolOutput(ok=True, content=f"--- {url} ---\n\n{text}")
    except Exception as exc:
        return ToolOutput(ok=False, content=f"Failed to fetch {url}: {exc}", error_kind="fetch_failed")


# ---------------------------------------------------------------------------
# Zetaris live-data tools (read-only analytics gateway)
# ---------------------------------------------------------------------------

def _zetaris_query(args: dict, ctx: ToolContext) -> ToolOutput:
    """Run one read-only SQL statement against the live Zetaris data fabric."""
    from xvie_agent import zetaris

    client = zetaris.default_client()
    if client is None:
        return ToolOutput(
            ok=False,
            content=(
                "Zetaris is not configured. Ask the user to set ZETARIS_BASE_URL, "
                "ZETARIS_USERNAME and ZETARIS_PASSWORD in Backend/xvie-agent/.env."
            ),
            error_kind="not_configured",
        )

    sql = str(args.get("sql") or "").strip()
    if not sql:
        return ToolOutput(ok=False, content="Missing required argument: sql", error_kind="missing_argument")
    limit_raw = args.get("limit")
    try:
        limit = int(limit_raw) if limit_raw is not None else None
    except (TypeError, ValueError):
        limit = None

    try:
        result = client.run_query(sql, limit=limit)
        return ToolOutput(ok=True, content=result.format(max_rows=30, max_chars=ctx.max_output_chars))
    except zetaris.ZetarisError as exc:
        return ToolOutput(ok=False, content=f"Zetaris query failed: {exc}", error_kind="zetaris_error")
    except ValueError as exc:
        return ToolOutput(ok=False, content=str(exc), error_kind="read_only_guard")


def _zetaris_catalog(args: dict, ctx: ToolContext) -> ToolOutput:
    """Discover the Zetaris catalog: data sources, tables, and column schemas."""
    from xvie_agent import zetaris

    client = zetaris.default_client()
    if client is None:
        return ToolOutput(
            ok=False,
            content=(
                "Zetaris is not configured. Ask the user to set ZETARIS_BASE_URL, "
                "ZETARIS_USERNAME and ZETARIS_PASSWORD in Backend/xvie-agent/.env."
            ),
            error_kind="not_configured",
        )

    kind = str(args.get("kind") or "datasources").strip().lower()
    catalog = str(args.get("catalog") or "").strip()
    table = str(args.get("table") or "").strip()

    try:
        if kind == "datasources":
            sources = client.list_datasources()
            if not sources:
                return ToolOutput(ok=True, content="No data sources registered in Zetaris.")
            lines = [f".. catalog table: {s.get('name', '?')}  ({s.get('connectionType', '?')}, "
                     f"{s.get('tableCount', 0)} tables)" for s in sources]
            catalog_names = sorted({str(s.get("name", "")).upper() for s in sources if s.get("name")})
            lines.append(
                "\nUse zetaris_catalog with kind='tables' and catalog=<NAME> to list "
                "tables, then kind='columns' for their schemas."
            )
            return ToolOutput(ok=True, content="\n".join(lines) + f"\nCatalog names: {', '.join(catalog_names)}")

        if kind == "tables":
            if not catalog:
                return ToolOutput(
                    ok=False,
                    content="Missing required argument: catalog (run kind='datasources' first)",
                    error_kind="missing_argument",
                )
            tables = client.list_tables(catalog)
            if not tables:
                return ToolOutput(ok=True, content=f"No tables found in catalog {catalog}.")
            return ToolOutput(
                ok=True,
                content=f"Tables in {catalog.upper()}:\n" + "\n".join(
                    f"- {t['table']}" for t in tables
                )
                + "\nUse zetaris_catalog with kind='columns' to get a table's schema.",
            )

        if kind == "columns":
            if not (catalog and table):
                return ToolOutput(
                    ok=False,
                    content="Missing required arguments: catalog and table",
                    error_kind="missing_argument",
                )
            result = client.describe_table(catalog, table)
            return ToolOutput(ok=True, content=f"Schema of {catalog}.{table}:\n" + result.format(max_rows=60, max_chars=ctx.max_output_chars))

        return ToolOutput(
            ok=False,
            content="Invalid kind: must be one of 'datasources', 'tables', 'columns'.",
            error_kind="missing_argument",
        )
    except zetaris.ZetarisError as exc:
        return ToolOutput(ok=False, content=f"Zetaris catalog lookup failed: {exc}", error_kind="zetaris_error")
    except ValueError as exc:
        return ToolOutput(ok=False, content=str(exc), error_kind="read_only_guard")


# ---------------------------------------------------------------------------
# Registry builder
# ---------------------------------------------------------------------------

def build_default_registry(ctx: ToolContext, *, allow_web: bool = False) -> dict[str, Tool]:
    """Build the default tool registry for the given context.

    Args:
        ctx: Shared tool context with workspace and permission settings.
        allow_web: If ``True``, include web_search and web_fetch tools.

    Returns a dict mapping tool names to :class:`Tool` instances.
    """

    _TOOLS: list[Tool] = [
        Tool(
            name="list_dir",
            description="List files and directories at the given path. Directories are prefixed with 'd '.",
            json_schema={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative path to list. Defaults to workspace root.",
                    }
                },
                "required": [],
            },
            handler=_list_dir,
        ),
        Tool(
            name="read_file",
            description="Read a file's contents (optionally a line range).",
            json_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative path to the file."},
                    "start_line": {"type": "integer", "description": "1-indexed start line (inclusive)."},
                    "end_line": {"type": "integer", "description": "1-indexed end line (inclusive)."},
                },
                "required": ["path"],
            },
            handler=_read_file,
        ),
        Tool(
            name="write_file",
            description="Create or overwrite a file with the given content. Parent directories are created automatically.",
            json_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative path to write."},
                    "content": {"type": "string", "description": "Full file content to write."},
                },
                "required": ["path", "content"],
            },
            handler=_write_file,
        ),
        Tool(
            name="append_file",
            description="Append content to a file; build large files in chunks after write_file.",
            json_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative path of the existing file."},
                    "content": {"type": "string", "description": "Content to append to the end of the file."},
                },
                "required": ["path", "content"],
            },
            handler=_append_file,
        ),
        Tool(
            name="file_size",
            description="Return a file's char/line count to track large-file progress.",
            json_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative path to the file."},
                },
                "required": ["path"],
            },
            handler=_file_size,
        ),
        Tool(
            name="verify_file",
            description=(
                "Validate a written file (Python/JSON/CSS/HTML). "
                "Call after writing; repair failures."
            ),
            json_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative path of the file to verify."},
                    "rich_html": {"type": "boolean", "description": "Force strict website quality checks for HTML."},
                },
                "required": ["path"],
            },
            handler=_verify_file,
        ),
        Tool(
            name="edit_file",
            description=(
                "Replace an exact string in a file. old_str must match exactly once — "
                "copy it from read_file output."
            ),
            json_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative path to the file."},
                    "old_str": {"type": "string", "description": "Exact string to find (must match once)."},
                    "new_str": {"type": "string", "description": "Replacement string."},
                },
                "required": ["path", "old_str", "new_str"],
            },
            handler=_edit_file,
        ),
        Tool(
            name="glob_search",
            description="Find files matching a glob pattern (e.g. '*.py', 'test_*'). Recursive.",
            json_schema={
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Glob pattern to match against file names."},
                },
                "required": ["pattern"],
            },
            handler=_glob_search,
        ),
        Tool(
            name="grep_search",
            description="Search file contents for a regex pattern. Returns file:line: content for each match.",
            json_schema={
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Regex pattern to search for."},
                    "path": {"type": "string", "description": "Relative directory or file to search in (default: root)."},
                },
                "required": ["pattern"],
            },
            handler=_grep_search,
        ),
        Tool(
            name="bash",
            description="Execute a shell command. Use for compilation, tests, git, etc. Enforces a timeout.",
            json_schema={
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Shell command to execute."},
                },
                "required": ["command"],
            },
            handler=_bash,
        ),
        Tool(
            name="think",
            description=(
                "One-sentence reasoning for your next action, shown to the user. "
                "Call before every action tool call."
            ),
            json_schema={
                "type": "object",
                "properties": {
                    "thought": {
                        "type": "string",
                        "description": "What you will do next and why.",
                    }
                },
                "required": ["thought"],
            },
            handler=_think,
        ),
        Tool(
            name="ask_question",
            description="Ask user questions (pauses until answered). Max 4 questions, 5 options each.",
            json_schema={
                "type": "object",
                "properties": {
                    "questions": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string"},
                                "question": {"type": "string"},
                                "header": {"type": "string"},
                                "options": {
                                    "type": "array",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "label": {"type": "string"},
                                            "description": {"type": "string"},
                                        },
                                        "required": ["label"],
                                    },
                                },
                                "allow_custom": {"type": "boolean"},
                            },
                            "required": ["id", "question"],
                        },
                    }
                },
                "required": ["questions"],
            },
            handler=_ask_question,
        ),
        Tool(
            name="mark_task_done",
            description="Mark a finished plan task; all listed files must have changed.",
            json_schema={
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Task title from the plan.",
                    },
                    "changed_files": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Files changed for this task.",
                    },
                },
                "required": ["title"],
            },
            handler=_mark_task_done,
        ),
        Tool(
            name="write_plan",
            description="Write a structured implementation plan as Markdown. Call once after investigating the codebase.",
            json_schema={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Plan title."},
                    "summary": {"type": "string", "description": "One-paragraph summary."},
                    "steps": {
                        "type": "array",
                        "description": "Ordered steps.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": {"type": "string"},
                                "description": {"type": "string"},
                                "files_touched": {
                                    "type": "array",
                                    "items": {"type": "string"},
                                },
                            },
                            "required": ["title", "description"],
                        },
                    },
                    "risks": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Risks and open questions.",
                    },
                    "design_brief": {
                        "type": "object",
                        "description": (
                            "Optional design brief for website tasks: token refs, "
                            "animation thesis, motion budget, stack."
                        ),
                        "properties": {
                            "tokens": {"type": "string"},
                            "refs": {"type": "string"},
                            "motion_budget": {"type": "string"},
                            "thesis": {"type": "string"},
                            "stack": {"type": "string"},
                        },
                    },
                },
                "required": ["title", "summary", "steps"],
            },
            handler=_write_plan,
        ),
        Tool(
            name="check_contrast",
            description="Check WCAG contrast ratio between foreground and background hex colors.",
            json_schema={
                "type": "object",
                "properties": {
                    "fg_hex": {"type": "string", "description": "Foreground color as hex (e.g. '#1a1a1a')."},
                    "bg_hex": {"type": "string", "description": "Background color as hex (e.g. '#ffffff')."},
                },
                "required": ["fg_hex", "bg_hex"],
            },
            handler=_check_contrast,
        ),
        Tool(
            name="preview_artifact",
            description="Locate an HTML/CSS/JS file for rendering by a host app. Returns the file path.",
            json_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative path to the web artifact."},
                },
                "required": ["path"],
            },
            handler=_preview_artifact,
        ),
        Tool(
            name="review_ui_render",
            description="Render an HTML page at desktop and mobile sizes, save full-page screenshots, and report browser errors and horizontal overflow. Requires the optional Playwright visual extra.",
            json_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative path to the HTML page."},
                },
                "required": ["path"],
            },
            handler=_review_ui_render,
        ),
        Tool(
            name="move_file",
            description="Move or rename a file within the workspace.",
            json_schema={
                "type": "object",
                "properties": {
                    "src": {"type": "string", "description": "Current file path."},
                    "dst": {"type": "string", "description": "New file path."},
                },
                "required": ["src", "dst"],
            },
            handler=_move_file,
        ),
        Tool(
            name="delete_file",
            description="Delete a file within the workspace.",
            json_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative path to delete."},
                },
                "required": ["path"],
            },
            handler=_delete_file,
        ),
        Tool(
            name="apply_patch",
            description="Atomically apply exact replacements across files; batch palette swaps instead of rewriting files.",
            json_schema={
                "type": "object",
                "properties": {
                    "files": {
                        "type": "array",
                        "description": "Edits to apply.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "path": {"type": "string"},
                                "old_str": {"type": "string", "description": "Exact string to replace once."},
                                "new_str": {"type": "string", "description": "Replacement."},
                            },
                            "required": ["path", "old_str", "new_str"],
                        },
                    }
                },
                "required": ["files"],
            },
            handler=_apply_patch,
        ),
        Tool(
            name="diff_preview",
            description="Show a unified diff between a file and new content WITHOUT writing. Read-only.",
            json_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative path to the file."},
                    "new_content": {"type": "string", "description": "Proposed new content."},
                },
                "required": ["path", "new_content"],
            },
            handler=_diff_preview,
        ),
        Tool(
            name="run_code",
            description="Execute a code snippet in Python, JavaScript, or Bash. Writes to a temp file and runs it.",
            json_schema={
                "type": "object",
                "properties": {
                    "language": {"type": "string", "enum": ["python", "javascript", "bash"], "description": "Language to execute."},
                    "code": {"type": "string", "description": "The code to run."},
                },
                "required": ["language", "code"],
            },
            handler=_run_code,
        ),
        Tool(
            name="search_images",
            description="Find usable Pexels or Wikimedia Commons photos with direct URLs and attribution; avoid placeholders.",
            json_schema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query in English (e.g., 'tacos mexican food', 'restaurant interior', 'fresh salad')",
                    },
                    "per_page": {
                        "type": "integer",
                        "description": "Number of results (1-15, default 6)",
                    },
                },
                "required": ["query"],
            },
            handler=_search_images,
        ),
        Tool(
            name="read_ui_reference",
            description=(
                "Read one additional UI design reference by name when its specific detail "
                "is needed and it was not pre-loaded. Reference names are listed in the "
                "parameter description. Each reference is limited to 6000 characters "
                "and can be read only once per run."
            ),
            json_schema={
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": (
                            "Reference name: craft-intent, tokens, inspiration, accessibility, "
                            "color, layout, recipe-dashboard, recipe-landing, recipe-auth, "
                            "themes, dashboard, forms, components, ai-chat, review, finish-bar, "
                            "loops, principles-catalog, coverage, spec, typography, motion, "
                            "modern-css, responsive, metadata, copy, sound, stack, heuristics, "
                            "personas, state-design, dataviz"
                        ),
                    },
                },
                "required": ["name"],
            },
            handler=_read_ui_reference,
        ),
    ]

    # --- Web tools (only in brainstorm mode) ---
    if allow_web:
        _TOOLS.append(
            Tool(
                name="web_search",
                description=(
                    "Search the web for information, best practices, prior art, "
                    "trends, and community opinions. Use for research during "
                    "brainstorming and critical analysis."
                ),
                json_schema={
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Search query in English.",
                        },
                        "num_results": {
                            "type": "integer",
                            "description": "Number of results to return (default 5, max 10).",
                        },
                    },
                    "required": ["query"],
                },
                handler=_web_search,
            ),
        )
        _TOOLS.append(
            Tool(
                name="web_fetch",
                description=(
                    "Fetch and read the text content of a URL. Useful for "
                    "reading documentation, articles, or API references."
                ),
                json_schema={
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "URL to fetch (https://...).",
                        },
                        "max_chars": {
                            "type": "integer",
                            "description": "Max characters to return (default 8000).",
                        },
                    },
                    "required": ["url"],
                },
                handler=_web_fetch,
            ),
        )

    # --- Zetaris live-data tools (only when configured) ---
    from xvie_agent import zetaris as _zetaris

    if _zetaris.default_client() is not None:
        _TOOLS.append(
            Tool(
                name="zetaris_query",
                description=(
                    "Run one read-only SQL statement (SELECT / SHOW / DESCRIBE / EXPLAIN / WITH) "
                    "against the Zetaris live data fabric and get rows back. Use for real "
                    "enterprise data: counts, aggregates, samples. Writes are blocked."
                ),
                json_schema={
                    "type": "object",
                    "properties": {
                        "sql": {
                            "type": "string",
                            "description": "Read-only SQL statement, e.g. SELECT * FROM catalog.table LIMIT 10.",
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Max rows to fetch for this query (default from ZETARIS_QUERY_LIMIT).",
                        },
                    },
                    "required": ["sql"],
                },
                handler=_zetaris_query,
            ),
        )
        _TOOLS.append(
            Tool(
                name="zetaris_catalog",
                description=(
                    "Discover Zetaris data without writing SQL: kind='datasources' lists "
                    "registered sources and their catalog names, kind='tables' with "
                    "catalog=<NAME> lists its tables, kind='columns' with catalog and table "
                    "returns the schema. Call this before writing queries."
                ),
                json_schema={
                    "type": "object",
                    "properties": {
                        "kind": {
                            "type": "string",
                            "enum": ["datasources", "tables", "columns"],
                            "description": "What to look up (default: datasources).",
                        },
                        "catalog": {
                            "type": "string",
                            "description": "Catalog/data-source name, required for 'tables' and 'columns'.",
                        },
                        "table": {
                            "type": "string",
                            "description": "Table name, required for 'columns'.",
                        },
                    },
                    "required": ["kind"],
                },
                handler=_zetaris_catalog,
            ),
        )

    return {t.name: t for t in _TOOLS}
