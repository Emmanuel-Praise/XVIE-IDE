import { ChevronRight, Home, SquareTerminal } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { useEditorStore } from "@/Editor/editorStore";
import { useFileSystemStore } from "@/Editor/fs/fileSystemStore";
import { useTerminalStore } from "@/Terminal/terminalStore";
import { isTerminalTab, terminalIdOfTab } from "@/Terminal/terminalTab";

interface EditorBreadcrumbsProps {
  groupId: string;
}

export default function EditorBreadcrumbs({ groupId }: EditorBreadcrumbsProps): React.JSX.Element | null {
  const activeFile = useEditorStore(
    (state) => state.groups[groupId]?.activeFile ?? ""
  );
  const workspaceName = useFileSystemStore((state) => state.workspace?.name);
  const terminalName = useTerminalStore((state) =>
    isTerminalTab(activeFile)
      ? (state.terminals.find((t) => t.id === terminalIdOfTab(activeFile))?.name ?? "Terminal")
      : null
  );

  if (!activeFile) {
    return null;
  }

  if (isTerminalTab(activeFile)) {
    return (
      <div className="flex h-7 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-outline-variant px-4">
        <SquareTerminal size={11} className="shrink-0 text-secondary" />
        <span className="truncate font-label-sm text-label-sm font-bold text-primary">
          {terminalName ?? "Terminal"}
        </span>
      </div>
    );
  }

  const parts = activeFile ? activeFile.split(/[\\/]/).filter(Boolean) : [];
  const root = workspaceName ?? parts[0] ?? "Workspace";
  const relative = workspaceName ? parts : parts.slice(1);

  return (
    <div className="flex h-7 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-outline-variant px-4">
      <button
        type="button"
        className="flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 font-label-sm text-label-sm text-secondary transition-colors hover:bg-surface-container-low hover:text-primary"
      >
        <Home size={11} />
        {root}
      </button>
      {relative.map((part, index) => {
        const last = index === relative.length - 1;
        return (
          <span key={`${part}-${index}`} className="flex shrink-0 items-center gap-0.5">
            <ChevronRight size={12} className="text-on-tertiary-container" />
            <button
              type="button"
              disabled={last}
              className={cn(
                "cursor-pointer rounded px-1.5 py-0.5 font-label-sm text-label-sm transition-colors",
                last
                  ? "font-bold text-primary"
                  : "text-secondary hover:bg-surface-container-low hover:text-primary"
              )}
            >
              {part}
            </button>
          </span>
        );
      })}
    </div>
  );
}
