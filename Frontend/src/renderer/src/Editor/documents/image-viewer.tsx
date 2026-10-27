import { useEffect, useRef, useState } from "react";
import { ZoomIn, ZoomOut, ImageOff, Maximize2 } from "lucide-react";
import type { DocumentKind } from "./documentKinds";
import DocShell, { DocError, DocLoading } from "./doc-shell";
import { retryDocumentBytes, useDocumentBytes } from "./useDocumentBytes";

interface ImageViewerProps {
  path: string;
  name: string;
  kind: DocumentKind;
}

function formatBytes(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}

export default function ImageViewer({ path, name, kind }: ImageViewerProps): React.JSX.Element {
  const { bytes, loading, failed } = useDocumentBytes(path);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [decodeError, setDecodeError] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!bytes) return;
    let url: string | null = null;
    try {
      const lower = path.toLowerCase();
      let mime = "image/png";
      if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) mime = "image/jpeg";
      else if (lower.endsWith(".gif")) mime = "image/gif";
      else if (lower.endsWith(".webp")) mime = "image/webp";
      else if (lower.endsWith(".bmp")) mime = "image/bmp";
      else if (lower.endsWith(".svg")) mime = "image/svg+xml";
      else if (lower.endsWith(".avif")) mime = "image/avif";
      else if (lower.endsWith(".ico")) mime = "image/x-icon";
      else if (lower.endsWith(".tif") || lower.endsWith(".tiff")) mime = "image/tiff";
      const blob = new Blob([bytes as BlobPart], { type: mime });
      url = URL.createObjectURL(blob);
      setObjectUrl(url);
      setDecodeError(false);
    } catch {
      setDecodeError(true);
      setObjectUrl(null);
    }
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [bytes, path]);

  const clampZoom = (value: number): number => Math.max(0.1, Math.min(8, value));

  const toolbar = (
    <>
      <button
        type="button"
        onClick={() => setZoom((z) => clampZoom(z / 1.25))}
        className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 font-label-sm text-label-sm text-editor-text transition-colors hover:bg-primary/10"
      >
        <ZoomOut size={12} />
      </button>
      <button
        type="button"
        onClick={() => setZoom(1)}
        className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 font-label-sm text-label-sm text-editor-text transition-colors hover:bg-primary/10"
      >
        <Maximize2 size={12} />
      </button>
      <button
        type="button"
        onClick={() => setZoom((z) => clampZoom(z * 1.25))}
        className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 font-label-sm text-label-sm text-editor-text transition-colors hover:bg-primary/10"
      >
        <ZoomIn size={12} />
      </button>
      <span className="w-12 text-center font-label-sm text-label-sm text-editor-text-dim">
        {Math.round(zoom * 100)}%
      </span>
      {natural && (
        <span className="rounded bg-surface-container-low px-1.5 py-0.5 font-label-sm text-label-sm text-editor-text-dim">
          {natural.w}×{natural.h}
        </span>
      )}
      {bytes && <span className="text-ellipsis font-label-sm text-label-sm text-editor-text-dim">{formatBytes(bytes.byteLength)}</span>}
    </>
  );

  return (
    <DocShell kind={kind} path={path} name={name} toolbar={toolbar}>
      {failed ? (
        <DocError kind={kind} path={path} onRetry={() => retryDocumentBytes(path)} />
      ) : loading ? (
        <DocLoading />
      ) : !objectUrl || decodeError ? (
        <DocError
          kind={kind}
          path={path}
          message="Could not decode this image."
          onRetry={() => retryDocumentBytes(path)}
        />
      ) : (
        <div
          ref={scrollerRef}
          className="h-full w-full overflow-auto bg-editor-surface"
          onWheel={(e) => {
            if (e.ctrlKey || e.metaKey) {
              e.preventDefault();
              setZoom((z) => clampZoom(e.deltaY < 0 ? z * 1.1 : z / 1.1));
            }
          }}
        >
          <div className="flex min-h-full w-fit items-center justify-center p-8" style={{ width: "auto" }}>
            <img
              src={objectUrl}
              alt={name}
              draggable={false}
              onLoad={(e) => {
                const img = e.currentTarget;
                setNatural({ w: img.naturalWidth, h: img.naturalHeight });
              }}
              onError={() => setDecodeError(true)}
              className="select-none shadow-[0_2px_16px_rgba(0,0,0,0.3)]"
              style={{
                width: natural ? natural.w * zoom : undefined,
                height: natural ? natural.h * zoom : undefined,
                maxWidth: "none"
              }}
            />
          </div>
          {!natural && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-editor-text-dim">
              <ImageOff size={18} />
            </div>
          )}
        </div>
      )}
    </DocShell>
  );
}