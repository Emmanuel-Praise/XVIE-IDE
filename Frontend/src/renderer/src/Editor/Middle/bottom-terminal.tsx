import { useRef, useState } from "react";
import { CircleX, Plus, SquareTerminal, Trash2, TriangleAlert, X } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { outputLines, problemItems } from "@/Editor/data/mockTerminal";
import { useEditorStore, type BottomTab } from "@/Editor/editorStore";
import {
  DEFAULT_PANEL_HEIGHT,
  useTerminalStore
} from "@/Terminal/terminalStore";
import TerminalPanel from "@/Terminal/TerminalPanel";
import { useFileSystemStore } from "@/Editor/fs/fileSystemStore";

/** Draggable top edge — pull up/down to resize the terminal panel height. */
function PanelResizer({ disabled }: { disabled: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const startY = useRef(0);
  const startH = useRef(0);
  const [dragging, setDragging] = useState(false);

  if (disabled) return <></>;

  const handlePointerDown = (event: React.PointerEvent): void => {
    event.preventDefault();
    startY.current = event.clientY;
    startH.current = useTerminalStore.getState().panelHeight;
    setDragging(true);
    useTerminalStore.getState().setPanelResizing(true);
    ref.current?.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent): void => {
    if (!ref.current?.hasPointerCapture(event.pointerId)) return;
    // Dragging up (smaller clientY) grows the panel.
    useTerminalStore
      .getState()
      .setPanelHeight(startH.current + (startY.current - event.clientY));
  };

  const handlePointerUp = (event: React.PointerEvent): void => {
    setDragging(false);
    useTerminalStore.getState().setPanelResizing(false);
    if (ref.current?.hasPointerCapture(event.pointerId)) {
      ref.current.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize terminal panel"
      title="Drag to resize (double-click to reset)"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={() => useTerminalStore.getState().setPanelHeight(DEFAULT_PANEL_HEIGHT)}
      className={cn(
        "z-10 h-1.5 shrink-0 cursor-row-resize touch-none transition-colors",
        dragging ? "bg-primary" : "bg-transparent hover:bg-primary/40"
      )}
    />
  );
}

const tabs: { key: BottomTab; label: string; badge?: number }[] = [
  { key: "problems", label: "Problems", badge: problemItems.length },
  { key: "output", label: "Output" },
  { key: "terminal", label: "Terminal" },
  { key: "debug", label: "Debug Console" }
];

function ProblemsView(): React.JSX.Element {
  return (
    <div className="p-3 font-label-sm text-label-sm text-editor-text">
      {problemItems.map((problem) => (
        <div key={`${problem.source}-${problem.line}`} className="flex items-start gap-2 py-0.5">
          {problem.severity === "error" ? (
            <CircleX size={13} className="mt-0.5 shrink-0 text-error" />
          ) : (
            <TriangleAlert size={13} className="mt-0.5 shrink-0 text-editor-text-accent" />
          )}
          <span className="flex-1">{problem.message}</span>
          <span className="shrink-0 text-editor-text-dim">
            {problem.source} · line {problem.line}
          </span>
        </div>
      ))}
    </div>
  );
}

function OutputView(): React.JSX.Element {
  return (
    <div className="p-3 font-label-sm text-label-sm leading-relaxed text-editor-text">
      {outputLines.map((line, index) => (
        <div key={`${line}-${index}`}>{line}</div>
      ))}
    </div>
  );
}

function DebugView(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-3 text-center">
      <SquareTerminal size={20} className="text-editor-text-dim" strokeWidth={1.5} />
      <p className="font-body-sm text-body-sm text-editor-text-dim">
        Launch a debug session to see output here.
      </p>
    </div>
  );
}

const views: Record<Exclude<BottomTab, "terminal">, React.JSX.Element> = {
  problems: <ProblemsView />,
  output: <OutputView />,
  debug: <DebugView />
};

export default function BottomTerminal(): React.JSX.Element {
  const bottomTab = useEditorStore((state) => state.bottomTab);
  const setBottomTab = useEditorStore((state) => state.setBottomTab);
  const bottomOpen = useEditorStore((state) => state.bottomOpen);
  const setBottomOpen = useEditorStore((state) => state.setBottomOpen);
  const creating = useTerminalStore((state) => state.creating);
  const createTerminal = useTerminalStore((state) => state.createTerminal);
  const clearOutput = useTerminalStore((state) => state.clearOutput);
  const panelHeight = useTerminalStore((state) => state.panelHeight);
  const workspacePath = useFileSystemStore((state) => state.workspace?.path);
  const isTerminal = bottomTab === "terminal";

  const handleNewTerminal = (): void => {
    setBottomTab("terminal");
    setBottomOpen(true);
    void createTerminal(workspacePath).then(() => {
      const latest = useTerminalStore.getState().terminals.at(-1);
      if (latest) useTerminalStore.getState().moveTerminal(latest.id, "panel");
    });
  };

  const handleClearTerminal = (): void => {
    const { terminals, activeId } = useTerminalStore.getState();
    const activePanel = terminals.find((t) => t.id === activeId && t.location === "panel")
      ?? terminals.find((t) => t.location === "panel");
    if (activePanel) clearOutput(activePanel.id);
  };

  // While the edge is dragged the height must track the pointer 1:1 —
  // a CSS height transition would lag behind and feel "slow".
  const panelResizing = useTerminalStore((state) => state.panelResizing);

  return (
    <div
      style={bottomOpen && isTerminal ? { height: 42 + panelHeight } : undefined}
      className={cn(
        "shrink-0 overflow-hidden rounded-t-2xl border-t border-outline-variant bg-editor-chrome",
        !panelResizing && "transition-all duration-200",
        bottomOpen ? (isTerminal ? undefined : "max-h-60") : "max-h-0 border-t-0"
      )}
    >
      <PanelResizer disabled={!bottomOpen || !isTerminal} />
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-outline-variant bg-surface-container-low px-2">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => {
              setBottomTab(tab.key);
              setBottomOpen(true);
            }}
            className={cn(
              "flex cursor-pointer items-center gap-1 rounded-t-lg bg-surface-container-low px-2.5 py-1 font-label-sm text-label-sm transition-colors duration-150",
              bottomTab === tab.key
                ? "bg-surface-container-lowest font-bold text-primary"
                : "text-secondary hover:bg-surface-container-lowest/50 hover:text-primary"
            )}
          >
            {tab.label}
            {tab.badge !== undefined && (
              <span className="rounded bg-surface-container px-1 text-[10px]">
                {tab.badge}
              </span>
            )}
          </button>
        ))}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            aria-label="New terminal"
            title="New terminal"
            onClick={handleNewTerminal}
            disabled={creating}
            className="cursor-pointer rounded p-1.5 text-secondary transition-colors hover:bg-surface-container-lowest hover:text-primary disabled:opacity-40"
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            aria-label="Clear terminal"
            title="Clear active terminal"
            onClick={handleClearTerminal}
            className="cursor-pointer rounded p-1.5 text-secondary transition-colors hover:bg-surface-container-lowest hover:text-primary"
          >
            <Trash2 size={14} />
          </button>
          <button
            type="button"
            aria-label="Close panel"
            onClick={() => setBottomOpen(false)}
            className="cursor-pointer rounded p-1.5 text-secondary transition-colors hover:bg-surface-container-lowest hover:text-primary"
          >
            <X size={14} />
          </button>
        </div>
      </div>
      {isTerminal ? (
        <div className="bg-terminal-surface" style={{ height: panelHeight }}>
          <TerminalPanel />
        </div>
      ) : (
        <div className="h-44 overflow-y-auto bg-terminal-surface">{views[bottomTab]}</div>
      )}
    </div>
  );
}
