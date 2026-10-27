import { create } from "zustand";
import type { TerminalLocation, TerminalSession } from "./terminalTypes";
import { clearXterm, disposeXterm, writeXterm } from "./terminalXterm";
import { useEditorStore } from "@/Editor/editorStore";

export const DEFAULT_SHELL_PREF = "auto";

export const MIN_PANEL_HEIGHT = 140;
export const MAX_PANEL_HEIGHT = 560;
export const DEFAULT_PANEL_HEIGHT = 240;

interface TerminalState {
  terminals: TerminalSession[];
  activeId: string | null;
  creating: boolean;
  /** Shell used for newly created terminals ("auto" = OS default). */
  shellPref: string;
  /** Bottom-panel terminal height in px (drag the top edge to resize). */
  panelHeight: number;
  /** True while the panel edge is being dragged (disables height animation). */
  panelResizing: boolean;
  /** Terminal tab currently being dragged (panel <-> editor). */
  draggingId: string | null;
  /** Last terminal creation error, shown in the panel. */
  lastError: string | null;
  createTerminal: (cwd?: string) => Promise<void>;
  closeTerminal: (id: string) => void;
  setActive: (id: string) => void;
  moveTerminal: (id: string, location: TerminalLocation) => void;
  clearOutput: (id: string) => void;
  setShellPref: (shell: string) => void;
  setPanelHeight: (height: number) => void;
  setPanelResizing: (resizing: boolean) => void;
  setDragging: (id: string | null) => void;
  clearError: () => void;
  ensureListener: () => void;
  resetAll: () => void;
}

let listenerAttached = false;
let terminalCounter = 0;

function sessionName(shell: string): string {
  terminalCounter += 1;
  const base = shell.split(/[\\/]/).pop()?.replace(/\.exe$/i, "") || "shell";
  return `${base} ${terminalCounter}`;
}

function activeIn(
  terminals: TerminalSession[],
  location: TerminalLocation,
  fallback: string | null
): string | null {
  if (fallback && terminals.some((t) => t.id === fallback && t.location === location)) {
    return fallback;
  }
  const first = terminals.find((t) => t.location === location);
  return first ? first.id : null;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  terminals: [],
  activeId: null,
  creating: false,
  shellPref: DEFAULT_SHELL_PREF,
  panelHeight: DEFAULT_PANEL_HEIGHT,
  panelResizing: false,
  draggingId: null,
  lastError: null,

  createTerminal: async (cwd?: string) => {
    const api = window.api?.terminal;
    if (!api) {
      set({ lastError: "Terminal bridge unavailable (not running in Electron?)." });
      return;
    }
    // Restart numbering from 1 when no terminals exist.
    if (get().terminals.length === 0) terminalCounter = 0;
    set({ creating: true, lastError: null });
    try {
      const shellPref = get().shellPref;
      const result = await api.create({
        ...(cwd ? { cwd } : {}),
        ...(shellPref !== DEFAULT_SHELL_PREF ? { shell: shellPref } : {})
      });
      if (!result.success) {
        set({ lastError: result.error });
        return;
      }
      const session: TerminalSession = {
        id: result.id,
        name: sessionName(result.shell),
        shell: result.shell,
        cwd: result.cwd,
        location: "panel",
        status: "running"
      };
      set((state) => ({
        terminals: [...state.terminals, session],
        activeId: session.id
      }));
      get().ensureListener();
    } finally {
      set({ creating: false });
    }
  },

  closeTerminal: (id: string) => {
    const api = window.api?.terminal;
    if (api) void api.kill(id).catch(() => undefined);
    disposeXterm(id);
    // Drop any editor tabs showing this terminal (deferred cross-store call).
    try {
      useEditorStore.getState().closeTerminalTabsForSession(id);
    } catch {
      // editor store may be mid-reset — non-fatal
    }
    if (get().draggingId === id) set({ draggingId: null });
    set((state) => {
      const terminals = state.terminals.filter((t) => t.id !== id);
      // Restart numbering from 1 once every terminal is gone.
      if (terminals.length === 0) terminalCounter = 0;
      const activeId =
        state.activeId === id
          ? (terminals[terminals.length - 1]?.id ?? null)
          : state.activeId;
      return { terminals, activeId };
    });
  },

  setActive: (id: string) => {
    if (get().terminals.some((t) => t.id === id)) set({ activeId: id });
  },

  moveTerminal: (id: string, location: TerminalLocation) => {
    set((state) => ({
      terminals: state.terminals.map((t) => (t.id === id ? { ...t, location } : t)),
      activeId: id,
      draggingId: null
    }));
  },

  clearOutput: (id: string) => {
    clearXterm(id);
  },

  setShellPref: (shell: string) => set({ shellPref: shell }),

  setPanelHeight: (height: number) => {
    const clamped = Math.min(MAX_PANEL_HEIGHT, Math.max(MIN_PANEL_HEIGHT, Math.round(height)));
    if (clamped !== get().panelHeight) set({ panelHeight: clamped });
  },

  setPanelResizing: (resizing: boolean) => {
    if (get().panelResizing !== resizing) set({ panelResizing: resizing });
  },

  setDragging: (id: string | null) => {
    if (get().draggingId !== id) set({ draggingId: id });
  },

  clearError: () => set({ lastError: null }),

  ensureListener: () => {
    if (listenerAttached) return;
    const api = window.api?.terminal;
    if (!api) return;
    listenerAttached = true;
    api.onData((event) => {
      writeXterm(event.id, event.data);
    });
    api.onExit((event) => {
      set((state) => ({
        terminals: state.terminals.map((t) =>
          t.id === event.id ? { ...t, status: "exited" as const, exitCode: event.code } : t
        )
      }));
      writeXterm(event.id, `\r\n[terminal] exited with code ${event.code}\r\n`);
    });
  },

  resetAll: () => {
    const { terminals } = get();
    const api = window.api?.terminal;
    if (api) {
      for (const t of terminals) void api.kill(t.id).catch(() => undefined);
    }
    for (const t of terminals) disposeXterm(t.id);
    terminalCounter = 0;
    set({ terminals: [], activeId: null, creating: false, lastError: null });
  }
}));

export function activeTerminalIdFor(location: TerminalLocation): string | null {
  const { terminals, activeId } = useTerminalStore.getState();
  return activeIn(terminals, location, activeId);
}
