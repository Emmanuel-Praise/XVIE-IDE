import { execFile } from "child_process";
import { promisify } from "util";
import { ipcMain } from "electron";
import { promises as fs } from "fs";
import { resolve } from "path";
import { githubGitEnvironment } from "./github";
import type { GitCommit, GitFileChange, GitStatus } from "../shared/ipc-types";

const execFileAsync = promisify(execFile);

async function runGit(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: root,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...githubGitEnvironment() }
    });
    return stdout;
  } catch (error) {
    throw new Error(describeGitError(error, args));
  }
}

function describeGitError(error: unknown, args: string[]): string {
  const failure = error && typeof error === "object" ? error as { message?: string; stderr?: string; stdout?: string; code?: string | number } : {};
  if (failure.code === "ENOENT") return "Git could not be found. Install Git and restart XVIE.";
  const output = failure.stderr?.trim() || failure.stdout?.trim();
  if (output) return output.replace(/^fatal: /i, "").replace(/^error: /i, "");
  const detail = (failure.message ?? String(error)).replace(/^Command failed: git[^\r\n]*\r?\n?/, "").trim();
  return detail || `Git ${args[0] ?? "command"} failed. Check that Git is installed and the project folder is accessible.`;
}

function isNotGitRepository(error: unknown): boolean {
  const failure = error && typeof error === "object" ? error as { stderr?: string; message?: string } : {};
  return /not a git repository/i.test(failure.stderr ?? failure.message ?? "");
}

async function repositoryPath(path: string, requireGit = false): Promise<string> {
  if (typeof path !== "string" || !path.trim()) throw new Error("Choose a project first.");
  const root = await fs.realpath(resolve(path));
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error("The selected project path is not a folder.");
  if (requireGit) {
    try { await runGit(root, ["rev-parse", "--show-toplevel"]); }
    catch (error) {
      if (isNotGitRepository(error)) throw new Error("Git is not initialized in this project yet.");
      throw error;
    }
  }
  return root;
}

function errorResult(error: unknown): { success: false; error: string } {
  return { success: false, error: error instanceof Error ? error.message : String(error) };
}

function registerGitStatus(): void {
  ipcMain.handle("git:status", async (_event, path: string): Promise<GitStatus> => {
    const root = await repositoryPath(path);
    try {
      await runGit(root, ["rev-parse", "--show-toplevel"]);
    } catch (error) {
      if (isNotGitRepository(error)) return { initialized: false, branch: "", remote: null, changes: [] };
      throw error;
    }
    const [branchOutput, remoteOutput, statusOutput] = await Promise.all([
      runGit(root, ["branch", "--show-current"]),
      runGit(root, ["remote", "get-url", "origin"]).catch(() => ""),
      runGit(root, ["status", "--porcelain=v1"])
    ]);
    const changes: GitFileChange[] = statusOutput.split(/\r?\n/).filter(Boolean).map((line) => {
      const status = line.slice(0, 2).trim() || "?";
      return { status, path: line.slice(3).replace(/^"|"$/g, "") };
    });
    return { initialized: true, branch: branchOutput.trim() || "HEAD", remote: remoteOutput.trim() || null, changes };
  });
}

function registerGitHistory(): void {
  ipcMain.handle("git:history", async (_event, path: string): Promise<GitCommit[]> => {
    const root = await repositoryPath(path, true);
    // A freshly initialized repository has no HEAD yet. Treat that as an empty
    // history so the renderer can show its normal first-commit state.
    try { await runGit(root, ["rev-parse", "--verify", "HEAD"]); }
    catch { return []; }
    const output = await runGit(root, ["log", "--all", "--reverse", "--topo-order", "--diff-merges=first-parent", "--date=iso-strict", "--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%D", "--numstat", "--summary"]);
    return output.split("\x1e").filter((record) => record.trim()).map((record) => {
      const lines = record.replace(/^\r?\n/, "").split(/\r?\n/);
      const fields = (lines.shift() ?? "").split("\x1f");
      const [hash = "", parents = "", author = "", email = "", date = "", message = "", refs = ""] = fields;
      let insertions = 0;
      let deletions = 0;
      const addedPaths = new Set(lines.map((line) => /^ create mode \d+ (.+)$/.exec(line)?.[1]).filter((file): file is string => !!file));
      const deletedPaths = new Set(lines.map((line) => /^ delete mode \d+ (.+)$/.exec(line)?.[1]).filter((file): file is string => !!file));
      const fileChanges = [...new Map(lines.map((line) => {
        const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(line);
        if (!match) return null;
        insertions += Number(match[1]) || 0;
        deletions += Number(match[2]) || 0;
        const file = match[3];
        const status = addedPaths.has(file) ? "added" as const : deletedPaths.has(file) ? "deleted" as const : "modified" as const;
        return [file, { path: file, status, insertions: Number(match[1]) || 0, deletions: Number(match[2]) || 0, binary: match[1] === "-" || match[2] === "-" }] as const;
      }).filter((entry): entry is readonly [string, { path: string; status: "added" | "deleted" | "modified"; insertions: number; deletions: number; binary: boolean }] => entry !== null))].map(([, file]) => file);
      const files = fileChanges.map((file) => file.path);
      return {
        hash,
        parents: parents.split(" ").filter(Boolean),
        author,
        email,
        date,
        message,
        refs: refs.split(",").map((ref) => ref.trim()).filter(Boolean),
        files,
        fileChanges,
        insertions,
        deletions
      } satisfies GitCommit;
    }).filter((commit) => commit.hash);
  });
}

