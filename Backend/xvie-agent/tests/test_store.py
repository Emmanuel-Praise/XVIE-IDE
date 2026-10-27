"""Tests for xvie_agent.store — session save/load/list."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from xvie_agent.session import SessionState
from xvie_agent.store import archive_session, list_sessions, load_session, save_session
from xvie_agent.types import ToolCall, UsageStats


# ---------------------------------------------------------------------------
# save + load round-trip
# ---------------------------------------------------------------------------

class TestSaveLoadRoundTrip:
    def test_explicit_context_compaction_archives_and_keeps_recent_turns(self, tmp_path: Path) -> None:
        session = SessionState(system_prompt="System")
        for turn in range(6):
            session.append_user(f"Request {turn}")
            session.append_assistant(f"Progress {turn}")
        archive_session(session, tmp_path)
        assert session.compact_for_resume(keep_last_n_turns=4)
        save_session(session, tmp_path)

        active = load_session(session.session_id, tmp_path)
        archives = list((tmp_path / "archives" / session.session_id).glob("*.json"))
        assert len(archives) == 1
        archived = json.loads(archives[0].read_text(encoding="utf-8"))
        assert len(archived["messages"]) == 12
        assert len(active.messages) == 8
        assert "Request 0" in active.context_summary
        assert active.messages[0].content == "Request 2"

    def test_empty_session(self, tmp_path: Path) -> None:
        s = SessionState(system_prompt="Hi")
        save_session(s, tmp_path)
        loaded = load_session(s.session_id, tmp_path)
        assert loaded.session_id == s.session_id
        assert loaded.system_prompt == "Hi"
        assert loaded.messages == []

    def test_full_session_with_tools(self, tmp_path: Path) -> None:
        s = SessionState(system_prompt="System")
        s.append_user("Read file")
        tc = ToolCall(id="c1", name="read_file", arguments={"path": "x.py"})
        s.append_assistant("", tool_calls=[tc], usage=UsageStats(input_tokens=50, output_tokens=10))
        s.append_tool_result(tool_call_id="c1", content="file contents here")
        s.append_assistant("The file says: file contents here", usage=UsageStats(input_tokens=60, output_tokens=15))

        save_session(s, tmp_path)
        loaded = load_session(s.session_id, tmp_path)

        assert loaded.session_id == s.session_id
        assert loaded.system_prompt == s.system_prompt
        assert len(loaded.messages) == 4
        assert loaded.messages[0].role == "user"
        assert loaded.messages[1].tool_calls[0].id == "c1"
        assert loaded.messages[1].tool_calls[0].arguments == {"path": "x.py"}
        assert loaded.messages[2].role == "tool"
        assert loaded.messages[2].content == "file contents here"
        assert loaded.messages[3].usage.input_tokens == 60

    def test_file_created(self, tmp_path: Path) -> None:
        s = SessionState()
        path = save_session(s, tmp_path)
        assert path.exists()
        assert path.name == f"{s.session_id}.json"

    def test_load_nonexistent_raises(self, tmp_path: Path) -> None:
        with pytest.raises(FileNotFoundError):
            load_session("nonexistent-id", tmp_path)

    def test_large_session_is_archived_and_compacted_for_resume(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("XVIE_SESSION_COMPACT_CHARS", "2000")
        session = SessionState(system_prompt="System")
        for turn in range(7):
            session.append_user(f"Request {turn}")
            session.append_assistant(f"Progress {turn}")
            session.append_tool_result(f"call-{turn}", f"tool output {turn} " + "x" * 700)

        save_session(session, tmp_path)
        active = load_session(session.session_id, tmp_path)
        archives = list((tmp_path / "archives" / session.session_id).glob("*.json"))

        assert len(archives) == 1
        archived = json.loads(archives[0].read_text(encoding="utf-8"))
        assert len(archived["messages"]) == 21
        assert len(active.messages) < len(archived["messages"])
        assert "Request 0" in active.context_summary
        assert "previous-session-summary" in str(active.to_openai_messages())


# ---------------------------------------------------------------------------
# list_sessions
# ---------------------------------------------------------------------------

class TestListSessions:
    def test_empty_dir(self, tmp_path: Path) -> None:
        assert list_sessions(tmp_path) == []

    def test_nonexistent_dir(self, tmp_path: Path) -> None:
        assert list_sessions(tmp_path / "nope") == []

    def test_lists_sessions(self, tmp_path: Path) -> None:
        s1 = SessionState(system_prompt="First")
        s1.append_user("Hello from session 1")
        save_session(s1, tmp_path)

        s2 = SessionState(system_prompt="Second")
        s2.append_user("Hello from session 2")
        save_session(s2, tmp_path)

        sessions = list_sessions(tmp_path)
        assert len(sessions) == 2
        ids = {s["session_id"] for s in sessions}
        assert s1.session_id in ids
        assert s2.session_id in ids

    def test_session_info_fields(self, tmp_path: Path) -> None:
        s = SessionState(system_prompt="Test")
        s.append_user("What is the meaning of life?")
        save_session(s, tmp_path)

        sessions = list_sessions(tmp_path)
        assert len(sessions) == 1
        info = sessions[0]
        assert info["session_id"] == s.session_id
        assert info["created_at"] != ""
        assert info["message_count"] == 1
        assert "meaning of life" in info["last_user_message"]

    def test_sorted_by_mtime_desc(self, tmp_path: Path) -> None:
        import time

        s1 = SessionState()
        s1.append_user("First")
        save_session(s1, tmp_path)
        # Ensure different mtime on Windows (1-second resolution)
        time.sleep(1.1)
        s2 = SessionState()
        s2.append_user("Second")
        save_session(s2, tmp_path)

        sessions = list_sessions(tmp_path)
        assert sessions[0]["session_id"] == s2.session_id  # Most recent first

    def test_corrupted_file_skipped(self, tmp_path: Path) -> None:
        # Write a valid session
        s = SessionState()
        s.append_user("OK")
        save_session(s, tmp_path)

        # Corrupt another file
        (tmp_path / "bad.json").write_text("not valid json {{{")

        sessions = list_sessions(tmp_path)
        assert len(sessions) == 1  # bad file skipped
