import { MAX_BROWSER_FILE_CHUNK_CHARS } from "@/Browser/browserAgentLimits";

/** Extract every complete JSON object candidate from browser-model responses, largest first. */
export function parseAgentJsonCandidates(text: string): unknown[] {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1]);
  const found: unknown[] = [];
  for (const source of [...fenced, text]) {
    // Ignore prose around JSON and braces inside quoted file contents.
    for (let start = source.indexOf("{"); start >= 0; start = source.indexOf("{", start + 1)) {
      let depth = 0;
      let quoted = false;
      let escaped = false;
      for (let index = start; index < source.length; index += 1) {
        const char = source[index];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') quoted = false;
          continue;
        }
        if (char === '"') quoted = true;
        else if (char === "{") depth += 1;
        else if (char === "}" && --depth === 0) {
          try { found.push(JSON.parse(source.slice(start, index + 1)) as unknown); }
          catch { /* not valid JSON — keep scanning later starts */ }
          break;
        }
      }
    }
  }
  // Largest first: when a giant write_plan is truncated mid-stream, inner
  // fragments (e.g. {"path": "."} from DSML markup) also parse — the outer
  // envelope must win over salvaged scraps.
  return found.sort((a, b) => JSON.stringify(b ?? null).length - JSON.stringify(a ?? null).length);
}

/** Extract the first complete JSON object from common browser-model responses. */
export function parseAgentJson<T>(text: string): T {
  const candidates = parseAgentJsonCandidates(text);
  if (!candidates.length) {
    throw new Error("The model did not return valid JSON. Ask it to retry using the provided JSON tool format.");
  }
  return candidates[0] as T;
}

/** Parse JSON with ambiguous quotes via bounded backtracking.
 *
 * Strict parsing dies on one bare quote (e.g. `"Segoe UI",` inside CSS: the
 * closing `"` looks structural because `,` follows). Every in-string `"`
 * followed by `,`/`}`/`]` is a choice point; `:`-quotes are certain and keep
 * the choice set small. Tries escape-heavy combinations first, capped at 2^14.
 */
export function salvageBacktrackJson(text: string): unknown | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  const blob = text.slice(start, end + 1);
  const n = blob.length;
  const nextSig = (i: number): string => {
    let j = i + 1;
    while (j < n && /\s/.test(blob[j])) j += 1;
    return j < n ? blob[j] : "";
  };
  const amb: number[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < n; i += 1) {
    const ch = blob[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        const nxt = nextSig(i);
        if (nxt === ":") inString = false;
        else if (nxt === "," || nxt === "}" || nxt === "]") amb.push(i);
      }
      continue;
    }
    if (ch === '"') inString = true;
  }
  const isEnvelope = (v: unknown): boolean =>
    !!v && typeof v === "object" && !Array.isArray(v) &&
    ["tools", "actions", "files", "done", "answer", "summary"].some((k) => k in (v as Record<string, unknown>));
  const build = (escapeSet: Set<number>): string => {
    let out = "";
    let inS = false;
    let esc = false;
    for (let i = 0; i < n; i += 1) {
      const ch = blob[i];
      if (inS) {
        if (esc) { out += ch; esc = false; continue; }
        if (ch === "\\") { out += ch; esc = true; continue; }
        if (ch === '"') {
          if (escapeSet.has(i)) { out += '\\"'; continue; }
          const nxt = nextSig(i);
          if (nxt === ":" || nxt === "," || nxt === "}" || nxt === "]") { out += ch; inS = false; }
          else out += '\\"';
          continue;
        }
        out += ch;
        continue;
      }
      out += ch;
      if (ch === '"') inS = true;
    }
    return out;
  };
  const attempt = (mask: Set<number>): unknown | undefined => {
    try {
      const v = JSON.parse(build(mask)) as unknown;
      return isEnvelope(v) ? v : undefined;
    } catch {
      return undefined;
    }
  };
  const popcount = (m: number): number => {
    let c = 0;
    while (m > 0) { c += m & 1; m >>= 1; }
    return c;
  };
  if (amb.length <= 14) {
    const total = 1 << amb.length;
    const order: number[] = Array.from({ length: total }, (_, m) => m)
      .sort((a, b) => popcount(b) - popcount(a));
    for (const m of order) {
      const set = new Set<number>();
      for (let j = 0; j < amb.length; j += 1) if ((m >> j) & 1) set.add(amb[j]);
      const hit = attempt(set);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  return attempt(new Set(amb));
}

/** Extract the first candidate matching the required shape (prefers the envelope over inner fragments). */
export function parseAgentJsonShaped<T>(text: string, isValid: (value: unknown) => value is T): T {
  const candidates = parseAgentJsonCandidates(text);
  const shaped = candidates.find(isValid);
  if (shaped !== undefined) return shaped;
  // Best-effort salvage before giving up: models (esp. DeepSeek) paste raw
  // HTML with bare quotes into "content", which breaks strict parsing.
  const repaired = repairModelJson(text);
  if (repaired && repaired !== text) {
    const recandidates = parseAgentJsonCandidates(repaired);
    const reshaped = recandidates.find(isValid);
    if (reshaped !== undefined) return reshaped;
  }
  const salvaged = salvageBacktrackJson(text);
  if (salvaged !== undefined && isValid(salvaged)) return salvaged;
  if (!candidates.length) {
    throw new Error(`The model did not return valid JSON. ${diagnoseJsonFailure(text)} Ask it to retry using the provided JSON tool format.`);
  }
  throw new Error(`The JSON did not match the required Browser Agent response shape. ${diagnoseJsonFailure(text)}`);
}

/** Explain the likely cause of a JSON failure so the repair prompt can name it. */
export function diagnoseJsonFailure(text: string): string {
  // Raw HTML with attributes inside what should be a JSON string value.
  if (/<[a-zA-Z][^<>]*\s[a-zA-Z-]+="[^"]*"[^<>]*>/.test(text)) {
    return "Likely cause: file content contains unescaped double quotes (e.g. <html lang=\"en\">) — every \" inside a JSON string must be written as \\\" .";
  }
  const open = (text.match(/{/g) ?? []).length;
  const close = (text.match(/}/g) ?? []).length;
  if (open > close + 2) {
    return "Likely cause: the reply was cut off mid-JSON (unbalanced braces) — re-send the same action in smaller chunks.";
  }
  return "";
}

