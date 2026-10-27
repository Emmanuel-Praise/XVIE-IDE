"""Generic Playwright driver for the hardcoded web-LLM sites.

This ports the behaviour of ``mcp-web-llm/server.py`` plus the per-model
``send_message`` / ``get_latest_answer`` / ``upload_files`` logic from
``mcp-web-llm/models/*.py`` into one data-driven driver backed by
:mod:`sites`. The IDE talks to :mod:`app`, never to this module directly.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import os
import platform
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import uuid
from pathlib import Path

logger = logging.getLogger(__name__)


def _provider_host(hostname: str | None, domains: tuple[str, ...]) -> bool:
    host = (hostname or "").lower().rstrip(".")
    return any(host == domain or host.endswith("." + domain) for domain in domains)

try:
    from playwright.async_api import (
        BrowserContext,
        Page,
        TimeoutError as PlaywrightTimeoutError,
        async_playwright,
    )
except ImportError:  # pragma: no cover - surfaced clearly at runtime
    BrowserContext = object  # type: ignore[assignment]
    Page = object  # type: ignore[assignment]

    class PlaywrightTimeoutError(Exception):  # type: ignore[no-redef]
        pass

    async_playwright = None  # type: ignore[assignment]

from sites import BrowserSite, get_site
from store import conversation as load_conversation, recent_messages, save_message, update_remote_url

# NOTE: port 9222 is off-limits — Xvie's Electron app itself exposes CDP on
# 9222 in dev, and mcp-web-llm also defaults to it. We use 9333 so the engine
# always talks to OUR dedicated chat window and never the IDE or foreign apps.
CDP_PORT = os.getenv("MCP_WEB_LLM_CDP_PORT", "9333")
CDP_ENDPOINT = f"http://127.0.0.1:{CDP_PORT}"


def _default_profile_dir() -> str:
    override = os.environ.get("MCP_WEB_LLM_PROFILE_DIR")
    if override:
        return override
    # Own profile (NOT C:\chrome_debug_profile) so we never fight mcp-web-llm
    # or a manually-started Chrome over the same profile lock.
    return str(Path.home() / ".xvie-browser-agent" / "chrome-profile")


DEFAULT_PROFILE_DIR = _default_profile_dir()
ANSWER_TIMEOUT_S = int(os.getenv("XVIE_BROWSER_ANSWER_TIMEOUT_S", "150"))
# The dedicated Chrome window starts INVISIBLE (real headed window, hidden via
# the Win32 API) so chats never cover the IDE. Plain --headless is NOT used:
# it exits immediately on some machines and trips stricter bot detection.
# XVIE_BROWSER_HEADLESS=0 starts it visible (handy for first-time logins).
HEADLESS_DEFAULT = os.getenv("XVIE_BROWSER_HEADLESS", "1") == "1"

_chrome_proc: subprocess.Popen | None = None
_chrome_pid: int | None = None
_chrome_visible: bool = False
# Serializes ALL launches (HTTP endpoint and in-task auto-launch alike):
# exactly ONE browser process, launched once, tabs added on demand.
_ensure_lock = threading.Lock()


def _pidfile_path() -> str:
    from store import get_db_path

    return os.path.join(os.path.dirname(get_db_path()), "chrome.pid")


def _write_pidfile(pid: int) -> None:
    try:
        with open(_pidfile_path(), "w") as fh:
            fh.write(str(pid))
    except Exception as exc:
        logger.warning("Could not write chrome pidfile: %s", exc)


def _read_pidfile() -> int | None:
    try:
        with open(_pidfile_path()) as fh:
            pid = int(fh.read().strip())
            return pid if pid > 0 else None
    except Exception:
        return None


def _clear_pidfile() -> None:
    try:
        os.remove(_pidfile_path())
    except Exception:
        pass


def _pid_alive(pid: int) -> bool:
    """True if a process with this pid exists (Win32, no deps)."""
    try:
        import ctypes

        SYNCHRONIZE = 0x00100000
        handle = ctypes.windll.kernel32.OpenProcess(SYNCHRONIZE, False, pid)
        if not handle:
            return False
        ctypes.windll.kernel32.CloseHandle(handle)
        return True
    except Exception:
        return False


def _managed_pid() -> int | None:
    """Pid of OUR dedicated Chrome, adopting across sidecar restarts.

    Resolution order: live in-memory pid -> pidfile -> process scan for our
    CDP port/profile (nothing else on this machine uses port 9333). The scan
    means Show/Hide is available whenever our browser runs, no matter which
    sidecar instance launched it.
    """
    global _chrome_pid
    if _chrome_pid is not None and _pid_alive(_chrome_pid):
        return _chrome_pid
    _chrome_pid = None
    pid = _read_pidfile()
    if pid is not None and _pid_alive(pid):
        _chrome_pid = pid
        return pid
    pid = _find_chrome_by_cmdline()
    if pid is not None:
        _chrome_pid = pid
        _write_pidfile(pid)
        return pid
    return None


def _find_chrome_by_cmdline() -> int | None:
    """Locate our dedicated Chrome by its CDP port / profile in cmdline."""
    try:
        import psutil
    except ImportError:
        return None
    port_flag = f"--remote-debugging-port={CDP_PORT}"
    profile_dir = os.environ.get("MCP_WEB_LLM_PROFILE_DIR", DEFAULT_PROFILE_DIR)
    try:
        for proc in psutil.process_iter(["pid", "name", "cmdline"]):
            try:
                info = proc.info
                if not info or (info.get("name") or "").lower() != "chrome.exe":
                    continue
                cmdline = " ".join(info.get("cmdline") or [])
                if port_flag not in cmdline:
                    continue
                if "--type=" in cmdline:
                    continue  # renderer/gpu child, not the main process
                if profile_dir not in cmdline:
                    continue
                return int(info["pid"])
            except Exception:
                continue
    except Exception as exc:
        logger.warning("Chrome process scan failed: %s", exc)
    return None


def _hidden_enforcer_loop() -> None:
    """Background guard: while our browser should be hidden, re-hide any of
    its windows every 2s (late popups, restore bubbles, interstitials)."""
    import ctypes

    try:
        user32 = ctypes.windll.user32
    except Exception:
        return
    while True:
        try:
            time.sleep(2.0)
            if _chrome_visible:
                continue
            pid = _managed_pid()
            if pid is None:
                continue
            for hwnd in _chrome_window_handles(pid):
                try:
                    if user32.IsWindowVisible(hwnd):
                        user32.ShowWindow(hwnd, 0)  # SW_HIDE
                except Exception:
                    pass
        except Exception:
            pass


_enforcer_started = False


def _start_hidden_enforcer() -> None:
    global _enforcer_started
    if _enforcer_started:
        return
    _enforcer_started = True
    thread = threading.Thread(target=_hidden_enforcer_loop, daemon=True)
    thread.start()


# ---------------------------------------------------------------------------
# Chrome / CDP lifecycle (ported from mcp-web-llm/server.py)
# ---------------------------------------------------------------------------

def find_chrome_executable() -> str | None:
    env_path = os.getenv("MCP_WEB_LLM_CHROME_PATH")
    if env_path and os.path.exists(env_path):
        return env_path
    candidates: list[str] = []
    local_appdata = os.environ.get("LOCALAPPDATA")
    if local_appdata:
        candidates.append(os.path.join(local_appdata, "Google", "Chrome", "Application", "chrome.exe"))
    candidates.extend(
        [
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        ]
    )
    for path in candidates:
        if path and os.path.exists(path):
            return path
    return None


def launch_chrome_with_cdp(urls: list[str], visible: bool = False) -> None:
    """Launch the dedicated Chrome window.

    The window starts INVISIBLE (a real headed Chrome whose top-level window
    is created hidden via STARTUPINFO) so chats run in the background without
    ever covering the IDE — and without headless-mode quirks (instant exits,
    stricter bot detection). Pass ``visible=True`` (the "Show browser"
    action) when a site needs an interactive login. The process is tracked so
    Show/Hide can toggle the same window in place — no restarts, tabs kept.
    """
    global _chrome_proc, _chrome_pid, _chrome_visible
    if not platform.system().lower().startswith("win"):
        raise RuntimeError(
            f"Auto-launch is currently supported on Windows only. "
            f"Please start Chrome with --remote-debugging-port={CDP_PORT} manually."
        )
    stop_chrome()
    chrome = find_chrome_executable()
    if not chrome:
        raise RuntimeError(
            f"chrome.exe not found. Install Google Chrome or start it with "
            f"--remote-debugging-port={CDP_PORT} manually."
        )
    profile_dir = os.environ.get("MCP_WEB_LLM_PROFILE_DIR", DEFAULT_PROFILE_DIR)
    args = [
        chrome,
        "--remote-debugging-address=127.0.0.1",
        f"--remote-debugging-port={CDP_PORT}",
        f"--user-data-dir={profile_dir}",
        "--disable-blink-features=AutomationControlled",
        # Skip first-run UI, the default-browser modal and the crash-restore
        # bubble: all of them would pop visible windows over the IDE.
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-session-crashed-bubble",
        "--new-window",
        *urls,
    ]
    creationflags = 0
    if hasattr(subprocess, "DETACHED_PROCESS"):
        creationflags |= subprocess.DETACHED_PROCESS
    if hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP"):
        creationflags |= subprocess.CREATE_NEW_PROCESS_GROUP
    startupinfo = None
    if not visible and hasattr(subprocess, "STARTUPINFO"):
        # SW_HIDE: the main window is created invisible (no taskbar flash).
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = 0
    _chrome_proc = subprocess.Popen(
        args, close_fds=True, creationflags=creationflags, startupinfo=startupinfo
    )
    _chrome_pid = _chrome_proc.pid
    _write_pidfile(_chrome_pid)
    _chrome_visible = False
    _start_hidden_enforcer()
    logger.info("Launched dedicated Chrome (hidden, pid=%s)", _chrome_proc.pid)
    if not visible:
        # Belt and suspenders: STARTUPINFO hides the first window, but Chrome
        # may flash follow-up windows (profile restore, popups). Sweep them
        # invisible briefly; the background enforcer keeps them hidden after.
        _hide_chrome_windows(_chrome_proc.pid, timeout_s=3.0)
    else:
        set_chrome_visibility(True)


def _hide_chrome_windows(pid: int, timeout_s: float = 6.0) -> None:
    """Force-hide every window of a process for a short window (Win32)."""
    import ctypes

    deadline = time.time() + max(0.5, timeout_s)
    try:
        user32 = ctypes.windll.user32
    except Exception:
        return
    while time.time() < deadline:
        try:
            for hwnd in _chrome_window_handles(pid):
                try:
                    if user32.IsWindowVisible(hwnd):
                        user32.ShowWindow(hwnd, 0)  # SW_HIDE
                except Exception:
                    pass
        except Exception:
            pass
        time.sleep(0.25)


def _chrome_window_handles(pid: int) -> list[int]:
    """Top-level window handles owned by a process (Win32 only)."""
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    handles: list[int] = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def _enum(hwnd, _lparam):
        try:
            owner = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
            if owner.value == pid:
                buf = ctypes.create_unicode_buffer(256)
                user32.GetClassNameW(hwnd, buf, 256)
                if buf.value.startswith("Chrome_WidgetWin"):
                    handles.append(hwnd)
        except Exception:
            pass
        return True

    user32.EnumWindows(_enum, 0)
    return handles


def set_chrome_visibility(visible: bool) -> bool:
    """Show or hide OUR dedicated Chrome window in place. Returns success."""
    global _chrome_visible
    pid = _managed_pid()
    if pid is None:
        return False
    try:
        import ctypes

        user32 = ctypes.windll.user32
        hwnds = _chrome_window_handles(pid)
        if not hwnds:
            # Window may not exist yet (still starting) — record intent.
            _chrome_visible = bool(visible)
            return False
        # SW_RESTORE=9 shows+activates, SW_HIDE=0 hides (also from taskbar).
        for hwnd in hwnds:
            user32.ShowWindow(hwnd, 9 if visible else 0)
        if visible:
            try:
                user32.SetForegroundWindow(hwnds[0])
            except Exception:
                pass
        _chrome_visible = bool(visible)
        logger.info("Chrome window visibility -> %s", visible)
        return True
    except Exception as exc:
        logger.warning("Failed to toggle Chrome visibility: %s", exc)
        return False


def _terminate_pid(pid: int) -> None:
    try:
        import ctypes

        PROCESS_TERMINATE = 0x0001
        handle = ctypes.windll.kernel32.OpenProcess(PROCESS_TERMINATE, False, pid)
        if handle:
            ctypes.windll.kernel32.TerminateProcess(handle, 0)
            ctypes.windll.kernel32.CloseHandle(handle)
    except Exception as exc:
        logger.warning("Failed to terminate pid %s: %s", pid, exc)


def stop_chrome() -> None:
    """Terminate the Chrome instance launched by this sidecar, if any."""
    global _chrome_proc, _chrome_pid, _chrome_visible
    proc, _chrome_proc = _chrome_proc, None
    pid = _chrome_pid
    _chrome_pid = None
    _chrome_visible = False
    _clear_pidfile()
    if proc is not None and proc.poll() is None:
        logger.info("Stopping sidecar Chrome (pid=%s)", proc.pid)
        proc.terminate()
        try:
            proc.wait(timeout=6)
        except subprocess.TimeoutExpired:
            proc.kill()
    elif pid is not None and _pid_alive(pid):
        logger.info("Stopping adopted Chrome (pid=%s)", pid)
        _terminate_pid(pid)
        deadline = time.time() + 6.0
        while time.time() < deadline and _pid_alive(pid):
            time.sleep(0.5)
    # Give the OS time to release the profile lock before a relaunch.
    time.sleep(2.0)


def cdp_reachable_quick(timeout: float = 2.0) -> bool:
    try:
        with urllib.request.urlopen(f"{CDP_ENDPOINT}/json/version", timeout=timeout):
            return True
    except Exception:
        return False


def ensure_chrome(urls: list[str] | None = None, visible: bool | None = None) -> dict:
    """Bring up the ONE dedicated Chrome, changing visibility only when asked.

    The browser always launches with just a blank tab — site tabs are created
    on demand for the model you actually pick, never all six at once.
    Show/Hide toggles the SAME window in place (no restart, tabs kept). An
    omitted visibility request preserves an existing window's current state.
    Serialized by a lock: concurrent calls pile onto one browser instead of
    spawning a fleet that fights over the profile lock (which used to pop
    visible windows everywhere).
    """
    with _ensure_lock:
        if cdp_reachable_quick():
            pid = _managed_pid()
            if pid is None:
                return {"started": False, "toggled": False, "managed": False, "visible": True, "cdp_reachable": True}
            if visible is None or bool(visible) == _chrome_visible:
                return {"started": False, "toggled": False, "managed": True, "visible": _chrome_visible, "cdp_reachable": True}
            toggled = set_chrome_visibility(bool(visible))
            return {"started": False, "toggled": toggled, "managed": True, "visible": _chrome_visible, "cdp_reachable": True}
        if visible is None:
            visible = not HEADLESS_DEFAULT
        launch_chrome_with_cdp(["about:blank"], visible=visible)
        return {"started": True, "toggled": False, "managed": True, "visible": _chrome_visible, "cdp_reachable": cdp_reachable_quick(15.0)}


def restart_managed_chrome(visible: bool = True) -> dict:
    """Restart only Xvie's own browser after a failed Playwright attachment.

    The same browser profile is reused. Its open provider tabs are closed, so
    this is exposed as an explicit recovery action only.
    """
    global _chrome_visible
    with _ensure_lock:
        if _managed_pid() is None:
            raise RuntimeError("The Chrome session is not managed by Xvie; it was left untouched.")
        stop_chrome()
        launch_chrome_with_cdp(["about:blank"], visible=bool(visible))
        return {
            "started": True,
            "toggled": False,
            "managed": True,
            "visible": _chrome_visible,
            "cdp_reachable": cdp_reachable_quick(15.0),
        }


async def wait_for_cdp(p, timeout_s: float = 15.0):
    deadline = asyncio.get_event_loop().time() + timeout_s
    last_err: Exception | None = None
    while asyncio.get_event_loop().time() < deadline:
        try:
            # Per-attempt timeout: connect_over_cdp can hang indefinitely
            # against a much newer Chrome than Playwright was built for.
            browser = await asyncio.wait_for(
                p.chromium.connect_over_cdp(CDP_ENDPOINT), timeout=10.0
            )
            if not browser.contexts:
                raise RuntimeError("Chrome answered but has no open contexts.")
            return browser.contexts[0]
        except Exception as exc:
            last_err = exc
            await asyncio.sleep(0.5)
    raise RuntimeError(f"Failed to connect to Chrome at {CDP_ENDPOINT}: {last_err}")


async def get_browser_context(p, auto_launch: bool = True):
    """Connect to the ONE dedicated Chrome window, launching it if needed.

    Launches funnel through ensure_chrome (same serialized path as the HTTP
    endpoint), so concurrent asks and probes pile onto one browser instead of
    each spawning their own fleet of windows.
    """
    try:
        return await wait_for_cdp(p, timeout_s=2.0)
    except Exception as exc:
        if not auto_launch:
            raise
        await asyncio.to_thread(ensure_chrome, None, False)
        logger.info("Ensured hidden Chrome, waiting for CDP: %s", exc)
        return await wait_for_cdp(p, timeout_s=45.0)


async def get_or_create_page(context, site: BrowserSite, create: bool = True):
    """Find the site's tab, optionally opening it. Only the model you pick
    ever gets a tab — check_login probes with create=False so badges never
    open sites by themselves."""
    for page in context.pages:
        page_url = page.url or ""
        if any(k in page_url for k in site.domain_keywords):
            logger.info("Reusing tab for %s: %s", site.id, page.url)
            # Never foreground while hidden: bring_to_front yanks an
            # invisible window back onto the screen on every single reply.
            if _chrome_visible or _managed_pid() is None:
                try:
                    await page.bring_to_front()
                except Exception:
                    pass
            return page, True
    if not create:
        return None, False
    logger.info("Opening new tab for %s: %s", site.id, site.url)
    page = await context.new_page()
    try:
        await page.goto(site.url)
    except PlaywrightTimeoutError:
        logger.warning("Timeout loading %s, retrying once...", site.url)
        await page.goto(site.url)
    return page, False


def ensure_logged_in(page, site: BrowserSite) -> bool:
    url = (page.url or "").lower()
    return not ("login" in url or "/auth" in url or "signin" in url or "sign-in" in url)


def doctor_report() -> dict:
    from sites import SITES

    report: dict = {
        "project": "xvie-browser-agent",
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "cdp_endpoint": CDP_ENDPOINT,
        "cdp_reachable": False,
        "chrome_executable": find_chrome_executable(),
        "profile_dir": os.environ.get("MCP_WEB_LLM_PROFILE_DIR", DEFAULT_PROFILE_DIR),
        "open_tabs": [],
        "chrome_managed": _managed_pid() is not None,
        "chrome_visible": _chrome_visible,
        "chrome_headless_default": HEADLESS_DEFAULT,
        "sites": [s.url for s in SITES.values()],
    }
    try:
        with urllib.request.urlopen(f"{CDP_ENDPOINT}/json/version", timeout=2) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            report["cdp_reachable"] = True
            report["cdp_browser"] = data.get("Browser")
    except Exception as exc:
        report["cdp_error"] = str(exc)
        return report
    try:
        with urllib.request.urlopen(f"{CDP_ENDPOINT}/json/list", timeout=2) as resp:
            tabs = json.loads(resp.read().decode("utf-8"))
            report["open_tabs"] = [t.get("url") for t in tabs if isinstance(t, dict) and t.get("url")]
    except Exception as exc:
        report["tabs_error"] = str(exc)
    return report


# ---------------------------------------------------------------------------
# Query + file handling (ported from resolve_query_and_files in server.py)
# ---------------------------------------------------------------------------

def materialize_base64_images(images_base64: list[str] | None = None) -> list[str]:
    if not images_base64:
        return []
    temp_dir = os.path.join(tempfile.gettempdir(), "xvie-browser-agent-inline")
    os.makedirs(temp_dir, exist_ok=True)
    created: list[str] = []
    for idx, raw in enumerate(images_base64):
        if not raw:
            continue
        payload = raw.strip()
        ext = ".png"
        m = re.match(r"^data:(image/[\w.+-]+);base64,(.+)$", payload, re.IGNORECASE | re.DOTALL)
        if m:
            mime = m.group(1).lower()
            payload = m.group(2).strip()
            if "jpeg" in mime or "jpg" in mime:
                ext = ".jpg"
            elif "webp" in mime:
                ext = ".webp"
            elif "gif" in mime:
                ext = ".gif"
        try:
            binary = base64.b64decode(payload, validate=True)
        except binascii.Error:
            continue
        if binary.startswith(b"\xff\xd8\xff"):
            ext = ".jpg"
        elif binary.startswith(b"GIF87a") or binary.startswith(b"GIF89a"):
            ext = ".gif"
        elif binary.startswith(b"RIFF") and b"WEBP" in binary[:16]:
            ext = ".webp"
        file_name = f"inline_{uuid.uuid4().hex}_{idx}{ext}"
        file_path = os.path.join(temp_dir, file_name)
        with open(file_path, "wb") as fh:
            fh.write(binary)
        created.append(file_path)
    return created


def resolve_query_and_files(
    query: str,
    file_paths: list[str] | None = None,
    images_base64: list[str] | None = None,
) -> tuple[str, list[str] | None]:
    resolved: list[str] = []
    seen: set[str] = set()
    for path in materialize_base64_images(images_base64):
        abs_path = os.path.abspath(path)
        if os.path.exists(abs_path) and abs_path not in seen:
            resolved.append(abs_path)
            seen.add(abs_path)
    for path in file_paths or []:
        abs_path = os.path.abspath(path)
        # Files only: a workspace directory in the text must never become an
        # "upload" (set_input_files rejects directories and the fallback
        # crashes reading them — this was the /run-task 502).
        if os.path.isfile(abs_path) and abs_path not in seen:
            resolved.append(abs_path)
            seen.add(abs_path)

    cleaned = query
    if not cleaned:
        cleaned = "Please read the file or image I just uploaded and describe what you see."
    return cleaned, (resolved or None)


# ---------------------------------------------------------------------------
# Page automation (ported from models/base.py + per-site adapters)
# ---------------------------------------------------------------------------

async def human_type(page, locator, text: str) -> None:
    try:
        # Keep using the exact visible node selected by find_input. Re-querying
        # the selector here can hit a hidden duplicate (provider UIs often keep
        # a hidden composer mounted during transitions) and wait forever.
        await locator.click(timeout=8_000)
        try:
            await locator.fill(text, timeout=8_000)
        except Exception:
            await locator.fill("", timeout=8_000)
            await locator.focus()
            # CDP insertText puts the entire string into the focused editor at
            # once. Avoid per-character typing delays for long agent prompts.
            await page.keyboard.insert_text(text)
    except PlaywrightTimeoutError as exc:
        raise RuntimeError(
            f"Timeout interacting with the visible {locator} composer. The page may be loading slowly "
            f"or the site layout changed. Please check the browser tab and try again."
        ) from exc


async def _input_is_clear(locator) -> bool:
    try:
        return await locator.evaluate(
            """(el) => {
                if (!el) return true;
                const text = (el.value || el.textContent || '').replace(/\\u200b/g, '').trim();
                return text === '';
            }""",
        )
    except Exception:
        return False


async def _send_was_accepted(page, site: BrowserSite, input_locator, previous_bubble_count: int) -> bool:
    """Accept any reliable UI signal that the provider received the prompt."""
    if await _input_is_clear(input_locator):
        return True
    if await _is_generating(page, site):
        return True
    try:
        if len(await read_bubbles(page, site)) > previous_bubble_count:
            return True
    except Exception:
        pass
    return False


async def _confirm_sent(
    page,
    site: BrowserSite,
    input_locator,
    previous_bubble_count: int,
    timeout_s: float = 6.0,
) -> bool:
    """Poll for composer clear, a new answer bubble, or active generation."""
    deadline = asyncio.get_event_loop().time() + timeout_s
    while asyncio.get_event_loop().time() < deadline:
        if await _send_was_accepted(page, site, input_locator, previous_bubble_count):
            return True
        await asyncio.sleep(0.5)
    return await _send_was_accepted(page, site, input_locator, previous_bubble_count)


async def _find_send_button(input_locator, site: BrowserSite):
    """Find a site's send control only inside the composer region.

    Searching the whole page for generic icon buttons can click unrelated
    dialogs (for example DeepSeek's "Create public link" action).
    """
    container = input_locator
    for _ in range(7):
        try:
            container = container.locator("xpath=..")
        except Exception:
            return None
        for selector in site.send_candidates:
            try:
                matches = container.locator(selector)
                count = min(await matches.count(), 8)
                for index in range(count):
                    button = matches.nth(index)
                    safe_to_click = await button.evaluate(
                        """(el) => {
                            const meta = [el.getAttribute('aria-label'), el.getAttribute('title'),
                                el.getAttribute('data-testid'), el.className, el.innerText]
                                .filter(Boolean).join(' ').toLowerCase();
                            return !el.disabled
                                && el.getAttribute('aria-disabled') !== 'true'
                                && !/\\bdisabled\\b/.test(meta)
                                && !/\\b(attach|upload|file)\\b/.test(meta);
                        }"""
                    )
                    if safe_to_click and await button.is_visible() and await button.is_enabled():
                        return button
            except Exception:
                continue
    return None


async def upload_files(page, file_paths: list[str]) -> None:
    """Attach files WITHOUT opening the OS file dialog.

    Old order clicked an attach button first — that pops a native file
    chooser Playwright cannot drive (the "browser trying to open and select
    a file" you saw) and strands the send. New order: set files directly
    on the hidden <input type=file> (no dialog), only click attach as a
    last resort before the drag-and-drop fallback.
    """
    if not file_paths:
        return
    abs_paths = [os.path.abspath(p) for p in file_paths if os.path.isfile(p)]
    if not abs_paths:
        return
    uploaded = False
    try:
        inputs = page.locator('input[type="file"]')
        count = await inputs.count()
        for i in range(count):
            try:
                inp = inputs.nth(i)
                if await inp.is_disabled():
                    continue
                await inp.set_input_files(abs_paths)
                files_len = await inp.evaluate("(el) => (el.files && el.files.length) || 0")
                if files_len > 0:
                    uploaded = True
                    break
            except Exception as exc:
                logger.warning("File input %d failed: %s", i, exc)
    except Exception as exc:
        logger.warning("File input scan failed: %s", exc)
    if uploaded:
        await asyncio.sleep(3)
        return
    # Do not click the provider's attach button here: it opens a native file
    # chooser that blocks the user's desktop. The drag/drop fallback below
    # keeps upload automation inside the page.
    if not uploaded:
        import base64 as _b64
        import mimetypes

        files_data = []
        for path in abs_paths:
            try:
                mime, _ = mimetypes.guess_type(path)
                with open(path, "rb") as fh:
                    files_data.append(
                        {
                            "name": os.path.basename(path),
                            "type": mime or "application/octet-stream",
                            "data": _b64.b64encode(fh.read()).decode("utf-8"),
                        }
                    )
            except OSError as exc:
                logger.warning("Skipping unreadable attachment %s: %s", path, exc)
        if not files_data:
            return
        js = """
        ([filesData]) => {
            const target = document.body;
            const dataTransfer = new DataTransfer();
            filesData.forEach(file => {
                const chars = atob(file.data);
                const bytes = new Array(chars.length);
                for (let i = 0; i < chars.length; i++) bytes[i] = chars.charCodeAt(i);
                const blob = new Blob([new Uint8Array(bytes)], { type: file.type });
                dataTransfer.items.add(new File([blob], file.name, { type: file.type }));
            });
            ['dragenter', 'dragover', 'drop'].forEach(t =>
                target.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer })));
        }
        """
        await page.evaluate(js, [files_data])
    await asyncio.sleep(3)


async def find_input(page, site: BrowserSite):
    """Return the first visible, enabled composer node from the site's candidates."""
    deadline = asyncio.get_event_loop().time() + 20.0
    while asyncio.get_event_loop().time() < deadline:
        for sel in site.input_candidates:
            try:
                matches = page.locator(sel)
                # A selector can match hidden duplicate composers. Inspect each
                # match and return that exact node so later clicks/fills cannot
                # accidentally resolve to a different, hidden element.
                count = min(await matches.count(), 20)
                for index in range(count):
                    candidate = matches.nth(index)
                    if await candidate.is_visible() and await candidate.is_enabled():
                        return candidate, sel
            except Exception:
                continue
        await asyncio.sleep(0.4)
    raise RuntimeError(
        f"{site.label} message box did not become visible within 20 seconds. "
        "Sign in if needed, close any open dialog, and make sure the chat composer is visible before retrying."
    )


