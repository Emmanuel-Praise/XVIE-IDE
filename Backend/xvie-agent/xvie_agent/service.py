"""Authenticated local HTTP bridge used by the Xvie desktop application."""

from __future__ import annotations

import os
import re
import secrets
import threading
import time
import uuid
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from pydantic import BaseModel, Field
from dotenv import load_dotenv

from xvie_agent.loop import run_agent
from xvie_agent.agent import _is_small_talk
from xvie_agent.providers.base import ProviderClient, ProviderConfig
from xvie_agent.providers.registry import load_providers_from_env
from xvie_agent.session import SessionState
from xvie_agent.store import list_sessions, load_session, save_session
from xvie_agent.types import AgentEvent, AgentRunResult, UsageStats
from xvie_agent.tools import search_commons_images


class RunRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=100_000)
    workspace_root: str
    session_id: str | None = None
    model: str = ""
    provider_name: str = ""
    api_key: str = ""
    base_url: str = ""
    mode: str = "code"
    allow_write: bool = True
    allow_shell: bool = True
    write_approved: bool = False
    permission_mode: str = "default"
    max_turns: int = Field(default=50, ge=1, le=200)


class AnswerQuestionsRequest(BaseModel):
    answers: list[dict[str, Any]] = Field(default_factory=list, max_length=4)


class ImageSearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=200)
    per_page: int = Field(default=6, ge=1, le=15)


@dataclass
class RunState:
    session_id: str
    workspace_root: Path
    events: list[dict[str, Any]] = field(default_factory=list)
    running: bool = True
    awaiting_plan: bool = False
    approval: threading.Event = field(default_factory=threading.Event)
    approval_granted: bool = False
    cancelled: threading.Event = field(default_factory=threading.Event)
    session_thoughts: list[dict[str, Any]] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)
    pending_questions: list[dict[str, Any]] = field(default_factory=list)
    awaiting_questions: bool = False
    question_event: threading.Event = field(default_factory=threading.Event)
    question_answers: list[dict[str, Any]] | None = None

    def emit(self, kind: str, **data: Any) -> None:
        with self.lock:
            self.events.append({"id": len(self.events), "type": kind, **data})


app = FastAPI(title="Xvie Agent Service", docs_url=None, redoc_url=None)
_runs: dict[str, RunState] = {}
_runs_lock = threading.Lock()


_CHANGE_ACTION = (
    r"add|apply|build|change|create|delete|design|edit|fix|implement|install|"
    r"modify|move|refactor|remove|replace|save|update|upgrade|write|wire|"
    r"connect|integrate|generate"
)
_CHANGE_REQUEST = re.compile(
    # Direct commands, including common save-to-file wording.
    rf"^\s*(?:please\s+)?(?:(?:just|simply|now)\s+)?(?:{_CHANGE_ACTION})\b"
    # Action intent can appear after context in a long, natural-language
    # request (for example, "I want help ... please help me edit it").
    rf"|\b(?:i\s+want\s+you\s+to|i\s+need\s+you\s+to|please\s+help\s+me|"
    rf"help\s+me|go\s+ahead\s+and|let(?:'s|\s+us))\b"
    rf"(?:(?![.!?]).){{0,180}}?\b(?:{_CHANGE_ACTION})\b",
    # Polite direct commands are actionable; explanatory/how-to questions
    # that merely mention editing remain read-only.
    re.IGNORECASE | re.DOTALL,
)
_POLITE_DIRECT_CHANGE_REQUEST = re.compile(
    rf"\b(?:can|could|would)\s+you\s+(?:please\s+)?(?:{_CHANGE_ACTION})\b",
    re.IGNORECASE | re.DOTALL,
)
_PLAN_CONTINUATION_REQUEST = re.compile(
    r"^\s*(?:please\s+)?(?:continue|resume|proceed|carry\s+on)\b"
    r"(?:(?![.!?]).){0,120}\bplan\b"
    r"|\b(?:can|could|would)\s+you\s+(?:please\s+)?"
    r"(?:continue|resume|proceed|carry\s+on)\b"
    r"(?:(?![.!?]).){0,120}\bplan\b",
    re.IGNORECASE | re.DOTALL,
)


