"""Interactive chat REPL for xvie-agent.

Provides a persistent, conversational interface where the user can chat
with the agent across multiple turns. The session persists across the
conversation, so the agent remembers previous context.

Unicode safety: agent replies (which often contain em-dashes, curly
quotes, and emoji) are streamed through Rich's wide-character console
path instead of raw ``os.write`` of UTF-8 bytes.  On a Windows console
running a non-UTF-8 codepage (cp1252/cp437), raw byte writes render as
mojibake (``ΓÇö``, ``ΓÇÖ``, ``≡ƒöº``).  Nothing is ever stripped from the
data — sessions are serialized with ``ensure_ascii=False`` so the real
characters are preserved for downstream app integration.
"""

from __future__ import annotations

import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from xvie_agent.loop import run_agent
from xvie_agent.providers.base import ProviderClient
from xvie_agent.session import SessionState
from xvie_agent.status import StatusLine, event_status_text, with_elapsed
from xvie_agent.store import list_sessions
from xvie_agent.types import AgentRunResult, BudgetConfig
from xvie_agent.modes import get_mode, is_valid_mode


# ---------------------------------------------------------------------------
# Console encoding helpers
# ---------------------------------------------------------------------------

def force_utf8_console() -> None:
    """Best-effort: switch the Windows console codepage to UTF-8 (65001).

    Fixes mojibake (``ΓÇö`` / ``≡ƒöº``) for any code path that writes raw
    UTF-8 bytes to the console — Rich already renders via the wide-char
    API, so this is purely a safety net.  It never touches the content
    itself, only the terminal's decoding.
    """
    if os.name != "nt":
        return
    try:
        import ctypes
        kernel32 = ctypes.windll.kernel32
        kernel32.SetConsoleOutputCP(65001)
        kernel32.SetConsoleCP(65001)
    except Exception:
        pass


class TextStreamer:
    """Stream assistant text through Rich so Unicode renders on Windows.

    Deltas are batched and flushed on size/word boundaries so output still
    feels live, while going through ``rich.text.Text`` (which renders
    literally — no markup parsing, no codepage mangling).

    When *gutter* is provided (e.g. ``"│ "``), every output line is prefixed
    with it — the opencode-style left-gutter conversation pane.  Gutter-less
    operation is identical to the original streaming behaviour.
    """

    __slots__ = (
        "_console", "_flush_every", "_buf", "_chars",
        "_gutter", "_gutter_style", "_at_line_start",
    )

    def __init__(
        self,
        console,
        flush_every: int = 48,
        *,
        gutter: str | None = None,
        gutter_style: str = "dim",
    ) -> None:
        self._console = console
        self._flush_every = flush_every
        self._buf: list[str] = []
        self._chars = 0
        self._gutter = gutter
        self._gutter_style = gutter_style
        self._at_line_start = True

    def feed(self, delta: str) -> None:
        if not delta:
            return
        self._buf.append(delta)
        self._chars += len(delta)
        # In gutter (live) mode, emit as soon as a delta arrives so streamed
        # text never lags behind tool/thinking lines.  Otherwise batch.
        if self._gutter is not None or self._chars >= self._flush_every:
            self.flush()

    def flush(self) -> None:
        if not self._buf:
            return
        text = "".join(self._buf)
        self._buf.clear()
        self._chars = 0
        from rich.text import Text
        try:
            if self._gutter is None:
                self._console.print(Text(text), end="")
            else:
                self._print_with_gutter(text)
            try:
                self._console.file.flush()
            except Exception:
                pass
        except UnicodeEncodeError:
            # Rich's legacy Windows renderer encodes via the console's
            # codepage and can't represent e.g. emoji. Fall back to raw
            # UTF-8 bytes — correct once force_utf8_console() has set the
            # console codepage to 65001.
            try:
                fd = sys.stdout.fileno()
                os.write(fd, text.encode("utf-8", errors="replace"))
            except (OSError, ValueError):
                pass
        except Exception:
            pass

    def _print_with_gutter(self, text: str) -> None:
        """Emit *text* line-by-line, prefixing each line with the gutter."""
        from rich.text import Text
        console = self._console
        parts = text.split("\n")
        last = len(parts) - 1
        for i, part in enumerate(parts):
            if i > 0:
                console.print("")
                self._at_line_start = True
            if (
                self._gutter
                and self._at_line_start
                and not (i == last and part == "")
            ):
                console.print(Text(self._gutter, style=self._gutter_style), end="")
                self._at_line_start = False
            if part:
                console.print(Text(part), end="")

    @property
    def at_line_start(self) -> bool:
        """True if the streamer is at the start of a line (no partial line open)."""
        return self._at_line_start


