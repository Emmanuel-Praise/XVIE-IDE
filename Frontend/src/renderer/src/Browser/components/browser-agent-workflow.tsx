import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, ChevronDown, CircleAlert, Code2, History, Loader2, MessageSquare, Plus, Send, Settings2, Sparkles, Square, Trash2 } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { useBrowserStore } from "@/Browser/browserStore";
import { BROWSER_SITES } from "@/Browser/browserSites";
import { agentEligibleSites, isChatOnlySite } from "@/Browser/browserModelMeta";
import { BRAND_TINT, BrandIcon } from "@/Browser/components/brand-icons";
import { useFileSystemStore } from "@/Editor/fs/fileSystemStore";
import { useEditorStore } from "@/Editor/editorStore";
import type { BrowserSiteId, WorkspaceFileChange } from "../../../../shared/ipc-types";
import { canonicalBrowserToolName, collectBareToolActions, isPlaceholderAgentPath, isStructuredAgentReply, normalizeAgentReply, normalizeBrowserToolAction, parseAgentJson, parseAgentJsonShaped, parseAgentJsonWithRetry, previewBrowserAgentStream, projectFilePriority, requestedFileMustBePreserved, requestedProjectFileNames } from "@/Browser/browserAgentProtocol";
import { BROWSER_DESIGN_REMINDER, BROWSER_XVIE_MODE_PROMPTS, conversationKey, isImplementSavedPlanRequest, normalizeTaskSpelling, toolsForBrowserXvieMode } from "@/Browser/browserXvieModes";
import { MAX_BROWSER_FILE_CHUNK_CHARS, MAX_BROWSER_JSON_REPLY_CHARS } from "@/Browser/browserAgentLimits";
import { findMissingCssClasses, formatContrastReport, matchPlanStepTitle, verifyFileContent } from "@/Browser/browserVerify";
import MessageItem from "@/Agent/components/conversation/message-item";
import QuestionCard from "@/Agent/components/conversation/question-card";
import type { AgentQuestion } from "@/Agent/types";
import ToolRow from "@/Agent/components/conversation/tool-row";
import type { Message, MessageStatus } from "@/Agent/types";
import { AGENT_MODES } from "@/Agent/data/modes";
import type { AgentMode } from "@/Agent/types";
import { browserActivityId, diffForChange, kindForTool, thinkActivity, type BrowserActivityItem } from "@/Browser/browserActivity";
import BrowserAgentWelcome from "@/Browser/components/browser-agent-welcome";
import "@/Agent/styles/agent-markdown.css";

// --- Browser ask_question bus (module-level so the isolated agent runner,
// which lives outside the React component, can pause-and-wait for answers) ---
export type BrowserAnswer = { id: string; selected: string[]; custom_text: string };
let browserPendingQuestions: AgentQuestion[] = [];
let browserQuestionsResolver: ((answers: BrowserAnswer[]) => void) | null = null;
const browserQuestionsListeners = new Set<() => void>();
function emitBrowserQuestions(): void {
  for (const listener of browserQuestionsListeners) {
    try { listener(); } catch { /* listener errors must not break the run */ }
  }
}
export function getBrowserPendingQuestions(): AgentQuestion[] {
  return browserPendingQuestions;
}
export function subscribeBrowserQuestions(listener: () => void): () => void {
  browserQuestionsListeners.add(listener);
  return () => { browserQuestionsListeners.delete(listener); };
}
export function requestBrowserAnswers(questions: AgentQuestion[]): Promise<BrowserAnswer[]> {
  browserPendingQuestions = questions;
  emitBrowserQuestions();
  return new Promise<BrowserAnswer[]>((resolve) => {
    browserQuestionsResolver = resolve;
  });
}
export function resolveBrowserAnswers(answers: BrowserAnswer[]): void {
  browserPendingQuestions = [];
  emitBrowserQuestions();
  browserQuestionsResolver?.(answers);
  browserQuestionsResolver = null;
}
export function cancelBrowserAnswers(): void {
  browserPendingQuestions = [];
  emitBrowserQuestions();
  browserQuestionsResolver?.([]);
  browserQuestionsResolver = null;
}

interface SourceFile { path: string; content: string; hash: string; absolutePath: string; bufferContent?: string }
interface ProposedFile { path: string; content: string }
interface BrowserPlanStep { title: string; description: string; files_touched: string[] }
interface BrowserImplementationPlan {
  title: string;
  summary: string;
  steps: BrowserPlanStep[];
  risks: string[];
  design_brief?: Record<string, string>;
}
interface WorkflowHistoryEntry { id: string; title: string; date: number; coordinator: BrowserSiteId; workers: BrowserSiteId[]; outcome: string; summary: string; files: string[]; mode?: AgentMode; conversationId?: string; workspaceRoot?: string }
interface AgentProgressCheckpoint {
  site: BrowserSiteId;
  task: string;
  conversationId: string;
  virtualFiles: Record<string, string>;
  baselineFiles: Record<string, string>;
  fullyRead: string[];
  writeStarted?: string[];
  pendingPrompt?: string;
  pendingOutput?: string;
  summary: string;
  turns: number;
  plan?: BrowserImplementationPlan;
  completedTasks?: string[];
}
interface AgentSavedResult { files: ProposedFile[]; summary: string }
interface PendingBrowserRun {
  workspaceRoot: string;
  task: string;
  mode?: AgentMode;
  plan?: string;
  planDetails?: BrowserImplementationPlan;
  planSteps?: BrowserPlanStep[];
  planMessageId?: string;
  changedPaths?: string[];
  coordinator: BrowserSiteId;
  workers: BrowserSiteId[];
  createdAt: number;
  updatedAt: number;
  sourceHashes: Record<string, string>;
  sourceContentHashes: Record<string, string>;
  conversations: Partial<Record<BrowserSiteId, string>>;
  conversationIsolationVersion?: number;
  agentTasks: Partial<Record<BrowserSiteId, string>>;
  agentProgress: Partial<Record<BrowserSiteId, AgentProgressCheckpoint>>;
  agentResults: Partial<Record<BrowserSiteId, AgentSavedResult>>;
  phase: "agents" | "review";
}

const HISTORY_KEY = "xvie-browser-agent-history";
const MODEL_CONFIG_KEY = "xvie-browser-agent-model-config";
const MODE_KEY = "xvie-browser-agent-mode";
const CHAT_KEY = "xvie-browser-agent-chat";
const CONVERSATIONS_KEY = "xvie-browser-agent-conversations";
const WORKSPACE_FINGERPRINTS_KEY = "xvie-browser-agent-workspace-fingerprints-v1";
const LAST_PLAN_KEY = "xvie-browser-agent-last-plan";
const PENDING_RUN_PREFIX = "xvie-browser-agent-pending:";
const HISTORY_RESET_KEY = "xvie-browser-agent-history-reset-v1";
const CONTEXT_RESET_KEY = "xvie-browser-agent-context-reset-v1";
try {
  if (typeof localStorage !== "undefined" && localStorage.getItem(HISTORY_RESET_KEY) !== "done") {
    localStorage.removeItem(HISTORY_KEY);
    localStorage.removeItem(CHAT_KEY);
    localStorage.removeItem(CONVERSATIONS_KEY);
    localStorage.setItem(HISTORY_RESET_KEY, "done");
  }
} catch { /* Browser Agent storage may be unavailable in restricted contexts. */ }
try {
  if (typeof localStorage !== "undefined" && localStorage.getItem(CONTEXT_RESET_KEY) !== "done") {
    // Older releases kept plan and code turns in one provider thread. Keep
    // saved run checkpoints (they may contain unapplied work), but start fresh
    // provider conversations and discard the stale automatic-plan pointer.
    localStorage.removeItem(CONVERSATIONS_KEY);
    localStorage.removeItem(LAST_PLAN_KEY);
    localStorage.setItem(CONTEXT_RESET_KEY, "done");
  }
} catch { /* Browser Agent storage may be unavailable in restricted contexts. */ }
interface BrowserAgentModelConfig { coordinator: BrowserSiteId; workers: BrowserSiteId[]; configured: boolean }
function readModelConfig(): BrowserAgentModelConfig | null {
  try {
    const value = JSON.parse(localStorage.getItem(MODEL_CONFIG_KEY) ?? "null") as Partial<BrowserAgentModelConfig> | null;
    if (!value || !BROWSER_SITES.some((site) => site.id === value.coordinator)) return null;
    const workers = Array.isArray(value.workers) ? value.workers.filter((id): id is BrowserSiteId => BROWSER_SITES.some((site) => site.id === id) && id !== value.coordinator).slice(0, 2) : [];
    return { coordinator: value.coordinator as BrowserSiteId, workers, configured: value.configured === true };
  } catch { return null; }
}
function readAgentMode(): AgentMode {
  try {
    const value = localStorage.getItem(MODE_KEY);
    return AGENT_MODES.some((mode) => mode.id === value) ? value as AgentMode : "code";
  } catch { return "code"; }
}
function readWorkflowHistory(): WorkflowHistoryEntry[] {
  try {
    const value = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as WorkflowHistoryEntry[];
    return Array.isArray(value) ? value.slice(0, 25) : [];
  } catch { return []; }
}

const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "dist", "build", "out", ".next", "coverage", ".xvie-sessions", ".xvie", ".forge-sessions", "__pycache__", ".pytest_cache"]);
// Compaction budget: DeepSeek-style web UIs degrade past ~15k chars per
// prompt (slow sends, stalls, truncated JSON). Mirror xvie's bounded
// inventory + 6k relevant-context discipline instead of 24k dumps.
const MAX_CONTEXT_CHARS = 14_000;
const MAX_FILES = 48;
const MAX_SCAN_DIRECTORIES = 400;
const MAX_FILE_CANDIDATES = 2_000;
const MAX_AGENT_FILE_CHARS = 64_000;
function pendingRunKey(root: string): string { return `${PENDING_RUN_PREFIX}${root}`; }
function readPendingRun(root: string): PendingBrowserRun | null {
  try {
    const value = JSON.parse(localStorage.getItem(pendingRunKey(root)) ?? "null") as PendingBrowserRun | null;
    return value && value.workspaceRoot === root ? value : null;
  } catch { return null; }
}

function normalizeBrowserPlan(value: Record<string, unknown>): BrowserImplementationPlan {
  let rawSteps = value.steps;
  if (typeof rawSteps === "string") {
    try { rawSteps = JSON.parse(rawSteps) as unknown; }
    catch { throw new Error("write_plan steps must be a JSON array of step objects."); }
  }
  // Weak models sometimes send a single step object instead of an array.
  if (rawSteps && typeof rawSteps === "object" && !Array.isArray(rawSteps)) rawSteps = [rawSteps];
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) throw new Error("write_plan requires at least one implementation step.");
  if (rawSteps.length > 30) throw new Error("write_plan supports at most 30 implementation steps.");
  const steps = rawSteps.map((raw, index): BrowserPlanStep => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Plan step ${index + 1} must be an object.`);
    const step = raw as Record<string, unknown>;
    // Accept common title/description/files aliases so a valid plan is never
    // rejected for a key-name variation ("Plan step N needs a title").
    const suppliedTitle = ["title", "name", "heading"].map((key) => typeof step[key] === "string" ? (step[key] as string).trim() : "").find(Boolean) ?? "";
    const title = suppliedTitle || (typeof step.step === "number" || typeof step.step === "string"
      ? `Step ${String(step.step).trim()}`
      : "");
    if (!title) throw new Error(`Plan step ${index + 1} needs a title.`);
    const files = Array.isArray(step.files_touched) ? step.files_touched
      : Array.isArray(step.files) ? step.files
      : typeof step.file === "string" ? [step.file] : [];
    const description = ["description", "desc", "detail", "summary"].map((key) => typeof step[key] === "string" ? (step[key] as string).trim() : "").find(Boolean) ?? "";
    return {
      title,
      description,
      files_touched: files.filter((file): file is string => typeof file === "string").map((file) => file.replace(/\\/g, "/").trim()).filter(Boolean),
    };
  });
  const normalizedTitles = steps.map((step) => step.title.toLowerCase());
  if (new Set(normalizedTitles).size !== normalizedTitles.length) throw new Error("Plan step titles must be unique so mark_task_done can identify each step.");
  const risks = Array.isArray(value.risks) ? value.risks.filter((risk): risk is string => typeof risk === "string") : [];
  const rawDesignBrief = value.design_brief && typeof value.design_brief === "object" && !Array.isArray(value.design_brief)
    ? value.design_brief as Record<string, unknown>
    : {};
  const design_brief = Object.fromEntries(["tokens", "refs", "motion_budget", "thesis", "stack"]
    .map((key) => [key, rawDesignBrief[key]])
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && !!entry[1].trim())
    .map(([key, item]) => [key, item.trim()]));
  return {
    title: typeof value.title === "string" && value.title.trim() ? value.title.trim() : "Implementation plan",
    summary: typeof value.summary === "string" ? value.summary.trim() : "",
    steps,
    risks,
    ...(Object.keys(design_brief).length ? { design_brief } : {}),
  };
}

function renderBrowserPlan(plan: BrowserImplementationPlan, completed: ReadonlySet<string> = new Set()): string {
  const lines = [`# ${plan.title}`, ""];
  if (plan.summary) lines.push(plan.summary, "");
  lines.push("## Steps", "");
  for (const step of plan.steps) {
    const done = [...completed].some((title) => title.toLowerCase() === step.title.toLowerCase());
    const files = step.files_touched.length ? ` (files: ${step.files_touched.map((file) => `\`${file}\``).join(", ")})` : "";
    lines.push(`- [${done ? "x" : " "}] **${step.title}**${step.description ? ` — ${step.description}` : ""}${files}`);
  }
  const designKeys = ["tokens", "refs", "motion_budget", "thesis", "stack"] as const;
  const designLines = designKeys.flatMap((key) => plan.design_brief?.[key] ? [`- ${key}: ${plan.design_brief[key]}`] : []);
  if (designLines.length) lines.push("", "## Design", "", ...designLines);
  if (plan.risks.length) lines.push("", "## Risks & open questions", "", ...plan.risks.map((risk) => `- ${risk}`));
  const files = [...new Set(plan.steps.flatMap((step) => step.files_touched))];
  if (files.length) lines.push("", "## Files touched", "", ...files.map((file) => `- \`${file}\``));
  return lines.join("\n");
}

async function digest(content: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/** Mirror xvie-agent's plan-file convention: `.xvie/plans/<UTC-ts>-<slug>.md`. */
function browserPlanFileName(title: string, when = new Date()): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "plan";
  const pad = (value: number): string => String(value).padStart(2, "0");
  const ts = `${when.getUTCFullYear()}${pad(when.getUTCMonth() + 1)}${pad(when.getUTCDate())}-${pad(when.getUTCHours())}${pad(when.getUTCMinutes())}${pad(when.getUTCSeconds())}`;
  return `.xvie/plans/${ts}-${slug}.md`;
}

/** Save the structured plan to `.xvie/plans/` like xvie-agent does.
 * Best-effort: a failure is reported in chat but never blocks the run —
 * the plan also lives in the run checkpoint and the chat transcript. */
async function persistBrowserPlanFile(plan: BrowserImplementationPlan, note: (line: string) => void): Promise<string | null> {
  const path = browserPlanFileName(plan.title);
  try {
    const result = await window.api.workspace.applyFileChanges([
      { path, content: `${renderBrowserPlan(plan)}\n`, expectedHash: null },
    ]);
    if (!result.success) throw new Error(result.error);
    note(`Saved plan to ${path}`);
    return path;
  } catch (err) {
    note(`Plan file could not be saved (${err instanceof Error ? err.message : String(err)}); the plan remains in this chat`);
    return null;
  }
}

interface SavedBrowserPlan { workspaceRoot: string; task: string; plan: BrowserImplementationPlan; planFile: string | null; updatedAt: number; workspaceFingerprint?: string }
function readLastPlan(root: string): SavedBrowserPlan | null {
  try {
    const value = JSON.parse(localStorage.getItem(LAST_PLAN_KEY) ?? "null") as SavedBrowserPlan | null;
    return value && value.workspaceRoot === root && value.plan ? value : null;
  } catch { return null; }
}
function writeLastPlan(entry: SavedBrowserPlan): void {
  try { localStorage.setItem(LAST_PLAN_KEY, JSON.stringify(entry)); } catch { /* plan persistence is best-effort */ }
}


interface ChatMessageEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
  ts?: number;
  site?: BrowserSiteId;
  status?: MessageStatus;
  files?: string[];
}
interface ChatActivityEntry {
  id: string;
  role: "activity";
  text: string;
  ts?: number;
  item?: BrowserActivityItem;
}
type ChatEntry = ChatMessageEntry | ChatActivityEntry;

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Closest real block in `current` to a failed `oldStr`, for edit retries.
 * Word-overlap window so the model copies bytes that exist. */
function closestBlockHint(current: string, oldStr: string): string {
  const lines = current.split("\n");
  const want = oldStr.toLowerCase().split(/\s+/).filter(Boolean);
  if (!want.length || !lines.length) return "";
  const wantSet = new Set(want);
  const span = Math.min(Math.max(oldStr.split("\n").length, 3), 12);
  let best = 0;
  let bestIdx = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const window = lines.slice(i, i + span).join(" ").toLowerCase().split(/\s+/);
    const hit = new Set(window.filter((w) => wantSet.has(w))).size;
    if (hit > best) { best = hit; bestIdx = i; }
  }
  if (!best) return "";
  const start = Math.max(0, bestIdx - 1);
  return lines.slice(start, start + span + 1).map((l, i) => `${start + i + 1}: ${l}`.slice(0, 200)).join("\n").slice(0, 900);
}

function messageFor(entry: ChatMessageEntry): Message {
  return {
    id: entry.id,
    role: entry.role,
    content: entry.text,
    status: entry.status ?? "done",
    timestamp: entry.ts ?? Date.now(),
    fileRefs: [],
  };
}

function activityFor(entry: ChatActivityEntry): BrowserActivityItem {
  if (entry.item) return entry.item;
  // Older saved Browser Agent transcripts used plain text activity records.
  return {
    id: entry.id,
    kind: "run",
    target: entry.text,
    status: "completed",
    timestamp: entry.ts ?? Date.now(),
  };
}
function readChatTranscript(): ChatEntry[] {
  try {
    const value = JSON.parse(localStorage.getItem(CHAT_KEY) ?? "[]") as ChatEntry[];
    return Array.isArray(value) ? value.slice(-100) : [];
  } catch { return []; }
}
function readModelConversations(): Partial<Record<string, string>> {
  try { return JSON.parse(localStorage.getItem(CONVERSATIONS_KEY) ?? "{}") as Partial<Record<string, string>>; }
  catch { return {}; }
}
function readWorkspaceFingerprints(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(WORKSPACE_FINGERPRINTS_KEY) ?? "{}") as Record<string, string>; }
  catch { return {}; }
}
function workspaceFingerprintKey(root: string): string {
  return root.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
}
async function fingerprintWorkspacePaths(paths: string[]): Promise<string> {
  return digest(JSON.stringify([...new Set(paths)].sort((left, right) => left.localeCompare(right))));
}
/** Never reuse a legacy site-only thread: it may carry Plan instructions into Code mode. */
function getModelConversation(store: { current: Partial<Record<string, string>> }, site: BrowserSiteId, mode: AgentMode): string | undefined {
  return store.current[conversationKey(site, mode)];
}
function setModelConversation(store: { current: Partial<Record<string, string>> }, site: BrowserSiteId, mode: AgentMode, id: string): void {
  store.current[conversationKey(site, mode)] = id;
  try { localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(store.current)); } catch { /* provider history remains available */ }
}

function validRelativePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return !!normalized && !normalized.startsWith("/") && !/^[a-z]:/i.test(normalized) &&
    normalized.split("/").every((part) => part && part !== "." && part !== "..") && !normalized.includes("\0");
}

function shouldDelegateTask(task: string): boolean {
  const text = task.trim();
  if (!text) return false;
  // Keep focused requests on one agent. Parallel planning is useful when the
  // user asks for it or describes multiple substantial, independent pieces.
  if (/\b(parallel|delegate|independent subtasks?|split (this|the task)|multiple agents?)\b/i.test(text)) return true;
  const words = text.split(/\s+/).filter(Boolean).length;
  const sentences = text.split(/[.!?]+/).filter((part) => part.trim()).length;
  return words >= 40 && sentences >= 2;
}

/** Obvious greeting only: whole message is a greeting, nothing else. Anything
 * with extra words ("hello, review X", "hi please fix…") is NOT obvious and
 * goes to the model with the full template so it can decide. */
function isObviousGreeting(task: string): boolean {
  return /^\s*(?:hi+|hello+|hey+|yo|sup|howdy|greetings|good\s+(?:morning|afternoon|evening|day)|thanks(?:\s+you)?(?:\s+(?:so|very)\s+much)?|thank\s+you|bye+|goodbye|see\s+ya)\s*[!.?,\s]*$/i.test(task.trim());
}

function isWorkspaceCodingTask(task: string): boolean {
  // Treat this as a coding task only when an action is tied to a workspace or
  // code target; ordinary requests like "write a summary" stay in chat.
  const action = /\b(edit|change|modify|fix|repair|debug|implement|code|refactor|create|add|remove|delete|rename|write|rewrite|rework|update|build|test|run|inspect|read|review|explain|analy[sz]e|find|search|open|redesign|improve|style|restyle|revamp|check|verify|compare|validate|audit|diagnose|look)\b/i;
  // Design-family words are workspace targets too: "change the current
  // design" names no file but unmistakably means editing the project.
  const target = /\b(file|files|folder|folders|project|workspace|repository|repo|source|codebase|code|frontend|app|application|website|webpage|component|function|class|script|bug|error|feature|test|tests|ui|interface|dashboard|landing page|design|redesign|style|styling|styles|layout|theme|look|appearance|page)\b|\b[a-z0-9_./-]+\.(?:html?|css|jsx?|tsx?|py|json|md)\b/i;
  // Named UI pieces are often referred to by their product name only
  // ("redesign homelights") and requests about full-screen layouts may not
  // mention a file, app, or component. Route direct visual redesign requests
  // to the workspace workflow even when the target name is unfamiliar.
  // "Change/improve the design" without naming files counts as well.
  const directDesignRequest = /\b(redesign|restyle|revamp|new\s+design)\b/i.test(task)
    || /\b(change|improve|refresh|overhaul|update)\b.{0,40}\bdesign\b/i.test(task);
  return directDesignRequest || (action.test(task) && target.test(task));
}

function mayCreateFile(task: string, plan: string | BrowserImplementationPlan | undefined, path: string): boolean {
  const planText = typeof plan === "string" ? plan : plan ? renderBrowserPlan(plan) : "";
  return /\b(create|add|new|introduce|scaffold|generate|extract)\b/i.test(task) ||
    (!!planText && planText.toLowerCase().includes(path.toLowerCase()));
}

/**
 * DeepSeek sometimes answers with its native DSML function-call markup
 * (<invoke name="read_file"><parameter name="path">…</parameter></invoke>)
 * plus prose instead of the JSON envelope. Convert those blocks into tool
 * actions so the turn is salvaged without a repair round-trip.
 */
function parseDsmlActions(text: string): Array<Record<string, unknown>> | null {
  // Trigger on the invoke markup itself — the DSML banner is not always present.
  if (!text || !/invoke\s+name\s*=/i.test(text)) return null;
  const actions: Array<Record<string, unknown>> = [];
  const invokeOpen = /<[^>]*invoke\s+name\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi;
  let match: RegExpExecArray | null;
  const blocks: Array<{ tool: string; chunk: string }> = [];
  const opens: Array<{ tool: string; index: number }> = [];
  while ((match = invokeOpen.exec(text)) !== null) {
    opens.push({ tool: (match[1] ?? match[2] ?? "").trim(), index: match.index + match[0].length });
  }
  if (!opens.length) return null;
  const closeRe = /<\/[^>]*invoke>/gi;
  const closes: number[] = [];
  let closeMatch: RegExpExecArray | null;
  while ((closeMatch = closeRe.exec(text)) !== null) closes.push(closeMatch.index);
  opens.forEach((open, i) => {
    const nextOpen = i + 1 < opens.length ? opens[i + 1].index : text.length;
    const closeAfter = closes.find((pos) => pos >= open.index) ?? text.length;
    const end = Math.min(nextOpen, closeAfter);
    if (end > open.index) blocks.push({ tool: open.tool, chunk: text.slice(open.index, end) });
  });
  const paramRe = /<[^>]*parameter\s+name\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)(<\/[^>]*parameter>|$)/gi;
  for (const block of blocks) {
    const args: Record<string, string> = {};
    let paramMatch: RegExpExecArray | null;
    paramRe.lastIndex = 0;
    while ((paramMatch = paramRe.exec(block.chunk)) !== null) {
      args[(paramMatch[1] ?? paramMatch[2] ?? "").trim()] = (paramMatch[3] ?? "").trim();
    }
    // Some models wrap all arguments as one JSON blob: <parameter name="args">{"path": "."}</parameter>
    if (Object.keys(args).length === 1 && typeof args.args === "string" && args.args.trim().startsWith("{")) {
      try {
        const unwrapped = JSON.parse(args.args) as unknown;
        if (unwrapped && typeof unwrapped === "object" && !Array.isArray(unwrapped)) {
          for (const [key, value] of Object.entries(unwrapped as Record<string, unknown>)) {
            if (typeof value === "string") args[key] = value;
          }
          delete args.args;
        }
      } catch { /* keep the raw blob; validation reports it */ }
    }
    const tool = block.tool;
    if (tool === "list_files") actions.push({ tool, ...(args.path ? { path: args.path } : {}) });
    else if (tool === "read_file" && args.path) actions.push({ tool, path: args.path });
    else if (tool === "search_text" && (args.query ?? args.text)) actions.push({ tool, query: args.query ?? args.text });
    else if ((tool === "write_file" || tool === "append_file") && args.path && args.content) {
      actions.push({ tool, path: args.path, content: args.content });
    } else if (tool === "edit_file" && args.path && (args.old_str ?? args.oldStr) && (args.new_str ?? args.newStr)) {
      actions.push({ tool, path: args.path, old_str: args.old_str ?? args.oldStr, new_str: args.new_str ?? args.newStr });
    } else if (tool === "write_plan") {
      const parsed: Record<string, unknown> = { ...args };
      for (const key of ["steps", "risks", "design_brief"]) {
        if (typeof parsed[key] === "string") {
          try { parsed[key] = JSON.parse(parsed[key] as string) as unknown; } catch { /* action validation reports malformed plan */ }
        }
      }
      actions.push({ tool, args: parsed });
    } else if (tool === "mark_task_done" || tool === "think") actions.push({ tool, args });
    else if (tool === "finish") actions.push({ tool });
  }
  return actions.length ? actions : null;
}

