import {
  SquareSplitHorizontal,
  SquareSplitVertical,
  SquareTerminal,
  X,
  Code2,
  Eye,
  Columns2,
  Table2,
  Globe
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/shared/lib/utils";
import {
  useEditorStore,
  type MarkdownViewMode,
  type SplitDirection
} from "@/Editor/editorStore";
import FileIcon from "@/Editor/icons/FileIcon";
import { setEditorDragPayload } from "@/Editor/Middle/drop-zones";
import { isCsvFile } from "@/Editor/documents/documentKinds";
import { useTerminalStore } from "@/Terminal/terminalStore";
import { TERMINAL_DND_MIME } from "@/Terminal/terminalTypes";
import { isTerminalTab, terminalIdOfTab } from "@/Terminal/terminalTab";

interface EditorTabsProps {
  groupId: string;
}

/** A terminal living as an editor tab — drags/moves like a file tab. */
function EditorTerminalChip({
  tab,
  groupId,
  active,
  isGroupActive
}: {
  tab: string;
  groupId: string;
  active: boolean;
  isGroupActive: boolean;
}): React.JSX.Element {
  const terminalId = terminalIdOfTab(tab);
  const session = useTerminalStore((state) => state.terminals.find((t) => t.id === terminalId));
  const setDragging = useTerminalStore((state) => state.setDragging);
  const name = session?.name ?? "Terminal";
  const exited = !session || session.status === "exited";

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onMouseDown={() => {
        useEditorStore.getState().setActiveGroup(groupId);
        useEditorStore.getState().setGroupActiveFile(groupId, tab);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          useEditorStore.getState().setGroupActiveFile(groupId, tab);
        }
      }}
      onDragStart={(event) => {
        setEditorDragPayload({ kind: "terminal", terminalId, fromGroupId: groupId });
        try {
          event.dataTransfer.setData(TERMINAL_DND_MIME, terminalId);
          event.dataTransfer.setData("text/plain", name);
        } catch {
          // store mirror is the fallback
        }
        event.dataTransfer.effectAllowed = "move";
        setDragging(terminalId);
      }}
      onDragEnd={() => {
        setEditorDragPayload(null);
        setDragging(null);
      }}
      title={`${name} — drag to another group, or back to the panel to dock`}
      className={cn(
        "group flex h-7 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-lg px-2.5 font-label-md text-label-md transition-colors duration-150",
        active
          ? isGroupActive
            ? "bg-surface-container-high font-bold text-primary"
            : "bg-surface-container-low font-bold text-primary/70"
          : "text-secondary hover:bg-surface-container-low hover:text-primary"
      )}
    >
      <SquareTerminal size={13} className="shrink-0" />
      <span className="truncate">{name}</span>
      {exited && <span className="shrink-0 text-[10px] text-error">(exited)</span>}
      <button
        type="button"
        aria-label={`Close ${name}`}
        title="Close terminal"
        onClick={(event) => {
          event.stopPropagation();
          useEditorStore.getState().closeTab(tab, groupId);
        }}
        className={cn(
          "ml-0.5 shrink-0 cursor-pointer rounded p-0.5 transition-all hover:bg-surface-variant",
          active ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-60"
        )}
      >
        <X size={11} />
      </button>
    </div>
  );
}

