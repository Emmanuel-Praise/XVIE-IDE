import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import * as pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs";
import { ZoomIn, ZoomOut } from "lucide-react";
import type { DocumentKind } from "./documentKinds";
import DocShell, { DocError, DocLoading } from "./doc-shell";
import { retryDocumentBytes, useDocumentBytes } from "./useDocumentBytes";

// Run the PDF worker in-process via the loopback port:
//  - Dev: a dedicated module worker breaks under Vite's /@fs/ transform, and
//    pdf.js's fake-worker dynamic import (?import) also 500s in dev.
//  - Prod: the app is served over file:// where dedicated workers are blocked.
// Registering WorkerMessageHandler on globalThis makes pdf.js use the
// in-process ("fake") worker deterministically in both environments.
(globalThis as { pdfjsWorker?: typeof pdfjsWorker }).pdfjsWorker = pdfjsWorker;
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// Memory / responsiveness guardrails: constrain how much GPU/bitmap memory a
// single page may consume and cap the bitmap backing scale.
const MAX_DPR = 2;
const MAX_PIXELS = 16 * 1024 * 1024; // ~16 MP per page
const PRE_RENDER_MARGIN = "320px 0px";
const YIELD_MS = 24;

interface PageTask {
  task: pdfjs.RenderTask;
}