async def send_message(page, site: BrowserSite, query: str, file_paths: list[str] | None) -> None:
    # DeepSeek often leaves an overlay / update dialog covering the composer,
    # which makes find_input time out and surfaces as SEND_FAILED. One Escape
    # dismisses it without affecting a healthy composer.
    try:
        await page.keyboard.press("Escape")
        await asyncio.sleep(0.4)
    except Exception:
        pass
    input_locator, input_selector = await find_input(page, site)
    try:
        previous_bubble_count = len(await read_bubbles(page, site))
    except Exception:
        previous_bubble_count = 0
    if file_paths:
        await upload_files(page, file_paths)
        if site.id in ("deepseek", "qwen"):
            try:
                basename = os.path.basename(file_paths[0])
                await page.wait_for_function(
                    "(name) => document.body && document.body.innerText.includes(name)",
                    arg=basename,
                    timeout=10000,
                )
            except Exception:
                pass
            await asyncio.sleep(2)
    editable = (
        "contenteditable" in input_selector
        or "role='textbox'" in input_selector
        or "ProseMirror" in input_selector
        or input_selector == "#prompt-textarea"
    )
    if editable:
        # ProseMirror/contenteditable composers only accept REAL keystrokes
        # (ChatGPT's editor ignores programmatic fills for submit).
        await input_locator.focus()
        is_editable_div = await input_locator.evaluate(
            """(el) => {
                return el.isContentEditable
                    || (el.getAttribute('role') === 'textbox' && el.tagName !== 'TEXTAREA')
                    || (el.className && String(el.className).includes('ProseMirror'));
            }""",
        )
        if is_editable_div:
            # Rich-text providers (notably ChatGPT) need a real editor input
            # event, but do not need simulated key-by-key typing. insert_text
            # pastes the complete prompt in one fast operation.
            await page.keyboard.insert_text(query)
        else:
            await human_type(page, input_locator, query)
    else:
        await human_type(page, input_locator, query)
    await asyncio.sleep(0.6)
    # Staged send: a dead button click used to be fatal (single attempt, then
    # SEND_FAILED). Now: click button if found -> quick check -> Enter ->
    # quick check -> Ctrl+Enter -> full confirmation window. Never submit
    # twice: each stage re-checks _confirm_sent before trying the next.
    _confirm_timeout = 20.0 if site.id == "deepseek" else 10.0
    send_button = await _find_send_button(input_locator, site)
    if send_button is not None:
        try:
            await send_button.click(timeout=3_000)
        except Exception as exc:
            logger.warning("Send button click failed for %s: %s", site.id, exc)
            send_button = None
        else:
            if await _confirm_sent(page, site, input_locator, previous_bubble_count, timeout_s=3.0):
                return
    if send_button is None:
        try:
            await input_locator.press(site.send_key, timeout=3_000)
        except Exception as exc:
            logger.warning("Send key press failed for %s: %s", site.id, exc)
        if await _confirm_sent(page, site, input_locator, previous_bubble_count, timeout_s=3.0):
            return
    else:
        # Button was clicked but nothing happened (disabled / detached) —
        # fall back to keyboard submit before giving up.
        try:
            await input_locator.press(site.send_key, timeout=3_000)
        except Exception:
            pass
        if await _confirm_sent(page, site, input_locator, previous_bubble_count, timeout_s=3.0):
            return
    # Last resort for big pastes where Enter inserts a newline instead of
    # submitting (happens on DeepSeek with 10k+ char prompts).
    try:
        await input_locator.press("Control+Enter", timeout=3_000)
    except Exception:
        pass
    sent = await _confirm_sent(page, site, input_locator, previous_bubble_count, timeout_s=_confirm_timeout)
    if not sent:
        raise RuntimeError(
            f"SEND_FAILED: {site.label} did not accept the message "
            f"(no composer, answer, or generation signal appeared). Your prompt is still available in the browser tab; "
            f"press Show to inspect it, then retry."
        )


