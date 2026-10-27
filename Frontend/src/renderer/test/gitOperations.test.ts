import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();

vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, listener: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, listener) }
}));
vi.mock("../../main/github", () => ({ githubGitEnvironment: () => ({}) }));

import { registerGitHandlers } from "../../main/git";

describe("Git IPC operations", () => {
  let parent: string;
  let repo: string;
  const call = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler registered for ${channel}`);
    return await handler({}, ...args) as T;
  };

  beforeEach(async () => {
    handlers.clear();
    registerGitHandlers();
    parent = await mkdtemp(join(tmpdir(), "xvie-git-test-"));
    repo = join(parent, "project");
    await mkdir(repo);
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it("initializes, commits, reports history and branches, and pushes to a local remote", async () => {
    expect(await call("git:status", repo)).toMatchObject({ initialized: false, changes: [] });
    expect(await call("git:initialize", repo, "XVIE Test", "xvie-test@example.com")).toEqual({ success: true });
    expect(execFileSync("git", ["config", "--local", "user.name"], { cwd: repo, encoding: "utf8" }).trim()).toBe("XVIE Test");
    expect(await call("git:history", repo)).toEqual([]);

    await writeFile(join(repo, "readme.md"), "first\n");
    expect(await call("git:status", repo)).toMatchObject({ initialized: true, branch: "main", changes: [{ path: "readme.md" }] });
    expect(await call("git:commit", repo, "Initial project")).toEqual({ success: true });

    expect(await call("git:create-branch", repo, "feature/demo")).toEqual({ success: true });
    await writeFile(join(repo, "feature.txt"), "feature\n");
    expect(await call("git:commit", repo, "Add feature")).toEqual({ success: true });
    expect(await call("git:switch-branch", repo, "main")).toEqual({ success: true });

    const history = await call<Array<{ hash: string; message: string; files: string[]; parents: string[]; insertions: number; deletions: number; fileChanges: Array<{ path: string; status: string; insertions: number; deletions: number; binary: boolean }> }>>("git:history", repo);
    expect(history.map((commit) => commit.message)).toEqual(["Initial project", "Add feature"]);
    expect(history[0].files).toContain("readme.md");
    expect(history[0]).toMatchObject({ insertions: 1, deletions: 0, fileChanges: [{ path: "readme.md", status: "added", insertions: 1, deletions: 0, binary: false }] });
    expect(history[1].parents).toHaveLength(1);
    expect(history[1].fileChanges).toContainEqual(expect.objectContaining({ path: "feature.txt", status: "added", insertions: 1, deletions: 0 }));
    expect(await call("git:branches", repo)).toEqual({ current: "main", branches: ["feature/demo", "main"] });

    const bare = join(parent, "remote.git");
    await mkdir(bare);
    execFileSync("git", ["init", "--bare", "--initial-branch=main"], { cwd: bare, stdio: "ignore" });
    expect(await call("git:set-remote", repo, "https://github.com/test/project.git")).toEqual({ success: true });
    execFileSync("git", ["remote", "set-url", "origin", bare], { cwd: repo, stdio: "ignore" });
    expect(await call("git:push", repo)).toEqual({ success: true });
    expect(execFileSync("git", ["--git-dir", bare, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim()).toBe(history[0].hash);
    expect(await readFile(join(repo, "readme.md"), "utf8")).toBe("first\n");
  });

  it("rejects invalid identities and non-GitHub remote URLs with clear errors", async () => {
    expect(await call("git:initialize", repo, "", "bad")).toMatchObject({ success: false, error: expect.stringContaining("valid author") });
    expect(await call("git:initialize", repo, "XVIE Test", "xvie-test@example.com")).toEqual({ success: true });
    expect(await call("git:set-remote", repo, "file:///tmp/not-github.git")).toMatchObject({ success: false, error: expect.stringContaining("valid GitHub") });
  });

  it("reports real insertions, deletions, and file statuses for edits", async () => {
    await call("git:initialize", repo, "XVIE Test", "xvie-test@example.com");
    const editedFile = join(repo, "file with spaces.txt");
    await writeFile(editedFile, "first\nsecond\nthird\n");
    await call("git:commit", repo, "Add text file");

    await writeFile(editedFile, "first\nchanged\n");
    await call("git:commit", repo, "Edit text file");
    const deletedFile = join(repo, "remove me.txt");
    await writeFile(deletedFile, "remove this line\n");
    await call("git:commit", repo, "Add removable file");
    await rm(deletedFile);
    await call("git:commit", repo, "Delete removable file");

    const history = await call<Array<{ message: string; insertions: number; deletions: number; fileChanges: Array<{ path: string; status: string; insertions: number; deletions: number }> }>>("git:history", repo);
    expect(history.find((item) => item.message === "Add text file")).toMatchObject({ insertions: 3, deletions: 0, fileChanges: [{ path: "file with spaces.txt", status: "added", insertions: 3, deletions: 0 }] });
    expect(history.find((item) => item.message === "Edit text file")).toMatchObject({ insertions: 1, deletions: 2, fileChanges: [{ path: "file with spaces.txt", status: "modified", insertions: 1, deletions: 2 }] });
    expect(history.find((item) => item.message === "Delete removable file")).toMatchObject({ insertions: 0, deletions: 1, fileChanges: [{ path: "remove me.txt", status: "deleted", insertions: 0, deletions: 1 }] });
  });

  it("reports first-parent changes for merge commits", async () => {
    await call("git:initialize", repo, "XVIE Test", "xvie-test@example.com");
    await writeFile(join(repo, "base.txt"), "base\n");
    await call("git:commit", repo, "Base");
    await call("git:create-branch", repo, "feature");
    await writeFile(join(repo, "feature.txt"), "feature line\n");
    await call("git:commit", repo, "Feature change");
    await call("git:switch-branch", repo, "main");
    await writeFile(join(repo, "main.txt"), "main line\n");
    await call("git:commit", repo, "Main change");
    execFileSync("git", ["merge", "--no-ff", "feature", "-m", "Merge feature"], { cwd: repo, stdio: "ignore" });

    const history = await call<Array<{ message: string; insertions: number; deletions: number; parents: string[]; fileChanges: Array<{ path: string; status: string; insertions: number; deletions: number }> }>>("git:history", repo);
    expect(history.find((item) => item.message === "Merge feature")).toMatchObject({ insertions: 1, deletions: 0, parents: expect.arrayContaining([expect.any(String)]), fileChanges: [{ path: "feature.txt", status: "added", insertions: 1, deletions: 0 }] });
  });
});
