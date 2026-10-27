export interface GitHubRepoOwner {
  login: string;
  avatar_url: string;
  html_url: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  clone_url: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  default_branch: string;
  topics: string[];
  owner: GitHubRepoOwner;
  updated_at: string;
  pushed_at: string;
  homepage?: string | null;
  private?: boolean;
}

export interface GitHubUser {
  login: string;
  name: string | null;
  avatar_url: string;
  html_url: string;
  public_repos: number;
}

export interface GitHubSearchResult {
  total_count: number;
  items: GitHubRepo[];
}

export interface GitHubReadmeResult {
  html: string | null;
  error: string | null;
}

export type ClonePhase = "starting" | "progress" | "done" | "error";

export interface CloneProgress {
  repo: string;
  phase: ClonePhase;
  message?: string;
  destination?: string;
}

export type CloneResult =
  | { canceled: true }
  | { canceled?: false; success: true; destination: string }
  | { canceled?: false; success: false; error: string };

export interface SearchResult {
  items: GitHubRepo[];
  totalCount: number;
}

export interface GithubBridge {
  search: (query: string, page?: number) => Promise<SearchResult>;
  readme: (owner: string, repo: string) => Promise<GitHubReadmeResult>;
  clone: (url: string) => Promise<CloneResult>;
  authStatus: () => Promise<{ user: GitHubUser | null; configured?: boolean; error?: string }>;
  authConfig: () => Promise<{ configured: boolean }>;
  connectToken: (token: string) => Promise<{ success: boolean; user?: GitHubUser; error?: string }>;
  startSignIn: () => Promise<{ success: boolean; userCode?: string; verificationUri?: string; error?: string }>;
  pollSignIn: () => Promise<{ success: boolean; pending?: boolean; user?: GitHubUser; error?: string }>;
  signOut: () => Promise<{ success: boolean }>;
  repositories: (page?: number) => Promise<{ items: GitHubRepo[]; totalCount: number; hasMore: boolean }>;
  createRepository: (name: string, description: string, isPrivate: boolean) => Promise<GitHubRepo>;
  setRepositoryDefault: (owner: string, repo: string, branch: string) => Promise<{ success: boolean; error?: string }>;
  previewImage: (repo: GitHubRepo) => Promise<string | null>;
  previewImages: (repos: GitHubRepo[]) => Promise<Record<string, string | null>>;
  onCloneProgress: (callback: (progress: CloneProgress) => void) => () => void;
}

export interface GitFileChange {
  path: string;
  status: string;
}

export interface GitCommit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  date: string;
  message: string;
  refs: string[];
  files: string[];
  fileChanges: Array<{ path: string; status: "added" | "deleted" | "modified"; insertions: number; deletions: number; binary: boolean }>;
  insertions: number;
  deletions: number;
}

export interface GitStatus {
  initialized: boolean;
  branch: string;
  remote: string | null;
  changes: GitFileChange[];
}

export interface GitBridge {
  status: (path: string) => Promise<GitStatus>;
  history: (path: string) => Promise<GitCommit[]>;
  branches: (path: string) => Promise<{ current: string; branches: string[] }>;
  initialize: (path: string, name: string, email: string) => Promise<{ success: boolean; error?: string }>;
  commit: (path: string, message: string) => Promise<{ success: boolean; error?: string }>;
  createBranch: (path: string, name: string) => Promise<{ success: boolean; error?: string }>;
  switchBranch: (path: string, name: string) => Promise<{ success: boolean; error?: string }>;
  setRemote: (path: string, url: string) => Promise<{ success: boolean; error?: string }>;
  push: (path: string) => Promise<{ success: boolean; error?: string }>;
}

export type FsEntryKind = "file" | "directory";

export interface FsEntry {
  name: string;
  path: string;
  kind: FsEntryKind;
  isSymlink: boolean;
  hidden: boolean;
  size: number;
  modifiedAt: number;
}

export type DirSnapshot = FsEntry[];

export type ReadFileResult =
  | { binary: true; size: number; isSymlink: boolean }
  | { binary: false; content: string; isSymlink: boolean };

export type OpenFolderResult =
  | { canceled: true }
  | { canceled: false; path: string; name: string };

export type FsResult =
  | { success: true }
  | { success: false; error: string };

