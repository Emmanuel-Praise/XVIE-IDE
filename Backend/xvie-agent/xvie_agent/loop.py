"""High-level agent entry point — the ``run_agent()`` function.

Wires together context discovery, system prompt building, tool registry,
and the :class:`AgentLoop` orchestrator into a single call.

This is what the CLI ``xvie-agent run`` invokes.
"""

from __future__ import annotations

import logging
import os
import re
import time
import json
from dataclasses import replace
from pathlib import Path
from typing import Callable

from dotenv import load_dotenv

from xvie_agent.agent import AgentLoop
from xvie_agent.context import build_context_snapshot, discover_memory_files
from xvie_agent.design_guidance import DESIGN_PRINCIPLES, inject_design_principles, prompt_needs_design_guidance, scan_project_tokens, build_discovery_context
from xvie_agent.prompting import build_plan_compliance_nudge, build_system_prompt, build_mode_system_prompt
from xvie_agent.providers.base import ProviderClient, ProviderConfig
from xvie_agent.providers.registry import load_providers_from_env
from xvie_agent.router import ModelRouter, RoutingPolicy, classify_task, load_routing_config
from xvie_agent.session import SessionState
from xvie_agent.store import archive_session, save_session
from xvie_agent.token_budget import estimate_messages_tokens
from xvie_agent.tools import ToolContext, build_default_registry
from xvie_agent.types import AgentEvent, AgentRunResult, BudgetConfig, ToolCall, UsageStats
from xvie_agent.modes import get_mode, ModeConfig
from xvie_agent.workflow import classify_workflow
from xvie_agent.execution import (
    ExecutionPhase,
    PermissionMode,
    TaskExecutionState,
    bounded_inventory,
    build_relevant_context,
    collect_design_warnings,
    detect_verification_command,
    is_website_task,
    run_verification,
    validate_changed_file,
    validate_cross_file_consistency,
    validate_layout_pair,
    validate_responsive_render,
)

logger = logging.getLogger(__name__)


def _resolve_provider(
    *,
    api_key: str = "",
    provider_name: str = "",
    base_url: str = "",
) -> ProviderConfig | None:
    """Resolve provider credentials from explicit args or env vars.

    Priority:
    1. Explicit arguments (api_key + provider_name + base_url)
    2. ``FORGE_PROVIDER_<NAME>_*`` env vars
    3. Legacy ``NVIDIA_API_KEY`` / ``OPENROUTER_API_KEY`` env vars

    Returns a ``ProviderConfig`` or ``None`` if nothing is configured.
    """
    load_dotenv()

    # --- 1. Explicit arguments ---
    if api_key:
        if not provider_name:
            if api_key.startswith("nvapi-"):
                provider_name = "nvidia"
            elif api_key.startswith("sk-or-"):
                provider_name = "openrouter"
            else:
                provider_name = "custom"
        if not base_url:
            from xvie_agent.providers.base import _KNOWN_DEFAULTS
            base_url = _KNOWN_DEFAULTS.get(
                provider_name,
                os.getenv("FORGE_CUSTOM_BASE_URL", "https://api.openai.com/v1"),
            )
        return ProviderConfig(name=provider_name, api_key=api_key, base_url=base_url)

    # --- 2. FORGE_PROVIDER_<NAME>_* env vars ---
    prefix = "FORGE_PROVIDER_"
    env_providers: dict[str, ProviderConfig] = {}
    for key, value in os.environ.items():
        if not key.startswith(prefix) or not key.endswith("_API_KEY") or not value:
            continue
        name = key[len(prefix):-len("_API_KEY")].lower()
        base_url_key = f"{prefix}{name.upper()}_BASE_URL"
        env_base_url = os.getenv(base_url_key, "")
        if env_base_url:
            env_providers[name] = ProviderConfig(
                name=name, api_key=value, base_url=env_base_url,
            )

    if env_providers:
        default_name = os.getenv("FORGE_DEFAULT_PROVIDER", "")
        if default_name and default_name.lower() in env_providers:
            return env_providers[default_name.lower()]
        return next(iter(env_providers.values()))

    # --- 3. Legacy fallback ---
    nvidia_key = os.getenv("NVIDIA_API_KEY", "")
    nvidia_url = os.getenv("NVIDIA_BASE_URL", "")
    if nvidia_key and nvidia_url:
        return ProviderConfig(name="nvidia", api_key=nvidia_key, base_url=nvidia_url)

    or_key = os.getenv("OPENROUTER_API_KEY", "")
    if or_key:
        return ProviderConfig(
            name="openrouter", api_key=or_key,
            base_url="https://openrouter.ai/api/v1",
        )

    return None


