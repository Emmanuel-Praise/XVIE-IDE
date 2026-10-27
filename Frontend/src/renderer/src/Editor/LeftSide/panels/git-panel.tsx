import { FileDiff, FilePlus2, GitBranch, RefreshCw, Send } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { gitChanges, type GitChange } from "@/Editor/data/mockTerminal";
import { useEditorStore } from "@/Editor/editorStore";
import PanelShell from "@/Editor/LeftSide/panels/panel-shell";

const changeMeta: Record<GitChange["kind"], { label: string; className: string }> = {
  modified: { label: "M", className: "bg-error-container text-on-error-container" },
  untracked: { label: "U", className: "bg-primary-container text-on-primary" },
  staged: { label: "A", className: "bg-secondary-container text-on-secondary-container" }
};

export default function GitPanel(): React.JSX.Element {
  const openFile = useEditorStore((state) => state.openFile);

  return (
    <PanelShell
      title="Source Control"
      actions={
        <>
          <button
            type="button"
            aria-label="Commit"
            className="cursor-pointer rounded-md p-1 text-secondary transition-colors hover:bg-surface-container-low hover:text-primary"
          >
            <Send size={15} />
          </button>
          <button
            type="button"
            aria-label="Refresh"
            className="cursor-pointer rounded-md p-1 text-secondary transition-colors hover:bg-surface-container-low hover:text-primary"
          >
            <RefreshCw size={15} />
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3 p-3">
        <button
          type="button"
          className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-low px-3 py-1.5 font-label-md text-label-md text-on-surface transition-colors hover:border-primary"
        >
          <GitBranch size={13} className="text-secondary" />
          main
        </button>

        <div className="flex flex-col">
          <p className="px-1 pb-1 font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">
            Changes
          </p>
          {gitChanges.map((change) => {
            const meta = changeMeta[change.kind];
            const fileName = change.path.split("/").pop();
            return (
              <button
                key={`${change.path}-${change.kind}`}
                type="button"
                onClick={() => openFile(change.path)}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left font-label-md text-label-md text-on-surface transition-colors hover:bg-surface-container-low"
              >
                <span
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-bold",
                    meta.className
                  )}
                >
                  {meta.label}
                </span>
                {change.kind === "untracked" ? (
                  <FilePlus2 size={14} className="shrink-0 text-secondary" />
                ) : (
                  <FileDiff size={14} className="shrink-0 text-secondary" />
                )}
                <span className="truncate">{fileName}</span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 rounded-xl border border-outline-variant bg-surface-container-low px-3 py-1.5 transition-colors focus-within:border-primary">
          <input
            type="text"
            placeholder="Commit message"
            className="w-full bg-transparent font-label-md text-label-md text-on-surface placeholder-secondary focus:outline-none"
          />
          <button
            type="button"
            aria-label="Commit"
            className="cursor-pointer rounded-lg bg-primary p-1 text-on-primary transition-opacity hover:opacity-90"
          >
            <Send size={12} />
          </button>
        </div>
      </div>
    </PanelShell>
  );
}