async def read_bubbles(page, site: BrowserSite) -> list[str]:
    for sel in site.answer_selectors:
        try:
            texts = await page.locator(sel).all_text_contents()
            texts = [t.strip() for t in texts if (t or "").strip()]
            if texts:
                return texts
        except Exception:
            continue
    return []


async def read_answer_images(page, site: BrowserSite, limit: int = 8) -> list[str]:
    """Collect images rendered inside the latest answer turn.

    Generated pictures live in various places: <img>, lazy data-src,
    srcset, CSS backgrounds, page-local blob: URLs — and often as SIBLINGS
    of the markdown div rather than inside it (ChatGPT image blocks). So we
    search the whole last assistant turn. Everything downloadable is fetched
    IN-PAGE (same-origin authed URLs like ChatGPT's estuary CDN only resolve
    with the tab's cookies) and returned as data: URLs; anything else falls
    back to its raw URL.
    """
    js = """(async ({sels, maxBytes}) => {
        const push = (bag, src) => { if (src) bag.push(src); };
        const collect = (root, bag) => {
            for (const img of root.querySelectorAll('img')) {
                push(bag, img.currentSrc || img.src
                    || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '');
                const ss = img.getAttribute('srcset') || '';
                if (ss) push(bag, ss.split(',')[0].trim().split(' ')[0]);
            }
            for (const pic of root.querySelectorAll('picture source[srcset]')) {
                const ss = pic.getAttribute('srcset') || '';
                if (ss) push(bag, ss.split(',')[0].trim().split(' ')[0]);
            }
            for (const el of root.querySelectorAll('*')) {
                try {
                    const bg = getComputedStyle(el).backgroundImage || '';
                    const m = bg.match(/url\\("?(.*?)"?\\)/);
                    if (m && m[1] && !m[1].startsWith('data:image/svg')) push(bag, m[1]);
                } catch (e) { /* ignore */ }
            }
        };
        const bag = [];
        // Primary: last assistant turn root (covers markdown + sibling blocks).
        const roots = document.querySelectorAll(
            "div[data-message-author-role='assistant'], .ds-message, .font-claude-response");
        const turn = roots.length ? roots[roots.length - 1] : null;
        if (turn) {
            collect(turn, bag);
            let sib = turn.nextElementSibling, hops = 0;
            while (sib && hops < 4) { collect(sib, bag); sib = sib.nextElementSibling; hops++; }
        }
        // Fallback: last markdown bubble (previous behaviour).
        if (!bag.length) {
            for (const sel of sels) {
                let els = [];
                try { els = document.querySelectorAll(sel); } catch (e) { continue; }
                if (!els.length) continue;
                collect(els[els.length - 1], bag);
                if (bag.length) break;
            }
        }
        const download = async (url) => {
            try {
                const resp = await fetch(url, {credentials: 'include'});
                if (!resp.ok) return null;
                const blob = await resp.blob();
                if (!blob.size || blob.size > maxBytes) return null;
                return await new Promise((res, rej) => {
                    const fr = new FileReader();
                    fr.onload = () => res(fr.result);
                    fr.onerror = rej;
                    fr.readAsDataURL(blob);
                });
            } catch (e) { return null; }
        };
        const seen = new Set(), out = [];
        for (const src of bag) {
            if (!src || seen.has(src)) continue;
            seen.add(src);
            if (src.startsWith('blob:') || /^https?:\\/\\//.test(src)) {
                const dataUrl = await download(src);
                if (dataUrl) { out.push(dataUrl); }
                else if (/^https?:\\/\\//.test(src)) { out.push(src); }
            } else if (src.startsWith('data:')) {
                if (src.length <= maxBytes * 1.4) out.push(src);
            }
            if (out.length >= 8) break;
        }
        return out;
    })"""
    try:
        imgs = await page.evaluate(js, {"sels": site.answer_selectors, "maxBytes": 2_000_000})
    except Exception as exc:
        logger.warning("Image scrape failed for %s: %s", site.id, exc)
        return []
    seen: set[str] = set()
    out: list[str] = []
    for src in imgs or []:
        if src not in seen:
            seen.add(src)
            out.append(src)
        if len(out) >= limit:
            break
    return out


