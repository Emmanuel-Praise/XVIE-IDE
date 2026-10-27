import { useEffect, useState } from "react";
import { ArrowUpFromLine, Plus, SquareTerminal, Trash2, X } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { useTerminalStore } from "./terminalStore";
import { TERMINAL_DND_MIME } from "./terminalTypes";
import TerminalView from "./TerminalView";
import { useFileSystemStore } from "@/Editor/fs/fileSystemStore";
import { useEditorStore } from "@/Editor/editorStore";
import { setEditorDragPayload } from "@/Editor/Middle/drop-zones";

const SHELL_OPTIONS = [
  { value: "auto", label: "Default shell" },
  { value: "powershell.exe", label: "PowerShell" },
  { value: "pwsh.exe", label: "PowerShell 7" },
  { value: "cmd.exe", label: "CMD" },
  { value: "bash", label: "Bash" }
];

function TabChip({ id, active }: { id: string; active: boolean }): React.JSX.Element {
  const session = useTerminalStore((s) => s.terminals.find((t) => t.id === id));
  const setActive = useTerminalStore((s) => s.setActive);
  const closeTerminal = useTerminalStore((s) => s.closeTerminal);
  const setDragging = useTerminalStore((s) => s.setDragging);
  if (!session) return <></>;
  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onMouseDown={() => setActive(id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") setActive(id);
      }}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        try {
          event.dataTransfer.setData(TERMINAL_DND_MIME, id);
          event.dataTransfer.setData("text/plain", session.name);
        } catch {
          // Some hosts restrict setData — the store mirror is the fallback.
        }
        // Lights up the editor groups' native drop indicators.
        setEditorDragPayload({ kind: "terminal", terminalId: id });
        setDragging(id);
      }}
      onDragEnd={() => {
        setEditorDragPayload(null);
        setDragging(null);
      }}
      title={`${session.name} — drag into the editor to open as a tab`}
      className={cn(
        "group flex h-6 max-w-40 shrink-0 cursor-grab items-center gap-1.5 rounded-md px-2 font-label-sm text-label-sm transition-colors active:cursor-grabbing",
        active
          ? "bg-surface-container-high font-bold text-primary"
          : "text-secondary hover:bg-surface-container-lowest/60 hover:text-primary"
      )}
    >
      <SquareTerminal size={12} className="shrink-0" />
      <span className="truncate">{session.name}</span>
      {session.status === "exited" && (
        <span className="shrink-0 text-[10px] text-error">(exited)</span>
      )}
      <button
        type="button"
        aria-label={`Close ${session.name}`}
        onClick={(event) => {
          event.stopPropagation();
          closeTerminal(id);
        }}
        className="shrink-0 cursor-pointer rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-70 hover:opacity-100"
      >
        <X size={11} />
      </button>
    </div>
  );
}

