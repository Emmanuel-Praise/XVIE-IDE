"""Session persistence — save and load sessions to/from disk.

Each session is stored as ``<dir>/<session_id>.json``.  The directory is
created automatically if it doesn't exist.
"""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from datetime import datetime, timezone

from xvie_agent.session import SessionState


def save_session(session: SessionState, dir: Path) -> Path:
    """Save a session to disk.

    Args:
        session: The session state to persist.
        dir: Directory to write into (created if missing).

    Returns:
        The path of the written file.
    """
    dir.mkdir(parents=True, exist_ok=True)
    path = dir / f"{session.session_id}.json"
    raw = session.to_json()
    try:
        compact_after_chars = max(1_000, int(os.getenv("XVIE_SESSION_COMPACT_CHARS", "100000")))
    except ValueError:
        compact_after_chars = 100_000
    if len(raw) > compact_after_chars:
        # Preserve an exact snapshot before trimming the active context. Each
        # compaction gets a unique archive file, so earlier checkpoints remain
        # available even when a resumed session grows again.
        if session.compact_for_resume():
            archive_session(session, dir, raw=raw)
            raw = session.to_json()
    _atomic_write(path, raw)
    return path


def archive_session(session: SessionState, dir: Path, *, raw: str | None = None) -> Path:
    """Write an exact, timestamped session snapshot before active compaction."""
    archive_dir = dir / "archives" / session.session_id
    archive_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    archive_path = archive_dir / f"{stamp}.json"
    _atomic_write(archive_path, raw if raw is not None else session.to_json())
    return archive_path


def _atomic_write(path: Path, content: str) -> None:
    """Replace a JSON file atomically so an interrupted save cannot truncate it."""
    temp = path.with_name(path.name + f".{uuid.uuid4().hex}.tmp")
    temp.write_text(content, encoding="utf-8")
    os.replace(temp, path)


def load_session(session_id: str, dir: Path) -> SessionState:
    """Load a session from disk.

    Args:
        session_id: The UUID of the session to load.
        dir: Directory containing session files.

    Returns:
        The deserialized :class:`SessionState`.

    Raises:
        FileNotFoundError: If the session file doesn't exist.
    """
    path = dir / f"{session_id}.json"
    raw = path.read_text(encoding="utf-8")
    return SessionState.from_json(raw)


def list_sessions(dir: Path) -> list[dict]:
    """List all saved sessions in a directory.

    Returns:
        A list of dicts with ``session_id``, ``created_at``,
        ``updated_at``, ``message_count``, and a preview of the last
        user message.
    """
    if not dir.is_dir():
        return []
    results: list[dict] = []
    for path in sorted(dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            raw = path.read_text(encoding="utf-8")
            session = SessionState.from_json(raw)
            last_user = ""
            for msg in reversed(session.messages):
                if msg.role == "user":
                    last_user = msg.content[:120]
                    break
            results.append({
                "session_id": session.session_id,
                "created_at": session.created_at,
                "updated_at": session.updated_at,
                "message_count": len(session.messages),
                "last_user_message": last_user,
                "parent_session_id": session.parent_session_id,
            })
        except (json.JSONDecodeError, KeyError):
            continue
    return results