# Selectors proving a model is still generating (answer not final yet).
GENERATING_SELECTORS: dict[str, tuple[str, ...]] = {
    "deepseek": (
        ".ds-cursor",
        ".ds-loading",
        "[class*='loading']",
        "[class*='generating']",
        "[class*='stop']",
        "button:has-text('Stop')",
    ),
    "chatgpt": (
        "button[data-testid='stop-button']",
        "button[aria-label*='Stop' i]",
    ),
    "claude": ("button[aria-label*='Stop' i]",),
    "gemini": ("button[aria-label*='Stop' i]",),
    "grok": ("button[aria-label*='Stop' i]",),
    "qwen": ("button[aria-label*='Stop' i]",),
    "perplexity": ("button[aria-label*='Stop' i]",),
}


async def _is_generating(page, site: BrowserSite) -> bool:
    for sel in GENERATING_SELECTORS.get(site.id, ()):
        try:
            loc = page.locator(sel).first
            if await loc.count() > 0 and await loc.is_visible():
                return True
        except Exception:
            continue
    return False


# "Continue"/"Continue generating" buttons: the model paused mid-answer
# (long outputs on DeepSeek hit its length cap). Clicking resumes instead of
# returning a truncated half-JSON that can never parse — nobody should have
# to press it by hand.
CONTINUE_SELECTORS: tuple[str, ...] = (
    "button:has-text('Continue generating')",
    "button:has-text('Continue')",
    "button[aria-label*='Continue' i]",
    "[role='button']:has-text('Continue generating')",
    "[role='button']:has-text('Continue')",
    "div:has(> svg):has-text('Continue')",
)