async function runIsolatedBrowserAgent(options: {
  site: BrowserSiteId;
  task: string;
  mode: AgentMode;
  internalCodePlanning?: boolean;
  plan?: BrowserImplementationPlan;
  conversationId?: string;
  sources: SourceFile[];
  /** Absolute workspace root. Enables disk fallback when the bounded snapshot
   * misses a file the model names (reads load from disk; listings scan it). */
  workspaceRoot?: string;
  ask: (site: BrowserSiteId, query: string, conversationId?: string) => Promise<string>;
  checkCanceled: () => void;
  note: (line: string) => void;
  onFileChange?: (path: string, content: string) => Promise<void>;
  onFileRefresh?: (path: string, diskHash: string, liveContent: string) => Promise<void>;
  onPlan?: (plan: BrowserImplementationPlan, planFile?: string | null) => void;
  onTaskDone?: (title: string, completed: string[]) => void;
  resumeState?: AgentProgressCheckpoint;
  onCheckpoint?: (state: AgentProgressCheckpoint) => void;
  /** Turn ceiling for this run. Coordinator code runs need headroom for
   * paginated reads + per-step edits across multi-step plans. */
  maxTurns?: number;
}): Promise<{ files: ProposedFile[]; summary: string; incomplete: boolean; plan?: BrowserImplementationPlan; completedTasks: string[] }> {
  const { site, task, mode, internalCodePlanning = false, plan: initialPlan, conversationId, sources, workspaceRoot, ask, checkCanceled, note, onFileChange, onFileRefresh, onPlan, onTaskDone, resumeState, onCheckpoint, maxTurns: maxTurnsOption } = options;
  const maxTurns = Math.max(1, Math.min(maxTurnsOption ?? 40, 120));
  const absoluteFor = (relative: string): string | null => {
    if (!workspaceRoot) return null;
    const separator = workspaceRoot.includes("\\") ? "\\" : "/";
    return `${workspaceRoot.replace(/[\\/]$/, "")}${separator}${relative.replace(/[\\/]/g, separator)}`;
  };
  /** Load an on-disk file that missed the bounded snapshot into the run. */
  const ensureDiskFile = async (relative: string): Promise<string | null> => {
    const absolutePath = absoluteFor(relative);
    if (!absolutePath) return null;
    try {
      const read = await window.api.workspace.readFile(absolutePath);
      if (!read || read.binary || typeof read.content !== "string") return null;
      if (read.content.length > MAX_AGENT_FILE_CHARS) return null;
      const openFile = useEditorStore.getState().files[absolutePath];
      const content = openFile?.dirty ? openFile.content : read.content;
      const loadedSource: SourceFile = {
        path: relative,
        content,
        hash: await digest(read.content),
        absolutePath,
        ...(openFile?.dirty ? { bufferContent: openFile.content } : {}),
      };
      virtualFiles.set(relative, content);
      baselineFiles.set(relative, content);
      originalPaths.add(relative);
      originalByPath.set(relative, loadedSource);
      if (!sources.some((file) => file.path === relative)) sources.push(loadedSource);
      if (requestedFileMustBePreserved(task, relative)) protectedOriginals.add(relative.toLowerCase());
      return content;
    } catch {
      return null;
    }
  };
  /** Refresh an existing file before every read so external edits can be rebased safely. */
  const refreshExistingFile = async (relative: string): Promise<string> => {
    const original = originalByPath.get(relative);
    if (!original) return virtualFiles.get(relative) ?? "";
    let disk: Awaited<ReturnType<typeof window.api.workspace.readFile>>;
    try { disk = await window.api.workspace.readFile(original.absolutePath); }
    catch { disk = null; }
    if (!disk) throw new Error(`${relative} is no longer present in the open workspace. Use list_dir to confirm its current path before editing.`);
    if (disk.binary || typeof disk.content !== "string") throw new Error("Binary files cannot be read by this coding workflow.");
    if (disk.content.length > MAX_AGENT_FILE_CHARS) throw new Error("File is larger than the 64 KB safe edit limit.");
    const openFile = useEditorStore.getState().files[original.absolutePath];
    const liveContent = openFile?.dirty ? openFile.content : disk.content;
    if (liveContent.length > MAX_AGENT_FILE_CHARS) throw new Error("File is larger than the 64 KB safe edit limit.");
    const diskHash = await digest(disk.content);
    const diskChanged = !!original.hash && diskHash !== original.hash;
    const bufferChanged = !!openFile?.dirty && openFile.content !== original.bufferContent;
    const contentChanged = virtualFiles.get(relative) !== liveContent;
    if (contentChanged) {
      virtualFiles.set(relative, liveContent);
      baselineFiles.set(relative, liveContent);
      fullyRead.delete(relative);
    }
    original.content = liveContent;
    original.hash = diskHash;
    if (openFile?.dirty) original.bufferContent = openFile.content;
    else delete original.bufferContent;
    if (diskChanged || bufferChanged) {
      await onFileRefresh?.(relative, diskHash, liveContent);
      note(`${site} refreshed ${relative} after it changed during the run. Rebase the intended edit on this current content.`);
    }
    return liveContent;
  };
  // Tool turns use a bounded in-memory snapshot for reads; coordinator writes
  // are committed through onFileChange, while read-only workers have no writer.
  const virtualFiles = new Map(sources.map((file) => [file.path, file.content] as const));
  const baselineFiles = new Map(sources.map((file) => [file.path, file.content] as const));
  for (const [path, content] of Object.entries(resumeState?.baselineFiles ?? {})) {
    baselineFiles.set(path, content);
    virtualFiles.set(path, content);
  }
  for (const [path, content] of Object.entries(resumeState?.virtualFiles ?? {})) virtualFiles.set(path, content);
  const fullyRead = new Set(resumeState?.fullyRead ?? []);
  const writeStartedFiles = new Set(resumeState?.writeStarted ?? []);
  let planState = resumeState?.plan ?? initialPlan;
  const completedTasks = new Set(resumeState?.completedTasks ?? []);
  const originalPaths = new Set(sources.map((file) => file.path));
  const protectedOriginals = new Set(sources
    .filter((file) => requestedFileMustBePreserved(task, file.path))
    .map((file) => file.path.toLowerCase()));
  const originalByPath = new Map(sources.map((file) => [file.path, file]));
  const context = sources.map((file) => `--- ${file.path} ---\n${file.content}`).join("\n\n");
  const commitVirtualFile = async (path: string, content: string): Promise<void> => {
    const existed = virtualFiles.has(path);
    const previous = virtualFiles.get(path);
    virtualFiles.set(path, content);
    try { await onFileChange?.(path, content); }
    catch (error) {
      if (existed) virtualFiles.set(path, previous ?? "");
      else virtualFiles.delete(path);
      throw error;
    }
  };
  const initialPrompt = `You are Browser Agent. Follow the selected mode instructions and available tools below. Return one JSON object per turn with actions and a short summary. Use only real project-relative paths.\nTASK:\n${task}\nPROJECT SNAPSHOT:\n${context}`;
  let summary = resumeState?.summary ?? "";
  let finished = false;
  let incomplete = false;
  let turns = resumeState?.turns ?? 0;
  let pendingPrompt = resumeState?.pendingPrompt;
  let pendingOutput = resumeState?.pendingOutput;
  const saveCheckpoint = (): void => onCheckpoint?.({
    site, task, conversationId: conversationId ?? "",
    // Keep the checkpoint file-scoped and compact: unchanged workspace
    // content is reloaded from the project; only full reads and proposed
    // edits need to be serialized.
    virtualFiles: Object.fromEntries([...virtualFiles].filter(([path, content]) => content !== baselineFiles.get(path))),
    baselineFiles: Object.fromEntries(baselineFiles),
    fullyRead: [...fullyRead], writeStarted: [...writeStartedFiles], pendingPrompt, pendingOutput, summary, turns,
    plan: planState, completedTasks: [...completedTasks],
  });
  const requestNext = async (prompt: string): Promise<string> => {
    pendingPrompt = prompt;
    pendingOutput = undefined;
    saveCheckpoint();
    const response = await ask(site, prompt, conversationId);
    pendingPrompt = undefined;
    pendingOutput = response;
    saveCheckpoint();
    return response;
  };
  const savedFileManifest = [...virtualFiles.entries()]
    .filter(([path, content]) => content !== baselineFiles.get(path))
    .map(([path, content]) => `${path} (${content.length.toLocaleString()} characters)`);
  const continuationPrompt = resumeState
    ? `Continue the unfinished task in this same conversation. Preserve completed edits already saved to the project and continue until the request is complete. Return one JSON actions object.\nTASK:\n${task}\nFILES ALREADY CHANGED:\n${savedFileManifest.join("\n") || "None yet"}`
    : initialPrompt;
  const mayWrite = mode === "code" || mode === "debug";
  // Shared xvie workflow: same five mode prompts + tool sets as Backend/xvie-agent.
  const toolsForMode = toolsForBrowserXvieMode(mode);
  const planMarkdown = planState ? renderBrowserPlan(planState, completedTasks) : "No structured plan exists yet.";
  const needsDesign = /\b(html|css|web\s*page|webpage|website|landing|dashboard|component|layout|styl|responsive|navbar|hero|footer|header|sidebar|modal|form|button|card|menu|gallery|portfolio|ui|frontend|design|viewport|mobile|tablet|desktop)\b/i.test(task);
  const designBlock = needsDesign ? `\n${BROWSER_DESIGN_REMINDER}` : "";
  const planModePrompt = internalCodePlanning
    ? BROWSER_XVIE_MODE_PROMPTS.plan.replace("=== PLANNING MODE ===", "=== CODE MODE: INTERNAL PLANNING PHASE ===").replace("You are in PLANNING MODE.", "You are in Code mode. This is the internal planning phase before implementation.")
    : BROWSER_XVIE_MODE_PROMPTS.plan;
  const modeInstructions: Record<AgentMode, string> = {
    plan: `${planModePrompt}\nYou MUST call write_plan(title, summary, steps, risks, design_brief) with ordered steps; every step must name its exact files_touched and describe a concrete change. Then finish. The structured plan is shown to the user as a checklist. PLAN PROPORTION (hard): scale steps to the task — a small tweak or single-file restyle gets 1-3 steps total, never padding with audit-only steps; only a genuine multi-area rebuild earns up to 10. Combine related file changes into one step.${designBlock}`,
    ask: `${BROWSER_XVIE_MODE_PROMPTS.ask}${designBlock}`,
    code: `${BROWSER_XVIE_MODE_PROMPTS.code}\nACTIVE PLAN:\n${planMarkdown}\nInvestigate before editing. Prefer targeted edit_file changes to existing files and read each file fully first. Use write_file for an existing file only when the user requests a full rewrite, or for a genuinely new file required by the task. Save completed changes immediately. Do not stop after inspection or ask for approval between the plan and implementation.${designBlock}`,
    debug: `${BROWSER_XVIE_MODE_PROMPTS.debug}\nACTIVE PLAN:\n${planMarkdown}\nRead before editing, preserve unrelated behavior, and do not claim verification that was not performed. Save completed changes immediately without waiting for approval.${designBlock}`,
    brainstorm: `${BROWSER_XVIE_MODE_PROMPTS.brainstorm}${designBlock}`,
  };
  // DeepSeek-style web UIs truncate long answers mid-JSON (which then fails
  // to parse and stalls the run until someone presses "continue"). Every turn
  // must therefore be SMALL: a few actions, short strings, one plan step.
  const OUTPUT_BUDGET = `Keep the whole JSON reply under about ${MAX_BROWSER_JSON_REPLY_CHARS.toLocaleString()} characters. Each file content chunk is at most ${MAX_BROWSER_FILE_CHUNK_CHARS.toLocaleString()} decoded characters. Batch up to 4 independent reads/searches; use one write action per turn and continue large files with append_file. Escape quotes and newlines inside JSON strings. Do not re-read unchanged files or repeat completed work.`;
  // One envelope for every reply kind — the model picks by prompt, never prose.
  const RESPONSE_FORMAT = "Return exactly one JSON object per turn. Put the short human-readable summary/message field first so it can be shown while you prepare the rest. Tool turn: {\"summary\":\"<short progress>\",\"actions\":[{\"tool\":\"<name>\",\"args\":{...}}]}. Direct answer: {\"message\":\"<answer>\",\"actions\":[]}. Finished task: {\"summary\":\"<final summary>\",\"actions\":[{\"tool\":\"finish\"}]}. Use real project-relative paths and canonical tool names.";
  const effectivePrompt = `${modeInstructions[mode]}\nAVAILABLE TOOLS: ${toolsForMode}. Use "tool" for the action name and "args" for its arguments (aliases "name"/"action"/"arguments" accepted). Read-only modes must not emit write actions.\n${RESPONSE_FORMAT}\n${OUTPUT_BUDGET}\n${continuationPrompt}`;
  let output = pendingOutput ?? await requestNext(pendingPrompt ?? effectivePrompt);

  // Single provider conversation per run. Rotating chats every turn spammed
  // new tabs and flicked the browser window ("keeps creating new chats",
  // "trying to open folders"). Remote-context growth is handled by
  // prompt-level compaction (bounded snapshot + capped result echoes) instead.
  const askTurn = (query: string): Promise<string> => requestNext(query);
  // Completed coordinator edits are saved immediately; retries preserve them.
  const finishPartial = (reason: string): void => {
    finished = true;
    incomplete = true;
    const partial = [...virtualFiles.entries()].filter(([path, content]) => content !== baselineFiles.get(path));
    summary = `${summary || "Work halted before the model finished."} (Stopped: ${reason}${partial.length ? `; ${partial.length} file change(s) remain in the project` : "; no file changes were made"}.)`;
    note(`${site} stopped before completing; completed file edits remain saved`);
  };
  const finishGateError = (): string | null => {
    if (mode === "plan" && !planState) return "Planning mode must call write_plan before finishing.";
    if (mayWrite) {
      const invalidFiles = [...virtualFiles.entries()]
        .filter(([path, content]) => content !== baselineFiles.get(path) && /\.(?:css|m?js|cjs)$/i.test(path))
        .flatMap(([path, content]) => verifyFileContent(path, content).map((problem) => `${path}: ${problem}`));
      if (invalidFiles.length) {
        return `The changed code files failed automatic syntax checks. Repair them and verify again before finishing:\n${invalidFiles.slice(0, 8).map((problem) => `- ${problem}`).join("\n")}`;
      }
    }
    const openTasks = planState?.steps.filter((step) => ![...completedTasks].some((title) => title.toLowerCase() === step.title.toLowerCase())) ?? [];
    if (mayWrite && openTasks.length) {
      return `The plan still has unfinished steps: ${openTasks.map((step) => step.title).join(", ")}. Continue the next step and call mark_task_done after saving its files.`;
    }
    return null;
  };

  let lastNoProgressKey = "";
  let repeatedNoProgressTurns = 0;
  const progressState = (): string => JSON.stringify({
    planState,
    completed: [...completedTasks].sort(),
    fullyRead: [...fullyRead].sort(),
    files: [...virtualFiles.entries()].sort(([left], [right]) => left.localeCompare(right)),
  });

  while (!finished) {
    if (turns >= maxTurns) {
      finishPartial(`the ${maxTurns}-turn safety limit was reached`);
      break;
    }
    turns += 1;
    checkCanceled();
    let payload: Record<string, unknown>;
    const dsmlActions = parseDsmlActions(output);
    if (dsmlActions) {
      // DeepSeek native markup — no repair round-trip needed. Cut prose at
      // the first markup tag so DSML headers never leak into the feed.
      const cut = output.search(/</);
      const lead = (cut >= 0 ? output.slice(0, cut) : output).trim().replace(/\s+/g, " ");
      payload = { actions: dsmlActions, summary: lead.slice(0, 300) || "Continuing with native tool calls." };
      note(`${site} answered with native tool calls (${dsmlActions.length} action(s))`);
    } else {
      // Envelope first (covers strict + salvaged envelopes); bare
      // single-action objects second — accepted directly without spending
      // a repair round-trip the model may ignore.
      let envelope: Record<string, unknown> | undefined;
      try {
        envelope = parseAgentJsonShaped<Record<string, unknown>>(output, isStructuredAgentReply);
      } catch {
        envelope = undefined;
      }
      if (envelope) {
        payload = envelope;
      } else {
        const bareActions = collectBareToolActions(output);
        if (bareActions) {
          payload = { actions: bareActions, summary: "" };
          note(`${site} answered with bare tool call(s) (${bareActions.length} action(s))`);
        } else {
        try {
          payload = await parseAgentJsonWithRetry({
            response: output,
            ask: (query) => askTurn(query),
            isValid: isStructuredAgentReply,
            onRetry: (attempt, durationMs, succeeded) => console.info("[xvie:browser-agent:timing]", { stage: "json_repair", attempt, durationMs, succeeded }),
            retryPrompt: (_previous, reason) =>
              `Repair the previous response (${reason}). ${RESPONSE_FORMAT} Use only these tools: ${toolsForMode}. ${OUTPUT_BUDGET}\nPrevious response:\n${_previous}`,
          });
        } catch (err) {
          finishPartial(err instanceof Error ? err.message : String(err));
          break;
        }
        }
      }
    }
    // Unify every accepted reply shape: downstream always sees an actions
    // array plus a summary string. Direct answers (greetings, tool-free
    // questions) arrive as actions:[] with the answer as the summary.
    const unified = normalizeAgentReply(payload);
    if (unified) {
      payload = { ...payload, actions: unified.actions, summary: unified.summary };
    }
    // Allow a one-shot proposal from providers that ignore the tool protocol,
    // while enforcing the selected mode and the same path/read safeguards.
    if (Array.isArray(payload.files)) {
      if (!mayWrite && (payload.files as unknown[]).length) throw new Error(`${mode} mode cannot modify project files.`);
      if (mayWrite && (payload.files as unknown[]).length && !planState) throw new Error("File tools are blocked until write_plan creates a structured plan.");
      for (const raw of payload.files as ProposedFile[]) {
        const path = String(raw.path ?? "").replace(/\\/g, "/");
        if (!validRelativePath(path) || isPlaceholderAgentPath(path) || typeof raw.content !== "string") throw new Error(`${site} proposed an invalid or placeholder file path.`);
        if (protectedOriginals.has(path.toLowerCase())) throw new Error(`${site} tried to replace the named original ${path}; keep it unchanged unless the user requests a replacement.`);
        if (raw.content.length > MAX_AGENT_FILE_CHARS) throw new Error(`${site} proposed a file larger than the 64 KB safe edit limit: ${path}`);
        if (originalPaths.has(path) && !fullyRead.has(path)) throw new Error(`${site} must read the complete ${path} before editing it.`);
        if (originalPaths.has(path) && !/\b(full|entire|whole|complete)\s+(rewrite|replacement|overhaul)\b/i.test(task)) throw new Error(`${site} must use edit_file for the existing file ${path}; full-file replacement was not requested.`);
        if (!originalPaths.has(path) && !mayCreateFile(task, planState, path)) throw new Error(`${site} may create ${path} only when the task or plan requires a new file.`);
        await commitVirtualFile(path, raw.content);
      }
      summary = typeof payload.summary === "string" ? payload.summary : "Isolated proposal ready.";
      if (mayWrite && planState) {
        const markedTitles = Array.isArray(payload.completed_tasks)
          ? payload.completed_tasks.filter((title): title is string => typeof title === "string")
          : [];
        for (const title of markedTitles) {
          const step = planState.steps.find((candidate) => candidate.title.toLowerCase() === title.trim().toLowerCase());
          if (!step) continue;
          const changedFiles = [...virtualFiles.entries()]
            .filter(([filePath, content]) => content !== baselineFiles.get(filePath))
            .map(([filePath]) => filePath.toLowerCase());
          if (step.files_touched.some((file) => !changedFiles.includes(file.toLowerCase()))) continue;
          completedTasks.add(step.title);
          onTaskDone?.(step.title, [...completedTasks]);
        }
        const gate = finishGateError();
        if (gate) {
          note(`${site} returned file contents without completing every planned checklist step; requesting the remaining task markers`);
          try {
            output = await requestNext(`${gate}\nUse mark_task_done for each step only after its planned files have been saved. Investigation-only steps also need an explicit completed_tasks entry when using this response format. Then finish. Return the next actions object.\nTASK:\n${task}`);
          } catch (err) {
            finishPartial(err instanceof Error ? err.message : String(err));
          }
          continue;
        }
      }
      finished = true;
      break;
    }

    const actions = Array.isArray(payload.actions) ? payload.actions as Array<Record<string, unknown>> : [];
    const results: Array<{ tool: string; path?: string; result?: unknown; error?: string }> = [];
    // Compaction: the model only needs confirmation + excerpts back, not
    // full file contents it already holds. Full text stays in virtualFiles.
    const compactForModel = (text: string, limit = 4_000): string =>
      text.length > limit ? `${text.slice(0, limit)}\n[truncated ${((text.length - limit)).toLocaleString()} more characters — use read_file for the rest]` : text;
    // Max 4 actions per turn: weak web models that batch 8 actions emit
    // one giant reply that gets truncated mid-JSON. Extra actions are
    // deferred — the loop asks for the next chunk on the following turn.
    const trimmedActionCount = Math.max(0, actions.length - 4);
    const normalizedActions = actions.slice(0, 4).map(normalizeBrowserToolAction);
    if (trimmedActionCount > 0) {
      note(`${site} sent ${actions.length} actions; running the first 4 now and deferring ${trimmedActionCount}`);
    }
    const actionSignature = JSON.stringify(normalizedActions.map(({ tool, args, error }) => ({ tool, args, error })));
    const stateBeforeActions = progressState();
    for (const rawAction of normalizedActions) {
      const { args } = rawAction;
      // Canonicalize frontend/backend aliases (list_files→list_dir, search_text→grep_search).
      const tool = canonicalBrowserToolName(rawAction.tool);
      const actionError = rawAction.error;
      const rawPath = typeof args.path === "string" ? args.path.replace(/\\/g, "/") : "";
      // "." / "./" / "" all mean the snapshot root (DeepSeek sends ".").
      const path = rawPath === "." || rawPath === "./" || rawPath === "/" ? "" : rawPath;
      const toolStartedAt = performance.now();
      let toolSucceeded = true;
      try {
        if (actionError) throw new Error(actionError);
        if (!tool) throw new Error("Tool action is missing its name. Use {\"tool\": \"<name>\", \"args\": {...}} with one of: " + toolsForMode + ".");
        if (["write_file", "append_file", "edit_file"].includes(tool) && !mayWrite) {
          throw new Error(`${mode} mode is read-only. Available tools: ${toolsForMode}.`);
        }
        if (["write_file", "append_file", "edit_file"].includes(tool) && mayWrite && !planState) {
          throw new Error("File tools are blocked until write_plan creates a structured plan. Call write_plan first, then retry the edit.");
        }
        if (tool === "think") {
          const thought = typeof args.thought === "string" ? args.thought.trim() : "";
          if (!thought) throw new Error("think requires a short progress note.");
          note(`${site}: ${thought.slice(0, 300)}`);
          results.push({ tool, result: "Thought noted. Continue with the next action." });
        } else if (tool === "ask_question") {
          const rawQuestions = Array.isArray((args as Record<string, unknown>).questions)
            ? (args as Record<string, unknown>).questions as Array<Record<string, unknown>>
            : [];
          const questions: AgentQuestion[] = rawQuestions.slice(0, 4).flatMap((q, i) => {
            if (!q || typeof q !== "object") return [];
            const id = String((q as Record<string, unknown>).id ?? `q${i + 1}`).trim() || `q${i + 1}`;
            const question = String((q as Record<string, unknown>).question ?? "").trim();
            if (!question) return [];
            const header = String((q as Record<string, unknown>).header ?? "").trim();
            const rawOpts = Array.isArray((q as Record<string, unknown>).options)
              ? (q as Record<string, unknown>).options as Array<unknown>
              : [];
            const options = rawOpts.slice(0, 5).flatMap((o) => {
              if (typeof o === "string" && o.trim()) return [{ label: o.trim() }];
              if (o && typeof o === "object") {
                const label = String((o as Record<string, unknown>).label ?? "").trim();
                if (!label) return [];
                return [{ label, description: String((o as Record<string, unknown>).description ?? "").trim() }];
              }
              return [];
            });
            const allowRaw = (q as Record<string, unknown>).allow_custom;
            return [{ id, question, header, options, allow_custom: typeof allowRaw === "boolean" ? allowRaw : true }];
          });
          if (!questions.length) throw new Error("ask_question needs a non-empty questions list with id + question.");
          note(`${site} has questions for you — answer to continue`);
          const answers = await requestBrowserAnswers(questions);
          const lines = ["User answers:"];
          for (const q of questions) {
            const a = answers.find((x) => x.id === q.id);
            const parts: string[] = [];
            if (a?.selected?.length) parts.push(`selected: ${a.selected.join(", ")}`);
            if (a?.custom_text?.trim()) parts.push(`custom: ${a.custom_text.trim()}`);
            lines.push(`- ${q.id}: ${parts.join("; ") || "(skipped — use your best guess)"}`);
          }
          lines.push("Continue the task using these answers.");
          results.push({ tool, result: lines.join("\n") });
        } else if (tool === "write_plan") {
          if (mode !== "plan" && !mayWrite) throw new Error(`${mode} mode does not have the write_plan tool.`);
          if (mayWrite && planState) throw new Error("An active plan already exists. Follow it and mark each completed step instead of replacing it.");
          const nextPlan = normalizeBrowserPlan(args);
          for (const step of nextPlan.steps) {
            for (const file of step.files_touched) {
              if (!validRelativePath(file) || isPlaceholderAgentPath(file)) throw new Error(`Plan step '${step.title}' contains an invalid project-relative path: ${file}`);
            }
          }
          planState = nextPlan;
          saveCheckpoint();
          // Persist like xvie-agent: `.xvie/plans/<ts>-<slug>.md` (kept out of
          // the bounded snapshot — SKIP_DIRS excludes `.xvie` — so it never
          // satisfies mark_task_done file checks or pollutes reads).
          const planFile = await persistBrowserPlanFile(nextPlan, note);
          onPlan?.(nextPlan, planFile);
          results.push({ tool, result: renderBrowserPlan(nextPlan) });
          note(`${site} saved a structured plan with ${nextPlan.steps.length} step(s)`);
        } else if (tool === "mark_task_done") {
          if (mode !== "plan" && !mayWrite) throw new Error(`${mode} mode does not have the mark_task_done tool.`);
          if (!planState) throw new Error("No plan exists. Call write_plan first.");
          // Accept common title key aliases — models send title/name/task/step.
          const rawTitle = ["title", "name", "task", "step_title", "task_title", "step"]
            .map((key) => args[key])
            .find((value): value is string => typeof value === "string" && !!value.trim()) ?? "";
          const title = rawTitle.trim();
          // Fuzzy title matching (exact → normalized → unique substring) so
          // shortened/paraphrased titles resolve instead of stalling the run.
          // Mismatches list the open step titles verbatim.
          const matched = matchPlanStepTitle(planState.steps, title);
          if ("error" in matched) throw new Error(matched.error);
          const step = planState.steps[matched.index];
          const changedFiles = [...virtualFiles.entries()]
            .filter(([filePath, content]) => content !== baselineFiles.get(filePath))
            .map(([filePath]) => filePath.toLowerCase());
          let missing = step.files_touched.filter((file) => !changedFiles.includes(file.toLowerCase()));
          if (missing.length) {
            // The virtual map can lose track (re-reads reset baselines,
            // rollbacks, resume quirks) while the edits ARE on disk via
            // applyChanges. Verify against disk before failing the step.
            const stillMissing: string[] = [];
            for (const file of missing) {
              const baseline = baselineFiles.get(file) ?? baselineFiles.get(file.toLowerCase());
              const absolute = originalByPath.get(file)?.absolutePath ?? absoluteFor(file);
              let diskContent: string | null = null;
              if (absolute) {
                try {
                  const read = await window.api.workspace.readFile(absolute);
                  if (read && !read.binary && typeof read.content === "string") diskContent = read.content;
                } catch { /* treat as still missing below */ }
              }
              if (diskContent === null || (baseline !== undefined && diskContent === baseline)) {
                stillMissing.push(file);
              } else {
                // On-disk change confirmed — adopt it so later edits build
                // on the true current content instead of a stale snapshot.
                virtualFiles.set(file, diskContent);
                note(`Confirmed ${file} saved on disk for '${step.title}'.`);
              }
            }
            missing = stillMissing;
          }
          // Investigation-only steps (audit/review/analyse) produce findings,
          // not file writes — completing them must not stall the run.
          const investigatory = /\b(audit|review|inspect|investigat|analy[sz]e|document|assess|survey|explore)\b/i.test(`${step.title} ${step.description}`);
          if (missing.length && !investigatory) throw new Error(`Cannot mark '${step.title}' done until these planned files have been saved: ${missing.join(", ")}.`);
          if (missing.length && investigatory) note(`Marked investigatory step '${step.title}' done without file writes.`);
          completedTasks.add(step.title);
          onTaskDone?.(step.title, [...completedTasks]);
          saveCheckpoint();
          results.push({ tool, result: `Marked '${step.title}' done.` });
          note(`Completed plan task: ${step.title}`);
        } else if (tool === "list_dir" || tool === "list_files") {
          if (path && (!validRelativePath(path) || isPlaceholderAgentPath(path))) {
            throw new Error("Use a real folder or file path from the project snapshot, or omit path (or use \".\") to list the snapshot.");
          }
          const prefix = path.replace(/\/+$/, "");
          // Prefer the live workspace: the bounded snapshot may miss files
          // (e.g. created by an earlier run after the snapshot was taken).
          let listed: string[] | null = null;
          const listAbsolute = prefix ? absoluteFor(prefix) : workspaceRoot ?? null;
          if (listAbsolute) {
            try {
              const entries = await window.api.workspace.scanDir(listAbsolute);
              listed = entries
                .filter((entry) => !entry.isSymlink && !SKIP_DIRS.has(entry.name))
                .map((entry) => {
                  const relative = entry.path.slice((workspaceRoot ?? "").length).replace(/^[\\/]/, "").replace(/\\/g, "/");
                  return entry.kind === "directory" ? `${relative}/` : relative;
                })
                .filter((name) => !!name && !isPlaceholderAgentPath(name.replace(/\/$/, "")))
                .slice(0, 200);
            } catch {
              listed = null;
            }
          }
          listed ??= [...virtualFiles.keys()].filter((name) => !prefix || name === prefix || name.startsWith(`${prefix}/`)).slice(0, 200);
          results.push({ tool, result: listed });
          note(`${site} listed ${listed.length} project file(s)${path ? ` under ${path}` : ""}`);
        } else if (tool === "read_file") {
          if (!validRelativePath(path) || isPlaceholderAgentPath(path)) throw new Error("Use a real project-relative path from the project snapshot or list_dir output.");
          if (!virtualFiles.has(path)) {
            // Snapshot miss: load from disk instead of failing. Files created
            // by earlier runs (or crowded out of the bounded snapshot) are
            // real workspace files the agent must be able to read.
            const loaded = await ensureDiskFile(path);
            if (loaded === null) throw new Error(`File is not available: ${path}. Use list_dir to see this run's readable files.`);
            note(`${site} loaded ${path} from disk (outside the initial snapshot)`);
          }
          // Line-range reads: the snapshot/excerpts are truncated, so the
          // model can page through large files instead of guessing bytes.
          const rawStart = args.start_line ?? args.startLine ?? args.start ?? null;
          const rawEnd = args.end_line ?? args.endLine ?? args.end ?? null;
          const startLine = typeof rawStart === "number" && rawStart > 0 ? Math.floor(rawStart) : 1;
          const endLine = typeof rawEnd === "number" && rawEnd >= startLine ? Math.floor(rawEnd) : null;
          const wantsRange = rawStart !== null || rawEnd !== null;
          const original = originalByPath.get(path);
          let content = virtualFiles.get(path)!;
          if (original) content = await refreshExistingFile(path);
          if (fullyRead.has(path) && !wantsRange) {
            // Already read in full this run — echoing it again only burns
            // context and triggers re-read loops on truncated excerpts.
            results.push({ tool, path, result: "Already read in full earlier in this run — it is in your context above. Do NOT read it again; proceed to write, append, edit, or finish. To page through it, call read_file with start_line/end_line." });
            note(`${site} already had ${path}; skipped re-read`);
            continue;
          }
          const allLines = content.split("\n");
          const totalLines = allLines.length;
          if (wantsRange) {
            const slice = allLines.slice(startLine - 1, endLine ?? totalLines).join("\n");
            results.push({ tool, path, result: `--- ${path} (lines ${startLine}-${endLine ?? totalLines} of ${totalLines}) ---\n${compactForModel(slice)}` });
            note(`${site} read ${path} lines ${startLine}-${endLine ?? totalLines} of ${totalLines}`);
            continue;
          }
          fullyRead.add(path);
          // Compaction: echo a bounded excerpt back (the model already holds
          // the snapshot context); the full text stays in this run's current project snapshot.
          // The excerpt is the head; page with start_line/end_line for the rest.
          const head = allLines.slice(0, 120).join("\n");
          results.push({ tool, path, result: `--- ${path} (${content.length.toLocaleString()} chars, ${totalLines} lines; showing first 120 lines, page with start_line/end_line) ---\n${compactForModel(head)}` });
          note(`${site} read ${path} (${content.length.toLocaleString()} characters)`);
        } else if (tool === "grep_search" || tool === "search_text" || tool === "glob_search") {
          const rawQuery = typeof args.query === "string" ? args.query : typeof args.pattern === "string" ? args.pattern : typeof args.text === "string" ? args.text : "";
          const query = rawQuery.trim().toLowerCase();
          if (tool === "glob_search") {
            const pattern = rawQuery.trim() || "*";
            // Real glob semantics (xvie parity): ** crosses directories,
            // * stays within one path segment. Falls back to substring when
            // the pattern has no wildcards at all.
            const globToRegExp = (glob: string): RegExp => {
              let out = "";
              for (let i = 0; i < glob.length; i += 1) {
                const char = glob[i];
                if (char === "*") {
                  if (glob[i + 1] === "*") {
                    out += ".*";
                    i += 1;
                    if (glob[i + 1] === "/") i += 1;
                  } else out += "[^/]*";
                } else if (char === "?") out += "[^/]";
                else if ("+^${}()|[]\\.".includes(char)) out += `\\${char}`;
                else out += char;
              }
              return new RegExp(`^${out}$`, "i");
            };
            let matched: string[];
            try {
              const matcher = globToRegExp(pattern);
              matched = [...virtualFiles.keys()].filter((name) => matcher.test(name)).slice(0, 50);
            } catch {
              const lowered = pattern.toLowerCase();
              matched = [...virtualFiles.keys()].filter((name) => name.toLowerCase().includes(lowered)).slice(0, 50);
            }
            results.push({ tool, result: matched });
            note(`${site} matched ${matched.length} file(s) for pattern “${pattern}”`);
          } else {
          if (!query) throw new Error("Provide a search query.");
          const matches: string[] = [];
          for (const [name, content] of virtualFiles) {
            const index = content.toLowerCase().indexOf(query);
            if (index >= 0) matches.push(`${name}: ${content.slice(Math.max(0, index - 90), Math.min(content.length, index + query.length + 130)).replace(/\s+/g, " ")}`);
            if (matches.length >= 12) break;
          }
          results.push({ tool, result: matches });
          note(`${site} searched project text for “${query}” and found ${matches.length} matching file(s)`);
          }
        } else if (tool === "verify_file") {
          const verificationStartedAt = performance.now();
          if (!validRelativePath(path) || isPlaceholderAgentPath(path)) throw new Error("verify_file needs a real project-relative path.");
          if (!virtualFiles.has(path)) {
            const loaded = await ensureDiskFile(path);
            if (loaded === null) throw new Error(`Cannot verify ${path}: file is not available in this run.`);
          }
          const content = virtualFiles.get(path) ?? "";
          const problems = verifyFileContent(path, content);
          // Cross-file HTML/CSS consistency (xvie parity): classes used in
          // this run's HTML with no matching CSS rule are advisory warnings.
          const warnings: string[] = [];
          if (/\.html?$/i.test(path)) {
            const htmls = [...virtualFiles.entries()].filter(([p]) => /\.html?$/i.test(p)).map(([, c]) => c);
            const csss = [...virtualFiles.entries()].filter(([p]) => /\.css$/i.test(p)).map(([, c]) => c);
            for (const missing of findMissingCssClasses(htmls, csss).slice(0, 10)) {
              warnings.push(`class "${missing}" has no matching CSS rule`);
            }
          }
          console.info("[xvie:browser-agent:timing]", {
            stage: "verification", site, tool, path,
            durationMs: Math.round(performance.now() - verificationStartedAt),
            errors: problems.length, warnings: warnings.length,
          });
          if (problems.length) {
            results.push({ tool, path, error: `Verification of ${path} FAILED:\n${problems.map((p) => `- ${p}`).join("\n")}\nRepair the file now, then call verify_file again.` });
            note(`${site} found problems in ${path} (${problems.length})`);
          } else {
            const warnBlock = warnings.length ? `\nWarnings (advisory):\n${warnings.map((w) => `- ${w}`).join("\n")}` : "";
            results.push({ tool, path, result: `Verification PASSED: ${path} is complete and well-formed.${warnBlock}` });
            note(`${site} verified ${path}`);
          }
        } else if (tool === "check_contrast") {
          const fg = typeof args.fg_hex === "string" ? args.fg_hex : typeof args.fg === "string" ? args.fg : "";
          const bg = typeof args.bg_hex === "string" ? args.bg_hex : typeof args.bg === "string" ? args.bg : "";
          if (!fg || !bg) throw new Error("check_contrast needs fg_hex and bg_hex (e.g. fg_hex: \"#1a1a1a\", bg_hex: \"#ffffff\").");
          const report = formatContrastReport(fg, bg);
          results.push({ tool, result: report });
          note(`${site} checked contrast ${fg} on ${bg}`);
        } else if (tool === "search_images") {
          const query = typeof args.query === "string" ? args.query.trim() : "";
          if (!query) throw new Error("search_images needs a descriptive query, for example 'wood fired pizza restaurant food'.");
          const imageSearchStartedAt = performance.now();
          const { results: images } = await window.api.agent.searchImages(query, 6);
          console.info("[xvie:browser-agent:timing]", { stage: "image_search", site, query, durationMs: Math.round(performance.now() - imageSearchStartedAt), results: images.length });
          const imageResults = images.map((img, i) => `${i + 1}. ${img.alt}\nHero/banner URL: ${img.heroUrl}\nThumbnail URL: ${img.thumbnailUrl}\nPhotographer: ${img.photographer}\nLicense: ${img.license}\nCredit: ${img.credit}\nSource: ${img.sourceUrl}\nDimensions: ${img.width}x${img.height}`).join("\n\n");
          results.push({ tool, result: images.length
            ? `Found ${images.length} real image results for "${query}":\n${imageResults}\nUse a direct URL in img src, descriptive alt text, loading="lazy", responsive object-fit, and include the provided credit and source link.`
            : `No images found for "${query}". Try a more specific query or proceed without images.` });
          note(`${site} found ${images.length} images for ${query}`);
        } else if (tool === "read_ui_reference") {
          // Reference library is still a future capability.
          results.push({ tool, result: "Noted. No local reference library is wired into this loop; continue with the project context." });
          note(`${site} checked ${tool}${path ? ` on ${path}` : ""}`);
        } else if (tool === "write_file") {
          if (!validRelativePath(path) || isPlaceholderAgentPath(path)) throw new Error("Use a real, meaningful project-relative file path; placeholder paths are not allowed.");
          if (protectedOriginals.has(path.toLowerCase())) throw new Error(`Keep ${path} unchanged unless the user explicitly requests a replacement.`);
          if (!virtualFiles.has(path)) {
            // The file may exist on disk without being in the snapshot (or in
            // originalPaths). Load it so existing-file rules and the
            // on-save conflict check see the true on-disk state.
            const loaded = await ensureDiskFile(path);
            if (loaded === null && originalPaths.has(path)) throw new Error("File is outside the run's readable files.");
          }
          if (originalPaths.has(path) && !fullyRead.has(path)) throw new Error("Read the complete existing file before editing it.");
          if (originalPaths.has(path) && !/\b(full|entire|whole|complete)\s+(rewrite|replacement|overhaul)\b/i.test(task)) throw new Error(`Use edit_file for existing file ${path}. A full-file rewrite was not requested.`);
          if (!originalPaths.has(path) && !mayCreateFile(task, planState, path)) throw new Error(`Create ${path} only when the task or plan requires a new file.`);
          if (typeof args.content !== "string") throw new Error("A complete UTF-8 file content string is required.");
          // Keep file chunks within the prompt and protocol limit.
          // Truncated model responses receive protocol repair before writes are applied.
          if (args.content.length > MAX_BROWSER_FILE_CHUNK_CHARS) throw new Error(`That write is ${args.content.length.toLocaleString()} characters, over the ${MAX_BROWSER_FILE_CHUNK_CHARS.toLocaleString()}-character per-call limit. Send the first chunk, then continue with append_file chunks up to that limit.`);
          if (args.content.length > MAX_AGENT_FILE_CHARS) throw new Error("Files are limited to 64 KB per edit in the browser workflow.");
          if (virtualFiles.get(path) === args.content) {
            results.push({ tool, path, result: "No content change: the proposed file is identical to the current project file." });
            note(`${site} made no content change to ${path}`);
          } else {
            await commitVirtualFile(path, args.content);
            writeStartedFiles.add(path);
            results.push({ tool, path, result: `First chunk saved (${args.content.length.toLocaleString()} chars). Continue with append_file until the file is complete, then finish.` });
            note(`${site} saved the first edit to ${path}`);
          }
        } else if (tool === "append_file") {
          if (!validRelativePath(path) || isPlaceholderAgentPath(path)) throw new Error("Use the same real project-relative path you started with write_file.");
          if (!virtualFiles.has(path) || !writeStartedFiles.has(path)) throw new Error("Call write_file with the first chunk before append_file.");
          if (typeof args.content !== "string" || !args.content) throw new Error("An append chunk string is required.");
          if (args.content.length > MAX_BROWSER_FILE_CHUNK_CHARS) throw new Error(`Keep each append_file chunk to at most ${MAX_BROWSER_FILE_CHUNK_CHARS.toLocaleString()} characters.`);
          const combined = virtualFiles.get(path)! + args.content;
          if (combined.length > MAX_AGENT_FILE_CHARS) throw new Error("Files are limited to 64 KB per edit in the browser workflow.");
          await commitVirtualFile(path, combined);
          results.push({ tool, path, result: `Appended (${combined.length.toLocaleString()} chars total). Send the next chunk or finish.` });
          note(`${site} appended to ${path} (${combined.length.toLocaleString()} chars total)`);
        } else if (tool === "edit_file") {
          if (!validRelativePath(path) || isPlaceholderAgentPath(path)) throw new Error("Use a real project-relative path from the project snapshot.");
          if (!virtualFiles.has(path)) {
            const loaded = await ensureDiskFile(path);
            if (loaded === null) throw new Error(`File is not available: ${path}. Use list_dir to see this run's files.`);
          }
          if (originalPaths.has(path) && !fullyRead.has(path)) throw new Error("Read the complete existing file before editing it (read_file without line range, or page all ranges).");
          const oldStr = ["old_str", "oldStr", "old_string", "oldString"].map((k) => args[k]).find((v): v is string => typeof v === "string" && !!v) ?? "";
          const newStr = ["new_str", "newStr", "new_string", "newString"].map((k) => args[k]).find((v): v is string => typeof v === "string") ?? "";
          if (!oldStr || newStr === "") throw new Error("edit_file needs old_str (exact block copied from a read_file result, same key spelling) plus new_str.");
          const current = virtualFiles.get(path)!;
          const occurrences = current.split(oldStr).length - 1;
          if (occurrences !== 1) {
            // Point at the closest real block so the next retry copies bytes
            // that exist instead of re-sending an excerpt guess.
            const hint = closestBlockHint(current, oldStr);
            throw new Error(`old_str matches ${occurrences} times in the current ${path} — it must match exactly once. Call read_file for the latest content, then copy a longer unique block from those exact lines.${hint ? ` Closest current block:\n${hint}` : ""}`);
          }
          await commitVirtualFile(path, current.replace(oldStr, newStr));
          results.push({ tool, path, result: "Targeted edit saved to the project." });
          note(`${site} edited ${path}`);
        } else if (tool === "finish" || tool === "done") {
          const gate = finishGateError();
          if (gate) throw new Error(gate);
          finished = true;
          results.push({ tool: "finish", result: "Isolated run finished." });
        } else {
          throw new Error(`Unknown tool '${tool}'. Available tools: ${toolsForMode}.`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toolSucceeded = false;
        results.push({ tool, path: path || undefined, error: message });
        note(`${site} could not use ${tool || "unnamed action"}${path ? ` on ${path}` : ""}: ${message}`);
      } finally {
        console.info("[xvie:browser-agent:timing]", {
          stage: "tool_execution", site, tool, path: path || undefined,
          durationMs: Math.round(performance.now() - toolStartedAt), succeeded: toolSucceeded,
        });
      }
    }
    // Commit the processed response and isolated files together. If the app
    // closes during tool handling, the previous checkpoint still contains
    // the raw response and will replay the whole action batch from its
    // previous file snapshot.
    pendingOutput = undefined;
    saveCheckpoint();
    if (typeof payload.summary === "string" && payload.summary.trim()) {
      summary = payload.summary;
      // The model's own progress notes were previously swallowed — print them.
      note(`${site}: ${summary.slice(0, 300)}${summary.length > 300 ? "…" : ""}`);
    }
    if (payload.done === true) {
      const gate = finishGateError();
      if (gate) results.push({ tool: "finish", error: gate });
      else finished = true;
    }
    if (finished && results.some((result) => !!result.error)) {
      finished = false;
      note(`${site} has tool errors to correct before this run can finish`);
    }
    if (!finished && normalizedActions.length) {
      const stateAfterActions = progressState();
      const noProgressKey = `${actionSignature}\n${stateAfterActions}`;
      if (stateBeforeActions === stateAfterActions && noProgressKey === lastNoProgressKey) {
        repeatedNoProgressTurns += 1;
      } else {
        repeatedNoProgressTurns = stateBeforeActions === stateAfterActions ? 1 : 0;
      }
      lastNoProgressKey = noProgressKey;
      if (repeatedNoProgressTurns >= 3) {
        finishPartial("the same tool actions repeated without making progress; check the reported tool errors and retry with a different action");
        break;
      }
    } else if (normalizedActions.length) {
      lastNoProgressKey = "";
      repeatedNoProgressTurns = 0;
    }
    if (!finished && results.length === 0) {
      if (summary.trim()) {
        // An empty action list with a useful summary is a valid conversational
        // completion, even if the provider wrapped it in the tool envelope.
        finished = true;
      } else {
        note(`${site} returned no usable actions; asking it to retry with the listed tools`);
        checkCanceled();
        try {
          output = await requestNext(
            `Your last response did not contain a usable action. Continue the task and return one JSON object with an actions array using only: ${toolsForMode}. ${OUTPUT_BUDGET} If no tool is needed (greeting, direct answer), reply {"message":"your answer","actions":[]}. If the request needs no more work, use {"summary":"your direct answer","actions":[{"tool":"finish"}]}. Put the human-readable summary/message before actions so it streams to the user early.\nTASK:\n${task}`
          );
        } catch (err) {
          finishPartial(err instanceof Error ? err.message : String(err));
          break;
        }
        continue;
      }
    }
    if (!finished) {
      note(`${site} completed tool turn ${turns}`);
      // Compaction: cap the echoed results so the prompt stays inside the
      // browser model's effective context window. Saved file contents remain
      // in the project and in this run's working snapshot.
      // read_file slices are exempted up to 3k: shrinking them re-hides the
      // exact lines the next edit must copy, causing re-read loops that
      // burn turns until the safety limit stops the run.
      const compacted = results.map((entry) => {
        if (typeof entry.result !== "string") return entry;
        const cap = entry.tool === "read_file" ? 3_000 : 1_200;
        if (entry.result.length > cap) {
          return { ...entry, result: `${entry.result.slice(0, cap)}\n[compacted ${(entry.result.length - cap).toLocaleString()} more characters]` };
        }
        return entry;
      });
      // Hard ceiling on the follow-up prompt: shrink the longest results
      // first so one big read can never push the turn over budget. Web-model
      // prompts degrade past ~6k chars, so keep follow-ups tight.
      // read_file slices shrink last — they carry the exact bytes edits need.
      let resultsJson = JSON.stringify(compacted);
      while (resultsJson.length > 5_000) {
        let longest = -1;
        let longestLen = 0;
        compacted.forEach((entry, index) => {
          if (entry.tool === "read_file" && typeof entry.result === "string" && entry.result.length <= 3_000) return;
          const len = typeof entry.result === "string" ? entry.result.length : 0;
          if (len > longestLen) { longestLen = len; longest = index; }
        });
        if (longest < 0 || longestLen <= 500) break;
        const entry = compacted[longest];
        entry.result = `${String(entry.result).slice(0, Math.floor(longestLen / 2))}\n[compacted for context]`;
        resultsJson = JSON.stringify(compacted);
      }
      checkCanceled();
      try {
        output = await requestNext(
          `Tool results from the project. Completed file edits are already saved:\n${resultsJson}\nContinue the task using the same JSON action format. ${RESPONSE_FORMAT} Correct every tool error before finishing. If a file changed on disk or old_str no longer matches, call read_file to refresh that file, then rebase only the intended edit; never resend a stale edit. Save any unsaved editor buffer before retrying. Batch up to 4 independent reads/searches into one actions array. Files fully read are in your context — page the rest with read_file start_line/end_line; results marked [truncated]/[compacted] are excerpts only, never copy edit old_str from an excerpt. For edit_file, copy the exact block from a read_file result (same file, full lines) so old_str matches exactly once. Prefer edit_file for small fixes and append_file chunks for large files (at most ${MAX_BROWSER_FILE_CHUNK_CHARS.toLocaleString()} characters per call). ${OUTPUT_BUDGET} When the requested edits are ready, use finish and give a short summary.`
        );
      } catch (err) {
        // Retry one transient stall on the same conversation; prior file actions stay saved.
        note(`${site} stalled; retrying this turn once`);
        checkCanceled();
        try {
          output = await requestNext(
            `Continue the task using the JSON action format. ${RESPONSE_FORMAT} ${OUTPUT_BUDGET} Tool results:\n${resultsJson.slice(0, 4_000)}\nTASK:\n${task}`
          );
        } catch (err2) {
          finishPartial(err2 instanceof Error ? err2.message : String(err2));
          break;
        }
      }
    }
  }

  saveCheckpoint();
  const files = [...virtualFiles.entries()]
    .filter(([path, content]) => content !== baselineFiles.get(path))
    .map(([path, content]) => ({ path, content }));
  return { files, summary, incomplete, plan: planState, completedTasks: [...completedTasks] };
}

export default function BrowserAgentWorkflow(): React.JSX.Element {
  const workspace = useFileSystemStore((state) => state.workspace);
  const status = useBrowserStore((state) => state.status);
  const statusLoading = useBrowserStore((state) => state.statusLoading);
  const chromeBusy = useBrowserStore((state) => state.chromeBusy);
  const chromeError = useBrowserStore((state) => state.chromeError);
  const loginState = useBrowserStore((state) => state.loginState);
  const ensureChrome = useBrowserStore((state) => state.ensureChrome);
  const restartChrome = useBrowserStore((state) => state.restartChrome);
  const refreshLogin = useBrowserStore((state) => state.refreshLogin);
  const [coordinator, setCoordinator] = useState<BrowserSiteId>(() => {
    const saved = readModelConfig()?.coordinator;
    return saved && !isChatOnlySite(saved) ? saved : "deepseek";
  });
  const [workers, setWorkers] = useState<BrowserSiteId[]>(() => (readModelConfig()?.workers ?? []).filter((id) => !isChatOnlySite(id)));
  const [mode, setMode] = useState<AgentMode>(readAgentMode);
  const [modeOpen, setModeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [activity, setActivity] = useState<string[]>([]);
  const [history, setHistory] = useState<WorkflowHistoryEntry[]>(readWorkflowHistory);
  const [pendingRun, setPendingRun] = useState<PendingBrowserRun | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Start in the conversation, matching XVIE Agent. Model choices live in settings.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatEntry[]>(readChatTranscript);
  const [chatDraft, setChatDraft] = useState("");
  const browserQuestions = useSyncExternalStore(subscribeBrowserQuestions, getBrowserPendingQuestions);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const modelConversations = useRef<Partial<Record<string, string>>>(readModelConversations());
  useEffect(() => {
    const onConversationDeleted = (event: Event): void => {
      const conversationId = (event as CustomEvent<{ conversationId?: string }>).detail?.conversationId;
      if (!conversationId) return;
      for (const [thread, id] of Object.entries(modelConversations.current)) {
        if (id === conversationId) delete modelConversations.current[thread];
      }
      try { localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(modelConversations.current)); } catch { /* storage is optional */ }
      setHistory((previous) => {
        const next = previous.map((entry) => {
          if (entry.conversationId !== conversationId) return entry;
          const { conversationId: _deletedId, ...rest } = entry;
          return rest;
        });
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* history is best-effort */ }
        return next;
      });
    };
    window.addEventListener("xvie:browser-conversation-deleted", onConversationDeleted);
    return () => window.removeEventListener("xvie:browser-conversation-deleted", onConversationDeleted);
  }, []);
  const cancelRequested = useRef(false);
  // Assistant placeholder receiving streamed partials for the current run.
  const activeAssistantId = useRef<string | null>(null);
  const browserTurnCounter = useRef(0);

  useEffect(() => {
    void useBrowserStore.getState().refreshStatus();
    void refreshLogin(coordinator);
    for (const worker of workers) void refreshLogin(worker);
  }, [coordinator, workers, refreshLogin]);
  useEffect(() => {
    setPendingRun(workspace?.path ? readPendingRun(workspace.path) : null);
  }, [workspace?.path]);
  useEffect(() => {
    try { localStorage.setItem(CHAT_KEY, JSON.stringify(chatMessages.slice(-100))); } catch { /* conversation persistence is best-effort */ }
  }, [chatMessages]);
  useEffect(() => { try { localStorage.setItem(MODE_KEY, mode); } catch { /* mode persistence is best-effort */ } }, [mode]);
  useEffect(() => { if (chatScrollRef.current) chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight; }, [chatMessages, error, browserQuestions]);

  const addTimelineActivity = (item: BrowserActivityItem, text = item.detail ?? item.target): void => {
    const entry: ChatActivityEntry = { id: item.id, role: "activity", text, ts: item.timestamp, item };
    setChatMessages((previous) => [...previous, entry]);
  };
  const note = (line: string): void => {
    setActivity((previous) => [line, ...previous].slice(0, 10));
    const modelSummary = /^(chatgpt|claude|gemini|deepseek|grok|qwen|perplexity):\s*(.+)$/i.exec(line);
    if (modelSummary) {
      const site = BROWSER_SITES.find((item) => item.id === modelSummary[1].toLowerCase())?.id;
      if (site) {
        addTimelineActivity(thinkActivity(site, modelSummary[2]));
        return;
      }
    }
    const lower = line.toLowerCase();
    const kind = /\bread\b|already had/.test(lower) ? "read"
      : /search/.test(lower) ? "search"
      : /listed|finding files|loaded .* file/.test(lower) ? "index"
      : /drafted|edited|appended|wrote|write/.test(lower) ? "update"
      : /review|verified|applied|finished|completed/.test(lower) ? "verify"
      : "run";
    addTimelineActivity({
      id: uid("bact"), kind, target: line, status: /could not|stopped|error|failed/.test(lower) ? "failed" : "completed", timestamp: Date.now(),
    });
  };
  const saveHistory = (entry: WorkflowHistoryEntry): void => {
    setHistory((previous) => {
      const conversationMode = entry.mode ?? mode;
      const completeEntry: WorkflowHistoryEntry = {
        ...entry,
        mode: conversationMode,
        workspaceRoot: entry.workspaceRoot ?? workspace?.path,
        conversationId: entry.conversationId ?? getModelConversation(modelConversations, entry.coordinator, conversationMode),
      };
      const next = [completeEntry, ...previous].slice(0, 25);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* history is best-effort */ }
      return next;
    });
  };
  const deleteHistoryEntry = (id: string): void => {
    setHistory((previous) => {
      const next = previous.filter((entry) => entry.id !== id);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* history is best-effort */ }
      return next;
    });
  };
  const clearWorkflowHistory = (): void => {
    setHistory([]);
    try { localStorage.removeItem(HISTORY_KEY); } catch { /* history is best-effort */ }
  };
  const startNewAgentConversation = (): void => {
    if (busy) return;
    modelConversations.current = {};
    try {
      localStorage.removeItem(CONVERSATIONS_KEY);
      localStorage.removeItem(CHAT_KEY);
      localStorage.removeItem(LAST_PLAN_KEY);
      if (workspace?.path) localStorage.removeItem(pendingRunKey(workspace.path));
    } catch { /* storage is optional */ }
    setPendingRun(null);
    setChatMessages([]);
    setError("");
    setStage("");
    setActivity([]);
    setHistoryOpen(false);
  };
  const openWorkflowHistory = (item: WorkflowHistoryEntry): void => {
    setCoordinator(item.coordinator);
    if (item.mode) setMode(item.mode);
    if (item.conversationId && item.mode) setModelConversation(modelConversations, item.coordinator, item.mode, item.conversationId);
    setChatMessages([{ id: `${item.id}-history`, role: "assistant", text: `${item.summary}${item.outcome ? `\n\nPrevious run: ${item.outcome}. ${item.files.length} file(s).` : ""}`, ts: item.date, files: item.files }]);
    setHistoryOpen(false);
    setSettingsOpen(false);
  };
  const renderHistoryEntry = (item: WorkflowHistoryEntry): React.JSX.Element => (
    <div key={item.id} className="flex min-w-0 items-center gap-1 rounded-lg hover:bg-surface-container-low">
      <button type="button" onClick={() => openWorkflowHistory(item)} className="min-w-0 flex-1 px-2.5 py-2 text-left">
        <span className="block truncate font-label-sm text-label-sm text-on-surface">{item.title}</span>
        <span className="mt-0.5 flex items-center gap-2 font-label-xs text-label-xs text-secondary"><span>{item.outcome}</span><span>·</span><span>{new Date(item.date).toLocaleString()}</span><span>·</span><span>{item.files.length} files</span></span>
      </button>
      <button type="button" title={`Delete ${item.title} from workflow history`} aria-label={`Delete ${item.title} from workflow history`} onClick={() => deleteHistoryEntry(item.id)} className="mr-1.5 shrink-0 rounded-md p-1.5 text-secondary hover:bg-surface-container hover:text-error"><Trash2 size={13} /></button>
    </div>
  );
  const persistPendingRun = (run: PendingBrowserRun): void => {
    run.updatedAt = Date.now();
    try {
      localStorage.setItem(pendingRunKey(run.workspaceRoot), JSON.stringify(run));
      setPendingRun(run);
    } catch {
      throw new Error("Could not save the Browser Agent checkpoint. Free some application storage and retry; no workspace files were applied.");
    }
  };
  const clearPendingRun = (root: string): void => {
    try { localStorage.removeItem(pendingRunKey(root)); } catch { /* best-effort cleanup */ }
    setPendingRun(null);
  };
  const toggleWorker = (site: BrowserSiteId): void => {
    setWorkers((current) => current.includes(site)
      ? current.filter((item) => item !== site)
      : current.length < 2 ? [...current, site] : current);
  };

  const readWorkspace = async (root: string, task: string, boostPaths: string[] = []): Promise<{ files: SourceFile[]; manifest: string[] }> => {
    const queue = [root];
    const candidates: Array<{ absolutePath: string; path: string; modifiedAt: number }> = [];
    const requested = requestedProjectFileNames(task);
    // Files from the saved plan / earlier edits in this workspace are almost
    // always the relevant ones for follow-ups ("continue to improve it").
    const boosted = new Set(boostPaths.map((p) => p.replace(/\\/g, "/").toLowerCase()));
    let scannedDirectories = 0;
    while (queue.length && scannedDirectories < MAX_SCAN_DIRECTORIES && candidates.length < MAX_FILE_CANDIDATES) {
      const batch = queue.splice(0, Math.min(12, MAX_SCAN_DIRECTORIES - scannedDirectories));
      const snapshots = await Promise.all(batch.map(async (directory) => {
        try { return await window.api.workspace.scanDir(directory); }
        catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          throw new Error(`Cannot read workspace folder "${directory}". Reopen the project and try again. ${detail}`);
        }
      }));
      scannedDirectories += batch.length;
      for (const entries of snapshots) for (const entry of entries) {
          if (entry.kind === "directory") {
            if (!entry.isSymlink && !SKIP_DIRS.has(entry.name)) queue.push(entry.path);
          } else if (!entry.isSymlink && entry.size <= MAX_AGENT_FILE_CHARS) {
            const relative = entry.path.slice(root.length).replace(/^[\\/]/, "").replace(/\\/g, "/");
            // Never snapshot placeholder/example paths the model may have
            // invented (they leaked into runs as "relative/file").
            if (isPlaceholderAgentPath(relative)) continue;
            candidates.push({ absolutePath: entry.path, path: relative, modifiedAt: entry.modifiedAt ?? 0 });
            if (candidates.length >= MAX_FILE_CANDIDATES) break;
          }
        }
    }
    const manifest = candidates.map((candidate) => candidate.path);
    const now = Date.now();
    const priorityOf = (candidate: { path: string; modifiedAt: number }): number => {
      let score = projectFilePriority(candidate.path, task, requested);
      if (boosted.has(candidate.path.toLowerCase())) score += 50_000;
      const ageMs = now - (candidate.modifiedAt || 0);
      if (ageMs >= 0 && ageMs < 24 * 3_600_000) score += 5_000;
      else if (ageMs >= 0 && ageMs < 7 * 24 * 3_600_000) score += 2_000;
      return score;
    };
    candidates.sort((a, b) => priorityOf(b) - priorityOf(a) || a.path.localeCompare(b.path));
    const files: SourceFile[] = [];
    let budget = MAX_CONTEXT_CHARS;
    for (let offset = 0; offset < candidates.length && files.length < MAX_FILES && budget >= 500; offset += 12) {
      const batch = candidates.slice(offset, offset + 12);
      const reads = await Promise.all(batch.map((candidate) => window.api.workspace.readFile(candidate.absolutePath).catch(() => null)));
      for (let index = 0; index < batch.length && files.length < MAX_FILES && budget >= 500; index += 1) {
        const candidate = batch[index];
        const read = reads[index];
        if (!read || read.binary || !read.content) continue;
        const openFile = useEditorStore.getState().files[candidate.absolutePath];
        const liveContent = openFile?.dirty ? openFile.content : read.content;
        const content = liveContent.slice(0, Math.min(4_000, budget));
        files.push({
          path: candidate.path, content, hash: await digest(read.content), absolutePath: candidate.absolutePath,
          ...(openFile?.dirty ? { bufferContent: openFile.content } : {}),
        });
        budget -= content.length;
      }
    }
    return { files, manifest };
  };

  // Client-side ceiling per model answer. The sidecar caps at ~520s; without
  // our own timeout a hung call spins the UI forever with no message.
  const ASK_TIMEOUT_MS = 540_000;
  const ask = async (site: BrowserSiteId, query: string, conversationId?: string): Promise<string> => {
    const label = BROWSER_SITES.find((item) => item.id === site)?.label ?? site;
    const turn = ++browserTurnCounter.current;
    setStage(`Waiting for ${label} in the browser… (Stop cancels)`);
    const startedAt = Date.now();
    let firstPartialMs: number | null = null;
    let firstVisiblePartialMs: number | null = null;
    let streamFallback = false;
    const timer = window.setInterval(() => {
      const seconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
      setStage(`Waiting for ${label} (${seconds}s)… (Stop cancels)`);
    }, 1_000);
    let timeoutHandle: number | undefined;
    let cancelHandle: number | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = window.setTimeout(() => reject(new Error(
        `${label}: timed out after 9 minutes without an answer. Your prompt is still in the browser tab; press Show to inspect it, then retry.`
      )), ASK_TIMEOUT_MS);
    });
    // Stop actually aborts the wait instead of spinning until timeout.
    const canceled = new Promise<never>((_, reject) => {
      cancelHandle = window.setInterval(() => {
        if (cancelRequested.current) reject(new Error("Run canceled. Completed file edits remain saved."));
      }, 250);
    });
    // Best-effort live preview: the sidecar streams growing answer text as
    // the provider types. The workflow previously awaited the full answer,
    // so a fast-typing model still looked idle until the turn completed.
    const streamed = new Promise<string>((resolve, reject) => {
      const streamId = uid("stream");
      let settled = false;
      let seenChars = 0;
      let unsubscribe: (() => void) | undefined;
      const cleanup = (): void => {
        try { unsubscribe?.(); } catch { /* best-effort */ }
      };
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      try {
        unsubscribe = window.api.browser.onStream((evt) => {
          if (settled || evt.streamId !== streamId) return;
          if (evt.type === "partial") {
            seenChars = evt.text.length;
            if (firstPartialMs === null) {
              firstPartialMs = Date.now() - startedAt;
              console.info("[xvie:browser-agent:timing]", { stage: "first_partial", site, turn, durationMs: firstPartialMs });
            }
            const seconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
            setStage(`Receiving from ${label} (${seconds}s, ${(seenChars / 1024).toFixed(1)}k chars)… (Stop cancels)`);
            // Show a cleaned preview in the placeholder instead of raw JSON.
            const target = activeAssistantId.current;
            if (target) {
              const preview = previewBrowserAgentStream(evt.text);
              if (preview) {
                if (firstVisiblePartialMs === null) {
                  firstVisiblePartialMs = Date.now() - startedAt;
                  console.info("[xvie:browser-agent:timing]", { stage: "first_visible_partial", site, turn, durationMs: firstVisiblePartialMs });
                }
                setChatMessages((previous) => previous.map((entry) =>
                  entry.id === target && entry.role === "assistant"
                    ? { ...entry, text: preview, status: "streaming" as const }
                    : entry
                ));
              }
            }
          } else if (evt.type === "done") {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(evt.answer);
          } else {
            fail(new Error(evt.error || "Stream failed."));
          }
        });
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      void (async () => {
        try {
          const started = await window.api.browser.askStream(streamId, site, query, [], conversationId);
          if (!started.accepted) fail(new Error(started.error ?? "Stream rejected."));
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });
    try {
      const answer = await Promise.race([
        streamed.catch((streamError) => {
          streamFallback = true;
          console.warn("[xvie:browser-agent:timing]", { stage: "stream_fallback", site, turn, reason: streamError instanceof Error ? streamError.message : String(streamError) });
          return window.api.browser.ask(site, query, [], conversationId).then((result) => {
            if (!result.success) throw new Error(`${label}: ${result.error}`);
            return result.answer;
          });
        }),
        timeout,
        canceled,
      ]);
      const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      console.info("[xvie:browser-agent:timing]", {
        stage: "model_turn_complete", site, turn, durationMs: Date.now() - startedAt,
        timeToFirstPartialMs: firstPartialMs, timeToFirstVisiblePartialMs: firstVisiblePartialMs, streamFallback,
      });
      setStage(`${label} responded in ${seconds}s`);
      return answer;
    } finally {
      window.clearInterval(timer);
      if (timeoutHandle !== undefined) window.clearTimeout(timeoutHandle);
      if (cancelHandle !== undefined) window.clearInterval(cancelHandle);
    }
  };

  const run = async (submittedTask: string, resume?: PendingBrowserRun): Promise<void> => {
    const root = workspace?.path;
    if (!submittedTask.trim() || busy) return;
    if (resume && (!root || resume.workspaceRoot !== root)) {
      setError("Open the same project to continue its saved Browser Agent run.");
      return;
    }
    const activeMode = resume?.mode ?? mode;
    const writeMode = activeMode === "code" || activeMode === "debug";
    // "Implement the plan" (typo-tolerant) is a build request even though it
    // names no files — check it before the workspace-task gate, which would
    // otherwise shunt it to a conversational reply on a stale thread.
    const wantsSavedPlan = !resume && writeMode && !!root && isImplementSavedPlanRequest(submittedTask) && !!readLastPlan(root);
    if (!resume && root && pendingRun?.workspaceRoot === root && writeMode && (isWorkspaceCodingTask(submittedTask) || wantsSavedPlan)) {
      setError("A coding task is paused for this project. Continue or discard it before starting another coding run.");
      return;
    }
    const activeCoordinator = resume?.coordinator ?? coordinator;
    const savedDuringRun = new Set(resume?.changedPaths ?? []);
    let workspaceManifestForSave: string[] = [];
    let fingerprintKeyForSave: string | null = null;
    // Obvious greetings stay instant: no snapshot, no provider call.
    // Anything with extra text falls through to the full template below.
    if (!resume && isObviousGreeting(submittedTask)) {
      const label = BROWSER_SITES.find((item) => item.id === activeCoordinator)?.label ?? activeCoordinator;
      const greeting = `Hello! I'm ${label} via Browser Agent. What would you like to work on?`;
      setChatMessages((previous) => [...previous,
        { id: uid("user"), role: "user", text: submittedTask, ts: Date.now() },
        { id: uid("browser-agent"), role: "assistant", text: greeting, ts: Date.now(), site: activeCoordinator, status: "done" },
      ]);
      saveHistory({ id: uid("history"), title: submittedTask.slice(0, 100), date: Date.now(), coordinator: activeCoordinator, workers: [], outcome: "complete", summary: greeting, files: [] });
      return;
    }
    const assistantId = uid("browser-agent");
    setChatMessages((previous) => [...previous,
      { id: uid("user"), role: "user", text: submittedTask, ts: Date.now() },
      { id: assistantId, role: "assistant", text: "", ts: Date.now(), site: activeCoordinator, status: "streaming" },
    ]);
    activeAssistantId.current = assistantId;
    cancelRequested.current = false;
    const checkCanceled = (): void => {
      if (cancelRequested.current) throw new Error("Run canceled. Completed file edits remain saved.");
    };
    setBusy(true); setError(""); setActivity([]);
    try {
      const selectedWorkers = [...(resume?.workers ?? workers)];
      let runWorkers = writeMode ? (resume ? [...resume.workers] : shouldDelegateTask(submittedTask) ? selectedWorkers : []) : [];
      if (selectedWorkers.length && !runWorkers.length) {
        note("This is a focused request, so the coordinator will handle it directly");
      }
      // Status can go stale between a previous probe and this run. Ask the
      // bridge to verify/ensure the session every time; this is idempotent
      // when Chrome is already healthy and avoids starting a run on a dead CDP
      // connection.
      setStage(status?.cdp_reachable ? "Checking the open browser session" : "Opening the browser session");
      // Preserve the user's current window visibility. Passing false here
      // hides an already visible browser before every agent run.
      const connection = await ensureChrome();
      if (!connection.success) throw new Error(connection.error ?? "Could not connect to Chrome. Open the browser window and retry.");
      note(status?.cdp_reachable ? "Verified the open browser session" : "Connected to the browser session");
      checkCanceled();
      const requiredModels = [activeCoordinator, ...runWorkers];
      const currentLogin = useBrowserStore.getState().loginState;
      await Promise.all(requiredModels
        .filter((site) => currentLogin[site] === null || currentLogin[site] === false)
        .map((site) => refreshLogin(site)));
      checkCanceled();
      const checkedLogin = useBrowserStore.getState().loginState;
      if (checkedLogin[activeCoordinator] === false) throw new Error(`Sign in to ${activeCoordinator} in the open browser window, then retry.`);
      const signedOutWorkers = runWorkers.filter((id) => checkedLogin[id] === false);
      if (signedOutWorkers.length === 1 && signedOutWorkers[0] === "chatgpt" && runWorkers.length === 1) {
        runWorkers = [];
        setWorkers([]);
        note("GPT is not signed in; continuing with DeepSeek as the only model");
      } else if (signedOutWorkers.length) {
        throw new Error(`Sign in to ${signedOutWorkers.join(", ")} in the browser window, then retry.`);
      }

      if (!writeMode) {
        const planBoost = root ? (readLastPlan(root)?.plan.steps.flatMap((step) => step.files_touched) ?? []) : [];
        const planWorkspace = root ? await readWorkspace(root, submittedTask, planBoost) : null;
        const sources = planWorkspace?.files ?? [];
        note(sources.length ? `Loaded ${sources.length} project file(s) for ${activeMode} mode` : `No workspace snapshot is available for ${activeMode} mode`);
        let conversationId = getModelConversation(modelConversations, activeCoordinator, activeMode);
        if (!conversationId) {
          const conversation = await window.api.browser.newConversation(activeCoordinator);
          if ("error" in conversation) throw new Error(conversation.error);
          conversationId = conversation.id;
          setModelConversation(modelConversations, activeCoordinator, activeMode, conversationId);
        }
        setStage(activeMode === "plan" ? "Investigating and preparing a structured plan" : `${activeMode === "ask" ? "Answering" : "Exploring options"} from project context`);
        // write_plan already saved the plan file in-branch; capture its path.
        let planFile: string | null = null;
        const result = await runIsolatedBrowserAgent({
          site: activeCoordinator, task: submittedTask, mode: activeMode, conversationId, sources,
          workspaceRoot: root ?? undefined, ask,
          checkCanceled, note,
          onPlan: (plan, file) => {
            if (file) planFile = file;
            note(`${activeCoordinator} created a structured plan with ${plan.steps.length} step(s)`);
          },
          onTaskDone: (title) => note(`Completed plan task: ${title}`),
        });
        if (result.incomplete) throw new Error(`${activeCoordinator} stopped before completing ${activeMode} mode.`);
        checkCanceled();
        // Keep the finished plan for later: switching to Code/Debug mode and
        // asking to implement it reuses this plan instead of re-planning.
        if (activeMode === "plan" && result.plan && root) {
          if (!planFile) planFile = await persistBrowserPlanFile(result.plan, note);
          writeLastPlan({ workspaceRoot: root, task: submittedTask, plan: result.plan, planFile, updatedAt: Date.now(), workspaceFingerprint: await fingerprintWorkspacePaths(planWorkspace?.manifest ?? []) });
        }
        const reply = activeMode === "plan" && result.plan
          ? `${renderBrowserPlan(result.plan, new Set(result.completedTasks))}${planFile ? `\n\n> Plan saved to \`${planFile}\`.` : ""}\n\n> Switch to Code or Debug mode and say “implement the plan” to build it.`
          : result.summary.trim();
        if (!reply) throw new Error(`${activeCoordinator} finished without a ${activeMode} result.`);
        setStage(activeMode === "plan" ? "Plan ready" : "Response complete");
        // Chronological order: the finished answer goes after the activities,
        // not in the placeholder slot above them.
        setChatMessages((previous) => [...previous.filter((entry) => entry.id !== assistantId),
          { id: assistantId, role: "assistant", text: reply, ts: Date.now(), site: activeCoordinator, status: "done" }]);
        saveHistory({ id: `${Date.now()}`, title: submittedTask.slice(0, 100), date: Date.now(), coordinator: activeCoordinator, workers: [], outcome: "complete", summary: reply, files: [] });
        return;
      }

      if (!isWorkspaceCodingTask(normalizeTaskSpelling(submittedTask)) && !wantsSavedPlan) {
        // File-grounded question ("check styles.css ..."): answer from the
        // REAL files with the snapshot — never a blind chat reply claiming
        // no file access. Stays in the UI's mode (code stays code): the
        // model answers directly when no change is needed, or plans + edits
        // when the request turns out to need work.
        if (root && requestedProjectFileNames(submittedTask).size > 0) {
          try {
            setStage(`${BROWSER_SITES.find((item) => item.id === activeCoordinator)?.label} is reading the requested files`);
            const askBoost = readLastPlan(root)?.plan.steps.flatMap((step) => step.files_touched) ?? [];
            const askSources = (await readWorkspace(root, submittedTask, askBoost)).files;
            checkCanceled();
            let askConversationId = getModelConversation(modelConversations, activeCoordinator, activeMode);
            if (!askConversationId) {
              const conversation = await window.api.browser.newConversation(activeCoordinator);
              if (!("error" in conversation)) {
                askConversationId = conversation.id;
                setModelConversation(modelConversations, activeCoordinator, activeMode, askConversationId);
              }
            }
            const askResult = await runIsolatedBrowserAgent({
              site: activeCoordinator, task: submittedTask, mode: activeMode,
              conversationId: askConversationId, sources: askSources, workspaceRoot: root, ask,
              checkCanceled, note,
            });
            checkCanceled();
            const askReply = askResult.summary.trim();
            if (!askReply) throw new Error("empty answer");
            if (askResult.incomplete) note("Answer is partial; completed reads remain available for a follow-up");
            setStage("Response complete");
            setChatMessages((previous) => [...previous.filter((entry) => entry.id !== assistantId),
              { id: assistantId, role: "assistant", text: askReply, ts: Date.now(), site: activeCoordinator, status: "done" }]);
            saveHistory({ id: uid("history"), title: submittedTask.slice(0, 100), date: Date.now(), coordinator: activeCoordinator, workers: [], outcome: "complete", summary: askReply, files: [] });
            return;
          } catch (err) {
            // Fall through to the plain conversational reply below.
            note(`File-backed answer failed (${err instanceof Error ? err.message : String(err)}); answering conversationally`);
            checkCanceled();
          }
        }
        // Model-decides: non-coding requests get the full template
        // (TASK + project snapshot) once per user message, and the model
        // chooses direct answer (actions:[]) vs inspection tools vs edits.
        // Never a bare no-context chat prompt (that caused "no access"), and
        // never a forced ASK MODE when the UI is in code/debug — the UI mode
        // stays, write tools stay plan-gated, the model decides.
        setStage(`${BROWSER_SITES.find((item) => item.id === activeCoordinator)?.label} is answering`);
        const chatBoost = root ? (readLastPlan(root)?.plan.steps.flatMap((step) => step.files_touched) ?? []) : [];
        const chatSources = root ? (await readWorkspace(root, submittedTask, chatBoost)).files : [];
        note(chatSources.length ? `Loaded ${chatSources.length} project file(s) for context` : `No workspace snapshot available; answering from conversation`);
        checkCanceled();
        let chatConversationId = getModelConversation(modelConversations, activeCoordinator, activeMode);
        if (!chatConversationId) {
          const conversation = await window.api.browser.newConversation(activeCoordinator);
          if (!("error" in conversation)) {
            chatConversationId = conversation.id;
            setModelConversation(modelConversations, activeCoordinator, activeMode, chatConversationId);
          }
        }
        const chatResult = await runIsolatedBrowserAgent({
          site: activeCoordinator, task: submittedTask, mode: activeMode,
          conversationId: chatConversationId, sources: chatSources, workspaceRoot: root ?? undefined, ask,
          checkCanceled, note,
        });
        checkCanceled();
        const reply = chatResult.summary.trim();
        if (!reply) throw new Error("The model did not return a usable answer. Please retry.");
        if (chatResult.incomplete) note("Answer is partial; ask a follow-up to continue");
        setStage("Response complete");
        setChatMessages((previous) => [...previous.filter((entry) => entry.id !== assistantId),
          { id: assistantId, role: "assistant", text: reply, ts: Date.now(), site: activeCoordinator, status: "done" }]);
        saveHistory({ id: uid("history"), title: submittedTask.slice(0, 100), date: Date.now(), coordinator: activeCoordinator, workers: [], outcome: "complete", summary: reply, files: [] });
        return;
      }

      setStage("Finding files related to your request");
      note("Searching the workspace for files related to your request");
      if (!root) throw new Error("Open a project before asking the Browser Agent to edit files.");
      // Follow-up fixes ("improve it", "fix errors") name no files — boost
      // the saved plan's files plus anything changed before so the snapshot
      // actually contains the work under discussion.
      const followUpBoost = [
        ...(readLastPlan(root)?.plan.steps.flatMap((step) => step.files_touched) ?? []),
        ...(resume?.changedPaths ?? []),
        ...(pendingRun?.workspaceRoot === root ? pendingRun.changedPaths ?? [] : []),
      ];
      const workspaceSnapshot = await readWorkspace(root, submittedTask, followUpBoost);
      const sources = workspaceSnapshot.files;
      workspaceManifestForSave = workspaceSnapshot.manifest;
      fingerprintKeyForSave = workspaceFingerprintKey(root);
      let changedResumeSource = false;
      if (!resume) {
        const fingerprints = readWorkspaceFingerprints();
        const currentFingerprint = await fingerprintWorkspacePaths(workspaceSnapshot.manifest);
        const previousFingerprint = fingerprints[fingerprintKeyForSave];
        const existingPlan = readLastPlan(root);
        const savedPlanIsStale = !!existingPlan?.workspaceFingerprint && existingPlan.workspaceFingerprint !== currentFingerprint;
        if ((previousFingerprint && previousFingerprint !== currentFingerprint) || savedPlanIsStale) {
          // A changed project file set makes prior provider claims and plans
          // unsafe to reuse, even when the user repeats the prompt.
          modelConversations.current = {};
          try {
            localStorage.removeItem(CONVERSATIONS_KEY);
            const savedPlan = readLastPlan(root);
            if (savedPlan) localStorage.removeItem(LAST_PLAN_KEY);
          } catch { /* storage is optional */ }
          note("The workspace changed since the previous run; cleared its saved plan and started with fresh model context.");
        }
      }
      checkCanceled();
      if (!sources.length) note("No existing text files were found; the plan will identify any genuinely required new files");
      if (resume) {
        for (const [path, expectedHash] of Object.entries(resume.sourceHashes)) {
          const current = sources.find((file) => file.path === path);
          const separator = root.includes("\\") ? "\\" : "/";
          const absolutePath = current?.absolutePath ?? `${root.replace(/[\\/]$/, "")}${separator}${path.replace(/[\\/]/g, separator)}`;
          const disk = !current || current.bufferContent === undefined ? await window.api.workspace.readFile(absolutePath) : null;
          const currentHash = current?.hash ?? (disk && !disk.binary && typeof disk.content === "string" ? await digest(disk.content) : null);
          const expectedContentHash = resume.sourceContentHashes[path];
          const diskContent = disk && !disk.binary ? disk.content : undefined;
          const currentContent = current?.bufferContent ?? diskContent ?? current?.content;
          const currentContentHash = typeof currentContent === "string" ? await digest(currentContent) : null;
          if (currentHash !== expectedHash || (expectedContentHash && currentContentHash !== expectedContentHash)) {
            changedResumeSource = true;
            // User edits made while a run was paused are the new source of
            // truth. Drop stale proposed overlays and ask the model to read
            // the changed file before it makes another edit.
            for (const progress of Object.values(resume.agentProgress)) {
              if (!progress) continue;
              if (typeof currentContent === "string") progress.baselineFiles[path] = currentContent;
              else delete progress.baselineFiles[path];
              delete progress.virtualFiles[path];
              progress.fullyRead = progress.fullyRead.filter((file) => file !== path);
              progress.writeStarted = (progress.writeStarted ?? []).filter((file) => file !== path);
              progress.pendingOutput = undefined;
              progress.pendingPrompt = `The workspace file ${path} changed while the task was paused. Call read_file to inspect its current content, preserve the user's edits, and reapply only the remaining requested changes. Do not replay an earlier write or append.`;
            }
            if (currentHash) resume.sourceHashes[path] = currentHash;
            else delete resume.sourceHashes[path];
            if (currentContentHash) resume.sourceContentHashes[path] = currentContentHash;
            else delete resume.sourceContentHashes[path];
            if (current && typeof currentContent === "string") {
              current.content = currentContent.slice(0, 4_000);
              current.bufferContent = currentContent;
            }
            note(`Updated the saved task with the latest ${path}; the agent will reread it before editing.`);
          }
        }
      }
      const context = sources.map((file) => `--- ${file.path} ---\n${file.content}`).join("\n\n");
      note(`Loaded ${sources.length} relevant workspace file(s): ${sources.slice(0, 8).map((file) => file.path).join(", ")}`);
      const models = resume
        ? [activeCoordinator, ...runWorkers].map((site) => [site, resume.conversations[site]] as const).filter((entry): entry is readonly [BrowserSiteId, string] => typeof entry[1] === "string")
        : await Promise.all([activeCoordinator, ...runWorkers].map(async (site) => {
        try {
          // Keep one provider thread per site and mode so follow-up messages
          // retain conversation context without mixing Plan/Ask/Code prompts.
          const conversationMode: AgentMode = site === activeCoordinator ? activeMode : "ask";
          const existingConversation = getModelConversation(modelConversations, site, conversationMode);
          if (existingConversation) return [site, existingConversation] as const;
          const conversation = await window.api.browser.newConversation(site);
          if ("error" in conversation) throw new Error(conversation.error);
          setModelConversation(modelConversations, site, conversationMode, conversation.id);
          return [site, conversation.id] as const;
        } catch (err) {
          const raw = err instanceof Error ? err.message : String(err);
          if (site !== activeCoordinator) {
            note(`${site} could not start a browser conversation and was skipped: ${raw}`);
            return null;
          }
          if (/Failed to connect to Chrome/i.test(raw)) {
            useBrowserStore.setState({ chromeError: "Chrome is responding, but the Browser Agent cannot attach to its debugging connection. Open the browser again, wait for it to restart, then retry." });
            throw new Error(`Could not open ${BROWSER_SITES.find((item) => item.id === site)?.label} because the managed Chrome debugging connection failed. Press “Open browser”, wait for Chrome to connect, then retry.`);
          }
          throw new Error(`${BROWSER_SITES.find((item) => item.id === site)?.label}: ${raw}`);
        }
      }));
      checkCanceled();
      const conversationByModel = Object.fromEntries(models.filter((item): item is readonly [BrowserSiteId, string] => item !== null)) as Partial<Record<BrowserSiteId, string>>;
      runWorkers = runWorkers.filter((site) => !!conversationByModel[site]);

      const checkpoint: PendingBrowserRun = resume ?? {
        workspaceRoot: root,
        task: submittedTask,
        mode: activeMode,
        coordinator: activeCoordinator,
        workers: runWorkers,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sourceHashes: Object.fromEntries(sources.map((file) => [file.path, file.hash])),
        sourceContentHashes: Object.fromEntries(await Promise.all(sources.map(async (file) => [file.path, file.bufferContent !== undefined ? await digest(file.bufferContent) : file.hash] as const))),
        conversations: conversationByModel,
        conversationIsolationVersion: 1,
        agentTasks: {},
        agentProgress: {},
        agentResults: {},
        phase: "agents",
      };
      const resumeWasInvalidated = !!resume && (changedResumeSource || resume.conversationIsolationVersion !== 1);
      checkpoint.mode = activeMode;
      checkpoint.conversationIsolationVersion = 1;
      checkpoint.conversations = { ...checkpoint.conversations, ...conversationByModel };
      checkpoint.phase = "agents";
      if (resumeWasInvalidated) {
        // A resumed task whose inputs changed must not continue with provider
        // claims or virtual edits based on the old files. Keep its user task,
        // but rebuild the plan and start fresh provider threads.
        for (const site of [activeCoordinator, ...runWorkers]) {
          const conversation = await window.api.browser.newConversation(site);
          if ("error" in conversation) throw new Error(conversation.error);
          conversationByModel[site] = conversation.id;
          const conversationMode: AgentMode = site === activeCoordinator ? activeMode : "ask";
          setModelConversation(modelConversations, site, conversationMode, conversation.id);
        }
        checkpoint.conversations = { ...conversationByModel };
        checkpoint.agentProgress = {};
        checkpoint.agentResults = {};
        checkpoint.agentTasks = {};
        checkpoint.plan = "";
        checkpoint.planDetails = undefined;
        checkpoint.planSteps = undefined;
        checkpoint.planMessageId = undefined;
        try {
          const savedPlan = readLastPlan(root);
          if (savedPlan) localStorage.removeItem(LAST_PLAN_KEY);
        } catch { /* storage is optional */ }
        note("The saved task used stale project or model context; its plan and provider threads were cleared before resuming.");
      }
      persistPendingRun(checkpoint);
      const refreshCheckpointSource = async (path: string, diskHash: string, liveContent: string): Promise<void> => {
        checkpoint.sourceHashes[path] = diskHash;
        checkpoint.sourceContentHashes[path] = await digest(liveContent);
        const source = sources.find((file) => file.path === path);
        if (source) {
          source.hash = diskHash;
          source.content = liveContent;
          source.bufferContent = liveContent;
        }
        persistPendingRun(checkpoint);
      };

      let implementationPlan = resumeWasInvalidated ? "" : resume?.plan ?? "";
      let implementationPlanState: BrowserImplementationPlan | undefined = resumeWasInvalidated ? undefined : resume?.planDetails ?? (resume?.planSteps?.length
        ? {
            title: implementationPlan.match(/^#\s+(.+)$/m)?.[1] ?? "Implementation plan",
            summary: "",
            steps: resume.planSteps,
            risks: [],
          }
        : undefined);
      let planMessageId = resumeWasInvalidated ? undefined : resume?.planMessageId;
      const publishPlan = (nextPlan: BrowserImplementationPlan, completed: ReadonlySet<string> = new Set()): void => {
        if (!planMessageId) planMessageId = uid("browser-plan");
        checkpoint.plan = renderBrowserPlan(nextPlan);
        checkpoint.planDetails = nextPlan;
        checkpoint.planSteps = nextPlan.steps;
        checkpoint.planMessageId = planMessageId;
        persistPendingRun(checkpoint);
        const planEntry: ChatMessageEntry = {
          id: planMessageId, role: "assistant",
          text: `### Implementation plan\n\n${renderBrowserPlan(nextPlan, completed)}`,
          ts: Date.now(), site: activeCoordinator, status: "done",
        };
        setChatMessages((previous) => previous.some((entry) => entry.id === planMessageId)
          ? previous.map((entry) => entry.id === planMessageId ? planEntry : entry)
          : [...previous, planEntry]);
      };
      if (!implementationPlanState && root) {
        // The user may have prepared this plan in Plan mode and switched to
        // Code/Debug to build it — reuse that saved plan instead of
        // re-planning from scratch (the old flow ignored it and stalled).
        const saved = readLastPlan(root);
        if (saved && isImplementSavedPlanRequest(submittedTask)) {
          implementationPlanState = saved.plan;
          implementationPlan = renderBrowserPlan(saved.plan);
          publishPlan(saved.plan);
          note(`Reusing the saved plan “${saved.plan.title}”${saved.planFile ? ` (${saved.planFile})` : ""}; the coordinator will now implement it`);
        }
      }
      if (!implementationPlanState) {
        setStage(`${BROWSER_SITES.find((item) => item.id === activeCoordinator)?.label} is preparing a structured plan`);
        note(`${activeCoordinator} is investigating the project and creating a structured plan`);
        let autoPlanFile: string | null = null;
        // Internal planning uses a separate provider chat so its "planning
        // only" instructions cannot leak into the Code implementation turn.
        let plannerConversationId = conversationByModel[activeCoordinator];
        plannerConversationId = getModelConversation(modelConversations, activeCoordinator, "plan");
        if (!plannerConversationId) {
          const plannerConversation = await window.api.browser.newConversation(activeCoordinator);
          if ("error" in plannerConversation) throw new Error(plannerConversation.error);
          plannerConversationId = plannerConversation.id;
          setModelConversation(modelConversations, activeCoordinator, "plan", plannerConversationId);
        }
        const planResult = await runIsolatedBrowserAgent({
          site: activeCoordinator, task: submittedTask, mode: "plan",
          internalCodePlanning: true,
          conversationId: plannerConversationId, sources, workspaceRoot: root, ask, checkCanceled, note,
          onPlan: (nextPlan, file) => {
            if (file) autoPlanFile = file;
            implementationPlanState = nextPlan;
            implementationPlan = renderBrowserPlan(nextPlan);
            publishPlan(nextPlan);
          },
          onFileRefresh: refreshCheckpointSource,
        });
        const completedPlan = planResult.plan ?? {
          title: "Implement the requested changes",
          summary: submittedTask,
          steps: [{
            title: "Implement and verify the requested changes",
            description: "Use the user request and relevant project files as the implementation scope, then verify the changed files.",
            files_touched: sources.filter((file) => /\.(html?|css|mjs?|cjs)$/i.test(file.path)).map((file) => file.path),
          }],
          risks: ["The model did not return a structured plan; this short fallback was generated by the workflow."],
        } satisfies BrowserImplementationPlan;
        if (planResult.incomplete || !planResult.plan) note("The model did not finish a structured plan, so the workflow created a short fallback plan and will continue in Code mode.");
        implementationPlanState = completedPlan;
        implementationPlan = renderBrowserPlan(completedPlan);
        publishPlan(completedPlan);
        if (root && planResult.plan) writeLastPlan({
          workspaceRoot: root, task: submittedTask, plan: completedPlan, planFile: autoPlanFile,
          updatedAt: Date.now(), workspaceFingerprint: await fingerprintWorkspacePaths(workspaceManifestForSave),
        });
        if (planResult.plan) note("Structured plan is ready; the coordinator will now implement it");
      } else {
        implementationPlan = implementationPlan || renderBrowserPlan(implementationPlanState);
        publishPlan(implementationPlanState, new Set(checkpoint.agentProgress[activeCoordinator]?.completedTasks ?? []));
      }

      runWorkers = shouldDelegateTask(submittedTask) ? runWorkers : [];
      checkpoint.workers = runWorkers;
      if (runWorkers.length) {
        setStage("Workers are reviewing the plan (read-only)");
        const workerSettled = await Promise.allSettled(runWorkers.map(async (site, index) => {
          const workerTask = `Read-only analysis for the user's coding task. Review the implementation plan and project snapshot. Identify relevant existing files, risks, and useful checks. Do not edit or propose file contents.\nTASK:\n${submittedTask}\nPLAN:\n${implementationPlan}\nANALYSIS FOCUS: ${index === 0 ? "relevant implementation patterns and files" : "edge cases and verification risks"}`;
          const result = await runIsolatedBrowserAgent({
            site, task: workerTask, mode: "ask", conversationId: conversationByModel[site], sources, workspaceRoot: root, ask, checkCanceled, note,
            resumeState: checkpoint.agentProgress[site],
            onCheckpoint: (state) => { checkpoint.agentProgress[site] = state; persistPendingRun(checkpoint); },
            onFileRefresh: refreshCheckpointSource,
          });
          if (result.incomplete) throw new Error(`${site} did not finish its analysis.`);
          checkpoint.agentResults[site] = { files: [], summary: result.summary };
          persistPendingRun(checkpoint);
          return { site, summary: result.summary };
        }));
        for (const result of workerSettled) {
          if (result.status === "fulfilled") note(`${result.value.site} returned read-only analysis`);
          else note(`A worker analysis was skipped: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
        }
      }
      checkCanceled();
      const workerFindings = runWorkers.map((site) => checkpoint.agentResults[site]?.summary).filter((value): value is string => !!value?.trim());
      const coordinatorTask = workerFindings.length
        ? `${submittedTask}\n\nRead-only worker analysis (use as supporting context; resolve any conflicts yourself):\n${workerFindings.map((finding, index) => `Worker ${index + 1}: ${finding}`).join("\n\n")}`
        : submittedTask;
      setStage(`${BROWSER_SITES.find((item) => item.id === activeCoordinator)?.label} is editing the planned files`);
      const expectedEditorContents = new Map(sources.map((file) => [file.path, file.bufferContent ?? file.content]));
      const changedPaths = new Set([...savedDuringRun, ...(checkpoint.changedPaths ?? [])]);
      const coordinatorResult = await runIsolatedBrowserAgent({
        site: activeCoordinator,
        task: coordinatorTask,
        mode: activeMode,
        plan: implementationPlanState,
        conversationId: conversationByModel[activeCoordinator],
        sources,
        workspaceRoot: root,
        ask,
        checkCanceled,
        note,
        // 10-step plans with paginated reads + per-step edits cannot fit
        // in the default 40 turns; progress checkpoints make resume safe.
        maxTurns: 80,
        onTaskDone: (_title, completed) => publishPlan(implementationPlanState!, new Set(completed)),
        resumeState: checkpoint.agentProgress[activeCoordinator],
        onCheckpoint: (state) => { checkpoint.agentProgress[activeCoordinator] = state; persistPendingRun(checkpoint); },
        onFileChange: async (path, content) => {
          const source = sources.find((file) => file.path === path);
          const expectedHash = Object.prototype.hasOwnProperty.call(checkpoint.sourceHashes, path)
            ? checkpoint.sourceHashes[path]
            : source?.hash ?? null;
          await applyChanges([{ path, content, expectedHash }], sources, assistantId, submittedTask, expectedEditorContents);
          const hash = await digest(content);
          checkpoint.sourceHashes[path] = hash;
          checkpoint.sourceContentHashes[path] = hash;
          if (source) {
            source.hash = hash;
            source.content = content;
            delete source.bufferContent;
          }
          expectedEditorContents.set(path, content);
          changedPaths.add(path);
          savedDuringRun.add(path);
          checkpoint.changedPaths = [...changedPaths];
          persistPendingRun(checkpoint);
        },
        onFileRefresh: refreshCheckpointSource,
      });
      if (coordinatorResult.incomplete) throw new Error(`${activeCoordinator} stopped before finishing. Completed edits remain saved.`);
      checkCanceled();
      const savedPaths = [...changedPaths];
      const finalSummary = coordinatorResult.summary.trim() || (savedPaths.length ? "The requested edits are saved." : "No file changes were needed.");
      const completedText = savedPaths.length
        ? `${finalSummary}\n\nSaved ${savedPaths.length} file change${savedPaths.length === 1 ? "" : "s"} to the open project.`
        : `${finalSummary}\n\nNo workspace files were changed.`;
      // Chronological order: move the finished summary after the plan and
      // file activities instead of filling the placeholder above them.
      setChatMessages((previous) => [...previous.filter((entry) => entry.id !== assistantId),
        { id: assistantId, role: "assistant", text: completedText, ts: Date.now(), site: activeCoordinator, status: "done", files: savedPaths }]);
      setStage(savedPaths.length ? "Changes saved to the open project" : "Response complete · no workspace files changed");
      saveHistory({ id: uid("history"), title: submittedTask.slice(0, 100), date: Date.now(), coordinator: activeCoordinator, workers: runWorkers, outcome: savedPaths.length ? "applied" : "complete", summary: completedText, files: savedPaths });
      clearPendingRun(root);
      if (fingerprintKeyForSave) {
        const fingerprints = readWorkspaceFingerprints();
        const finalFingerprint = await fingerprintWorkspacePaths([...workspaceManifestForSave, ...savedDuringRun]);
        fingerprints[fingerprintKeyForSave] = finalFingerprint;
        try { localStorage.setItem(WORKSPACE_FINGERPRINTS_KEY, JSON.stringify(fingerprints)); } catch { /* best-effort */ }
        const savedPlan = readLastPlan(root);
        if (savedPlan) writeLastPlan({ ...savedPlan, workspaceFingerprint: finalFingerprint });
      }
    } catch (err) {
      let message = err instanceof Error ? err.message : String(err);
      if (resume && root && !readPendingRun(root)) persistPendingRun(resume);
      if (/Run canceled/i.test(message) && root && readPendingRun(root)) {
        message = "Run paused. Use Continue saved task to resume.";
      }
      if (savedDuringRun.size) message += ` Already saved: ${[...savedDuringRun].join(", ")}.`;
      if (/failed to connect to chrome|cannot attach to its debugging connection/i.test(message)) {
        useBrowserStore.setState({ chromeError: message });
        void useBrowserStore.getState().refreshStatus();
      }
      setError(message); setStage("Run stopped"); note(message);
      setChatMessages((previous) => {
        const assistant = previous.find((entry) => entry.id === assistantId && entry.role === "assistant");
        return [...previous.filter((entry) => entry.id !== assistantId), ...(assistant?.role === "assistant" ? [{ ...assistant, text: `I couldn't complete the run. ${message}`, status: "failed" as const }] : [])];
      });
      saveHistory({ id: `${Date.now()}`, title: submittedTask.slice(0, 100), date: Date.now(), coordinator: activeCoordinator, workers: resume?.workers ?? workers, outcome: "stopped", summary: message, files: [...savedDuringRun] });
      if (fingerprintKeyForSave && workspaceManifestForSave.length) {
        try {
          const fingerprints = readWorkspaceFingerprints();
          fingerprints[fingerprintKeyForSave] = await fingerprintWorkspacePaths([...workspaceManifestForSave, ...savedDuringRun]);
          localStorage.setItem(WORKSPACE_FINGERPRINTS_KEY, JSON.stringify(fingerprints));
        } catch { /* best-effort */ }
      }
    } finally { activeAssistantId.current = null; setBusy(false); }
  };

  const applyChanges = async (
    changes: WorkspaceFileChange[],
    sources: SourceFile[],
    assistantId: string,
    task: string,
    expectedEditorContents: Map<string, string>,
  ): Promise<void> => {
    const sourceByPath = new Map(sources.map((source) => [source.path, source]));
    const root = workspace?.path;
    if (!root) throw new Error("Open a project before applying Browser Agent changes.");
    const separator = root.includes("\\") ? "\\" : "/";
    const beforeContents = new Map<string, string>();
    for (const change of changes) {
      const source = sourceByPath.get(change.path);
      const absolutePath = source?.absolutePath ?? `${root.replace(/[\\/]$/, "")}${separator}${change.path.replace(/[\\/]/g, separator)}`;
      const open = useEditorStore.getState().files[absolutePath];
      const expectedEditorContent = expectedEditorContents.get(change.path);
      if (open?.dirty && open.content !== expectedEditorContent) {
        throw new Error(`Your unsaved editor changes conflict with ${change.path}. Save or close that buffer, then continue the task.`);
      }
      if (change.expectedHash !== null) {
        const disk = await window.api.workspace.readFile(absolutePath);
        if (!disk) throw new Error(`${change.path} was removed from the open workspace. Earlier edits remain saved; use list_dir to confirm its current path.`);
        if (disk.binary || typeof disk.content !== "string") throw new Error(`${change.path} is no longer a readable text file. Earlier edits remain saved.`);
        if (await digest(disk.content) !== change.expectedHash) throw new Error(`${change.path} changed on disk while the agent was working. Earlier edits remain saved; no further changes were applied. Call read_file to load the latest content, then rebase only the intended edit. Save any unsaved editor buffer before retrying.`);
        const baseline = source?.bufferContent ?? (expectedEditorContent === source?.content ? disk.content : expectedEditorContent) ?? disk.content;
        beforeContents.set(change.path, baseline);
      } else {
        beforeContents.set(change.path, "");
      }
    }
    const result = await window.api.workspace.applyFileChanges(changes);
    if (!result.success) throw new Error(`Could not save the next edit. Earlier edits remain saved: ${result.error}`);
    for (const change of changes) {
      const source = sourceByPath.get(change.path);
      const absolutePath = source?.absolutePath ?? `${root.replace(/[\\/]$/, "")}${separator}${change.path.replace(/[\\/]/g, separator)}`;
      if (useEditorStore.getState().files[absolutePath]) {
        useEditorStore.getState().setSavedFileContent(absolutePath, change.content);
      }
    }
    const activityEntries: ChatActivityEntry[] = changes.map((change) => {
      const source = sourceByPath.get(change.path);
      const diff = diffForChange(change.path, beforeContents.get(change.path) ?? "", change.content);
      const item: BrowserActivityItem = {
        id: browserActivityId("bact"),
        kind: kindForTool(source ? "edit_file" : "write_file"),
        target: change.path,
        detail: "Saved to the open project",
        status: "completed",
        timestamp: Date.now(),
        ...diff,
      };
      return { id: item.id, role: "activity", text: item.detail ?? change.path, ts: item.timestamp, item };
    });
    setChatMessages((previous) => [...previous.filter((entry) => entry.id !== assistantId), ...activityEntries, ...previous.filter((entry) => entry.id === assistantId)]);
    note(`Saved ${changes.map((change) => change.path).join(", ")} to the open project`);
  };
  // Chat-only sites (e.g. Perplexity) are single-chat for now — they never
  // appear as coordinator/worker options in the orchestration UI.
  const agentSites = agentEligibleSites(BROWSER_SITES.map((site) => site.id))
    .map((id) => BROWSER_SITES.find((site) => site.id === id))
    .filter((site): site is (typeof BROWSER_SITES)[number] => Boolean(site));
  const modelOptions = agentSites.filter((site) => site.id !== coordinator);
  const currentMode = AGENT_MODES.find((item) => item.id === mode) ?? AGENT_MODES[2];
  const CurrentModeIcon = currentMode.icon;
  const isConnected = status?.cdp_reachable === true && !chromeError;
  const canRestartBrowser = status?.chrome_managed === true && /failed to connect to chrome|cannot attach to its debugging connection/i.test(chromeError ?? "");
  const connectionLabel = chromeBusy || statusLoading
    ? "Checking Chrome connection…"
    : isConnected
    ? "Chrome responds"
      : "Chrome is not connected";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {settingsOpen ? <div className="agent-code-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-scroll overscroll-contain px-4 py-4">
      <section className="shrink-0 rounded-2xl border border-outline-variant bg-surface-container-low p-4">
        <div className="mb-1 flex items-center gap-2"><span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/10 text-primary"><Sparkles size={16} /></span><div><h2 className="font-label-md text-label-md font-semibold text-on-surface">Browser Agent</h2><p className="font-label-xs text-label-xs text-secondary">Five modes · plan first · incremental edits</p></div></div>
        <p className="mb-4 font-body-sm text-body-sm leading-relaxed text-secondary">The coordinator plans and makes all workspace edits. Selected workers can review broad tasks without writing files. Each completed edit is saved after a conflict check.</p>

        <div className={cn("mb-4 flex items-start gap-2.5 rounded-xl border px-3 py-2.5", isConnected ? "border-emerald-500/25 bg-emerald-500/5" : "border-amber-500/25 bg-amber-500/5")}>
          <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", chromeBusy || statusLoading ? "animate-pulse bg-amber-500" : isConnected ? "bg-emerald-500" : "bg-amber-500")} />
          <div className="min-w-0 flex-1"><p className="font-label-sm text-label-sm font-medium text-on-surface">{connectionLabel}</p><p className="mt-0.5 font-label-xs text-label-xs leading-relaxed text-secondary">{isConnected ? "The Browser Agent checks model-tab access when a run starts." : chromeError ?? "Connect Chrome to open model conversations and start a run."}</p></div>
          {!isConnected && <button type="button" disabled={chromeBusy} title={canRestartBrowser ? "Closes Xvie-managed provider tabs and reuses the browser profile. A sign-in may be needed again." : "Open the managed browser to sign in."} onClick={() => { if (canRestartBrowser) { if (window.confirm("Restart Xvie's managed browser? Its provider tabs will close. The same browser profile is reused, but you may need to sign in again. Unsent drafts in those tabs may be lost.")) void restartChrome(true); } else void ensureChrome(true); }} className="shrink-0 rounded-lg border border-outline-variant bg-surface-container-lowest px-2.5 py-1.5 font-label-xs text-label-xs font-medium text-on-surface disabled:opacity-50">{chromeBusy ? "Connecting…" : canRestartBrowser ? "Restart browser" : "Open browser"}</button>}
        </div>

        <div className="mb-4 rounded-xl border border-outline-variant bg-surface-container-lowest p-3">
          <div className="mb-2 flex items-center justify-between gap-2"><label htmlFor="browser-agent-coordinator" className="font-label-sm text-label-sm font-semibold text-on-surface">Coordinator</label><span className="rounded-full bg-primary/10 px-2 py-0.5 font-label-xs text-label-xs font-medium text-primary">Plans + edits</span></div>
          <div className="relative">
            <select id="browser-agent-coordinator" value={coordinator} onChange={(event) => { const next = event.target.value as BrowserSiteId; setCoordinator(next); setWorkers((old) => old.filter((id) => id !== next)); }} className="w-full cursor-pointer appearance-none rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2.5 pr-9 font-label-md text-label-md font-medium text-on-surface focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20">
              {BROWSER_SITES.map((site) => <option key={site.id} value={site.id} disabled={isChatOnlySite(site.id)}>{site.label}{site.id === "deepseek" ? " · default" : ""}{isChatOnlySite(site.id) ? " · chat only" : ""}</option>)}
            </select><ChevronDown size={14} className="pointer-events-none absolute right-3 top-3 text-secondary" />
          </div>
          <div className="mt-2 flex items-center gap-2 rounded-lg bg-surface-container-low px-2.5 py-2"><BrandIcon id={coordinator} size={16} /><span className="font-label-sm text-label-sm font-medium text-on-surface">{BROWSER_SITES.find((site) => site.id === coordinator)?.label}</span><span className="ml-auto font-label-xs text-label-xs text-secondary">Coordinator</span></div>
        </div>

        <div className="mb-4">
          <div className="mb-2 flex items-center justify-between"><p className="font-label-sm text-label-sm font-semibold text-on-surface">Worker models</p><span className="font-label-xs text-label-xs text-secondary">Optional · up to 2 for broad tasks</span></div>
          <div className="grid grid-cols-1 gap-2">
            {modelOptions.map((site) => { const selected = workers.includes(site.id); const signedIn = loginState[site.id]; return <button key={site.id} type="button" aria-pressed={selected} onClick={() => toggleWorker(site.id)} className={cn("flex min-w-0 items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors", selected ? "border-primary/50 bg-primary/10" : "border-outline-variant bg-surface-container-lowest hover:bg-surface-container") }><span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", BRAND_TINT[site.id])}><BrandIcon id={site.id} size={17} /></span><span className="min-w-0 flex-1"><span className="block truncate font-label-sm text-label-sm font-medium text-on-surface">{site.label}</span><span className={cn("block truncate font-label-xs text-label-xs", signedIn === false ? "text-amber-500" : "text-secondary")}>{signedIn === true ? "Signed in" : signedIn === false ? "Sign-in needed" : "Not checked"}</span></span><span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-md border", selected ? "border-primary bg-primary text-on-primary" : "border-outline-variant text-transparent")}>{selected && <Check size={13} />}</span></button>; })}
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className={cn("flex items-center gap-1.5 font-label-xs text-label-xs", isConnected ? "text-emerald-500" : "text-secondary")}><span className={cn("h-1.5 w-1.5 rounded-full", isConnected ? "bg-emerald-500" : "bg-amber-500")} />{isConnected ? "Chrome connected" : "Models sign in through browser"}</span>
          {settingsOpen && <button type="button" onClick={() => { const saved = readModelConfig(); if (saved) { setCoordinator(saved.coordinator); setWorkers(saved.workers); } setSettingsOpen(false); }} className="rounded-lg border border-outline-variant px-2.5 py-2 font-label-sm text-label-sm text-on-surface">Cancel</button>}
          <button type="button" onClick={() => { try { localStorage.setItem(MODEL_CONFIG_KEY, JSON.stringify({ coordinator, workers, configured: true } satisfies BrowserAgentModelConfig)); } catch { /* retain this view's selection for the current session */ } setSettingsOpen(false); }} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 font-label-sm text-label-sm font-medium text-on-primary"><MessageSquare size={13} />Save models</button>
        </div>
      </section>

      <section className="shrink-0 rounded-xl border border-outline-variant bg-surface-container-lowest">
        <div className="flex items-center">
          <button type="button" onClick={() => setHistoryOpen((open) => !open)} aria-expanded={historyOpen} className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left font-label-sm text-label-sm font-medium text-on-surface"><History size={14} className="text-secondary" />Workflow history <span className="ml-auto rounded-full bg-surface-container-low px-2 py-0.5 font-label-xs text-label-xs text-secondary">{history.length}</span><ChevronDown size={13} className={cn("text-secondary transition-transform", historyOpen && "rotate-180")} /></button>
          {history.length > 0 && <button type="button" onClick={() => { if (window.confirm("Delete all Browser Agent workflow history? Saved workspace files will not be changed.")) clearWorkflowHistory(); }} title="Clear workflow history" aria-label="Clear workflow history" className="mr-2 rounded-md p-1.5 text-secondary hover:bg-surface-container-low hover:text-error"><Trash2 size={13} /></button>}
        </div>
        {historyOpen && <div className="agent-code-scroll max-h-52 overflow-y-auto border-t border-outline-variant p-1.5">{history.length ? history.map(renderHistoryEntry) : <p className="px-2.5 py-3 font-label-xs text-label-xs text-secondary">Completed and stopped runs appear here.</p>}</div>}
      </section>

      {(stage || activity.length > 0) && <section className="shrink-0 rounded-xl border border-outline-variant p-3"><div className="mb-2 flex items-center gap-2"><Loader2 size={13} className={cn("text-primary", busy && "animate-spin")} /><span className="font-label-sm text-label-sm font-medium text-on-surface">{stage}</span></div><div className="flex flex-col gap-1.5">{activity.map((line, index) => <p key={`${line}-${index}`} className="font-label-xs text-label-xs text-secondary">{line}</p>)}</div></section>}

      {error && <div role="alert" className="shrink-0 flex gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3 font-label-sm text-label-sm text-red-400"><CircleAlert size={14} className="mt-0.5 shrink-0" /><span className="break-words">{error}</span></div>}

      </div> : <>
        <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-outline-variant px-3 py-2">
          <button type="button" onClick={() => setSettingsOpen(true)} title="Change Browser Agent models" aria-label="Change Browser Agent models" className="rounded-md p-1.5 text-secondary hover:bg-surface-container-low hover:text-on-surface"><Settings2 size={15} /></button>
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Sparkles size={15} /></span>
          <div className="min-w-0 flex-1"><p className="truncate font-label-sm text-label-sm font-semibold text-on-surface">Browser Agent</p><p className="truncate font-label-xs text-label-xs text-secondary">{[coordinator, ...workers].map((id) => BROWSER_SITES.find((site) => site.id === id)?.label).join(" · ")}</p></div>
          <button type="button" disabled={chromeBusy} title={isConnected ? "Show the connected browser window" : "Open the browser and keep this session available"} onClick={() => { if (canRestartBrowser) { if (window.confirm("Restart Xvie's managed browser? Its provider tabs will close. The same profile is reused, but you may need to sign in again and unsent tab drafts may be lost.")) void restartChrome(true); } else void ensureChrome(true); }} className="shrink-0 rounded-lg border border-outline-variant px-2 py-1 font-label-xs text-label-xs text-on-surface disabled:opacity-50">{chromeBusy ? "Opening…" : canRestartBrowser ? "Restart browser" : isConnected ? "Show browser" : "Open browser"}</button>
          <button type="button" title="Workflow history" aria-label="Workflow history" onClick={() => setHistoryOpen((open) => !open)} className={cn("rounded-md p-1.5 hover:bg-surface-container-low", historyOpen ? "text-primary" : "text-secondary")}><History size={15} /></button>
          <button type="button" title="New conversation (clears this workspace's saved task and plan)" aria-label="New conversation" disabled={busy} onClick={startNewAgentConversation} className="rounded-md p-1.5 text-secondary hover:bg-surface-container-low hover:text-on-surface disabled:opacity-40"><Plus size={15} /></button>
        </header>
        {historyOpen && <section className="agent-code-scroll max-h-40 shrink-0 overflow-y-auto border-b border-outline-variant p-2">{history.length ? history.map(renderHistoryEntry) : <p className="p-2 font-label-xs text-label-xs text-secondary">No workflow history yet.</p>}</section>}
        {pendingRun && pendingRun.workspaceRoot === workspace?.path && <div className="flex shrink-0 items-center gap-3 border-b border-primary/20 bg-primary/5 px-4 py-2.5">
          <div className="min-w-0 flex-1"><p className="font-label-xs text-label-xs font-medium text-on-surface">Paused task saved</p><p className="truncate font-label-xs text-label-xs text-secondary">{pendingRun.task}</p></div>
          <button type="button" disabled={busy} onClick={() => { setCoordinator(pendingRun.coordinator); setWorkers(pendingRun.workers); setMode(pendingRun.mode ?? "code"); void run(pendingRun.task, pendingRun); }} className="shrink-0 rounded-lg bg-primary px-3 py-1.5 font-label-xs text-label-xs font-medium text-on-primary disabled:opacity-50">Continue</button>
          <button type="button" disabled={busy} onClick={() => { if (window.confirm("Discard this saved Browser Agent task and its saved plan? Any edits already saved to the project will remain.")) { clearPendingRun(pendingRun.workspaceRoot); const saved = readLastPlan(pendingRun.workspaceRoot); if (saved?.task === pendingRun.task) { try { localStorage.removeItem(LAST_PLAN_KEY); } catch { /* storage is optional */ } } } }} className="shrink-0 rounded-lg px-2 py-1.5 font-label-xs text-label-xs text-secondary hover:bg-surface-container">Discard</button>
        </div>}
        {busy && <div className="shrink-0 border-b border-outline-variant/70 px-4 py-2" role="status" aria-live="polite">
          <div className="mb-1.5 flex items-center gap-2"><Loader2 size={12} className="animate-spin text-primary" /><span className="truncate font-label-xs text-label-xs text-secondary">{stage || "Working on your request"}</span></div>
          <div className="h-0.5 origin-left animate-pulse rounded-full bg-primary/60" />
        </div>}
        <div ref={chatScrollRef} className="agent-code-scroll flex min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="mx-auto flex min-h-full w-full max-w-[820px] flex-col gap-5 px-6 pb-12 pt-6">
          {!chatMessages.length && (
            <div className="mx-auto w-full max-w-[820px] shrink-0" style={{ width: "min(100%, 51.25rem)" }}>
              <BrowserAgentWelcome mode={mode} coordinator={coordinator} onSelectMode={setMode} />
            </div>
          )}
          {chatMessages.map((entry) => entry.role === "activity" ? (
            <ToolRow key={entry.id} item={activityFor(entry)} />
          ) : (
            <div key={entry.id} className="shrink-0">
              {entry.role === "assistant" ? (
                <>
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className={cn("flex h-5 w-5 items-center justify-center rounded-full", BRAND_TINT[entry.site ?? coordinator])}>
                      <BrandIcon id={entry.site ?? coordinator} size={13} />
                    </span>
                    <span className="font-label-xs text-label-xs text-secondary">{BROWSER_SITES.find((site) => site.id === (entry.site ?? coordinator))?.label ?? "Assistant"} · {new Date(entry.ts ?? Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  </div>
                  <div className="pl-7"><MessageItem message={messageFor(entry)} showHeader={false} /></div>
                </>
              ) : <MessageItem message={messageFor(entry)} />}
              {entry.role === "assistant" && entry.status === "streaming" && !entry.text && (
                <div className="mt-2 flex items-center gap-2 pl-7 font-label-xs text-label-xs text-secondary" role="status" aria-live="polite">
                  <Loader2 size={13} className="animate-spin" />{stage || "Working on your request"}
                </div>
              )}
              {entry.role === "assistant" && entry.files && entry.files.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5 pl-7">
                  {entry.files.map((path) => {
                    const root = workspace?.path ?? "";
                    const separator = root.includes("\\") ? "\\" : "/";
                    const absolutePath = `${root.replace(/[\\/]$/, "")}${separator}${path.replace(/[\\/]/g, separator)}`;
                    return (
                      <button key={path} type="button" onClick={() => { void useEditorStore.getState().openFile(absolutePath); }}
                        className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-outline-variant bg-surface-container-low px-2.5 py-1 font-label-xs text-label-xs text-on-surface transition-colors hover:bg-surface-container-high">
                        <Code2 size={12} className="shrink-0 text-primary" /><span className="truncate">{path}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
          {browserQuestions.length > 0 && (
            <div className="shrink-0">
              <QuestionCard
                questions={browserQuestions}
                onSubmit={(answers) => resolveBrowserAnswers(answers)}
              />
            </div>
          )}
          {error && <div role="alert" className="mx-8 flex shrink-0 gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3 font-label-sm text-label-sm text-red-400"><CircleAlert size={14} className="mt-0.5 shrink-0" /><div className="min-w-0 flex-1"><p className="break-words">{error}</p>{canRestartBrowser && <button type="button" disabled={chromeBusy} onClick={() => { if (window.confirm("Restart Xvie's managed browser? Its provider tabs will close. The same profile will be reused, but you may need to sign in again.")) void restartChrome(true); }} className="mt-2 rounded-md border border-red-500/30 px-2.5 py-1.5 font-label-xs text-label-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50">{chromeBusy ? "Restarting browser…" : "Restart browser"}</button>}</div></div>}
          </div>
        </div>
        <div className="shrink-0 border-t border-outline-variant p-3">
          <div className="rounded-xl border border-outline-variant bg-surface-container-lowest shadow-sm focus-within:border-primary/50">
            <textarea ref={chatInputRef} value={chatDraft} onChange={(event) => setChatDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setModeOpen(false); return; } if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (chatDraft.trim() && !busy) { const task = chatDraft; setChatDraft(""); void run(task); } } }} disabled={false} rows={2} placeholder={busy ? "Working… (Stop to interrupt, you can still type)" : "Message Browser Agent…"} className="max-h-36 min-h-16 w-full resize-y bg-transparent px-3.5 py-3 font-body-sm text-body-sm text-on-surface placeholder:text-secondary focus:outline-none" />
            <div className="flex items-center justify-between border-t border-outline-variant px-2.5 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <div className="relative shrink-0">
                  <button type="button" aria-label="Select Browser Agent mode" aria-expanded={modeOpen} disabled={busy} onClick={() => setModeOpen((open) => !open)} className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 font-label-xs text-label-xs font-medium text-on-surface hover:bg-surface-container-low disabled:opacity-60">
                    <CurrentModeIcon size={13} className="text-primary" />{currentMode.label}<ChevronDown size={11} className="text-secondary" />
                  </button>
                  {modeOpen && <>
                    <button type="button" aria-label="Close mode menu" onClick={() => setModeOpen(false)} className="fixed inset-0 z-40 cursor-default" />
                    <div className="absolute bottom-full left-0 z-50 mb-1.5 w-56 rounded-xl border border-outline-variant bg-surface-container-lowest p-1 shadow-lg">
                      {AGENT_MODES.map((item) => <button key={item.id} type="button" onClick={() => { setMode(item.id); setModeOpen(false); }} className={cn("flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-surface-container", mode === item.id && "bg-surface-container-low")}>
                        <item.icon size={13} className="mt-0.5 shrink-0 text-secondary" />
                        <span className="min-w-0 flex-1"><span className="block font-label-sm text-label-sm text-on-surface">{item.label}</span><span className="block font-label-xs text-label-xs text-secondary">{item.description}</span></span>
                        {mode === item.id && <Check size={13} className="mt-0.5 text-primary" />}
                      </button>)}
                    </div>
                  </>}
                </div>
                <span className="truncate font-label-xs text-label-xs text-secondary">{BROWSER_SITES.find((site) => site.id === coordinator)?.label}{workers.length ? ` + ${workers.map((id) => BROWSER_SITES.find((site) => site.id === id)?.label).join(", ")}` : " · solo"}</span>
              </div>
              {busy ? <button type="button" onClick={() => { cancelRequested.current = true; setStage("Stopping after the current browser response"); cancelBrowserAnswers(); }} className="inline-flex items-center gap-1.5 rounded-lg border border-outline-variant px-2.5 py-1.5 font-label-xs text-label-xs text-on-surface"><Square size={12} fill="currentColor" />Stop</button> : <button type="button" aria-label="Send message" title="Send message" onClick={() => { const task = chatDraft; if (!task.trim()) return; setChatDraft(""); void run(task); }} disabled={!chatDraft.trim()} className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-on-primary disabled:opacity-40"><Send size={14} /></button>}
            </div>
          </div>
          <p className="mt-1.5 text-center font-label-xs text-label-xs text-secondary">Plan mode does not edit files. Code and Debug show a plan first, then save each completed edit.</p>
        </div>
      </>}
    </div>
  );
}
