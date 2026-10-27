import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import { spawn } from "child_process";
import { join } from "path";
import { promises as fs } from "fs";
import { lookup } from "dns/promises";
import { isIP } from "net";
import type {
  CloneProgress,
  CloneResult,
  GitHubReadmeResult,
  GitHubSearchResult
} from "../shared/ipc-types";
import type { GitHubRepo, GitHubUser } from "../shared/ipc-types";

const GITHUB_API = "https://api.github.com";
const PER_PAGE = 30;
const AUTH_FILE = "xvie-github-token.bin";
let githubToken = "";
let deviceAuth: { deviceCode: string; interval: number; expiresAt: number } | null = null;
let tokenReady: Promise<void> = Promise.resolve();
// Preview cache with TTL so repeated marketplace visits don't re-capture.
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const PREVIEW_MAX_ENTRIES = 300;
const previewCache = new Map<string, { value: string | null; at: number }>();
const previewInflight = new Map<string, Promise<string | null>>();

function previewCacheGet(key: string): string | null | undefined {
  const entry = previewCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > PREVIEW_TTL_MS) {
    previewCache.delete(key);
    return undefined;
  }
  return entry.value;
}

function previewCacheSet(key: string, value: string | null): void {
  if (previewCache.size >= PREVIEW_MAX_ENTRIES) {
    const oldest = previewCache.keys().next().value;
    if (oldest) previewCache.delete(oldest);
  }
  previewCache.set(key, { value, at: Date.now() });
}

// At most 2 live screenshot windows at once — each one is expensive.
const CAPTURE_MAX_CONCURRENT = 2;
let captureActive = 0;
const captureQueue: Array<() => void> = [];

function withCaptureSlot<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = (): void => {
      captureActive += 1;
      task().then(resolve, reject).finally(() => {
        captureActive -= 1;
        const next = captureQueue.shift();
        if (next) next();
      });
    };
    if (captureActive < CAPTURE_MAX_CONCURRENT) run();
    else captureQueue.push(run);
  });
}

export function githubGitEnvironment(): NodeJS.ProcessEnv {
  if (!githubToken) return {};
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${githubToken}`).toString("base64")}`
  };
}

async function readToken(): Promise<string> {
  if (!safeStorage.isEncryptionAvailable()) return "";
  try {
    const encrypted = await fs.readFile(join(app.getPath("userData"), AUTH_FILE), "utf8");
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  } catch { return ""; }
}

async function saveToken(token: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure credential storage is unavailable on this system.");
  const dir = app.getPath("userData");
  await fs.mkdir(dir, { recursive: true });
  const target = join(dir, AUTH_FILE);
  const temp = `${target}.tmp`;
  await fs.writeFile(temp, safeStorage.encryptString(token).toString("base64"), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, target);
  githubToken = token;
}

/**
 * Trending default: repos created in the last 14 days that already earned
 * serious stars, still actively pushed, not archived, not forks — sorted by
 * stars descending so the most talked-about surface first.
 */
export function defaultSearchQuery(): string {
  const createdAfter = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const pushedAfter = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return `stars:>200 created:>=${createdAfter} pushed:>=${pushedAfter} archived:false fork:false`;
}

function apiHeaders(accept = "application/vnd.github+json"): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: accept,
    "User-Agent": "Xvie-Marketplace",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  const token = process.env.GITHUB_TOKEN;
  if (githubToken || token) {
    headers["Authorization"] = `Bearer ${githubToken || token}`;
  }
  return headers;
}

async function apiGet<T>(path: string, accept?: string): Promise<T> {
  await tokenReady;
  const response = await fetch(`${GITHUB_API}${path}`, { headers: apiHeaders(accept) });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`GitHub API ${response.status}: ${detail.slice(0, 300)}`);
  }
  return (await response.json()) as T;
}