/** Bottom-panel terminal: multi tabs, draggable to the main area. */
export default function TerminalPanel(): React.JSX.Element {
  const terminals = useTerminalStore((s) => s.terminals);
  const activeId = useTerminalStore((s) => s.activeId);
  const creating = useTerminalStore((s) => s.creating);
  const createTerminal = useTerminalStore((s) => s.createTerminal);
  const setActive = useTerminalStore((s) => s.setActive);
  const clearOutput = useTerminalStore((s) => s.clearOutput);
  const ensureListener = useTerminalStore((s) => s.ensureListener);
  const shellPref = useTerminalStore((s) => s.shellPref);
  const setShellPref = useTerminalStore((s) => s.setShellPref);
  const lastError = useTerminalStore((s) => s.lastError);
  const clearError = useTerminalStore((s) => s.clearError);
  const workspacePath = useFileSystemStore((s) => s.workspace?.path);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    ensureListener();
  }, [ensureListener]);

  // Lazily boot one shell so the panel is never an empty mock.
  useEffect(() => {
    if (terminals.length === 0 && !creating) void createTerminal(workspacePath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const panelTerms = terminals.filter((t) => t.location === "panel");
  const activePanelId =
    panelTerms.some((t) => t.id === activeId) ? activeId : (panelTerms[0]?.id ?? null);

  useEffect(() => {
    if (activePanelId && activePanelId !== activeId) setActive(activePanelId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePanelId]);

  const spawn = (): void => {
    void createTerminal(workspacePath);
  };

  return (
    <div
      className={cn("flex h-full min-h-0 flex-col", dragOver && "outline-1 outline-primary/40")}
      onDragOver={(event) => {
        if (
          event.dataTransfer.types.includes(TERMINAL_DND_MIME) ||
          useTerminalStore.getState().draggingId
        ) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.stopPropagation();
        let id = "";
        try {
          id = event.dataTransfer.getData(TERMINAL_DND_MIME);
        } catch {
          // fall through to the store mirror
        }
        id ||= useTerminalStore.getState().draggingId ?? "";
        setDragOver(false);
        if (id) {
          event.preventDefault();
          // Removes any editor tabs for it and docks it back here.
          useEditorStore.getState().dockTerminalToPanel(id);
        }
      }}
    >
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-outline-variant/60 px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {panelTerms.map((t) => (
            <TabChip key={t.id} id={t.id} active={t.id === activePanelId} />
          ))}
          {panelTerms.length === 0 && (
            <span className="px-1 font-label-sm text-label-sm text-secondary/50">
              No terminal here — drag one back or create a new one
            </span>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <select
            aria-label="Terminal shell"
            title="Shell for new terminals"
            value={shellPref}
            onChange={(event) => setShellPref(event.target.value)}
            className="max-w-24 cursor-pointer truncate rounded bg-transparent px-1 py-1 font-label-sm text-label-sm text-secondary outline-none transition-colors hover:text-primary"
          >
            {SHELL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-label="New terminal"
            title="New terminal"
            onClick={spawn}
            disabled={creating}
            className="cursor-pointer rounded p-1.5 text-secondary transition-colors hover:bg-surface-container-lowest hover:text-primary disabled:opacity-40"
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            aria-label="Clear active terminal"
            title="Clear active terminal"
            onClick={() => activePanelId && clearOutput(activePanelId)}
            className="cursor-pointer rounded p-1.5 text-secondary transition-colors hover:bg-surface-container-lowest hover:text-primary"
          >
            <Trash2 size={14} />
          </button>
          <button
            type="button"
            aria-label="Open terminal as editor tab"
            title="Open as editor tab (or drag the tab into the editor)"
            onClick={() =>
              activePanelId &&
              useEditorStore.getState().openTerminalTab(activePanelId)
            }
            className="cursor-pointer rounded p-1.5 text-secondary transition-colors hover:bg-surface-container-lowest hover:text-primary"
          >
            <ArrowUpFromLine size={14} />
          </button>
        </div>
      </div>
      {lastError && (
        <button
          type="button"
          onClick={clearError}
          title="Dismiss"
          className="shrink-0 cursor-pointer truncate border-b border-error/30 bg-error/10 px-3 py-1 text-left font-label-sm text-label-sm text-error"
        >
          Failed to start shell: {lastError} — click to dismiss
        </button>
      )}
      <div className="relative min-h-0 flex-1">
        {panelTerms.map((t) => (
          <div
            key={t.id}
            className={t.id === activePanelId ? "absolute inset-0" : "hidden"}
          >
            <TerminalView id={t.id} />
          </div>
        ))}
        {panelTerms.length === 0 && (
          <div className="flex h-full items-center justify-center p-4 text-center">
            <button
              type="button"
              onClick={spawn}
              className="cursor-pointer rounded-lg border border-dashed border-outline-variant px-4 py-2 font-label-sm text-label-sm text-secondary transition-colors hover:text-primary"
            >
              {creating ? "Starting shell…" : "+ New terminal"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