function registerGitBranches(): void {
  ipcMain.handle("git:branches", async (_event, path: string) => {
    const root = await repositoryPath(path, true);
    const output = await runGit(root, ["branch", "--format=%(HEAD) %(refname:short)"]);
    const rows = output.split(/\r?\n/).filter(Boolean);
    const branches = rows.map((line) => line.slice(2));
    const current = rows.find((line) => line.startsWith("* "))?.slice(2) ?? "";
    return { current, branches };
  });
}

function registerGitMutations(): void {
  ipcMain.handle("git:initialize", async (_event, path: string, name: string, email: string) => {
    try {
      const root = await repositoryPath(path);
      if (!name.trim() || !email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw new Error("Enter a valid author name and email address.");
      let initialized = false;
      try { await runGit(root, ["rev-parse", "--show-toplevel"]); initialized = true; } catch { /* expected for a new repository */ }
      if (initialized) throw new Error("Git is already initialized in this project.");
      await runGit(root, ["init", "-b", "main"]);
      await runGit(root, ["config", "--local", "user.name", name.trim()]);
      await runGit(root, ["config", "--local", "user.email", email.trim()]);
      return { success: true };
    } catch (error) { return errorResult(error); }
  });

  ipcMain.handle("git:commit", async (_event, path: string, message: string) => {
    try {
      const root = await repositoryPath(path, true);
      if (!message.trim()) throw new Error("Enter a commit message.");
      await runGit(root, ["add", "--all"]);
      await runGit(root, ["commit", "-m", message.trim()]);
      return { success: true };
    } catch (error) { return errorResult(error); }
  });

  ipcMain.handle("git:create-branch", async (_event, path: string, name: string) => {
    try {
      const root = await repositoryPath(path, true);
      if (!name.trim()) throw new Error("Enter a branch name.");
      await runGit(root, ["switch", "-c", name.trim()]);
      return { success: true };
    } catch (error) { return errorResult(error); }
  });

  ipcMain.handle("git:switch-branch", async (_event, path: string, name: string) => {
    try {
      const root = await repositoryPath(path, true);
      await runGit(root, ["switch", name]);
      return { success: true };
    } catch (error) { return errorResult(error); }
  });

  ipcMain.handle("git:set-remote", async (_event, path: string, url: string) => {
    try {
      const root = await repositoryPath(path, true);
      const value = url.trim();
      if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(value)) throw new Error("Choose a valid GitHub repository.");
      const existing = await runGit(root, ["remote"]);
      if (existing.split(/\r?\n/).includes("origin")) await runGit(root, ["remote", "set-url", "origin", value]);
      else await runGit(root, ["remote", "add", "origin", value]);
      return { success: true };
    } catch (error) { return errorResult(error); }
  });

  ipcMain.handle("git:push", async (_event, path: string) => {
    try {
      const root = await repositoryPath(path, true);
      const remote = await runGit(root, ["remote", "get-url", "origin"]).catch(() => "");
      if (!remote.trim()) throw new Error("Connect a GitHub repository before pushing.");
      const branch = (await runGit(root, ["branch", "--show-current"])).trim();
      if (!branch) throw new Error("Create or switch to a branch before pushing.");
      await runGit(root, ["push", "--set-upstream", "origin", branch]);
      return { success: true };
    } catch (error) { return errorResult(error); }
  });
}

export function registerGitHandlers(): void {
  registerGitStatus();
  registerGitHistory();
  registerGitBranches();
  registerGitMutations();
}
