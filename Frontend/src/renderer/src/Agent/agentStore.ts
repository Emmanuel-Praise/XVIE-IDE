import { create } from "zustand";
import { useFileSystemStore } from "@/Editor/fs/fileSystemStore";
import type {
  AgentMode,
  AgentNotification,
  AgentSession,
  ActivityItem,
  ContextStats,
  HistoryEntry,
  Message,
  PlanSummary
} from "./types";
import type { AgentEventEnvelope, AgentProviderProfile } from "../../../shared/ipc-types";

const EMPTY_CONTEXT: ContextStats = {
  repo: "workspace", project: "workspace", filesLoaded: 0, symbolsIndexed: 0,
  openEditors: 0, selectedContext: "Full workspace", memoryUsage: 0, contextSize: 0, contextBudget: 128
};

const pollingSessions = new Set<string>();

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function statusFor(stopReason: string, needsApproval: boolean): AgentSession["status"] {
  if (needsApproval) return "waiting";
  if (stopReason === "cancelled") return "stopped";
  if (stopReason === "output_incomplete") return "incomplete";
  return stopReason === "completed" ? "completed" : "failed";
}

function planFromText(text: string): PlanSummary {
  const steps = text.split(/\r?\n/)
    .map((line) => line.trim().replace(/^\s*(?:[-*•]|\d+[.)])\s*/, ""))
    .filter((line) => line.length > 4)
    .slice(0, 12);
  return {
    goal: text.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 180) ?? "Implementation plan",
    currentObjective: "Review the proposed plan",
    steps: (steps.length ? steps : ["Review the implementation plan"]).map((label, index) => ({ id: `plan-${index}`, label, done: false })),
    risks: [], dependencies: [], complexity: "Medium"
  };
}

function activityKind(event: { kind: string; data?: Record<string, unknown> }): ActivityItem["kind"] {
  if (["reasoning", "thought", "thinking"].includes(event.kind)) return "think";
  const tool = String(event.data?.tool ?? "").toLowerCase();
  if (/bash|run_code|terminal/.test(tool)) return "run";
  if (/write|edit|append|patch|move|delete/.test(tool) || event.kind === "editing" || event.kind === "edit_failed") return "write";
  if (/search|grep|find/.test(tool)) return "search";
  if (/read|list|inspect/.test(tool)) return "read";
  if (/verify|test/.test(tool)) return "verify";
  if (/git/.test(tool)) return "git";
  return "index";
}

function workspaceRoot(): string | null {
  return useFileSystemStore.getState().workspace?.path ?? null;
}

function refreshAgentChangedPath(file: string): void {
  const root = workspaceRoot();
  if (!root || !file.trim()) return;
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedFile = file.replace(/\\/g, "/");
  const isAbsolute = normalizedFile.startsWith("/") || /^[a-z]:\//i.test(normalizedFile);
  const path = isAbsolute ? normalizedFile : `${normalizedRoot}/${normalizedFile.replace(/^\.\//, "")}`;
  useFileSystemStore.getState().handleChanged(path);
}

