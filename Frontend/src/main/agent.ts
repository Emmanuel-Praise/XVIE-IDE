import { app, ipcMain, safeStorage } from "electron";
import { randomBytes } from "crypto";
import { existsSync } from "fs";
import { readFile, writeFile, rename, mkdir } from "fs/promises";
import { join } from "path";
import { spawn, type ChildProcess } from "child_process";
import { createServer } from "net";
import type { AgentProviderProfile, AgentRunRequest } from "../shared/ipc-types";

const configuredPort = Number.parseInt(process.env["XVIE_AGENT_PORT"] ?? "", 10);
let servicePort = Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 0;
const CONFIG_FILE = "xvie-agent-providers.bin";
type SavedProfile = Omit<AgentProviderProfile, "apiKey" | "configured"> & { encryptedKey: string };

let child: ChildProcess | null = null;
let starting: Promise<void> | null = null;
let serviceToken = "";

function serviceUrl(): string {
  return `http://127.0.0.1:${servicePort}`;
}

function terminateAgentService(): void {
  const processToStop = child;
  child = null;
  if (!processToStop) return;
  if (process.platform === "win32" && processToStop.pid) {
    const treeStop = spawn("taskkill", ["/pid", String(processToStop.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    });
    treeStop.once("error", () => processToStop.kill());
    return;
  }
  processToStop.kill();
}

async function choosePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("Could not reserve a local port for Xvie Agent.");
  return address.port;
}

function resolveServiceDir(): string | null {
  const candidates = [
    join(process.resourcesPath, "backend", "xvie-agent"),
    join(process.resourcesPath, "xvie-agent"),
    join(__dirname, "..", "..", "..", "Backend", "xvie-agent")
  ];
  return candidates.find((dir) => existsSync(join(dir, "xvie_agent", "service.py"))) ?? null;
}

function resolvePython(dir: string): string {
  const explicit = process.env["XVIE_AGENT_PYTHON"];
  if (explicit && existsSync(explicit)) return explicit;
  const candidates = [join(dir, ".venv", "Scripts", "python.exe"), join(dir, ".venv", "bin", "python")];
  return candidates.find((candidate) => existsSync(candidate)) ?? (process.platform === "win32" ? "python" : "python3");
}

async function readSavedProfiles(): Promise<SavedProfile[]> {
  if (!safeStorage.isEncryptionAvailable()) return [];
  try {
    const encoded = await readFile(join(app.getPath("userData"), CONFIG_FILE), "utf8");
    const plain = safeStorage.decryptString(Buffer.from(encoded, "base64"));
    const parsed = JSON.parse(plain) as SavedProfile[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeSavedProfiles(profiles: SavedProfile[]): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Secure credential storage is unavailable on this system.");
  }
  const dir = app.getPath("userData");
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `${CONFIG_FILE}.tmp`);
  const encrypted = safeStorage.encryptString(JSON.stringify(profiles)).toString("base64");
  await writeFile(temp, encrypted, { encoding: "utf8", mode: 0o600 });
  await rename(temp, join(dir, CONFIG_FILE));
}

async function readHealth(): Promise<boolean> {
  if (!serviceToken) return false;
  try {
    const response = await fetch(`${serviceUrl()}/health`, {
      headers: { Authorization: `Bearer ${serviceToken}` },
      signal: AbortSignal.timeout(1200)
    });
    if (!response.ok) return false;
    const payload = (await response.json()) as { agent?: string; version?: number };
    return payload.agent === "xvie-agent" && (payload.version ?? 0) >= 1;
  } catch {
    return false;
  }
}

async function ensureService(): Promise<void> {
  if (child && !child.killed && await readHealth()) return;
  if (starting) return starting;
  starting = (async () => {
    serviceToken = randomBytes(32).toString("hex");
    if (!servicePort) servicePort = await choosePort();
    const dir = resolveServiceDir();
    if (!dir) throw new Error("Xvie Agent backend was not found in Backend/xvie-agent.");
    const python = resolvePython(dir);
    child = spawn(python, ["-m", "uvicorn", "xvie_agent.service:app", "--host", "127.0.0.1", "--port", String(servicePort)], {
      cwd: dir,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, XVIE_AGENT_TOKEN: serviceToken, PYTHONIOENCODING: "utf-8" }
    });
    child.on("error", () => { child = null; });
    child.on("exit", () => { child = null; });

    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      if (await readHealth()) return;
      if (!child || child.killed) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    child?.kill();
    child = null;
    throw new Error(
      "Xvie Agent backend could not start. Install its requirements with `python -m pip install -e .` in Backend/xvie-agent, then try again."
    );
  })().finally(() => { starting = null; });
  return starting;
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  await ensureService();
  const response = await fetch(`${serviceUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${serviceToken}`,
      "Content-Type": "application/json",
      ...init.headers
    },
    signal: init.signal ?? AbortSignal.timeout(15_000)
  });
  const raw = await response.text();
  if (!response.ok) {
    let message = raw.slice(0, 700) || `Agent service returned ${response.status}.`;
    try { message = JSON.parse(raw).detail ?? message; } catch { /* keep response text */ }
    throw new Error(message);
  }
  return (raw ? JSON.parse(raw) : {}) as T;
}