async def _click_continue(page, attempts: int = 3) -> bool:
    """Click a visible Continue button. Returns True if one was clicked.

    Retries a few times: the button often renders below the fold or appears
    late, and a single check misses it. Scrolls it into view first since
    an off-screen button reports visible but rejects the click.
    """
    for _ in range(max(1, attempts)):
        for sel in CONTINUE_SELECTORS:
            try:
                loc = page.locator(sel).first
                if await loc.count() > 0 and await loc.is_visible() and await loc.is_enabled():
                    try:
                        await loc.scroll_into_view_if_needed(timeout=2_000)
                    except Exception:
                        pass
                    await loc.click(timeout=3_000)
                    await asyncio.sleep(1.5)
                    return True
            except Exception:
                continue
        await asyncio.sleep(1.0)
    return False


async def _count_answer_images(page, site: BrowserSite) -> int:
    try:
        return int(
            await page.evaluate(
                """(sels) => {
                    let n = 0;
                    for (const sel of sels) {
                        try {
                            const els = document.querySelectorAll(sel);
                            if (els.length) n += els[els.length - 1].querySelectorAll('img').length;
                        } catch (e) { /* ignore */ }
                    }
                    return n;
                }""",
                site.answer_selectors,
            )
        )
    except Exception:
        return 0


