"""Workspace context discovery for xvie-agent.

Discovers project memory files (AGENTS.md, CLAUDE.md) and builds a context
snapshot with environment info (cwd, platform, git state).
"""

from __future__ import annotations

import os
import platform
import subprocess
import sys
from pathlib import Path


_MEMORY_FILENAMES = ("AGENTS.md", "CLAUDE.md")


def _max_memory_chars() -> int:
    try:
        return max(2000, int(os.getenv("XVIE_MEMORY_CHARS", "8000")))
    except ValueError:
        return 8_000


def discover_memory_files(cwd: Path) -> str:
    """Walk up from *cwd* looking for project memory files.

    Searches for ``AGENTS.md`` and ``CLAUDE.md`` in *cwd* and every parent
    directory up to the filesystem root.  Also checks ``.xvie/AGENTS.md``
    in each directory.

    Returns:
        Concatenated content of all discovered files, capped at
        ``_MAX_MEMORY_CHARS`` characters.
    """
    collected: list[str] = []
    total = 0
    seen: set[Path] = set()
    _MAX_MEMORY_CHARS = _max_memory_chars()

    # Walk from cwd up to root
    current = cwd.resolve()
    while True:
        for name in _MEMORY_FILENAMES:
            # Direct in directory
            path = current / name
            if path.is_file() and path not in seen:
                seen.add(path)
                try:
                    text = path.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                if total + len(text) > _MAX_MEMORY_CHARS:
                    remaining = _MAX_MEMORY_CHARS - total
                    text = text[:remaining]
                    collected.append(text)
                    total = _MAX_MEMORY_CHARS
                    break
                collected.append(text)
                total += len(text)

            # Inside .xvie/ subdirectory
            forge_path = current / ".xvie" / name
            if forge_path.is_file() and forge_path not in seen:
                seen.add(forge_path)
                try:
                    text = forge_path.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                if total + len(text) > _MAX_MEMORY_CHARS:
                    remaining = _MAX_MEMORY_CHARS - total
                    text = text[:remaining]
                    collected.append(text)
                    total = _MAX_MEMORY_CHARS
                    break
                collected.append(text)
                total += len(text)

        if total >= _MAX_MEMORY_CHARS:
            break

        # Stop at filesystem root
        parent = current.parent
        if parent == current:
            break
        current = parent

    return "\n\n".join(collected)


def build_context_snapshot(cwd: Path) -> dict:
    """Build a snapshot of the workspace environment.

    Returns a dict with keys like ``cwd``, ``platform``, ``python_version``,
    ``git_branch``, ``git_status``.  Missing or unavailable info is omitted.
    """
    snapshot: dict = {"cwd": str(cwd.resolve())}
    snapshot["platform"] = f"{platform.system()} {platform.release()}"
    snapshot["python_version"] = sys.version.split()[0]

    # Node is useful context only for a Node project; avoid a process launch
    # for Python, static, or empty workspaces.
    if (cwd / "package.json").is_file():
        try:
            result = subprocess.run(
                ["node", "--version"],
                capture_output=True, text=True, timeout=1,
            )
            if result.returncode == 0:
                snapshot["node_version"] = result.stdout.strip()
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            pass

    # Git info (if in a repo) — short timeouts + no locks so a busy repo
    # can't stall the spinner for seconds before the first token.
    try:
        result = subprocess.run(
            ["git", "--no-optional-locks", "status", "--short", "--branch"],
            capture_output=True, text=True, timeout=1,
            cwd=str(cwd),
        )
        if result.returncode == 0:
            lines = result.stdout.splitlines()
            if lines and lines[0].startswith("## "):
                branch_status = lines[0][3:]
                snapshot["git_branch"] = branch_status.split("...", 1)[0]
                status_text = "\n".join(lines[1:]).strip()
                snapshot["git_status"] = status_text if status_text else "(clean)"
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        pass

    return snapshot