function toSession(record: Record<string, unknown>, workspace: string): AgentSession {
  const rawMessages = Array.isArray(record.messages) ? record.messages as Array<Record<string, unknown>> : [];
  const created = Date.parse(String(record.created_at ?? "")) || Date.now();
  const toolDiffs = new Map<string, string>();
  for (const message of rawMessages) {
    if (message.role !== "tool" || typeof message.tool_call_id !== "string") continue;
    const content = String(message.content ?? "");
    const marker = content.indexOf("\nChanges:\n");
    if (marker >= 0) toolDiffs.set(message.tool_call_id, content.slice(marker + "\nChanges:\n".length).trim());
  }
  const messages: Message[] = rawMessages
    .map((message, rawIndex) => ({ message, rawIndex }))
    .filter(({ message }) => message.role === "user" || message.role === "assistant")
    .filter(({ message }) => message.role === "user" || String(message.content ?? "").trim().length > 0)
    .filter(({ message }) => message.role !== "assistant" || !Array.isArray(message.tool_calls))
    .filter(({ message }) => message.role !== "assistant" || !/^\s*(?:the user (?:said|asked)|i should\b|let me (?:check|inspect|look|read|continue exploring)\b)/i.test(String(message.content ?? "")))
    .map(({ message, rawIndex }) => ({
      id: String(message.message_id ?? uid("message")),
      role: message.role as "user" | "assistant",
      content: String(message.content ?? ""),
      status: "done",
      timestamp: created + rawIndex,
      fileRefs: []
    }));
  const savedThoughts = Array.isArray(record.visible_thoughts) ? record.visible_thoughts as Array<Record<string, unknown>> : [];
  const thoughts: ActivityItem[] = savedThoughts.map((thought, index) => ({
    id: `thought-${index}-${String(thought.timestamp ?? index)}`,
    kind: "think",
    target: "Thought",
    detail: String(thought.text ?? ""),
    durationMs: typeof thought.duration_ms === "number" ? thought.duration_ms : undefined,
    status: "completed",
    timestamp: Date.parse(String(thought.timestamp ?? "")) || created + index
  }));
  const activity: ActivityItem[] = [...thoughts, ...rawMessages.flatMap((message, messageIndex) => {
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls as Array<Record<string, unknown>> : [];
    return calls.map((call, callIndex) => {
      const tool = String(call.name ?? "tool");
      const args = call.arguments && typeof call.arguments === "object" ? call.arguments as Record<string, unknown> : {};
      const target = String(args.file ?? args.path ?? args.command ?? tool);
      return {
        id: String(call.id ?? `history-${messageIndex}-${callIndex}`),
        kind: activityKind({ kind: "tool_finished", data: { tool } }),
        target,
        tool,
        detail: `Completed ${tool}`,
        diff: typeof call.id === "string" ? toolDiffs.get(call.id) : undefined,
        status: "completed" as const,
        timestamp: created + messageIndex + callIndex
      };
    });
  })];
  const userPrompt = messages.find((message) => message.role === "user")?.content ?? "Agent task";
  const execution = record.execution_state as Record<string, unknown> | null;
  const awaiting = execution?.phase === "awaiting_approval";
  const planText = typeof execution?.proposed_plan === "string" ? execution.proposed_plan : "";
  return {
    id: String(record.session_id ?? uid("session")),
    loadedFromDisk: true,
    title: userPrompt.length > 48 ? `${userPrompt.slice(0, 48)}…` : userPrompt,
    prompt: userPrompt,
    createdAt: created,
    updatedAt: Date.parse(String(record.updated_at ?? "")) || created,
    durationMs: 0,
    status: awaiting ? "waiting" : "completed",
    messages,
    stages: [], agents: [], activity, tools: [],
    context: { ...EMPTY_CONTEXT, project: workspace.split(/[\\/]/).pop() || "workspace" },
    plan: planText ? planFromText(planText) : null,
    contextSummary: typeof record.context_summary === "string" ? record.context_summary : undefined,
    approvalPending: awaiting,
    approvalType: awaiting ? "plan" : undefined,
    approvalDescription: awaiting ? "Review and approve the plan to let the agent make changes." : undefined
  };
}

export interface AgentViewState {
  open: boolean;
  setOpen: (open: boolean) => void;
  sessions: AgentSession[];
  activeSessionId: string | null;
  activeSession: () => AgentSession | null;
  newTask: () => void;
  sendMessage: (text: string, mode: AgentMode) => void;
  stopTask: () => void;
  resetStuck: () => void;
  approvePlan: () => void;
  rejectPlan: () => void;
  answerQuestions: (answers: Array<{ id: string; selected: string[]; custom_text: string }>) => void;
  continuePlan: () => void;
  openSession: (sessionId: string) => Promise<void>;
  loadSessions: () => Promise<void>;
  setWorkspaceScope: (path: string | null) => void;
  mode: AgentMode;
  setMode: (mode: AgentMode) => void;
  draft: string;
  setDraft: (draft: string) => void;
  notifications: AgentNotification[];
  dismissNotification: (id: string) => void;
  history: HistoryEntry[];
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  providers: AgentProviderProfile[];
  selectedProvider: string;
  setSelectedProvider: (name: string) => void;
  refreshProviders: () => Promise<void>;
  saveProvider: (provider: AgentProviderProfile) => Promise<{ success: boolean; error?: string }>;
}

