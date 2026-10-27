import { Bookmark, ExternalLink, Eye, GitFork, Loader2, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/shared/lib/utils";
import { usePreviewImage } from "@/Workspace/Marketplace/repoPreview";
import type { MarketplaceProject } from "@/Workspace/Marketplace/marketplaceData";
import type { CloneState } from "@/Workspace/Marketplace/marketplaceStore";

interface ProjectCardProps {
  project: MarketplaceProject;
  bookmarked: boolean;
  onToggleBookmark: (id: string) => void;
  onView: (project: MarketplaceProject) => void;
  onClone: (project: MarketplaceProject) => void;
  onOpenCloned: (destination: string, name: string) => void;
  cloneState?: CloneState;
}

export default function ProjectCard({
  project,
  bookmarked,
  onToggleBookmark,
  onView,
  onClone,
  onOpenCloned,
  cloneState
}: ProjectCardProps): React.JSX.Element {
  const { logo: Logo } = project;
  const cardRef = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const target = cardRef.current;
    if (!target) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "400px" }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  // Shared session cache + queued IPC: repeat views never refetch.
  const preview = usePreviewImage(visible ? (project.rawRepo ?? null) : undefined);
  const [imgBroken, setImgBroken] = useState(false);
  useEffect(() => { setImgBroken(false); }, [project.id]);
  const showImage = typeof preview === "string" && !imgBroken;
  const cloning = cloneState?.phase === "starting" || cloneState?.phase === "cloning";
  const linked = Boolean(project.repoUrl);

  return (
    <article ref={cardRef} className="group flex flex-col overflow-hidden rounded-2xl border border-outline-variant/40 bg-surface transition-all duration-200 hover:-translate-y-0.5 hover:border-outline-variant/70 hover:shadow-[0_8px_30px_-8px_rgba(0,0,0,0.14)] dark:hover:shadow-[0_8px_30px_-8px_rgba(0,0,0,0.4)]">
      <div className="relative h-40 overflow-hidden border-b border-outline-variant/30 bg-gradient-to-br from-primary/20 via-surface-container-high to-secondary/15 sm:h-44">
        {showImage ? <img src={preview} alt={`${project.name} project preview`} loading="lazy" decoding="async" draggable={false} onError={() => setImgBroken(true)} className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" /> : preview === undefined ? <div className="absolute inset-0 animate-pulse bg-gradient-to-r from-surface-container-low via-surface-container-high to-surface-container-low" aria-hidden="true" /> : <div className="absolute inset-0 flex items-center justify-center bg-[radial-gradient(ellipse_at_35%_25%,rgba(255,255,255,.3),transparent_48%),linear-gradient(135deg,rgba(80,78,72,.12),rgba(80,78,72,.02))]"><div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-white/30 bg-white/20 text-primary shadow-lg backdrop-blur-sm">{typeof Logo === "string" ? <img src={Logo} alt="" loading="lazy" decoding="async" className="h-full w-full rounded-2xl object-cover" /> : <Logo size={30} strokeWidth={1.5} />}</div><div className="absolute bottom-3 left-4 rounded-full border border-white/30 bg-black/15 px-2.5 py-1 font-label-xs text-label-xs text-white/90 backdrop-blur-sm">{project.category}</div></div>}
        {showImage && <span className="absolute bottom-3 left-4 rounded-full border border-white/25 bg-black/35 px-2.5 py-1 font-label-xs text-label-xs text-white backdrop-blur-sm">Preview</span>}
        <button type="button" onClick={() => onToggleBookmark(project.id)} aria-label={bookmarked ? `Remove ${project.name} from bookmarks` : `Bookmark ${project.name}`} aria-pressed={bookmarked} className={cn("absolute right-3 top-3 cursor-pointer rounded-full border border-white/30 bg-black/20 p-2 text-white/90 backdrop-blur-sm transition-colors hover:bg-black/40", bookmarked && "text-white")}><Bookmark size={16} className={cn(bookmarked && "fill-white")} /></button>
      </div>

      <div className="flex flex-1 flex-col p-4">
      <div className="mb-3 flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-outline-variant/30 bg-surface-container">
            {typeof Logo === "string" ? (
              <img src={Logo} alt={`${project.name} avatar`} className="h-full w-full object-cover" />
            ) : (
              <Logo size={20} strokeWidth={1.6} className="text-primary/70" />
            )}
          </div>
          <div className="min-w-0">
            <h3 className="truncate font-headline-sm text-headline-sm text-primary">
              {project.name}
            </h3>
            <div className="mt-0.5 flex items-center gap-2">
              <span className="rounded-md bg-surface-container px-1.5 py-0.5 font-label-sm text-[10px] uppercase text-secondary/60">
                {project.category.split(" ")[0]}
              </span>
              <span className="h-0.5 w-0.5 rounded-full bg-outline-variant" />
              <span className="font-body-sm text-body-sm text-secondary/50">{project.version}</span>
            </div>
          </div>
        </div>
      </div>

      <p className="mb-4 line-clamp-2 flex-1 font-body-sm text-body-sm text-secondary/60 leading-relaxed">
        {project.description}
      </p>

      <div className="mb-3.5 flex flex-wrap gap-1.5">
        {project.tech.map(({ label, icon: Icon }) => (
          <span
            key={label}
            className="inline-flex items-center gap-1 rounded-md bg-surface-container px-2 py-0.5 font-label-sm text-label-sm text-secondary/60"
          >
            {Icon && <Icon size={12} strokeWidth={1.8} />}
            {label}
          </span>
        ))}
      </div>

      <div className="mb-3.5 flex items-center gap-4 border-t border-outline-variant/20 pt-3">
        <div className="flex items-center gap-1 text-secondary/50">
          <Star size={13} strokeWidth={1.8} />
          <span className="font-label-sm text-label-sm">{project.stars}</span>
        </div>
        <div className="flex items-center gap-1 text-secondary/50">
          <GitFork size={13} strokeWidth={1.8} />
          <span className="font-label-sm text-label-sm" title="Forks">{project.forks}</span>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <div
            className="flex h-4 w-4 items-center justify-center rounded-full border border-outline-variant/40 bg-surface-container font-label-sm text-[8px] font-bold text-secondary/60"
            title={project.maintainer.name}
          >
            {project.maintainer.initials}
          </div>
          <span className="font-label-sm text-label-sm text-secondary/50">
            {project.maintainer.name}
          </span>
        </div>
      </div>

      <div className="mt-auto flex items-center justify-between">
        <span className="font-body-sm text-body-sm text-secondary/50">{project.updatedLabel}</span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onView(project)}
            disabled={!linked}
            title={linked ? undefined : "No repository linked"}
            className="cursor-pointer rounded-md border border-outline-variant/40 bg-surface px-2.5 py-1 font-label-md text-label-md text-secondary transition-all duration-150 hover:border-outline-variant hover:text-primary disabled:pointer-events-none disabled:opacity-30"
          >
            <span className="inline-flex items-center gap-1"><Eye size={12} />{project.secondaryAction}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              if (cloneState?.phase === "done" && cloneState.destination) {
                onOpenCloned(cloneState.destination, project.name);
              } else {
                onClone(project);
              }
            }}
            disabled={!linked || cloning}
            title={!linked ? "No repository linked" : undefined}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 font-label-md text-label-md text-on-primary shadow-[0_1px_3px_rgba(0,0,0,0.12)] transition-all duration-150 hover:shadow-[0_3px_10px_rgba(0,0,0,0.18)] hover:brightness-110 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40"
          >
            {cloneState?.phase === "done" ? (
              <>
                <ExternalLink size={13} />
                Open in IDE
              </>
            ) : cloning ? (
              <>
                <Loader2 size={13} strokeWidth={2} className="animate-spin" />
                Cloning…
              </>
            ) : cloneState?.phase === "error" ? (
              "Retry"
            ) : (
              "Use Project"
            )}
          </button>
        </div>
      </div>

      {cloneState?.phase === "done" && cloneState.destination && (
        <p
          className="mt-2 truncate font-body-sm text-body-sm text-secondary/40"
          title={cloneState.destination}
        >
          Saved to {cloneState.destination}
        </p>
      )}
      {cloneState?.phase === "error" && cloneState.error && (
        <p className="mt-2 line-clamp-2 font-body-sm text-body-sm text-error">{cloneState.error}</p>
      )}
      </div>
    </article>
  );
}