/** Best-effort repair of model JSON with unescaped quotes inside string values.
 *
 * Walks the text tracking JSON string state. A `"` met while inside a string
 * is structural only when the next non-space character is `:`, `,`, `}` or
 * `]` — otherwise it is content (e.g. an HTML attribute quote) and is escaped
 * to `\"`. Raw newlines/tabs inside strings become `\n`/`\t`. Returns the
 * repaired text, or null when there is nothing salvageable. Strict parsing is
 * always tried first; this only runs as a fallback and the result must still
 * pass shape validation before anything is executed.
 */
export function repairModelJson(text: string): string | null {
  if (!text || !text.includes('"') || !text.includes("{")) return null;
  let out = "";
  let inString = false;
  let escaped = false;
  let changed = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        out += char;
        escaped = false;
        continue;
      }
      if (char === "\\") {
        out += char;
        escaped = true;
        continue;
      }
      if (char === '"') {
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j += 1;
        const next = text[j] ?? "";
        if (next === ":" || next === "," || next === "}" || next === "]") {
          out += char;
          inString = false;
        } else {
          out += '\\"';
          changed = true;
        }
        continue;
      }
      if (char === "\n") {
        out += "\\n";
        changed = true;
        continue;
      }
      if (char === "\r") {
        out += "\\r";
        changed = true;
        continue;
      }
      if (char === "\t") {
        out += "\\t";
        changed = true;
        continue;
      }
      out += char;
      continue;
    }
    out += char;
    if (char === '"') inString = true;
  }
  if (!changed) return null;
  return out;
}

export interface NormalizedBrowserToolAction {
  tool: string;
  args: Record<string, unknown>;
  error?: string;
}

/** Canonical xvie tool vocabulary shared with Backend/browser-agent/browser_loop.py. */
export const BROWSER_TOOL_NAMES = new Set([
  "list_files", "list_dir", "read_file", "search_text", "grep_search", "glob_search",
  "think", "write_plan", "mark_task_done", "ask_question", "write_file", "append_file", "edit_file",
  "verify_file", "check_contrast", "read_ui_reference", "search_images", "finish", "done",
]);

const TOOL_NAME_KEYS = ["tool", "name", "tool_name", "toolName", "action", "functionName", "function_name", "cmd", "command"] as const;
const TOOL_ARGS_KEYS = ["args", "arguments", "parameters", "params", "input"] as const;

