"""HTTP sidecar for the Xvie browser agent.

Wraps :mod:`engine` (Playwright/CDP automation of the 6 hardcoded web LLMs)
in a small FastAPI service the Electron main process spawns and the
renderer reaches via ``window.api.browser`` IPC.

Endpoints
---------
- ``GET  /sites``            hardcoded site list
- ``GET  /status``           CDP/Chrome diagnostics (doctor)
- ``POST /ensure-chrome``    launch the dedicated Chrome window
- ``POST /ask``              ask one site, wait for the answer (long poll)
- ``GET  /history?site=``    recent sqlite history for a site
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger("browser-agent")

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

import engine
from sites import SITE_IDS, site_list
import store

app = FastAPI(title="xvie-browser-agent", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

ASK_TIMEOUT_S = int(os.getenv("XVIE_BROWSER_ASK_TIMEOUT_S", "520"))
# Bumped 21 -> 22: sticky conversation_id (no cross-talk), transcript
# re-injection on resume, server-side write auto-chunk, edit_file hints.
AGENT_VERSION = 22


@app.exception_handler(Exception)
async def unhandled_exception_handler(_request, exc: Exception) -> JSONResponse:
    # Never answer with a bare "Internal Server Error" — log the traceback
    # and return the real message so the IDE can show it.
    logger.exception("Unhandled browser-agent error")
    if isinstance(exc, HTTPException):
        raise exc
    return JSONResponse(
        status_code=500, content={"detail": f"{type(exc).__name__}: {exc}"}
    )


class AskRequest(BaseModel):
    site: str = Field(..., description="One of the hardcoded site ids")
    query: str = Field(..., min_length=1)
    file_paths: list[str] | None = None
    images_base64: list[str] | None = None
    conversation_id: str | None = None


class AskResponse(BaseModel):
    site: str
    answer: str
    images: list[str] = Field(default_factory=list)
    conversation_id: str | None = None


@app.get("/sites")
def get_sites() -> dict:
    return {"sites": site_list()}


@app.get("/modes")
def get_modes() -> dict:
    """Mirror xvie-agent mode registry so the UI never drifts.

    Returns the same five modes (plan/code/debug/ask/brainstorm) with
    allow_write/shell/web, lane_override, and read-only tool sets.
    """
    try:
        import sys as _sys
        from pathlib import Path as _Path
        _xvie_src = _Path(__file__).resolve().parent.parent / "xvie-agent"
        if str(_xvie_src) not in _sys.path:
            _sys.path.insert(0, str(_xvie_src))
        from xvie_agent.modes import MODES, DEFAULT_MODE
        return {
            "default": DEFAULT_MODE,
            "modes": {
                name: {
                    "display_name": cfg.display_name,
                    "allow_write": cfg.allow_write,
                    "allow_shell": cfg.allow_shell,
                    "allow_web_search": cfg.allow_web_search,
                    "tools_always_on": sorted(cfg.tools_always_on),
                    "lane_override": cfg.lane_override,
                    "research_depth": cfg.research_depth,
                    "can_generate_code": cfg.can_generate_code,
                }
                for name, cfg in MODES.items()
            },
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"modes unavailable: {exc}") from exc


@app.get("/status")
def get_status() -> dict:
    report = engine.doctor_report()
    report["supported_sites"] = list(SITE_IDS)
    return report


@app.post("/ensure-chrome")
def ensure_chrome(req: dict | None = None) -> dict:
    """Make sure the dedicated Chrome is up.

    Body: ``{"visible": true}`` to show, or ``{"visible": false}`` to hide.
    If omitted, an existing window keeps its current visibility; a new window
    uses the configured default.
    """
    from sites import SITES

    visible = None
    if isinstance(req, dict) and isinstance(req.get("visible"), bool):
        visible = req["visible"]
    try:
        # Blank launch only — the model's tab opens on demand, never all six.
        return engine.ensure_chrome(visible=visible)
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/restart-chrome")
def restart_chrome(req: dict | None = None) -> dict:
    """Explicitly restart Xvie-managed Chrome after an attach failure."""
    visible = bool((req or {}).get("visible", True))
    try:
        return engine.restart_managed_chrome(visible=visible)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/ask", response_model=AskResponse)
async def ask(req: AskRequest) -> AskResponse:
    if req.site not in SITE_IDS:
        raise HTTPException(status_code=400, detail=f"Unknown site {req.site!r}.")
    conversation_id = req.conversation_id
    if not conversation_id:
        conversation_id = store.create_conversation(req.site, title=req.query[:80])["id"]
    try:
        answer, images = await asyncio.wait_for(
            engine.run_model_task(
                req.site, req.query, req.file_paths, req.images_base64,
                conversation_id=conversation_id,
            ),
            timeout=ASK_TIMEOUT_S,
        )
    except asyncio.TimeoutError as exc:
        raise HTTPException(status_code=504, detail="Timed out waiting for the model answer.") from exc
    except RuntimeError as exc:
        message = str(exc)
        status = 401 if message.startswith("NOT_LOGGED_IN:") else 502
        raise HTTPException(status_code=status, detail=message) from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        # Playwright/protocol errors etc. — report, don't 500-blanket.
        raise HTTPException(status_code=502, detail=f"{type(exc).__name__}: {exc}") from exc
    return AskResponse(site=req.site, answer=answer, images=images, conversation_id=conversation_id)


class RunTaskRequest(BaseModel):
    site: str = Field(..., description="One of the hardcoded site ids")
    task: str = Field(..., min_length=1)
    workspace_root: str | None = None
    max_turns: int = Field(default=8, ge=1, le=12)
    conversation_id: str | None = None
    mode: str = Field(default="code", description="xvie mode: plan|code|debug|ask|brainstorm")


@app.post("/run-task")
async def run_task(req: RunTaskRequest) -> dict:
    """Full xvie-style tool loop powered by a browser LLM.

    The web model reasons; file tools execute LOCALLY and autonomously.
    Slower than API (one browser round-trip per turn) but same workflow.
    """
    if req.site not in SITE_IDS:
        raise HTTPException(status_code=400, detail=f"Unknown site {req.site!r}.")
    if (req.mode or "").lower().strip() not in ("plan", "code", "debug", "ask", "brainstorm"):
        raise HTTPException(status_code=400, detail=f"Unknown mode {req.mode!r}. Expected one of: plan, code, debug, ask, brainstorm.")
    try:
        from browser_loop import run_browser_task
    except ImportError as exc:
        raise HTTPException(status_code=500, detail=f"browser_loop unavailable: {exc}") from exc
    conversation_id = req.conversation_id or store.create_conversation(req.site, title=req.task[:80])["id"]
    try:
        result = await asyncio.wait_for(
            run_browser_task(req.site, req.task, req.workspace_root,
                             req.max_turns, conversation_id, mode=req.mode),
            timeout=ASK_TIMEOUT_S,
        )
    except asyncio.TimeoutError as exc:
        raise HTTPException(status_code=504, detail="Timed out running the browser task.") from exc
    except RuntimeError as exc:
        message = str(exc)
        status = 401 if message.startswith("NOT_LOGGED_IN:") else 502
        raise HTTPException(status_code=status, detail=message) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"{type(exc).__name__}: {exc}") from exc
    return {"site": req.site, "answer": result.final_output, "turns": result.turns,
            "tool_calls": result.tool_calls, "stop_reason": result.stop_reason,
            "changed_files": result.changed_files,
            "verification_outcome": result.verification_outcome,
            "conversation_id": conversation_id}


@app.post("/ask/stream")
async def ask_stream(req: AskRequest):
    """Same as /ask but streams growing answer text as SSE for live typing.

    Events: ``data: {"partial": "..."}`` … final
    ``data: {"done": true, "answer": "...", "images": [...]}`` or
    ``data: {"error": "...", "needs_login": bool}``.
    """
    if req.site not in SITE_IDS:
        raise HTTPException(status_code=400, detail=f"Unknown site {req.site!r}.")

    queue: asyncio.Queue = asyncio.Queue()

    async def _produce() -> None:
        async def _on_partial(text: str) -> None:
            await queue.put({"partial": text})

        try:
            answer, images = await engine.run_model_task(
                req.site, req.query, req.file_paths, req.images_base64,
                on_partial=_on_partial,
                conversation_id=req.conversation_id,
            )
            await queue.put({"done": True, "answer": answer, "images": images})
        except asyncio.CancelledError:
            raise
        except RuntimeError as exc:
            message = str(exc)
            await queue.put({
                "error": message,
                "needs_login": message.startswith("NOT_LOGGED_IN:"),
            })
        except Exception as exc:  # noqa: BLE001 - must surface, never hang
            await queue.put({"error": f"{type(exc).__name__}: {exc}"})

    async def _events():
        producer = asyncio.create_task(_produce())
        try:
            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=ASK_TIMEOUT_S + 30)
                except asyncio.TimeoutError:
                    yield f'data: {json.dumps({"error": "Stream timed out."})}\n\n'
                    break
                yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
                if "done" in item or "error" in item:
                    break
        finally:
            if not producer.done():
                producer.cancel()

    return StreamingResponse(_events(), media_type="text/event-stream")


@app.get("/login-status")
async def login_status(site: str, create: bool = False, launch: bool = False) -> dict:
    """Lightweight per-site login probe (no messages sent).

    ``create=true`` opens the site tab when missing (used when the user
    explicitly picks that model). ``launch`` allows starting the browser;
    badge sweeps leave it false so a down browser reports instantly instead
    of triggering a cold start.
    """
    if site not in SITE_IDS:
        raise HTTPException(status_code=400, detail=f"Unknown site {site!r}.")
    try:
        return await asyncio.wait_for(
            engine.check_login(site, create=create, launch=launch or create), timeout=60
        )
    except asyncio.TimeoutError as exc:
        raise HTTPException(status_code=504, detail="Login check timed out.") from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"{type(exc).__name__}: {exc}") from exc


@app.get("/history")
def history(site: str, limit: int = 50, conversation_id: str | None = None) -> dict:
    if site not in SITE_IDS:
        raise HTTPException(status_code=400, detail=f"Unknown site {site!r}.")
    return {"site": site, "messages": store.recent_messages(site, limit=limit, conversation_id=conversation_id)}


@app.get("/conversations")
def conversations(site: str, limit: int = 100) -> dict:
    if site not in SITE_IDS:
        raise HTTPException(status_code=400, detail=f"Unknown site {site!r}.")
    return {"site": site, "conversations": store.list_conversations(site, limit)}


@app.delete("/conversations/{conversation_id}")
def delete_conversation(site: str, conversation_id: str) -> dict:
    if site not in SITE_IDS:
        raise HTTPException(status_code=400, detail=f"Unknown site {site!r}.")
    if not store.delete_conversation(site, conversation_id):
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return {"success": True}


@app.post("/conversations")
async def new_conversation(req: dict) -> dict:
    site = str(req.get("site", ""))
    if site not in SITE_IDS:
        raise HTTPException(status_code=400, detail=f"Unknown site {site!r}.")
    try:
        remote_url = await engine.start_new_conversation(site)
    except RuntimeError as exc:
        status = 401 if str(exc).startswith("NOT_LOGGED_IN:") else 502
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    item = store.create_conversation(site)
    store.update_remote_url(site, item["id"], remote_url)
    return {**item, "remote_url": remote_url}


@app.post("/conversations/{conversation_id}/open")
async def open_conversation(site: str, conversation_id: str) -> dict:
    if site not in SITE_IDS:
        raise HTTPException(status_code=400, detail=f"Unknown site {site!r}.")
    item = store.conversation(site, conversation_id)
    if not item:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    try:
        if item["remote_url"]:
            await engine.open_conversation(site, item["remote_url"])
        else:
            remote_url = await engine.start_new_conversation(site)
            store.update_remote_url(site, conversation_id, remote_url)
            item = store.conversation(site, conversation_id) or item
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return item


@app.get("/health")
def health() -> dict:
    # Marker the IDE verifies so it never talks to a stale sidecar that is
    # squatting on the port (e.g. an orphan from an older version).
    return {
        "ok": True,
        "agent": "xvie-browser-agent",
        "version": AGENT_VERSION,
        "cdp_port": engine.CDP_PORT,
        "sidecar_port": int(os.getenv("XVIE_BROWSER_AGENT_PORT", "28711")),
    }


@app.post("/shutdown")
def shutdown() -> dict:
    """Graceful stop (used when replacing a stale sidecar)."""
    import threading

    def _exit() -> None:
        import time

        time.sleep(0.5)
        os._exit(0)

    threading.Thread(target=_exit, daemon=True).start()
    return {"ok": True, "stopping": True}


def main() -> None:
    import uvicorn

    port = int(os.getenv("XVIE_BROWSER_AGENT_PORT", "28711"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")


if __name__ == "__main__":
    main()