export const useAgentStore = create<AgentViewState>((set, get) => {
  let historyScope: string | null = null;
  let historyRequest = 0;
  const scopeFor = (path: string | null): string | null => {
    if (!path) return null;
    const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
    return window.api?.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const setWorkspaceScope = (path: string | null): void => {
    const nextScope = scopeFor(path);
    if (nextScope === historyScope) return;
    historyScope = nextScope;
    historyRequest += 1;
    set({ history: [], sessions: [], activeSessionId: null });
  };
  const patchSession = (id: string, update: (session: AgentSession) => Partial<AgentSession>) =>
    set((state) => ({ sessions: state.sessions.map((session) => session.id === id ? { ...session, ...update(session) } : session) }));

  const notify = (kind: AgentNotification["kind"], title: string, message: string) => {
    set((state) => ({ notifications: [{ id: uid("notice"), kind, title, message, timestamp: Date.now(), read: false }, ...state.notifications].slice(0, 5) }));
  };

  const consume = (sessionId: string, item: AgentEventEnvelope): void => {
    if (item.type === "question_required") {
      const questions = Array.isArray(item.questions) ? item.questions as unknown as import("./types").AgentQuestion[] : [];
      patchSession(sessionId, () => ({
        status: "waiting",
        pendingQuestions: questions,
        progressMessage: "The agent has questions for you",
      }));
      notify("info", "Agent has questions", "Answer the highlighted questions to continue the run.");
      return;
    }
    if (item.type === "questions_answered") {
      patchSession(sessionId, () => ({ status: "running", pendingQuestions: null, progressMessage: "Continuing with your answers" }));
      return;
    }
    if (item.type === "activity" && item.event) {
      const event = item.event;
      if (event.kind === "editing" && typeof event.data?.file === "string") {
        refreshAgentChangedPath(event.data.file);
      }
      if (event.kind === "question_required") {
        const questions = Array.isArray((event.data as Record<string, unknown>)?.questions)
          ? (event.data as Record<string, unknown>).questions as unknown as import("./types").AgentQuestion[]
          : [];
        patchSession(sessionId, () => ({
          status: "waiting",
          pendingQuestions: questions,
          progressMessage: "The agent has questions for you",
        }));
        notify("info", "Agent has questions", "Answer the highlighted questions to continue the run.");
        return;
      }
      if (event.kind === "reasoning" || event.kind === "thinking") {
        patchSession(sessionId, () => ({ progressMessage: "Thinking through the next step" }));
        return;
      }
      if (event.kind === "thought") {
        const thought = event.message.trim();
        patchSession(sessionId, (session) => ({
          progressMessage: "Considering the next step",
          activity: [...session.activity.map((item) => item.kind === "think" && item.status === "running" ? { ...item, status: "completed" as const, timestamp: Date.now() } : item), {
            id: uid("thought"), kind: "think", target: "Thought", detail: thought || "Considering the request.",
            durationMs: typeof event.data?.duration_ms === "number" ? event.data.duration_ms : undefined,
            status: "completed", timestamp: Date.now()
          }]
        }));
        return;
      }
      if (event.kind === "understanding_task") {
        patchSession(sessionId, () => ({ progressMessage: event.message }));
        return;
      }
      if (event.kind === "planning") {
        patchSession(sessionId, () => ({ progressMessage: "Reviewing the project and preparing a plan" }));
        return;
      }
      if (event.kind === "smalltalk") {
        patchSession(sessionId, () => ({ progressMessage: "Replying to your greeting" }));
        return;
      }
      if (["inspecting", "selected_model", "retrying", "context_trimmed", "context_compacted", "output_truncated", "rate_limit_wait", "verification_failed", "large_input"].includes(event.kind)) {
        patchSession(sessionId, () => ({
          ...(event.kind === "context_compacted" && typeof event.data?.summary === "string"
            ? { contextSummary: event.data.summary }
            : {}),
          progressMessage: event.kind === "selected_model" && event.message.startsWith("Model responded:")
            ? "Preparing a response"
            : event.message,
          progressUntil: event.kind === "rate_limit_wait" && typeof event.data?.retry_in === "number"
            ? Date.now() + Number(event.data.retry_in) * 1000
            : undefined
        }));
        return;
      }
      if (event.kind === "model_text") {
        const delta = String(event.data?.delta ?? event.message);
        patchSession(sessionId, (session) => {
          const activity = session.activity.map((item) => item.kind === "think" && item.status === "running" ? { ...item, status: "completed" as const, timestamp: Date.now() } : item);
          return { pendingText: (session.pendingText ?? "") + delta, progressMessage: "Preparing a response", activity };
        });
        return;
      }
      if (event.kind === "awaiting_confirmation") {
        patchSession(sessionId, () => ({ status: "waiting", approvalPending: true, approvalType: "tool", approvalDescription: event.message, progressMessage: "Waiting for your approval" }));
        return;
      }
      const data = event.data ?? {};
      const tool = String(data.tool ?? "");
      if (event.kind === "tool_finished") {
        patchSession(sessionId, (session) => {
          const running = [...session.activity].reverse().find((activity) => (activity.tool === tool || activity.target === tool) && activity.status === "running");
          return running ? {
            activity: session.activity.map((activity) => activity.id === running.id ? { ...activity, status: data.ok === false ? "failed" : "completed", detail: event.message } : activity),
            progressMessage: "Reviewing tool results"
          } : {};
        });
        return;
      }
      if (event.kind === "file_diff") {
        const file = String(data.file ?? "");
        const diff = event.message.trim();
        patchSession(sessionId, (session) => {
          const index = session.activity.map((activity) => activity.kind === "write" && (!file || activity.target === file || activity.tool === String(data.tool ?? ""))).lastIndexOf(true);
          if (index < 0) return {};
          return { activity: session.activity.map((activity, activityIndex) => activityIndex === index ? { ...activity, diff } : activity) };
        });
        return;
      }
      const hasToolEvent = Boolean(tool) || ["editing", "edit_failed", "action_denied", "task_done", "verifying", "verification_failed", "awaiting_confirmation", "plan_required"].includes(event.kind);
      if (!hasToolEvent) {
        patchSession(sessionId, () => ({ progressMessage: event.message || "Working on your request" }));
        return;
      }
      if (event.kind === "tool_started" && tool === "think") {
        patchSession(sessionId, () => ({ pendingText: "", progressMessage: "Considering the next step" }));
        return;
      }
      const target = String(data.file ?? data.path ?? tool ?? event.message).trim() || event.message;
      const itemStatus: ActivityItem["status"] = event.kind === "tool_started" || event.kind === "editing" && !data.file ? "running" : event.kind === "edit_failed" || event.kind === "action_denied" ? "failed" : "completed";
      const activity: ActivityItem = { id: uid("activity"), kind: activityKind(event), target, tool: tool || undefined, detail: event.message, status: itemStatus, timestamp: Date.now() };
      patchSession(sessionId, (session) => {
        const runningTool = event.kind === "editing"
          ? [...session.activity].reverse().find((item) => item.status === "running" && item.kind === "write" && (!tool || item.tool === tool || item.target === tool))
          : undefined;
        return {
          status: session.approvalPending ? "waiting" : "running",
          pendingText: event.kind === "tool_started" ? "" : session.pendingText,
          progressMessage: event.kind === "tool_started" ? `Using ${tool || "a project tool"}` : event.message || "Working on your request",
          activity: runningTool
            ? session.activity.map((item) => item.id === runningTool.id ? { ...item, target: String(data.file ?? item.target), detail: event.message, status: itemStatus, timestamp: Date.now() } : item)
            : [...session.activity, activity],
          plan: session.plan && event.kind === "task_done"
            ? { ...session.plan, steps: session.plan.steps.map((step, index) => index === 0 ? { ...step, done: true } : step) }
            : session.plan
        };
      });
      return;
    }
    if (item.type === "approval_required") {
      patchSession(sessionId, () => ({ status: "waiting", approvalPending: true, approvalType: "tool", approvalDescription: item.description ?? "The agent needs permission to continue." }));
      return;
    }
    if (item.type === "approval_rejected") {
      patchSession(sessionId, () => ({ status: "stopped", approvalPending: false, approvalType: undefined, approvalDescription: undefined }));
      return;
    }
    if (item.type === "approval_denied") {
      patchSession(sessionId, () => ({ status: "running", approvalPending: false, approvalType: undefined, approvalDescription: undefined }));
      return;
    }
    if (item.type === "failed") {
      patchSession(sessionId, () => ({ status: "failed", error: item.error, approvalPending: false, progressMessage: undefined, pendingText: undefined }));
      notify("error", "Agent stopped", item.error ?? "The agent service encountered an error.");
      return;
    }
    if (item.type === "completed" && item.result) {
      const result = item.result;
      patchSession(sessionId, (session) => {
        const responseIncomplete = result.stop_reason === "output_incomplete";
        const messages = result.final_output.trim()
          ? [...session.messages, { id: uid("message"), role: "assistant" as const, content: result.final_output, status: responseIncomplete ? "incomplete" as const : "done" as const, timestamp: Date.now(), fileRefs: [] }]
          : session.messages;
        const needsApproval = result.confirmation_required || result.stop_reason === "awaiting_approval";
        const nextStatus = statusFor(result.stop_reason, needsApproval);
        return {
          id: result.session_id || session.id,
          messages,
          pendingText: undefined,
          status: nextStatus,
          progressMessage: undefined,
          progressUntil: undefined,
          approvalPending: needsApproval,
          approvalType: needsApproval ? "plan" : undefined,
          approvalDescription: needsApproval ? "Review and approve the plan to let the agent make changes." : undefined,
          pendingQuestions: null,
          plan: needsApproval ? planFromText(result.final_output) : session.plan,
          durationMs: Date.now() - session.createdAt,
          updatedAt: Date.now(),
          usage: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens, totalTokens: result.usage.total_tokens },
          contextSummary: result.context_summary || session.contextSummary,
          error: nextStatus === "failed" ? result.final_output : undefined
        };
      });
      const updated = get().sessions.find((session) => session.id === sessionId);
      if (updated && updated.status !== "running" && updated.status !== "waiting") {
        const entry: HistoryEntry = { id: updated.id, title: updated.title, status: updated.status, durationMs: updated.durationMs, date: Date.now() };
        set((state) => ({ history: [entry, ...state.history.filter((item) => item.id !== entry.id)] }));
      }
    }
  };

  const pollRun = async (sessionId: string, fromId = -1): Promise<void> => {
    // A 409 recovery can race with an existing event poll. Keep one consumer
    // per session so events are not applied twice and polling stays predictable.
    if (pollingSessions.has(sessionId)) return;
    pollingSessions.add(sessionId);
    let after = fromId;
    let active = true;
    const startedAt = Date.now();
    // Hung events() previously left status=running forever, which disables
    // the send box (PromptArea shows Stop, Send never returns).
    const POLL_TIMEOUT_MS = 10 * 60_000;
    let idleRounds = 0;
    try {
      while (active) {
        if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
          patchSession(sessionId, () => ({ status: "failed", error: "Agent poll timed out after 10 minutes. Press Stop/New task and retry.", progressMessage: undefined, pendingText: undefined }));
          notify("error", "Agent timed out", "No events for 10 minutes. The run was marked failed so you can type again.");
          // Unblock the backend too. Otherwise its worker can remain marked
          // running after the renderer gives up, and the next turn gets a 409.
          void window.api.agent.stop(sessionId).catch((err) => {
            notify("error", "Could not stop timed-out agent", err instanceof Error ? err.message : String(err));
          });
          break;
        }
        try {
          const result = await window.api.agent.events(sessionId, after);
          if (!result.events.length) idleRounds += 1;
          else idleRounds = 0;
          for (const event of result.events) {
            after = Math.max(after, event.id);
            consume(sessionId, event);
          }
          active = result.running;
          // Backend says done but status never flipped (missed completed
          // frame): unblock the composer rather than staying running.
          if (!active) {
            const s = get().sessions.find((x) => x.id === sessionId);
            if (s && (s.status === "running" || s.status === "waiting") && !s.approvalPending) {
              patchSession(sessionId, () => ({ status: "completed", progressMessage: undefined, pendingText: undefined }));
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          patchSession(sessionId, () => ({ status: "failed", error: message, progressMessage: undefined, pendingText: undefined }));
          notify("error", "Agent connection lost", message);
          active = false;
        }
        if (active) await new Promise((resolve) => window.setTimeout(resolve, 300));
      }
    } finally {
      pollingSessions.delete(sessionId);
    }
  };

  return {
    open: false,
    setOpen: (open) => set({ open }),
    sessions: [],
    activeSessionId: null,
    activeSession: () => get().sessions.find((session) => session.id === get().activeSessionId) ?? null,
    newTask: () => set({ activeSessionId: null, draft: "" }),
    mode: "code",
    setMode: (mode) => set({ mode }),
    draft: "",
    setDraft: (draft) => set({ draft }),
    notifications: [],
    dismissNotification: (id) => set((state) => ({ notifications: state.notifications.filter((item) => item.id !== id) })),
    history: [],
    sidebarOpen: true,
    setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
    providers: [],
    selectedProvider: "",
    setSelectedProvider: (selectedProvider) => set({ selectedProvider }),
    refreshProviders: async () => {
      try {
        const providers = await window.api.agent.providers();
        set({ providers });
        if (!get().selectedProvider && providers.length) set({ selectedProvider: providers[0].name });
      } catch (err) {
        notify("error", "Provider settings unavailable", err instanceof Error ? err.message : String(err));
      }
    },
    saveProvider: async (provider) => {
      const result = await window.api.agent.saveProvider(provider);
      if (result.success) {
        await get().refreshProviders();
        set({ selectedProvider: provider.name });
      }
      return result;
    },
    loadSessions: async () => {
      const root = workspaceRoot();
      setWorkspaceScope(root);
      if (!root || !window.api?.agent) return;
      const requestId = ++historyRequest;
      const requestedScope = scopeFor(root);
      try {
        const rows = await window.api.agent.sessions(root);
        if (requestId !== historyRequest || requestedScope !== scopeFor(workspaceRoot())) return;
        const history = rows.map((row) => ({
          id: String(row.session_id),
          title: String(row.last_user_message || "Agent session"),
          status: ((row.execution_state as Record<string, unknown> | null)?.phase === "awaiting_approval" ? "waiting" : "completed") as HistoryEntry["status"],
          durationMs: 0,
          date: Date.parse(String(row.updated_at ?? "")) || Date.now()
        }));
        set({ history });
      } catch (err) {
        if (requestId !== historyRequest || requestedScope !== scopeFor(workspaceRoot())) return;
        notify("error", "Could not load agent sessions", err instanceof Error ? err.message : String(err));
      }
    },
    setWorkspaceScope,
    openSession: async (sessionId) => {
      const root = workspaceRoot();
      if (!root) return;
      const requestedScope = scopeFor(root);
      try {
        const record = await window.api.agent.session(root, sessionId);
        if (requestedScope !== scopeFor(workspaceRoot())) return;
        const session = toSession(record, root);
        set((state) => ({ sessions: [...state.sessions.filter((item) => item.id !== session.id), session], activeSessionId: session.id }));
      } catch (err) {
        notify("error", "Could not open agent session", err instanceof Error ? err.message : String(err));
      }
    },
    sendMessage: (text, mode) => {
      const prompt = text.trim();
      const root = workspaceRoot();
      if (!prompt) return;
      if (!root) {
        notify("warning", "Open a project first", "Choose a workspace before asking Xvie Agent to inspect or change files.");
        return;
      }
      const currentId = get().activeSessionId;
      const existing = currentId ? get().sessions.find((session) => session.id === currentId) : undefined;
      const sessionId = existing?.id ?? uid("session");
      const userMessage: Message = { id: uid("message"), role: "user", content: prompt, status: "done", timestamp: Date.now(), fileRefs: [] };
      const session: AgentSession = existing
        ? { ...existing, status: "running", pendingText: undefined, messages: [...existing.messages, userMessage], updatedAt: Date.now(), error: undefined }
        : {
            id: sessionId, title: prompt.length > 48 ? `${prompt.slice(0, 48)}…` : prompt,
            prompt, createdAt: Date.now(), updatedAt: Date.now(), durationMs: 0, status: "running",
            messages: [userMessage], stages: [], agents: [], activity: [], tools: [], context: { ...EMPTY_CONTEXT, project: root.split(/[\\/]/).pop() || "workspace" }, plan: null
          };
      set((state) => ({ sessions: [...state.sessions.filter((item) => item.id !== sessionId), session], activeSessionId: sessionId }));
      void (async () => {
        try {
          const response = await window.api.agent.run({
            prompt, workspaceRoot: root, sessionId: existing ? sessionId : undefined,
            mode, providerName: get().selectedProvider || undefined
          });
          if (response.session_id !== sessionId) {
            patchSession(sessionId, () => ({ id: response.session_id }));
            set((state) => ({ activeSessionId: state.activeSessionId === sessionId ? response.session_id : state.activeSessionId }));
          }
          void pollRun(response.session_id);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (existing && /this session is already running/i.test(message)) {
            // The backend still owns this session's run (for example after the
            // renderer was reloaded). Recover its event stream instead of
            // marking the session failed. The attempted follow-up was rejected,
            // so remove only the optimistic message added for that attempt.
            patchSession(sessionId, (current) => ({
              status: "running",
              error: undefined,
              messages: current.messages.filter((item) => item.id !== userMessage.id)
            }));
            void pollRun(sessionId, -1);
            return;
          }
          patchSession(sessionId, () => ({ status: "failed", error: message }));
          notify("error", "Could not start Xvie Agent", message);
        }
      })();
    },
    stopTask: () => {
      const session = get().activeSession();
      if (session?.status === "running" || session?.status === "waiting") {
        if (session.status === "waiting" && session.approvalType === "plan") {
          get().rejectPlan();
          return;
        }
        // Optimistically unblock the composer: a hung stop() IPC previously
        // left isRunning=true forever so nothing could be typed/sent.
        const sessionId = session.id;
        patchSession(sessionId, () => ({ status: "stopped", approvalPending: false, approvalType: undefined, approvalDescription: undefined, progressMessage: undefined, pendingText: undefined }));
        const scope = session.loadedFromDisk ? workspaceRoot() : undefined;
        void (scope ? window.api.agent.stop(sessionId, scope) : window.api.agent.stop(sessionId))
          .then((result) => {
            if (!result.success) notify("error", "Could not stop agent", result.error ?? "Unknown error");
          })
          .catch((err) => notify("error", "Could not stop agent", err instanceof Error ? err.message : String(err)));
      }
    },
    resetStuck: () => {
      const session = get().activeSession();
      if (session && (session.status === "running" || session.status === "waiting")) {
        patchSession(session.id, () => ({ status: "stopped", approvalPending: false, approvalType: undefined, approvalDescription: undefined, progressMessage: undefined, pendingText: undefined, error: undefined }));
      }
    },
    approvePlan: () => {
      const session = get().activeSession();
      if (!session) return;
      const restartRun = session.approvalType === "plan";
      patchSession(session.id, () => ({ status: "running", approvalPending: false, approvalType: undefined, approvalDescription: undefined, error: undefined }));
      void (async () => {
        try {
          const scope = session.loadedFromDisk ? workspaceRoot() : undefined;
          const result = await (scope ? window.api.agent.approve(session.id, scope) : window.api.agent.approve(session.id));
          if (!result.success) throw new Error(result.error ?? "Unknown approval error.");
          if (restartRun) void pollRun(session.id, -1);
        } catch (err) {
          patchSession(session.id, () => ({ status: "waiting", approvalPending: true, approvalType: session.approvalType ?? "plan", approvalDescription: session.approvalDescription }));
          notify("error", "Approval failed", err instanceof Error ? err.message : String(err));
        }
      })();
    },
    rejectPlan: () => {
      const session = get().activeSession();
      if (!session) return;
      const scope = session.loadedFromDisk ? workspaceRoot() : undefined;
      void (scope ? window.api.agent.reject(session.id, scope) : window.api.agent.reject(session.id))
        .then((result) => {
          if (!result.success) { notify("error", "Could not reject approval", result.error ?? "Unknown error"); return; }
          const declinedTool = session.approvalType === "tool";
          patchSession(session.id, () => ({ status: declinedTool ? "running" : "stopped", approvalPending: false, approvalType: undefined, approvalDescription: undefined }));
        })
        .catch((err) => notify("error", "Could not reject approval", err instanceof Error ? err.message : String(err)));
    },
    answerQuestions: (answers) => {
      const session = get().activeSession();
      if (!session || !session.pendingQuestions?.length) return;
      patchSession(session.id, () => ({ status: "running", pendingQuestions: null, questionsAnswered: true, progressMessage: "Continuing with your answers" }));
      void (async () => {
        try {
          const result = await window.api.agent.answerQuestions(session.id, answers);
          if (!result.success) throw new Error(result.error ?? "Unknown answer error.");
        } catch (err) {
          patchSession(session.id, () => ({ status: "waiting" }));
          notify("error", "Could not send answers", err instanceof Error ? err.message : String(err));
        }
      })();
    },
    continuePlan: () => {
      const session = get().activeSession();
      if (!session) return;
      // Clickable continue: approves a waiting plan, otherwise sends a follow-up.
      if (session.approvalPending && session.approvalType === "plan") {
        get().approvePlan();
        return;
      }
      get().sendMessage("Continue with the plan.", get().mode);
    }
  };
});
