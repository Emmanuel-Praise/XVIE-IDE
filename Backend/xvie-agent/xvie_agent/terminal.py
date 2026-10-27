"""Persistent shell sessions for stateful command execution.

Provides :class:`PersistentShell` — a long-lived subprocess that carries
state (``cd``, env vars, installed packages) across tool calls within the
same session, unlike the stateless ``subprocess.run`` in the bash tool.

A background reaper thread cleans up idle shells after a configurable timeout.
"""

from __future__ import annotations

import logging
import platform
import subprocess
import threading
import time
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

# Global registry of active shells, keyed by session_id
_shells: dict[str, PersistentShell] = {}
_lock = threading.Lock()

DEFAULT_IDLE_TIMEOUT = 600  # 10 minutes


@dataclass
class ShellResult:
    """Result of a command executed in a persistent shell."""

    stdout: str
    stderr: str
    exit_code: int
    timed_out: bool = False


class PersistentShell:
    """A long-lived bash subprocess that maintains state across calls.

    State includes the current working directory, exported environment
    variables, and any installed packages (within the same subprocess).

    Parameters:
        session_id: Unique session identifier (used for the global registry).
        idle_timeout: Seconds of inactivity before the shell is killed.
        max_output_chars: Maximum output characters before truncation.
        command_timeout: Timeout per individual command in seconds.
    """

    def __init__(
        self,
        session_id: str,
        idle_timeout: int = DEFAULT_IDLE_TIMEOUT,
        max_output_chars: int = 20000,
        command_timeout: int = 30,
    ) -> None:
        self.session_id = session_id
        self.idle_timeout = idle_timeout
        self.max_output_chars = max_output_chars
        self.command_timeout = command_timeout
        self._last_used = time.monotonic()
        self._process: subprocess.Popen | None = None
        self._lock = threading.Lock()
        self._start()

    def _start(self) -> None:
        """Start the persistent bash subprocess."""
        is_windows = platform.system() == "Windows"
        if is_windows:
            self._process = subprocess.Popen(
                "cmd.exe",
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
            )
        else:
            self._process = subprocess.Popen(
                ["/bin/bash", "-i"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                start_new_session=True,
            )
        logger.info("PersistentShell started for session %s", self.session_id)

    @property
    def alive(self) -> bool:
        """True if the subprocess is still running."""
        if self._process is None:
            return False
        return self._process.poll() is None

    def execute(self, command: str) -> ShellResult:
        """Execute a command in the persistent shell.

        Args:
            command: The shell command to run.

        Returns:
            A :class:`ShellResult` with stdout, stderr, and exit code.
        """
        with self._lock:
            self._last_used = time.monotonic()

            if not self.alive:
                self._start()

            assert self._process is not None
            assert self._process.stdin is not None
            assert self._process.stdout is not None
            assert self._process.stderr is not None

            # Send command with a unique marker to detect completion
            marker = f"__XVIE_EXIT_{int(time.time() * 1000)}__"
            exit_cmd = f"echo {marker} $?\n"

            try:
                self._process.stdin.write(command + "\n" + exit_cmd)
                self._process.stdin.flush()
            except (BrokenPipeError, OSError) as exc:
                return ShellResult(
                    stdout="", stderr=str(exc), exit_code=-1
                )

            # Read output until we see the marker
            output_lines: list[str] = []
            start = time.monotonic()
            exit_code = 0

            while True:
                if time.monotonic() - start > self.command_timeout:
                    return ShellResult(
                        stdout="\n".join(output_lines),
                        stderr=f"Command timed out after {self.command_timeout}s",
                        exit_code=-1,
                        timed_out=True,
                    )

                line = self._process.stdout.readline()
                if not line:
                    break

                stripped = line.rstrip("\n")
                if stripped.startswith(marker):
                    parts = stripped.split()
                    try:
                        exit_code = int(parts[1]) if len(parts) > 1 else 0
                    except (ValueError, IndexError):
                        exit_code = 0
                    break

                output_lines.append(line.rstrip("\r\n"))

            stdout = "\n".join(output_lines)

            # Read any remaining stderr (non-blocking)
            stderr = ""
            try:
                import select
                if hasattr(select, "select"):
                    ready, _, _ = select.select([self._process.stderr], [], [], 0.1)
                    if ready:
                        stderr = self._process.stderr.read(4096)
            except (ImportError, OSError):
                pass

            # Truncate if needed
            if len(stdout) > self.max_output_chars:
                truncated = self.max_output_chars - 100
                stdout = stdout[:truncated] + f"\n\n[Truncated — {len(stdout) - truncated} more chars]"

            return ShellResult(stdout=stdout, stderr=stderr, exit_code=exit_code)

    def close(self) -> None:
        """Terminate the shell subprocess."""
        if self._process and self.alive:
            try:
                self._process.stdin.write(b"exit\n")
                self._process.stdin.flush()
                self._process.terminate()
                self._process.wait(timeout=5)
            except Exception:
                try:
                    self._process.kill()
                except Exception:
                    pass
        self._process = None
        logger.info("PersistentShell closed for session %s", self.session_id)


def get_or_create_shell(
    session_id: str,
    idle_timeout: int = DEFAULT_IDLE_TIMEOUT,
    max_output_chars: int = 20000,
    command_timeout: int = 30,
) -> PersistentShell:
    """Get an existing shell for the session, or create a new one."""
    with _lock:
        shell = _shells.get(session_id)
        if shell and shell.alive:
            return shell
        shell = PersistentShell(
            session_id=session_id,
            idle_timeout=idle_timeout,
            max_output_chars=max_output_chars,
            command_timeout=command_timeout,
        )
        _shells[session_id] = shell
        return shell


def close_shell(session_id: str) -> None:
    """Close and remove the shell for a session."""
    with _lock:
        shell = _shells.pop(session_id, None)
        if shell:
            shell.close()


# ---------------------------------------------------------------------------
# Background reaper thread
# ---------------------------------------------------------------------------

_reaper_running = False


def _reaper_loop() -> None:
    """Background thread that kills idle shells."""
    while True:
        time.sleep(60)  # Check every minute
        with _lock:
            now = time.monotonic()
            to_close = [
                sid for sid, shell in _shells.items()
                if now - shell._last_used > shell.idle_timeout
            ]
        for sid in to_close:
            logger.info("Reaper: closing idle shell for session %s", sid)
            close_shell(sid)


def start_reaper() -> None:
    """Start the background reaper thread (once)."""
    global _reaper_running
    if _reaper_running:
        return
    _reaper_running = True
    t = threading.Thread(target=_reaper_loop, daemon=True, name="xvie-shell-reaper")
    t.start()
