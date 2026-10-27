import { FileCode2, FileX2, FolderOpen, Loader2, SquareTerminal, X } from "lucide-react";
import Logo from "@/Workspace/components/logo";
import { useEditorStore } from "@/Editor/editorStore";
import { useFileSystemStore } from "@/Editor/fs/fileSystemStore";
import MonacoEditor from "@/Editor/monaco/Editor";
import MarkdownPreview from "@/Editor/Middle/markdown-preview";
import DocumentViewer from "@/Editor/documents/document-viewer";
import CsvViewer from "@/Editor/documents/csv-viewer";
import { documentKindOf, isCsvFile } from "@/Editor/documents/documentKinds";
import TerminalView from "@/Terminal/TerminalView";
import { useTerminalStore } from "@/Terminal/terminalStore";
import { isTerminalTab, terminalIdOfTab } from "@/Terminal/terminalTab";

function EmptyWorkspace(): React.JSX.Element {
  const openWorkspace = useFileSystemStore((state) => state.openWorkspace);
  const opening = useFileSystemStore((state) => state.opening);

  return (
    <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-editor-surface">
      <div className="editor-dot-grid absolute inset-0 opacity-15" />
      <div className="relative z-10 flex flex-col items-center gap-5 opacity-70 select-none">
        <Logo className="h-32 w-32 grayscale" />
        <div className="text-center">
          <p className="font-headline-md text-headline-md text-editor-text">
            Open a folder to start
          </p>
          <p className="mt-1 font-body-md text-body-md text-editor-text-dim">
            Browse the real filesystem, edit with syntax highlighting
          </p>
          <button
            type="button"
            onClick={() => void openWorkspace()}
            disabled={opening}
            className="mt-5 inline-flex items-center gap-2 rounded-lg border border-editor-text-dim/30 bg-editor-surface-raised px-4 py-2 font-label-md text-label-md text-editor-text transition-colors hover:bg-editor-text-dim/10 disabled:opacity-50"
          >
            {opening ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <FolderOpen size={14} />
            )}
            Open Folder
          </button>
        </div>
      </div>
    </div>
  );
}

function SelectFileState(): React.JSX.Element {
  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-hidden bg-editor-surface">
      <div className="editor-dot-grid absolute inset-0 opacity-15" />
      <div className="relative z-10 flex flex-col items-center gap-5 opacity-35 select-none pointer-events-none">
        <Logo className="h-32 w-32 grayscale" />
        <div className="text-center">
          <p className="font-headline-md text-headline-md text-editor-text">
            Select a file to begin
          </p>
          <p className="mt-1 font-body-md text-body-md text-editor-text-dim">
            Pick any file from the explorer
          </p>
        </div>
      </div>
    </div>
  );
}

function BinaryPreview({ name, size }: { name: string; size: number }): React.JSX.Element {
  const formatted =
    size >= 1024 * 1024
      ? `${(size / (1024 * 1024)).toFixed(1)} MB`
      : size >= 1024
        ? `${(size / 1024).toFixed(1)} KB`
        : `${size} B`;

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-editor-surface">
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-editor-text-dim/40 px-10 py-12 text-center">
        <FileCode2 size={30} className="text-editor-text-dim" strokeWidth={1.5} />
        <div>
          <p className="font-headline-sm text-headline-sm text-editor-text">{name}</p>
          <p className="mt-1 font-body-sm text-body-sm text-editor-text-dim">
            Binary file, {formatted} — cannot be displayed as text
          </p>
        </div>
      </div>
    </div>
  );
}

function FileErrorState({ name, error }: { name: string; error: string }): React.JSX.Element {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-editor-surface">
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-editor-text-dim/40 px-10 py-12 text-center">
        <FileX2 size={30} className="text-editor-text-dim" strokeWidth={1.5} />
        <div>
          <p className="font-headline-sm text-headline-sm text-editor-text">{name}</p>
          <p className="mt-1 font-body-sm text-body-sm text-editor-text-dim">{error}</p>
        </div>
      </div>
    </div>
  );
}

interface EditorCanvasProps {
  groupId: string;
}

function DeadTerminalTab({ tab, groupId }: { tab: string; groupId: string }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 bg-editor-surface p-4 text-center">
      <SquareTerminal size={22} className="text-editor-text-dim" strokeWidth={1.5} />
      <p className="font-body-sm text-body-sm text-editor-text-dim">
        This terminal no longer exists.
      </p>
      <button
        type="button"
        onClick={() => useEditorStore.getState().closeTab(tab, groupId)}
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-outline-variant px-3 py-1.5 font-label-sm text-label-sm text-secondary transition-colors hover:text-primary"
      >
        <X size={13} /> Close tab
      </button>
    </div>
  );
}

