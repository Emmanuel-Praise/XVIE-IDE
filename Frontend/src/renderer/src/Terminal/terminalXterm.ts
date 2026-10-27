import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useThemeStore } from "@/theme/themeStore";

/**
 * Module-level xterm.js registry. Terminal instances live OUTSIDE React so a
 * session survives unmount/remount — e.g. dragging its tab between the bottom
 * panel and an editor group just re-attaches the same live terminal.
 *
 * IMPORTANT: xterm's `open()` is a no-op for an already-opened terminal, so
 * re-attaching is done by moving `term.element` into the new host instead.
 */

interface XtermEntry {
  term: Terminal;
  fit: FitAddon;
  host: HTMLElement | null;
}

const entries = new Map<string, XtermEntry>();
/** Data that arrived before the view ever mounted (fast shells). */
const pending = new Map<string, string>();

const MAX_PENDING = 200_000;

const DARK_ANSI: ITheme = {
  background: "#141413",
  foreground: "#dbd9d5",
  cursor: "#f4f2ee",
  selectionBackground: "#373533",
  black: "#0d1117",
  red: "#f85149",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ff7b72",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc"
};

const LIGHT_ANSI: ITheme = {
  background: "#ffffff",
  foreground: "#1a1c1c",
  cursor: "#000000",
  selectionBackground: "#c9d6e8",
  black: "#1a1c1c",
  red: "#ba1a1a",
  green: "#098658",
  yellow: "#795e26",
  blue: "#0000ff",
  magenta: "#af00db",
  cyan: "#267f99",
  white: "#76767e",
  brightBlack: "#76767e",
  brightRed: "#e50000",
  brightGreen: "#098658",
  brightYellow: "#795e26",
  brightBlue: "#0000ff",
  brightMagenta: "#af00db",
  brightCyan: "#267f99",
  brightWhite: "#1a1c1c"
};

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Builds the xterm theme from the live app CSS tokens, so it follows light/dark mode. */
function currentTheme(): ITheme {
  const dark = document.documentElement.classList.contains("dark");
  const base = dark ? DARK_ANSI : LIGHT_ANSI;
  return {
    ...base,
    background: cssVar("--terminal-surface") || base.background,
    foreground: cssVar("--editor-text") || base.foreground,
    cursor: cssVar("--editor-text-bright") || base.cursor
  };
}

function createEntry(id: string): XtermEntry {
  const term = new Terminal({
    cursorBlink: true,
    cursorStyle: "bar",
    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
    fontSize: 12,
    lineHeight: 1.4,
    scrollback: 5000,
    theme: currentTheme()
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // Everything the user types (incl. arrows, Ctrl+C, function keys) goes
  // straight to the PTY — the shell (PSReadLine etc.) owns line editing.
  term.onData((data) => {
    window.api?.terminal.write(id, data).catch(() => undefined);
  });
  const entry: XtermEntry = { term, fit, host: null };
  entries.set(id, entry);
  return entry;
}

function reportSize(id: string, entry: XtermEntry): void {
  try {
    window.api?.terminal
      .resize(id, entry.term.cols, entry.term.rows)
      .catch(() => undefined);
  } catch {
    // backend may be momentarily unavailable — non-fatal
  }
}

let themeSyncOn = false;

/** Applies the current app theme to every live terminal; subscribes once. */
export function ensureThemeSync(): void {
  if (themeSyncOn) return;
  themeSyncOn = true;
  const apply = (): void => {
    const theme = currentTheme();
    for (const entry of entries.values()) {
      try {
        entry.term.options.theme = theme;
      } catch {
        // ignore — terminal may be mid-disposal
      }
    }
  };
  useThemeStore.subscribe(apply);
}

/** Attach (or re-attach) a session's terminal to a DOM node. */
export function attachXterm(id: string, host: HTMLElement): void {
  const entry = entries.get(id) ?? createEntry(id);
  if (entry.host !== host) {
    const live = entry.term.element;
    if (live && live.parentElement !== host) {
      // open() is a no-op for opened terminals — move the live DOM instead.
      host.appendChild(live);
    } else if (!live) {
      entry.term.open(host);
    }
    entry.host = host;
    const queued = pending.get(id);
    if (queued) {
      pending.delete(id);
      entry.term.write(queued);
    }
  }
  fitXterm(id);
  refreshXterm(id);
}

export function fitXterm(id: string): void {
  const entry = entries.get(id);
  if (!entry || !entry.host) return;
  try {
    entry.fit.fit();
    reportSize(id, entry);
  } catch {
    // host may have zero size while hidden — retry on next layout pass
  }
}

/** Forces a full repaint (needed after reparenting or un-hiding). */
export function refreshXterm(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  try {
    entry.term.refresh(0, entry.term.rows - 1);
  } catch {
    // ignore
  }
}

export function focusXterm(id: string): void {
  try {
    entries.get(id)?.term.focus();
  } catch {
    // ignore
  }
}

/** Stream backend output into the terminal (buffers if not yet mounted). */
export function writeXterm(id: string, data: string): void {
  const entry = entries.get(id);
  if (entry?.host) {
    entry.term.write(data);
    return;
  }
  // Lazily create so early output isn't lost; flushed on attach.
  if (!entry) createEntry(id);
  const prev = pending.get(id) ?? "";
  pending.set(id, (prev + data).slice(-MAX_PENDING));
}

export function clearXterm(id: string): void {
  pending.delete(id);
  try {
    entries.get(id)?.term.clear();
  } catch {
    // ignore
  }
}

export function disposeXterm(id: string): void {
  pending.delete(id);
  const entry = entries.get(id);
  if (!entry) return;
  entries.delete(id);
  try {
    entry.term.dispose();
  } catch {
    // ignore
  }
}