async def wait_for_answer(
    page,
    site: BrowserSite,
    min_len: int = 0,
    timeout_s: int = ANSWER_TIMEOUT_S,
    on_partial=None,
    prev_last: str = "",
    sent_query: str = "",
) -> str:
    """Poll the latest bubble; optionally stream growing text via on_partial.

    Image generations take minutes, so the budget EXTENDS while progress is
    observed (growing text or new images): up to 8 minutes total, giving up
    only after 90s of complete stillness. Pure-image answers (no text) also
    complete once images stop arriving.
    """
    import time as _time

    hard_cap = max(timeout_s, 480.0)
    stall_limit = 90.0
    start = _time.time()
    last_progress = start
    last = ""
    stable = 0
    empty_stable = 0
    img_stable = 0
    last_img_count = 0
    last_emit = 0.0
    normalized_query = " ".join(sent_query.split()).casefold()
    while True:
        now = _time.time()
        if now - start >= hard_cap:
            break
        bubbles = await read_bubbles(page, site)
        current = ""
        if bubbles:
            candidate = bubbles[-1].strip()
            # Some provider selectors (notably DeepSeek's generic message
            # fallback) also match the user turn. Never surface the submitted
            # prompt as if it were the model's answer.
            is_submitted_prompt = bool(normalized_query) and " ".join(candidate.split()).casefold() == normalized_query
            # New content = bubble count grew past the pre-send snapshot OR
            # the last bubble's text changed. Text comparison matters on
            # reused tabs with history: selector result sets fluctuate, so
            # the count alone can sit at/below min_len while the fresh
            # answer streams right in front of us (the phantom-stall 502).
            if candidate and not is_submitted_prompt and (len(bubbles) > min_len or candidate != prev_last):
                current = candidate
        img_count = await _count_answer_images(page, site)
        progressed = (current and current != last) or (img_count != last_img_count)
        if progressed:
            last_progress = now
            stable = 0
            img_stable = 0
            if current and current != last:
                last = current
                if on_partial is not None and now - last_emit >= 0.8:
                    last_emit = now
                    try:
                        if asyncio.iscoroutinefunction(on_partial):
                            await on_partial(current)
                        else:
                            on_partial(current)
                    except Exception:
                        pass
            last_img_count = img_count
        else:
            if current and current == last:
                stable += 1
            if not current:
                empty_stable += 1
            else:
                empty_stable = 0
            if img_count > 0:
                img_stable += 1
            # Stalled text but a Continue button is showing: resume generation
            # and treat it as progress (resets the stall timer). Checked
            # before the stable>=4 early-return so long writes are never
            # returned truncated.
            if stable >= 2 or empty_stable >= 4:
                try:
                    if await _click_continue(page):
                        last_progress = _time.time()
                        stable = 0
                        empty_stable = 0
                        await asyncio.sleep(0.5)
                        continue
                except Exception:
                    pass
            if (
                current
                and stable >= 4
                and not await _is_generating(page, site)
            ):
                # One last sweep: a Continue button may have appeared between
                # the generating check and now (DeepSeek renders it late).
                try:
                    if await _click_continue(page):
                        last_progress = _time.time()
                        stable = 0
                        await asyncio.sleep(0.5)
                        continue
                except Exception:
                    pass
                return current
            # Image-only answer: pictures arrived and nothing moves.
            if not current and img_count > 0 and img_stable >= 8:
                return ""
            if now - last_progress >= stall_limit:
                # Before giving up on a stall, try Continue once more: the
                # model may have hit its length cap exactly as polling
                # observed stillness (button renders late). A click buys a
                # fresh stall window instead of a truncated half-answer.
                try:
                    if await _click_continue(page, attempts=2):
                        last_progress = _time.time()
                        stable = 0
                        empty_stable = 0
                        await asyncio.sleep(0.5)
                        continue
                except Exception:
                    pass
                # DeepSeek "thinking" phases show no text for minutes while
                # the stop/cursor indicator is live — that is progress, not a
                # stall. Reset the timer instead of abandoning an answer that
                # was actually on its way (up to the hard cap).
                try:
                    if await _is_generating(page, site):
                        last_progress = now
                        await asyncio.sleep(0.5)
                        continue
                except Exception:
                    pass
                break
        await asyncio.sleep(0.5)
    if last:
        return last
    raise TimeoutError(
        f"Timeout waiting for {site.label} answer "
        f"(no progress for {stall_limit:.0f}s)"
    )


