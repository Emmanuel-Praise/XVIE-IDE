import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  Trash2,
  Pencil,
  Loader2
} from "lucide-react";
import { cn } from "@/shared/lib/utils";
import type { FsEntry } from "../../../../../shared/ipc-types";
import { useEditorStore } from "@/Editor/editorStore";
import { useFileSystemStore } from "@/Editor/fs/fileSystemStore";
import FileIcon from "@/Editor/icons/FileIcon";
import { folderColorFor } from "@/Editor/icons/folder-icons";
import PanelShell from "@/Editor/LeftSide/panels/panel-shell";
import { setEditorDragPayload } from "@/Editor/Middle/drop-zones";

type InlineAction =
  | { mode: "create"; kind: "file" | "folder"; dirPath: string }
  | { mode: "rename"; entry: FsEntry }
  | null;

interface ContextMenuState {
  x: number;
  y: number;
  entry: FsEntry;
}

function parentOf(path: string): string {
  const parent = path.split(/[\\/]/).slice(0, -1).join("/");
  return parent || path;
}

function InlineInput({
  action,
  depth,
  onDone
}: {
  action: NonNullable<InlineAction>;
  depth?: number;
  onDone: () => void;
}): React.JSX.Element {
  const createFile = useFileSystemStore((state) => state.createFile);
  const createFolder = useFileSystemStore((state) => state.createFolder);
  const openFile = useEditorStore((state) => state.openFile);
  const initial = action.mode === "rename" ? action.entry.name : "";
  const placeholder = action.mode === "create"
    ? action.kind === "folder"
      ? "Folder name"
      : "File name"
    : "New name";
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    if (initial) {
      const dot = initial.lastIndexOf(".");
      inputRef.current?.setSelectionRange(0, dot > 0 ? dot : initial.length);
    }
  }, [initial]);

  const commit = async (): Promise<void> => {
    const name = value.trim();
    onDone();
    if (!name) return;
    if (action.mode === "rename") {
      const target = action.entry.path;
      if (name === action.entry.name) return;
      await useEditorStore.getState().renameFile(target, `${parentOf(target)}/${name}`);
      return;
    }
    const path = `${action.dirPath}${action.dirPath.endsWith("/") ? "" : "/"}${name}`;
    if (action.kind === "file") {
      const result = await createFile(path);
      if (result.success) void openFile(path);
    } else {
      await createFolder(path);
    }
  };

  return (
    <div
      className="flex items-center gap-1.5 py-0.5 pr-2"
      style={{ paddingLeft: `${(depth ?? 0) * 14 + 8}px` }}
    >
      <span className="w-[13px] shrink-0" />
      {action.mode === "rename" ? (
        <FileIcon
          name={action.entry.name}
          path={action.entry.path}
          isDirectory={action.entry.kind === "directory"}
          open
        />
      ) : action.kind === "folder" ? (
        <FolderOpen size={15} className="shrink-0 text-primary" strokeWidth={1.8} />
      ) : (
        <FilePlus2 size={15} className="shrink-0 text-primary" strokeWidth={1.8} />
      )}
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") void commit();
          if (event.key === "Escape") onDone();
        }}
        placeholder={placeholder}
        className="w-full min-w-0 rounded border border-primary/50 bg-editor-surface-raised px-1.5 py-0.5 font-label-md text-label-md text-editor-text outline-none placeholder:text-editor-text-dim/50"
      />
    </div>
  );
}

