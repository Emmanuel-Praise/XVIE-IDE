import { BrowserWindow, app, dialog, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { promises as fs } from "fs";
import { createHash } from "crypto";
import { dirname, join, normalize, relative, resolve } from "path";
import type {
  DirSnapshot,
  FsEntry,
  FsResult,
  WorkspaceFileChange,
  OpenFolderResult,
  ReadFileResult
} from "../shared/ipc-types";

const BINARY_SNIFF_BYTES = 8192;
const WATCH_DEBOUNCE_MS = 150;

const openRoots = new Map<number, string>();

function rootFor(event: IpcMainInvokeEvent): string {
  const root = openRoots.get(event.sender.id);
  if (!root) throw new Error("No workspace folder is open.");
  return root;
}

function requireInside(root: string, candidate: string): string {
  const resolved = resolve(candidate);
  if (resolved === resolve(root)) {
    return resolved;
  }
  const rel = relative(resolve(root), resolved);
  if (rel.startsWith("..") || resolve(rel) === resolve("..")) {
    throw new Error(`Path escapes the workspace root: ${candidate}`);
  }
  return resolved;
}

async function toEntry(path: string): Promise<FsEntry> {
  const stat = await fs.lstat(path);
  const name = path.split(/[\\/]/).pop() ?? path;
  return {
    name,
    path: normalize(path),
    kind: stat.isDirectory() ? "directory" : "file",
    isSymlink: stat.isSymbolicLink(),
    hidden: name.startsWith("."),
    size: stat.isDirectory() ? 0 : stat.size,
    modifiedAt: stat.mtimeMs
  };
}

function registerOpenFolder(): void {
  ipcMain.handle(
    "workspace:open-folder",
    async (event): Promise<OpenFolderResult> => {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      const options: Electron.OpenDialogOptions = {
        title: "Choose or create a project folder",
        buttonLabel: "Select Folder",
        properties: ["openDirectory", "createDirectory"]
      };
      const picked = ownerWindow
        ? await dialog.showOpenDialog(ownerWindow, options)
        : await dialog.showOpenDialog(options);
      if (picked.canceled || picked.filePaths.length === 0) {
        return { canceled: true };
      }
      const path = normalize(picked.filePaths[0]);
      const name = path.split(/[\\/]/).pop() || path;
      openRoots.set(event.sender.id, path);
      event.sender.once("destroyed", () => openRoots.delete(event.sender.id));
      return { canceled: false, path, name };
    }
  );
}

function registerOpenPath(): void {
  ipcMain.handle("workspace:open-path", async (event, path: string): Promise<FsResult> => {
    if (typeof path !== "string" || !path.trim()) {
      return { success: false, error: "A valid project folder is required." };
    }
    try {
      const normalized = await fs.realpath(resolve(path));
      const stat = await fs.stat(normalized);
      if (!stat.isDirectory()) return { success: false, error: "The selected project path is not a folder." };
      openRoots.set(event.sender.id, normalize(normalized));
      event.sender.once("destroyed", () => openRoots.delete(event.sender.id));
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

function registerScanDir(): void {
  ipcMain.handle("workspace:scan-dir", async (event, path: string): Promise<DirSnapshot> => {
    const root = rootFor(event);
    const target = requireInside(root, path);
    let entries;
    try { entries = await fs.readdir(target, { withFileTypes: true }); }
    catch (err) {
      // A folder can disappear between a filesystem event and the next render.
      // Treat that race as an empty directory instead of an unhandled IPC error.
      if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") return [];
      throw err;
    }
    const snapshot: DirSnapshot = [];
    await Promise.all(
      entries.map(async (entry) => {
        try {
          snapshot.push(await toEntry(join(target, entry.name)));
        } catch {
          // Skip entries that cannot be stat'ed (e.g. broken symlinks).
        }
      })
    );
    snapshot.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return snapshot;
  });
}

/**
 * Decodes a file buffer as text when possible.
 * Handles UTF-8, UTF-16 (BOM or NUL-byte pattern) and falls back to null for
 * true binary files (NUL bytes in an ASCII-dominant stream).
 */
function decodeTextBuffer(buffer: Buffer): { binary: true; size: number } | { binary: false; content: string } {
  const size = buffer.byteLength;

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { binary: false, content: buffer.toString("utf16le", 2) };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { binary: false, content: buffer.toString("utf16le", 2).split("").reverse().join("") };
  }

  const sample = buffer.subarray(0, BINARY_SNIFF_BYTES);
  if (!sample.includes(0)) {
    return { binary: false, content: buffer.toString("utf8") };
  }

  // No BOM but NUL bytes present: UTF-16 without BOM (common on Windows,
  // e.g. Notepad's "Unicode" encoding). ASCII characters have a NUL in the
  // high byte, so one byte lane will be almost exclusively NUL.
  let evenNulls = 0;
  let oddNulls = 0;
  for (let i = 0; i < sample.length; i += 2) {
    if (sample[i] === 0) evenNulls++;
    if (sample[i + 1] === 0) oddNulls++;
  }
  const total = Math.ceil(sample.length / 2);
  if (oddNulls > total * 0.6) {
    return { binary: false, content: buffer.toString("utf16le") };
  }
  if (evenNulls > total * 0.6) {
    return { binary: false, content: buffer.toString("utf16le").split("").reverse().join("") };
  }

  return { binary: true, size };
}

function registerReadFile(): void {
  ipcMain.handle("workspace:read-file", async (event, path: string): Promise<ReadFileResult | null> => {
    const root = rootFor(event);
    const target = requireInside(root, path);
    try {
      const buffer = await fs.readFile(target);
      const lstat = await fs.lstat(target);
      const isSymlink = lstat.isSymbolicLink();
      const decoded = decodeTextBuffer(buffer);
      if (decoded.binary) {
        return { binary: true, size: decoded.size, isSymlink };
      }
      return { binary: false, content: decoded.content, isSymlink };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") return null;
      throw err;
    }
  });
}

function registerReadBinary(): void {
  ipcMain.handle(
    "workspace:read-binary",
    async (event, path: string): Promise<Uint8Array | null> => {
      try {
        const root = rootFor(event);
        const target = requireInside(root, path);
        const buffer = await fs.readFile(target);
        return new Uint8Array(buffer);
      } catch {
        return null;
      }
    }
  );
}

function registerWriteBinary(): void {
  ipcMain.handle(
    "workspace:write-binary",
    async (event, path: string, data: unknown): Promise<FsResult> => {
      try {
        const root = rootFor(event);
        const target = requireInside(root, path);
        if (!(data instanceof Uint8Array)) {
          return { success: false, error: "Invalid binary payload." };
        }
        await fs.writeFile(target, Buffer.from(data));
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );
}

function registerOpenExternal(): void {
  ipcMain.handle(
    "workspace:open-external",
    async (event, path: string): Promise<FsResult> => {
      try {
        const root = rootFor(event);
        const target = requireInside(root, path);
        const errorMessage = await shell.openPath(target);
        return errorMessage
          ? { success: false, error: errorMessage }
          : { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );
}

function registerRename(): void {
  ipcMain.handle(
    "workspace:rename",
    async (event, from: string, to: string): Promise<FsResult> => {
      try {
        const root = rootFor(event);
        await fs.rename(requireInside(root, from), requireInside(root, to));
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );
}

function registerCreateFile(): void {
  ipcMain.handle(
    "workspace:create-file",
    async (event, path: string, content = ""): Promise<FsResult> => {
      try {
        const root = rootFor(event);
        const target = requireInside(root, path);
        await fs.mkdir(dirname(target), { recursive: true });
        await fs.writeFile(target, content, "utf8");
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );
}

function registerApplyFileChanges(): void {
  ipcMain.handle("workspace:apply-file-changes", async (event, changes: WorkspaceFileChange[]): Promise<FsResult> => {
    const root = rootFor(event);
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > 80) {
      return { success: false, error: "The proposed change set is empty or too large." };
    }
    const staged: Array<{ target: string; temp: string; backup: Buffer | null }> = [];
    const committed: Array<{ target: string; backup: Buffer | null }> = [];
    try {
      const seen = new Set<string>();
      for (const change of changes) {
        if (!change || typeof change.path !== "string" || typeof change.content !== "string") {
          throw new Error("Invalid file change payload.");
        }
        const target = requireInside(root, join(root, change.path));
        const key = process.platform === "win32" ? target.toLowerCase() : target;
        if (seen.has(key)) throw new Error(`Duplicate change target: ${change.path}`);
        seen.add(key);
        const realRoot = await fs.realpath(root);
        let existingParent = dirname(target);
        while (true) {
          try { await fs.access(existingParent); break; }
          catch {
            const next = dirname(existingParent);
            if (next === existingParent) throw new Error(`Could not resolve parent directory for ${change.path}`);
            existingParent = next;
          }
        }
        const realExistingParent = await fs.realpath(existingParent);
        requireInside(realRoot, join(realExistingParent, "__xvie_probe__"));
        await fs.mkdir(dirname(target), { recursive: true });
        const parent = await fs.realpath(dirname(target));
        requireInside(realRoot, join(parent, "__xvie_probe__"));
        let backup: Buffer | null = null;
        try {
          const stat = await fs.lstat(target);
          if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Refusing to replace a non-regular file: ${change.path}`);
          backup = await fs.readFile(target);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        const actualHash = backup ? createHash("sha256").update(backup).digest("hex") : null;
        if (actualHash !== change.expectedHash) throw new Error(`File changed since review: ${change.path}`);
        const temp = `${target}.xvie-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
        await fs.writeFile(temp, change.content, { encoding: "utf8", flag: "wx" });
        staged.push({ target, temp, backup });
      }
      for (const item of staged) {
        await fs.rename(item.temp, item.target);
        committed.push(item);
      }
      event.sender.send("workspace:changed", root);
      return { success: true };
    } catch (err) {
      for (const item of staged) {
        try { await fs.rm(item.temp, { force: true }); } catch { /* best effort cleanup */ }
      }
      for (const item of committed.reverse()) {
        try {
          if (item.backup === null) await fs.rm(item.target, { force: true });
          else await fs.writeFile(item.target, item.backup);
        } catch { /* best effort rollback */ }
      }
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

function registerCreateFolder(): void {
  ipcMain.handle(
    "workspace:create-folder",
    async (event, path: string): Promise<FsResult> => {
      try {
        const root = rootFor(event);
        await fs.mkdir(requireInside(root, path), { recursive: true });
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );
}

function registerDelete(): void {
  ipcMain.handle(
    "workspace:delete",
    async (event, path: string): Promise<FsResult> => {
      try {
        const root = rootFor(event);
        await fs.rm(requireInside(root, path), { recursive: true, force: true });
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );
}

function registerSetRootDev(): void {
  ipcMain.handle("workspace:set-root-dev", async (event, path: string): Promise<FsResult> => {
    if (app.isPackaged) {
      return { success: false, error: "Only available in development." };
    }
    if (typeof path !== "string" || !path.trim()) {
      return { success: false, error: "A valid path is required." };
    }
    try {
      const normalized = normalize(resolve(path));
      const stat = await fs.stat(normalized);
      if (!stat.isDirectory()) return { success: false, error: "The selected project path is not a folder." };
      openRoots.set(event.sender.id, normalized);
      event.sender.once("destroyed", () => openRoots.delete(event.sender.id));
      return { success: true };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return { success: false, error: code === "ENOENT" ? "This recent project folder no longer exists. Choose or open a valid project folder." : err instanceof Error ? err.message : String(err) };
    }
  });
}

function registerWatch(): void {
  ipcMain.handle("workspace:watch", (event) => {
    const root = rootFor(event);
    const send = (path: string): void => {
      if (!event.sender.isDestroyed()) {
        event.sender.send("workspace:changed", path);
      }
    };

    const controller = new AbortController();
    let timer: NodeJS.Timeout | null = null;
    const onEvent = (changePath: string | null): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => send(changePath ? normalize(changePath) : normalize(root)), WATCH_DEBOUNCE_MS);
    };

    void (async () => {
      try {
        const watcher = fs.watch(root, { recursive: true, signal: controller.signal });
        for await (const event of watcher) {
          if (event.eventType === "rename") {
            const filename = event.filename;
            onEvent(filename ? join(root, filename.toString()) : null);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) onEvent(null);
      }
    })();

    event.sender.once("destroyed", () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    });

    return { ok: true as const };
  });
}

export function registerWorkspaceHandlers(): void {
  registerOpenFolder();
  registerOpenPath();
  registerScanDir();
  registerReadFile();
  registerReadBinary();
  registerWriteBinary();
  registerOpenExternal();
  registerRename();
  registerCreateFile();
  registerApplyFileChanges();
  registerCreateFolder();
  registerDelete();
  registerWatch();
  registerSetRootDev();
}
