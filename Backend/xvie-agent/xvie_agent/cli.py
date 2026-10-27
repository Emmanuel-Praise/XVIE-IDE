"""CLI entry point for xvie-agent."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from xvie_agent import __version__


def _ensure_utf8() -> None:
    """Force UTF-8 on Windows to avoid cp1252 UnicodeEncodeError.

    Also switches the console output/input codepage to 65001 so raw
    UTF-8 bytes (e.g. em-dashes, curly quotes, emoji) render instead of
    mojibake (``ΓÇö`` / ``ΓÇÖ`` / ``≡ƒöº``). Nothing is stripped from the
    content itself — only the terminal's decoding changes.
    """
    import io
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout = io.TextIOWrapper(
            sys.stdout.buffer, encoding="utf-8", errors="replace", line_buffering=True
        )
    try:
        from xvie_agent.chat import force_utf8_console
        force_utf8_console()
    except Exception:
        pass


def _print_result(result, console, show_thinking: bool = False) -> None:
    """Print the agent result with rich formatting."""
    from rich.panel import Panel
    from rich.table import Table

    # Thinking mode: show activity trace with collapsible thinking
    # and rich editing narration.
    if show_thinking and getattr(result, "activity", None):
        lines: list[str] = []
        thinking_buf: list[str] = []
        for event in result.activity:
            kind = event.kind
            if kind == "reasoning":
                thinking_buf.append(event.message)
                continue
            if kind == "thought":
                if thinking_buf:
                    lines.append(f"  ▼ Thinking:")
                    for tl in thinking_buf:
                        lines.append(f"    {tl.strip()}")
                    thinking_buf.clear()
                lines.append(f"  ▶ Thought: {event.message}")
                continue
            # Flush thinking if we hit a non-thinking event
            if thinking_buf:
                lines.append(f"  ▼ Thinking:")
                for tl in thinking_buf:
                    lines.append(f"    {tl.strip()}")
                thinking_buf.clear()
            # Rich editing narration
            if kind == "editing":
                tool = event.data.get("tool", "")
                lines.append(f"  ✏ {event.message}")
            elif kind == "edit_failed":
                lines.append(f"  ✗ {event.message}")
            elif kind == "task_done":
                lines.append(f"  ✓ {event.message}")
            else:
                lines.append(f"  · {event.message}")
        # Flush remaining thinking
        if thinking_buf:
            lines.append(f"  ▼ Thinking:")
            for tl in thinking_buf:
                lines.append(f"    {tl.strip()}")
        if lines:
            console.print(Panel(
                "\n".join(lines),
                title="Working",
                border_style="dim",
                subtitle="(activity trace)",
            ))

    if result.final_output:
        from xvie_agent.chat import _render_answer
        _render_answer(console, result.final_output, title="Answer")
    else:
        console.print(Panel(
            f"[yellow]No final answer. Stop reason: {result.stop_reason}[/yellow]",
            title="Result", border_style="yellow",
        ))
        if result.stop_reason == "payload_too_large":
            console.print(
                "[yellow]The model service could not accept the refreshed request. "
                "Your files and session progress are saved; retry when the service "
                "is ready.[/yellow]"
            )
        elif result.stop_reason in ("rate_limited", "all_models_exhausted"):
            console.print(
                "[yellow]The model provider is rate-limiting requests — "
                "the agent auto-retried then gave up. "
                "Wait a minute and run again.[/yellow]"
            )

    table = Table(title="Summary", show_header=False, border_style="dim")
    table.add_column("Metric", style="bold")
    table.add_column("Value")
    table.add_row("Stop reason", result.stop_reason)
    table.add_row("Turns", str(result.turns))
    table.add_row("Tool calls", str(len(result.tool_calls)))
    table.add_row("Input tokens", str(result.usage.input_tokens))
    table.add_row("Output tokens", str(result.usage.output_tokens))
    table.add_row("Total tokens", str(result.usage.total_tokens))
    cost = (result.usage.input_tokens * 0.15 + result.usage.output_tokens * 0.60) / 1_000_000
    table.add_row("Est. cost", f"${cost:.4f}")
    if result.model_calls_by_model:
        for model_name, count in result.model_calls_by_model.items():
            table.add_row(f"Calls ({model_name})", str(count))
    console.print(table)


def _run_with_status(console, label: str, **kwargs):
    """Run run_agent() under an animated status line fed by agent events."""
    from xvie_agent.loop import run_agent
    from xvie_agent.status import StatusLine, event_status_text

    status = StatusLine()
    status.start(label)

    def on_event(event) -> None:
        status.update(event_status_text(event.kind, event.message))

    try:
        return run_agent(**kwargs, event_callback=on_event)
    finally:
        status.stop()


def _resolve_provider_for_cli(args) -> "ProviderClient | None":
    """Resolve a ProviderClient from CLI args + env vars.

    Priority:
    1. --provider flag → lookup from load_providers_from_env()
    2. --api-key flag → build from explicit args
    3. Auto-detect from env vars
    """
    from xvie_agent.providers.base import ProviderClient, ProviderConfig, _KNOWN_DEFAULTS
    from xvie_agent.providers.registry import load_providers_from_env, get_provider
    from dotenv import load_dotenv
    import os

    load_dotenv()

    # --provider flag: look up from registry
    if args.provider:
        providers = load_providers_from_env()
        try:
            return get_provider(args.provider, providers)
        except KeyError as exc:
            # If provider not in registry but --api-key is also given, build it
            if args.api_key:
                base_url = args.base_url or _KNOWN_DEFAULTS.get(args.provider, "")
                if base_url:
                    return ProviderClient(
                        config=ProviderConfig(
                            name=args.provider, api_key=args.api_key, base_url=base_url,
                        )
                    )
            raise SystemExit(str(exc)) from exc

    # --api-key flag: build from explicit args
    if args.api_key:
        name = args.provider or "custom"
        base_url = args.base_url or _KNOWN_DEFAULTS.get(name, os.getenv("FORGE_CUSTOM_BASE_URL", ""))
        if not base_url:
            raise SystemExit(
                f"Provider '{name}' has no known base URL. "
                f"Use --base-url or set FORGE_PROVIDER_{name.upper()}_BASE_URL."
            )
        return ProviderClient(
            config=ProviderConfig(name=name, api_key=args.api_key, base_url=base_url)
        )

    # Auto-detect from env vars
    providers = load_providers_from_env()
    if providers:
        default_name = os.getenv("FORGE_DEFAULT_PROVIDER", "")
        if default_name and default_name in providers:
            return providers[default_name]
        return next(iter(providers.values()))

    return None


def _cmd_run(args: argparse.Namespace) -> int:
    """Execute the ``run`` subcommand."""
    from rich.console import Console
    from xvie_agent.types import BudgetConfig

    _ensure_utf8()
    console = Console()

    prompt = _read_prompt(args)

    budget = BudgetConfig(
        max_total_tokens=args.max_tokens if args.max_tokens else None,
        max_turns=args.max_turns,
        max_tool_calls=args.max_tool_calls if args.max_tool_calls else None,
    )
    workspace = Path(args.workspace).resolve()

    # Resolve provider
    client = _resolve_provider_for_cli(args)
    provider_label = client.provider_name if client else "unknown"
    console.print(
        f"[bold]xvie-agent[/bold] running on [cyan]{args.model}[/cyan] "
        f"(provider: {provider_label})  workspace={workspace}"
    )

    lane = getattr(args, 'lane', '') or None
    thinking = getattr(args, 'thinking', False)
    show_thinking = getattr(args, 'show_thinking', False)
    mode = getattr(args, 'mode', 'code')
    # --allow-write implies write_approved: the user explicitly opted into
    # file modifications.  Without this, writes still get blocked by the
    # approval gate even though the tool is registered.
    write_approved = getattr(args, "approve_writes", False) or args.allow_write
    result = _run_with_status(
        console,
        "Working…",
        prompt=prompt,
        model=args.model,
        workspace_root=workspace,
        provider=client,
        allow_write=args.allow_write,
        allow_shell=args.allow_shell,
        budget=budget,
        max_turns=args.max_turns,
        command_timeout=args.command_timeout,
        lane=lane,
        thinking=thinking,
        mode=mode,
        write_approved=write_approved,
        permission_mode=getattr(args, "permission_mode", "default"),
    )
    _print_result(result, console, show_thinking=show_thinking)
    return 0


def _read_prompt(args: argparse.Namespace) -> str:
    """Resolve the run/resume prompt, supporting files and stdin via ``-``."""
    prompt_file = getattr(args, "prompt_file", None)
    if prompt_file:
        return Path(prompt_file).read_text(encoding="utf-8")
    if args.prompt == "-":
        return sys.stdin.read()
    return args.prompt


def _cmd_sessions(args: argparse.Namespace) -> int:
    """List saved sessions."""
    from rich.console import Console
    from rich.table import Table
    from xvie_agent.store import list_sessions

    _ensure_utf8()
    console = Console()

    sessions_dir = Path(args.sessions_dir).resolve()
    sessions = list_sessions(sessions_dir)

    if not sessions:
        console.print("[dim]No saved sessions found.[/dim]")
        return 0

    table = Table(title="Saved Sessions")
    table.add_column("ID", style="cyan", no_wrap=True)
    table.add_column("Created", style="dim")
    table.add_column("Messages")
    table.add_column("Last Message")

    for s in sessions:
        sid = s["session_id"][:12] + "..."
        table.add_row(sid, s["created_at"][:19], str(s["message_count"]), s["last_user_message"][:60])

    console.print(table)
    return 0


def _cmd_resume(args: argparse.Namespace) -> int:
    """Resume a previous session with a new prompt."""
    from rich.console import Console
    from xvie_agent.store import load_session, save_session

    _ensure_utf8()
    console = Console()

    sessions_dir = Path(args.sessions_dir).resolve()
    session = load_session(args.session_id, sessions_dir)

    client = _resolve_provider_for_cli(args)
    provider_label = client.provider_name if client else "unknown"
    console.print(
        f"[bold]xvie-agent[/bold] resuming session [cyan]{session.session_id[:12]}...[/cyan] "
        f"(provider: {provider_label})"
    )

    lane = getattr(args, 'lane', '') or None
    write_approved = getattr(args, "approve_writes", False) or args.allow_write
    result = _run_with_status(
        console,
        "Working…",
        prompt=_read_prompt(args),
        model=args.model,
        workspace_root=Path(args.workspace).resolve(),
        provider=client,
        allow_write=args.allow_write,
        allow_shell=args.allow_shell,
        budget=BudgetConfig(max_turns=args.max_turns),
        max_turns=args.max_turns,
        existing_session=session,
        lane=lane,
        write_approved=write_approved,
    )

    # Save the updated session
    save_session(session, sessions_dir)

    _print_result(result, console)
    return 0


def _cmd_plan(args: argparse.Namespace) -> int:
    """Execute the ``plan`` subcommand."""
    from rich.console import Console

    _ensure_utf8()
    console = Console()

    client = _resolve_provider_for_cli(args)
    provider_label = client.provider_name if client else "unknown"
    console.print(
        f"[bold]xvie-agent[/bold] planning on [cyan]{args.model}[/cyan] "
        f"(provider: {provider_label})  workspace={Path(args.workspace).resolve()}"
    )

    result = _run_with_status(
        console,
        "Planning…",
        prompt=args.prompt,
        model=args.model,
        workspace_root=Path(args.workspace).resolve(),
        provider=client,
        allow_write=False,
        allow_shell=False,
        budget=BudgetConfig(max_turns=args.max_turns),
        max_turns=args.max_turns,
        mode="plan",
    )
    _print_result(result, console)
    return 0


def _cmd_execute_plan(args: argparse.Namespace) -> int:
    """Execute the ``execute-plan`` subcommand."""
    from rich.console import Console
    from xvie_agent.loop import run_agent
    from xvie_agent.planning import plan_to_run_requests
    from xvie_agent.types import BudgetConfig

    _ensure_utf8()
    console = Console()

    plan_path = Path(args.plan_file).resolve()
    steps = plan_to_run_requests(plan_path)

    if not steps:
        console.print("[yellow]No steps found in the plan file.[/yellow]")
        return 1

    console.print(f"[bold]Executing {len(steps)} steps from {plan_path.name}[/bold]")

    client = _resolve_provider_for_cli(args)
    workspace = Path(args.workspace).resolve()

    # One shared session across all steps — step N sees what steps 1..N-1 did.
    from xvie_agent.session import SessionState
    session = SessionState(system_prompt="")

    for i, step_prompt in enumerate(steps, 1):
        console.print(f"\n[bold cyan]Step {i}/{len(steps)}:[/bold cyan] {step_prompt[:100]}")

        result = run_agent(
            prompt=step_prompt,
            model=args.model,
            workspace_root=workspace,
            provider=client,
            allow_write=args.allow_write,
            allow_shell=args.allow_shell,
            budget=BudgetConfig(max_turns=args.max_turns),
            max_turns=args.max_turns,
            existing_session=session,
        )

        if result.stop_reason not in ("completed",):
            console.print(f"[red]Step {i} failed: {result.stop_reason}[/red]")
            if not args.continue_on_error:
                console.print("[red]Stopping. Use --continue-on-error to proceed.[/red]")
                return 1
        else:
            console.print(f"[green]Step {i} completed.[/green]")

    console.print(f"\n[bold green]All {len(steps)} steps completed.[/bold green]")
    return 0


def _cmd_chat(args: argparse.Namespace) -> int:
    """Execute the ``chat`` subcommand."""
    from xvie_agent.chat import chat
    from xvie_agent.loop import _resolve_provider
    from xvie_agent.providers.base import ProviderClient

    _ensure_utf8()

    workspace = Path(args.workspace).resolve()

    # Resolve provider
    config = _resolve_provider(
        api_key=args.api_key,
        provider_name=args.provider_name,
        base_url=args.base_url,
    )
    client = None
    if config:
        client = ProviderClient(config=config)

    chat(
        workspace_root=workspace,
        provider=client,
        model=args.model,
        allow_write=args.allow_write,
        allow_shell=args.allow_shell,
        lane=args.lane or None,
        thinking=args.trace,
        permission_mode=args.permission_mode,
        max_turns=args.max_turns,
        initial_mode=getattr(args, "mode", "code"),
        plan_gate=args.plan_gate,
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="xvie-agent",
        description="A multi-model agentic coding engine",
    )
    parser.add_argument(
        "--version", action="version", version=f"%(prog)s {__version__}"
    )
    subparsers = parser.add_subparsers(dest="command")

    # -- Shared arguments for run/resume --
    def _add_common_args(p):
        p.add_argument("--model", "-m", default="nvidia/nemotron-3-ultra-550b-a55b")
        p.add_argument("--workspace", "-w", default=".")
        p.add_argument("--allow-write", action="store_true")
        p.add_argument("--allow-shell", action="store_true")
        p.add_argument("--max-turns", type=int, default=50, help="Max agent turns per request (default: 50)")
        p.add_argument("--max-tokens", type=int, default=None)
        p.add_argument("--max-tool-calls", type=int, default=None)
        p.add_argument("--api-key", default="", help="Provider API key")
        p.add_argument("--provider", default="", help="Provider name (e.g. nvidia, openrouter)")
        p.add_argument("--base-url", default="", help="Provider base URL")
        p.add_argument("--command-timeout", type=int, default=30)
        p.add_argument("--lane", default="", help="Routing lane (planning, coding, fast_edit)")
        p.add_argument("--thinking", action="store_true", help="Enable thinking/reasoning mode")
        p.add_argument("--show-thinking", action="store_true", help="Display reasoning in output")
        p.add_argument("--approve-writes", action="store_true", help="Approve file changes for this run")
        p.add_argument("--permission-mode", choices=["default", "accept-edits", "plan"], default="default")
        p.add_argument("--mode", default="code", choices=["plan", "code", "debug", "ask", "brainstorm"],
                        help="Agent mode: plan (read-only research), code (implement), debug (find/fix bugs), ask (questions only), brainstorm (ideas/research)")

    # -- run subcommand --
    run_parser = subparsers.add_parser("run", help="Run the agent on a prompt")
    run_parser.add_argument("prompt", help="The user prompt / question ('-' reads stdin)")
    run_parser.add_argument("--prompt-file", default="", help="Read the prompt from a file (bypasses the OS arg-length limit)")
    _add_common_args(run_parser)
    run_parser.set_defaults(func=_cmd_run)

    # -- sessions subcommand --
    sessions_parser = subparsers.add_parser("sessions", help="List saved sessions")
    sessions_parser.add_argument(
        "--dir", dest="sessions_dir", default=".xvie-sessions",
        help="Sessions directory (default: .xvie-sessions)",
    )
    sessions_parser.set_defaults(func=_cmd_sessions)

    # -- resume subcommand --
    resume_parser = subparsers.add_parser("resume", help="Resume a previous session")
    resume_parser.add_argument("session_id", help="Session ID (or first 12 chars)")
    resume_parser.add_argument("prompt", help="New prompt to continue with ('-' reads stdin)")
    resume_parser.add_argument("--prompt-file", default="", help="Read the prompt from a file (bypasses the OS arg-length limit)")
    _add_common_args(resume_parser)
    resume_parser.add_argument(
        "--dir", dest="sessions_dir", default=".xvie-sessions",
        help="Sessions directory (default: .xvie-sessions)",
    )
    resume_parser.set_defaults(func=_cmd_resume)

    # -- plan subcommand --
    plan_parser = subparsers.add_parser("plan", help="Run in planning mode (read-only, generates a plan file)")
    plan_parser.add_argument("prompt", help="What to plan for")
    _add_common_args(plan_parser)
    plan_parser.set_defaults(func=_cmd_plan)

    # -- execute-plan subcommand --
    exec_parser = subparsers.add_parser("execute-plan", help="Execute steps from a plan file")
    exec_parser.add_argument("plan_file", help="Path to the plan .md file")
    _add_common_args(exec_parser)
    exec_parser.add_argument("--continue-on-error", action="store_true", help="Don't stop on first failed step")
    exec_parser.set_defaults(func=_cmd_execute_plan)

    # -- chat subcommand --
    chat_parser = subparsers.add_parser("chat", help="Start an interactive chat session")
    chat_parser.add_argument("--model", "-m", default="nvidia/nemotron-3-ultra-550b-a55b")
    chat_parser.add_argument("--workspace", "-w", default=".")
    chat_parser.add_argument("--allow-write", action="store_true", default=True)
    chat_parser.add_argument("--allow-shell", action="store_true", default=True)
    chat_parser.add_argument("--lane", default="")
    chat_parser.add_argument("--api-key", default="")
    chat_parser.add_argument("--provider", default="", dest="provider_name")
    chat_parser.add_argument("--base-url", default="")
    chat_parser.add_argument("--trace", action=argparse.BooleanOptionalAction, default=True,
                             help="Show live thinking and activity updates (default: on)")
    chat_parser.add_argument("--permission-mode", choices=["default", "accept-edits", "plan"], default="accept-edits",
                             help="accept-edits writes files directly (default); default asks first; plan is read-only")
    chat_parser.add_argument("--mode", default="code", choices=["plan", "code", "debug", "ask", "brainstorm"],
                             help="Starting agent mode (can be changed mid-chat with /plan, /code, etc.)")
    chat_parser.add_argument("--max-turns", type=int, default=50, help="Max agent turns per request (default: 50)")
    chat_parser.add_argument("--plan-gate", action=argparse.BooleanOptionalAction, default=False,
                             help="Pause after the agent writes a multi-step plan and await approval (default: off — planning flows straight into implementation)")
    chat_parser.set_defaults(func=_cmd_chat)

    args = parser.parse_args(argv)

    if args.command is None:
        parser.print_help()
        return 0

    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