def _effective_mode(request: RunRequest) -> str:
    """Pass the UI mode through; the model decides whether tools are needed.

    Previous regex demotion (code/debug -> ask when no edit verb found) made
    questions like "what do you think of X here" run read-only without the
    model ever choosing. Mode now only clamps permissions downstream
    (effective_allow_write/shell + read-only tool filter), never the
    prompt shape or routing.
    """
    if request.permission_mode == "plan" or request.mode == "plan":
        return "plan"
    return request.mode


def _authorize(authorization: str | None = Header(default=None)) -> None:
    expected = os.environ.get("XVIE_AGENT_TOKEN", "")
    supplied = authorization.removeprefix("Bearer ") if authorization else ""
    if not expected or not secrets.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="Unauthorized agent service request.")


def _workspace(path: str) -> Path:
    root = Path(path).expanduser().resolve()
    if not root.is_dir():
        raise HTTPException(status_code=400, detail="The selected workspace folder is unavailable.")
    return root


def _session_directory(root: Path) -> Path:
    return root / ".xvie-sessions"


def _session_summary(session: SessionState) -> dict[str, Any]:
    last_user = next((m.content for m in reversed(session.messages) if m.role == "user"), "")
    return {
        "session_id": session.session_id,
        "created_at": session.created_at,
        "updated_at": session.updated_at,
        "message_count": len(session.messages),
        "last_user_message": last_user[:120],
        "execution_state": session.execution_state,
        "context_summary": session.context_summary,
        "visible_thoughts": session.visible_thoughts,
        "messages": [SessionState._msg_to_dict(m) for m in session.messages],
    }


def _run_state_or_restore(session_id: str, workspace_root: str | None) -> RunState | None:
    with _runs_lock:
        state = _runs.get(session_id)
    if state or not workspace_root:
        return state
    try:
        root = _workspace(workspace_root)
        session = load_session(session_id, _session_directory(root))
    except (HTTPException, FileNotFoundError):
        return None
    execution = session.execution_state or {}
    if execution.get("phase") != "awaiting_approval":
        return None
    restored = RunState(session_id=session_id, workspace_root=root, running=False, awaiting_plan=True)
    with _runs_lock:
        return _runs.setdefault(session_id, restored)


