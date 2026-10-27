"""Live status line with an animated spinner — the "cooking" indicator.

A tiny daemon thread redraws one line on stdout (``\\r`` + ANSI erase)
while the agent is working, so the user always sees *something* happening
even when no tokens or tool events have arrived yet.

Contract with callers (single-threaded event loop)
--------------------------------------------------
The spinner always occupies the row where the next printed content line
will go (a fresh line at the bottom of all output). The caller keeps that
invariant:

* ``start(text)`` begins animating on the current (fresh) line.
* ``hide()`` stops the thread and erases the line — call this just BEFORE
  printing; the print overwrites the spinner's row wholesale.
* ``show()`` restarts the animation on the current line — call this AFTER
  printing so the spinner sits on the next fresh line again.
* ``update(text)`` changes the label (picked up immediately).
* ``stop()`` erases the line for good (e.g. when streaming begins).

``hide()``/``show()`` are a pair: never call one without the other while
``active``. ``pause()``/``resume()`` are kept as aliases for callers that
don't print in between (e.g. CLI one-shot runs).

All writes go through a lock so the spinner thread and the main thread
never interleave partial writes.
"""

from __future__ import annotations

import sys
import threading
from typing import TextIO

SPINNER_FRAMES = ("⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏")


class StatusLine:
    """A single self-refreshing line on stdout with an animated spinner."""

    def __init__(self, stream: TextIO | None = None, interval: float = 0.1) -> None:
        self._stream = stream or sys.stdout
        self._interval = interval
        self._text = ""
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._active = False
        self._lock = threading.Lock()
        self._started_at: float | None = None

    @property
    def active(self) -> bool:
        return self._active

    def elapsed(self) -> float:
        """Seconds since start() — 0 if never started."""
        import time as _time

        if self._started_at is None:
            return 0.0
        return max(0.0, _time.monotonic() - self._started_at)

    # -- lifecycle ---------------------------------------------------------

    def start(self, text: str = "Working…") -> None:
        """Begin animating the status line with *text* (on the current line)."""
        import time as _time

        with self._lock:
            if self._active:
                self._text = text
                self._draw()
                return
            self._text = text
            self._active = True
            self._started_at = _time.monotonic()
            self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, daemon=True, name="xvie-status"
        )
        self._thread.start()
        self._draw()

    def _run(self) -> None:
        frame = 0
        while not self._stop.wait(self._interval):
            with self._lock:
                if not self._active:
                    break
                text = self._text
            glyph = SPINNER_FRAMES[frame % len(SPINNER_FRAMES)]
            frame += 1
            self._write_raw(f"\r{glyph} {text}\x1b[K")

    # -- callers use these two around any printed output -------------------

    def hide(self) -> None:
        """Stop animating and erase the status line. The spinner always lives
        on the SAME row where the next printed content line will go, so the
        caller simply erases (no cursor movement) and then prints over it."""
        self._stop_anim()
        self._write_raw("\r\x1b[2K")

    def show(self, text: str | None = None) -> None:
        """Restart the animation on the current line (call after printing)."""
        if not self._active:
            if text is not None:
                self.start(text)
            return
        if text is not None:
            with self._lock:
                self._text = text
        self._start_anim()

    # -- convenience aliases -----------------------------------------------

    def pause(self) -> None:
        """Alias for :meth:`hide` (used when the caller will print next)."""
        self.hide()

    def resume(self, text: str | None = None) -> None:
        """Alias for :meth:`show`."""
        self.show(text)

    # -- drawing helpers ----------------------------------------------------

    def update(self, text: str) -> None:
        """Change the status text (visible immediately)."""
        with self._lock:
            self._text = text
        self._draw()

    def _draw(self) -> None:
        if not self._active:
            return
        with self._lock:
            text = self._text
        self._write_raw(f"\r{SPINNER_FRAMES[0]} {text}\x1b[K")

    def _start_anim(self) -> None:
        with self._lock:
            self._stop.clear()
        if self._thread is not None and self._thread.is_alive():
            return
        self._thread = threading.Thread(
            target=self._run, daemon=True, name="xvie-status"
        )
        self._thread.start()
        self._draw()

    def _stop_anim(self) -> None:
        self._stop.set()
        thread = self._thread
        if (
            thread is not None
            and thread.is_alive()
            and thread is not threading.current_thread()
        ):
            thread.join(timeout=0.5)

    def stop(self, clear: bool = True) -> None:
        """Stop animating and (optionally) erase the status line."""
        with self._lock:
            self._active = False
        self._stop_anim()
        if clear:
            self._write_raw("\r\x1b[2K")

    def _write_raw(self, text: str) -> None:
        try:
            self._stream.write(text)
            self._stream.flush()
        except (OSError, ValueError):
            pass


# ---------------------------------------------------------------------------
# Claude-style status labels for agent events
# ---------------------------------------------------------------------------

_EVENT_LABELS: dict[str, str] = {
    "understanding_task": "Understanding your request…",
    "smalltalk": "Answering you…",
    "thinking": "Thinking…",
    "reasoning": "Thinking…",
    "thought": "Thinking…",
    "inspecting": "Inspecting the workspace…",
    "planning": "Planning the work…",
    "selected_model": "Working…",
    "editing": "",
    "edit_failed": "Fixing that…",
    "task_done": "Marking task complete…",
    "file_diff": "Reviewing the changes…",
    "verifying": "",
    "verification_failed": "Repairing files…",
    "retrying": "Retrying…",
    "rate_limit_wait": "",
    "awaiting_confirmation": "Waiting for your input…",
    "context_trimmed": "Trimming older history…",
    "context_compacted": "Compacting older turns…",
    "tool_started": "",
    "tool_finished": "",
    "output_truncated": "Picking up where I left off…",
}

# Kinds that should surface the raw event message verbatim (already human-friendly).
_KIND_USES_MESSAGE = {
    "tool_started",
    "verifying",
    "rate_limit_wait",
    "context_trimmed",
    "context_compacted",
    "smalltalk",
    "output_truncated",
}


def event_status_text(kind: str, message: str) -> str:
    """Map an ``AgentEvent`` to a short Claude-style status label."""
    if kind in _KIND_USES_MESSAGE:
        return message.rstrip("…") + "…" if message and not message.endswith("…") else (message or "Working…")
    label = _EVENT_LABELS.get(kind)
    if label is None:
        return "Working…"
    if kind == "editing" and message:
        return message
    return label or "Working…"


def with_elapsed(base: str, elapsed_s: float, threshold_s: float = 3.0) -> str:
    """Append ``(Ns)`` to a spinner label once the wait gets long.

    Keeps the first seconds clean (``Thinking…``) then switches to
    ``Thinking… (4s)`` so a stalled turn is visibly making progress.
    """
    if elapsed_s < threshold_s or not base:
        return base
    base = base.rstrip()
    if base.endswith(")"):
        return base
    return f"{base} ({elapsed_s:.0f}s)"