function ContextMenu({
  state,
  onClose,
  onRename,
  onDelete,
  onCreateFile,
  onCreateFolder
}: {
  state: ContextMenuState;
  onClose: () => void;
  onRename: (entry: FsEntry) => void;
  onDelete: (entry: FsEntry) => void;
  onCreateFile: (dirPath: string) => void;
  onCreateFolder: (dirPath: string) => void;
}): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const openFile = useEditorStore((state) => state.openFile);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [onClose]);

  const isFolder = state.entry.kind === "directory";
  const canRename = !state.entry.isSymlink;

  return (
    <div
      ref={menuRef}
      className="fixed z-50 w-44 rounded-lg border border-editor-text-dim/20 bg-editor-surface-raised py-1 shadow-xl"
      style={{ left: state.x, top: state.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {!isFolder && (
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-1.5 font-label-sm text-label-sm text-editor-text hover:bg-editor-text-dim/10"
          onClick={() => {
            void openFile(state.entry.path);
            onClose();
          }}
        >
          Open
        </button>
      )}
      {isFolder && (
        <>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 font-label-sm text-label-sm text-editor-text hover:bg-editor-text-dim/10"
            onClick={() => {
              onClose();
              onCreateFile(state.entry.path);
            }}
          >
            <FilePlus2 size={13} />
            New File…
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 font-label-sm text-label-sm text-editor-text hover:bg-editor-text-dim/10"
            onClick={() => {
              onClose();
              onCreateFolder(state.entry.path);
            }}
          >
            <FolderPlus size={13} />
            New Folder…
          </button>
        </>
      )}
      {canRename && (
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-1.5 font-label-sm text-label-sm text-editor-text hover:bg-editor-text-dim/10"
          onClick={() => {
            onClose();
            onRename(state.entry);
          }}
        >
          <Pencil size={13} />
          Rename…
        </button>
      )}
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-1.5 font-label-sm text-label-sm text-red-400/90 hover:bg-red-400/10"
        onClick={() => {
          onClose();
          onDelete(state.entry);
        }}
      >
        <Trash2 size={13} />
        Delete
      </button>
    </div>
  );
}

function TreeRow({
  entry,
  depth,
  onContextMenu,
  inlineAction,
  onInlineDone
}: {
  entry: FsEntry;
  depth: number;
  onContextMenu: (event: React.MouseEvent, entry: FsEntry) => void;
  inlineAction: InlineAction;
  onInlineDone: () => void;
}): React.JSX.Element {
  const expanded = useFileSystemStore((state) => state.expanded[entry.path]);
  const entries = useFileSystemStore((state) => state.entries[entry.path]);
  const loading = useFileSystemStore((state) => state.loading[entry.path]);
  const toggle = useFileSystemStore((state) => state.toggle);
  const openFile = useEditorStore((state) => state.openFile);
  const activeFace = useEditorStore((state) => {
    const group = state.groups[state.activeGroupId];
    return group?.activeFile ?? "";
  });
  const dirty = useEditorStore((state) => state.files[entry.path]?.dirty ?? false);
  const isFolder = entry.kind === "directory";
  const isOpen = Boolean(expanded);
  const active = !isFolder && activeFace === entry.path;
  const isRenaming =
    inlineAction?.mode === "rename" && inlineAction.entry.path === entry.path;
  const isCreatingHere =
    inlineAction?.mode === "create" && inlineAction.dirPath === entry.path;

  const contentHints = isFolder && entries ? entries.map((child) => child.name) : undefined;

  useEffect(() => {
    if (isFolder && entries === undefined && !loading) {
      void useFileSystemStore.getState().peek(entry.path);
    }
  }, [entry.path, isFolder, entries, loading]);

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          if (isFolder) {
            void toggle(entry.path);
          } else {
            void openFile(entry.path);
          }
        }}
        onContextMenu={(event) => onContextMenu(event, entry)}
        draggable={!isFolder}
        onDragStart={(event) => {
          if (isFolder) {
            event.preventDefault();
            return;
          }
          setEditorDragPayload({ kind: "file", path: entry.path });
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", entry.path);
        }}
        onDragEnd={() => setEditorDragPayload(null)}
        className={cn(
          "flex w-full cursor-pointer items-center gap-1.5 py-1 pr-2 font-label-md text-label-md transition-colors duration-100",
          active
            ? "bg-editor-text-dim/15 text-editor-text"
            : "text-editor-text-dim hover:bg-editor-text-dim/10 hover:text-editor-text"
        )}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        {isFolder ? (
          isOpen ? (
            <ChevronDown size={13} className="shrink-0" />
          ) : (
            <ChevronRight size={13} className="shrink-0" />
          )
        ) : (
          <span className="w-[13px] shrink-0" />
        )}
        <FileIcon
          name={entry.name}
          path={entry.path}
          isDirectory={isFolder}
          open={isOpen}
          isSymlink={entry.isSymlink}
          contentHints={contentHints}
        />
        <span
          className={cn(
            "truncate transition-colors duration-100",
            !isFolder && "text-inherit"
          )}
          style={isFolder ? { color: folderColorFor(entry.name) } : undefined}
        >
          {entry.name}
        </span>
        {dirty && (
          <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-editor-text-bright" />
        )}
        {isFolder && loading && (
          <Loader2 size={11} className="ml-auto shrink-0 animate-spin text-editor-text-dim/60" />
        )}
      </button>
      {isRenaming && (
        <InlineInput
          action={inlineAction}
          depth={depth}
          onDone={onInlineDone}
        />
      )}
      {isCreatingHere && (
        <InlineInput
          action={inlineAction}
          depth={depth + 1}
          onDone={onInlineDone}
        />
      )}
      {isFolder && isOpen && (
        <div>
          {entries?.map((child) => (
            <TreeRow
              key={child.path}
              entry={child}
              depth={depth + 1}
              onContextMenu={onContextMenu}
              inlineAction={inlineAction}
              onInlineDone={onInlineDone}
            />
          ))}
          {entries === undefined && !loading && (
            <div className="py-1 pl-[26px] pr-2 font-label-sm text-label-sm text-editor-text-dim/60">
              Loading…
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ExplorerPanel(): React.JSX.Element {
  const workspace = useFileSystemStore((state) => state.workspace);
  const opening = useFileSystemStore((state) => state.opening);
  const openWorkspace = useFileSystemStore((state) => state.openWorkspace);
  const rootEntries = useFileSystemStore((state) =>
    state.workspace ? state.entries[state.workspace.path] : undefined
  );
  const expanded = useFileSystemStore((state) => state.expanded);
  const refresh = useFileSystemStore((state) => state.refresh);
  const collapseAll = useFileSystemStore((state) => state.collapseAll);
  const deleteEntry = useFileSystemStore((state) => state.deleteEntry);
  const [inline, setInline] = useState<InlineAction>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  if (!workspace) {
    return (
      <PanelShell title="Explorer">
        <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
          <FolderOpen size={22} className="text-editor-text-dim/60" strokeWidth={1.5} />
          <p className="font-body-sm text-body-sm text-editor-text-dim">
            No folder open.
            <br />
            Open one to browse its files.
          </p>
          <button
            type="button"
            onClick={() => void openWorkspace()}
            disabled={opening}
            className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-editor-text-dim/30 bg-editor-surface-raised px-3 py-1.5 font-label-sm text-label-sm text-editor-text transition-colors hover:bg-editor-text-dim/10 disabled:opacity-50"
          >
            {opening ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <FolderOpen size={12} />
            )}
            Open Folder
          </button>
        </div>
      </PanelShell>
    );
  }

  const handleContextMenu = (event: React.MouseEvent, entry: FsEntry): void => {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, entry });
  };

  const handleCreateInFolder = (dirPath: string, kind: "file" | "folder"): void => {
    if (!expanded[dirPath] && dirPath !== workspace.path) {
      void useFileSystemStore.getState().expand(dirPath);
    }
    setInline({ mode: "create", kind, dirPath });
  };

  const handleRename = (entry: FsEntry): void => {
    const dir = parentOf(entry.path);
    if (!expanded[dir] && dir !== workspace.path) void useFileSystemStore.getState().expand(dir);
    setInline({ mode: "rename", entry });
  };

  const handleDelete = (entry: FsEntry): void => {
    void deleteEntry(entry.path).then((result) => {
      if (!result.success) return;
      const store = useEditorStore.getState();
      const affected = new Set<string>();
      for (const group of Object.values(store.groups)) {
        for (const tab of group.tabs) {
          if (tab === entry.path || tab.startsWith(entry.path + "/")) affected.add(tab);
        }
      }
      for (const tab of affected) store.closeTabEverywhere(tab);
    });
  };

  return (
    <PanelShell
      title="Explorer"
      actions={
        <>
          <button
            type="button"
            aria-label="New File"
            className="cursor-pointer rounded-md p-1 text-editor-text-dim transition-colors hover:bg-editor-text-dim/10 hover:text-editor-text"
            onClick={() => setInline({ mode: "create", kind: "file", dirPath: workspace.path })}
          >
            <FilePlus2 size={15} />
          </button>
          <button
            type="button"
            aria-label="New Folder"
            className="cursor-pointer rounded-md p-1 text-editor-text-dim transition-colors hover:bg-editor-text-dim/10 hover:text-editor-text"
            onClick={() => setInline({ mode: "create", kind: "folder", dirPath: workspace.path })}
          >
            <FolderPlus size={15} />
          </button>
          <button
            type="button"
            aria-label="Refresh"
            className="cursor-pointer rounded-md p-1 text-editor-text-dim transition-colors hover:bg-editor-text-dim/10 hover:text-editor-text"
            onClick={() => {
              for (const dir of Object.keys(expanded)) {
                if (expanded[dir]) void refresh(dir);
              }
            }}
          >
            <RefreshCw size={15} />
          </button>
          <button
            type="button"
            aria-label="Collapse All"
            className="cursor-pointer rounded-md p-1 text-editor-text-dim transition-colors hover:bg-editor-text-dim/10 hover:text-editor-text"
            onClick={collapseAll}
          >
            <ChevronsDownUp size={15} />
          </button>
        </>
      }
    >
      <div className="py-2">
        <div className="flex items-center gap-1.5 px-2 pb-1 font-label-md text-label-md font-bold text-editor-text">
          <ChevronDown size={14} className="text-editor-text-dim" />
          <FileIcon
            name={workspace.name}
            path={workspace.path}
            isDirectory
            open
            contentHints={rootEntries?.map((entry) => entry.name)}
          />
          <span
            className="truncate"
            style={{ color: folderColorFor(workspace.name) }}
          >
            {workspace.name}
          </span>
        </div>
        {inline?.mode === "create" && inline.dirPath === workspace.path && (
          <InlineInput action={inline} onDone={() => setInline(null)} />
        )}
        {rootEntries?.map((entry) => (
          <TreeRow
            key={entry.path}
            entry={entry}
            depth={1}
            onContextMenu={handleContextMenu}
            inlineAction={inline}
            onInlineDone={() => setInline(null)}
          />
        ))}
        {rootEntries === undefined && (
          <div className="px-2 py-1 font-label-sm text-label-sm text-editor-text-dim/60">
            Loading…
          </div>
        )}
      </div>
      {contextMenu && (
        <ContextMenu
          state={contextMenu}
          onClose={() => setContextMenu(null)}
          onRename={handleRename}
          onDelete={handleDelete}
          onCreateFile={(dirPath) => handleCreateInFolder(dirPath, "file")}
          onCreateFolder={(dirPath) => handleCreateInFolder(dirPath, "folder")}
        />
      )}
    </PanelShell>
  );
}
