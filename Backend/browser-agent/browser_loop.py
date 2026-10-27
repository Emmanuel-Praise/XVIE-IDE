"""Browser-powered xvie workflow — mirrors Backend/xvie-agent/xvie_agent/loop.py.

Same deterministic pipeline as xvie-agent, only the reasoning engine is
swapped: a web LLM driven through :mod:`engine` (Playwright/CDP) instead of
an API ProviderClient.

Mirrored stages (same order, same helpers, same imports):
  1. classify_workflow() -> kind/lane/needs_write_confirmation
  2. get_mode() clamp -> effective allow_write/shell + read-only tool filter
  3. discover_memory_files + build_context_snapshot
  4. build_default_registry (mode-aware)
  5. build_system_prompt + build_mode_system_prompt + plan-compliance nudge
     + inject_design_principles (load_references limit=2) + design self-review
     + bounded_inventory + build_relevant_context
  6. Plan-first gate: file tools BLOCKED until write_plan (same rule as xvie)
  7. Turn loop: browser reasons (JSON tool calls) -> execute locally ->
     feed ToolResults back -> repeat until done / max_turns
  8. VERIFY phase identical to loop.py: validate_changed_file,
     validate_responsive_render, validate_cross_file_consistency,
     validate_layout_pair, collect_design_warnings, run_verification

Web-model contract (JSON only — mirrors browserAgentProtocol.ts):
  {"tools": [{"tool": "read_file", "args": {"path": "index.html"}}]}
  {"done": true, "answer": "<final summary>"}
Plain prose with no JSON = final answer (no edits staged).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

_XVIE_SRC = Path(__file__).resolve().parent.parent / "xvie-agent"
if str(_XVIE_SRC) not in sys.path:
    sys.path.insert(0, str(_XVIE_SRC))

from xvie_agent.tools import ToolContext, build_default_registry  # noqa: E402
from xvie_agent.workflow import classify_workflow  # noqa: E402
from xvie_agent.modes import get_mode  # noqa: E402
from xvie_agent.context import build_context_snapshot, discover_memory_files  # noqa: E402
from xvie_agent.prompting import (  # noqa: E402
    build_mode_system_prompt,
    build_plan_compliance_nudge,
    build_system_prompt,
)
from xvie_agent.design_guidance import (  # noqa: E402
    inject_design_principles,
    prompt_needs_design_guidance,
)
from xvie_agent.execution import (  # noqa: E402
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

import engine  # noqa: E402

BANNED_PATHS = {
    "optional/prefix", "optional/path", "relative/file", "relative/path",
    "workspace-relative/path", "path/to/file", "your/file",
}

_MUTATING_TOOLS = {"write_file", "edit_file", "append_file", "apply_patch",
                   "move_file", "delete_file", "bash", "run_code"}

JSON_CONTRACT = """BROWSER TOOL CONTRACT:
Return exactly one JSON object per turn:
Tool turn: {"tools": [{"tool": "read_file", "args": {"path": "index.html"}}]}
Direct answer: {"tools": [], "answer": "<answer>"}
Finish: {"done": true, "answer": "<summary>"}
Use canonical fields "tool" and "args" and real project-relative paths.
For code changes, call write_plan first for multi-step work. Read existing files before editing; use exact old_str for edit_file. Limit each write_file/append_file content chunk to 6000 decoded characters; use one write action per turn.
Escape quotes and newlines inside JSON strings. Keep the full JSON reply under about 9000 characters. Batch up to 4 independent reads/searches.
Design guidance: respect the project stack/tokens and use semantic, responsive, accessible UI. Guidance is partly advisory; verify structural/syntax checks and report only checks actually performed.
"""


def _has_envelope_shape(obj: dict) -> bool:
    """True when the object looks like a tool envelope rather than an inner fragment."""
    return any(k in obj for k in ("tools", "actions", "files", "done", "answer", "summary"))


def _candidate_objects(text: str) -> list[dict]:
    """All balanced-brace JSON objects in the text (fences first, then raw)."""
    fenced = [m.group(1) for m in re.finditer(r"```(?:json)?\s*([\s\S]*?)```", text, re.IGNORECASE)]
    found: list[dict] = []
    for source in [*fenced, text]:
        idx = source.find("{")
        while idx >= 0:
            obj = _try_parse_from(source, idx)
            if obj is not None:
                found.append(obj)
            idx = source.find("{", idx + 1)
    return found


def collect_tool_calls(text: str) -> list[dict] | None:
    """Collect bare single-action objects (no envelope) from a reply.

    Weak models emit `{"tool":"read_file","args":{...}}` alone, or several in
    a row, instead of `{"tools":[...]}`. Gathers every candidate that carries
    a usable tool name, in order, dropping exact duplicates (models echo the
    same call twice). Returns None when nothing action-shaped exists.
    """
    if not text or "{" not in text:
        return None
    # Scan with spans so objects nested inside an envelope (its own inner
    # actions) are never mistaken for bare calls — that would execute them twice.
    fenced = [m.group(1) for m in re.finditer(r"```(?:json)?\s*([\s\S]*?)```", text, re.IGNORECASE)]
    spans: list[tuple[int, int, dict]] = []
    for source in [*fenced, text]:
        idx = source.find("{")
        while idx >= 0:
            obj = _try_parse_from(source, idx)
            if obj is not None:
                # Re-derive the end offset from the serialized length is
                # unreliable; instead re-scan: _try_parse_from consumes a
                # balanced span — recompute it here.
                depth, quoted, escaped = 0, False, False
                end = -1
                for i in range(idx, len(source)):
                    ch = source[i]
                    if quoted:
                        if escaped:
                            escaped = False
                        elif ch == "\\":
                            escaped = True
                        elif ch == '"':
                            quoted = False
                        continue
                    if ch == '"':
                        quoted = True
                    elif ch == "{":
                        depth += 1
                    elif ch == "}":
                        depth -= 1
                        if depth == 0:
                            end = i
                            break
                spans.append((idx, end, obj))
            idx = source.find("{", idx + 1)
    out: list[dict] = []
    seen: set[str] = set()
    for pos, (start, end, cand) in enumerate(spans):
        if end < 0:
            continue
        # Skip anything nested inside a larger object (envelope contents).
        if any(s < start and e >= end for s, e, _ in spans[:pos] + spans[pos + 1:]):
            continue
        if any(k in cand for k in ("tools", "actions", "files", "done", "answer", "summary")):
            continue  # envelopes take the normal path
        if not isinstance(cand, dict):
            continue
        nested = cand.get("function") if isinstance(cand.get("function"), dict) else {}
        raw_tool: object = ""
        for key in _TOOL_NAME_KEYS:
            val = cand.get(key)
            if isinstance(val, str) and val.strip():
                raw_tool = val
                break
        if not raw_tool and isinstance(nested.get("name"), str):
            raw_tool = nested.get("name")
        if not raw_tool and isinstance(cand.get("type"), str):
            raw_tool = cand.get("type")
        tool = _canonical_tool_name(str(raw_tool) if isinstance(raw_tool, (str, int, float)) else "")
        if not tool or tool == "done":
            continue
        args: object = None
        for key in _TOOL_ARGS_KEYS:
            if isinstance(cand.get(key), (dict, str)):
                args = cand.get(key)
                break
        if args is None and isinstance(nested.get("arguments"), (dict, str)):
            args = nested.get("arguments")
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                continue
        if args is None:
            args = {k: v for k, v in cand.items()
                    if k not in (*_TOOL_NAME_KEYS, *_TOOL_ARGS_KEYS, "id", "function", "type")}
        if not isinstance(args, dict):
            continue
        args.pop("type", None)
        sig = f"{tool}:{json.dumps(args, sort_keys=True)}"
        if sig in seen:
            continue
        seen.add(sig)
        out.append({"tool": tool, "args": args, "id": f"bare-{len(out)}"})
    return out or None


def diagnose_json_failure(text: str) -> str:
    """Name the likely cause of a JSON failure for the repair prompt."""
    if re.search(r"<[a-zA-Z][^<>]*\s[a-zA-Z-]+=\"[^\"]*\"[^<>]*>", text or ""):
        return ("Likely cause: file content contains unescaped double quotes "
                '(e.g. <html lang="en">) — every " inside a JSON string must be '
                'written as \\". Re-send the same action with escaped quotes, '
                "or split it into smaller write_file + append_file chunks.")
    opens = (text or "").count("{")
    closes = (text or "").count("}")
    if opens > closes + 2:
        return ("Likely cause: the reply was cut off mid-JSON (unbalanced braces) — "
                "re-send the same action smaller: write_file with only the first "
                "part of the file, then continue with append_file chunks.")
    return ""


def _salvage_backtrack(text: str, max_ambiguous: int = 14) -> dict | None:
    """Parse JSON with ambiguous quotes via bounded backtracking.

    Strict parsing dies on one bare quote (e.g. `"Segoe UI",` inside HTML/CSS
    content: the closing `"` looks structural because `,` follows). Here every
    in-string `"` followed by `,`/`}`/`]` is a choice point (escape vs close);
    `:`-followed quotes are certain (key closes reopen state reliably, which
    keeps the choice set small). Tries 2^k combinations, capped — beyond the
    cap only the all-escaped greedy attempt runs. Returns the first shaped
    envelope that parses, else None.
    """
    s = text.find("{")
    e = text.rfind("}")
    if s < 0 or e <= s:
        return None
    blob = text[s:e + 1]
    n = len(blob)

    def next_sig(i: int) -> str:
        j = i + 1
        while j < n and blob[j] in " \t\r\n":
            j += 1
        return blob[j] if j < n else ""

    # Pass 1: locate ambiguous quote indices. `:`-quotes resync state, so a
    # wrong assumption at one choice never corrupts later detection for long.
    amb: list[int] = []
    in_string = False
    escaped = False
    for i, ch in enumerate(blob):
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                nxt = next_sig(i)
                if nxt == ":":
                    in_string = False
                elif nxt in (",", "}", "]"):
                    amb.append(i)
            continue
        if ch == '"':
            in_string = True

    def build(escape_set: set[int]) -> str | None:
        out: list[str] = []
        in_s = False
        esc = False
        for i, ch in enumerate(blob):
            if in_s:
                if esc:
                    out.append(ch)
                    esc = False
                    continue
                if ch == "\\":
                    out.append(ch)
                    esc = True
                    continue
                if ch == '"':
                    if i in escape_set:
                        out.append('\\"')
                        continue
                    nxt = next_sig(i)
                    if nxt == ":" or nxt in (",", "}", "]"):
                        out.append(ch)
                        in_s = False
                    else:
                        out.append('\\"')
                    continue
                out.append(ch)
                continue
            out.append(ch)
            if ch == '"':
                in_s = True
        return "".join(out)

    def attempt(mask: set[int]) -> dict | None:
        try:
            obj = json.loads(build(mask))
        except (json.JSONDecodeError, ValueError):
            return None
        return obj if isinstance(obj, dict) and _has_envelope_shape(obj) else None

    if len(amb) <= max_ambiguous:
        # Escape-heavy masks first: content quotes outnumber structural ones.
        masks = sorted(
            (set(j for j in range(len(amb)) if (m >> j) & 1) for m in range(1 << len(amb))),
            key=len,
            reverse=True,
        )
        for mask in masks:
            hit = attempt({amb[j] for j in mask})
            if hit is not None:
                return hit
        return None
    # Too many choices: single greedy attempt (escape everything ambiguous).
    return attempt(set(amb))


def repair_model_json(text: str) -> str | None:
    """Best-effort repair of model JSON with unescaped quotes in string values.

    A `"` met inside a string is structural only when the next non-space char
    is `:`, `,`, `}` or `]` — otherwise it is content (e.g. an HTML attribute
    quote) and is escaped. Raw newlines/tabs inside strings become \\n/\\t.
    Returns repaired text, or None when nothing changed. Strict parsing always
    runs first; the repaired result must still pass shape validation.
    """
    if not text or '"' not in text or "{" not in text:
        return None
    out: list[str] = []
    in_string = False
    escaped = False
    changed = False
    i = 0
    while i < len(text):
        ch = text[i]
        if in_string:
            if escaped:
                out.append(ch)
                escaped = False
            elif ch == "\\":
                out.append(ch)
                escaped = True
            elif ch == '"':
                j = i + 1
                while j < len(text) and text[j] in " \t\r\n":
                    j += 1
                nxt = text[j] if j < len(text) else ""
                if nxt in (":", ",", "}", "]"):
                    out.append(ch)
                    in_string = False
                else:
                    out.append('\\"')
                    changed = True
            elif ch == "\n":
                out.append("\\n")
                changed = True
            elif ch == "\r":
                out.append("\\r")
                changed = True
            elif ch == "\t":
                out.append("\\t")
                changed = True
            else:
                out.append(ch)
        else:
            out.append(ch)
            if ch == '"':
                in_string = True
        i += 1
    return "".join(out) if changed else None


def extract_json(text: str) -> dict:
    if not text or not text.strip():
        raise ValueError("Empty model response.")
    candidates = _candidate_objects(text)
    if not candidates:
        # Best-effort salvage before giving up (unescaped HTML quotes).
        repaired = repair_model_json(text)
        if repaired:
            try:
                return extract_json(repaired)
            except ValueError:
                pass
        salvaged = _salvage_backtrack(text)
        if salvaged is not None:
            return salvaged
        raise ValueError(
            "The model did not return valid JSON. "
            f"{diagnose_json_failure(text)} Re-send ONLY the JSON object."
        )
    # Prefer the envelope over inner fragments: a truncated giant response
    # contains small parseable scraps (e.g. {"path": "."} inside DSML markup)
    # that must never win over the real {tools:[...]} object.
    shaped = [o for o in candidates if _has_envelope_shape(o)]
    pool = shaped or candidates
    best = max(pool, key=lambda o: len(json.dumps(o)))
    if not _has_envelope_shape(best):
        # Only fragments parsed, but a repaired full envelope may hide
        # underneath (bare HTML quotes). Try salvage before settling.
        repaired = repair_model_json(text)
        if repaired:
            try:
                fixed = extract_json(repaired)
                if _has_envelope_shape(fixed):
                    return fixed
            except ValueError:
                pass
        salvaged = _salvage_backtrack(text)
        if salvaged is not None:
            return salvaged
    return best


def _try_parse_from(source: str, start: int):
    depth = 0
    quoted = False
    escaped = False
    for i in range(start, len(source)):
        ch = source[i]
        if quoted:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                quoted = False
            continue
        if ch == '"':
            quoted = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    parsed = json.loads(source[start:i + 1])
                    return parsed if isinstance(parsed, dict) else None
                except json.JSONDecodeError:
                    return None
    return None


_TOOL_NAME_KEYS = ("tool", "name", "tool_name", "toolName", "action", "functionName", "function_name", "cmd", "command")
_TOOL_ARGS_KEYS = ("args", "arguments", "parameters", "params", "input")
# Canonical xvie tool names (mirrors xvie_agent.tools.build_default_registry).
# Frontend aliases map here so both runtimes share one vocabulary.
_TOOL_ALIASES = {
    "list_files": "list_dir",
    "listfiles": "list_dir",
    "list": "list_dir",
    "search_text": "grep_search",
    "search": "grep_search",
    "grep": "grep_search",
    "glob": "glob_search",
    "read": "read_file",
    "write": "write_file",
    "edit": "edit_file",
    "append": "append_file",
    "finish": "done",
    "complete": "done",
    "think_thought": "think",
}


_KNOWN_TOOLS = frozenset({
    "read_file", "list_dir", "glob_search", "grep_search", "think",
    "write_plan", "mark_task_done", "write_file", "append_file",
    "edit_file", "verify_file", "check_contrast", "read_ui_reference",
    "search_images", "file_size", "bash", "run_code", "done",
    "ask_question",
})


def _canonical_tool_name(raw: str) -> str:
    name = (raw or "").strip()
    lowered = name.lower()
    if lowered in _TOOL_ALIASES:
        return _TOOL_ALIASES[lowered]
    if lowered in _KNOWN_TOOLS:
        return lowered
    return name


def parse_dsml_tool_calls(text: str) -> list[dict] | None:
    """Salvage DeepSeek native DSML <invoke name=...> markup without a repair trip."""
    if not text or "invoke" not in text.lower():
        return None
    import re as _re
    opens = [(m.group(1).strip(), m.end()) for m in _re.finditer(r'<[^>]*invoke name="([^"]+)"[^>]*>', text, _re.IGNORECASE)]
    if not opens:
        return None
    closes = [m.start() for m in _re.finditer(r'</[^>]*invoke>', text, _re.IGNORECASE)]
    out: list[dict] = []
    for i, (tool, start) in enumerate(opens):
        next_open = opens[i + 1][1] if i + 1 < len(opens) else len(text)
        close_after = next((p for p in closes if p >= start), len(text))
        chunk = text[start:min(next_open, close_after)]
        args: dict = {}
        for pm in _re.finditer(r'<[^>]*parameter name="([^"]+)"[^>]*>([\s\S]*?)(</[^>]*parameter>|$)', chunk, _re.IGNORECASE):
            args[pm.group(1).strip()] = pm.group(2).strip()
        if tool:
            out.append({"tool": _canonical_tool_name(tool), "args": args, "id": f"dsml-{i}"})
    return out or None


def normalise_tool_calls(obj: dict) -> tuple[list[dict], bool, str]:
    if not isinstance(obj, dict):
        raise ValueError("Top-level JSON must be an object.")
    # Accept both backend {done,answer} and frontend {actions,summary,files} envelopes.
    if isinstance(obj.get("actions"), list):
        obj = {"tools": obj["actions"], **({"answer": obj["summary"]} if isinstance(obj.get("summary"), str) else {})}
    if isinstance(obj.get("files"), list) and not obj.get("tools"):
        # One-shot file proposal (frontend legacy) — handled by caller; treat as done here.
        return [], True, str(obj.get("summary", "Done."))
    if isinstance(obj.get("tools"), list) and not obj["tools"]:
        # Direct answer needing no tools (greeting / plain question).
        answer = obj.get("answer", obj.get("summary", obj.get("message", "")))
        if isinstance(answer, str) and answer.strip():
            return [], True, answer
    has_tool_key = any(
        (isinstance(c, dict) and any(k in c for k in (*_TOOL_NAME_KEYS, "function", "type")))
        for c in ([obj] if isinstance(obj, dict) else [])
    )
    if obj.get("done") is True or ("answer" in obj and "tools" not in obj and not has_tool_key):
        return [], True, str(obj.get("answer", obj.get("summary", "Done.")))
    raw_calls = obj["tools"] if isinstance(obj.get("tools"), list) else ([obj] if has_tool_key else None)
    if raw_calls is None:
        raise ValueError("Expected {tools:[...]} or {done:true,answer:...}.")
    norm = []
    for n, c in enumerate(raw_calls):
        if not isinstance(c, dict):
            raise ValueError(f"Tool action #{n} must be an object. Tool action is missing its name.")
        nested = c.get("function") if isinstance(c.get("function"), dict) else {}
        raw_tool = next((c.get(k) for k in _TOOL_NAME_KEYS if isinstance(c.get(k), str) and c.get(k).strip()), "")
        if not raw_tool and isinstance(nested.get("name"), str):
            raw_tool = nested.get("name")
        if not raw_tool and isinstance(c.get("type"), str):
            raw_tool = c.get("type")
        tool = _canonical_tool_name(str(raw_tool) if isinstance(raw_tool, (str, int, float)) else "")
        if not tool or tool == "done":
            if tool == "done":
                return [], True, str(c.get("answer", c.get("summary", "Done.")))
            raise ValueError(f"Tool action #{n} is missing its name (Tool action is missing its name). Got keys: {sorted(c.keys())}.")
        raw_args = next((c.get(k) for k in _TOOL_ARGS_KEYS if isinstance(c.get(k), (dict, str))), None)
        if raw_args is None and isinstance(nested.get("arguments"), (dict, str)):
            raw_args = nested.get("arguments")
        if isinstance(raw_args, str):
            try:
                raw_args = json.loads(raw_args)
            except json.JSONDecodeError:
                raise ValueError(f"Tool call #{n} 'args' were not valid JSON.")
        if raw_args is None:
            # Flat args beside the tool name (DeepSeek {type, path} style).
            raw_args = {k: v for k, v in c.items() if k not in (*_TOOL_NAME_KEYS, *_TOOL_ARGS_KEYS, "id", "function", "type")}
        if not isinstance(raw_args, dict):
            raise ValueError(f"Tool call #{n} 'args' must be an object.")
        raw_args.pop("type", None)  # DeepSeek echoes its discriminator inside args
        norm.append({"tool": tool, "args": raw_args, "id": str(c.get("id", f"browser-{n}"))})
    return norm, False, ""


def _is_placeholder(path: str) -> bool:
    return path.replace("\\", "/").lstrip("./").lower() in BANNED_PATHS


@dataclass
class BrowserTaskResult:
    final_output: str
    turns: int
    tool_calls: list = field(default_factory=list)
    stop_reason: str = "completed"
    transcript: list = field(default_factory=list)
    changed_files: list = field(default_factory=list)
    verification_outcome: str | None = None


def _build_system_prompt(task: str, root: Path, tools: dict, read_only: bool,
                         mode: str, lane: str | None) -> str:
    """Identical assembly to loop.py run_agent (minus provider/router)."""
    memory = discover_memory_files(root)
    snapshot = build_context_snapshot(root)
    system = build_system_prompt(memory=memory, context_snapshot=snapshot,
                                 tool_names=sorted(tools.keys()), read_only=read_only)
    mode_prompt = build_mode_system_prompt(mode)
    if mode_prompt:
        system += "\n\n" + mode_prompt
    # Plan-compliance nudge: browser models are weak -> always inject (like unknown).
    if not read_only:
        nudge = build_plan_compliance_nudge("unknown")
        if nudge:
            system += "\n\n" + nudge
    # Design system (same 3 layers as xvie: core taste + router refs +
    # discovery/memory via inject_design_principles).
    routed = None
    needs_design = prompt_needs_design_guidance(task) or (lane or "") == "ui_design"
    if needs_design:
        try:
            from xvie_agent.design_router import load_references
            routed = load_references(task, limit=2)
        except Exception as exc:
            logger.warning("Design references unavailable: %s", exc)
            routed = None
    system = inject_design_principles(system, lane or "", task,
                                      workspace_root=root, routed=routed)
    if needs_design:
        system += (
            "\n\n<design-self-review>Before finishing, check that the page "
            "matches the brief, has clear hierarchy, responsive behavior, "
            "accessible contrast and focus, and no placeholder content. Fix "
            "concrete issues only; do not add sections to satisfy a generic "
            "checklist.</design-self-review>"
        )
    # Bounded workspace map + high-signal context (same as xvie, no model calls).
    inventory = bounded_inventory(root)
    if inventory:
        system += "\n\n<workspace-inventory>\n" + "\n".join(inventory) + "\n</workspace-inventory>"
    relevant = build_relevant_context(root, task)
    if relevant.strip():
        system += "\n\n<project-context>\n" + relevant + "\n</project-context>"
    return system


def _auto_chunk_write(name: str, args: dict) -> list[tuple[str, dict]]:
    """Split an oversized write_file into write + append chunks server-side.

    Web models routinely ignore the first-chunk rule and emit the whole
    file at once, which tools.py rejects as content_too_large and burns a
    turn. Splitting here saves the round-trip.
    """
    if name != "write_file":
        return [(name, args)]
    content = args.get("content")
    if not isinstance(content, str) or len(content) <= 6000:
        return [(name, args)]
    chunks = [content[i:i + 6000] for i in range(0, len(content), 6000)]
    seq = [("write_file", {**args, "content": chunks[0]})]
    seq += [("append_file", {"path": args.get("path"), "content": ch}) for ch in chunks[1:]]
    return seq


def _execute_calls(registry: dict, ctx: ToolContext, calls: list[dict],
                   has_plan: bool, on_event=None) -> tuple[list[dict], bool]:
    """Execute tool calls locally. Returns (results, new_has_plan)."""
    results = []
    # Track files read this run so edit_file failures can name the fix
    # (stale copy vs non-unique anchor) instead of looping 15 turns.
    if not hasattr(ctx, "_browser_read_paths"):
        ctx._browser_read_paths = set()  # type: ignore[attr-defined]
    for c in calls:
        name, args, cid = c["tool"], c["args"], c["id"]
        # --- Clarifying questions: surface to UI, then continue with best guess ---
        if name == "ask_question":
            questions = args.get("questions", []) if isinstance(args, dict) else []
            if isinstance(questions, dict):
                questions = [questions]
            norm: list[dict] = []
            for i, q in enumerate(questions[:4] if isinstance(questions, list) else []):
                if not isinstance(q, dict):
                    continue
                qid = str(q.get("id", f"q{i+1}")).strip() or f"q{i+1}"
                text = str(q.get("question", "")).strip()
                if not text:
                    continue
                opts: list[dict] = []
                for opt in (q.get("options", []) or [])[:5]:
                    if isinstance(opt, str) and opt.strip():
                        opts.append({"label": opt.strip()})
                    elif isinstance(opt, dict) and str(opt.get("label", "")).strip():
                        opts.append({"label": str(opt["label"]).strip()[:120],
                                     "description": str(opt.get("description", ""))[:240]})
                norm.append({"id": qid[:64], "question": text[:1000],
                             "header": str(q.get("header", ""))[:80],
                             "options": opts,
                             "allow_custom": bool(q.get("allow_custom", True))})
            if not norm:
                results.append({"tool_call_id": cid, "ok": False, "error_kind": "invalid_arguments",
                                "content": "ask_question needs a non-empty 'questions' list with 'id' + 'question'."})
                continue
            if on_event is not None:
                try:
                    evt = {"type": "question_required", "questions": norm}
                    res = on_event(evt) if not asyncio.iscoroutinefunction(on_event) else None
                    # Sync callbacks may return answers directly.
                    if isinstance(res, list) and res:
                        by_id = {a.get("id"): a for a in res if isinstance(a, dict)}
                        lines = ["User answers:"]
                        for q in norm:
                            a = by_id.get(q["id"], {})
                            sel = a.get("selected", []) if isinstance(a, dict) else []
                            cust = str(a.get("custom_text", "")).strip() if isinstance(a, dict) else ""
                            parts = []
                            if sel:
                                parts.append("selected: " + ", ".join(str(s) for s in sel[:5]))
                            if cust:
                                parts.append(f"custom: {cust[:1000]}")
                            lines.append(f"- {q['id']}: {'; '.join(parts) if parts else '(skipped)'}")
                        lines.append("Continue the task using these answers.")
                        results.append({"tool_call_id": cid, "ok": True, "content": "\n".join(lines)})
                        continue
                except Exception:
                    pass
                try:
                    evt2 = {"type": "note", "message": f"questions asked ({len(norm)}); waiting for user in UI"}
                    on_event(evt2) if not asyncio.iscoroutinefunction(on_event) else None
                except Exception:
                    pass
            results.append({"tool_call_id": cid, "ok": True, "error_kind": "awaiting_input",
                            "content": ("Questions for the user (answer in UI, then continue with best guess):\n"
                                        + "\n".join(f"- {q['id']}: {q['question']}" for q in norm))})
            continue
        for key in ("path",):
            if isinstance(args.get(key), str) and _is_placeholder(args[key]):
                results.append({"tool_call_id": cid, "ok": False,
                                "content": f"Rejected placeholder path '{args[key]}'. Use a real workspace-relative path."})
                break
        else:
            # Plan-first gate — identical rule to xvie: file tools BLOCKED until plan.
            if name in _MUTATING_TOOLS and name not in ("bash", "run_code") and not has_plan:
                # Heuristic matching xvie RULE 1: multi-file/multi-step tasks need a plan.
                results.append({"tool_call_id": cid, "ok": False, "error_kind": "plan_required",
                                "content": "File tools are BLOCKED until a plan exists. Call write_plan(title, summary, steps) first with files_touched per step, then retry."})
                continue
            tool = registry.get(name)
            if tool is None:
                results.append({"tool_call_id": cid, "ok": False,
                                "content": f"Unknown tool '{name}'. Available: {', '.join(sorted(registry))}."})
                continue
            try:
                # Auto-chunk oversized writes instead of rejecting the turn.
                seq = _auto_chunk_write(name, args)
                combined: list[str] = []
                ok_all = True
                err_kind = None
                for sub_name, sub_args in seq:
                    sub_tool = registry.get(sub_name)
                    if sub_tool is None:
                        ok_all = False
                        combined.append(f"Unknown tool '{sub_name}'.")
                        break
                    out = sub_tool.handler(sub_args, ctx)
                    chunk = out.content if len(out.content) <= 20000 else out.content[:20000] + "\n[truncated]"
                    combined.append(f"[{sub_name}] {chunk}")
                    if not out.ok:
                        ok_all = False
                        err_kind = out.error_kind
                        break
                    if sub_name == "write_plan":
                        has_plan = True
                    if sub_name == "read_file" and isinstance(sub_args.get("path"), str):
                        ctx._browser_read_paths.add(str(sub_args["path"]))  # type: ignore[attr-defined]
                content = "\n".join(combined)
                if len(seq) > 1:
                    content = f"Auto-split {len(args.get('content', ''))} chars into {len(seq)} chunks. " + content
                entry: dict = {"tool_call_id": cid, "ok": ok_all, "content": content}
                if err_kind:
                    entry["error_kind"] = err_kind
                # Actionable edit_file hint: stale copy vs non-unique anchor.
                if not ok_all and name == "edit_file" and isinstance(args.get("path"), str):
                    read_yet = args["path"] in ctx._browser_read_paths  # type: ignore[attr-defined]
                    hint = (" read_file that path first, then copy old_str verbatim (whitespace-exact)."
                            if not read_yet else
                            " re-read the file: your old_str is stale or appears 0/2+ times. Copy a longer exact block including surrounding lines so it matches exactly once.")
                    entry["content"] += hint
                results.append(entry)
                if name == "write_plan" and ok_all:
                    has_plan = True
            except Exception as exc:
                results.append({"tool_call_id": cid, "ok": False, "content": f"{type(exc).__name__}: {exc}"})
        continue
    return results, has_plan


async def _emit_question_event_async(on_event, calls: list[dict]) -> None:
    """Awaitable question_required emit for async run_browser_task callers."""
    if not on_event:
        return
    qs: list = []
    for c in calls:
        if c.get("tool") == "ask_question" and isinstance(c.get("args"), dict):
            q = c["args"].get("questions", [])
            qs = q if isinstance(q, list) else [q]
            break
    if not qs:
        return
    try:
        evt = {"type": "question_required", "questions": qs}
        if asyncio.iscoroutinefunction(on_event):
            await on_event(evt)
        else:
            on_event(evt)
    except Exception:
        pass


def _verify_phase(task: str, root: Path, changed: list[str],
                  allow_shell: bool, command_timeout: int = 30) -> tuple[str, str | None, str]:
    """Mirror of loop.py post-run VERIFY. Returns (suffix, outcome, command)."""
    if not changed:
        return "", None, ""
    rich_html = is_website_task(task)
    errors = [e for p in changed if (e := validate_changed_file(p, root, rich_html=rich_html))]
    if not errors and rich_html:
        for p in changed:
            if p.lower().endswith((".html", ".htm")):
                if (e := validate_responsive_render(p, root)):
                    errors.append(e)
    if not errors and rich_html:
        if (e := validate_cross_file_consistency(root, changed)):
            errors.append(e)
    if not errors and rich_html:
        htmls = [p for p in changed if p.endswith((".html", ".htm"))]
        csss = [p for p in changed if p.endswith(".css")]
        for hp in htmls:
            ht = (root / hp).resolve()
            if not ht.exists():
                continue
            try:
                html_content = ht.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for cp in csss:
                ct = (root / cp).resolve()
                if not ct.exists():
                    continue
                try:
                    css_content = ct.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                if (e := validate_layout_pair(html_content, css_content, hp)):
                    errors.append(e)
    warnings: list[str] = []
    if rich_html:
        for p in changed:
            if p.endswith((".html", ".htm", ".css")):
                warnings.extend(collect_design_warnings(root, p))
    if errors:
        return ("\n\nValidation failed (changes saved, resume to continue):\n" + "\n".join(errors),
                "failed", "")
    non_testable = {".html", ".htm", ".css", ".md", ".txt"}
    testable = [p for p in changed if Path(p).suffix.lower() not in non_testable]
    cmd = detect_verification_command(root) if testable else ""
    if cmd and allow_shell:
        passed, output = run_verification(cmd, root, command_timeout)
        suffix = "\n\nVerification passed." if passed else f"\n\nVerification failed:\n{output}"
        return suffix, ("passed" if passed else "failed"), cmd
    suffix = ""
    if warnings:
        seen = list(dict.fromkeys(warnings))[:10]
        suffix = "\n\nDesign warnings (advisory):\n" + "\n".join(f"  - {w}" for w in seen)
    return suffix, "not_available", cmd


async def run_browser_task(
    site: str,
    task: str,
    workspace_root: str | None = None,
    max_turns: int = 8,
    conversation_id: str | None = None,
    mode: str = "code",
    on_event=None,
) -> BrowserTaskResult:
    root = Path(workspace_root or os.getcwd()).resolve()

    # -- 1. Classify + mode clamp (exact copy of loop.py logic) --
    from xvie_agent.modes import VALID_MODES as _VALID_MODES
    normalized_mode = (mode or "code").lower().strip()
    if normalized_mode not in _VALID_MODES:
        normalized_mode = "code"
    mode = normalized_mode
    workflow = classify_workflow(task)
    mode_config = get_mode(mode)
    effective_write = True and mode_config.allow_write  # autonomous: user approved
    effective_shell = True and mode_config.allow_shell
    read_only = not mode_config.allow_write and not mode_config.allow_shell

    # -- 2. Registry (mode-aware, same filtering as xvie loop.py) --
    tool_ctx = ToolContext(workspace_root=root, allow_write=effective_write,
                           allow_shell=effective_shell, command_timeout_seconds=30)
    tools = build_default_registry(tool_ctx, allow_web=mode_config.allow_web_search)
    if read_only:
        keep = set(mode_config.tools_always_on)
        if mode_config.allow_web_search:
            keep |= {"web_search", "web_fetch"}
        if mode == "plan":
            keep |= {"mark_task_done", "write_plan"}
            keep |= {"read_ui_reference", "check_contrast", "verify_file"}
            if mode_config.allow_web_search:
                keep |= {"search_images"}
        tools = {k: v for k, v in tools.items() if k in keep}
        tool_ctx = ToolContext(workspace_root=root, allow_write=False, allow_shell=False)

    # -- 3. System prompt (same assembly as xvie) + browser JSON wrapper --
    lane = mode_config.lane_override or workflow.lane
    if prompt_needs_design_guidance(task) and not mode_config.lane_override:
        lane = "ui_design"
    system = _build_system_prompt(task, root, tools, read_only, mode, lane)
    # Browser models need the JSON envelope stated up-front (they ignore
    # function-calling schemas, so the contract rides in-band).
    system += "\n\n" + JSON_CONTRACT

    transcript: list[dict] = []
    all_calls: list = []
    changed: list[str] = []
    has_plan = False
    pending = ""
    final_answer = ""

    # Per-turn ceiling: one hung model answer must never eat the whole run
    # budget. Engine caps a single answer at ~8 min; we bound the round-trip
    # slightly above that so the loop can retry or finish partial instead.
    TURN_TIMEOUT_S = 500.0

    async def _ask_site(text: str) -> str:
        started_at = time.perf_counter()
        first_partial_ms: int | None = None

        async def on_partial(_text: str) -> None:
            nonlocal first_partial_ms
            if first_partial_ms is None:
                first_partial_ms = round((time.perf_counter() - started_at) * 1000)
                logger.info("browser_agent_timing stage=first_partial site=%s duration_ms=%d", site, first_partial_ms)

        try:
            answer, _ = await asyncio.wait_for(
                engine.run_model_task(
                    site, text, conversation_id=conversation_id, on_partial=on_partial,
                ),
                timeout=TURN_TIMEOUT_S,
            )
            logger.info(
                "browser_agent_timing stage=model_turn_complete site=%s duration_ms=%d first_partial_ms=%s",
                site, round((time.perf_counter() - started_at) * 1000), first_partial_ms,
            )
            return answer
        except asyncio.TimeoutError as exc:
            raise RuntimeError(
                f"TURN_TIMEOUT: no answer within {TURN_TIMEOUT_S:.0f}s on turn. "
                f"Your prompt is still in the browser tab; press Show to inspect it."
            ) from exc

    # Single-file chat tasks skip the plan gate (same spirit as xvie RULE 1).
    single_file = len(re.findall(r"[\w./-]+\.(?:html|css|js|ts|py|json|md)", task, re.I)) <= 1 \
        and not re.search(r"\b(and|plus|both|all|every|each|multi|redesign.*css)\b", task, re.I)
    if single_file or workflow.kind in ("chat", "inspect", "suggest"):
        has_plan = True  # no plan required; investigate -> act directly

    for turn in range(1, max_turns + 1):
        if turn == 1:
            prompt = (f"{system}\n\nTASK:\n{task}\n\n"
                      f"Start: investigate with list_dir/read_file if needed, "
                      f"write_plan if multi-step, then implement. At most 4 independent read/search calls; "
                      f"one write action per turn. Keep the JSON reply under ~9000 chars.")
        else:
            prompt = (f"TOOL RESULTS (turn {turn - 1}):\n{pending[:5000]}\n\n"
                      f"Continue TASK:\n{task}\nAt most 4 independent read/search calls, one write action, "
                      f"under ~9000 chars. Return ONLY the next JSON object.")
        if on_event:
            try:
                on_event({"type": "turn", "turn": turn}) if not asyncio.iscoroutinefunction(on_event) \
                    else await on_event({"type": "turn", "turn": turn})
            except Exception:
                pass
        try:
            answer_text = await _ask_site(prompt)
        except RuntimeError:
            raise
        except Exception as exc:
            raise RuntimeError(f"{type(exc).__name__}: {exc}") from exc
        transcript.append({"role": "assistant", "content": answer_text[:4000]})
        dsml_calls = parse_dsml_tool_calls(answer_text)
        if dsml_calls:
            calls, is_done, answer = dsml_calls, False, ""
            if on_event:
                try:
                    evt = {"type": "note", "message": f"native tool calls ({len(dsml_calls)} action(s))"}
                    on_event(evt) if not asyncio.iscoroutinefunction(on_event) else await on_event(evt)
                except Exception:
                    pass
            tools_started_at = time.perf_counter()
            results, has_plan = _execute_calls(tools, tool_ctx, calls, has_plan, on_event)
            logger.info("browser_agent_timing stage=tool_batch site=%s duration_ms=%d calls=%d", site, round((time.perf_counter() - tools_started_at) * 1000), len(calls))
            await _emit_question_event_async(on_event, calls)
            all_calls.extend(calls)
            transcript.append({"role": "tool", "content": json.dumps(results)[:4000]})
            for c in calls:
                p = c["args"].get("path") if isinstance(c["args"], dict) else None
                if c["tool"] in ("write_file", "edit_file", "append_file", "move_file", "delete_file") and p \
                        and p not in changed:
                    changed.append(str(p))
            pending = json.dumps(results, ensure_ascii=False)
            continue
        try:
            obj = extract_json(answer_text)
        except ValueError as exc:
            if "{" in answer_text and not read_only:
                # Looks like attempted tool JSON in a write-capable mode:
                # route through the repair flow instead of silently
                # "completing" with zero edits staged (the old break here
                # ended runs as completed while nothing was written).
                answer_text = (
                    f"Invalid tool JSON: {exc}\n{diagnose_json_failure(answer_text)}\n"
                    f"Original reply:\n{answer_text[:4000]}"
                )
                try:
                    fixed = await _ask_site(
                        f"{answer_text}\nRe-send ONLY valid JSON per protocol:\n{JSON_CONTRACT}")
                    obj = extract_json(fixed)
                    transcript.append({"role": "assistant", "content": fixed[:4000]})
                except Exception as exc2:
                    final_answer = (f"Unusable tool response after retry. No further edits staged. "
                                    f"Last: {answer_text[:1200]} ({exc2})")
                    return BrowserTaskResult(final_answer, turn, all_calls, "bad_json",
                                             transcript, changed, None)
            else:
                final_answer = answer_text.strip()  # chatty model -> final answer
                break
        if not _has_envelope_shape(obj):
            # Bare single-action objects (no envelope) or JSON-lines style:
            # gather every action-shaped candidate instead of settling for
            # one fragment while dropping the rest.
            bare = collect_tool_calls(answer_text)
            if bare:
                obj = {"tools": [{"tool": c["tool"], "args": c["args"]} for c in bare]}
        try:
            calls, is_done, answer = normalise_tool_calls(obj)
        except ValueError as exc:
            # Up to 2 repair rounds with escalating hints: the second names
            # the exact fix (escaping / smaller chunks) instead of repeating
            # the generic contract.
            repair = (
                f"Invalid tool JSON: {exc}. Return one valid object using the required \"tools\" array and canonical \"tool\"/\"args\" fields. "
                f"Escape quotes and newlines inside JSON strings; keep each file chunk at or below 6000 characters.\n"
                f"Last reply: {answer_text[:6000]}"
            )
            calls = None  # type: ignore[assignment]
            for rnd in range(2):
                if rnd == 1:
                    repair = (
                        f"Still unusable ({exc}). {diagnose_json_failure(answer_text)} "
                        "Return one valid tools envelope with escaped JSON strings and file chunks no larger than 6000 characters.\n"
                        f"Last reply: {answer_text[:6000]}"
                    )
                try:
                    repair_started_at = time.perf_counter()
                    fixed = await _ask_site(repair)
                    logger.info("browser_agent_timing stage=json_repair site=%s attempt=%d duration_ms=%d succeeded=true", site, rnd + 1, round((time.perf_counter() - repair_started_at) * 1000))
                    obj = extract_json(fixed)
                    calls, is_done, answer = normalise_tool_calls(obj)
                    transcript.append({"role": "assistant", "content": fixed[:4000]})
                    break
                except Exception as exc2:
                    logger.info("browser_agent_timing stage=json_repair site=%s attempt=%d duration_ms=%d succeeded=false", site, rnd + 1, round((time.perf_counter() - repair_started_at) * 1000))
                    exc = exc2  # type: ignore[assignment]
            else:
                return BrowserTaskResult(
                    f"Unusable tool response after retry. No further edits staged. "
                    f"Last: {answer_text[:1200]} ({exc})",
                    turn, all_calls, "bad_json", transcript, changed, None)
            if calls is None:
                return BrowserTaskResult(
                    f"Unusable tool response after retry. No further edits staged. "
                    f"Last: {answer_text[:1200]} ({exc})",
                    turn, all_calls, "bad_json", transcript, changed, None)
        if is_done:
            final_answer = answer
            break
        # Max 4 tool calls per turn: big batches come from giant replies
        # that risk truncation. Extras are deferred to the next turn.
        if len(calls) > 4:
            transcript.append({"role": "assistant",
                               "content": f"[deferred {len(calls) - 4} extra tool call(s) to next turn]"})
            calls = calls[:4]
        tools_started_at = time.perf_counter()
        results, has_plan = _execute_calls(tools, tool_ctx, calls, has_plan, on_event)
        logger.info("browser_agent_timing stage=tool_batch site=%s duration_ms=%d calls=%d", site, round((time.perf_counter() - tools_started_at) * 1000), len(calls))
        await _emit_question_event_async(on_event, calls)
        all_calls.extend(calls)
        transcript.append({"role": "tool", "content": json.dumps(results)[:4000]})
        for c in calls:
            p = c["args"].get("path") if isinstance(c["args"], dict) else None
            if c["tool"] in ("write_file", "edit_file", "append_file", "move_file", "delete_file") and p \
                    and p not in changed:
                changed.append(str(p))
            if c["tool"] == "apply_patch" and isinstance(c["args"].get("files"), list):
                for e in c["args"]["files"]:
                    if isinstance(e, dict) and e.get("path") and e["path"] not in changed:
                        changed.append(str(e["path"]))
        pending = json.dumps(results, ensure_ascii=False)
    else:
        final_answer = final_answer or "Stopped: max turns reached. Partial work (if any) was applied."

    verification_started_at = time.perf_counter()
    suffix, outcome, _cmd = _verify_phase(task, root, changed, effective_shell)
    logger.info("browser_agent_timing stage=verification site=%s duration_ms=%d files=%d outcome=%s", site, round((time.perf_counter() - verification_started_at) * 1000), len(changed), outcome)
    return BrowserTaskResult(final_answer + suffix, max_turns if not final_answer else turn,
                             all_calls, "completed", transcript, changed, outcome)