# ---------------------------------------------------------------------------
# File attachment helpers (/attach)
# ---------------------------------------------------------------------------

def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name, "")
    if not raw:
        return default
    try:
        return max(1, int(raw))
    except ValueError:
        return default


_MAX_ATTACH_BYTES = _env_int("XVIE_MAX_ATTACH_BYTES", 4_000_000)
_MAX_ATTACH_FILES = _env_int("XVIE_MAX_ATTACH_FILES", 50)


@dataclass
class AttachedFile:
    """A single file queued for the next agent message."""

    rel_path: str
    content: str
    size: int


def _looks_binary(data: bytes, sample_limit: int = 4096) -> bool:
    """Heuristic: reject binary files (NUL-heavy content)."""
    if not data:
        return False
    sample = data[:sample_limit]
    nuls = sample.count(b"\x00")
    return bool(nuls) and (nuls / len(sample)) > 0.05


def collect_attachments(
    specs: list[str],
    workspace_root: Path,
    *,
    max_bytes: int = _MAX_ATTACH_BYTES,
    max_files: int = _MAX_ATTACH_FILES,
) -> list[AttachedFile]:
    """Expand user specs into attachable text files.

    Supports plain paths, globs (``src/**/*.py``), and directories (recursive).
    Files are read as UTF-8 (lossy) and capped at *max_bytes* each.
    """
    workspace_root = workspace_root.resolve()
    seen: dict[str, AttachedFile] = {}

    for spec in specs:
        has_glob = any(ch in spec for ch in "*?[")
        target = Path(spec)
        if not target.is_absolute() and not has_glob:
            target = workspace_root / target

        if has_glob:
            paths = list(workspace_root.glob(spec))
        elif target.is_dir():
            paths = [p for p in sorted(target.rglob("*")) if p.is_file()]
        elif target.is_file():
            paths = [target]
        else:
            paths = []

        for fp in paths:
            try:
                data = fp.read_bytes()
            except OSError:
                continue
            if _looks_binary(data):
                continue
            size = len(data)
            content = data.decode("utf-8", errors="replace")
            if size > max_bytes:
                content = content[:max_bytes] + "\n\n[truncated]"
            try:
                rel = str(fp.resolve().relative_to(workspace_root))
            except ValueError:
                rel = str(fp)
            rel = rel.replace(os.sep, "/")
            key = str(fp.resolve())
            if key not in seen:
                seen[key] = AttachedFile(rel_path=rel, content=content, size=size)

    return list(seen.values())[:max_files]


def format_attachment_block(files: list[AttachedFile]) -> str:
    """Render attached files as a fenced text block for the agent."""
    blocks: list[str] = []
    for f in files:
        ext = Path(f.rel_path).suffix.lstrip(".")
        blocks.append(f"Attached file: {f.rel_path}")
        blocks.append(f"```{ext}")
        blocks.append(f.content)
        blocks.append("```")
    return "\n".join(blocks)


def _fmt_bytes(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / (1024 * 1024):.1f} MB"


# ---------------------------------------------------------------------------
# Turn footer summary
# ---------------------------------------------------------------------------

def summarize_result(
    result: AgentRunResult,
    model: str,
    mode: str,
    activity_kinds: list[str],
    tools_used: list[str],
) -> list[str]:
    """Build the tidy turn-footer summary lines (plain text)."""
    lines: list[str] = []
    tool_text = (", ".join(tools_used[:6])
                 + (f" +{len(tools_used) - 6} more" if len(tools_used) > 6 else "")
                 if tools_used else "(none)")
    lines.append(
        f"stop: {result.stop_reason} · mode: {mode} · "
        f"turns: {result.turns} · tools: {tool_text}"
    )
    usage = result.usage
    cost = (usage.input_tokens * 0.15 + usage.output_tokens * 0.60) / 1_000_000
    lines.append(
        f"tokens: {usage.input_tokens:,} in / {usage.output_tokens:,} out / "
        f"{usage.total_tokens:,} total · est. ${cost:.4f} · {model}"
    )
    if activity_kinds:
        lines.append("activity: " + " → ".join(dict.fromkeys(activity_kinds)))
    return lines


# Conversation-pane left gutter — message blocks are unbordered: content
# flows in a dim left gutter, opencode-style, with no header/label row.
def _pane(text: str) -> str:
    """Prefix every line in *text* with the opencode-style left gutter.

    Preserves inline Rich markup (the gutter itself stays dim).
    """
    prefix = "[dim]│[/dim] "
    return prefix + text.replace("\n", "\n" + prefix)