function registerSearch(): void {
  ipcMain.handle(
    "github:search",
    async (
      _event,
      query: string,
      page: number
    ): Promise<{ items: GitHubSearchResult["items"]; totalCount: number }> => {
      const q = (query ?? "").trim() || defaultSearchQuery();
      const { items, total_count } = await apiGet<GitHubSearchResult>(
        `/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${PER_PAGE}&page=${page ?? 1}`
      );
      return { items, totalCount: total_count };
    }
  );
}

function registerReadme(): void {
  ipcMain.handle(
    "github:readme",
    async (_event, owner: string, repo: string): Promise<GitHubReadmeResult> => {
      await tokenReady;
      const response = await fetch(
        `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`,
        { headers: apiHeaders("application/vnd.github.html+json") }
      );
      if (response.status === 404) {
        return { html: null, error: "This repository does not have a README." };
      }
      if (!response.ok) {
        throw new Error(`GitHub API ${response.status}`);
      }
      return { html: await response.text(), error: null };
    }
  );
}

function registerClone(): void {
  ipcMain.handle("github:clone", async (event, url: string): Promise<CloneResult> => {
    await tokenReady;
    if (typeof url !== "string" || !/^https:\/\/github\.com\//.test(url)) {
      return { success: false, error: "Invalid repository URL." };
    }

    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: "Choose a folder to clone into",
      buttonLabel: "Clone Here",
      properties: ["openDirectory", "createDirectory"]
    };
    const picked = ownerWindow
      ? await dialog.showOpenDialog(ownerWindow, options)
      : await dialog.showOpenDialog(options);
    if (picked.canceled || picked.filePaths.length === 0) {
      return { canceled: true };
    }

    const repoName = url.replace(/\.git$/, "").split("/").pop() ?? "repository";
    if (!/^[A-Za-z0-9._-]+$/.test(repoName)) {
      return { success: false, error: "Could not determine a safe folder name for this repository." };
    }
    const destination = join(picked.filePaths[0], repoName);

    const send = (progress: CloneProgress): void => {
      if (!event.sender.isDestroyed()) {
        event.sender.send("github:clone-progress", progress);
      }
    };

    send({ repo: url, phase: "starting", destination });
    const token = githubToken;
    const child = spawn("git", ["clone", "--depth", "1", "--progress", url, destination], {
      windowsHide: true,
      env: token ? { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` } : process.env
    });

    let lastLine = "";
    const onData = (chunk: Buffer): void => {
      const text = chunk
        .toString("utf8")
        .replace(/\x1b\[[0-9;]*m/g, "")
        .replace(/\r/g, "\n");
      const lines = text.split("\n").filter(Boolean);
      if (lines.length > 0) {
        lastLine = lines[lines.length - 1];
        send({ repo: url, phase: "progress", message: lastLine, destination });
      }
    };
    child.stderr.on("data", onData);
    child.stdout.on("data", onData);

    return await new Promise<CloneResult>((resolve) => {
      child.on("error", (err) => {
        send({ repo: url, phase: "error", message: err.message, destination });
        resolve({ success: false, error: `Failed to start git: ${err.message}` });
      });
      child.on("close", (code) => {
        if (code === 0) {
          send({ repo: url, phase: "done", destination });
          resolve({ success: true, destination });
        } else {
          send({ repo: url, phase: "error", message: lastLine, destination });
          resolve({
            success: false,
            error: lastLine.trim() || `git clone exited with code ${code}.`
          });
        }
      });
    });
  });
}

async function githubUser(): Promise<GitHubUser | null> {
  if (!githubToken) return null;
  try { return await apiGet<GitHubUser>("/user"); } catch { return null; }
}

async function postApi<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    method: "POST", headers: { ...apiHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.json() as Promise<T>;
}

async function patchApi(path: string, body: unknown): Promise<void> {
  const response = await fetch(`${GITHUB_API}${path}`, { method: "PATCH", headers: { ...apiHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${(await response.text()).slice(0, 300)}`);
}

function registerAccount(): void {
  ipcMain.handle("github:auth-status", async () => ({ user: await githubUser(), configured: Boolean(process.env.XVIE_GITHUB_CLIENT_ID) }));
  ipcMain.handle("github:auth-config", async () => ({ configured: Boolean(process.env.XVIE_GITHUB_CLIENT_ID) }));
  ipcMain.handle("github:connect-token", async (_event, token: string) => {
    try {
      const cleaned = typeof token === "string" ? token.trim() : "";
      if (!cleaned) throw new Error("Paste a personal access token first.");
      if (cleaned.length < 20) throw new Error("That token looks too short. Copy the full token from GitHub.");
      if (/\s/.test(cleaned)) throw new Error("The token should not contain spaces. Copy it again from GitHub.");
      const response = await fetch(`${GITHUB_API}/user`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "Xvie-Marketplace", "X-GitHub-Api-Version": "2022-11-28", Authorization: `Bearer ${cleaned}` }
      });
      if (response.status === 401) throw new Error("GitHub rejected this token. Check it has not expired or been revoked.");
      if (response.status === 403) throw new Error("GitHub refused this token (rate limited or missing scopes). Give it 'repo' scope and try again.");
      if (!response.ok) throw new Error(`GitHub API ${response.status}: ${(await response.text()).slice(0, 200)}`);
      const user = (await response.json()) as GitHubUser;
      await saveToken(cleaned);
      return { success: true, user };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  });
  ipcMain.handle("github:auth-start", async () => {
    const clientId = process.env.XVIE_GITHUB_CLIENT_ID;
    if (!clientId) return { success: false, error: "Device sign-in needs XVIE_GITHUB_CLIENT_ID, which is not set in this build. Connect with a personal access token instead — GitHub Settings → Developer settings → Personal access tokens → Tokens (classic) with 'repo' scope." };
    try {
      const response = await fetch("https://github.com/login/device/code", {
        method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, scope: "repo read:user" })
      });
      const data = await response.json() as { device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number; error?: string };
      if (!response.ok || !data.device_code || !data.user_code || !data.verification_uri) throw new Error(data.error ?? "GitHub did not start the sign-in flow.");
      deviceAuth = { deviceCode: data.device_code, interval: data.interval ?? 5, expiresAt: Date.now() + (data.expires_in ?? 900) * 1000 };
      await shell.openExternal(data.verification_uri);
      return { success: true, userCode: data.user_code, verificationUri: data.verification_uri };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  });
  ipcMain.handle("github:auth-poll", async () => {
    if (!deviceAuth) return { success: false, error: "Start GitHub sign-in first." };
    if (Date.now() >= deviceAuth.expiresAt) { deviceAuth = null; return { success: false, error: "GitHub sign-in code expired. Try again." }; }
    try {
      const response = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: process.env.XVIE_GITHUB_CLIENT_ID, device_code: deviceAuth.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" })
      });
      const data = await response.json() as { access_token?: string; error?: string; interval?: number };
      if (data.error === "authorization_pending") return { success: false, pending: true };
      if (data.error === "slow_down") { deviceAuth.interval = (data.interval ?? deviceAuth.interval) + 5; return { success: false, pending: true }; }
      if (!response.ok || !data.access_token) return { success: false, error: data.error ?? "GitHub authorization failed." };
      await saveToken(data.access_token);
      deviceAuth = null;
      const user = await githubUser();
      return user ? { success: true, user } : { success: false, error: "Signed in, but GitHub could not load the account." };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  });
  ipcMain.handle("github:sign-out", async () => {
    githubToken = "";
    try { await fs.rm(join(app.getPath("userData"), AUTH_FILE), { force: true }); } catch { /* token is already cleared in memory */ }
    return { success: true };
  });
  ipcMain.handle("github:repositories", async (_event, page = 1) => {
    await tokenReady;
    if (!githubToken) throw new Error("Connect a GitHub account first.");
    const response = await fetch(`${GITHUB_API}/user/repos?sort=updated&per_page=100&page=${page}`, { headers: apiHeaders() });
    if (!response.ok) throw new Error(`GitHub API ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const items = await response.json() as GitHubRepo[];
    const link = response.headers.get("link") ?? "";
    return { items, totalCount: items.length, hasMore: /rel="next"/.test(link) };
  });
  ipcMain.handle("github:create-repository", async (_event, name: string, description: string, isPrivate: boolean) => {
    await tokenReady;
    if (!githubToken) throw new Error("Connect a GitHub account first.");
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("Enter a valid repository name.");
    return postApi<GitHubRepo>("/user/repos", { name, description, private: isPrivate, auto_init: false });
  });
  ipcMain.handle("github:set-default-branch", async (_event, owner: string, repo: string, branch: string) => {
    try {
      await tokenReady;
      if (!githubToken) throw new Error("Connect a GitHub account first.");
      await patchApi(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { default_branch: branch });
      return { success: true };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  });
}

function validDemoUrl(value: string, repo: GitHubRepo): URL | null {
  try {
    const url = new URL(value);
    if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password || url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname === "127.0.0.1" || url.hostname === "::1") return null;
    // A homepage pointing back at github.com is usually just the repo page —
    // screenshotting it is slow and useless, so skip straight to repo images.
    if (/(^|\.)github\.com$/i.test(url.hostname)) return null;
    if (repo.html_url && url.toString().replace(/\/$/, "") === repo.html_url.replace(/\/$/, "")) return null;
    return url;
  } catch { return null; }
}

async function captureDemo(rawUrl: string): Promise<string | null> {
  const cacheKey = `demo:${rawUrl}`;
  const cached = previewCacheGet(cacheKey);
  if (cached !== undefined) return cached;
  return withCaptureSlot(async () => {
    const doubleChecked = previewCacheGet(cacheKey);
    if (doubleChecked !== undefined) return doubleChecked;
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      previewCacheSet(cacheKey, null);
      return null;
    }
    const privateAddress = (address: string): boolean => {
      if (isIP(address) === 4) {
        const [a, b] = address.split(".").map(Number);
        return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
      }
      const normalized = address.toLowerCase();
      return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized) || normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.") || normalized.startsWith("::ffff:192.168.");
    };
    try {
      const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true });
      if (addresses.some(({ address }) => privateAddress(address))) {
        previewCacheSet(cacheKey, null);
        return null;
      }
    } catch {
      previewCacheSet(cacheKey, null);
      return null;
    }
    // Smaller window + shorter settle + JPEG output keeps this path fast.
    const window = new BrowserWindow({ width: 960, height: 640, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    try {
      await Promise.race([window.loadURL(url.toString()), new Promise((_, reject) => setTimeout(() => reject(new Error("Preview timed out")), 8000))]);
      await new Promise((resolve) => setTimeout(resolve, 600));
      const image = await window.webContents.capturePage();
      const thumb = image.resize({ width: 640 });
      let dataUrl: string;
      try {
        const jpeg = thumb.toJPEG(70);
        dataUrl = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
      } catch {
        dataUrl = thumb.toDataURL();
      }
      previewCacheSet(cacheKey, dataUrl);
      return dataUrl;
    } catch {
      previewCacheSet(cacheKey, null);
      return null;
    } finally { if (!window.isDestroyed()) window.destroy(); }
  });
}

function pickRepoImage(paths: string[]): string | null {
  const imagePattern = /\.(png|jpe?g|webp|gif|avif)$/i;
  const images = paths.filter((path) => imagePattern.test(path));
  const preferred = images.filter((path) => /(screenshot|preview|demo|hero|banner|cover|thumbnail)/i.test(path));
  return [...preferred, ...images].find((path) => !/(badge|logo|icon|avatar|favicon)/i.test(path)) ?? null;
}

async function repoImageUrl(repo: GitHubRepo): Promise<string | null> {
  // Cheap non-recursive root listing first — covers the common screenshot.png case.
  try {
    const shallow = await apiGet<{ tree?: Array<{ path: string; type: string }> }>(
      `/repos/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/git/trees/${encodeURIComponent(repo.default_branch)}`
    );
    const candidate = pickRepoImage((shallow.tree ?? []).filter((item) => item.type === "blob").map((item) => item.path));
    if (candidate) {
      return `https://raw.githubusercontent.com/${repo.full_name}/${encodeURIComponent(repo.default_branch)}/${candidate.split("/").map(encodeURIComponent).join("/")}`;
    }
  } catch { /* fall through to recursive */ }
  const tree = await apiGet<{ tree?: Array<{ path: string; type: string }> }>(
    `/repos/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`
  );
  const candidate = pickRepoImage((tree.tree ?? []).filter((item) => item.type === "blob").map((item) => item.path));
  if (!candidate) return null;
  return `https://raw.githubusercontent.com/${repo.full_name}/${encodeURIComponent(repo.default_branch)}/${candidate.split("/").map(encodeURIComponent).join("/")}`;
}

async function readmeImageUrl(repo: GitHubRepo): Promise<string | null> {
  const readme = await fetch(`${GITHUB_API}/repos/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/readme`, {
    headers: apiHeaders("application/vnd.github.html+json"),
    signal: AbortSignal.timeout(8000)
  });
  if (!readme.ok) return null;
  const html = await readme.text();
  const source = html.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
  if (source && /^https:\/\//i.test(source)) return source;
  return null;
}

async function resolvePreview(repo: GitHubRepo): Promise<string | null> {
  const key = repo.full_name;
  const cached = previewCacheGet(key);
  if (cached !== undefined) return cached;
  const inflight = previewInflight.get(key);
  if (inflight) return inflight;
  const task = (async (): Promise<string | null> => {
    // Fallback order stays: demo screenshot → repo images → README image → null.
    // The repo-image lookup starts immediately so a slow demo doesn't serialize everything.
    const demoUrl = repo.homepage ? validDemoUrl(repo.homepage, repo) : null;
    const repoImagePromise = repoImageUrl(repo).catch(() => null);
    if (demoUrl) {
      const capture = await captureDemo(demoUrl.toString()).catch(() => null);
      if (capture) {
        previewCacheSet(key, capture);
        // Let the background lookup settle into cache for next time, ignore errors.
        void repoImagePromise.catch(() => null);
        return capture;
      }
    }
    const repoImage = await repoImagePromise;
    if (repoImage) {
      previewCacheSet(key, repoImage);
      return repoImage;
    }
    try {
      const readmeImage = await readmeImageUrl(repo);
      if (readmeImage) {
        previewCacheSet(key, readmeImage);
        return readmeImage;
      }
    } catch { /* renderer shows the category fallback */ }
    previewCacheSet(key, null);
    return null;
  })();
  previewInflight.set(key, task);
  try {
    return await task;
  } finally {
    previewInflight.delete(key);
  }
}

const PREVIEW_BATCH_LIMIT = 12;
const PREVIEW_BATCH_CONCURRENCY = 4;

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function registerPreview(): void {
  ipcMain.handle("github:preview-image", async (_event, repo: GitHubRepo): Promise<string | null> => {
    try {
      return await resolvePreview(repo);
    } catch {
      return null;
    }
  });
  ipcMain.handle("github:preview-images", async (_event, repos: GitHubRepo[]): Promise<Record<string, string | null>> => {
    const list = Array.isArray(repos) ? repos.slice(0, PREVIEW_BATCH_LIMIT) : [];
    const out: Record<string, string | null> = {};
    await mapWithConcurrency(list, PREVIEW_BATCH_CONCURRENCY, async (repo) => {
      try {
        out[repo.full_name] = await resolvePreview(repo);
      } catch {
        out[repo.full_name] = null;
      }
    });
    return out;
  });
}

export function registerGithubHandlers(): void {
  tokenReady = readToken().then((token) => { githubToken = token; });
  registerSearch();
  registerReadme();
  registerClone();
  registerAccount();
  registerPreview();
}
