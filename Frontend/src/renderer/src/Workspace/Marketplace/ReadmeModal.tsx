import { useEffect, useMemo } from "react";
import { ExternalLink, Loader2, X } from "lucide-react";
import type { MarketplaceProject } from "@/Workspace/Marketplace/marketplaceData";
import type { ReadmeState } from "@/Workspace/Marketplace/marketplaceStore";

interface ReadmeModalProps {
  repo: MarketplaceProject;
  html: string | null;
  error: string | null;
  loading: boolean;
  onClose: () => void;
}

const README_STYLES = `
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      line-height: 1.6;
      color: #1f2328;
      padding: 24px 32px 48px;
      margin: 0 auto;
      max-width: 900px;
      word-wrap: break-word;
    }
    h1, h2, h3, h4 { margin-top: 1.5em; margin-bottom: 0.5em; }
    h1 { border-bottom: 1px solid #d0d7de; padding-bottom: 0.3em; }
    img { max-width: 100%; height: auto; }
    pre { background: #f6f8fa; padding: 16px; border-radius: 8px; overflow-x: auto; }
    code { background: rgba(175, 184, 193, 0.2); padding: 0.2em 0.4em; border-radius: 4px; font-size: 0.9em; }
    pre code { background: none; padding: 0; }
    table { border-collapse: collapse; margin: 1em 0; }
    th, td { border: 1px solid #d0d7de; padding: 6px 12px; }
    a { color: #0969da; text-decoration: none; }
    a:hover { text-decoration: underline; }
    blockquote { border-left: 4px solid #d0d7de; margin-left: 0; padding-left: 16px; color: #57606a; }
    hr { border: none; border-top: 1px solid #d0d7de; margin: 2em 0; }
  </style>
`;

export default function ReadmeModal({
  repo,
  html,
  error,
  loading,
  onClose
}: ReadmeModalProps): React.JSX.Element {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const srcDoc = useMemo(
    () =>
      html
        ? `<!DOCTYPE html><html><head><meta charset="utf-8">${README_STYLES}</head><body>${html}</body></html>`
        : "",
    [html]
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`README for ${repo.name}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-outline-variant/50 bg-surface shadow-2xl">
        <div className="flex items-center justify-between gap-4 border-b border-outline-variant px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate font-headline-sm text-headline-sm text-primary">{repo.name}</h2>
            <p className="truncate font-body-sm text-body-sm text-secondary">
              {repo.id} · README
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {repo.repoUrl && (
                <a
                  href={repo.repoUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-outline-variant/50 px-3 py-1.5 font-label-md text-label-md text-primary transition-all duration-150 hover:border-outline-variant hover:bg-surface-container-low"
                >
                <ExternalLink size={14} />
                View on GitHub
              </a>
            )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close README viewer"
            className="cursor-pointer rounded-lg p-1.5 text-secondary/60 transition-colors duration-150 hover:bg-surface-container-low hover:text-primary"
          >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden">
          {loading && (
            <div className="flex flex-col items-center gap-3 text-secondary">
              <Loader2 size={28} className="animate-spin text-primary" />
              <span className="font-body-md text-body-md">Loading README…</span>
            </div>
          )}
          {!loading && error && (
            <div className="mx-4 rounded-xl border border-outline-variant/40 bg-surface-container-lowest px-md py-lg text-center">
              <p className="font-body-md text-body-md text-error">{error}</p>
              {repo.repoUrl && (
                <a
                  href={repo.repoUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-sm inline-flex cursor-pointer items-center gap-1.5 font-label-md text-label-md text-primary/70 transition-colors hover:text-primary"
                >
                  <ExternalLink size={14} />
                  Open on GitHub instead
                </a>
              )}
            </div>
          )}
          {!loading && !error && html && (
            <iframe
              title={`${repo.name} README`}
              srcDoc={srcDoc}
              sandbox=""
              className="h-full w-full flex-1 border-0 bg-white"
            />
          )}
        </div>
      </div>
    </div>
  );
}