export default function EditorCanvas({ groupId }: EditorCanvasProps): React.JSX.Element {
  const workspace = useFileSystemStore((state) => state.workspace);
  const activeFile = useEditorStore((state) => state.groups[groupId]?.activeFile ?? "");
  const tabs = useEditorStore((state) => state.groups[groupId]?.tabs ?? []);
  const terminals = useTerminalStore((state) => state.terminals);
  const file = useEditorStore((state) =>
    activeFile && !isTerminalTab(activeFile) ? state.files[activeFile] : undefined
  );
  const markdownViewMode = useEditorStore(
    (state) => state.groups[groupId]?.markdownViewMode ?? "source"
  );
  const csvViewMode = useEditorStore(
    (state) => state.groups[groupId]?.csvViewMode ?? "grid"
  );

  if (!workspace) return <EmptyWorkspace />;

  if (!activeFile) {
    return (
      <div className="relative flex-1 overflow-hidden bg-editor-surface">
        <SelectFileState />
      </div>
    );
  }

  // Terminal tabs share the strip with file tabs. Every terminal tab in this
  // group stays mounted (inactive ones hidden) so switching tabs never
  // detaches the live xterm surface — that's what caused black screens.
  if (isTerminalTab(activeFile)) {
    const terminalTabs = tabs.filter(isTerminalTab);
    return (
      <div className="relative flex-1 overflow-hidden bg-editor-surface">
        {terminalTabs.map((tab) => {
          const terminalId = terminalIdOfTab(tab);
          const alive = terminals.some((t) => t.id === terminalId);
          const visible = tab === activeFile;
          return (
            <div key={tab} className={visible ? "absolute inset-0" : "hidden"}>
              {alive ? (
                <TerminalView id={terminalId} />
              ) : (
                <DeadTerminalTab tab={tab} groupId={groupId} />
              )}
            </div>
          );
        })}
      </div>
    );
  }

  const isMarkdown = file?.languageId === "markdown" && !file?.binary;
  const isCsv = !!activeFile && isCsvFile(activeFile) && !file?.binary;
  const isDocument = !!file?.binary && documentKindOf(activeFile) !== null;
  const gridView = isCsv && csvViewMode === "grid";
  const showMarkdownSource = isMarkdown && markdownViewMode !== "preview";
  const showSource = (!isMarkdown && !isDocument && !gridView) || showMarkdownSource;
  const showPreview = isMarkdown && markdownViewMode !== "source";
  const splitMarkdown = isMarkdown && markdownViewMode === "split";

  return (
    <div className="relative flex-1 overflow-hidden bg-editor-surface">
      {showSource && (
        <div className={showPreview ? "absolute inset-0 right-1/2 overflow-hidden" : "absolute inset-0"}>
          <MonacoEditor groupId={groupId} />
        </div>
      )}
      {showPreview && (
        <div className={splitMarkdown ? "absolute inset-0 left-1/2 border-l border-outline-variant overflow-hidden" : "absolute inset-0"}>
          {file?.content ? (
            <MarkdownPreview content={file.content} />
          ) : (
            <div className="flex h-full items-center justify-center bg-editor-surface">
              <Loader2 size={20} className="animate-spin text-editor-text-dim" />
            </div>
          )}
        </div>
      )}
      {activeFile && (!file || file.loading) && (
        <div className="absolute inset-0 flex items-center justify-center bg-editor-surface">
          <Loader2 size={20} className="animate-spin text-editor-text-dim" />
        </div>
      )}
      {activeFile && file?.error && <FileErrorState name={file.name} error={file.error} />}
      {activeFile && isDocument && !file?.loading && !file?.error && (
        <div className="absolute inset-0 overflow-hidden">
          <DocumentViewer path={activeFile} name={file?.name ?? activeFile} />
        </div>
      )}
      {activeFile && file?.binary && !isDocument && file?.name && (
        <BinaryPreview name={file.name} size={file.size ?? 0} />
      )}
      {activeFile && gridView && !file?.loading && !file?.error && (
        <div className="absolute inset-0 overflow-hidden">
          <CsvViewer key={activeFile} path={activeFile} name={file?.name ?? activeFile} content={file?.content ?? ""} />
        </div>
      )}
    </div>
  );
}