export function registerAgentHandlers(): void {
  ipcMain.handle("agent:providers", async (): Promise<AgentProviderProfile[]> => {
    const [savedProfiles, environmentProfiles] = await Promise.all([
      readSavedProfiles(),
      requestJson<{ providers: Array<{ name: string; base_url: string; model: string; configured: boolean }> }>("/providers")
        .then((result) => result.providers)
        .catch(() => [])
    ]);
    const profiles = new Map<string, AgentProviderProfile>();
    for (const profile of environmentProfiles) {
      profiles.set(profile.name.toLowerCase(), {
        name: profile.name,
        baseUrl: profile.base_url,
        model: profile.model,
        configured: profile.configured
      });
    }
    for (const { encryptedKey, ...profile } of savedProfiles) {
      profiles.set(profile.name.toLowerCase(), { ...profile, configured: !!encryptedKey });
    }
    return [...profiles.values()].sort((a, b) => a.name.localeCompare(b.name));
  });

  ipcMain.handle("agent:provider-save", async (_event, profile: AgentProviderProfile) => {
    try {
      if (!profile.name.trim() || !profile.baseUrl.trim() || !profile.model.trim()) {
        throw new Error("Provider name, base URL, and model are required.");
      }
      const profiles = await readSavedProfiles();
      const current = profiles.find((item) => item.name.toLowerCase() === profile.name.trim().toLowerCase());
      const apiKey = profile.apiKey?.trim();
      const encryptedKey = apiKey
        ? safeStorage.encryptString(apiKey).toString("base64")
        : current?.encryptedKey ?? "";
      const next: SavedProfile = {
        name: profile.name.trim(),
        baseUrl: profile.baseUrl.trim().replace(/\/$/, ""),
        model: profile.model.trim(),
        encryptedKey
      };
      await writeSavedProfiles([...profiles.filter((item) => item.name.toLowerCase() !== next.name.toLowerCase()), next]);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("agent:run", async (_event, request: AgentRunRequest) => {
    const profiles = await readSavedProfiles();
    const selected = profiles.find((profile) => profile.name.toLowerCase() === request.providerName?.toLowerCase());
    let apiKey = "";
    if (selected?.encryptedKey && safeStorage.isEncryptionAvailable()) {
      apiKey = safeStorage.decryptString(Buffer.from(selected.encryptedKey, "base64"));
    }
    return requestJson<{ session_id: string }>("/runs", {
      method: "POST",
      body: JSON.stringify({
        prompt: request.prompt,
        workspace_root: request.workspaceRoot,
        session_id: request.sessionId,
        mode: request.mode,
        provider_name: selected?.name ?? request.providerName ?? "",
        model: selected?.model ?? request.model ?? "",
        api_key: apiKey,
        base_url: selected?.baseUrl ?? "",
        max_turns: request.maxTurns ?? 50,
        allow_write: true,
        allow_shell: true,
        permission_mode: request.mode === "plan" ? "plan" : "default"
      })
    });
  });

  ipcMain.handle("agent:events", (_event, sessionId: string, after: number) =>
    requestJson(`/runs/${encodeURIComponent(sessionId)}/events?after=${after}`));
  ipcMain.handle("agent:approve", async (_event, sessionId: string, workspaceRoot?: string | null) => {
    try { await requestJson(`/runs/${encodeURIComponent(sessionId)}/approve${workspaceRoot ? `?workspace_root=${encodeURIComponent(workspaceRoot)}` : ""}`, { method: "POST", body: "{}" }); return { success: true }; }
    catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("agent:reject", async (_event, sessionId: string, workspaceRoot?: string | null) => {
    try { await requestJson(`/runs/${encodeURIComponent(sessionId)}/reject${workspaceRoot ? `?workspace_root=${encodeURIComponent(workspaceRoot)}` : ""}`, { method: "POST", body: "{}" }); return { success: true }; }
    catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("agent:stop", async (_event, sessionId: string, workspaceRoot?: string | null) => {
    try { await requestJson(`/runs/${encodeURIComponent(sessionId)}/stop${workspaceRoot ? `?workspace_root=${encodeURIComponent(workspaceRoot)}` : ""}`, { method: "POST", body: "{}" }); return { success: true }; }
    catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("agent:answer-questions", async (_event, sessionId: string, answers: Array<{ id: string; selected: string[]; custom_text: string }>) => {
    try { await requestJson(`/runs/${encodeURIComponent(sessionId)}/answer-questions`, { method: "POST", body: JSON.stringify({ answers }) }); return { success: true }; }
    catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle("agent:sessions", (_event, workspaceRoot: string) =>
    requestJson<{ sessions: Array<Record<string, unknown>> }>(`/sessions?workspace_root=${encodeURIComponent(workspaceRoot)}`).then((data) => data.sessions));
  ipcMain.handle("agent:session", (_event, workspaceRoot: string, sessionId: string) =>
    requestJson(`/sessions/${encodeURIComponent(sessionId)}?workspace_root=${encodeURIComponent(workspaceRoot)}`));
  ipcMain.handle("agent:search-images", (_event, query: string, perPage = 6) =>
    requestJson<{ results: Array<{ alt: string; heroUrl: string; thumbnailUrl: string; sourceUrl: string; photographer: string; license: string; credit: string; width: number; height: number }> }>("/images/search", {
      method: "POST",
      body: JSON.stringify({ query, per_page: perPage }),
      signal: AbortSignal.timeout(12_000)
    }));

  let quitting = false;
  let allowQuitAfterAgentShutdown = false;
  app.on("before-quit", (event) => {
    if (allowQuitAfterAgentShutdown) {
      terminateAgentService();
      return;
    }
    if (!child && !starting) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;

    void (async () => {
      if (starting) {
        await Promise.race([
          starting.catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 1_000))
        ]);
      }
      if (child && serviceToken) {
        try {
          await fetch(`${serviceUrl()}/shutdown`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${serviceToken}`,
              "Content-Type": "application/json"
            },
            body: "{}",
            signal: AbortSignal.timeout(2_500)
          });
        } catch {
          // The child is still terminated below if graceful shutdown is unavailable.
        }
      }
      terminateAgentService();
      allowQuitAfterAgentShutdown = true;
      app.quit();
    })();
  });
}