export default function PdfViewer({ path, name, kind }: PdfViewerProps): React.JSX.Element {
  const { bytes, loading, failed } = useDocumentBytes(path);
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [containerWidth, setContainerWidth] = useState(0);
  const [visible, setVisible] = useState<ReadonlySet<number>>(() => new Set());
  const [pageFailed, setPageFailed] = useState<ReadonlyMap<number, string>>(
    () => new Map()
  );
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const tasksRef = useRef<Map<number, PageTask>>(new Map());

  const cMapUrl = useMemo(() => new URL("pdfjs/cmaps/", document.baseURI).href, []);

  // Load the document.
  useEffect(() => {
    setDoc(null);
    setErrorText(null);
    setPageFailed(new Map());
    for (const entry of tasksRef.current.values()) entry.task.cancel();
    tasksRef.current.clear();
    if (!bytes) return;
    let cancelled = false;
    const task = pdfjs.getDocument({
      data: bytes,
      useSystemFonts: true,
      cMapUrl,
      cMapPacked: true
    });
    void task.promise
      .then((loaded) => {
        if (!cancelled) setDoc(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setErrorText(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [bytes, cMapUrl]);

  // Track the editable container width.
  useEffect(() => {
    if (!doc) return;
    const el = scrollerRef.current;
    if (!el) return;
    const update = (): void => setContainerWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [doc]);

  // Watch which pages are (near) the viewport and render only those.
  useEffect(() => {
    if (!doc) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const current = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          const num = Number((entry.target as HTMLElement).getAttribute("data-page"));
          if (!Number.isFinite(num)) continue;
          if (entry.isIntersecting) {
            if (!current.has(num)) {
              current.add(num);
              changed = true;
            }
          } else if (current.delete(num)) {
            changed = true;
          }
        }
        if (changed) setVisible(new Set(current));
      },
      { root: scroller, rootMargin: PRE_RENDER_MARGIN, threshold: 0.001 }
    );
    for (const node of Array.from(scroller.querySelectorAll<HTMLElement>("[data-page]"))) {
      observer.observe(node);
    }
    return () => observer.disconnect();
  }, [doc]);

  // Render the visible pages. Cancels in-flight work whenever dependencies change.
  useEffect(() => {
    if (!doc || containerWidth <= 0) return;
    let cancelled = false;
    void (async () => {
      const numbers = Array.from(visible).sort((a, b) => a - b);
      for (const pageNum of numbers) {
        if (cancelled) return;
        const host = scrollerRef.current?.querySelector<HTMLElement>(`[data-page="${pageNum}"]`);
        const canvas = host?.querySelector<HTMLCanvasElement>("canvas");
        if (!canvas) continue;
        const existing = tasksRef.current.get(pageNum);
        if (existing) {
          existing.task.cancel();
          tasksRef.current.delete(pageNum);
        }
        try {
          const page = await doc.getPage(pageNum);
          if (cancelled) return;
          const unit = page.getViewport({ scale: 1 });
          if (unit.width <= 0 || unit.height <= 0) {
            markFailed(pageNum, "Page has an invalid size.");
            page.cleanup();
            continue;
          }
          const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
          const fitScale = Math.max(0.05, (containerWidth - 40) / unit.width);
          const budgetCap = Math.sqrt(MAX_PIXELS / (unit.width * unit.height)) / dpr;
          const cssScale = Math.min(fitScale, budgetCap, 4) * zoom;
          if (cssScale <= 0) continue;
          const viewport = page.getViewport({ scale: cssScale * dpr });
          canvas.width = Math.max(1, Math.floor(viewport.width));
          canvas.height = Math.max(1, Math.floor(viewport.height));
          canvas.style.width = `${Math.floor(unit.width * cssScale)}px`;
          canvas.style.height = `${Math.floor(unit.height * cssScale)}px`;
          const task = page.render({ canvas, viewport });
          tasksRef.current.set(pageNum, { task });
          await task.promise;
          page.cleanup();
          setPageFailed((prev) => (prev.has(pageNum) ? withoutKey(prev, pageNum) : prev));
        } catch (err) {
          if (!cancelled) {
            markFailed(pageNum, err instanceof Error ? err.message : String(err));
          }
        }
        // Let the UI breathe between pages so long documents never freeze.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, YIELD_MS);
          requestAnimationFrame(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    })();
    return () => {
      cancelled = true;
      for (const entry of tasksRef.current.values()) entry.task.cancel();
      tasksRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, containerWidth, zoom, visible]);

  const markFailed = useCallback(
    (num: number, message: string): void => {
      setPageFailed((prev) => (prev.has(num) ? prev : new Map(prev).set(num, message)));
    },
    []
  );

  const toolbar = (
    <>
      <button
        type="button"
        aria-label="Zoom out"
        title="Zoom out"
        onClick={() => setZoom((value) => Math.max(0.25, value / 1.25))}
        className="cursor-pointer rounded p-1 text-secondary transition-colors hover:bg-surface-container-low hover:text-primary"
      >
        <ZoomOut size={13} />
      </button>
      <span className="min-w-[2.75rem] text-center font-label-sm text-label-sm text-editor-text-dim">
        {Math.round(zoom * 100)}%
      </span>
      <button
        type="button"
        aria-label="Zoom in"
        title="Zoom in"
        onClick={() => setZoom((value) => Math.min(4, value * 1.25))}
        className="cursor-pointer rounded p-1 text-secondary transition-colors hover:bg-surface-container-low hover:text-primary"
      >
        <ZoomIn size={13} />
      </button>
      <span className="ml-1 rounded bg-surface-container-low px-1.5 py-0.5 font-label-sm text-label-sm text-editor-text-dim">
        {doc ? `${doc.numPages} pages` : "…"}
      </span>
    </>
  );

  const showError = failed || !!errorText;

  return (
    <DocShell kind={kind} path={path} name={name} toolbar={toolbar}>
      {showError ? (
        <DocError kind={kind} path={path} message={errorText ?? undefined} onRetry={() => retryDocumentBytes(path)} />
      ) : loading || !doc ? (
        <DocLoading />
      ) : (
        <div ref={scrollerRef} className="h-full w-full overflow-auto bg-editor-surface">
          <div className="mx-auto flex min-w-full flex-col items-center gap-4 px-5 py-5">
            {doc.numPages === 0 && (
              <p className="font-body-sm text-body-sm text-editor-text-dim">No pages in this PDF.</p>
            )}
            {Array.from({ length: doc.numPages }, (_, index) => {
              const pageNum = index + 1;
              const message = pageFailed.get(pageNum);
              return (
                <div
                  key={pageNum}
                  data-page={pageNum}
                  className="relative"
                  style={{ width: Math.max(containerWidth - 40, 240) }}
                >
                  <canvas
                    className="block max-w-full rounded-md bg-white shadow-[0_2px_14px_rgba(0,0,0,0.3)]"
                    style={{ width: "100%", height: "720px" }}
                  />
                  {message && (
                    <div className="absolute inset-0 flex items-center justify-center rounded-md border border-red-500/30 bg-editor-surface px-6 text-center">
                      <p className="font-body-sm text-body-sm text-red-400">
                        This page could not be rendered: {message}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </DocShell>
  );
}

interface PdfViewerProps {
  path: string;
  name: string;
  kind: DocumentKind;
}

function withoutKey<K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}