def _render_answer(console, text: str, title: str | None = None) -> None:
    """Render the final answer: syntax-highlighted code blocks + plain text.

    Rich's Markdown renderer hangs on fenced code blocks in this environment,
    so we extract each ```lang ... ``` block, render it with :class:`Syntax`
    (highlighting), and fall back to plain :class:`Text` for the rest.  Using
    :class:`Text` also avoids interpreting stray Rich markup in model output.
    """
    import re

    from rich.console import Group
    from rich.panel import Panel
    from rich.syntax import Syntax
    from rich.text import Text

    fence = re.compile(r"```(\w*)\s*\n(.*?)```", re.DOTALL)
    parts: list = []
    pos = 0
    for match in fence.finditer(text):
        before = text[pos:match.start()]
        if before.strip():
            parts.append(Text(before))
        lang = (match.group(1) or "text").strip() or "text"
        try:
            parts.append(Syntax(match.group(2), lang, theme="monokai", word_wrap=True))
        except Exception:
            parts.append(Text(match.group(2)))
        pos = match.end()
    tail = text[pos:]
    if tail.strip():
        parts.append(Text(tail))
    if not parts:
        parts.append(Text(text or ""))
    body: object = Group(*parts) if len(parts) > 1 else parts[0]
    console.print(Panel(body, title=title, border_style="green"))


# ---------------------------------------------------------------------------
# Chat loop
# ---------------------------------------------------------------------------