def run_agent(
    prompt: str,
    model: str,
    workspace_root: Path,
    *,
    provider: ProviderClient | None = None,
    allow_write: bool = False,
    allow_shell: bool = False,
    budget: BudgetConfig | None = None,
    max_turns: int = 50,
    api_key: str = "",
    provider_name: str = "",
    base_url: str = "",
    system_prompt: str | None = None,
    command_timeout: int = 30,
    context_window: int = 131_072,
    existing_session: SessionState | None = None,
    sessions_dir: Path | None = None,
    lane: str | None = None,
    router: ModelRouter | None = None,
    thinking: bool = False,
    mode: str = "act",
    event_callback: Callable[[AgentEvent], None] | None = None,
    approval_callback: Callable[[str], bool] | None = None,
    question_callback: Callable[[list[dict]], list[dict] | None] | None = None,
    write_approved: bool = False,
    require_write_confirmation: bool = True,
    permission_mode: str = PermissionMode.DEFAULT,
    plan_gate: bool = False,
    cancel_event=None,
    _context_rollover_attempted: bool = False,
) -> AgentRunResult:
    """Run the agent loop end-to-end.

    This is the main entry point for both the CLI and programmatic usage.

    You can supply a ``provider`` (a pre-built :class:`ProviderClient`)
    directly — this is the preferred path for the CLI and any caller that
    already has a client.  Alternatively, pass ``api_key`` /
    ``provider_name`` / ``base_url`` and this function will resolve and
    build one internally.

    Args:
        prompt: The user's request.
        model: Model slug as the provider names it.
        workspace_root: Path to the project directory.
        provider: Pre-built provider client (preferred).  If ``None``,
            one is constructed from the other arguments.
        allow_write: Whether the agent can write/edit files.
        allow_shell: Whether the agent can run shell commands.
        budget: Token/turn budget constraints.
        max_turns: Maximum orchestrator iterations.
        api_key: Provider API key (used only when ``provider`` is ``None``).
        provider_name: Provider name (used only when ``provider`` is ``None``).
        base_url: Provider base URL (used only when ``provider`` is ``None``).
        system_prompt: Override the auto-generated system prompt.
        command_timeout: Timeout for bash commands in seconds.
        context_window: Model's context window size in tokens.
        plan_gate: When True, the run pauses after a multi-step write_plan so
            the user can review it and approve before implementation starts.

    Returns:
        An :class:`AgentRunResult` with the final answer and metadata.
    """
    workspace_root = workspace_root.resolve()
    own_client = False

    # `--permission-mode plan` (and `/permissions plan`) force the entire run
    # into read-only planning mode — identical to the /plan chat command.
    if permission_mode == "plan":
        mode = "plan"
        allow_write = False
        allow_shell = False

    # -- Resolve mode configuration --
    mode_config = get_mode(mode)
    # Mode overrides: allow_write and allow_shell are clamped by the mode
    effective_allow_write = allow_write and mode_config.allow_write
    effective_allow_shell = allow_shell and mode_config.allow_shell
    # Read-only modes (plan/ask/brainstorm) expose inspection tools only.
    read_only_mode = not mode_config.allow_write and not mode_config.allow_shell

    # -- Build provider if not supplied --
    if provider is not None:
        client = provider
    else:
        config = _resolve_provider(
            api_key=api_key,
            provider_name=provider_name,
            base_url=base_url,
        )
        if config is None:
            return AgentRunResult(
                final_output=(
                    "Error: No provider API key configured. "
                    "Set FORGE_PROVIDER_<NAME>_API_KEY and FORGE_PROVIDER_<NAME>_BASE_URL "
                    "in your environment or .env file."
                ),
                turns=0,
                tool_calls=(),
                usage=UsageStats(),
                stop_reason="config_error",
            )
        client = ProviderClient(config=config)
        own_client = True

    # -- Context discovery --
    context_prep_started = time.monotonic()
    # Emit immediately so the spinner paints during disk/git probing
    # instead of a blank "Working…" gap before the first token.
    if event_callback:
        event_callback(AgentEvent("understanding_task", "Understanding the request"))
    memory = discover_memory_files(workspace_root)
    context_snapshot = build_context_snapshot(workspace_root)

    # -- Tool registry (mode-aware permissions) --
    tool_ctx = ToolContext(
        workspace_root=workspace_root,
        allow_write=effective_allow_write,
        allow_shell=effective_allow_shell,
        command_timeout_seconds=command_timeout,
        provider_client=client,
        model_name=os.getenv("XVIE_VISION_MODEL", "").strip() or model,
    )
    tools = build_default_registry(tool_ctx, allow_web=mode_config.allow_web_search)

    # -- Read-only modes: filter to inspection tools only --
    # Done BEFORE the system prompt is built so the prompt's tool list and
    # guidance never advertise write/shell tools the model cannot use.  A model
    # that is told "Tools: write_file, edit_file, bash" but handed a schema
    # without them will keep trying phantom write tools and derail.
    if read_only_mode:
        read_tool_set = set(mode_config.tools_always_on)
        # Web tools stay available in brainstorm mode.
        if mode_config.allow_web_search:
            read_tool_set |= {"web_search", "web_fetch"}
        # Plan-tracking tools in plan mode (tracking, not code generation).
        if mode == "plan":
            read_tool_set |= {"mark_task_done", "write_plan"}
        # Read-only design tools in plan mode: reference lookup, contrast
        # math, and file validation are pure reads — planning can reference
        # recipes and pre-check design without writing anything.
        if mode == "plan":
            read_tool_set |= {"read_ui_reference", "check_contrast", "verify_file"}
            if mode_config.allow_web_search:
                read_tool_set |= {"search_images"}
        tools = {k: v for k, v in tools.items() if k in read_tool_set}
        tool_ctx = ToolContext(
            workspace_root=workspace_root,
            allow_write=False,
            allow_shell=False,
            command_timeout_seconds=command_timeout,
        )

    # -- System prompt --
    if system_prompt is None:
        system_prompt = build_system_prompt(
            memory=memory,
            context_snapshot=context_snapshot,
            tool_names=sorted(tools.keys()),
            read_only=read_only_mode,
        )

    # -- Inject mode-specific instructions --
    mode_prompt = build_mode_system_prompt(mode)
    if mode_prompt:
        system_prompt += "\n\n" + mode_prompt

    workflow = classify_workflow(prompt)
    _explicit_lane = lane is not None
    if lane is None:
        lane = workflow.lane

    # -- Mode lane override: modes can force a specific routing lane --
    if mode_config.lane_override:
        lane = mode_config.lane_override

    # -- Auto-use design settings: UI prompts run on the ui_design lane --
    # Explicit --lane and mode overrides still win; otherwise a website
    # request automatically gets the design lane's models/temperature.
    if (
        not _explicit_lane
        and not mode_config.lane_override
        and lane != "ui_design"
        and prompt_needs_design_guidance(prompt)
    ):
        lane = "ui_design"

    # -- Inject design system for UI/web tasks --
    # Covers both the ui_design lane AND any prompt mentioning UI keywords.
    # Layer 1: Core taste (system-prompt-core.md + routing-table.md)
    # Layer 2: Per-request references via the design router
    # Layer 3: Discovery — project scan / Quick Ask
    _design_routed = None
    _needs_design = prompt_needs_design_guidance(prompt) or (lane or "") == "ui_design"
    if _needs_design:
        try:
            from xvie_agent.design_router import load_references
            _design_routed = load_references(prompt, limit=2)
        except ImportError:
            pass
    system_prompt = inject_design_principles(
        system_prompt, lane or "", prompt,
        workspace_root=workspace_root,
        routed=_design_routed,
    )
    # If out of scope (React Native, HTML email, etc.), surface the warning
    if _design_routed and _design_routed.get("out_of_scope"):
        oos_labels = ", ".join(o.get("label", "") for o in _design_routed["out_of_scope"])
        if event_callback:
            event_callback(AgentEvent(
                kind="design_out_of_scope",
                message=f"Out of scope: {oos_labels}. These references cover web surfaces only.",
            ))
    # -- Advisory design self-review (warn-only, never blocks) --
    # Website tasks get a second-pass checklist appended to the prompt.
    # The model reports findings; nothing here fails verification.
    if _needs_design:
        system_prompt += (
            "\n\n<design-self-review>Before finishing, check that the page "
            "matches the brief, has clear hierarchy, responsive behavior, "
            "accessible contrast and focus, and no placeholder content. Fix "
            "concrete issues only; do not add sections to satisfy a generic "
            "checklist.</design-self-review>"
        )

    # -- Read-only modes: filter to inspection tools only --
    # (Handled above, before the system prompt is built.)

    # -- Session --
    if existing_session is not None:
        session = existing_session
    else:
        session = SessionState(system_prompt=system_prompt)
    # Always refresh: the rebuilt prompt carries fresh workspace inventory,
    # project context, and mode instructions.  Reusing the stale first-turn
    # prompt left later turns running blind (a major off-topic cause).
    session.system_prompt = system_prompt
    state = TaskExecutionState.from_dict(session.execution_state)
    if write_approved and state and state.phase == ExecutionPhase.AWAITING_APPROVAL:
        state.approved = True
        state.phase = ExecutionPhase.IMPLEMENT
        if state.proposed_plan:
            # The plan was already written and the user approved it — hand the
            # plan back explicitly so the model continues it instead of
            # re-planning from scratch.
            prompt = (
                "The user approved your plan. Do NOT re-plan from scratch — "
                "implement the approved plan now, step by step, calling "
                "mark_task_done after each step.\n\n"
                "<approved-plan>\n" + state.proposed_plan + "\n</approved-plan>"
            )
        else:
            prompt = state.prompt
    elif state is None or state.final_outcome:
        state = TaskExecutionState(task_kind=workflow.kind, prompt=prompt)

    # Always give the model a bounded map of the workspace — every task
    # benefits from knowing what files exist, and it costs no model calls.
    # Emit BEFORE the walk so the spinner paints instantly, not after.
    if not state.inspected_files:
        if event_callback:
            event_callback(AgentEvent("inspecting", "Inspecting the workspace…"))
        state.inspected_files = bounded_inventory(workspace_root)
        if event_callback:
            event_callback(AgentEvent("inspecting", "Collected workspace inventory", {"files": len(state.inspected_files)}))
    if state.inspected_files:
        system_prompt += "\n\n<workspace-inventory>\n" + "\n".join(state.inspected_files) + "\n</workspace-inventory>"

    # Give the model high-signal project context up front (README, manifest,
    # and files named in the prompt) — no model calls, big codegen boost.
    relevant_context = build_relevant_context(workspace_root, prompt)
    if relevant_context.strip():
        system_prompt += "\n\n<project-context>\n" + relevant_context + "\n</project-context>"

    mode = PermissionMode(permission_mode)
    writes_allowed = mode == PermissionMode.ACCEPT_EDITS or write_approved
    # Mode constraint: even if writes are approved, modes that disallow
    # write (plan, ask, brainstorm) will block them via effective_allow_write
    writes_allowed = writes_allowed and mode_config.allow_write
    approval_required_tools: set[str] = set()
    if mode == PermissionMode.ACCEPT_EDITS or write_approved:
        approval_required_tools = {"bash", "run_code"}
    elif workflow.needs_write_confirmation:
        approval_required_tools = {"write_file", "edit_file", "append_file", "apply_patch", "move_file", "delete_file", "bash", "run_code"}
    if mode == PermissionMode.PLAN:
        mode = "plan"
    # Hard guarantee: in accept-edits mode file writes NEVER ask — not even
    # if a future edit adds them above by mistake.
    if mode == PermissionMode.ACCEPT_EDITS or write_approved:
        approval_required_tools -= {"write_file", "edit_file", "append_file", "apply_patch", "move_file", "delete_file"}
    # Read-only modes (plan/ask/brainstorm) never reach this branch — their
    # write tools are filtered out entirely, so promising them "write tools are
    # visible" would be a lie and would cause phantom-write attempts.
    if workflow.needs_write_confirmation and not writes_allowed and not read_only_mode:
        system_prompt += "\n\nThis is the investigation and planning pass. Investigate first, then return a concrete implementation plan for approval. Write tools are registered for planning context but execution is blocked until approval; never claim files were changed."
        if event_callback:
            event_callback(AgentEvent("planning", "Investigating and preparing an implementation plan", {}))
    prior_messages = session.to_openai_messages()
    user_turns = sum(1 for message in session.messages if message.role == "user")
    compaction_threshold = max(500, int(context_window * 0.7))
    if user_turns > 4 and estimate_messages_tokens(prior_messages) > compaction_threshold:
        archive_session(session, sessions_dir or (workspace_root / ".xvie-sessions"))
        if session.compact_for_resume(keep_last_n_turns=4):
            if event_callback:
                event_callback(AgentEvent(
                    "context_compacted",
                    "Compacted older conversation turns to keep this chat going",
                    {"summary": session.context_summary},
                ))
    session.append_user(prompt)
    history = session.to_openai_messages()[1:-1]

    # -- Router (if lane specified) --
    active_router = router
    active_lane = lane
    if active_lane and active_router is None:
        # Auto-build router from env providers + routing.yaml
        from xvie_agent.providers.registry import load_providers_from_env as _load_provs
        all_providers = _load_provs()
        # Do not silently replace an injected test/custom client with an
        # environment provider. Real CLI clients are registered by name.
        if all_providers and (provider is None or client.provider_name in all_providers):
            routing_policy = load_routing_config()
            active_router = ModelRouter(
                providers=all_providers,
                policy=routing_policy,
                cancel_event=cancel_event,
                on_rate_limit_wait=lambda msg: event_callback(
                    AgentEvent(kind="rate_limit_wait", message=msg, data={
                        "retry_in": int(re.search(r"(?:waiting|in) (\d+)s", msg).group(1))
                    } if re.search(r"(?:waiting|in) (\d+)s", msg) else {})
                ) if event_callback else None,
            )
            # Pick a model from the lane's first entry for context_window
            try:
                lane_specs = routing_policy.get_lane(active_lane)
                if lane_specs:
                    model = lane_specs[0].id
                    context_window = lane_specs[0].context_window
            except KeyError:
                pass

    # -- Inject plan-compliance nudge for weak/unknown models ---
    # Look up the model's plan_compliance from the routing config if available.
    plan_compliance_level = "unknown"  # default: always inject the nudge
    if active_lane and active_router:
        try:
            lane_specs = active_router._policy.get_lane(active_lane)
            if lane_specs:
                plan_compliance_level = lane_specs[0].plan_compliance
        except (KeyError, AttributeError):
            pass
    compliance_nudge = build_plan_compliance_nudge(plan_compliance_level)
    # Never inject the plan-compliance nudge in read-only modes — it orders
    # write_file/edit_file usage, which is exactly the phantom-write behavior
    # read-only sessions must avoid.
    if compliance_nudge and not read_only_mode:
        system_prompt += "\n\n" + compliance_nudge
        # Refresh session prompt with the nudge
        session.system_prompt = system_prompt

    context_prep_seconds = time.monotonic() - context_prep_started

    # -- Loop --
    try:
        loop = AgentLoop(
            client=client,
            model=model,
            tools=tools,
            tool_ctx=tool_ctx,
            budget=budget or BudgetConfig(max_turns=max_turns),
            system_prompt=system_prompt,
            context_window=context_window,
            router=active_router,
            lane=active_lane,
            thinking=thinking,
            event_callback=event_callback,
            history=history,
            write_approved=write_approved,
            confirmation_required=bool(approval_required_tools),
            approval_required_tools=approval_required_tools,
            rich_html_validation=is_website_task(prompt),
            approval_callback=approval_callback,
            read_only=read_only_mode,
            plan_gate=plan_gate,
            cancel_event=cancel_event,
            context_prep_seconds=context_prep_seconds,
            question_callback=question_callback,
        )
        result = loop.run(prompt)
    finally:
        if own_client:
            client.close()

    changed: list[str] = []
    for tc in result.tool_calls:
        if tc.name in {"write_file", "edit_file", "append_file", "move_file", "delete_file"}:
            p = tc.arguments.get("path", "") if isinstance(tc.arguments, dict) else ""
            if p:
                changed.append(str(p))
        elif tc.name == "apply_patch" and isinstance(tc.arguments, dict):
            entries = tc.arguments.get("files", [])
            for entry in entries if isinstance(entries, list) else []:
                p = entry.get("path") if isinstance(entry, dict) else None
                if p:
                    changed.append(str(p))
    state.changed_files.extend(path for path in changed if path and path not in state.changed_files)
    # Website artifacts get the strict quality check (viewport, header/main/
    # footer, substantial content) so shallow stubs are rejected and repaired.
    rich_html = is_website_task(prompt)
    # Pause the workflow after the plan when:
    #   - the plan-gate run returned awaiting_approval (multi-step plan saved,
    #     no files written yet), OR
    #   - the default permission flow produced a plan as text (no writes were
    #     allowed, so the run finished without touching files).
    _plan_pause = (
        not read_only_mode
        and (
            result.stop_reason == "awaiting_approval"
            or (
                workflow.needs_write_confirmation
                and not writes_allowed
                and result.stop_reason == "completed"
            )
        )
    )
    if _plan_pause:
        state.phase = ExecutionPhase.AWAITING_APPROVAL
        state.proposed_plan = result.final_output or state.proposed_plan
        result = replace(result, stop_reason="awaiting_approval", confirmation_required=True, verification_outcome="not_run")
        if event_callback:
            event_callback(AgentEvent("awaiting_confirmation", "Plan is ready; approve to implement it", {}))
    elif state.changed_files:
        state.phase = ExecutionPhase.VERIFY
        artifact_errors = [
            error for path in state.changed_files
            if (error := validate_changed_file(path, workspace_root, rich_html=rich_html))
        ]
        if not artifact_errors and rich_html:
            for path in state.changed_files:
                if path.lower().endswith((".html", ".htm")):
                    render_error = validate_responsive_render(path, workspace_root)
                    if render_error:
                        artifact_errors.append(render_error)
        # Cross-file consistency check for HTML/CSS pairs
        if not artifact_errors and rich_html:
            cross_error = validate_cross_file_consistency(workspace_root, state.changed_files)
            if cross_error:
                artifact_errors.append(cross_error)
        # Pair-wise layout check (closes the in-loop-only gap: pair failures
        # re-broken after loop exit, or written via apply_patch, are caught here)
        if not artifact_errors and rich_html:
            html_paths = [p for p in state.changed_files if p.endswith(('.html', '.htm'))]
            css_paths = [p for p in state.changed_files if p.endswith('.css')]
            for html_path in html_paths:
                html_target = (workspace_root / html_path).resolve()
                if not html_target.exists():
                    continue
                try:
                    html_content = html_target.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                for css_path in css_paths:
                    css_target = (workspace_root / css_path).resolve()
                    if not css_target.exists():
                        continue
                    try:
                        css_content = css_target.read_text(encoding="utf-8", errors="replace")
                    except OSError:
                        continue
                    layout_error = validate_layout_pair(html_content, css_content, html_path)
                    if layout_error:
                        artifact_errors.append(layout_error)
        # Advisory design warnings — surfaced, never blocking.
        design_warnings: list[str] = []
        if rich_html:
            for path in state.changed_files:
                if path.endswith(('.html', '.htm', '.css')):
                    design_warnings.extend(collect_design_warnings(workspace_root, path))
        if artifact_errors:
            state.verification_output = "\n".join(artifact_errors)
            state.verification_outcome = "failed"
            logger.warning("Artifact validation failed: %s", state.verification_output)
            result = replace(
                result,
                final_output=(
                    result.final_output
                    + "\n\nI couldn't finish validating the generated files. "
                    "Your changes are saved; resume this session to continue."
                ),
                verification_outcome="failed",
                stop_reason="verification_failed",
            )
        else:
            # Only run test-suite verification when code files changed —
            # running pytest after editing an HTML page wastes time.
            _non_testable = {".html", ".htm", ".css", ".md", ".txt"}
            testable = [
                p for p in state.changed_files
                if Path(p).suffix.lower() not in _non_testable
            ]
            state.verification_command = detect_verification_command(workspace_root) if testable else ""
        if not artifact_errors and state.verification_command and effective_allow_shell:
            if event_callback:
                event_callback(AgentEvent("verifying", f"Running {state.verification_command}", {}))
            passed, output = run_verification(state.verification_command, workspace_root, command_timeout)
            state.verification_output = output
            state.verification_outcome = "passed" if passed else "failed"
            suffix = "\n\nVerification passed." if passed else f"\n\nVerification failed:\n{output}"
            result = replace(result, final_output=result.final_output + suffix, verification_outcome=state.verification_outcome, stop_reason="completed" if passed else "verification_failed")
        elif not artifact_errors:
            state.verification_outcome = "not_available"
            result = replace(result, verification_outcome="not_available")
        if not artifact_errors and design_warnings:
            seen = list(dict.fromkeys(design_warnings))[:10]
            warn_block = "\n\nDesign warnings (advisory — do not block):\n" + "\n".join(f"  - {w}" for w in seen)
            state.verification_output = (state.verification_output + warn_block) if state.verification_output else warn_block.lstrip("\n")
            result = replace(result, final_output=result.final_output + warn_block)
        state.phase = ExecutionPhase.REPORT
        state.final_outcome = result.stop_reason
    elif result.stop_reason == "completed":
        state.phase = ExecutionPhase.REPORT
        state.final_outcome = "completed"

    # Persist a stop reason even when no file was changed; a linked rollover
    # session needs to know whether the prior run completed or paused.
    state.final_outcome = result.stop_reason
    session.execution_state = state.to_dict()

    # Persist the actual transcript from this turn, not an empty shell.
    for message in result.transcript[len(history) + 2:]:
        role = message.get("role")
        if role == "assistant":
            calls = [
                ToolCall(id=raw["id"], name=raw["function"]["name"], arguments=json.loads(raw["function"]["arguments"]))
                for raw in message.get("tool_calls", [])
            ] or None
            session.append_assistant(message.get("content", ""), calls, reasoning=message.get("reasoning"))
        elif role == "tool":
            session.append_tool_result(message.get("tool_call_id", ""), message.get("content", ""))

    # -- Auto-save session --
    if sessions_dir is None:
        sessions_dir = workspace_root / ".xvie-sessions"
    save_session(session, sessions_dir)

    # One bounded fresh-session retry handles providers that still reject a
    # compacted in-place context. The old session remains saved and the new
    # session records its parent for continuity and user-visible resumption.
    if result.stop_reason == "payload_too_large" and not _context_rollover_attempted:
        summary = session.summary_for_fresh_context()
        fresh_session = SessionState(
            system_prompt=system_prompt,
            context_summary=summary or "Continue the current request from a fresh context. Inspect workspace files to recover exact state.",
            parent_session_id=session.session_id,
            visible_thoughts=session.visible_thoughts,
        )
        resumed = run_agent(
            prompt=prompt,
            model=model,
            workspace_root=workspace_root,
            provider=None if own_client else client,
            allow_write=allow_write,
            allow_shell=allow_shell,
            budget=budget,
            max_turns=max_turns,
            api_key=api_key,
            provider_name=provider_name,
            base_url=base_url,
            system_prompt=system_prompt,
            command_timeout=command_timeout,
            context_window=context_window,
            existing_session=fresh_session,
            sessions_dir=sessions_dir,
            lane=lane,
            router=router,
            thinking=thinking,
            mode=mode,
            event_callback=event_callback,
            approval_callback=approval_callback,
            write_approved=write_approved,
            require_write_confirmation=require_write_confirmation,
            permission_mode=permission_mode,
            plan_gate=plan_gate,
            cancel_event=cancel_event,
            question_callback=question_callback,
            _context_rollover_attempted=True,
        )
        if resumed.session_id:
            return replace(
                resumed,
                final_output=(resumed.final_output or "Task continued.")
                + f"\n\nContinued in linked session {resumed.session_id}.",
            )

    return replace(result, session_id=session.session_id)
