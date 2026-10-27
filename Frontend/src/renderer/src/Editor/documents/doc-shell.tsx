import { useState } from "react";
import {
  ExternalLink,
  FileImage,
  FileSpreadsheet,
  FileText,
  Loader2,
  Presentation
} from "lucide-react";
import type { DocumentKind } from "./documentKinds";
import { documentAppLabel, isLegacyFormat } from "./documentKinds";

function KindIcon({
  kind,
  legacy
}: {
  kind: DocumentKind;
  legacy: boolean;
}): React.JSX.Element {
  if (legacy) return <FileText size={14} className="shrink-0 text-editor-text-dim" />;
  switch (kind) {
    case "pdf":
    case "word":
      return <FileText size={14} className="shrink-0 text-primary" />;
    case "excel":
      return <FileSpreadsheet size={14} className="shrink-0 text-primary" />;
    case "powerpoint":
      return <Presentation size={14} className="shrink-0 text-primary" />;
    case "image":
      return <FileImage size={14} className="shrink-0 text-primary" />;
  }
}

export function OpenInAppButton({ path, kind }: { path: string; kind: DocumentKind }): React.JSX.Element {
  const [status, setStatus] = useState<"idle" | "busy" | "fail">("idle");

  const handleOpen = async (): Promise<void> => {
    if (status === "busy") return;
    setStatus("busy");
    const api = window.api?.workspace;
    const ok = api ? await api.openExternal(path) : { success: false as const, error: "Unavailable" };
    setStatus(ok.success ? "idle" : "fail");
    setTimeout(() => setStatus("idle"), 2000);
  };

  return (
    <button
      type="button"
      title={`Open in ${documentAppLabel(kind)}`}
      onClick={() => void handleOpen()}
      className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 font-label-sm text-label-sm text-editor-text transition-colors hover:bg-editor-text-dim/10 hover:text-editor-text"
    >
      {status === "fail" ? (
        <span className="text-red-400">Open failed</span>
      ) : (
        <>
          <ExternalLink size={12} />
          Open in {documentAppLabel(kind)}
        </>
      )}
    </button>
  );
}

export function DocLoading(): React.JSX.Element {
  return (
    <div className="flex h-full w-full items-center justify-center bg-editor-surface">
      <Loader2 size={22} className="animate-spin text-editor-text-dim" />
    </div>
  );
}

export function DocError({
  kind,
  path,
  onRetry,
  message
}: {
  kind: DocumentKind;
  path: string;
  onRetry: () => void;
  message?: string;
}): React.JSX.Element {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-editor-surface px-6 text-center">
      <p className="font-body-sm text-body-sm text-editor-text-dim">
        Could not read this {documentAppLabel(kind).toLowerCase()} file.
      </p>
      {message && (
        <p className="max-w-md break-all rounded-lg bg-surface-container-low px-3 py-2 font-label-sm text-label-sm text-red-400">
          {message}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="cursor-pointer rounded-lg border border-editor-text-dim/30 px-3 py-1.5 font-label-sm text-label-sm text-editor-text transition-colors hover:bg-editor-text-dim/10"
        >
          Retry
        </button>
        <OpenInAppButton path={path} kind={kind} />
      </div>
    </div>
  );
}

export function LegacyNotice({
  kind,
  path
}: {
  kind: DocumentKind;
  path: string;
}): React.JSX.Element {
  return (
    <>
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-editor-surface px-6 text-center">
        <KindIcon kind={kind} legacy />
        <p className="max-w-sm font-body-sm text-body-sm text-editor-text-dim">
          This older format has no in-app preview. Open it in {documentAppLabel(kind)} to view
          and edit it — changes are picked up automatically.
        </p>
        <OpenInAppButton path={path} kind={kind} />
      </div>
    </>
  );
}

interface DocShellProps {
  kind: DocumentKind;
  path: string;
  name: string;
  toolbar?: React.ReactNode;
  children: React.ReactNode;
}

/** Chrome bar wrapping every document viewer: icon, name, kind, toolbar, open-in-app. */
export default function DocShell({
  kind,
  path,
  name,
  toolbar,
  children
}: DocShellProps): React.JSX.Element {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-editor-surface">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-outline-variant px-2">
        <KindIcon kind={kind} legacy={isLegacyFormat(path)} />
        <span className="max-w-[40%] truncate font-label-sm text-label-sm text-editor-text">
          {name}
        </span>
        <span className="shrink-0 rounded bg-surface-container-low px-1.5 py-0.5 font-label-sm text-label-sm text-editor-text-dim">
          {documentAppLabel(kind)}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">{toolbar}</div>
        <OpenInAppButton path={path} kind={kind} />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}