def _launch_run(state: RunState, request: RunRequest, *, approve_plan: bool = False) -> None:
    def event_callback(event: AgentEvent) -> None:
        if event.kind == "awaiting_confirmation" and event.data.get("plan_gate"):
            state.awaiting_plan = True
        if event.kind == "thought":
            state.session_thoughts.append({"text": event.message, "timestamp": datetime.now(timezone.utc).isoformat(), **event.data})
        if event.kind == "question_required":
            with state.lock:
                state.pending_questions = list(event.data.get("questions", []) or [])
                state.awaiting_questions = True
        state.emit("activity", event={"kind": event.kind, "message": event.message, "data": event.data})

    def approval_callback(description: str) -> bool:
        state.emit("approval_required", description=description, session_id=state.session_id)
        while not state.cancelled.is_set():
            if state.approval.wait(0.2):
                state.approval.clear()
                granted = state.approval_granted
                state.approval_granted = False
                return granted
        return False

    def question_callback(questions: list[dict]) -> list[dict] | None:
        with state.lock:
            state.pending_questions = list(questions)
            state.awaiting_questions = True
            state.question_answers = None
            state.question_event.clear()
        state.emit("question_required", questions=questions, session_id=state.session_id)
        while not state.cancelled.is_set():
            if state.question_event.wait(0.2):
                state.question_event.clear()
                with state.lock:
                    answers = state.question_answers
                    state.question_answers = None
                    state.awaiting_questions = False
                    state.pending_questions = []
                return answers
        with state.lock:
            state.awaiting_questions = False
            state.pending_questions = []
        return None

    def worker() -> None:
        try:
            load_dotenv()
            # Bound a stalled model response in the desktop app and keep one
            # quick retry for transient provider/network failures.
            os.environ.setdefault("XVIE_PROVIDER_TIMEOUT", "45")
            os.environ.setdefault("XVIE_RETRY_MAX", "1")
            root = state.workspace_root
            existing = None
            if request.session_id:
                existing = load_session(request.session_id, _session_directory(root))
            else:
                existing = SessionState(session_id=state.session_id)
            state.session_thoughts = existing.visible_thoughts
            provider = None
            if request.api_key:
                if not request.base_url:
                    raise ValueError("A provider base URL is required when an API key is supplied.")
                provider = ProviderClient(config=ProviderConfig(
                    name=request.provider_name or "custom",
                    api_key=request.api_key,
                    base_url=request.base_url,
                ))
            elif request.provider_name:
                provider = load_providers_from_env().get(request.provider_name.lower())

            prompt = request.prompt
            effective_mode = "code" if approve_plan else _effective_mode(request)
            if effective_mode == "ask" and request.mode in {"code", "debug"} and not _is_small_talk(prompt):
                state.emit("activity", event={"kind": "understanding_task", "message": "Answering as a read-only question", "data": {}})
            if approve_plan:
                prompt = "Continue the approved plan. Implement the approved plan now, step by step."
            if _is_small_talk(prompt) and not approve_plan:
                # Greetings should not depend on provider behavior or turn into
                # narrated model scratch work. Save a normal conversation turn.
                answer = "Hi! What would you like to work on?"
                existing.append_user(prompt)
                existing.append_assistant(answer)
                save_session(existing, _session_directory(root))
                result = AgentRunResult(
                    final_output=answer, turns=0, tool_calls=(), usage=UsageStats(),
                    stop_reason="completed", session_id=existing.session_id,
                )
                state.emit("activity", event={"kind": "smalltalk", "message": "Replying to greeting", "data": {}})
            else:
                result = run_agent(
                    prompt=prompt,
                    model=request.model or os.getenv(
                        "DEFAULT_MODEL",
                        os.getenv("FORGE_DEFAULT_MODEL", "nvidia/nemotron-3.5-lightning-30b-a3b"),
                    ),
                    workspace_root=root,
                    provider=provider,
                    allow_write=request.allow_write if effective_mode != "ask" else False,
                    allow_shell=request.allow_shell if effective_mode != "ask" else False,
                    max_turns=request.max_turns,
                    existing_session=existing,
                    sessions_dir=_session_directory(root),
                    mode=effective_mode,
                    permission_mode=request.permission_mode,
                    write_approved=request.write_approved or approve_plan,
                    plan_gate=True,
                    event_callback=event_callback,
                    approval_callback=approval_callback,
                    question_callback=question_callback,
                    cancel_event=state.cancelled,
                )
            state.session_id = result.session_id or state.session_id
            existing.visible_thoughts = state.session_thoughts
            state.awaiting_plan = (
                result.confirmation_required
                or result.stop_reason in {"awaiting_confirmation", "awaiting_approval"}
            )
            usage = asdict(result.usage)
            usage["total_tokens"] = result.usage.total_tokens
            state.emit("completed", result={
                "session_id": state.session_id,
                "final_output": result.final_output,
                "stop_reason": result.stop_reason,
                "turns": result.turns,
                "tool_calls": [asdict(call) for call in result.tool_calls],
                "usage": usage,
                "confirmation_required": result.confirmation_required,
                "verification_outcome": result.verification_outcome,
                "context_summary": existing.context_summary,
                "visible_thoughts": existing.visible_thoughts,
            })
        except Exception as exc:
            state.emit("failed", error=str(exc)[:1000])
        finally:
            state.running = False

    state.running = True
    state.awaiting_plan = False
    state.awaiting_questions = False
    state.pending_questions = []
    state.question_answers = None
    state.question_event.clear()
    threading.Thread(target=worker, daemon=True, name=f"xvie-agent-{state.session_id[:8]}").start()


@app.get("/health")
def health(_: None = Depends(_authorize)) -> dict[str, Any]:
    return {"ok": True, "agent": "xvie-agent", "version": 1}


@app.get("/providers")
def providers(_: None = Depends(_authorize)) -> dict[str, Any]:
    """List configured provider metadata without returning credentials."""
    load_dotenv()
    default_model = os.getenv("DEFAULT_MODEL", os.getenv("FORGE_DEFAULT_MODEL", ""))
    configured = load_providers_from_env()
    return {"providers": [
        {
            "name": name,
            "base_url": client.config.base_url,
            "model": os.getenv("METERLESS_MODEL", "worker") if name == "meterless" else default_model,
            "configured": True,
        }
        for name, client in sorted(configured.items())
    ]}


