"""Agent loop orchestrator — the core of xvie-agent.

Coordinates:
  1. Sending user queries to the model via :class:`ProviderClient`
  2. Parsing tool calls from the model response
  3. Executing tools via the tool registry
  4. Feeding tool results back to the model
  5. Repeating until the model gives a final text answer or a budget limit is hit

The loop is fully deterministic and headless — no I/O beyond the model
client and tool handlers.  This makes it easy to test with mocks.
"""

from __future__ import annotations

import json
import logging
import queue
import re
import threading
import time
from dataclasses import replace
from pathlib import Path
from typing import Any, Callable, Iterator

from xvie_agent.providers.base import (
    PayloadTooLargeError,
    ProviderClient,
    ProviderError,
    RateLimitedError,
)
from xvie_agent.retry import RetryPolicy, is_transient_error, retry_delay
from xvie_agent.router import AllModelsExhaustedError, ModelRouter
from xvie_agent.redact import redact_secrets
from xvie_agent.execution import (
    validate_changed_file,
    validate_cross_file_consistency,
    validate_layout_pair,
    validate_responsive_render,
)
from xvie_agent.token_budget import calculate_budget, estimate_tokens
from xvie_agent.tools import MAX_WRITE_CONTENT_CHARS, Tool, ToolContext, ToolOutput, build_default_registry
from xvie_agent.types import (
    AgentEvent,
    AgentRunResult,
    AssistantTurn,
    BudgetConfig,
    ToolCall,
    ToolResult,
    UsageStats,
)

logger = logging.getLogger(__name__)

_MUTATING_TOOLS = {"write_file", "edit_file", "append_file", "apply_patch", "move_file", "delete_file", "bash", "run_code"}
_READ_ONLY_TOOLS = {"read_file", "list_dir", "glob_search", "grep_search", "zetaris_query", "zetaris_catalog"}

# Appendix to continuation nudges after repeated output-token cutoffs: the
# cap is hit because one response tries to emit too much at once.
_OUTPUT_CAP_HINT = (
    f" Repeated output-token cutoffs mean one response was too large. Keep "
    f"interim assistant text to 1-2 short lines and build large files in "
    f"chunks of at most {MAX_WRITE_CONTENT_CHARS} chars per call "
    f"(write_file the first part, then append_file for the rest)."
)

# Leading "Thought:" line emitted under the THINKING PROTOCOL (prompting.py).
_THOUGHT_LINE = re.compile(r"^\s*\**\s*Thought\s*:\s*\**\s*(.+?)\s*$", re.IGNORECASE | re.MULTILINE)
_PRIVATE_SCRATCH_START = re.compile(
    r"^\s*(?:the user (?:said|asked)|i should\b|let me (?:check|inspect|look|read)\b)",
    re.IGNORECASE,
)

# Unchecked checklist items in a plan file: "- [ ] **Title** — Description"
_OPEN_TASK_LINE = re.compile(r"^- \[ \] \*\*(.+?)\*\*\s*—?\s*(.*)$", re.MULTILINE)


def _extract_thought(content: str) -> tuple[str, str]:
    """Split a leading ``Thought:`` line from assistant content.

    Returns ``(thought_text, remaining_content)``.  When the content does
    not start with a thought line, returns ``("", content)`` unchanged.
    """
    if not content:
        return "", content
    match = _THOUGHT_LINE.match(content)
    if match and match.group(1).strip():
        return match.group(1).strip(), content[match.end():].lstrip("\n")
    return "", content


def _open_plan_tasks(workspace_root: Path) -> list[str]:
    """Return titles of unchecked tasks in the most recent plan file."""
    plans_dir = workspace_root / ".xvie" / "plans"
    if not plans_dir.is_dir():
        return []
    plans = sorted(plans_dir.glob("*.md"), key=lambda p: p.stat().st_mtime)
    if not plans:
        return []
    try:
        text = plans[-1].read_text(encoding="utf-8")
    except OSError:
        return []
    titles: list[str] = []
    for match in _OPEN_TASK_LINE.finditer(text):
        title = match.group(1).strip()
        if title and title not in titles:
            titles.append(title)
    return titles


def _validate_tool_call(tool: Tool | None, arguments: dict) -> str | None:
    if tool is None:
        return None
    if not isinstance(arguments, dict):
        return "arguments must be a JSON object"
    if "_raw" in arguments:
        return "arguments were not valid JSON"
    missing = [name for name in tool.json_schema.get("required", []) if name not in arguments]
    return f"missing required argument(s): {', '.join(missing)}" if missing else None


def _normalize_questions(raw: object) -> list[dict]:
    """Normalize ask_question args into UI-ready question dicts (max 4)."""
    questions = raw if isinstance(raw, list) else ([raw] if isinstance(raw, dict) else [])
    out: list[dict] = []
    for i, q in enumerate(questions[:4]):
        if not isinstance(q, dict):
            continue
        qid = str(q.get("id", f"q{i+1}")).strip() or f"q{i+1}"
        text = str(q.get("question", "")).strip()
        if not text:
            continue
        header = str(q.get("header", "")).strip()
        allow_custom = q.get("allow_custom", True)
        allow_custom = bool(allow_custom) if isinstance(allow_custom, bool) else True
        opts: list[dict] = []
        for opt in (q.get("options", []) or [])[:5]:
            if isinstance(opt, str) and opt.strip():
                opts.append({"label": opt.strip(), "description": ""})
            elif isinstance(opt, dict) and str(opt.get("label", "")).strip():
                opts.append({
                    "label": str(opt["label"]).strip()[:120],
                    "description": str(opt.get("description", "")).strip()[:240],
                })
        out.append({
            "id": qid[:64],
            "question": text[:1000],
            "header": header[:80],
            "options": opts,
            "allow_custom": allow_custom,
        })
    return out


def _format_question_answers(questions: list[dict], answers: list[dict] | None) -> str:
    """Render user answers as tool-result text for the model."""
    by_id = {a.get("id"): a for a in (answers or []) if isinstance(a, dict)}
    lines = ["User answers:"]
    for q in questions:
        qid = q["id"]
        ans = by_id.get(qid, {})
        selected = ans.get("selected", []) if isinstance(ans, dict) else []
        custom = str(ans.get("custom_text", "")).strip() if isinstance(ans, dict) else ""
        parts: list[str] = []
        if isinstance(selected, list) and selected:
            parts.append("selected: " + ", ".join(str(s) for s in selected[:5]))
        if custom:
            parts.append(f"custom: {custom[:1000]}")
        lines.append(f"- {qid}: {'; '.join(parts) if parts else '(skipped — use your best guess)'}")
    lines.append("Continue the task using these answers.")
    return "\n".join(lines)


def _describe_action(tc: ToolCall) -> str:
    """Build a short human-readable description of a tool call for approval."""
    args = tc.arguments if isinstance(tc.arguments, dict) else {}
    name = tc.name
    if name == "bash":
        return f"run shell command: `{args.get('command', '?')}`"
    if name == "run_code":
        code = str(args.get("code", "")).strip().splitlines()
        first = code[0][:80] if code else "?"
        return f"execute {args.get('language', 'code')}: `{first}`"
    if name == "write_file":
        action = "create" if not Path(str(args.get("path", ""))).exists() else "overwrite"
        return f"{action} file `{args.get('path', '?')}`"
    if name == "append_file":
        return f"append to file `{args.get('path', '?')}`"
    if name == "edit_file":
        return f"edit file `{args.get('path', '?')}`"
    if name == "apply_patch":
        files = args.get("files", [])
        paths = ", ".join(f"`{f.get('path', '?')}`" for f in files[:3]) if isinstance(files, list) else "?"
        return f"patch files: {paths}"
    if name == "move_file":
        return f"move `{args.get('src', '?')}` -> `{args.get('dst', '?')}`"
    if name == "delete_file":
        return f"delete file `{args.get('path', '?')}`"
    return f"run tool {name}"


# ---------------------------------------------------------------------------
# Text-based tool call parser (fallback for weak models)
# ---------------------------------------------------------------------------

def _parse_text_tool_calls(content: str, available_tools: set[str]) -> list[ToolCall]:
    """Detect tool calls embedded in text content.

    Weak models sometimes output tool calls as text instead of using the
    function-calling API.  This parser detects common patterns and converts
    them to proper ToolCall objects.
    """
    if not content or not available_tools:
        return []

    calls: list[ToolCall] = []
    seen: set[str] = set()
    # Pattern: <|python_tag|>tool_name(args) — collect every distinct tool call.
    for match in re.finditer(r'<\|python_tag\|>(\w+)\(([^)]*)\)', content):
        name = match.group(1)
        if name in available_tools and name not in seen:
            seen.add(name)
            args = _parse_args_from_text(match.group(2))
            calls.append(ToolCall(id=f"text_{len(calls)}", name=name, arguments=args))

    # Pattern: tool_name(args) on its own line
    for match in re.finditer(r'^\s*(\w+)\(([^)]*)\)\s*$', content, re.MULTILINE):
        name = match.group(1)
        if name in available_tools and name not in seen:
            seen.add(name)
            args = _parse_args_from_text(match.group(2))
            calls.append(ToolCall(id=f"text_{len(calls)}", name=name, arguments=args))

    # Pattern: {"name": "...", "parameters": {...}} — JSON tool call as text.
    # raw_decode handles nested braces (CSS/JS inside content strings).
    decoder = json.JSONDecoder()
    for match in re.finditer(r'"name"\s*:\s*"(\w+)"', content):
        name = match.group(1)
        if name not in available_tools or name in seen:
            continue
        tail = content[match.end():]
        pm = re.search(r'"(?:parameters|arguments)"\s*:\s*', tail)
        if not pm:
            continue
        try:
            args, _ = decoder.raw_decode(content[match.end() + pm.end():])
        except json.JSONDecodeError:
            continue
        if isinstance(args, dict):
            seen.add(name)
            calls.append(ToolCall(id=f"text_{len(calls)}", name=name, arguments=args))

    return calls


def _looks_like_json_tool_call(content: str, available_tools: set[str]) -> bool:
    """Heuristic: does this text contain a (possibly malformed) JSON tool call?

    Used to refuse garbage answers — a model that emits raw JSON instead of
    using the function-calling API must be nudged to retry, never have its
    JSON dumped on the user as the final answer.
    """
    if not content:
        return False
    stripped = content.lstrip()
    if stripped.startswith('{"') and '"name"' in stripped[:200]:
        return True
    for name in available_tools:
        if re.search(rf'"name"\s*:\s*"{re.escape(name)}"', content):
            return True
    return False