/** Frontend aliases → canonical xvie names (mirrors backend _TOOL_ALIASES). */
const TOOL_ALIASES: Record<string, string> = {
  list_files: "list_dir",
  listfiles: "list_dir",
  list: "list_dir",
  search_text: "grep_search",
  search: "grep_search",
  grep: "grep_search",
  glob: "glob_search",
  read: "read_file",
  write: "write_file",
  edit: "edit_file",
  append: "append_file",
  finish: "finish",
  complete: "finish",
  done: "finish",
};

export function canonicalBrowserToolName(raw: string): string {
  const lowered = raw.trim().toLowerCase();
  if (TOOL_ALIASES[lowered]) return TOOL_ALIASES[lowered];
  // Known canonical names are case-insensitive (DeepSeek sends READ_FILE).
  if (BROWSER_TOOL_NAMES.has(lowered)) return lowered;
  return raw.trim();
}

/** Accept the tool-call shapes returned by browser chat models and normalize them. */
export function normalizeBrowserToolAction(value: unknown): NormalizedBrowserToolAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { tool: "", args: {}, error: "Tool action must be an object." };
  }
  const action = value as Record<string, unknown>;
  const nestedFunction = action.function && typeof action.function === "object" && !Array.isArray(action.function)
    ? action.function as Record<string, unknown>
    : undefined;
  const lookup = (key: string): unknown => {
    const direct = action[key];
    if (typeof direct === "string" && direct.trim()) return direct;
    return undefined;
  };
  let rawTool: unknown;
  for (const key of TOOL_NAME_KEYS) {
    const found = lookup(key);
    if (found !== undefined) { rawTool = found; break; }
  }
  if (rawTool === undefined && nestedFunction && typeof nestedFunction.name === "string" && nestedFunction.name.trim()) {
    rawTool = nestedFunction.name;
  }
  if (rawTool === undefined && typeof action.type === "string" && action.type.trim()) {
    // DeepSeek {type: "read_file", path} style — accept any non-empty type.
    rawTool = action.type;
  }
  const tool = typeof rawTool === "string" ? canonicalBrowserToolName(rawTool) : "";
  let rawArgs: unknown;
  for (const key of TOOL_ARGS_KEYS) {
    if (action[key] !== undefined && action[key] !== null) { rawArgs = action[key]; break; }
  }
  if (rawArgs === undefined && nestedFunction?.arguments !== undefined && nestedFunction.arguments !== null) {
    rawArgs = nestedFunction.arguments;
  }
  let args: unknown = rawArgs;
  if (typeof args === "string") {
    try { args = JSON.parse(args) as unknown; }
    catch { return { tool, args: {}, error: "Tool arguments were not valid JSON." }; }
  }
  if (args === undefined || args === null) {
    // Older Browser Agent responses put tool parameters beside `tool`.
    args = action;
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { tool, args: {}, error: "Tool arguments must be a JSON object." };
  }
  if (!tool) return { tool: "", args: args as Record<string, unknown>, error: "Tool action is missing its name." };
  const normalizedArgs = { ...(args as Record<string, unknown>) };
  // DeepSeek echoes its discriminator inside flat args — drop it.
  delete normalizedArgs.type;
  if (tool === "think" && typeof normalizedArgs.thought !== "string" && typeof normalizedArgs.summary === "string") {
    normalizedArgs.thought = normalizedArgs.summary;
  }
  // Backend uses list_dir/grep_search/glob_search; frontend snapshot uses
  // list_files/search_text — normalize path/query keys both ways.
  if ((tool === "list_dir" || tool === "grep_search" || tool === "glob_search") && typeof normalizedArgs.query === "string" && typeof normalizedArgs.pattern !== "string") {
    normalizedArgs.pattern = normalizedArgs.query;
  }
  return { tool, args: normalizedArgs };
}

/** Collect bare single-action objects (no `actions` envelope) from a reply.
 *
 * Weak models often emit `{"tool":"read_file","args":{...}}` alone, or several
 * such objects MCQ-separated ("JSON lines"), instead of the
 * `{"actions":[...]}` envelope. This gathers every candidate that normalizes
 * to a named tool, in order, dropping exact duplicates (models frequently
 * echo the same call twice). Returns null when nothing action-shaped exists.
 */