export default function EditorTabs({ groupId }: EditorTabsProps): React.JSX.Element {
  const [htmlOpenError, setHtmlOpenError] = useState("");
  const group = useEditorStore((state) => state.groups[groupId]);
  const activeGroupId = useEditorStore((state) => state.activeGroupId);
  const files = useEditorStore((state) => state.files);
  const setActiveGroup = useEditorStore((state) => state.setActiveGroup);
  const setGroupActiveFile = useEditorStore((state) => state.setGroupActiveFile);
  const closeTab = useEditorStore((state) => state.closeTab);
  const closeEditorGroup = useEditorStore((state) => state.closeEditorGroup);
  const splitEditorAt = useEditorStore((state) => state.splitEditorAt);
  const setGroupMarkdownViewMode = useEditorStore((state) => state.setGroupMarkdownViewMode);
  const setGroupCsvViewMode = useEditorStore((state) => state.setGroupCsvViewMode);

  if (!group) return <div className="h-10 shrink-0 border-b border-outline-variant" />;

  const tabs = group.tabs;
  const activeFile = group.activeFile;
  const markdownViewMode = group.markdownViewMode;
  const csvViewMode = group.csvViewMode;
  const isGroupActive = activeGroupId === groupId;
  const activeIsMarkdown = Boolean(
    activeFile &&
      files[activeFile]?.languageId === "markdown" &&
      !files[activeFile]?.binary
  );
  const activeIsCsv = Boolean(activeFile && !files[activeFile]?.binary && isCsvFile(activeFile));
  const activeIsHtml = Boolean(activeFile && !files[activeFile]?.binary && /\.html?$/i.test(activeFile));

  const openHtmlInBrowser = async (): Promise<void> => {
    setHtmlOpenError("");
    try {
      const file = files[activeFile];
      if (file?.dirty) {
        const saved = await window.api.workspace.createFile(activeFile, file.content);
        if (!saved.success) {
          setHtmlOpenError(saved.error);
          return;
        }
        useEditorStore.setState((state) => {
          const current = state.files[activeFile];
          return current?.content === file.content
            ? { files: { ...state.files, [activeFile]: { ...current, dirty: false } } }
            : state;
        });
      }
      const opened = await window.api.workspace.openExternal(activeFile);
      if (!opened.success) setHtmlOpenError(opened.error);
    } catch (error) {
      setHtmlOpenError(error instanceof Error ? error.message : String(error));
    }
  };

  const split = (direction: SplitDirection): void => {
    splitEditorAt(groupId, direction);
  };

  return (
    <div className="flex h-10 shrink-0 items-center border-b border-outline-variant px-2">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
      {tabs.map((path) => {
        if (isTerminalTab(path)) {
          return (
            <EditorTerminalChip key={path} tab={path} groupId={groupId} active={activeFile === path} isGroupActive={isGroupActive} />
          );
        }
        const file = files[path];
        const active = activeFile === path;
        return (
          <div
            key={path}
            role="button"
            tabIndex={0}
            draggable
            onMouseDown={() => {
              setActiveGroup(groupId);
              if (activeFile !== path) setGroupActiveFile(groupId, path);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") setGroupActiveFile(groupId, path);
            }}
            onDragStart={(event) => {
              setEditorDragPayload({ kind: "tab", path, fromGroupId: groupId });
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", path);
            }}
            onDragEnd={() => setEditorDragPayload(null)}
            className={cn(
              "group flex h-7 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-lg px-2.5 font-label-md text-label-md transition-colors duration-150",
              active
                ? isGroupActive
                  ? "bg-surface-container-high font-bold text-primary"
                  : "bg-surface-container-low font-bold text-primary/70"
                : "text-secondary hover:bg-surface-container-low hover:text-primary"
            )}
          >
            <FileIcon
              name={file?.name ?? path}
              path={path}
              isSymlink={file?.isSymlink}
              size={13}
            />
            <span className="truncate">{file?.name ?? path}</span>
            {file?.dirty ? (
              <span
                aria-label="Unsaved changes"
                className="ml-0.5 h-2 w-2 shrink-0 rounded-full bg-editor-text-bright"
              />
            ) : (
              <button
                type="button"
                aria-label={`Close ${file?.name ?? path}`}
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(path, groupId);
                }}
                className={cn(
                  "ml-0.5 shrink-0 cursor-pointer rounded p-0.5 transition-all hover:bg-surface-variant",
                  active ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-60"
                )}
              >
                <X size={11} />
              </button>
            )}
          </div>
        );
      })}
      {tabs.length === 0 && (
        <span className="px-2 font-label-sm text-label-sm text-secondary/40">
          No editors open
        </span>
      )}
      </div>
      <div className="ml-2 flex shrink-0 items-center gap-0.5">
        {activeIsHtml && (
          <button
            type="button"
            title={htmlOpenError || "Open HTML file in your browser"}
            aria-label="Open HTML file in browser"
            onClick={() => void openHtmlInBrowser()}
            className={cn("cursor-pointer rounded-lg p-1.5 transition-colors hover:bg-surface-container-low", htmlOpenError ? "text-red-400" : "text-secondary hover:text-primary")}
          >
            <Globe size={14} strokeWidth={1.8} />
          </button>
        )}
        {activeIsMarkdown && (
          <div className="mr-1 flex items-center gap-0.5 rounded-lg border border-outline-variant/60 p-0.5">
            {(
              [
                { mode: "source" as MarkdownViewMode, icon: Code2, label: "Source" },
                { mode: "preview" as MarkdownViewMode, icon: Eye, label: "Preview" },
                { mode: "split" as MarkdownViewMode, icon: Columns2, label: "Split" }
              ] as const
            ).map(({ mode, icon: Icon, label }) => (
              <button
                key={mode}
                type="button"
                aria-label={label}
                aria-pressed={markdownViewMode === mode}
                onClick={() => setGroupMarkdownViewMode(groupId, mode)}
                className={cn(
                  "cursor-pointer rounded-md p-1 transition-colors",
                  markdownViewMode === mode
                    ? "bg-surface-container-high text-primary"
                    : "text-secondary hover:bg-surface-container-low hover:text-primary"
                )}
              >
                <Icon size={14} strokeWidth={1.8} />
              </button>
            ))}
          </div>
        )}
        {activeIsCsv && (
          <div className="mr-1 flex items-center gap-0.5 rounded-lg border border-outline-variant/60 p-0.5">
            {(
              [
                { mode: "grid", icon: Table2, label: "Grid" },
                { mode: "source", icon: Code2, label: "Source" }
              ] as const
            ).map(({ mode, icon: Icon, label }) => (
              <button
                key={mode}
                type="button"
                aria-label={label}
                aria-pressed={csvViewMode === mode}
                onClick={() => setGroupCsvViewMode(groupId, mode)}
                className={cn(
                  "cursor-pointer rounded-md p-1 transition-colors",
                  csvViewMode === mode
                    ? "bg-surface-container-high text-primary"
                    : "text-secondary hover:bg-surface-container-low hover:text-primary"
                )}
              >
                <Icon size={14} strokeWidth={1.8} />
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          title="Split editor right"
          aria-label="Split editor right"
          onClick={() => split("column")}
          className="cursor-pointer rounded-lg p-1.5 text-secondary transition-colors hover:bg-surface-container-low hover:text-primary"
        >
          <SquareSplitHorizontal size={14} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          title="Split editor down"
          aria-label="Split editor down"
          onClick={() => split("row")}
          className="cursor-pointer rounded-lg p-1.5 text-secondary transition-colors hover:bg-surface-container-low hover:text-primary"
        >
          <SquareSplitVertical size={14} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          title="Close editor group"
          aria-label="Close editor group"
          onClick={() => closeEditorGroup(groupId)}
          className="cursor-pointer rounded-lg p-1.5 text-secondary transition-colors hover:bg-surface-container-low hover:text-primary"
        >
          <X size={14} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  );
}
