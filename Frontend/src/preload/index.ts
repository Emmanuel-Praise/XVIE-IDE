import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  AppBridge,
  BrowserBridge,
  BrowserSiteId,
  BrowserStreamEvent,
  AgentBridge,
  CloneProgress,
  GithubBridge,
  GitBridge,
  TerminalBridge,
  TerminalCreateOptions,
  TerminalDataEvent,
  TerminalExitEvent,
  WorkspaceBridge,
  WorkspaceFileChange,
  XvieApi
} from "../shared/ipc-types";

const app: AppBridge = {
  setTheme: (mode: "light" | "dark") => ipcRenderer.invoke("app:set-theme", mode)
};

const github: GithubBridge = {
  search: (query: string, page = 1) =>
    ipcRenderer.invoke("github:search", query, page),
  readme: (owner: string, repo: string) =>
    ipcRenderer.invoke("github:readme", owner, repo),
  clone: (url: string) => ipcRenderer.invoke("github:clone", url),
  authStatus: () => ipcRenderer.invoke("github:auth-status"),
  authConfig: () => ipcRenderer.invoke("github:auth-config"),
  connectToken: (token: string) => ipcRenderer.invoke("github:connect-token", token),
  startSignIn: () => ipcRenderer.invoke("github:auth-start"),
  pollSignIn: () => ipcRenderer.invoke("github:auth-poll"),
  signOut: () => ipcRenderer.invoke("github:sign-out"),
  repositories: (page = 1) => ipcRenderer.invoke("github:repositories", page),
  createRepository: (name: string, description: string, isPrivate: boolean) =>
    ipcRenderer.invoke("github:create-repository", name, description, isPrivate),
  setRepositoryDefault: (owner: string, repo: string, branch: string) =>
    ipcRenderer.invoke("github:set-default-branch", owner, repo, branch),
  previewImage: (repo) => ipcRenderer.invoke("github:preview-image", repo),
  previewImages: (repos) => ipcRenderer.invoke("github:preview-images", repos),
  onCloneProgress: (callback: (progress: CloneProgress) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, progress: CloneProgress): void => {
      callback(progress);
    };
    ipcRenderer.on("github:clone-progress", listener);
    return () => {
      ipcRenderer.removeListener("github:clone-progress", listener);
    };
  }
};

const git: GitBridge = {
  status: (path) => ipcRenderer.invoke("git:status", path),
  history: (path) => ipcRenderer.invoke("git:history", path),
  branches: (path) => ipcRenderer.invoke("git:branches", path),
  initialize: (path, name, email) => ipcRenderer.invoke("git:initialize", path, name, email),
  commit: (path, message) => ipcRenderer.invoke("git:commit", path, message),
  createBranch: (path, name) => ipcRenderer.invoke("git:create-branch", path, name),
  switchBranch: (path, name) => ipcRenderer.invoke("git:switch-branch", path, name),
  setRemote: (path, url) => ipcRenderer.invoke("git:set-remote", path, url),
  push: (path) => ipcRenderer.invoke("git:push", path)
};

const workspace: WorkspaceBridge = {
  openFolder: () => ipcRenderer.invoke("workspace:open-folder"),
  openPath: (path: string) => ipcRenderer.invoke("workspace:open-path", path),
  scanDir: (path: string) => ipcRenderer.invoke("workspace:scan-dir", path),
  readFile: (path: string) => ipcRenderer.invoke("workspace:read-file", path),
  readBinary: (path: string) => ipcRenderer.invoke("workspace:read-binary", path),
  writeBinary: (path: string, data: Uint8Array) =>
    ipcRenderer.invoke("workspace:write-binary", path, data),
  openExternal: (path: string) => ipcRenderer.invoke("workspace:open-external", path),
  rename: (from: string, to: string) => ipcRenderer.invoke("workspace:rename", from, to),
  createFile: (path: string, content?: string) =>
    ipcRenderer.invoke("workspace:create-file", path, content),
  applyFileChanges: (changes: WorkspaceFileChange[]) => ipcRenderer.invoke("workspace:apply-file-changes", changes),
  createFolder: (path: string) => ipcRenderer.invoke("workspace:create-folder", path),
  deleteEntry: (path: string) => ipcRenderer.invoke("workspace:delete", path),
  setRootDev: (path: string) => ipcRenderer.invoke("workspace:set-root-dev", path),
  onChanged: (callback: (path: string) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, path: string): void => {
      callback(path);
    };
    ipcRenderer.on("workspace:changed", listener);
    return () => {
      ipcRenderer.removeListener("workspace:changed", listener);
    };
  }
};