def _parse_args_from_text(args_str: str) -> dict:
    """Parse a simple Python-like args string into a dict."""
    args: dict = {}
    if not args_str.strip():
        return args

    # keyword args with quotes: key="value" or key='value'
    for m in re.finditer(r'(\w+)\s*=\s*["\']([^"\']*)["\']', args_str):
        args[m.group(1)] = m.group(2)

    # keyword args without quotes: key=123, key=True
    for m in re.finditer(r'(\w+)\s*=\s*(\w+)', args_str):
        if m.group(1) not in args:
            val = m.group(2)
            if val.isdigit():
                args[m.group(1)] = int(val)
            elif val.lower() == 'true':
                args[m.group(1)] = True
            elif val.lower() == 'false':
                args[m.group(1)] = False
            else:
                args[m.group(1)] = val

    # Positional string arg -> 'path' (most common)
    if not args and args_str.strip():
        for m in re.finditer(r'["\']([^"\']*)["\']', args_str):
            args['path'] = m.group(1)
            break
        if not args:
            val = args_str.strip().strip('"').strip("'")
            if val:
                args['path'] = val

    return args


# ---------------------------------------------------------------------------
# Small talk detection
# ---------------------------------------------------------------------------

_SMALL_TALK_RE = re.compile(
    r"^\s*(?:"
    r"hi+|hello+|hey+|yo|sup|howdy|greetings"
    r"|good\s+(?:morning|afternoon|evening|day)"
    r"|thanks(?:\s+you)?(?:\s+(?:so|a)\s+lot)?"
    r"|thank\s+you(?:\s+(?:very|so)\s+much)?"
    r"|bye+|goodbye|see\s+ya|later"
    r"|nice|cool|awesome|great|perfect|ok(?:ay)?|got\s?it|sounds\s+good"
    r"|how\s+are\s+you|what'?s\s+up|who\s+are\s+you|what\s+can\s+you\s+do"
    r")\s*[!.?,\s]*$",
    re.IGNORECASE,
)


def _is_small_talk(message: str) -> bool:
    """True for pure greetings/small talk — these need no tools at all."""
    return bool(_SMALL_TALK_RE.match(message))


# ---------------------------------------------------------------------------
# Default system prompt
# ---------------------------------------------------------------------------

DEFAULT_SYSTEM_PROMPT = """\
You are xvie-agent, an AI coding assistant. You help users with software \
engineering tasks by reading, writing, and editing code.

Rules:
- Always use the provided tools when you need to read or modify files.
- Never attempt to access files outside the workspace.
- Be concise in your responses.
- When editing code, make minimal, targeted changes.
- If a tool call fails, explain the error and try an alternative approach.
"""


# ---------------------------------------------------------------------------
# Tool schema conversion
# ---------------------------------------------------------------------------

def _tools_to_openai_format(
    tools: dict[str, Tool],
    tool_ctx: ToolContext | None = None,
) -> list[dict]:
    """Convert the tool registry to OpenAI function-calling format.

    If ``tool_ctx`` is provided, tools requiring disabled permissions are
    excluded — this saves tokens and prevents the model from attempting
    tools it can't use.
    """
    filtered: list[Tool] = []
    write_tools = {"write_file", "edit_file", "append_file", "apply_patch", "move_file", "delete_file"}
    shell_tools = {"bash", "run_code"}
    for tool in tools.values():
        # Skip tools requiring disabled permissions — advertising unusable
        # tools makes weak models attempt them and derail.
        if tool_ctx is not None:
            if tool.name in write_tools and not tool_ctx.allow_write:
                continue
            if tool.name in shell_tools and not tool_ctx.allow_shell:
                continue
        filtered.append(tool)

    return [
        {
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.json_schema,
            },
        }
        for tool in filtered
    ]


def _format_tool_result_as_message(result: ToolResult) -> dict:
    """Convert a ToolResult into an OpenAI tool message."""
    return {
        "role": "tool",
        "tool_call_id": result.tool_call_id,
        "content": result.content,
    }


def _format_tool_calls_as_message(turn: AssistantTurn, tc: ToolCall | None = None) -> dict:
    """Convert the model's tool call(s) into an assistant message dict.

    ``tc`` selects a single call: NVIDIA NIM models reject assistant
    messages containing more than one tool_call ("This model only supports
    single tool-calls at once"), so multi-call turns are recorded as one
    message per call — any model can then resume the conversation.
    """
    calls = [tc] if tc is not None else list(turn.tool_calls)
    message: dict = {"role": "assistant", "content": turn.content or ""}
    if turn.reasoning:
        message["reasoning_content"] = turn.reasoning
    if calls:
        message["tool_calls"] = [
            {
                "id": c.id,
                "type": "function",
                "function": {
                    "name": c.name,
                    "arguments": json.dumps(c.arguments),
                },
            }
            for c in calls
        ]
    return message