export function collectBareToolActions(text: string): Array<Record<string, unknown>> | null {
  const candidates = parseAgentJsonCandidates(text);
  const actions: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    // Skip envelopes here — the normal envelope path handles those.
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate) &&
        ("actions" in (candidate as Record<string, unknown>) || "files" in (candidate as Record<string, unknown>))) {
      continue;
    }
    const normalized = normalizeBrowserToolAction(candidate);
    if (normalized.error || !normalized.tool) continue;
    const key = `${normalized.tool}:${JSON.stringify(normalized.args)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    actions.push({ tool: normalized.tool, args: normalized.args });
  }
  return actions.length ? actions : null;
}

/** Every model reply must be exactly one JSON object in one of these shapes:
 * - Tool turn:        {"actions": [{"tool": "...", "args": {...}}], "summary": "..."}
 * - Direct answer:    {"actions": [], "message": "<answer for the user>"}
 *   (greetings and questions that need no tools use this — the model decides
 *   by prompt, never prose outside JSON)
 * - One-shot files:   {"files": [{"path": "...", "content": "..."}], "summary": "..."}
 * - Explicit finish:  {"actions": [{"tool": "finish"}], "summary": "..."}
 */
export interface NormalizedAgentReply {
  actions: Array<Record<string, unknown>>;
  summary: string;
  files?: unknown;
  done?: boolean;
}

function replyText(value: Record<string, unknown>): string {
  for (const key of ["message", "answer", "summary", "text"]) {
    if (typeof value[key] === "string") return (value[key] as string).trim();
  }
  return "";
}

/** Normalize any valid reply shape into {actions, summary}. Returns null when invalid. */
export function normalizeAgentReply(value: unknown): NormalizedAgentReply | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (Array.isArray(payload.actions)) {
    return {
      actions: payload.actions as Array<Record<string, unknown>>,
      summary: replyText(payload),
    };
  }
  if (Array.isArray(payload.files)) {
    return { actions: [], summary: replyText(payload), files: payload.files };
  }
  if (payload.done === true) {
    return { actions: [], summary: replyText(payload), done: true };
  }
  // Direct answer without an actions array (greeting / plain question).
  const text = replyText(payload);
  if (text) return { actions: [], summary: text };
  return null;
}

/** Guard: true for any of the unified reply shapes (tool, direct, files, done). */
export function isStructuredAgentReply(value: unknown): value is Record<string, unknown> {
  return normalizeAgentReply(value) !== null;
}

/** Parse a tool response, asking the provider once to repair malformed output. */
export async function parseAgentJsonWithRetry<T>(options: {
  response: string;
  ask: (prompt: string) => Promise<string>;
  isValid: (value: unknown) => value is T;
  retryPrompt: (response: string, reason: string) => string;
  onRetry?: (attempt: number, durationMs: number, succeeded: boolean) => void;
}): Promise<T> {
  const parse = (response: string): T => parseAgentJsonShaped(response, options.isValid);
  // Keep retrying through malformed turns (up to 3 rounds): transient
  // provider glitches and escaping slips are recoverable, and every retry
  // carries a more specific correction hint than the last.
  const ESCAPE_HINT = ` Escape quotes and newlines inside JSON strings; keep file content chunks at or below ${MAX_BROWSER_FILE_CHUNK_CHARS.toLocaleString()} characters.`;
  const CHUNK_HINT = ` If truncated, resend the same write in ${MAX_BROWSER_FILE_CHUNK_CHARS.toLocaleString()}-character chunks using write_file then append_file.`;

  let lastResponse = options.response;
  let lastError: unknown = null;
  for (let round = 0; round < 3; round += 1) {
    try {
      return parse(lastResponse);
    } catch (err) {
      lastError = err;
    }
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    // Escalate: later rounds name the exact fix instead of repeating the generic prompt.
    const extra = round === 0 ? "" : round === 1 ? ESCAPE_HINT : `${ESCAPE_HINT}${CHUNK_HINT}`;
    let corrected: string;
    const retryStartedAt = performance.now();
    let retrySucceeded = false;
    try {
      corrected = await options.ask(options.retryPrompt(
        lastResponse.slice(0, 6_000),
        `${reason}${extra}`
      ));
      retrySucceeded = true;
    } catch (retryError) {
      const retryReason = retryError instanceof Error ? retryError.message : String(retryError);
      throw new Error(`The Browser Agent response could not be repaired. No workspace edits were staged. ${retryReason}`);
    } finally {
      try {
        options.onRetry?.(round + 1, Math.round(performance.now() - retryStartedAt), retrySucceeded);
      } catch {
        // Diagnostics must not change whether a repaired reply is accepted.
      }
    }
    lastResponse = corrected;
  }
  try {
    return parse(lastResponse);
  } catch {
    const usefulResponse = lastResponse.trim().slice(0, 1_200);
    throw new Error(
      `The model still did not return a usable Browser Agent tool response after 3 retries. No workspace edits were staged.` +
        (usefulResponse ? ` Last response: ${usefulResponse}` : "")
    );
  }
}

const PLACEHOLDER_AGENT_PATHS = new Set([
  "optional/prefix",
  "optional/path",
  "relative/file",
  "relative/path",
  "workspace-relative/path",
  "path/to/file",
  "your/file"
]);

/** Reject literal path examples that models sometimes copy from tool schemas. */
export function isPlaceholderAgentPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  return PLACEHOLDER_AGENT_PATHS.has(normalized);
}

export function requestedProjectFileNames(task: string): Set<string> {
  const names = new Set<string>();
  const pattern = /(?:^|[\s"'`])([a-z0-9_.-]+(?:[\\/][a-z0-9_.-]+)*\.(?:html?|css|tsx?|jsx?|json|md|py|vue|svelte))(?=$|[\s"'`.,;:!?])/gi;
  for (const match of task.matchAll(pattern)) {
    const normalized = match[1].replace(/\\/g, "/").toLowerCase();
    names.add(normalized);
    names.add(normalized.split("/").at(-1)!);
  }
  return names;
}

export function projectFilePriority(path: string, task: string, requested: Set<string>): number {
  const normalized = path.toLowerCase();
  const basename = normalized.split("/").at(-1) ?? normalized;
  const words = task.toLowerCase().match(/[a-z0-9_-]{3,}/g) ?? [];
  let score = 0;
  if (requested.has(normalized)) score += 20_000;
  else if (requested.has(basename)) score += 15_000;
  for (const word of new Set(words)) {
    if (basename.includes(word)) score += 500;
    else if (normalized.includes(word)) score += 100;
  }
  if (/\b(style|styling|design|visual|layout|html|website|webpage)\b/i.test(task) && /\.(html?|css|tsx?|jsx?)$/i.test(path)) score += 250;
  if (/\b(style|styling|design|visual|layout)\b/i.test(task) && /(?:^|\/)(?:style|styles|theme|global|app)\.[^.]+$/i.test(path)) score += 400;
  score -= normalized.split("/").length * 5;
  return score;
}

export function requestedFileMustBePreserved(task: string, path: string): boolean {
  const asksForAnotherCopy = /\b(?:another|new|separate|alternative)\b.{0,30}\b(?:version|copy|design)\b/i.test(task) ||
    /\bwithout\s+(?:destroying|changing|overwriting|replacing|modifying)\b/i.test(task);
  if (!asksForAnotherCopy) return false;
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const names = requestedProjectFileNames(task);
  return names.has(normalized) || names.has(normalized.split("/").at(-1)!);
}

/** Extract a human-readable summary from a growing JSON reply without showing its tool protocol. */
export function previewBrowserAgentStream(partial: string): string | null {
  const text = partial.trim();
  if (!text) return null;
  // Only read the first root field. This prevents nested tool arguments that
  // happen to contain a key named "summary" from leaking protocol data.
  const field = /^\s*\{\s*"(?:summary|message)"\s*:\s*"((?:[^"\\]|\\.)*)/s.exec(text);
  if (field) {
    const raw = field[1];
    // JSON may end on a half escape while the model is streaming. Trim at
    // most six trailing characters until the available prefix is decodable.
    for (let end = raw.length; end >= Math.max(0, raw.length - 6); end -= 1) {
      try {
        const decoded = JSON.parse(`"${raw.slice(0, end)}"`) as string;
        if (decoded.trim()) return `${decoded.slice(0, 400)}…`;
      } catch { /* wait for the rest of an incomplete escape */ }
    }
    return null;
  }
  if (text.startsWith("{") || text.startsWith("[")) return null;
  return `${text.slice(0, 400)}…`;
}