@app.post("/images/search")
def search_images(request: ImageSearchRequest, _: None = Depends(_authorize)) -> dict[str, Any]:
    """Search Pexels, falling back to Wikimedia Commons if Pexels is unavailable."""
    load_dotenv()
    api_key = os.environ.get("PEXELS_API_KEY", "")
    if not api_key:
        try:
            return {"results": search_commons_images(request.query.strip(), request.per_page)}
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Wikimedia Commons image search failed: {exc}") from exc
    url = "https://api.pexels.com/v1/search?" + urllib.parse.urlencode({
        "query": request.query.strip(), "per_page": request.per_page,
    })
    req = urllib.request.Request(url, headers={"Authorization": api_key})
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            payload = __import__("json").loads(response.read().decode("utf-8"))
    except Exception as exc:
        try:
            return {"results": search_commons_images(request.query.strip(), request.per_page)}
        except Exception as fallback_exc:
            raise HTTPException(
                status_code=502,
                detail=f"Pexels image search failed ({type(exc).__name__}: {exc}); "
                       f"Wikimedia Commons fallback failed ({type(fallback_exc).__name__}: {fallback_exc})",
            ) from fallback_exc
    if not isinstance(payload, dict) or not isinstance(payload.get("photos", []), list):
        payload = {"photos": []}
    results = []
    for photo in payload.get("photos", []):
        if not isinstance(photo, dict):
            continue
        src = photo.get("src") or {}
        if not isinstance(src, dict):
            continue
        hero = src.get("landscape") or src.get("large2x") or src.get("large") or ""
        thumb = src.get("medium") or src.get("small") or ""
        if not hero and not thumb:
            continue
        results.append({
            "alt": photo.get("alt") or request.query.strip(),
            "heroUrl": hero or thumb,
            "thumbnailUrl": thumb or hero,
            "sourceUrl": photo.get("url") or "",
            "photographer": photo.get("photographer") or "Unknown",
            "license": "Pexels License",
            "credit": f"Photo by {photo.get('photographer') or 'Unknown'} on Pexels",
            "width": photo.get("width") or 0,
            "height": photo.get("height") or 0,
        })
    if not results:
        try:
            return {"results": search_commons_images(request.query.strip(), request.per_page)}
        except Exception as exc:
            raise HTTPException(
                status_code=502,
                detail=f"Pexels returned no usable images; Wikimedia Commons fallback failed: {exc}",
            ) from exc
    return {"results": results}


@app.get("/sessions")
def sessions(workspace_root: str = Query(...), _: None = Depends(_authorize)) -> dict[str, Any]:
    root = _workspace(workspace_root)
    summaries = list_sessions(_session_directory(root))
    return {"sessions": summaries}


@app.get("/sessions/{session_id}")
def get_session(session_id: str, workspace_root: str = Query(...), _: None = Depends(_authorize)) -> dict[str, Any]:
    root = _workspace(workspace_root)
    try:
        return _session_summary(load_session(session_id, _session_directory(root)))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Agent session was not found.") from None


@app.post("/runs")
def start_run(request: RunRequest, _: None = Depends(_authorize)) -> dict[str, Any]:
    root = _workspace(request.workspace_root)
    session_id = request.session_id or str(uuid.uuid4())
    with _runs_lock:
        current = _runs.get(session_id)
        if current and current.running:
            raise HTTPException(status_code=409, detail="This session is already running.")
        state = current or RunState(session_id=session_id, workspace_root=root)
        state.workspace_root = root
        state.events = []
        state.cancelled.clear()
        state.awaiting_questions = False
        state.pending_questions = []
        state.question_answers = None
        state.question_event.clear()
        _runs[session_id] = state
    _launch_run(state, request)
    return {"session_id": session_id, "accepted": True}


