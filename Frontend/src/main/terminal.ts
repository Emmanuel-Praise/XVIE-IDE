import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { spawn, type ChildProcess } from "child_process";
import { homedir } from "os";
import { promises as fs } from "fs";
import type {
  TerminalCreateOptions,
  TerminalCreateResult,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalWriteResult,
} from "../shared/ipc-types";
import type * as Pty from "node-pty";

// node-pty gives us a real ConPTY/pseudoterminal (cursor addressing, colors,
// raw mode) so full-screen TUIs like opencode/vim work. If the native module
// can't load, fall back to plain pipes (normal commands still work).
let ptyModule: typeof Pty | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ptyModule = require("node-pty") as typeof Pty;
} catch {
  ptyModule = null;
}

type SessionProc =
  | { kind: "pty"; proc: Pty.IPty }
  | { kind: "pipe"; proc: ChildProcess };

interface TerminalRecord {
  id: string;
  session: SessionProc;
  senderId: number;
}

const terminals = new Map<string, TerminalRecord>();
const MAX_TERMINALS = 12;

function makeId(): string {
  return `term-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultShell(): string {
  if (process.platform === "win32") return "powershell.exe";
  return process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
}

function defaultArgs(shell: string): string[] {
  const lower = shell.toLowerCase();
  if (lower.includes("powershell") || lower.includes("pwsh")) return ["-NoLogo"];
  return [];
}

async function resolveCwd(requested?: string): Promise<string> {
  const fallback = homedir();
  if (!requested || !requested.trim()) return fallback;
  try {
    const stat = await fs.stat(requested);
    if (stat.isDirectory()) return requested;
    return fallback;
  } catch {
    return fallback;
  }
}

function sendToSender(senderId: number, channel: string, payload: unknown): void {
  try {
    const win = BrowserWindow.getAllWindows().find(
      (w) => w.webContents.id === senderId
    );
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  } catch {
    // best effort — renderer may have been closed
  }
}

function emitData(senderId: number, sender: Electron.WebContents, payload: TerminalDataEvent): void {
  if (!sender.isDestroyed()) sender.send("terminal:data", payload);
  else sendToSender(senderId, "terminal:data", payload);
}

function emitExit(senderId: number, sender: Electron.WebContents, payload: TerminalExitEvent): void {
  try {
    if (!sender.isDestroyed()) sender.send("terminal:exit", payload);
    else sendToSender(senderId, "terminal:exit", payload);
  } catch {
    // ignore
  }
}

function killRecord(record: TerminalRecord): void {
  try {
    record.session.proc.kill();
  } catch {
    // ignore — process may already be gone
  }
}

function registerCreate(): void {
  ipcMain.handle(
    "terminal:create",
    async (
      event: IpcMainInvokeEvent,
      options: TerminalCreateOptions = {}
    ): Promise<TerminalCreateResult> => {
      try {
        if (terminals.size >= MAX_TERMINALS) {
          return { success: false, error: "Too many terminals open. Close one first." };
        }
        const shell = options.shell?.trim() || defaultShell();
        const cwd = await resolveCwd(options.cwd);
        const id = makeId();
        const args = options.args ?? defaultArgs(shell);
        const senderId = event.sender.id;

        if (ptyModule) {
          let proc: Pty.IPty;
          try {
            proc = ptyModule.spawn(shell, args, {
              name: "xterm-256color",
              cols: 80,
              rows: 30,
              cwd,
              env: { ...process.env } as Record<string, string>
            });
          } catch (err) {
            return {
              success: false,
              error: err instanceof Error ? err.message : String(err)
            };
          }
          const record: TerminalRecord = { id, session: { kind: "pty", proc }, senderId };
          terminals.set(id, record);
          proc.onData((data: string) => {
            emitData(senderId, event.sender, { id, data });
          });
          proc.onExit(({ exitCode }) => {
            emitExit(senderId, event.sender, { id, code: exitCode });
          });
          hookDestroyed(event, senderId);
          return { success: true, id, shell, cwd };
        }

        // Fallback: plain pipes (no TUI support, but normal commands work).
        const proc = spawn(shell, args, {
          cwd,
          env: {
            ...process.env,
            PYTHONUNBUFFERED: "1",
            TERM: process.env.TERM || "dumb"
          },
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"]
        });

        if (!proc.stdout || !proc.stderr || !proc.stdin) {
          return { success: false, error: "Unable to start shell (stdio unavailable)." };
        }

        proc.stdout.setEncoding("utf8");
        proc.stderr.setEncoding("utf8");

        const record: TerminalRecord = { id, session: { kind: "pipe", proc }, senderId };
        terminals.set(id, record);

        proc.stdout.on("data", (chunk: string) => {
          emitData(senderId, event.sender, { id, data: String(chunk) });
        });
        proc.stderr.on("data", (chunk: string) => {
          emitData(senderId, event.sender, { id, data: String(chunk) });
        });
        proc.on("error", (err) => {
          emitData(senderId, event.sender, {
            id,
            data: `\r\n[terminal] failed to start: ${err.message}\r\n`
          });
        });
        proc.on("close", (code) => {
          emitExit(senderId, event.sender, { id, code: code ?? 0 });
        });

        hookDestroyed(event, senderId);
        return { success: true, id, shell, cwd };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );
}

function hookDestroyed(event: IpcMainInvokeEvent, senderId: number): void {
  event.sender.once("destroyed", () => {
    // Kill terminals owned by a destroyed renderer.
    for (const [tid, rec] of terminals) {
      if (rec.senderId === senderId) {
        killRecord(rec);
        terminals.delete(tid);
      }
    }
  });
}

function registerWrite(): void {
  ipcMain.handle(
    "terminal:write",
    async (
      _event: IpcMainInvokeEvent,
      id: string,
      data: string
    ): Promise<TerminalWriteResult> => {
      const record = terminals.get(id);
      if (!record) return { success: false, error: "Terminal not found." };
      try {
        if (record.session.kind === "pty") {
          record.session.proc.write(data);
        } else {
          record.session.proc.stdin?.write(data);
        }
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );
}

function registerResize(): void {
  ipcMain.handle(
    "terminal:resize",
    async (
      _event: IpcMainInvokeEvent,
      id: string,
      cols: number,
      rows: number
    ): Promise<TerminalWriteResult> => {
      const record = terminals.get(id);
      if (!record) return { success: false, error: "Terminal not found." };
      try {
        if (record.session.kind === "pty") {
          const c = Math.max(2, Math.min(500, Math.floor(cols) || 80));
          const r = Math.max(2, Math.min(200, Math.floor(rows) || 30));
          record.session.proc.resize(c, r);
        }
        // Plain pipes have no window size — accept silently for API stability.
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );
}

function registerKill(): void {
  ipcMain.handle(
    "terminal:kill",
    async (_event: IpcMainInvokeEvent, id: string): Promise<TerminalWriteResult> => {
      const record = terminals.get(id);
      if (!record) return { success: true };
      killRecord(record);
      terminals.delete(id);
      return { success: true };
    }
  );
}

export function registerTerminalHandlers(): void {
  registerCreate();
  registerWrite();
  registerResize();
  registerKill();
}
