import { app, ipcMain } from "electron";
import { spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import type {
  BrowserAskResult,
  BrowserMessage,
  BrowserRunTaskResult,
  BrowserSiteId,
  BrowserSiteInfo,
  BrowserStatus
} from "../shared/ipc-types";

const DEFAULT_PORT = 28711;
// CDP port for OUR dedicated chat window. Must not be 9222: Xvie's Electron
// exposes its own CDP on 9222 in dev, and mcp-web-llm defaults to it too.
const EXPECTED_CDP_PORT = process.env["MCP_WEB_LLM_CDP_PORT"] ?? "9333";
const EXPECTED_VERSION = 21;

const FALLBACK_SITES: BrowserSiteInfo[] = [
  { id: "chatgpt", label: "ChatGPT", url: "https://chatgpt.com/", domains: ["chatgpt.com"] },
  { id: "claude", label: "Claude", url: "https://claude.ai/", domains: ["claude.ai"] },
  { id: "gemini", label: "Gemini", url: "https://gemini.google.com/", domains: ["gemini.google.com"] },
  { id: "deepseek", label: "DeepSeek", url: "https://chat.deepseek.com/", domains: ["chat.deepseek.com"] },
  { id: "grok", label: "Grok", url: "https://grok.com/", domains: ["grok.com"] },
  { id: "qwen", label: "Qwen", url: "https://chat.qwen.ai/", domains: ["chat.qwen.ai"] },
  { id: "perplexity", label: "Perplexity", url: "https://www.perplexity.ai/", domains: ["perplexity.ai"] }
];

function sidecarPort(): number {
  const raw = process.env["XVIE_BROWSER_AGENT_PORT"];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
}

function sidecarBase(): string {
  return `http://127.0.0.1:${sidecarPort()}`;
}

/** Locate Backend/browser-agent in dev (Frontend/out/main -> repo root) or packaged builds. */
function resolveSidecarDir(): string | null {
  const candidates = [
    // Packaged build: extraResources backend/browser-agent
    join(process.resourcesPath, "backend", "browser-agent"),
    join(process.resourcesPath, "browser-agent"),
    // Dev: <repo>/Frontend/out/main -> <repo>/Backend/browser-agent
    join(__dirname, "..", "..", "..", "Backend", "browser-agent")
  ];
  for (const dir of candidates) {
    try {
      if (existsSync(join(dir, "app.py"))) return dir;
    } catch {
      // ignore and try next candidate
    }
  }
  return null;
}

function resolvePython(sidecarDir: string): string | null {
  const explicit = process.env["XVIE_BROWSER_AGENT_PYTHON"];
  if (explicit && existsSync(explicit)) return explicit;
  const venvWin = join(sidecarDir, ".venv", "Scripts", "python.exe");
  if (existsSync(venvWin)) return venvWin;
  const venvPosix = join(sidecarDir, ".venv", "bin", "python");
  if (existsSync(venvPosix)) return venvPosix;
  for (const candidate of ["python", "python3", "py"]) {
    return candidate; // resolved via PATH; spawn failure is reported to the user
  }
  return null;
}

let child: ChildProcess | null = null;
let starting: Promise<void> | null = null;

async function readHealth(): Promise<{
  ok: boolean;
  agent?: string;
  version?: number;
  cdp_port?: string;
} | null> {
  try {
    const res = await fetch(`${sidecarBase()}/health`);
    if (!res.ok) return null;
    return (await res.json()) as {
      ok: boolean;
      agent?: string;
      version?: number;
      cdp_port?: string;
    };
  } catch {
    return null;
  }
}

function healthMatches(h: { agent?: string; version?: number; cdp_port?: string } | null): boolean {
  return (
    !!h && h.agent === "xvie-browser-agent" && (h.version ?? 0) >= EXPECTED_VERSION &&
    String(h.cdp_port ?? "") === EXPECTED_CDP_PORT
  );
}

async function waitForHealth(timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (healthMatches(await readHealth())) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function ensureSidecar(): Promise<void> {
  if (child && !child.killed) return Promise.resolve();
  if (starting) return starting;
  starting = (async () => {
    const existing = await readHealth();
    if (healthMatches(existing)) return; // our sidecar is already running
    if (existing?.ok) {
      // Something stale (e.g. an orphan from an older version) squats the
      // port. Ask it to stop if it supports it, then re-check.
      try {
        await fetch(`${sidecarBase()}/shutdown`, { method: "POST" });
      } catch {
        // old versions have no /shutdown — fall through to the error below
      }
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const after = await readHealth();
      if (healthMatches(after)) return;
      if (after?.ok) {
        throw new Error(
          `Port ${sidecarPort()} is occupied by an incompatible browser-agent. ` +
            `Stop the stray "python app.py" process (Task Manager) and press Start again.`
        );
      }
    }
    const dir = resolveSidecarDir();
    if (!dir) {
      throw new Error(
        "Browser-agent backend not found. Expected Backend/browser-agent/app.py."
      );
    }
    const python = resolvePython(dir);
    if (!python) {
      throw new Error(
        "No Python found. Set XVIE_BROWSER_AGENT_PYTHON or create Backend/browser-agent/.venv."
      );
    }
    child = spawn(python, ["app.py"], {
      cwd: dir,
      windowsHide: true,
      env: {
        ...process.env,
        XVIE_BROWSER_AGENT_PORT: String(sidecarPort()),
        MCP_WEB_LLM_CDP_PORT: EXPECTED_CDP_PORT,
        PYTHONIOENCODING: "utf-8"
      }
    });
    child.on("error", () => {
      child = null;
    });
    child.on("exit", () => {
      child = null;
    });
    const healthy = await waitForHealth(25000);
    if (!healthy) {
      throw new Error(
        `Browser-agent sidecar did not start on port ${sidecarPort()}. ` +
          `Run "pip install -r requirements.txt" in Backend/browser-agent and retry.`
      );
    }
  })();
  const done = starting.finally(() => {
    starting = null;
  });
  return done;
}

async function isSidecarAlive(): Promise<boolean> {
  return healthMatches(await readHealth());
}

async function proxyJson<T>(
  path: string,
  init?: RequestInit,
  options: { autoStart?: boolean } = {}
): Promise<T> {
  const { autoStart = false } = options;
  if (autoStart) {
    await ensureSidecar();
  } else if (!(await isSidecarAlive())) {
    throw new Error("Browser-agent backend is not running. Press Start first.");
  }
  const res = await fetch(`${sidecarBase()}${path}`, init);
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    // FastAPI errors are JSON {detail}; surface the real message.
    try {
      const parsed = JSON.parse(raw) as { detail?: string };
      if (parsed?.detail) throw new Error(String(parsed.detail).slice(0, 800));
    } catch (err) {
      if (err instanceof Error && !/JSON/.test(err.message)) throw err;
    }
    throw new Error(raw.slice(0, 500) || `Sidecar responded ${res.status}.`);
  }
  return (await res.json()) as T;
}

export function registerBrowserAgentHandlers(): void {
  ipcMain.handle(
    "browser:start-sidecar",
    async (): Promise<{ success: boolean; error?: string }> => {
      try {
        await ensureSidecar();
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  ipcMain.handle("browser:sites", async (): Promise<BrowserSiteInfo[]> => {
    try {
      const data = await proxyJson<{ sites: BrowserSiteInfo[] }>("/sites");
      return data.sites;
    } catch {
      return FALLBACK_SITES;
    }
  });

  ipcMain.handle("browser:status", async (): Promise<BrowserStatus> => {
    if (!(await isSidecarAlive())) {
      return {
        ok: false,
        sidecar: false,
        cdp_reachable: false,
        chrome_visible: false,
        chrome_managed: false,
        chrome_executable: null,
        open_tabs: []
      };
    }
    try {
      const report = await proxyJson<{
        cdp_reachable: boolean;
        chrome_visible: boolean;
        chrome_managed: boolean;
        chrome_executable: string | null;
        open_tabs: string[];
      }>("/status");
      return {
        ok: true,
        sidecar: true,
        cdp_reachable: report.cdp_reachable,
        chrome_visible: report.chrome_visible ?? false,
        chrome_managed: report.chrome_managed ?? false,
        chrome_executable: report.chrome_executable,
        open_tabs: report.open_tabs ?? []
      };
    } catch (err) {
      return {
        ok: false,
        sidecar: false,
        cdp_reachable: false,
        chrome_visible: false,
        chrome_managed: false,
        chrome_executable: null,
        open_tabs: [],
        error: err instanceof Error ? err.message : String(err)
      };
    }
  });

  ipcMain.handle(
    "browser:ensure-chrome",
    async (
      _event,
      visible?: boolean
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        const result = await proxyJson<{ cdp_reachable?: boolean; error?: string }>(
          "/ensure-chrome",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(visible === undefined ? {} : { visible })
          },
          { autoStart: true }
        );
        if (result.cdp_reachable !== true) {
          return { success: false, error: result.error ?? "Chrome started but its remote debugging connection is not ready. Retry or open the browser window." };
        }
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  ipcMain.handle(
    "browser:restart-chrome",
    async (_event, visible?: boolean): Promise<{ success: boolean; error?: string }> => {
      try {
        const result = await proxyJson<{ cdp_reachable?: boolean; error?: string }>(
          "/restart-chrome",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ visible: visible !== false })
          },
          { autoStart: true }
        );
        if (result.cdp_reachable !== true) {
          return { success: false, error: result.error ?? "Chrome restarted but its debugging connection is not ready. Retry in a moment." };
        }
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  ipcMain.handle(
    "browser:history",
    async (_event, site: BrowserSiteId, conversationId?: string): Promise<BrowserMessage[]> => {
      try {
        const params = new URLSearchParams({ site });
        if (conversationId) params.set("conversation_id", conversationId);
        const data = await proxyJson<{ messages: BrowserMessage[] }>(
          `/history?${params.toString()}`
        );
        return data.messages;
      } catch {
        return [];
      }
    }
  );

  ipcMain.handle("browser:conversations", async (_event, site: BrowserSiteId) => {
    try {
      const data = await proxyJson<{ conversations: Array<Record<string, unknown>> }>(
        `/conversations?site=${encodeURIComponent(site)}`
      );
      return data.conversations;
    } catch {
      return [];
    }
  });

  ipcMain.handle("browser:conversation-new", async (_event, site: BrowserSiteId) => {
    try {
      return await proxyJson<Record<string, unknown>>("/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ site })
      }, { autoStart: true });
    } catch (err) {
      // Resolve IPC with a displayable error so Electron does not emit an
      // unhandled-handler stack trace for expected browser attachment errors.
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("browser:conversation-delete", async (_event, site: BrowserSiteId, conversationId: string) => {
    try {
      await proxyJson(`/conversations/${encodeURIComponent(conversationId)}?site=${encodeURIComponent(site)}`, { method: "DELETE" });
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("browser:conversation-open", async (_event, site: BrowserSiteId, conversationId: string) => {
    try {
      return await proxyJson<Record<string, unknown>>(
        `/conversations/${encodeURIComponent(conversationId)}/open?site=${encodeURIComponent(site)}`,
        { method: "POST" }
      );
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(
    "browser:ask",
    async (
      _event,
      site: BrowserSiteId,
      query: string,
      filePaths?: string[],
      conversationId?: string
    ): Promise<BrowserAskResult> => {
      try {
        const data = await proxyJson<{ answer: string; images?: string[]; conversation_id?: string }>(
          "/ask",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              site, query, file_paths: filePaths ?? [], conversation_id: conversationId
            })
          },
          { autoStart: true }
        );
        return { success: true, answer: data.answer, images: data.images ?? [], conversation_id: data.conversation_id };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const needsLogin =
          /NOT_LOGGED_IN|log in/i.test(message) || message.includes("401");
        return { success: false, error: message, needsLogin };
      }
    }
  );

  ipcMain.handle("browser:modes", async (): Promise<{ default?: string; modes?: Record<string, unknown> }> => {
    try {
      return await proxyJson<{ default?: string; modes?: Record<string, unknown> }>("/modes", undefined, { autoStart: true });
    } catch {
      return {};
    }
  });

  ipcMain.handle(
    "browser:run-task",
    async (
      _event,
      site: BrowserSiteId,
      task: string,
      workspaceRoot: string,
      maxTurns?: number,
      conversationId?: string,
      mode?: string
    ): Promise<BrowserRunTaskResult> => {
      try {
        const data = await proxyJson<{
          answer: string; turns: number;
          tool_calls: Array<{ tool: string; args: Record<string, unknown>; id: string }>;
          changed_files?: string[]; stop_reason: string; verification_outcome?: string | null;
        }>(
          "/run-task",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              site, task, workspace_root: workspaceRoot,
              max_turns: maxTurns ?? 8, conversation_id: conversationId,
              mode: mode ?? "code"
            })
          },
          { autoStart: true }
        );
        return {
          success: true, answer: data.answer, turns: data.turns,
          tool_calls: data.tool_calls ?? [], changed_files: data.changed_files ?? [],
          stop_reason: data.stop_reason, verification_outcome: data.verification_outcome ?? null
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const needsLogin =
          /NOT_LOGGED_IN|log in/i.test(message) || message.includes("401");
        return { success: false, error: message, needsLogin };
      }
    }
  );

  ipcMain.handle(
    "browser:login-status",
    async (
      _event,
      site: BrowserSiteId,
      create?: boolean,
      launch?: boolean
    ): Promise<{ logged_in: boolean | null; chrome_up: boolean }> => {
      try {
        const params = new URLSearchParams({ site });
        if (create) params.set("create", "true");
        if (launch) params.set("launch", "true");
        const data = await proxyJson<{ logged_in: boolean | null; chrome_up: boolean }>(
          `/login-status?${params.toString()}`,
          undefined,
          { autoStart: true }
        );
        return { logged_in: data.logged_in, chrome_up: data.chrome_up };
      } catch {
        return { logged_in: null, chrome_up: false };
      }
    }
  );

  // Fire-and-forget SSE relay: the renderer starts a stream with an id, then
  // receives "browser:stream" events until done/error. Live partial text is
  // what makes replies feel fast.
  ipcMain.handle(
    "browser:ask-stream",
    async (
      event,
      streamId: string,
      site: BrowserSiteId,
      query: string,
      filePaths?: string[],
      conversationId?: string
    ): Promise<{ accepted: boolean; error?: string }> => {
      try {
        await ensureSidecar();
      } catch (err) {
        return { accepted: false, error: err instanceof Error ? err.message : String(err) };
      }
      const sender = event.sender;
      const post = (payload: unknown): void => {
        if (!sender.isDestroyed()) sender.send("browser:stream", payload);
      };
      void (async () => {
        try {
          const res = await fetch(`${sidecarBase()}/ask/stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ site, query, file_paths: filePaths ?? [], conversation_id: conversationId })
          });
          if (!res.ok || !res.body) {
            const raw = await res.text().catch(() => "");
            let message = raw.slice(0, 500) || `Sidecar responded ${res.status}.`;
            try {
              const parsed = JSON.parse(raw) as { detail?: string };
              if (parsed?.detail) message = String(parsed.detail).slice(0, 800);
            } catch {
              // keep raw message
            }
            post({ streamId, type: "error", error: message });
            return;
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          const flush = (chunk: string): void => {
            buffer += chunk;
            let idx = buffer.indexOf("\n\n");
            while (idx >= 0) {
              const frame = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              for (const line of frame.split("\n")) {
                if (!line.startsWith("data:")) continue;
                try {
                  const data = JSON.parse(line.slice(5).trim()) as {
                    partial?: string;
                    done?: boolean;
                    answer?: string;
                    images?: string[];
                    error?: string;
                    needs_login?: boolean;
                  };
                  if (typeof data.partial === "string") {
                    post({ streamId, type: "partial", text: data.partial });
                  } else if (data.done) {
                    post({
                      streamId,
                      type: "done",
                      answer: data.answer ?? "",
                      images: data.images ?? []
                    });
                  } else if (data.error) {
                    const needsLogin =
                      !!data.needs_login || /NOT_LOGGED_IN|log in/i.test(data.error);
                    post({ streamId, type: "error", error: data.error, needsLogin });
                  }
                } catch {
                  // ignore malformed frame
                }
              }
              idx = buffer.indexOf("\n\n");
            }
          };
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            flush(decoder.decode(value, { stream: true }));
          }
          flush(decoder.decode());
        } catch (err) {
          post({
            streamId,
            type: "error",
            error: err instanceof Error ? err.message : String(err)
          });
        }
      })();
      return { accepted: true };
    }
  );

  app.on("before-quit", () => {
    try {
      child?.kill();
    } catch {
      // best effort
    }
    child = null;
  });
}