async def run_model_task(
    site_id: str,
    query: str,
    file_paths: list[str] | None = None,
    images_base64: list[str] | None = None,
    on_partial=None,
    conversation_id: str | None = None,
) -> tuple[str, list[str]]:
    """Run one prompt against one site.

    Returns ``(answer_text, image_urls)``. Raises on failure (including
    ``NOT_LOGGED_IN`` when the site needs an interactive login).
    """
    if async_playwright is None:
        raise RuntimeError("Playwright is not installed. Run: pip install -r requirements.txt")
    site = get_site(site_id)
    query, file_paths = resolve_query_and_files(
        query, file_paths, images_base64
    )
    stored_query = query
    logger.info("Asking %s: %s", site_id, query[:80])
    async with async_playwright() as p:
        context = await get_browser_context(p)
        page, _ = await get_or_create_page(context, site)
        conv = load_conversation(site_id, conversation_id) if conversation_id else None
        remote_url = str((conv or {}).get("remote_url") or "")
        previous = recent_messages(site_id, limit=50, conversation_id=conversation_id) if conversation_id else []
        if remote_url:
            from urllib.parse import urlparse
            if _provider_host(urlparse(remote_url).hostname, site.domain_keywords) and page.url != remote_url:
                try:
                    await page.goto(remote_url, wait_until="domcontentloaded", timeout=30_000)
                except Exception as exc:
                    logger.warning("Could not restore conversation URL %s: %s", remote_url, exc)
        elif conversation_id and previous:
            # Resuming a saved thread without a provider URL: keep the
            # current tab (do NOT click New Chat and wipe native history);
            # context is re-injected below as SAVED CONVERSATION.
            pass
        if conversation_id and previous:
            # Always re-inject local transcript when resuming: provider tabs
            # paginate/collapse history and remote_url may be stale, which
            # previously looked like "forgetting in the same chat".
            try:
                bubbles = await read_bubbles(page, site)
                native_has_context = any(
                    (previous[-1]["content"][:120] in b) if previous and b else False
                    for b in bubbles[-3:]
                ) if bubbles and previous else False
            except Exception:
                native_has_context = False
            if not native_has_context:
                transcript = "\n".join(
                    f"{item['role'].upper()}: {item['content']}" for item in previous
                )[-32_000:]
                query = (
                    "Continue this saved conversation. Prior messages are included for context; "
                    "answer the latest user message at the end.\n\n"
                    f"SAVED CONVERSATION:\n{transcript}\n\nLATEST USER MESSAGE:\n{query}"
                )
        if not ensure_logged_in(page, site):
            raise RuntimeError(f"NOT_LOGGED_IN: Please log in to {site.label} in the opened Chrome window.")
        try:
            prev_bubbles = await read_bubbles(page, site)
            prev = len(prev_bubbles)
            prev_last = prev_bubbles[-1].strip() if prev_bubbles else ""
        except Exception:
            prev = 0
            prev_last = ""
        save_message(site_id, "user", stored_query, conversation_id)
        await send_message(page, site, query, file_paths)
        answer = await wait_for_answer(
            page, site, min_len=prev, on_partial=on_partial,
            prev_last=prev_last, sent_query=query,
        )
        images = await read_answer_images(page, site)
        save_message(site_id, "assistant", answer, conversation_id)
        if conversation_id:
            update_remote_url(site_id, conversation_id, page.url)
        return answer, images


