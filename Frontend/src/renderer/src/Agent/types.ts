export type AgentRoleId =
  | "planner"
  | "research"
  | "context"
  | "generator"
  | "architecture"
  | "review"
  | "debug"
  | "verification"
  | "documentation"
  | "terminal";

export type AgentStatus = "idle" | "thinking" | "working" | "waiting" | "done" | "failed";

export type AgentMode = "plan" | "ask" | "code" | "debug" | "brainstorm";

export interface AgentDef {
  id: AgentRoleId;
  name: string;
  role: string;
  color: string;
}

export interface ActiveAgent {
  id: AgentRoleId;
  status: AgentStatus;
  currentTask: string;
  progress: number;
  startedAt: number;
  elapsedMs: number;
}

export type StageStatus = "pending" | "active" | "completed" | "failed";

export interface TimelineStage {
  id: string;
  label: string;
  status: StageStatus;
  progress: number;
  startedAt?: number;
  endedAt?: number;
  subSteps: string[];
  expanded: boolean;
}

export type ActivityKind = "think" | "read" | "write" | "update" | "run" | "search" | "index" | "verify" | "git";

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  target: string;
  tool?: string;
  detail?: string;
  status: "running" | "completed" | "failed";
  timestamp: number;
  /** Diff stats for file-write activity (rendered as +N −N). */
  additions?: number;
  deletions?: number;
  diff?: string;
  durationMs?: number;
}

export type ToolStatus = "idle" | "running" | "completed" | "failed";

export interface ToolState {
  id: string;
  name: string;
  status: ToolStatus;
  currentAction?: string;
}

export interface ContextStats {
  repo: string;
  project: string;
  filesLoaded: number;
  symbolsIndexed: number;
  openEditors: number;
  selectedContext: string;
  memoryUsage: number;
  contextSize: number;
  contextBudget: number;
}

export type NotificationKind = "info" | "success" | "warning" | "error" | "agent";

export interface AgentNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  message: string;
  timestamp: number;
  read: boolean;
}

export type MessageRole = "user" | "assistant" | "system";

export type MessageStatus = "streaming" | "done" | "incomplete" | "stopped" | "failed";

export interface MessageFileRef {
  path: string;
  label: string;
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  timestamp: number;
  fileRefs: MessageFileRef[];
}

export interface PlanStep {
  id: string;
  label: string;
  done: boolean;
}

export interface PlanSummary {
  goal: string;
  currentObjective: string;
  steps: PlanStep[];
  risks: string[];
  dependencies: string[];
  complexity: "Low" | "Medium" | "High";
}

export interface AgentQuestionOption {
  label: string;
  description?: string;
}

export interface AgentQuestion {
  id: string;
  question: string;
  header?: string;
  options: AgentQuestionOption[];
  allow_custom?: boolean;
}

export interface AgentQuestionAnswer {
  id: string;
  selected: string[];
  custom_text: string;
}

export type SessionStatus = "running" | "waiting" | "completed" | "incomplete" | "stopped" | "failed";

export interface AgentSession {
  id: string;
  loadedFromDisk?: boolean;
  title: string;
  prompt: string;
  createdAt: number;
  updatedAt: number;
  durationMs: number;
  status: SessionStatus;
  messages: Message[];
  stages: TimelineStage[];
  agents: ActiveAgent[];
  activity: ActivityItem[];
  tools: ToolState[];
  context: ContextStats;
  plan: PlanSummary | null;
  approvalPending?: boolean;
  approvalDescription?: string;
  approvalType?: "plan" | "tool";
  pendingQuestions?: AgentQuestion[] | null;
  questionsAnswered?: boolean;
  /** Short user-facing progress label; private model reasoning stays hidden. */
  progressMessage?: string;
  progressUntil?: number;
  /** Model output is buffered until the final answer is ready for display. */
  pendingText?: string;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  contextSummary?: string;
}

export interface HistoryEntry {
  id: string;
  title: string;
  status: SessionStatus;
  durationMs: number;
  date: number;
}