export interface WorkspaceFileChange {
  path: string;
  content: string;
  expectedHash: string | null;
}

export interface WorkspaceBridge {
  openFolder: () => Promise<OpenFolderResult>;
  openPath: (path: string) => Promise<FsResult>;
  scanDir: (path: string) => Promise<DirSnapshot>;
  readFile: (path: string) => Promise<ReadFileResult | null>;
  readBinary: (path: string) => Promise<Uint8Array | null>;
  writeBinary: (path: string, data: Uint8Array) => Promise<FsResult>;
  openExternal: (path: string) => Promise<FsResult>;
  rename: (from: string, to: string) => Promise<FsResult>;
  createFile: (path: string, content?: string) => Promise<FsResult>;
  applyFileChanges: (changes: WorkspaceFileChange[]) => Promise<FsResult>;
  createFolder: (path: string) => Promise<FsResult>;
  deleteEntry: (path: string) => Promise<FsResult>;
  setRootDev: (path: string) => Promise<FsResult>;
  onChanged: (callback: (path: string) => void) => () => void;
}

export interface TerminalCreateOptions {
  cwd?: string;
  shell?: string;
  args?: string[];
}

export type TerminalCreateResult =
  | { success: true; id: string; shell: string; cwd: string }
  | { success: false; error: string };

export type TerminalWriteResult =
  | { success: true }
  | { success: false; error: string };

export interface TerminalDataEvent {
  id: string;
  data: string;
}

export interface TerminalExitEvent {
  id: string;
  code: number;
}

export interface TerminalBridge {
  create: (options?: TerminalCreateOptions) => Promise<TerminalCreateResult>;
  write: (id: string, data: string) => Promise<TerminalWriteResult>;
  resize: (id: string, cols: number, rows: number) => Promise<TerminalWriteResult>;
  kill: (id: string) => Promise<TerminalWriteResult>;
  onData: (callback: (event: TerminalDataEvent) => void) => () => void;
  onExit: (callback: (event: TerminalExitEvent) => void) => () => void;
}

export interface AppBridge {
  /** Sync the OS window chrome (title bar, taskbar icon) with the app theme. */
  setTheme: (mode: "light" | "dark") => Promise<{ success: boolean }>;
}

export interface XvieApi {
  platform: string;
  app: AppBridge;
  github: GithubBridge;
  git: GitBridge;
  workspace: WorkspaceBridge;
  browser: BrowserBridge;
  agent: AgentBridge;
  terminal: TerminalBridge;
}

export type BrowserSiteId =
  | "chatgpt"
  | "claude"
  | "gemini"
  | "deepseek"
  | "grok"
  | "qwen"
  | "perplexity";

export interface BrowserSiteInfo {
  id: BrowserSiteId;
  label: string;
  url: string;
  domains: string[];
}

export interface BrowserStatus {
  ok: boolean;
  sidecar: boolean;
  cdp_reachable: boolean;
  chrome_visible: boolean;
  chrome_managed: boolean;
  chrome_executable: string | null;
  open_tabs: string[];
  error?: string;
}

export interface BrowserMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
}

export interface BrowserConversation {
  id: string;
  site: BrowserSiteId;
  title: string;
  remote_url: string;
  created_at?: string;
  updated_at?: string;
}

export type BrowserConversationResult = BrowserConversation | { error: string };

export type BrowserAskResult =
  | { success: true; answer: string; images?: string[]; conversation_id?: string }
  | { success: false; error: string; needsLogin?: boolean };

export type BrowserRunTaskResult =
  | { success: true; answer: string; turns: number; tool_calls: Array<{ tool: string; args: Record<string, unknown>; id: string }>; changed_files: string[]; stop_reason: string; verification_outcome?: string | null }
  | { success: false; error: string; needsLogin?: boolean };

export type BrowserStreamEvent =
  | { streamId: string; type: "partial"; text: string }
  | { streamId: string; type: "done"; answer: string; images: string[] }
  | { streamId: string; type: "error"; error: string; needsLogin?: boolean };

