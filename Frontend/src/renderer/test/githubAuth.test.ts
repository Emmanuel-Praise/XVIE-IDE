import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { handlers, mocks } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  mocks: { userData: "", openExternal: vi.fn() }
}));

vi.mock("electron", () => ({
  app: { getPath: () => mocks.userData },
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString("utf8").replace(/^encrypted:/, "")
  },
  shell: { openExternal: mocks.openExternal },
  BrowserWindow: class { static fromWebContents(): null { return null; } },
  dialog: { showOpenDialog: vi.fn() }
}));

function response(data: unknown, headers: Record<string, string> = {}, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => data,
    text: async () => typeof data === "string" ? data : JSON.stringify(data)
  };
}

async function invoke<T>(name: string, ...args: unknown[]): Promise<T> {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`Missing handler: ${name}`);
  return await handler({}, ...args) as T;
}

describe("GitHub Device Flow and repository access", () => {
  let userData = "";
  const originalClientId = process.env.XVIE_GITHUB_CLIENT_ID;

  beforeEach(async () => {
    userData = await mkdtemp(join(tmpdir(), "xvie-github-auth-"));
    mocks.userData = userData;
    handlers.clear();
    mocks.openExternal.mockReset();
    process.env.XVIE_GITHUB_CLIENT_ID = "public-oauth-client-id";
    vi.resetModules();
    const { registerGithubHandlers } = await import("../../main/github");
    registerGithubHandlers();
  });

  afterEach(async () => {
    if (originalClientId === undefined) delete process.env.XVIE_GITHUB_CLIENT_ID;
    else process.env.XVIE_GITHUB_CLIENT_ID = originalClientId;
    vi.unstubAllGlobals();
    if (userData) await rm(userData, { recursive: true, force: true });
  });

  it("completes browser approval, encrypts the token, and accesses private repositories", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/login/device/code")) return response({ device_code: "device-code", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 });
      if (url.endsWith("/login/oauth/access_token")) return response({ access_token: "secret-access-token" });
      if (url.endsWith("/user")) return response({ login: "xvie-user", name: "XVIE User", avatar_url: "https://avatars.githubusercontent.com/u/1", html_url: "https://github.com/xvie-user", public_repos: 2 });
      if (url.includes("/user/repos?") && (!init?.method || init.method === "GET")) return response([{ id: 1, name: "private-project", full_name: "xvie-user/private-project", private: true }]);
      if (url.endsWith("/user/repos") && init?.method === "POST") return response({ id: 2, name: "new-project", full_name: "xvie-user/new-project", clone_url: "https://github.com/xvie-user/new-project.git" });
      if (url.includes("/repos/xvie-user/new-project")) return response({}, {}, 200);
      throw new Error(`Unexpected GitHub request: ${url}`);
    }));

    const started = await invoke<{ success: boolean; userCode: string; verificationUri: string }>("github:auth-start");
    expect(started).toMatchObject({ success: true, userCode: "ABCD-EFGH", verificationUri: "https://github.com/login/device" });
    expect(mocks.openExternal).toHaveBeenCalledWith("https://github.com/login/device");
    expect(JSON.stringify(requests[0]?.init?.body)).not.toContain("password");

    const signedIn = await invoke<{ success: boolean; user: { login: string } }>("github:auth-poll");
    expect(signedIn).toMatchObject({ success: true, user: { login: "xvie-user" } });
    const encrypted = await readFile(join(userData, "xvie-github-token.bin"), "utf8");
    expect(encrypted).not.toContain("secret-access-token");

    const repos = await invoke<{ items: Array<{ full_name: string; private: boolean }> }>("github:repositories", 1);
    expect(repos.items[0]).toMatchObject({ full_name: "xvie-user/private-project", private: true });
    expect(requests.find((request) => request.url.includes("/user/repos"))?.init?.headers).toMatchObject({ Authorization: "Bearer secret-access-token" });

    const created = await invoke<{ full_name: string }>("github:create-repository", "new-project", "", true);
    expect(created.full_name).toBe("xvie-user/new-project");
    const defaultBranch = await invoke<{ success: boolean }>("github:set-default-branch", "xvie-user", "new-project", "main");
    expect(defaultBranch.success).toBe(true);
    expect(requests.some((request) => request.init?.method === "PATCH")).toBe(true);

    await invoke("github:sign-out");
    const status = await invoke<{ user: unknown }>("github:auth-status");
    expect(status.user).toBeNull();
  });

  it("reports missing OAuth app configuration instead of pretending to connect", async () => {
    delete process.env.XVIE_GITHUB_CLIENT_ID;
    const result = await invoke<{ success: boolean; error: string }>("github:auth-start");
    expect(result.success).toBe(false);
    expect(result.error).toContain("XVIE_GITHUB_CLIENT_ID");
  });
});
