import { useEffect, useRef } from "react";
import { cn } from "@/shared/lib/utils";
import { useTerminalStore } from "./terminalStore";
import {
  attachXterm,
  ensureThemeSync,
  fitXterm,
  focusXterm,
  refreshXterm
} from "./terminalXterm";

interface TerminalViewProps {
  id: string;
  className?: string;
}

/**
 * Real terminal surface: an xterm.js instance bound to the session's PTY.
 * All keyboard input flows straight to the shell, so interactive TUIs
 * (opencode, vim, prompts) work exactly like a normal terminal.
 */
export default function TerminalView({ id, className }: TerminalViewProps): React.JSX.Element {
  const session = useTerminalStore((state) => state.terminals.find((t) => t.id === id));
  const ensureListener = useTerminalStore((state) => state.ensureListener);
  const closeTerminal = useTerminalStore((state) => state.closeTerminal);
  const createTerminal = useTerminalStore((state) => state.createTerminal);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ensureListener();
    ensureThemeSync();
    const host = hostRef.current;
    if (!host) return;
    attachXterm(id, host);
    focusXterm(id);
    // Fit once layout settles (fonts/panel animation) and on every resize.
    // ResizeObserver callbacks are rAF-throttled: fitting re-creates the
    // canvas backing store, which is too expensive to run per event while
    // the panel edge is being dragged.
    let frame = 0;
    const fitSoon = (): void => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        fitXterm(id);
        refreshXterm(id);
      });
    };
    const settle = window.setTimeout(fitSoon, 60);
    const observer = new ResizeObserver(fitSoon);
    observer.observe(host);
    return () => {
      window.clearTimeout(settle);
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      // Intentionally keep the xterm instance alive: switching tabs only
      // hides this view, and dragging the tab elsewhere re-attaches the
      // same live shell to the new host.
    };
  }, [id, ensureListener]);

  const exited = session?.status === "exited";

  const relaunch = (): void => {
    if (!session) return;
    const cwd = session.cwd;
    closeTerminal(id);
    void createTerminal(cwd);
  };

  return (
    <div
      className={cn("flex h-full min-h-0 flex-col bg-terminal-surface", className)}
      onClick={() => focusXterm(id)}
    >
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden px-1" />
      {exited && (
        <div className="flex shrink-0 items-center gap-2 border-t border-outline-variant/60 px-3 py-1.5 font-mono text-[12px] text-editor-text-dim">
          <span>
            Shell exited{session?.exitCode !== undefined ? ` (code ${session.exitCode})` : ""}.
          </span>
          <button
            type="button"
            onClick={relaunch}
            className="cursor-pointer rounded border border-outline-variant px-2 py-0.5 text-editor-text transition-colors hover:bg-surface-container"
          >
            Relaunch
          </button>
        </div>
      )}
    </div>
  );
}
