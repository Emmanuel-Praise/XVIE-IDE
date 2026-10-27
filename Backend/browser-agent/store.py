"""Tiny sqlite chat history for the browser agent.

Ported from ``mcp-web-llm/memory.py``: same table shape (``messages`` with
``model_name / role / content / timestamp``) so history stays compatible.
"""

from __future__ import annotations

import logging
import os
import sqlite3
import uuid
from pathlib import Path

logger = logging.getLogger(__name__)


def get_db_path() -> str:
    env_dir = os.getenv("MCP_WEB_LLM_DATA_DIR")
    if env_dir:
        data_dir = Path(env_dir)
        data_dir.mkdir(parents=True, exist_ok=True)
        return str(data_dir / "history.db")
    try:
        data_dir = Path.home() / ".xvie-browser-agent"
        data_dir.mkdir(parents=True, exist_ok=True)
        probe = data_dir / ".write_test"
        probe.touch()
        probe.unlink()
        return str(data_dir / "history.db")
    except Exception as exc:
        logger.warning("Cannot write to home dir, falling back to cwd: %s", exc)
        return str(Path(".") / "history.db")


def init_db() -> None:
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
        if cursor.fetchone() is None:
            cursor.execute(
                """
                CREATE TABLE messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    model_name TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
        cursor.execute("PRAGMA table_info(messages)")
        columns = {info[1] for info in cursor.fetchall()}
        if "conversation_id" not in columns:
            cursor.execute("ALTER TABLE messages ADD COLUMN conversation_id TEXT")
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                model_name TEXT NOT NULL,
                title TEXT NOT NULL,
                remote_url TEXT NOT NULL DEFAULT '',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        # Preserve older per-model transcripts as one legacy conversation.
        cursor.execute("SELECT DISTINCT model_name FROM messages WHERE conversation_id IS NULL")
        for (model_name,) in cursor.fetchall():
            conversation_id = f"legacy-{model_name}"
            cursor.execute(
                "SELECT content FROM messages WHERE model_name = ? AND role = 'user' ORDER BY id LIMIT 1",
                (model_name,),
            )
            first = cursor.fetchone()
            title = ((first[0] if first else "Previous conversation") or "Previous conversation")[:80]
            cursor.execute(
                "INSERT OR IGNORE INTO conversations (id, model_name, title) VALUES (?, ?, ?)",
                (conversation_id, model_name, title),
            )
            cursor.execute(
                "UPDATE messages SET conversation_id = ? WHERE model_name = ? AND conversation_id IS NULL",
                (conversation_id, model_name),
            )
        conn.commit()
    finally:
        conn.close()


def create_conversation(model_name: str, title: str = "New conversation") -> dict:
    conversation_id = uuid.uuid4().hex
    conn = sqlite3.connect(get_db_path())
    try:
        conn.execute(
            "INSERT INTO conversations (id, model_name, title) VALUES (?, ?, ?)",
            (conversation_id, model_name, title[:80]),
        )
        conn.commit()
    finally:
        conn.close()
    return {"id": conversation_id, "site": model_name, "title": title[:80], "remote_url": ""}


def conversation(model_name: str, conversation_id: str) -> dict | None:
    conn = sqlite3.connect(get_db_path())
    try:
        row = conn.execute(
            "SELECT id, model_name, title, remote_url, created_at, updated_at FROM conversations WHERE model_name = ? AND id = ?",
            (model_name, conversation_id),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    return {"id": row[0], "site": row[1], "title": row[2], "remote_url": row[3], "created_at": row[4], "updated_at": row[5]}


def update_remote_url(model_name: str, conversation_id: str, remote_url: str) -> None:
    conn = sqlite3.connect(get_db_path())
    try:
        conn.execute(
            "UPDATE conversations SET remote_url = ?, updated_at = CURRENT_TIMESTAMP WHERE model_name = ? AND id = ?",
            (remote_url, model_name, conversation_id),
        )
        conn.commit()
    finally:
        conn.close()


def list_conversations(model_name: str, limit: int = 100) -> list[dict]:
    conn = sqlite3.connect(get_db_path())
    try:
        rows = conn.execute(
            "SELECT c.id, c.title, c.remote_url, c.created_at, c.updated_at, "
            "(SELECT content FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user' ORDER BY m.id LIMIT 1), "
            "(SELECT MAX(m.id) FROM messages m WHERE m.conversation_id = c.id) "
            "FROM conversations c WHERE c.model_name = ? ORDER BY c.updated_at DESC, 6 DESC, c.rowid DESC LIMIT ?",
            (model_name, max(1, min(limit, 250))),
        ).fetchall()
    finally:
        conn.close()
    return [{"id": r[0], "site": model_name, "title": r[5] or r[1], "remote_url": r[2], "created_at": r[3], "updated_at": r[4]} for r in rows]


def delete_conversation(model_name: str, conversation_id: str) -> bool:
    """Delete one local conversation and its messages for a provider."""
    conn = sqlite3.connect(get_db_path())
    try:
        conn.execute("BEGIN IMMEDIATE")
        exists = conn.execute(
            "SELECT 1 FROM conversations WHERE model_name = ? AND id = ?",
            (model_name, conversation_id),
        ).fetchone()
        if not exists:
            conn.rollback()
            return False
        conn.execute("DELETE FROM messages WHERE model_name = ? AND conversation_id = ?", (model_name, conversation_id))
        conn.execute("DELETE FROM conversations WHERE model_name = ? AND id = ?", (model_name, conversation_id))
        conn.commit()
        return True
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def save_message(model_name: str, role: str, content: str, conversation_id: str | None = None) -> None:
    try:
        conn = sqlite3.connect(get_db_path())
        try:
            cursor = conn.cursor()
            columns = {info[1] for info in cursor.execute("PRAGMA table_info(messages)").fetchall()}
            if not conversation_id:
                # Never guess the latest conversation: that merges unrelated
                # chats and looks like "forgetting". Caller must pass an
                # explicit id; if missing, start a fresh thread.
                conversation_id = create_conversation(model_name)["id"]
            if "session_id" in columns:
                cursor.execute(
                    "INSERT INTO messages (session_id, model_name, role, content, conversation_id) VALUES (?, ?, ?, ?, ?)",
                    ("default", model_name, role, content, conversation_id),
                )
            else:
                cursor.execute(
                    "INSERT INTO messages (model_name, role, content, conversation_id) VALUES (?, ?, ?, ?)",
                    (model_name, role, content, conversation_id),
                )
            cursor.execute(
                "UPDATE conversations SET updated_at = CURRENT_TIMESTAMP, title = CASE WHEN title = 'New conversation' AND ? = 'user' THEN ? ELSE title END WHERE id = ?",
                (role, content[:80], conversation_id),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:
        logger.error("Failed to save browser-agent message: %s", exc)


def recent_messages(model_name: str, limit: int = 50, conversation_id: str | None = None) -> list[dict]:
    try:
        conn = sqlite3.connect(get_db_path())
        try:
            cursor = conn.cursor()
            if conversation_id:
                cursor.execute(
                    "SELECT role, content, timestamp FROM messages WHERE model_name = ? AND conversation_id = ? ORDER BY id DESC LIMIT ?",
                    (model_name, conversation_id, limit),
                )
            else:
                cursor.execute(
                    "SELECT role, content, timestamp FROM messages WHERE model_name = ? ORDER BY id DESC LIMIT ?",
                    (model_name, limit),
                )
            rows = cursor.fetchall()
        finally:
            conn.close()
    except Exception as exc:
        logger.error("Failed to read browser-agent history: %s", exc)
        return []
    return [
        {"role": role, "content": content, "timestamp": ts}
        for role, content, ts in reversed(rows)
    ]


try:
    init_db()
except Exception as exc:  # pragma: no cover - best effort at import time
    logger.error("Failed to initialize browser-agent history db: %s", exc)