def _compact_tool_arguments(raw: Any, limit: int) -> str:
    """Return bounded, valid JSON object text for a historical tool call.

    Provider conversation payloads require ``function.arguments`` to be a JSON
    object string. Truncating that serialized string directly can cut through
    a quoted value and make every model reject the full conversation.
    """
    try:
        value = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, json.JSONDecodeError):
        value = {"_raw": str(raw)}
    if not isinstance(value, dict):
        value = {"_raw": value}

    def shrink(item: Any, string_limit: int) -> Any:
        if isinstance(item, str):
            if len(item) <= string_limit:
                return item
            suffix = f"… [{len(item)} chars; older tool argument compacted]"
            return item[:max(0, string_limit - len(suffix))] + suffix
        if isinstance(item, list):
            kept = [shrink(child, string_limit) for child in item[:20]]
            if len(item) > 20:
                kept.append(f"… [{len(item) - 20} items omitted]")
            return kept
        if isinstance(item, dict):
            pairs = list(item.items())
            result = {str(key): shrink(child, string_limit) for key, child in pairs[:30]}
            if len(pairs) > 30:
                result["_omitted_fields"] = len(pairs) - 30
            return result
        return item

    string_limit = max(64, min(limit // 3, 1200))
    while True:
        encoded = json.dumps(shrink(value, string_limit), ensure_ascii=True)
        if len(encoded) <= limit:
            return encoded
        if string_limit > 64:
            string_limit = max(64, string_limit // 2)
        else:
            return json.dumps({"_omitted": "Older tool arguments compacted"})


def _prepare_messages_for_provider(messages: list[dict]) -> list[dict]:
    """Canonicalize tool arguments so every outgoing call is valid JSON."""
    prepared: list[dict] = []
    for message in messages:
        if message.get("role") != "assistant" or not message.get("tool_calls"):
            prepared.append(message)
            continue
        entry = dict(message)
        calls = []
        for call in message["tool_calls"]:
            normalized = dict(call)
            function = dict(call.get("function", {}))
            raw_arguments = function.get("arguments", "{}")
            try:
                parsed_arguments = json.loads(raw_arguments) if isinstance(raw_arguments, str) else raw_arguments
            except (TypeError, json.JSONDecodeError):
                function["arguments"] = _compact_tool_arguments(raw_arguments, 2000)
            else:
                function["arguments"] = json.dumps(
                    parsed_arguments if isinstance(parsed_arguments, dict) else {"_raw": parsed_arguments},
                    ensure_ascii=True,
                )
            normalized["function"] = function
            calls.append(normalized)
        entry["tool_calls"] = calls
        prepared.append(entry)
    return prepared


# ---------------------------------------------------------------------------
# Budget tracking
# ---------------------------------------------------------------------------

class BudgetTracker:
    """Tracks cumulative usage against a :class:`BudgetConfig`."""

    def __init__(self, config: BudgetConfig) -> None:
        self._config = config
        self.total_usage = UsageStats()
        self.tool_call_count = 0
        self.model_call_count = 0
        self.turn_count = 0
        self._model_calls_by_model: dict[str, int] = {}

    def record_model_call(self, model: str, usage: UsageStats) -> None:
        self.total_usage = self.total_usage + usage
        self.model_call_count += 1
        self._model_calls_by_model[model] = (
            self._model_calls_by_model.get(model, 0) + 1
        )

    def record_tool_call(self) -> None:
        self.tool_call_count += 1

    def record_turn(self) -> None:
        self.turn_count += 1

    @property
    def model_calls_by_model(self) -> dict[str, int]:
        return dict(self._model_calls_by_model)

    def check(self) -> str | None:
        """Return a stop reason string if a limit is exceeded, else ``None``."""
        c = self._config
        if c.max_turns is not None and self.turn_count >= c.max_turns:
            return "max_turns"
        if c.max_total_tokens is not None and self.total_usage.total_tokens >= c.max_total_tokens:
            return "budget_exceeded"
        if c.max_tool_calls is not None and self.tool_call_count >= c.max_tool_calls:
            return "budget_exceeded"
        if c.max_model_calls is not None and self.model_call_count >= c.max_model_calls:
            return "budget_exceeded"
        return None


# ---------------------------------------------------------------------------
# Agent loop
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Context-window management
# ---------------------------------------------------------------------------

def _split_exchange_blocks(messages: list[dict]) -> list[tuple[int, int]]:
    """Split messages into atomic blocks that must be dropped together.

    An assistant message carrying ``tool_calls`` plus its following tool
    results forms one block — cutting between them produces invalid API
    payloads.
    """
    blocks: list[tuple[int, int]] = []
    i = 0
    while i < len(messages):
        msg = messages[i]
        if msg.get("role") == "assistant" and msg.get("tool_calls"):
            j = i + 1
            while j < len(messages) and messages[j].get("role") == "tool":
                j += 1
            blocks.append((i, j))
            i = j
        else:
            blocks.append((i, i + 1))
            i += 1
    return blocks


def _trim_to_fit(messages: list[dict], context_window: int) -> list[dict] | None:
    """Drop the oldest exchange blocks until the context fits.

    Always preserves the system prompt (index 0) and every message from the
    most recent user message onward.  Returns ``None`` when even the
    protected minimum exceeds the window.
    """
    if len(messages) <= 2:
        return None

    system = messages[0]
    rest = messages[1:]

    last_user = max(
        (i for i, m in enumerate(rest) if m.get("role") == "user"),
        default=len(rest) - 1,
    )
    protected = rest[last_user:]
    droppable = rest[:last_user]

    if not droppable:
        return None

    blocks = _split_exchange_blocks(droppable)
    # Drop oldest-first, one block at a time.
    for _, end in blocks:
        candidate = [system, *droppable[end:], *protected]
        if not calculate_budget(candidate, context_window)["exceeds_hard_limit"]:
            return candidate

    return None


# Request bodies above this size (chars, messages + tools schema) are
# compacted BEFORE sending. The model context window (131k tokens) is NOT
# the binding constraint — NVIDIA NIM's deserializer rejects bodies around
# ~186-195KB chars, i.e. long before the window fills. Never mutate the
# input: compaction returns a copy for the wire only.
# Env XVIE_MAX_REQUEST_CHARS (default 90K, down from 120K): smaller wire
# payloads = fewer provider rejections = fewer mid-build stops.
def _resolve_max_request_chars() -> int:
    import os as _os
    try:
        return max(30_000, int(_os.getenv("XVIE_MAX_REQUEST_CHARS", "90000")))
    except ValueError:
        return 90_000


MAX_REQUEST_CHARS = _resolve_max_request_chars()


def _resolve_continuation_limits() -> tuple[int, int]:
    """(truncation continuations, stall continuations) from env.

    Defaults 8/8 (up from 3/5): weak models hit output caps mid-file and
    need room to append_file their way out instead of dying with a warning.
    """
    import os as _os
    try:
        trunc = max(3, int(_os.getenv("XVIE_MAX_CONTINUATIONS", "8")))
    except ValueError:
        trunc = 8
    try:
        stall = max(5, int(_os.getenv("XVIE_MAX_STALL_CONTINUATIONS", "8")))
    except ValueError:
        stall = 8
    return trunc, stall


_MAX_TRUNC_CONTINUATIONS, _MAX_STALL_CONTINUATIONS = _resolve_continuation_limits()


def _truncate_text(text: str, limit: int, label: str) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n[... {label} truncated, {len(text)} chars total]"


def _compact_messages_for_request(
    messages: list[dict],
    *,
    keep_turns: int = 4,
    max_assistant_chars: int = 2000,
    max_user_chars: int = 4000,
) -> list[dict]:
    """Return a wire-safe copy of *messages* with old bulk trimmed.

    Keeps the system prompt (index 0) and the last *keep_turns* user turns
    fully intact. Older messages are compacted: tool results become
    one-line placeholders (tool_call_id preserved for pairing), assistant
    content over *max_assistant_chars* is truncated (tool_calls structure
    kept — dropping it would break the conversation), user content over
    *max_user_chars* is truncated.
    """
    if not messages:
        return []
    compacted: list[dict] = []
    # Turn boundaries = user messages; everything before the cutoff is old.
    user_idx = [i for i, m in enumerate(messages) if m.get("role") == "user"]
    cutoff = user_idx[max(0, len(user_idx) - keep_turns)] if user_idx else len(messages)
    for i, msg in enumerate(messages):
        role = msg.get("role")
        if i == 0 or i >= cutoff:
            compacted.append(dict(msg))
            continue
        if role == "tool":
            entry = dict(msg)
            original = len(str(msg.get("content") or ""))
            entry["content"] = f"[tool result omitted, {original} chars]"
            compacted.append(entry)
        elif role == "assistant":
            entry = dict(msg)
            entry["content"] = _truncate_text(
                str(msg.get("content") or ""), max_assistant_chars, "assistant text"
            )
            calls = msg.get("tool_calls")
            if calls:
                slim_calls = []
                for call in calls:
                    slim = dict(call)
                    fn = dict(call.get("function", {}))
                    args = fn.get("arguments", "{}")
                    if len(str(args)) > max_assistant_chars:
                        fn["arguments"] = _compact_tool_arguments(args, max_assistant_chars)
                    slim["function"] = fn
                    slim_calls.append(slim)
                entry["tool_calls"] = slim_calls
            compacted.append(entry)
        elif role == "user":
            entry = dict(msg)
            entry["content"] = _truncate_text(
                str(msg.get("content") or ""), max_user_chars, "user text"
            )
            compacted.append(entry)
        else:
            compacted.append(dict(msg))
    return compacted


def _rollover_messages_for_request(messages: list[dict]) -> list[dict]:
    """Start a smaller working context while preserving the current task.

    This is a wire-only rollover: the saved transcript remains intact. Keep
    the last two user turns, trim bulky recent tool output, and remove optional
    injected project/reference context so the agent can continue in place.
    """
    compacted = _compact_messages_for_request(
        messages,
        keep_turns=2,
        max_assistant_chars=1200,
        max_user_chars=3000,
    )
    if not compacted:
        return compacted

    system = str(compacted[0].get("content") or "")
    for tag in ("workspace-inventory", "project-context"):
        system = re.sub(
            rf"\s*<{tag}>.*?</{tag}>\s*", "\n[Optional workspace context omitted during refresh.]\n",
            system, flags=re.DOTALL,
        )
    # The compact core design rules stay earlier in the prompt. Drop the
    # lengthy routed reference bodies on rollover; they can be read again if
    # a concrete implementation step needs one.
    system = re.sub(r"\n## Loaded references\n.*", "", system, flags=re.DOTALL)
    system_limit = max(8_000, int(MAX_REQUEST_CHARS * 0.5))
    if len(system) > system_limit:
        system = system[:system_limit] + "\n[System context shortened for continuation.]"
    compacted[0] = {**compacted[0], "content": system}

    for index, message in enumerate(compacted[1:], 1):
        if message.get("role") == "tool":
            content = str(message.get("content") or "")
            if len(content) > 1_500:
                compacted[index] = {
                    **message,
                    "content": _truncate_text(content, 1_500, "tool output"),
                }
    return compacted


def _all_attempts_payload_too_large(exc: Exception) -> bool:
    """True when a lane exhaustion was caused only by oversized requests."""
    attempts = getattr(exc, "attempts", None)
    if not attempts:
        return False
    return all(
        getattr(a, "error_type", "") == "payload_too_large" for a in attempts
    )


def _request_size_chars(messages: list[dict], tools: list[dict] | None) -> int:
    """Estimate the serialized request body size (what the API deserializes)."""
    try:
        size = len(json.dumps(messages))
    except (TypeError, ValueError):
        size = sum(len(str(m.get("content") or "")) for m in messages)
    if tools:
        try:
            size += len(json.dumps(tools))
        except (TypeError, ValueError):
            pass
    return size


class AgentLoop:
    """Orchestrates the model → tool → model loop.

    Parameters:
        client: An :class:`ProviderClient` for making model calls.
        model: The model slug to use for every turn (router comes later).
        tools: Registry of available tools.  If ``None``, builds the default.
        tool_ctx: Context passed to tool handlers.
        budget: Per-session budget constraints.
        system_prompt: Custom system prompt.  Falls back to
            :data:`DEFAULT_SYSTEM_PROMPT`.
        max_consecutive_tool_errors: Stop the loop after this many consecutive
            tool failures in a single turn (prevents infinite retry loops).
    """

    def __init__(
        self,
        client: ProviderClient,
        model: str,
        tools: dict[str, Tool] | None = None,
        tool_ctx: ToolContext | None = None,
        budget: BudgetConfig | None = None,
        system_prompt: str | None = None,
        max_consecutive_tool_errors: int = 5,
        context_window: int = 32_000,
        redact: bool = True,
        router: ModelRouter | None = None,
        lane: str | None = None,
        thinking: bool = False,
        event_callback: Callable[[AgentEvent], None] | None = None,
        history: list[dict] | None = None,
        write_approved: bool = False,
        confirmation_required: bool = False,
        approval_required_tools: set[str] | None = None,
        rich_html_validation: bool = False,
        approval_callback: Callable[[str], bool] | None = None,
        read_only: bool = False,
        plan_gate: bool = False,
        cancel_event: threading.Event | None = None,
        retry_policy: RetryPolicy | None = None,
        context_prep_seconds: float = 0.0,
        question_callback: Callable[[list[dict]], list[dict] | None] | None = None,
    ) -> None:
        self._client = client
        self._model = model
        self._tools = tools or {}
        self._tool_ctx = tool_ctx
        self._budget_config = budget or BudgetConfig()
        self._system_prompt = system_prompt or DEFAULT_SYSTEM_PROMPT
        self._max_consecutive_tool_errors = max_consecutive_tool_errors
        self._context_window = context_window
        self._redact = redact
        self._router = router
        self._lane = lane
        self._thinking = thinking
        self._event_callback = event_callback
        self._history = history or []
        self._write_approved = write_approved
        self._confirmation_required = confirmation_required
        self._approval_required_tools = approval_required_tools if approval_required_tools is not None else (
            set(_MUTATING_TOOLS) if confirmation_required else set()
        )
        self._rich_html_validation = rich_html_validation
        self._approval_callback = approval_callback
        self._read_only = read_only
        self._plan_gate = plan_gate
        self._cancel_event = cancel_event
        self._question_callback = question_callback
        self._retry_policy = retry_policy or RetryPolicy.from_env()
        self._timings = {
            "context_prep_seconds": max(0.0, context_prep_seconds),
            "provider_seconds": 0.0,
            "retry_seconds": 0.0,
            "tool_seconds": 0.0,
        }
        self._reasoning_streamed = False
        self._activity: list[AgentEvent] = []
        self.last_result: AgentRunResult | None = None

    def _emit(self, kind: str, message: str, **data: object) -> None:
        event = AgentEvent(kind=kind, message=message, data=dict(data))
        self._activity.append(event)
        if self._event_callback:
            self._event_callback(event)

    def run_stream(self, user_message: str) -> Iterator[AgentEvent]:
        """Yield progress events while the synchronous agent loop is running.

        ``last_result`` is populated once iteration is exhausted, preserving
        the existing ``run()`` return contract for non-stream consumers.
        """
        events: queue.Queue[AgentEvent | None] = queue.Queue()
        callback = self._event_callback

        def forward(event: AgentEvent) -> None:
            events.put(event)
            if callback:
                callback(event)

        def worker() -> None:
            try:
                self._event_callback = forward
                self.last_result = self.run(user_message)
            finally:
                events.put(None)

        threading.Thread(target=worker, daemon=True, name="xvie-agent-stream").start()
        while True:
            event = events.get()
            if event is None:
                break
            yield event

    def _stream_complete(
        self,
        messages: list[dict],
        tools: list[dict] | None,
        *,
        max_tokens: int | None = None,
    ) -> AssistantTurn:
        """Accumulate an OpenAI-compatible SSE response while forwarding safe deltas."""
        content: list[str] = []
        reasoning: list[str] = []
        calls: list[ToolCall] = []
        usage = UsageStats()
        truncated = False
        incomplete = False
        stream_options = {"model": self._model, "messages": messages, "tools": tools}
        if max_tokens is not None:
            stream_options["max_tokens"] = max_tokens
        for event in self._client.stream(**stream_options):
            if self._cancel_event is not None and self._cancel_event.is_set():
                break
            if event.text_delta:
                content.append(event.text_delta)
                self._emit("model_text", event.text_delta, delta=event.text_delta)
            if event.reasoning_delta:
                reasoning.append(event.reasoning_delta)
                self._reasoning_streamed = True
                self._emit("reasoning", event.reasoning_delta, delta=event.reasoning_delta)
            if event.tool_call:
                calls.append(event.tool_call)
            if event.usage:
                usage = event.usage
            if event.truncated:
                truncated = True
            if event.incomplete:
                incomplete = True
        return AssistantTurn(
            "".join(content),
            tuple(calls),
            usage,
            self._model,
            "".join(reasoning) or None,
            truncated,
            incomplete,
        )

    def _handle_stream_event(self, event) -> None:
        if event.text_delta:
            self._emit("model_text", event.text_delta, delta=event.text_delta)
        if event.reasoning_delta:
            self._reasoning_streamed = True
            self._emit("reasoning", event.reasoning_delta, delta=event.reasoning_delta)
        if getattr(event, "truncated", False) or getattr(event, "incomplete", False):
            self._emit(
                "output_truncated",
                "Model response ended before completion" if getattr(event, "incomplete", False) else "Model output hit the token cap",
            )

    def _complete_with_retry(
        self,
        messages: list[dict],
        tools: list[dict] | None,
        *,
        max_tokens: int | None = None,
    ) -> AssistantTurn:
        """Call the single client, waiting and retrying on transient errors.

        Rate limits (429), transient 5xx, and timeouts/network drops (status 0)
        are all retried with exponential backoff.  Non-transient errors
        (auth, out-of-credits, model refusals) propagate immediately.
        """
        policy = self._retry_policy
        attempt = 0
        while True:
            if self._cancel_event is not None and self._cancel_event.is_set():
                return AssistantTurn("", model=self._model)
            attempt += 1
            try:
                if hasattr(self._client, "stream"):
                    return self._stream_complete(messages, tools, max_tokens=max_tokens)
                return self._client.complete(model=self._model, messages=messages, tools=tools)
            except (RateLimitedError, ProviderError) as exc:
                if not is_transient_error(exc):
                    raise
                wait = retry_delay(policy, attempt, getattr(exc, "retry_after", None))
                wait = max(wait, 1.0)
                kind = "rate_limit_wait" if isinstance(exc, RateLimitedError) else "retrying"
                self._emit(
                    kind,
                    f"{'Rate limit hit' if isinstance(exc, RateLimitedError) else 'Transient provider error'} "
                    f"— waiting {wait:.0f}s before retrying ({attempt}/{policy.max_retries})",
                    retry_in=round(wait),
                )
                self._timings["retry_seconds"] += wait
                if self._cancel_event is not None:
                    self._cancel_event.wait(wait)
                else:
                    time.sleep(wait)

    def _call_model(self, messages: list[dict], tools: list[dict] | None) -> AssistantTurn:
        started = time.monotonic()
        try:
            return self._call_model_impl(messages, tools)
        finally:
            self._timings["provider_seconds"] += time.monotonic() - started

    def _call_model_impl(self, messages: list[dict], tools: list[dict] | None) -> AssistantTurn:
        """Run one model turn — via the router lane when active, else the client.

        The router already owns its own rate-limit cooldown/fallback logic;
        the direct path gets the wait-and-retry wrapper instead.

        Requests that outgrow what the provider can deserialize are compacted
        to a wire-safe copy first (originals untouched — transcript and
        session persistence keep full text).
        """
        if _request_size_chars(messages, tools) > MAX_REQUEST_CHARS:
            messages = _compact_messages_for_request(messages)
            self._emit(
                "context_compacted",
                "Compacting older tool output to keep the request responsive",
            )
        messages = _prepare_messages_for_provider(messages)
        if self._router and self._lane:
            self._emit("selected_model", f"Using {self._lane} model profile")
            if hasattr(self._router, "stream_with_fallback"):
                return self._router.stream_with_fallback(
                    self._lane, messages, tools, self._handle_stream_event
                )
            return self._router.complete_with_fallback(
                lane=self._lane,
                messages=messages,
                tools=tools,
            )
        return self._complete_with_retry(messages, tools)

    def _retry_after_payload_rollover(
        self,
        messages: list[dict],
        tools: list[dict] | None,
    ) -> tuple[AssistantTurn | None, list[dict], Exception | None]:
        """Retry once with a fresh compact context after provider size rejects."""
        compacted = _rollover_messages_for_request(messages)
        self._emit(
            "context_compacted",
            "Refreshing working context and resuming the task",
        )
        try:
            return self._call_model(compacted, tools), compacted, None
        except (PayloadTooLargeError, AllModelsExhaustedError, ProviderError) as exc:
            if isinstance(exc, AllModelsExhaustedError) and not _all_attempts_payload_too_large(exc):
                return None, compacted, exc
            return None, compacted, exc

    def _written_files(self, all_tool_calls: list[ToolCall]) -> list[str]:
        """Return paths written/edited during this run."""
        paths: list[str] = []
        for tc in all_tool_calls:
            if tc.name in {"write_file", "edit_file", "append_file"} and isinstance(tc.arguments, dict):
                p = tc.arguments.get("path")
                if p:
                    paths.append(str(p))
        return paths

    def _requested_scale(self, user_message: str) -> int | None:
        """Return a target line count if the user asked for a large file."""
        m = re.search(r"(\d{3,})\s*(?:lines|line)", user_message, re.IGNORECASE)
        if m:
            return int(m.group(1))
        if re.search(r"\b(?:large|big|huge|complete|full|entire)\b", user_message, re.IGNORECASE):
            return 500
        return None

    def _stub_completion(self, user_message: str, all_tool_calls: list[ToolCall], turn_content: str) -> bool:
        """True when the model claims completion but the requested file is a stub.

        Detects the classic failure: user asks for a large file, the model writes
        a tiny/malformed file, then emits a status line like 'The function call
        has been executed successfully' — and the loop would otherwise stop.
        """
        target = self._requested_scale(user_message)
        if target is None:
            return False
        # Only trigger when the model wrote files this run.
        written = self._written_files(all_tool_calls)
        if not written:
            return False
        # A status-only reply (no real content) is a red flag.
        status_only = len(turn_content.strip()) < 120 and not re.search(r"\n", turn_content.strip())
        if not status_only:
            return False
        # Check the actual file sizes.
        for path in written:
            if self._tool_ctx is None:
                continue
            target_path = (self._tool_ctx.workspace_root / path).resolve()
            try:
                if target_path.exists():
                    lines = len(target_path.read_text(encoding="utf-8", errors="replace").splitlines())
                    if lines < target:
                        return True
            except OSError:
                continue
        return False

    def run(self, user_message: str) -> AgentRunResult:
        """Execute the full agent loop for a single user message.

        Returns an :class:`AgentRunResult` with the final output, usage stats,
        and full transcript.
        """
        tracker = BudgetTracker(self._budget_config)
        messages: list[dict] = [
            {"role": "system", "content": self._system_prompt},
            *self._history,
            {"role": "user", "content": user_message},
        ]
        openai_tools = _tools_to_openai_format(self._tools, self._tool_ctx) if self._tools else None
        all_tool_calls: list[ToolCall] = []
        successful_read_calls: set[str] = set()
        transcript: list[dict] = list(messages)
        self._emit("understanding_task", "Understanding the request")

        # --- Small-talk fast path: greetings never touch tools or files ---
        if _is_small_talk(user_message):
            self._emit("smalltalk", "Casual message — answering directly, no tools")
            try:
                turn = self._complete_with_retry(messages, None, max_tokens=96)
            except RateLimitedError:
                return self._build_result(
                    final_output=(
                        "Paused: the provider rate-limited this run. "
                        "Wait ~60s and try again."
                    ),
                    messages=messages,
                    tracker=tracker,
                    all_tool_calls=all_tool_calls,
                    transcript=transcript,
                    stop_reason="rate_limited",
                )
            except (AllModelsExhaustedError, ProviderError) as exc:
                logger.warning("Small-talk model request failed: %s", exc)
                return self._build_result(
                    final_output=(
                        "I couldn't get a response from the model service. "
                        "Please try again shortly."
                    ),
                    messages=messages,
                    tracker=tracker,
                    all_tool_calls=all_tool_calls,
                    transcript=transcript,
                    stop_reason="model_error",
                )
            tracker.record_model_call(turn.model, turn.usage)
            tracker.record_turn()
            thought, answer = _extract_thought(turn.content)
            if thought:
                self._emit("thought", thought)
            answer = answer.strip()
            if not answer or _PRIVATE_SCRATCH_START.match(answer):
                answer = "Hi! What would you like to work on?"
            assistant_msg = {"role": "assistant", "content": answer}
            transcript.append(assistant_msg)
            return self._build_result(
                final_output=answer,
                messages=messages,
                tracker=tracker,
                all_tool_calls=all_tool_calls,
                transcript=transcript,
                stop_reason="completed",
                reasoning=turn.reasoning,
            )

        consecutive_errors = 0
        continuations = 0
        thinking_cut_streak = 0
        # Stagnation guard state: turns with no tool calls and empty or
        # repeated content. Fires even without truncation (rejections and
        # thinking loops), unlike thinking_cut_streak.
        stagnant_turns = 0
        prev_assistant_text = ""
        last_tool_error: str | None = None
        plan_nudges = 0
        stub_nudges = 0
        verification_nudges = 0
        json_call_nudges = 0
        truncated_write_nudges = 0
        nonproductive_turns = 0
        written_ok: set[str] = set()
        # If a "Thought:" line is stripped from content and the model then
        # stops without producing any real answer, preserve it so the user
        # never sees a silent empty response.
        last_stripped_thought: str = ""
        read_only_plan_text: str | None = None

        # --- Plan gate: track whether a plan exists in this session ---
        # For multi-step tasks, writes before a plan is created are rejected
        # with a clear error telling the model to plan first.
        _plan_created = False
        if self._tool_ctx is not None:
            _plan_dir = self._tool_ctx.workspace_root / ".xvie" / "plans"
            if _plan_dir.is_dir() and any(_plan_dir.glob("*.md")):
                _plan_created = True
        while True:
            if self._cancel_event is not None and self._cancel_event.is_set():
                return self._build_result(
                    final_output="Stopped by the user. Any completed tool actions remain saved.",
                    messages=messages,
                    tracker=tracker,
                    all_tool_calls=all_tool_calls,
                    transcript=transcript,
                    stop_reason="cancelled",
                )
            # --- Budget check (turn/token limits) ---
            stop = tracker.check()
            if stop:
                # Provide a helpful message when max_turns is hit so the
                # user knows they can increase the limit.
                if stop == "max_turns":
                    msg = (
                        f"Paused at the {tracker._config.max_turns}-turn limit before completing. "
                        "Progress is saved in this session. Resume with: "
                        "xvie-agent run --resume <session-id> --max-turns 100, "
                        "or break the task into smaller steps."
                    )
                elif stop == "budget_exceeded":
                    budget_limit = "configured run budget"
                    if tracker._config.max_total_tokens is not None and tracker.total_usage.total_tokens >= tracker._config.max_total_tokens:
                        budget_limit = "token budget"
                    elif tracker._config.max_tool_calls is not None and tracker.tool_call_count >= tracker._config.max_tool_calls:
                        budget_limit = "tool-call limit"
                    elif tracker._config.max_model_calls is not None and tracker.model_call_count >= tracker._config.max_model_calls:
                        budget_limit = "model-call limit"
                    msg = (
                        f"Paused: {budget_limit} reached before completing. "
                        "Progress is saved in this session. Resume with: "
                        "xvie-agent run --resume <session-id>, or rerun a "
                        "smaller step."
                    )
                else:
                    msg = (
                        f"Stopped ({stop}). Progress is saved in this session. "
                        "Resume with: xvie-agent run --resume <session-id>."
                    )
                return self._build_result(
                    final_output=msg,
                    messages=messages,
                    tracker=tracker,
                    all_tool_calls=all_tool_calls,
                    transcript=transcript,
                    stop_reason=stop,
                )

            # --- Context window budget check ---
            budget_info = calculate_budget(messages, self._context_window)
            if budget_info["exceeds_hard_limit"]:
                trimmed = _trim_to_fit(messages, self._context_window)
                if trimmed is None:
                    # Even the protected minimum (system + oldest/latest user
                    # message) exceeds the window.  Sending a long message the
                    # provider can handle is better than silently refusing it:
                    # emit a warning and proceed best-effort instead of dying.
                    self._emit(
                        "large_input",
                        "Input is larger than the reserved context window — you may have trimmed the model's headroom",
                    )
                else:
                    messages = trimmed
                    self._emit(
                        "context_trimmed",
                        f"Trimmed older history to fit the context window ({len(messages)} messages kept)",
                    )

            # --- Model call (router or single client) ---
            t0 = time.monotonic()
            try:
                self._emit("thinking", "Thinking through the next step")
                turn = self._call_model(messages, openai_tools)
                if self._cancel_event is not None and self._cancel_event.is_set():
                    continue
            except PayloadTooLargeError as exc:
                turn, messages, recovery_error = self._retry_after_payload_rollover(
                    messages, openai_tools
                )
                if turn is None:
                    payload_failure = (
                        isinstance(recovery_error, PayloadTooLargeError)
                        or isinstance(recovery_error, AllModelsExhaustedError)
                        and _all_attempts_payload_too_large(recovery_error)
                    )
                    stop_reason = "payload_too_large" if payload_failure else "model_error"
                    return self._build_result(
                        final_output=(
                            "I couldn't reconnect to a model for the next step after "
                            "refreshing the working context. Your files and session "
                            "progress are saved; retry when the model service is ready."
                        ),
                        messages=messages,
                        tracker=tracker,
                        all_tool_calls=all_tool_calls,
                        transcript=transcript,
                        stop_reason=stop_reason,
                    )
            except AllModelsExhaustedError as exc:
                logger.warning("All models exhausted: %s", exc)
                if _all_attempts_payload_too_large(exc):
                    turn, messages, recovery_error = self._retry_after_payload_rollover(
                        messages, openai_tools
                    )
                    if turn is not None:
                        pass
                    else:
                        payload_failure = (
                            isinstance(recovery_error, PayloadTooLargeError)
                            or isinstance(recovery_error, AllModelsExhaustedError)
                            and _all_attempts_payload_too_large(recovery_error)
                        )
                        stop_reason = "payload_too_large" if payload_failure else "all_models_exhausted"
                        return self._build_result(
                            final_output=(
                                "I couldn't reconnect to a model for the next step after "
                                "refreshing the working context. Your files and session "
                                "progress are saved; retry when the model service is ready."
                            ),
                            messages=messages,
                            tracker=tracker,
                            all_tool_calls=all_tool_calls,
                            transcript=transcript,
                            stop_reason=stop_reason,
                        )
                else:
                    return self._build_result(
                        final_output=(
                            "I couldn't continue because the available models rejected "
                            "this request. Your progress is saved in this session; "
                            "resume it to continue."
                        ),
                        messages=messages,
                        tracker=tracker,
                        all_tool_calls=all_tool_calls,
                        transcript=transcript,
                        stop_reason="all_models_exhausted",
                    )
            except RateLimitedError:
                return self._build_result(
                    final_output=(
                        "Paused: the provider rate-limited this run. Progress is "
                        "saved in this session. Wait ~60s, then resume with: "
                        "xvie-agent run --resume <session-id>."
                    ),
                    messages=messages,
                    tracker=tracker,
                    all_tool_calls=all_tool_calls,
                    transcript=transcript,
                    stop_reason="rate_limited",
                )
            except ProviderError as exc:
                logger.warning("Model request failed: %s", exc)
                return self._build_result(
                    final_output=(
                        "I couldn't continue because the model service rejected "
                        "the request. Your progress is saved; resume this session "
                        "to continue."
                    ),
                    messages=messages,
                    tracker=tracker,
                    all_tool_calls=all_tool_calls,
                    transcript=transcript,
                    stop_reason="model_error",
                )

            tracker.record_model_call(turn.model, turn.usage)
            tracker.record_turn()
            turn_ms = int((time.monotonic() - t0) * 1000)
            self._emit("selected_model", f"Model responded: {turn.model or self._model}", model=turn.model or self._model)

            # Only explicit, user-facing Thought lines are surfaced. Raw provider
            # reasoning remains private and is never forwarded to the UI.
            self._reasoning_streamed = False
            if turn.content:
                thought_text, stripped_content = _extract_thought(turn.content)
                if thought_text:
                    self._emit("thought", thought_text, duration_ms=turn_ms)
                    last_stripped_thought = thought_text
                    turn = replace(turn, content=stripped_content)

            if turn.truncated or turn.incomplete:
                self._emit(
                    "output_truncated",
                    "Model response ended before completion" if turn.incomplete else "Model output hit the token cap — response may be incomplete",
                )

            # --- Collect reasoning (if present) ---
            reasoning_text = turn.reasoning
            if reasoning_text and self._redact:
                reasoning_text = redact_secrets(reasoning_text)

            # --- No tool calls → check for text-based tool calls ---
            if not turn.tool_calls:
                text_calls = _parse_text_tool_calls(turn.content, set(self._tools.keys()))
                if text_calls:
                    # Treat text-embedded tool calls as real tool calls
                    turn = AssistantTurn(
                        content="",
                        tool_calls=tuple(text_calls),
                        usage=turn.usage,
                        model=turn.model,
                        reasoning=turn.reasoning,
                        truncated=turn.truncated,
                        incomplete=turn.incomplete,
                    )
                else:
                    # Model emitted a raw JSON tool call as text → force a
                    # retry via the function-calling API.  Dumping that JSON
                    # on the user as the "final answer" is never acceptable.
                    if (
                        json_call_nudges < 2
                        and _looks_like_json_tool_call(turn.content, set(self._tools.keys()))
                    ):
                        json_call_nudges += 1
                        self._emit(
                            "retrying",
                            "Tool call arrived as raw JSON — requesting function-call format",
                        )
                        assistant_msg = {"role": "assistant", "content": turn.content}
                        messages.append(assistant_msg)
                        transcript.append(assistant_msg)
                        messages.append({
                            "role": "user",
                            "content": (
                                "Your last message contained a tool call as raw JSON "
                                "text — that is NOT executed. Call the tool through the "
                                "function-calling API (the tool_calls field) instead, "
                                "like your earlier calls. Do not output the JSON as text."
                            ),
                        })
                        continue

                    # Output hit the token cap mid-response → auto-continue
                    # instead of returning an incomplete answer/file.
                    # Track repeat thinking-only truncations: a model stuck
                    # re-explaining without emitting tool calls needs force,
                    # not encouragement (else it burns all 3 continues).
                    response_cut = turn.truncated or turn.incomplete
                    if response_cut and not turn.tool_calls:
                        thinking_cut_streak += 1
                    else:
                        thinking_cut_streak = 0
                    # Track stagnation independent of truncation: no tool calls
                    # plus empty or repeated content. Resets on any tool call
                    # or novel text. Unlike thinking_cut_streak this also
                    # catches rejection-silence and thinking loops.
                    _norm_text = " ".join((turn.content or "").split())
                    if not turn.tool_calls and (
                        not _norm_text or _norm_text == prev_assistant_text
                    ):
                        stagnant_turns += 1
                    else:
                        stagnant_turns = 0
                        if _norm_text:
                            prev_assistant_text = _norm_text
                    if response_cut and continuations < _MAX_TRUNC_CONTINUATIONS:
                        continuations += 1
                        # Detect if we were mid-file-write: look at the last
                        # tool call for write_file/edit_file/append_file.
                        last_write_path = None
                        for tc in reversed(all_tool_calls):
                            if tc.name in {"write_file", "edit_file", "append_file"}:
                                if isinstance(tc.arguments, dict):
                                    last_write_path = tc.arguments.get("path")
                                break
                        # Check if the model was mid-tool-call (has pending
                        # tool results that haven't been responded to yet).
                        has_pending_tool = any(
                            m.get("role") == "tool" for m in messages[-3:]
                        )
                        if last_write_path:
                            self._emit(
                                "output_truncated",
                                f"Output cut off mid-write — auto-continuing ({continuations}/{_MAX_TRUNC_CONTINUATIONS})",
                            )
                            partial = {"role": "assistant", "content": turn.content}
                            messages.append(partial)
                            transcript.append(partial)
                            nudge = (
                                f"Your output was cut off by the token limit while "
                                f"writing {last_write_path}. If that write already "
                                f"succeeded, continue by calling append_file with "
                                f"path='{last_write_path}' to add the remaining "
                                f"content. If it did NOT succeed, write it in smaller "
                                f"chunks: write_file the FIRST part, then append_file "
                                f"the rest — keep each call at most "
                                f"{MAX_WRITE_CONTENT_CHARS} chars. Do NOT repeat "
                                f"anything already saved. Continue EXACTLY where you "
                                f"stopped."
                            )
                        elif has_pending_tool:
                            self._emit(
                                "output_truncated",
                                f"Output cut off — auto-continuing ({continuations}/{_MAX_TRUNC_CONTINUATIONS})",
                            )
                            partial = {"role": "assistant", "content": turn.content}
                            messages.append(partial)
                            transcript.append(partial)
                            nudge = (
                                "Your output was cut off by the token limit while "
                                "processing tool results. Continue with the next step "
                                "of your task — do not repeat earlier work."
                            )
                        else:
                            # Model was outputting long text (explanation/plan) —
                            # just let it continue without an alarming message.
                            self._emit(
                                "output_truncated",
                                f"Output cut off — auto-continuing ({continuations}/{_MAX_TRUNC_CONTINUATIONS})",
                            )
                            partial = {"role": "assistant", "content": turn.content}
                            messages.append(partial)
                            transcript.append(partial)
                            if self._read_only:
                                # Read-only modes must never be pushed toward
                                # implementation — the deliverable IS the text.
                                if turn.incomplete:
                                    nudge = (
                                        "The response stream ended before your answer "
                                        "finished. Continue exactly where you stopped "
                                        "and finish the analysis as text. Do NOT attempt "
                                        "to write files in this read-only session."
                                    )
                                else:
                                    nudge = (
                                        "Your explanation was cut off — that's fine. "
                                        "Continue from where you stopped and finish "
                                        "your plan/analysis as text. Do NOT attempt to "
                                        "write any files in this read-only session."
                                    )
                            else:
                                # Check if there are open plan tasks to redirect to
                                open_tasks = (
                                    _open_plan_tasks(self._tool_ctx.workspace_root)
                                    if self._tool_ctx is not None else []
                                )
                                if thinking_cut_streak >= 2:
                                    nudge = (
                                        "Your output was cut off AGAIN without a tool call. "
                                        "Thinking is now BANNED for this turn: emit ONE tool "
                                        "call IMMEDIATELY with zero prose — start with "
                                        "read_file, grep_search, or apply_patch on the "
                                        "smallest next step. No explanation, no plan text, "
                                        "just the tool call."
                                    )
                                    # Observable in the transcript (the generic
                                    # continues are messages-only).
                                    transcript.append({"role": "user", "content": nudge})
                                elif open_tasks:
                                    listing = "\n".join(f"  - {t}" for t in open_tasks[:10])
                                    if turn.incomplete:
                                        nudge = (
                                            "The response stream ended before your answer "
                                            "finished. Continue exactly where you stopped; "
                                            "do not repeat completed text or work."
                                        )
                                    else:
                                        nudge = (
                                            "Your explanation was cut off — that's fine, "
                                            "move on to implementation. Remaining plan tasks:\n"
                                            f"{listing}\n\n"
                                            "Start with the first unfinished task now. "
                                            "Do NOT re-explain — just do the work."
                                        )
                                else:
                                    if turn.incomplete:
                                        nudge = (
                                            "The response stream ended before your answer "
                                            "finished. Continue exactly where you stopped; "
                                            "do not repeat completed text or work."
                                        )
                                    else:
                                        nudge = (
                                            "Your explanation was cut off — that's fine. "
                                            "Now execute the task. Do NOT re-explain. "
                                            "Start writing files and calling tools."
                                        )
                        messages.append({"role": "user", "content": nudge})
                        if continuations >= 2:
                            messages[-1]["content"] += _OUTPUT_CAP_HINT
                        continue

                    # --- Completion gate: don't stop on a stub write ---
                    # If the user asked for a large file and the model wrote a tiny
                    # stub then replied with a status line, force it to keep building.
                    # Bounded to one nudge: after the model has had its second
                    # chance, accept the completion (post-run validation still
                    # guards quality) — unbounded nudges caused IndexError spirals.
                    if (
                        stub_nudges < 1
                        and self._stub_completion(user_message, all_tool_calls, turn.content)
                    ):
                        stub_nudges += 1
                        self._emit(
                            "retrying",
                            "File is far below the requested size — continuing to build it",
                        )
                        messages.append({"role": "assistant", "content": turn.content})
                        transcript.append({"role": "assistant", "content": turn.content})
                        messages.append({
                            "role": "user",
                            "content": (
                                "The file you wrote is far too small for the requested "
                                "scale. Do NOT summarize or stop. Continue building the "
                                "complete file now: use write_file to rewrite it fully, "
                                "or append_file to add the remaining sections, until it "
                                "reaches the requested size. Then call verify_file."
                            ),
                        })
                        continue

                    # --- Plan guard: don't stop while planned tasks remain ---
                    # If the model is mid-implementation (wrote files) but the
                    # latest plan still has unchecked tasks, push it back to
                    # the plan instead of accepting a premature "done".
                    open_tasks = (
                        _open_plan_tasks(self._tool_ctx.workspace_root)
                        if self._tool_ctx is not None else []
                    )
                    if (
                        open_tasks
                        and plan_nudges < 4
                        and not self._read_only
                        and self._written_files(all_tool_calls)
                    ):
                        plan_nudges += 1
                        self._emit(
                            "plan_continue",
                            f"{len(open_tasks)} plan task(s) remain — returning to the plan",
                        )
                        assistant_msg = {"role": "assistant", "content": turn.content}
                        messages.append(assistant_msg)
                        transcript.append(assistant_msg)
                        listing = "\n".join(f"  - {t}" for t in open_tasks[:10])
                        nudge_msg = {
                            "role": "user",
                            "content": (
                                f"Your plan still has {len(open_tasks)} unfinished task(s):\n"
                                f"{listing}\n\n"
                                "Do NOT stop. State a short Thought:, continue with the "
                                "NEXT unfinished task now, and call mark_task_done after "
                                "finishing each one. Only summarize when every task is "
                                "checked off."
                            ),
                        }
                        messages.append(nudge_msg)
                        transcript.append(nudge_msg)
                        continue

                    # --- Verification guard: repair invalid artifacts in-loop ---
                    # Files successfully written this run must pass validation
                    # before the run may end.  Feeding errors back while
                    # context is live is far cheaper than failing after the
                    # loop returns.
                    changed_paths = sorted(written_ok)
                    artifact_errors = [
                        error for path in changed_paths
                        if (error := validate_changed_file(
                            path, self._tool_ctx.workspace_root,
                            rich_html=self._rich_html_validation,
                        ))
                    ] if self._tool_ctx is not None else []
                    if not artifact_errors and self._rich_html_validation and self._tool_ctx is not None:
                        for path in changed_paths:
                            if path.lower().endswith((".html", ".htm")):
                                render_error = validate_responsive_render(
                                    path, self._tool_ctx.workspace_root
                                )
                                if render_error:
                                    artifact_errors.append(render_error)
                    # Cross-file consistency check for HTML/CSS pairs
                    if not artifact_errors and self._rich_html_validation and self._tool_ctx is not None:
                        cross_error = validate_cross_file_consistency(
                            self._tool_ctx.workspace_root, changed_paths,
                        )
                        if cross_error:
                            artifact_errors.append(cross_error)
                    # Layout quality check for HTML+CSS pairs
                    if not artifact_errors and self._rich_html_validation and self._tool_ctx is not None:
                        html_paths = [p for p in changed_paths if p.endswith(('.html', '.htm'))]
                        css_paths = [p for p in changed_paths if p.endswith('.css')]
                        for html_path in html_paths:
                            html_target = (self._tool_ctx.workspace_root / html_path).resolve()
                            if not html_target.exists():
                                continue
                            try:
                                html_content = html_target.read_text(encoding="utf-8", errors="replace")
                            except OSError:
                                continue
                            for css_path in css_paths:
                                css_target = (self._tool_ctx.workspace_root / css_path).resolve()
                                if not css_target.exists():
                                    continue
                                try:
                                    css_content = css_target.read_text(encoding="utf-8", errors="replace")
                                except OSError:
                                    continue
                                layout_error = validate_layout_pair(html_content, css_content, html_path)
                                if layout_error:
                                    artifact_errors.append(layout_error)
                    if (
                        artifact_errors
                        and verification_nudges < 3
                    ):
                        verification_nudges += 1
                        self._emit(
                            "verification_failed",
                            "Artifact validation failed — repairing now",
                        )
                        assistant_msg = {"role": "assistant", "content": turn.content}
                        messages.append(assistant_msg)
                        transcript.append(assistant_msg)
                        listing = "\n".join(f"  - {e}" for e in artifact_errors[:5])
                        nudge_msg = {
                            "role": "user",
                            "content": (
                                "The file(s) you wrote failed validation:\n"
                                f"{listing}\n\n"
                                "Do NOT summarize or stop. Repair the file(s) now "
                                "(read_file to inspect, then edit_file or write_file), "
                                "and call verify_file until it passes. Only then "
                                "give your final summary."
                            ),
                        }
                        messages.append(nudge_msg)
                        transcript.append(nudge_msg)
                        continue

                    # Empty content after tool calls: force the model to
                    # continue working instead of silently stopping.
                    _read_tools = {"read_file", "list_dir", "glob_search",
                                    "grep_search", "think"}
                    _all_read_only = (
                        all_tool_calls
                        and all(tc.name in _read_tools for tc in all_tool_calls)
                    )
                    _any_writes = bool(written_ok)
                    if (
                        not turn.content.strip()
                        and not reasoning_text
                        and _all_read_only
                        and not _any_writes
                        and continuations < _MAX_STALL_CONTINUATIONS
                    ):
                        nonproductive_turns += 1
                        continuations += 1
                        if self._read_only:
                            # Read-only session: the deliverable IS the plan or
                            # answer as text. Never order the model to write
                            # files that were filtered out of its toolset.
                            self._emit(
                                "retrying",
                                f"Read-only session stalled after {nonproductive_turns} turns — prompting for the deliverable as text",
                            )
                            assistant_msg = {"role": "assistant", "content": turn.content}
                            messages.append(assistant_msg)
                            transcript.append(assistant_msg)
                            messages.append({
                                "role": "user",
                                "content": (
                                    "You have done enough investigation. STOP using "
                                    "tools. Now deliver your read-only output as "
                                    "Markdown text — your complete plan (or analysis/"
                                    "answer). Do NOT attempt to write any files: none "
                                    "of the write/shell tools exist in this session."
                                ),
                            })
                            continue
                        if nonproductive_turns >= 3:
                            # Model has been inspecting for 3+ turns with no
                            # progress. Generate an explicit plan nudge that
                            # spells out EXACTLY what to do next.
                            self._emit(
                                "retrying",
                                f"No progress after {nonproductive_turns} turns — forcing plan + implementation",
                            )
                            assistant_msg = {"role": "assistant", "content": turn.content}
                            messages.append(assistant_msg)
                            transcript.append(assistant_msg)
                            messages.append({
                                "role": "user",
                                "content": (
                                    "STOP INSPECTING. You have investigated enough. "
                                    "Now you MUST take action IMMEDIATELY:\n\n"
                                    "Step 1: Call write_plan with a detailed plan. "
                                    "Example:\n"
                                    'write_plan(title="My Task", summary="Build a website", steps=[\n'
                                    '  {"title": "Step 1", "description": "Create HTML", "files_touched": ["index.html"]},\n'
                                    '  {"title": "Step 2", "description": "Create CSS", "files_touched": ["styles.css"]}\n])\n\n'
                                    "Step 2: After plan succeeds, call write_file for each step.\n"
                                    "Step 3: Call mark_task_done after each step.\n\n"
                                    "DO THIS NOW. Do NOT inspect more. Do NOT think more."
                                ),
                            })
                            continue
                        elif nonproductive_turns >= 2:
                            self._emit(
                                "retrying",
                                "Model still inspecting — urging action",
                            )
                            assistant_msg = {"role": "assistant", "content": turn.content}
                            messages.append(assistant_msg)
                            transcript.append(assistant_msg)
                            messages.append({
                                "role": "user",
                                "content": (
                                    "You have inspected the workspace enough. "
                                    "Now create a plan (write_plan) and start "
                                    "implementing. Do NOT inspect again."
                                ),
                            })
                            continue
                        else:
                            self._emit(
                                "retrying",
                                "Model returned no text — forcing continuation",
                            )
                            assistant_msg = {"role": "assistant", "content": turn.content}
                            messages.append(assistant_msg)
                            transcript.append(assistant_msg)
                            messages.append({
                                "role": "user",
                                "content": (
                                    "Continue with the task. Create a plan "
                                    "(write_plan) and start writing files."
                                ),
                            })
                            continue
                    # Reset non-productive counter when files are written
                    if _any_writes:
                        nonproductive_turns = 0

                    # --- Stagnation guard: never accept an empty or looping
                    # finish while work is visibly unfinished. Fires when:
                    # (a) a rejection is fresh AND this turn is stagnant
                    #     (empty/repeated — a novel explanation after an error
                    #     is a legitimate completion per repo contract), (b) a
                    #     stagnant turn meets open plan tasks, or (c) novel
                    #     narration meets open tasks from a plan written THIS
                    #     run with zero writes so far. Stale plans from old
                    #     sessions never hijack Q&A. Bounded so the run always
                    #     terminates (continuations + max_turns).
                    if (
                        not self._read_only
                        and not turn.tool_calls
                        and continuations < _MAX_STALL_CONTINUATIONS
                    ):
                        _open_here = (
                            _open_plan_tasks(self._tool_ctx.workspace_root)
                            if self._tool_ctx is not None else []
                        )
                        _plan_this_run = any(
                            getattr(tc, "name", "") == "write_plan"
                            for tc in all_tool_calls
                        )
                        _reason: str | None = None
                        if last_tool_error is not None and stagnant_turns >= 1:
                            _reason = (
                                "Your last action was REJECTED and nothing has "
                                f"been fixed since: {last_tool_error} Repair it "
                                "now with a real tool call."
                            )
                        elif stagnant_turns >= 1 and _open_here:
                            remaining = "\n".join(f"  - {t}" for t in _open_here[:5])
                            _reason = (
                                "You have produced no tool calls while plan tasks "
                                f"remain open:\n{remaining}\nAdvance the first "
                                "unfinished task with a real tool call."
                            )
                        elif _open_here and _plan_this_run and not written_ok:
                            remaining = "\n".join(f"  - {t}" for t in _open_here[:5])
                            _reason = (
                                "You wrote a plan this run but have not executed "
                                f"it:\n{remaining}\nStop narrating and advance the "
                                "first unfinished task with a real tool call."
                            )
                        if _reason is not None:
                            continuations += 1
                            self._emit(
                                "output_truncated",
                                f"Stalled with unfinished work — forcing action ({continuations}/{_MAX_STALL_CONTINUATIONS})",
                            )
                            force_nudge = (
                                f"{_reason} Emit ONE tool call IMMEDIATELY with zero "
                                "prose — thinking is banned this turn."
                            )
                            transcript.append({"role": "user", "content": force_nudge})
                            messages.append({"role": "assistant", "content": turn.content})
                            transcript.append({"role": "assistant", "content": turn.content})
                            messages.append({"role": "user", "content": force_nudge})
                            continue

                    assistant_msg = {"role": "assistant", "content": turn.content}
                    if reasoning_text:
                        assistant_msg["reasoning"] = reasoning_text
                    transcript.append(assistant_msg)
                    final_output = turn.content
                    # Some providers return the whole answer in the reasoning
                    # field with empty content (observed on NVIDIA NIM).  The
                    # text is the answer — never drop it.
                    if not final_output.strip() and reasoning_text:
                        final_output = reasoning_text
                    # Never surface private scratch reasoning as the answer.
                    # The UI receives a short, safe progress summary through
                    # thought events; this fallback covers thought-only turns.
                    if not final_output.strip() and last_stripped_thought:
                        final_output = "I couldn't produce a clear answer this time. Please try again or rephrase your request."
                    if turn.truncated or turn.incomplete:
                        final_output += (
                            "\n\n> **Response incomplete:** The model output ended "
                            "before it finished. Retry or continue to get the remaining work."
                        )
                    return self._build_result(
                        final_output=final_output,
                        messages=messages,
                        tracker=tracker,
                        all_tool_calls=all_tool_calls,
                        transcript=transcript,
                        stop_reason="output_incomplete" if (turn.truncated or turn.incomplete) else "completed",
                        reasoning=reasoning_text,
                    )

            # --- Execute tool calls ---
            # One assistant message PER tool call: NIM models reject
            # multi-tool-call assistant messages when the conversation is
            # replayed (single tool-call limit), which broke fallback.
            truncated_cut = False
            plan_paused = False
            for tc in turn.tool_calls:
                if self._cancel_event is not None and self._cancel_event.is_set():
                    break
                # --- Truncated mid-tool-call recovery ---
                # When the response hit the output-token cap while emitting a
                # tool call, the provider may deliver the partial arguments as
                # an unparsed {"_raw": ...} object.  That call did NOT run.
                # Executing or "repairing" it just makes the model retry the
                # same oversized call and truncate again.  Instead, tell it the
                # call was dropped and force chunking, bounded to two nudges.
                if (
                    (turn.truncated or turn.incomplete)
                    and truncated_write_nudges < 2
                    and isinstance(tc.arguments, dict)
                    and "_raw" in tc.arguments
                ):
                    truncated_write_nudges += 1
                    self._emit(
                        "retrying",
                        "Tool call cut off by the output-token cap — re-requesting in chunks",
                        tool=tc.name or None,
                    )
                    cut_note = {
                        "role": "assistant",
                        "content": (
                            "[Your previous tool call did not complete — nothing "
                            "was executed.]"
                        ),
                    }
                    messages.append(cut_note)
                    transcript.append(cut_note)
                    chunk_nudge = {
                        "role": "user",
                        "content": (
                            "Your previous tool call was cut off before it "
                            "completed, so it did NOT run. Do not retry it as "
                            "one giant call. Split the "
                            f"content into chunks of at most {MAX_WRITE_CONTENT_CHARS} "
                            "chars each: call write_file with the FIRST part, "
                            "then append_file for each remaining part. Keep "
                            "interim assistant text to one or two short lines."
                        ),
                    }
                    messages.append(chunk_nudge)
                    transcript.append(chunk_nudge)
                    truncated_cut = True
                    break
                assistant_msg = _format_tool_calls_as_message(turn, tc)
                messages.append(assistant_msg)
                transcript.append(assistant_msg)
                # --- Pre-check budget BEFORE each tool call ---
                pre_stop = tracker.check()
                if pre_stop:
                    budget_detail = "configured run budget"
                    if tracker._config.max_tool_calls is not None and tracker.tool_call_count >= tracker._config.max_tool_calls:
                        budget_detail = "tool-call limit"
                    elif tracker._config.max_model_calls is not None and tracker.model_call_count >= tracker._config.max_model_calls:
                        budget_detail = "model-call limit"
                    elif tracker._config.max_total_tokens is not None and tracker.total_usage.total_tokens >= tracker._config.max_total_tokens:
                        budget_detail = "token budget"
                    return self._build_result(
                        final_output=(
                            f"Paused ({pre_stop}: {budget_detail}) before running {tc.name}. "
                            "The requested work may be incomplete; progress is saved in this session. "
                            "Resume the session or raise the relevant run budget to continue."
                        ),
                        messages=messages,
                        tracker=tracker,
                        all_tool_calls=all_tool_calls,
                        transcript=transcript,
                        stop_reason=pre_stop,
                    )
                all_tool_calls.append(tc)
                tracker.record_tool_call()
                tool_event_data = {"tool": tc.name}
                if isinstance(tc.arguments, dict):
                    for key in ("path", "file", "command"):
                        if tc.arguments.get(key) is not None:
                            tool_event_data[key] = tc.arguments[key]
                self._emit("tool_started", f"Running {tc.name}", **tool_event_data)
                read_signature = json.dumps(
                    [tc.name, tc.arguments], sort_keys=True, ensure_ascii=False, default=str
                )
                # The think tool IS the model's visible reasoning — surface it
                # as a thought event instead of a plain tool status.
                if tc.name == "think" and isinstance(tc.arguments, dict):
                    thought_text = str(tc.arguments.get("thought", "")).strip()
                    if thought_text:
                        self._emit("thought", thought_text, duration_ms=turn_ms)

                # --- Clarifying questions: pause-and-wait (chips + free text) ---
                _write_tools = {"write_file", "edit_file", "apply_patch", "move_file", "delete_file", "append_file"}
                if tc.name == "ask_question" and isinstance(tc.arguments, dict):
                    questions = _normalize_questions(tc.arguments.get("questions", []))
                    if not questions:
                        result = ToolResult(
                            tc.id, False,
                            "ask_question needs a non-empty 'questions' list with 'id' + 'question'.",
                            "invalid_arguments",
                        )
                        self._emit("retrying", "Repairing invalid ask_question call", tool=tc.name)
                    elif self._question_callback is not None:
                        self._emit(
                            "question_required",
                            "The agent has questions for you",
                            questions=questions, tool=tc.name,
                        )
                        try:
                            answers = self._question_callback(questions)
                        except Exception:
                            answers = None
                        if self._cancel_event is not None and self._cancel_event.is_set():
                            result = ToolResult(tc.id, False, "Run was stopped while waiting for answers.", "cancelled")
                        else:
                            result = ToolResult(tc.id, True, _format_question_answers(questions, answers))
                        self._emit("tool_finished", "User answered questions", tool=tc.name, ok=result.ok)
                    else:
                        # Non-interactive: validate shape, tell model to proceed.
                        result = self._execute_tool(tc)
                elif tc.name in _READ_ONLY_TOOLS and read_signature in successful_read_calls:
                    result = ToolResult(
                        tc.id,
                        False,
                        "This exact read-only request already succeeded during this task. Use its earlier result and continue with the next useful step.",
                        "duplicate_read",
                    )
                    self._emit("retrying", f"Skipped repeated {tc.name} request", tool=tc.name)
                elif (
                    not _plan_created
                    and tc.name in _write_tools
                    and self._tool_ctx is not None
                ):
                    result = ToolResult(
                        tc.id,
                        False,
                        ("No plan exists yet. You MUST call write_plan BEFORE any file changes. "
                         "Example format: write_plan(title=\"My Task\", summary=\"...\", "
                         "steps=[{\"title\": \"Step 1\", \"description\": \"...\", "
                         "\"files_touched\": [\"file1.py\", \"file2.py\"]}]). "
                         "After write_plan succeeds, you can call write_file/edit_file."),
                        "plan_required",
                    )
                    self._emit("plan_required", f"Rejecting {tc.name} — plan required first", tool=tc.name)
                elif self._tools.get(tc.name) is None:
                    result = self._execute_tool(tc)
                elif tc.name in self._approval_required_tools:
                    if self._approval_callback is not None:
                        # Interactive mode: pause and ask the user directly.
                        description = _describe_action(tc)
                        self._emit("awaiting_confirmation", f"Approval requested: {description}", tool=tc.name)
                        try:
                            approved = bool(self._approval_callback(description))
                        except Exception:
                            approved = False
                        if approved:
                            self._emit("editing" if tc.name in _MUTATING_TOOLS else "tool_started",
                                       f"Approved — running {tc.name}", tool=tc.name)
                            result = self._execute_tool(tc)
                        else:
                            result = ToolResult(
                                tc.id,
                                False,
                                "The user DENIED this action. Do not retry it unchanged — "
                                "choose a different approach or explain what you need.",
                                "approval_denied",
                            )
                            self._emit("action_denied", f"User denied {tc.name}", tool=tc.name)
                    else:
                        # Non-interactive (scripted) mode: keep the safe block.
                        result = ToolResult(
                            tc.id,
                            False,
                            "Approval is required before this tool can run. "
                            "Writes are blocked this pass — do NOT retry write "
                            "tools; finish by outputting your implementation "
                            "plan as text.",
                            "approval_required",
                        )
                        self._emit("awaiting_confirmation", f"Waiting for approval before running {tc.name}", tool=tc.name)
                else:
                    validation_error = _validate_tool_call(self._tools.get(tc.name), tc.arguments)
                    if validation_error:
                        result = ToolResult(tc.id, False, f"Tool call repair needed for {tc.name}: {validation_error}", "invalid_arguments")
                        self._emit("retrying", f"Repairing invalid {tc.name} call", tool=tc.name)
                    else:
                        # --- Inject session context into mark_task_done ---
                        if tc.name == "mark_task_done" and isinstance(tc.arguments, dict):
                            tc.arguments["changed_files"] = sorted(written_ok)
                        result = self._execute_tool(tc)

                # NOTE: No automatic validation here. Chunked builds (write_file +
                # append_file repeatedly) MUST be allowed to leave the file incomplete
                # until the model deliberately calls verify_file at the end. Auto-
                # validating every chunk created a write→fail→repair death spiral.
                if result.ok and tc.name in _READ_ONLY_TOOLS:
                    successful_read_calls.add(read_signature)

                # artifact validation still runs post-run in loop.py and via the
                # explicit verify_file tool.

                # Track plan creation for the plan gate.
                if result.ok and tc.name == "write_plan":
                    _plan_created = True
                    # In /plan mode, saving the plan is the requested
                    # deliverable. End this run here so implementation nudges
                    # and a follow-up model call cannot pull it into execution.
                    if self._read_only:
                        read_only_plan_text = result.content
                        if "\n\n" in read_only_plan_text:
                            read_only_plan_text = read_only_plan_text.split("\n\n", 1)[1]
                    else:
                        # --- Plan gate: pause before implementation ---
                        # When enabled, pause after a real multi-step plan so
                        # the user can review it and approve implementation.
                        if (
                            self._plan_gate
                            and not written_ok
                            and result.content.count("- [ ]") >= 2
                        ):
                            plan_paused = True
                            plan_text = result.content
                            if "\n\n" in plan_text:
                                plan_text = plan_text.split("\n\n", 1)[1]
                            self._emit(
                                "awaiting_confirmation",
                                "Implementation plan ready — review it and approve to execute",
                                plan=plan_text,
                            )
                            break

                # Emit honest narration for mutating tools: reflect actual outcome.
                if tc.name in _MUTATING_TOOLS:
                    # Build a richer narration with file path + line stats
                    file_path = ""
                    line_info = ""
                    if isinstance(tc.arguments, dict):
                        file_path = tc.arguments.get("path", "")
                        content = tc.arguments.get("content", "")
                        if content:
                            line_count = len(content.splitlines())
                            char_count = len(content)
                            line_info = f" ({line_count} lines, {char_count} chars)"
                    if result.ok:
                        if tc.name == "write_file" and file_path:
                            # Check if file existed before (overwrite vs create)
                            old_lines = 0
                            if self._tool_ctx:
                                target = self._tool_ctx.workspace_root / file_path
                                if target.exists():
                                    try:
                                        old_lines = len(target.read_text(encoding="utf-8").splitlines())
                                    except OSError:
                                        pass
                            if old_lines > 0:
                                self._emit("editing", f"✏ {file_path}{line_info} (overwrote {old_lines} lines)", tool=tc.name, file=file_path, lines=line_count if content else 0, old_lines=old_lines)
                            else:
                                self._emit("editing", f"✏ {file_path}{line_info} (new file)", tool=tc.name, file=file_path, lines=line_count if content else 0)
                        elif tc.name == "edit_file" and file_path:
                            self._emit("editing", f"✏ Edited {file_path}{line_info}", tool=tc.name, file=file_path)
                        elif tc.name == "append_file" and file_path:
                            self._emit("editing", f"📎 Appended to {file_path}{line_info}", tool=tc.name, file=file_path)
                        else:
                            self._emit("editing", f"Applied {tc.name} successfully", tool=tc.name)
                        # Extract and emit the diff from the tool result
                        # Tool outputs now include a "Changes:\n<diff>" section
                        if result.content and "\nChanges:\n" in result.content:
                            diff_text = result.content.split("\nChanges:\n", 1)[1].strip()
                            if diff_text:
                                self._emit(
                                    "file_diff",
                                    diff_text,
                                    tool=tc.name,
                                    file=file_path,
                                )
                    else:
                        self._emit("edit_failed", f"✗ {tc.name} failed: {result.error_kind or 'error'}", tool=tc.name, error_kind=result.error_kind)

                # Track successfully written files for the completion-time
                # verification guard (attempted-but-blocked writes don't count).
                # apply_patch counts too — patched files must pass validation.
                if (
                    result.ok
                    and tc.name in {"write_file", "edit_file", "append_file", "move_file", "apply_patch"}
                    and isinstance(tc.arguments, dict)
                ):
                    if tc.name == "apply_patch":
                        entries = tc.arguments.get("files", [])
                        for entry in entries if isinstance(entries, list) else []:
                            p = entry.get("path") if isinstance(entry, dict) else None
                            if p:
                                written_ok.add(str(p))
                    else:
                        p = tc.arguments.get("path")
                        if p:
                            written_ok.add(str(p))
                    successful_read_calls.clear()

                # --- Redact secrets from tool output ---
                if self._redact:
                    result = ToolResult(
                        tool_call_id=result.tool_call_id,
                        ok=result.ok,
                        content=redact_secrets(result.content),
                        error_kind=result.error_kind,
                    )

                tool_msg = _format_tool_result_as_message(result)
                messages.append(tool_msg)
                transcript.append(tool_msg)
                if result.ok:
                    finished_message = f"{tc.name} completed"
                else:
                    failure_detail = " ".join(str(result.content or "").split())[:220]
                    suffix = f": {failure_detail}" if failure_detail else f": {result.error_kind or 'tool error'}"
                    finished_message = f"{tc.name} needs attention{suffix}"
                self._emit("tool_finished", finished_message, tool=tc.name, ok=result.ok)
                if result.ok and tc.name == "mark_task_done":
                    self._emit("task_done", str(tc.arguments.get("title", "task")), tool=tc.name)

                if read_only_plan_text is not None:
                    break

                if not result.ok:
                    consecutive_errors += 1
                    # Remember the rejection for the stagnation guard: a model
                    # that goes silent right after an error must be forced to
                    # repair, never allowed to finish empty.
                    err_text = str(getattr(result, "content", "") or "")
                    last_tool_error = err_text[:300] if err_text else "tool call failed"
                else:
                    consecutive_errors = 0
                    last_tool_error = None

            # --- Safety: bail on too many consecutive tool errors ---
            if truncated_cut:
                # A cut-off tool call was not executed; we queued a chunking
                # nudge and must re-call the model before judging success.
                truncated_cut = False
                continue
            if plan_paused:
                # The plan was saved this turn and the plan gate is on — hand
                # control back to the user with the plan for review instead of
                # implementing immediately.
                return self._build_result(
                    final_output=plan_text,
                    messages=messages,
                    tracker=tracker,
                    all_tool_calls=all_tool_calls,
                    transcript=transcript,
                    stop_reason="awaiting_approval",
                )
            if read_only_plan_text is not None:
                return self._build_result(
                    final_output=read_only_plan_text,
                    messages=messages,
                    tracker=tracker,
                    all_tool_calls=all_tool_calls,
                    transcript=transcript,
                    stop_reason="completed",
                )
            if consecutive_errors >= self._max_consecutive_tool_errors:
                detail = f" Last tool error: {last_tool_error}" if last_tool_error else ""
                return self._build_result(
                    final_output=(
                        "Stopped after repeated tool errors; the task may be "
                        "incomplete. Fix the reported issue and resume or retry "
                        f"with a smaller step.{detail}"
                    ),
                    messages=messages,
                    tracker=tracker,
                    all_tool_calls=all_tool_calls,
                    transcript=transcript,
                    stop_reason="too_many_tool_errors",
                )

    def _execute_tool(self, tc: ToolCall) -> ToolResult:
        """Run a single tool call and return a ToolResult."""
        tool = self._tools.get(tc.name)
        if tool is None:
            available = ", ".join(sorted(self._tools)) or "(none)"
            return ToolResult(
                tool_call_id=tc.id,
                ok=False,
                content=(
                    f"Unknown tool: {tc.name} — it is NOT available in this "
                    f"session. Available tools: {available}. "
                    "Use only the listed tools; do not retry unavailable ones."
                ),
                error_kind="unknown_tool",
            )
        if self._tool_ctx is None:
            return ToolResult(
                tool_call_id=tc.id,
                ok=False,
                content="No tool context configured",
                error_kind="no_context",
            )
        started = time.monotonic()
        try:
            output: ToolOutput = tool.handler(tc.arguments, self._tool_ctx)
        except Exception as exc:
            output = ToolOutput(ok=False, content=str(exc), error_kind="unhandled_exception")
        finally:
            self._timings["tool_seconds"] += time.monotonic() - started
        return ToolResult(
            tool_call_id=tc.id,
            ok=output.ok,
            content=output.content,
            error_kind=output.error_kind,
        )

    def _build_result(
        self,
        *,
        final_output: str,
        messages: list[dict],
        tracker: BudgetTracker,
        all_tool_calls: list[ToolCall],
        transcript: list[dict],
        stop_reason: str,
        reasoning: str | None = None,
    ) -> AgentRunResult:
        """Assemble the final AgentRunResult."""
        return AgentRunResult(
            final_output=final_output,
            turns=tracker.turn_count,
            tool_calls=tuple(all_tool_calls),
            usage=tracker.total_usage,
            stop_reason=stop_reason,
            transcript=tuple(transcript),
            model_calls_by_model=tracker.model_calls_by_model,
            reasoning=reasoning,
            activity=tuple(self._activity),
            selected_model=next(reversed(tracker.model_calls_by_model), self._model),
            confirmation_required=self._confirmation_required and not self._write_approved,
            verification_outcome="completed" if stop_reason == "completed" else None,
            timings=dict(self._timings),
        )