const browser: BrowserBridge = {
  startSidecar: () => ipcRenderer.invoke("browser:start-sidecar"),
  sites: () => ipcRenderer.invoke("browser:sites"),
  status: () => ipcRenderer.invoke("browser:status"),
  ensureChrome: (visible?: boolean) => ipcRenderer.invoke("browser:ensure-chrome", visible),
  restartChrome: (visible?: boolean) => ipcRenderer.invoke("browser:restart-chrome", visible),
  history: (site: BrowserSiteId, conversationId?: string) => ipcRenderer.invoke("browser:history", site, conversationId),
  conversations: (site: BrowserSiteId) => ipcRenderer.invoke("browser:conversations", site),
  deleteConversation: (site: BrowserSiteId, conversationId: string) => ipcRenderer.invoke("browser:conversation-delete", site, conversationId),
  newConversation: (site: BrowserSiteId) => ipcRenderer.invoke("browser:conversation-new", site),
  openConversation: (site: BrowserSiteId, conversationId: string) =>
    ipcRenderer.invoke("browser:conversation-open", site, conversationId),
  ask: (site: BrowserSiteId, query: string, filePaths?: string[], conversationId?: string) =>
    ipcRenderer.invoke("browser:ask", site, query, filePaths, conversationId),
  loginStatus: (site: BrowserSiteId, create?: boolean, launch?: boolean) =>
    ipcRenderer.invoke("browser:login-status", site, create, launch),
  askStream: (streamId: string, site: BrowserSiteId, query: string, filePaths?: string[], conversationId?: string) =>
    ipcRenderer.invoke("browser:ask-stream", streamId, site, query, filePaths, conversationId),
  modes: () => ipcRenderer.invoke("browser:modes"),
  runTask: (site: BrowserSiteId, task: string, workspaceRoot: string, maxTurns?: number, conversationId?: string, mode?: string) =>
    ipcRenderer.invoke("browser:run-task", site, task, workspaceRoot, maxTurns, conversationId, mode),
  onStream: (callback: (event: BrowserStreamEvent) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: BrowserStreamEvent): void => {
      callback(payload);
    };
    ipcRenderer.on("browser:stream", listener);
    return () => {
      ipcRenderer.removeListener("browser:stream", listener);
    };
  }
};

const agent: AgentBridge = {
  providers: () => ipcRenderer.invoke("agent:providers"),
  saveProvider: (provider) => ipcRenderer.invoke("agent:provider-save", provider),
  run: (request) => ipcRenderer.invoke("agent:run", request),
  events: (sessionId, after) => ipcRenderer.invoke("agent:events", sessionId, after),
  approve: (sessionId, workspaceRoot) => ipcRenderer.invoke("agent:approve", sessionId, workspaceRoot),
  reject: (sessionId, workspaceRoot) => ipcRenderer.invoke("agent:reject", sessionId, workspaceRoot),
  stop: (sessionId, workspaceRoot) => ipcRenderer.invoke("agent:stop", sessionId, workspaceRoot),
  answerQuestions: (sessionId, answers) => ipcRenderer.invoke("agent:answer-questions", sessionId, answers),
  sessions: (workspaceRoot) => ipcRenderer.invoke("agent:sessions", workspaceRoot),
  session: (workspaceRoot, sessionId) => ipcRenderer.invoke("agent:session", workspaceRoot, sessionId),
  searchImages: (query, perPage) => ipcRenderer.invoke("agent:search-images", query, perPage)
};

const terminal: TerminalBridge = {
  create: (options?: TerminalCreateOptions) =>
    ipcRenderer.invoke("terminal:create", options ?? {}),
  write: (id: string, data: string) => ipcRenderer.invoke("terminal:write", id, data),
  resize: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke("terminal:resize", id, cols, rows),
  kill: (id: string) => ipcRenderer.invoke("terminal:kill", id),
  onData: (callback: (event: TerminalDataEvent) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: TerminalDataEvent): void => {
      callback(payload);
    };
    ipcRenderer.on("terminal:data", listener);
    return () => {
      ipcRenderer.removeListener("terminal:data", listener);
    };
  },
  onExit: (callback: (event: TerminalExitEvent) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: TerminalExitEvent): void => {
      callback(payload);
    };
    ipcRenderer.on("terminal:exit", listener);
    return () => {
      ipcRenderer.removeListener("terminal:exit", listener);
    };
  }
};

const api: XvieApi = {
  platform: process.platform,
  app,
  github,
  git,
  workspace,
  browser,
  agent,
  terminal
};

contextBridge.exposeInMainWorld("api", api);

export type Api = XvieApi;