def chat(
    workspace_root: Path,
    *,
    provider: ProviderClient | None = None,
    model: str = "nvidia/nemotron-3-ultra-550b-a55b",
    allow_write: bool = True,
    allow_shell: bool = True,
    lane: str | None = None,
    sessions_dir: Path | None = None,
    api_key: str = "",
    provider_name: str = "",
    base_url: str = "",
    thinking: bool = True,
    permission_mode: str = "accept-edits",
    max_turns: int = 50,
    initial_mode: str = "code",
    plan_gate: bool = True,
) -> None:
    """Start an interactive chat session with the agent.

    Args:
        workspace_root: Path to the project directory.
        provider: Pre-built provider client (optional).
        model: Model slug to use.
        allow_write: Whether the agent can write files.
        allow_shell: Whether the agent can run commands.
        lane: Routing lane (optional).
        sessions_dir: Where to save sessions.
        api_key: Provider API key (if provider is None).
        provider_name: Provider name (if provider is None).
        base_url: Provider base URL (if provider is None).
    """
    from rich.console import Console, Group
    from rich.panel import Panel
    from rich.table import Table
    from rich.text import Text as RichText

    # Force stdout to unbuffered mode so streaming tokens appear immediately
    # on Windows (where stdout is line-buffered by default).
    try:
        import msvcrt
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    except (ImportError, OSError):
        pass
    try:
        sys.stdout.reconfigure(line_buffering=False)
    except (AttributeError, OSError):
        pass

    force_utf8_console()
    console = Console(force_terminal=True)

    # Snapshot the untouched print so the spinner guard below always wraps the
    # real implementation — never a previously-installed _guarded_print from an
    # earlier chat() call in the same process.
    _ORIGINAL_PRINT = console.print
    workspace_root = workspace_root.resolve()

    if sessions_dir is None:
        sessions_dir = workspace_root / ".xvie-sessions"

    perm_desc = {
        "accept-edits": "file writes apply directly; shell commands ask first",
        "default": "every file change asks for approval",
        "plan": "read-only planning",
    }.get(permission_mode, permission_mode)

    active_mode = initial_mode if is_valid_mode(initial_mode) else "code"

    # Resolve provider BEFORE the banner so we can show model/provider info.
    if provider is None:
        from xvie_agent.loop import _resolve_provider
        config = _resolve_provider(
            api_key=api_key,
            provider_name=provider_name,
            base_url=base_url,
        )
        if config is None:
            console.print("[red]No provider API key configured.[/red]")
            return
        provider = ProviderClient(config=config)

    provider_label = provider.provider_name

    mode_cfg = get_mode(active_mode)
    commands_table = Table(show_header=False, box=None, padding=(0, 2))
    commands_table.add_column("Modes", style="cyan")
    commands_table.add_column("Commands", style="yellow")
    commands_table.add_row(
        "/code  /plan  /debug\n/ask  /brainstorm",
        "/approve  /deny  /trace on|off\n/attach <files>  /models  /status",
    )
    commands_table.add_row(
        "/attach src/**/*.py  /attach README.md",
        "/permissions  /clear  /sessions  /quit\n/design style=... accent=...",
    )
    gate_label = "ON — the agent pauses after planning and awaits your approval" if plan_gate else "OFF"
    console.print(
        f"[dim]plan gate: {gate_label}. When a plan is ready, type 'proceed' to implement it, or '/deny' to cancel.[/dim]"
    )

    banner = Panel(
        Group(
            RichText("xvie-agent chat — persistent coding session", style="bold"),
            RichText(f"workspace: {workspace_root}", style="dim"),
            RichText(
                f"mode: {mode_cfg.display_name} · permission: {permission_mode} ({perm_desc})",
                style="dim",
            ),
            RichText(
                f"model: {model} · provider: {provider_label} · lane: {lane or 'auto'}",
                style="dim",
            ),
            commands_table,
        ),
        title="Chat Mode",
        border_style="blue",
        padding=(1, 2),
    )
    console.print(banner)

    # Start session
    session = SessionState(system_prompt="")
    trace_enabled = thinking
    approve_next_write = False
    pending_attachments: str | None = None

    while True:
        try:
            console.print()
            user_input = console.input("[bold yellow]You:[/bold yellow] ").strip()
        except (EOFError, KeyboardInterrupt):
            console.print("\n[dim]Goodbye![/dim]")
            break

        if not user_input:
            continue

        # Handle commands
        if user_input.lower() in ("/quit", "/exit", "/q"):
            console.print("[dim]Goodbye![/dim]")
            break

        if user_input.lower() == "/clear":
            session = SessionState(system_prompt="")
            pending_attachments = None
            console.print("[dim]Session cleared.[/dim]")
            continue

        if user_input.lower().startswith("/attach"):
            spec_line = user_input.split(maxsplit=1)
            if len(spec_line) < 2:
                console.print("[yellow]Usage: /attach <path or glob> [more paths…][/yellow]")
                console.print("[dim]Examples:\n  /attach README.md\n  /attach src/**/*.py\n  /attach src/[/dim]")
                continue
            try:
                files = collect_attachments(spec_line[1].split(), workspace_root)
            except Exception as exc:  # pragma: no cover - defensive
                console.print(f"[red]Could not resolve those paths: {exc}[/red]")
                continue
            if not files:
                console.print("[yellow]No readable non-binary files matched those paths.[/yellow]")
                continue
            pending_attachments = format_attachment_block(files)
            total = sum(f.size for f in files)
            console.print(f"[green]📎 Queued {len(files)} file(s) ({_fmt_bytes(total)}) for the next message:[/green]")
            for f in files[:8]:
                console.print(f"[dim]  {f.rel_path}[/dim]")
            if len(files) > 8:
                console.print(f"[dim]  … and {len(files) - 8} more.[/dim]")
            console.print("[dim]Type your question now, and the files will be attached to it.[/dim]")
            continue

        if user_input.lower() in {"/approve", "approve", "yes", "proceed"}:
            state = session.execution_state or {}
            if state.get("phase") != "awaiting_approval":
                console.print("[yellow]There is no pending implementation plan.[/yellow]")
                continue
            approve_next_write = True
            user_input = state["prompt"]

        if user_input.lower() == "/deny":
            approve_next_write = False
            session.execution_state = None
            console.print("[dim]Pending implementation was cancelled; investigation history remains available.[/dim]")
            continue

        if user_input.lower().startswith("/trace"):
            trace_enabled = not user_input.lower().endswith("off")
            console.print(f"[dim]Activity trace {'enabled' if trace_enabled else 'disabled'}.[/dim]")
            continue

        if user_input.lower() == "/models":
            console.print(f"[dim]Provider: {provider.provider_name}; requested model: {model}; lane: {lane or 'automatic'}[/dim]")
            continue

        if user_input.lower() == "/permissions":
            console.print(f"[dim]Permission mode: {permission_mode}. Use /permissions default, accept-edits, or plan.[/dim]")
            continue

        if user_input.lower().startswith("/permissions "):
            requested = user_input.split(maxsplit=1)[1].strip().lower()
            if requested in {"default", "accept-edits", "plan"}:
                permission_mode = requested
                console.print(f"[dim]Permission mode set to {permission_mode}.[/dim]")
            else:
                console.print("[yellow]Use default, accept-edits, or plan.[/yellow]")
            continue

        if user_input.lower() == "/plan":
            active_mode = "plan"
            console.print("[dim]Switched to [bold]Plan[/bold] mode — read-only research and planning.[/dim]")
            continue

        if user_input.lower().startswith("/design"):
            from xvie_agent.design_memory import save_design_memory

            spec = user_input.split(maxsplit=1)
            if len(spec) < 2:
                console.print(
                    "[yellow]Usage: /design style=minimal accent=#6C5CE7 font=Inter animation=subtle[/yellow]"
                )
                console.print("[dim]Saved to .xvie/design-memory.json; the agent respects it on future builds.[/dim]")
                continue
            prefs = {}
            for part in spec[1].split():
                if "=" in part:
                    key, _, value = part.partition("=")
                    key = key.strip().lower()
                    if key in {"style", "accent", "font", "animation"} and value.strip():
                        prefs[key] = value.strip()
            if not prefs:
                console.print("[yellow]No valid keys. Use style= / accent= / font= / animation=[/yellow]")
                continue
            save_design_memory(workspace_root, prefs)
            console.print(
                f"[green]Design memory saved: {', '.join(f'{k}={v}' for k, v in prefs.items())}[/green]"
            )
            continue

        if user_input.lower() == "/code":
            active_mode = "code"
            console.print("[dim]Switched to [bold]Code[/bold] mode — full implementation.[/dim]")
            continue

        if user_input.lower() == "/debug":
            active_mode = "debug"
            console.print("[dim]Switched to [bold]Debug[/bold] mode — systematic bug hunting. Paste error messages for analysis.[/dim]")
            continue

        if user_input.lower() == "/ask":
            active_mode = "ask"
            console.print("[dim]Switched to [bold]Ask[/bold] mode — questions only, no code generation.[/dim]")
            continue

        if user_input.lower() in ("/brainstorm", "/brain"):
            active_mode = "brainstorm"
            console.print("[dim]Switched to [bold]Brainstorm[/bold] mode — ideas, research, and critical analysis.[/dim]")
            continue

        if user_input.lower() == "/status":
            cfg = get_mode(active_mode)
            console.print(f"[dim]Session: {session.session_id[:12]}... | messages: {len(session.messages)} | mode: {cfg.display_name} | trace: {'on' if trace_enabled else 'off'}[/dim]")
            continue

        if user_input.lower() == "/sessions":
            _show_sessions(console, sessions_dir)
            continue

        # Attach queued files to this prompt if any.
        if pending_attachments:
            user_input = pending_attachments + "\n\n" + user_input
            pending_attachments = None

        console.print()
        from rich.markup import escape

        streamer = TextStreamer(console, gutter="│ ")
        streamed_chars = 0
        warnings: list[str] = []
        request_start = time.monotonic()

        # Live "cooking" spinner — shows progress during the quiet phase
        # between submission and the first streamed token / tool event.
        # It is restarted between turns (see _pipe) so post-stream waits
        # never look frozen.
        status = StatusLine()
        status.start("Working…")

        # Any console output while the spinner is live must first reclaim the
        # spinner's row, or prints would splice into an animated line. Bind to
        # the *original* print so a second chat() call in the same process
        # (which reinstates its own guard) never wraps its own wrapper.
        _printed_holder: dict[str, bool] = {"any": False}
        _console_print = _ORIGINAL_PRINT

        def _guarded_print(*args, **kwargs):
            if status.active:
                status.hide()
                _printed_holder["any"] = True
            return _console_print(*args, **kwargs)

        console.print = _guarded_print

        def approve_action(description: str) -> bool:
            """Inline approval 'button' — y/Enter approves, n denies."""
            if status.active:
                status.pause()
            console.print()
            from rich.prompt import Confirm
            try:
                approved = Confirm.ask(
                    f"  [bold yellow]Approve[/bold yellow] {description}",
                    default=True,
                )
            except (EOFError, KeyboardInterrupt):
                approved = False
            if not approved:
                console.print("[dim]  Denied.[/dim]")
            if status.active:
                status.resume()
            return bool(approved)

        def answer_questions(questions: list[dict]) -> list[dict] | None:
            """CLI pause-and-wait: numbered chips + free-text per question."""
            if status.active:
                status.pause()
            console.print()
            answers: list[dict] = []
            try:
                from rich.prompt import Prompt
                for q in questions:
                    header = str(q.get("header", "")).strip()
                    text = str(q.get("question", "")).strip()
                    opts = q.get("options", []) or []
                    title = f"{header}: {text}" if header else text
                    console.print(f"  [bold cyan]?[/bold cyan] {title}")
                    for i, opt in enumerate(opts, 1):
                        label = opt.get("label", "") if isinstance(opt, dict) else str(opt)
                        desc = opt.get("description", "") if isinstance(opt, dict) else ""
                        suffix = f" — {desc}" if desc else ""
                        console.print(f"     [dim]{i}.[/dim] {label}{suffix}")
                    console.print("     [dim]Type option number(s) comma-separated, or your own answer. Enter to skip.[/dim]")
                    try:
                        raw = Prompt.ask("     Your answer", default="").strip()
                    except (EOFError, KeyboardInterrupt):
                        raw = ""
                    if not raw:
                        answers.append({"id": q.get("id", ""), "selected": [], "custom_text": ""})
                        continue
                    selected: list[str] = []
                    customs: list[str] = []
                    for part in [p.strip() for p in raw.split(",") if p.strip()]:
                        if part.isdigit() and 1 <= int(part) <= len(opts):
                            opt = opts[int(part) - 1]
                            label = opt.get("label", "") if isinstance(opt, dict) else str(opt)
                            selected.append(str(label))
                        else:
                            customs.append(part)
                    answers.append({
                        "id": q.get("id", ""),
                        "selected": selected,
                        "custom_text": ", ".join(customs),
                    })
            finally:
                if status.active:
                    status.resume()
            return answers

        # Accumulate thinking text for collapsible display.
        # Reasoning deltas are flushed live (partial chunks) so a long
        # thinking phase never looks like a frozen "Working…" spinner.
        thought_buffer: list[str] = []
        thought_start_ms: float | None = None
        thought_last_flush: float = 0.0
        thought_chunk_index: int = 0

        def _emit(text: str) -> None:
            """Print one pane line; if the streamer left a partial line open,
            close it first so tool/thinking lines never collide with the
            streamed reply text."""
            if not streamer.at_line_start:
                console.print("")
            console.print(_pane(text))

        def _flush_thought() -> None:
            """Print accumulated thinking as a collapsible section."""
            nonlocal thought_buffer, thought_start_ms, thought_last_flush, thought_chunk_index
            if not thought_buffer or not trace_enabled:
                thought_buffer.clear()
                thought_start_ms = None
                return
            full_text = "".join(thought_buffer)
            duration = ""
            if thought_start_ms is not None:
                elapsed = time.monotonic() - thought_start_ms
                duration = f" ({elapsed:.1f}s)"
            prefix = "▼ Thinking" if thought_chunk_index == 0 else f"▼ Thinking (cont. {thought_chunk_index + 1})"
            _emit(f"[dim]  {prefix}{duration}:[/dim]")
            text = full_text.strip()
            lines = text.splitlines() if "\n" in text else [text]
            for line in lines[:30]:  # Cap at 30 lines for readability
                if line.strip():
                    _emit(f"[dim italic]    {escape(line.strip()[:300])}[/dim italic]")
            if len(lines) > 30:
                _emit(f"[dim]    ... ({len(lines) - 30} more lines)[/dim]")
            thought_buffer.clear()
            thought_start_ms = None
            thought_last_flush = 0.0
            thought_chunk_index = 0
            try:
                console.file.flush()
            except Exception:
                pass

        def _flush_thought_partial() -> None:
            """Emit the current reasoning buffer live without ending the block."""
            nonlocal thought_buffer, thought_last_flush, thought_chunk_index
            if not thought_buffer or not trace_enabled:
                return
            full_text = "".join(thought_buffer).strip()
            if not full_text:
                return
            # Keep the live preview short — full text comes at _flush_thought.
            preview = full_text[-400:]
            elapsed = 0.0
            if thought_start_ms is not None:
                elapsed = time.monotonic() - thought_start_ms
            thought_chunk_index += 1
            _emit(f"[dim]  ◌ Thinking ({elapsed:.0f}s): {escape(preview[:280])}[/dim]")
            thought_buffer.clear()
            thought_last_flush = time.monotonic()
            try:
                console.file.flush()
            except Exception:
                pass

        def _ensure_spinner(label: str) -> None:
            """Restart the spinner between turns so waits are never blank.

            The spinner is stopped on the first text token to avoid fighting
            the streamer. The *next* model turn (thinking/reasoning/tool) can
            then take many seconds — without this the UI looks frozen.
            """
            if status.active:
                return
            if not streamer.at_line_start:
                try:
                    console.print("")
                except Exception:
                    pass
            status.start(label)

        def on_event(event) -> None:
            nonlocal streamed_chars
            # Keep the Claude-style label fresh + elapsed so long waits read
            # as "Thinking… (7s)" instead of a frozen "Working…".
            elapsed_total = time.monotonic() - request_start
            base_label = event_status_text(event.kind, event.message)
            live_label = with_elapsed(base_label, elapsed_total)
            if status.active:
                status.update(live_label)
            _printed_holder["any"] = False
            _pipe(event)
            if status.active and _printed_holder["any"]:
                status.show()

        def _pipe(event) -> None:
            nonlocal streamed_chars, thought_buffer, thought_start_ms, thought_last_flush
            kind = event.kind

            # Streaming began — retire the spinner so it never fights the
            # partial gutter lines the streamer writes.
            if kind == "model_text":
                if status.active:
                    status.stop()

            # Completed plan tasks always show, even with trace off.
            if kind == "task_done":
                _flush_thought()
                streamer.flush()
                _emit(f"[green]  ✓ Task done:[/green] {escape(event.message)}")
                return

            # A new model turn started after streaming — the spinner was
            # stopped for the streamer, so restart it or the wait looks dead.
            if kind in ("thinking", "reasoning", "thought", "selected_model", "tool_started"):
                _ensure_spinner(with_elapsed(
                    event_status_text(kind, event.message),
                    time.monotonic() - request_start,
                ))

            # Reasoning deltas: accumulate + live-flush so long thinking
            # paints incrementally instead of one dump at the end.
            if kind == "reasoning":
                delta = event.data.get("delta", "")
                if delta and trace_enabled:
                    if not thought_buffer:
                        thought_start_ms = time.monotonic()
                        thought_last_flush = time.monotonic()
                    thought_buffer.append(delta)
                    joined_len = sum(len(p) for p in thought_buffer)
                    since_flush = time.monotonic() - thought_last_flush
                    if joined_len >= 400 or since_flush >= 2.5:
                        _flush_thought_partial()
                elif delta and not trace_enabled:
                    # Trace off: still keep spinner alive with elapsed time.
                    pass
                return

            # Complete thoughts (native reasoning or prompt-based "Thought:" lines)
            if kind == "thought":
                if trace_enabled:
                    _flush_thought()
                    ms = event.data.get("duration_ms")
                    dur = f" ({ms / 1000:.1f}s)" if isinstance(ms, (int, float)) else ""
                    _emit(f"[dim]  ▶ Thought{dur}:[/dim] {escape(event.message)}")
                return

            # Any other event flushes accumulated thinking.
            if thought_buffer:
                _flush_thought()

            # Assistant text deltas: stream via Rich (wide-char safe).
            if kind == "model_text":
                delta = event.data.get("delta", "")
                if delta:
                    streamed_chars += len(delta)
                    streamer.feed(delta)
                return

            if kind == "output_truncated":
                warnings.append(event.message)
                _emit(f"[dim]  ⏩ {event.message}[/dim]")
                return

            # --- Rich file editing narration ---
            if kind == "editing" and trace_enabled:
                tool_name = event.data.get("tool", "")
                msg = event.message
                streamer.flush()
                if tool_name == "write_file":
                    _emit(f"[cyan]  ✏ Writing:[/cyan] {escape(msg)}")
                elif tool_name == "edit_file":
                    _emit(f"[cyan]  ✏ Editing:[/cyan] {escape(msg)}")
                elif tool_name == "append_file":
                    _emit(f"[cyan]  📎 Appending:[/cyan] {escape(msg)}")
                elif tool_name in ("move_file", "delete_file"):
                    _emit(f"[cyan]  📁 {tool_name}:[/cyan] {escape(msg)}")
                else:
                    _emit(f"[dim]  ✏ {msg}[/dim]")
                return

            # --- File diff display ---
            if kind == "file_diff" and trace_enabled:
                diff_text = event.message
                file_path = event.data.get("file", "")
                if diff_text:
                    streamer.flush()
                    diff_lines = diff_text.splitlines()
                    _emit(f"[dim]  📝 Diff for {file_path}:[/dim]")
                    for line in diff_lines[:60]:  # Cap at 60 lines for readability
                        if line.startswith("+++") or line.startswith("---"):
                            _emit(f"[bold]{escape(line)}[/bold]")
                        elif line.startswith("@@"):
                            _emit(f"[cyan]{escape(line)}[/cyan]")
                        elif line.startswith("+"):
                            _emit(f"[green]{escape(line)}[/green]")
                        elif line.startswith("-"):
                            _emit(f"[red]{escape(line)}[/red]")
                        else:
                            _emit(f"[dim]{escape(line)}[/dim]")
                    if len(diff_lines) > 60:
                        _emit(f"[dim]    ... ({len(diff_lines) - 60} more lines)[/dim]")
                return

            if kind == "edit_failed" and trace_enabled:
                _emit(f"[red]  ✗ Edit failed:[/red] {escape(event.message)}")
                return

            # Long-running tool / approval checkpoints stay visible live…
            if kind == "tool_started":
                _emit(f"[dim]  ⚙ {escape(event.message)}…[/dim]")
                return
            if kind == "awaiting_confirmation":
                _emit(f"[yellow]  ⌛ {escape(event.message)}[/yellow]")
                return
            if kind == "question_required":
                _emit(f"[cyan]  ? {escape(event.message)}[/cyan]")
                return
            if kind == "rate_limit_wait":
                _emit(f"[yellow]  ⏳ {escape(event.message)}[/yellow]")
                return

        try:
            result = run_agent(
                prompt=user_input,
                model=model,
                workspace_root=workspace_root,
                provider=provider,
                allow_write=allow_write,
                allow_shell=allow_shell,
                lane=lane,
                existing_session=session,
                sessions_dir=sessions_dir,
                thinking=trace_enabled,
                max_turns=max_turns,
                budget=BudgetConfig(max_turns=max_turns),
                event_callback=on_event,
                approval_callback=approve_action,
                question_callback=answer_questions,
                write_approved=approve_next_write,
                permission_mode=permission_mode,
                mode=active_mode,
                plan_gate=plan_gate,
            )
        finally:
            status.stop()
            console.print = _ORIGINAL_PRINT
        streamer.flush()
        approve_next_write = False
        if thought_buffer:
            _flush_thought()
        console.print()

        # Display response — the opencode-style pane (label + gutter) when
        # nothing was streamed.
        output = result.final_output or ""
        if streamed_chars > 0:
            for w in warnings:
                _emit(f"[yellow]⚠ {w}[/yellow]")
        else:
            # If the model produced no text (only tool calls), generate a
            # summary only when REAL work was done (files created/edited).
            if not output.strip():
                tool_names = [tc.name for tc in (result.tool_calls or [])]
                mutating_tools = {"write_file", "edit_file", "append_file",
                                  "apply_patch", "move_file", "delete_file"}
                has_real_work = any(t in mutating_tools for t in tool_names)
                if has_real_work:
                    output = (
                        f"Files created/modified using: {', '.join(tool_names)}. "
                        "Let me know if you need any changes."
                    )
                elif tool_names:
                    # Only read/inspect tools — agent didn't actually build
                    # anything.  Show a helpful nudge instead of "done".
                    output = (
                        "I inspected the workspace but haven't started building yet. "
                        "Let me know if you'd like me to proceed."
                    )
            if len(output) > 3000:
                output = output[:3000] + "\n\n[dim](truncated — output was too long)[/dim]"
            if output:
                _render_answer(console, output)
            else:
                _emit(
                    f"[yellow]No response. Stop reason: {escape(result.stop_reason)}[/yellow]"
                )
            if result.stop_reason == "payload_too_large":
                _emit(
                    "[yellow]The model service could not accept the refreshed request. "
                    "Your files and session progress are saved; retry when the service "
                    "is ready.[/yellow]"
                )
            elif result.stop_reason in ("rate_limited", "all_models_exhausted"):
                _emit(
                    "[yellow]The model provider is rate-limiting requests. "
                    "The agent auto-retried a few times then gave up — "
                    "wait a minute and try again.[/yellow]"
                )
            elif result.stop_reason in ("model_error", "config_error"):
                _emit(
                    "[yellow]Model error. Check FORGE_PROVIDER_NVIDIA_API_KEY and "
                    "--model, then try again.[/yellow]"
                )
            if result.stop_reason == "awaiting_approval":
                _emit(
                    "[yellow]Plan ready — type[/yellow] [cyan]proceed[/cyan]"
                    "[yellow] to implement it, or[/yellow] [cyan]/deny[/cyan]"
                    "[yellow] to cancel.[/yellow]"
                )

        # Blank line separates this agent block from the next user prompt.
        console.print()


def _show_sessions(console, sessions_dir: Path) -> None:
    """Display saved sessions."""
    from rich.table import Table

    sessions = list_sessions(sessions_dir)
    if not sessions:
        console.print("[dim]No saved sessions.[/dim]")
        return

    table = Table(title="Saved Sessions")
    table.add_column("ID", style="cyan", no_wrap=True)
    table.add_column("Created", style="dim")
    table.add_column("Messages")
    table.add_column("Last Message")

    for s in sessions:
        sid = s["session_id"][:12] + "..."
        table.add_row(
            sid,
            s["created_at"][:19],
            str(s["message_count"]),
            s["last_user_message"][:60],
        )

    console.print(table)