export interface BrowserBridge {
  startSidecar: () => Promise<{ success: boolean; error?: string }>;
  sites: () => Promise<BrowserSiteInfo[]>;
  status: () => Promise<BrowserStatus>;
  /** true shows and false hides the window; omitted preserves visibility. */
  ensureChrome: (visible?: boolean) => Promise<{ success: boolean; error?: string }>;
  /** Explicit recovery action; closes Xvie-managed provider tabs and keeps the profile. */
  restartChrome: (visible?: boolean) => Promise<{ success: boolean; error?: string }>;
  history: (site: BrowserSiteId, conversationId?: string) => Promise<BrowserMessage[]>;
  conversations: (site: BrowserSiteId) => Promise<BrowserConversation[]>;
  deleteConversation: (site: BrowserSiteId, conversationId: string) => Promise<{ success: boolean; error?: string }>;
  newConversation: (site: BrowserSiteId) => Promise<BrowserConversationResult>;
  openConversation: (site: BrowserSiteId, conversationId: string) => Promise<BrowserConversationResult>;
  ask: (
    site: BrowserSiteId,
    query: string,
    filePaths?: string[],
    conversationId?: string
  ) => Promise<BrowserAskResult>;
  loginStatus: (
    site: BrowserSiteId,
    create?: boolean,
    launch?: boolean
  ) => Promise<{ logged_in: boolean | null; chrome_up: boolean }>;
  askStream: (
    streamId: string,
    site: BrowserSiteId,
    query: string,
    filePaths?: string[],
    conversationId?: string
  ) => Promise<{ accepted: boolean; error?: string }>;
  onStream: (callback: (event: BrowserStreamEvent) => void) => () => void;
  modes?: () => Promise<{ default?: string; modes?: Record<string, unknown> }>;
  runTask: (
    site: BrowserSiteId,
    task: string,
    workspaceRoot: string,
    maxTurns?: number,
    conversationId?: string,
    mode?: string
  ) => Promise<BrowserRunTaskResult>;
}

export interface AgentProviderProfile {
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  configured?: boolean;
}

export interface AgentRunRequest {
  prompt: string;
  workspaceRoot: string;
  sessionId?: string;
  mode: "plan" | "ask" | "code" | "debug" | "brainstorm";
  providerName?: string;
  model?: string;
  maxTurns?: number;
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

export interface AgentEventEnvelope {
  id: number;
  type: "activity" | "approval_required" | "completed" | "failed" | "stopping" | "approval_rejected" | "approval_denied" | "question_required" | "questions_answered";
  questions?: AgentQuestion[];
  answers?: AgentQuestionAnswer[];
  event?: { kind: string; message: string; data?: Record<string, unknown> };
  result?: {
    session_id: string;
    final_output: string;
    stop_reason: string;
    turns: number;
    tool_calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    usage: { input_tokens: number; output_tokens: number; total_tokens: number };
    confirmation_required: boolean;
    verification_outcome?: string | null;
    context_summary?: string;
    visible_thoughts?: Array<{ text: string; timestamp: string; duration_ms?: number }>;
  };
  description?: string;
  session_id?: string;
  error?: string;
}

export interface AgentBridge {
  providers: () => Promise<AgentProviderProfile[]>;
  saveProvider: (provider: AgentProviderProfile) => Promise<{ success: boolean; error?: string }>;
  run: (request: AgentRunRequest) => Promise<{ session_id: string }>;
  events: (sessionId: string, after: number) => Promise<{ events: AgentEventEnvelope[]; running: boolean }>;
  approve: (sessionId: string, workspaceRoot?: string | null) => Promise<{ success: boolean; error?: string }>;
  reject: (sessionId: string, workspaceRoot?: string | null) => Promise<{ success: boolean; error?: string }>;
  stop: (sessionId: string, workspaceRoot?: string | null) => Promise<{ success: boolean; error?: string }>;
  answerQuestions: (sessionId: string, answers: AgentQuestionAnswer[]) => Promise<{ success: boolean; error?: string }>;
  sessions: (workspaceRoot: string) => Promise<Array<Record<string, unknown>>>;
  session: (workspaceRoot: string, sessionId: string) => Promise<Record<string, unknown>>;
  searchImages: (query: string, perPage?: number) => Promise<{ results: Array<{ alt: string; heroUrl: string; thumbnailUrl: string; sourceUrl: string; photographer: string; license: string; credit: string; width: number; height: number }> }>;
}