@app.get("/runs/{session_id}/events")
def run_events(session_id: str, after: int = Query(default=-1, ge=-1), _: None = Depends(_authorize)) -> dict[str, Any]:
    with _runs_lock:
        state = _runs.get(session_id)
    if not state:
        raise HTTPException(status_code=404, detail="Agent run was not found.")
    with state.lock:
        return {"events": [event for event in state.events if event["id"] > after], "running": state.running}


@app.post("/runs/{session_id}/approve")
def approve(
    session_id: str,
    workspace_root: str | None = Query(default=None),
    _: None = Depends(_authorize),
) -> dict[str, bool]:
    state = _run_state_or_restore(session_id, workspace_root)
    if not state:
        raise HTTPException(status_code=404, detail="Agent run was not found.")
    if state.awaiting_plan:
        # A plan result is emitted just before its worker exits. Wait for that
        # short handoff so approval cannot be lost between the result and finally.
        if state.running:
            deadline = time.monotonic() + 1.0
            while state.running and time.monotonic() < deadline:
                time.sleep(0.01)
        if state.running:
            raise HTTPException(status_code=409, detail="The plan run is still finishing. Please approve again.")
        state.awaiting_plan = False
        state.approval_granted = False
        state.approval.clear()
        root = state.workspace_root
        req = RunRequest(
            prompt="Continue approved plan", workspace_root=str(root), session_id=session_id,
            mode="code", allow_write=True, allow_shell=True, write_approved=True,
        )
        state.events = []
        _launch_run(state, req, approve_plan=True)
        return {"accepted": True}
    if not state.running:
        raise HTTPException(status_code=409, detail="This run is not awaiting approval.")
    state.approval_granted = True
    state.approval.set()
    return {"accepted": True}


@app.post("/runs/{session_id}/reject")
def reject(
    session_id: str,
    workspace_root: str | None = Query(default=None),
    _: None = Depends(_authorize),
) -> dict[str, bool]:
    state = _run_state_or_restore(session_id, workspace_root)
    if not state:
        raise HTTPException(status_code=404, detail="Agent run was not found.")
    if state.running:
        state.approval_granted = False
        state.approval.set()
        state.emit("approval_denied")
        return {"accepted": True}
    if not state.awaiting_plan:
        raise HTTPException(status_code=409, detail="This run is not awaiting approval.")
    state.awaiting_plan = False
    state.emit("approval_rejected")
    return {"accepted": True}


@app.post("/runs/{session_id}/answer-questions")
def answer_questions(
    session_id: str,
    request: AnswerQuestionsRequest,
    _: None = Depends(_authorize),
) -> dict[str, bool]:
    with _runs_lock:
        state = _runs.get(session_id)
    if not state:
        raise HTTPException(status_code=404, detail="Agent run was not found.")
    with state.lock:
        if not state.awaiting_questions:
            raise HTTPException(status_code=409, detail="This run is not waiting for answers.")
        state.question_answers = list(request.answers or [])
        state.question_event.set()
    state.emit("questions_answered", session_id=session_id)
    return {"accepted": True}


@app.post("/runs/{session_id}/stop")
def stop(
    session_id: str,
    workspace_root: str | None = Query(default=None),
    _: None = Depends(_authorize),
) -> dict[str, bool]:
    state = _run_state_or_restore(session_id, workspace_root)
    if not state:
        raise HTTPException(status_code=404, detail="Agent run was not found.")
    if not state.running:
        if state.awaiting_plan:
            state.awaiting_plan = False
            state.emit("approval_rejected")
        # Make Stop safe to repeat after a run has already ended.
        return {"accepted": True}
    state.cancelled.set()
    state.approval.set()
    state.question_event.set()
    state.emit("stopping")
    return {"accepted": True}


@app.post("/shutdown")
def shutdown(_: None = Depends(_authorize)) -> dict[str, int]:
    with _runs_lock:
        active = [state for state in _runs.values() if state.running]
    for state in active:
        state.cancelled.set()
        state.approval.set()
        state.question_event.set()
        state.emit("stopping")

    deadline = time.monotonic() + 2.0
    while any(state.running for state in active) and time.monotonic() < deadline:
        time.sleep(0.025)
    return {
        "stopped": sum(not state.running for state in active),
        "remaining": sum(state.running for state in active),
    }
