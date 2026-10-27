"""Unit tests for xvie_agent.status — spinner + Claude-style status labels."""

import time

from xvie_agent.status import StatusLine, event_status_text


class TestEventStatusText:
    def test_known_event_kind(self) -> None:
        assert event_status_text("thinking", "Thinking through the next step") == "Thinking…"

    def test_inspecting(self) -> None:
        assert event_status_text("inspecting", "Collected workspace inventory") == "Inspecting the workspace…"

    def test_planning(self) -> None:
        assert event_status_text("planning", "Investigating") == "Planning the work…"

    def test_tool_started_uses_message(self) -> None:
        assert event_status_text("tool_started", "Running write_file") == "Running write_file…"

    def test_rate_limit_wait_uses_message(self) -> None:
        assert event_status_text("rate_limit_wait", "Rate limit hit — waiting 3s") == "Rate limit hit — waiting 3s…"

    def test_editing_uses_message(self) -> None:
        assert event_status_text("editing", "✏ index.html (new file)") == "✏ index.html (new file)"

    def test_unknown_kind_defaults(self) -> None:
        assert event_status_text("mystery_event", "whatever") == "Working…"

    def test_empty_message_defaults(self) -> None:
        assert event_status_text("tool_started", "") == "Working…"


class TestStatusLine:
    def test_start_stop_cycle(self) -> None:
        captured: list[str] = []
        class Stream:
            def write(self, s): captured.append(s)
            def flush(self): pass

        s = StatusLine(stream=Stream(), interval=0.01)
        assert not s.active
        s.start("Working…")
        assert s.active
        time.sleep(0.05)
        s.stop()
        assert not s.active
        assert captured  # at least one frame was rendered

    def test_update_changes_text(self) -> None:
        captured: list[str] = []
        class Stream:
            def write(self, s): captured.append(s)
            def flush(self): pass

        s = StatusLine(stream=Stream(), interval=0.01)
        s.start("Working…")
        s.update("Thinking…")
        time.sleep(0.05)
        s.stop()
        assert any("Thinking…" in c for c in captured)

    def test_stop_clears_when_requested(self) -> None:
        captured: list[str] = []
        class Stream:
            def write(self, s): captured.append(s)
            def flush(self): pass

        s = StatusLine(stream=Stream(), interval=0.01)
        s.start("Working…")
        s.stop(clear=True)
        assert captured[-1] == "\r\x1b[2K"

    def test_stop_without_clear_leaves_last_frame(self) -> None:
        captured: list[str] = []
        class Stream:
            def write(self, s): captured.append(s)
            def flush(self): pass

        s = StatusLine(stream=Stream(), interval=0.01)
        s.start("Working…")
        time.sleep(0.03)
        s.stop(clear=False)
        assert captured[-1] != "\r\x1b[2K"

    def test_hide_erases_line_without_cursor_move(self) -> None:
        captured: list[str] = []
        class Stream:
            def write(self, s): captured.append(s)
            def flush(self): pass

        s = StatusLine(stream=Stream(), interval=0.01)
        s.start("Working…")
        s.hide()
        assert captured[-1] == "\r\x1b[2K"
        # The spinner must not leave the thread animating mid-print.
        assert not s._thread.is_alive()
        assert s.active

    def test_hide_then_show_restarts_animation(self) -> None:
        captured: list[str] = []
        class Stream:
            def write(self, s): captured.append(s)
            def flush(self): pass

        s = StatusLine(stream=Stream(), interval=0.01)
        s.start("Working…")
        frames_before = len(captured)
        s.hide()
        s.show("Thinking…")
        time.sleep(0.05)
        s.stop()
        # show() drew an immediate frame with the new label.
        assert any("\x1b[K" in c and "Thinking…" in c for c in captured[frames_before:])

    def test_pause_resume_are_aliases(self) -> None:
        captured: list[str] = []
        class Stream:
            def write(self, s): captured.append(s)
            def flush(self): pass

        s = StatusLine(stream=Stream(), interval=0.01)
        s.start("Working…")
        s.pause()
        assert captured[-1] == "\r\x1b[2K"
        s.resume()
        assert s.active
        time.sleep(0.05)
        s.stop()
        assert captured