async def _start_new_conversation(page: Page, site: BrowserSite) -> None:
    """Open a new provider thread, falling back to its home page if needed."""
    for selector in site.new_chat_candidates:
        try:
            locator = page.locator(selector).first
            if await locator.is_visible(timeout=350):
                await locator.click(timeout=2_000)
                await page.wait_for_timeout(350)
                return
        except Exception:
            continue
    await page.goto(site.url, wait_until="domcontentloaded", timeout=30_000)


async def start_new_conversation(site_id: str) -> str:
    if async_playwright is None:
        raise RuntimeError("Playwright is not installed. Run: pip install -r requirements.txt")
    site = get_site(site_id)
    async with async_playwright() as p:
        context = await get_browser_context(p)
        page, _ = await get_or_create_page(context, site)
        if not ensure_logged_in(page, site):
            raise RuntimeError(f"NOT_LOGGED_IN: Please log in to {site.label} in the opened Chrome window.")
        await _start_new_conversation(page, site)
        return page.url


async def open_conversation(site_id: str, remote_url: str) -> None:
    from urllib.parse import urlparse
    site = get_site(site_id)
    parsed = urlparse(remote_url)
    if parsed.scheme != "https" or not _provider_host(parsed.hostname, site.domain_keywords):
        raise ValueError("Saved conversation URL does not belong to the selected provider.")
    async with async_playwright() as p:
        context = await get_browser_context(p)
        page, _ = await get_or_create_page(context, site)
        await page.goto(remote_url, wait_until="domcontentloaded", timeout=30_000)


async def check_login(site_id: str, create: bool = False, launch: bool = False) -> dict:
    """Lightweight login probe that never sends anything.

    With create=False (badge checks) it only inspects tabs that already
    exist — it never opens a site by itself. Pass create=True when the user
    explicitly picked this model so its tab gets opened (implies launch).

    launch=False makes badge sweeps instant: if the browser is down it
    reports chrome_up=False immediately instead of triggering a ~45s cold
    start per call.
    """
    if async_playwright is None:
        raise RuntimeError("Playwright is not installed. Run: pip install -r requirements.txt")
    site = get_site(site_id)
    async with async_playwright() as p:
        try:
            context = await get_browser_context(p, auto_launch=launch or create)
        except Exception:
            return {"site": site_id, "logged_in": None, "chrome_up": False, "url": None, "has_tab": False}
        page, existed = await get_or_create_page(context, site, create=create)
        if page is None:
            return {"site": site_id, "logged_in": None, "chrome_up": True, "url": None, "has_tab": False}
        if not existed:
            # Fresh tab: wait only until it navigates off blank (fast), not
            # for full page load (slow, unnecessary for a URL check).
            deadline = asyncio.get_event_loop().time() + 8.0
            while asyncio.get_event_loop().time() < deadline:
                url = (page.url or "").strip().lower()
                if url and url not in ("about:blank", "chrome://newtab/", "chrome://new-tab-page/"):
                    break
                await asyncio.sleep(0.4)
        logged_in = ensure_logged_in(page, site)
        return {"site": site_id, "logged_in": logged_in, "chrome_up": True, "url": page.url, "has_tab": True}
