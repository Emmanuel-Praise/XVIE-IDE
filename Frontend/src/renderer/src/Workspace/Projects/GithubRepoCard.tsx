import { useEffect, useRef, useState } from "react";
import { GitFork, Globe2, Loader2, LockKeyhole, Plus, Star } from "lucide-react";
import { usePreviewImage } from "@/Workspace/Marketplace/repoPreview";
import type { GitHubRepo } from "../../../../shared/ipc-types";

interface Props {
  repo: GitHubRepo;
  cloning: boolean;
  onClone: (repo: GitHubRepo) => void;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "";
  const days = Math.floor(ms / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export default function GithubRepoCard({ repo, cloning, onClone }: Props): React.JSX.Element {
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

  const preview = usePreviewImage(visible ? repo : undefined);
  const [imgBroken, setImgBroken] = useState(false);
  const showImage = typeof preview === "string" && !imgBroken;
  const initial = (repo.name.slice(0, 1) || "?").toUpperCase();

  return (
    <article ref={cardRef} className="group flex flex-col overflow-hidden rounded-2xl border border-outline-variant/40 bg-surface transition-all duration-200 hover:-translate-y-0.5 hover:border-outline-variant/70 hover:shadow-[0_8px_30px_-8px_rgba(0,0,0,0.14)]">
      <div className="relative h-28 overflow-hidden border-b border-outline-variant/30 bg-gradient-to-br from-primary/20 via-surface-container-high to-secondary/15">
        {showImage ? (
          <img
            src={preview}
            alt={`${repo.name} preview`}
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setImgBroken(true)}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          />
        ) : preview === undefined ? (
          <div className="absolute inset-0 animate-pulse bg-gradient-to-r from-surface-container-low via-surface-container-high to-surface-container-low" aria-hidden="true" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/30 bg-white/20 text-xl font-bold text-primary shadow-lg backdrop-blur-sm">
              {initial}
            </div>
          </div>
        )}
        <span className="absolute bottom-3 left-3 flex items-center gap-1 rounded-full border border-white/25 bg-black/35 px-2.5 py-1 font-label-xs text-label-xs text-white backdrop-blur-sm">
          {repo.private ? <LockKeyhole size={11} /> : <Globe2 size={11} />}
          {repo.private ? "Private" : "Public"}
        </span>
        <span className="absolute bottom-3 right-3 rounded-full border border-white/25 bg-black/35 px-2.5 py-1 font-label-xs text-label-xs text-white backdrop-blur-sm">
          {repo.default_branch}
        </span>
      </div>

      <div className="flex flex-1 flex-col p-3.5">
        <div className="flex items-center gap-2.5">
          <img
            src={repo.owner.avatar_url}
            alt=""
            loading="lazy"
            decoding="async"
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
            className="h-9 w-9 shrink-0 rounded-lg border border-outline-variant/30 object-cover"
          />
          <div className="min-w-0">
            <h3 className="truncate font-headline-sm text-headline-sm font-medium text-primary">{repo.name}</h3>
            <p className="truncate font-body-sm text-body-sm text-secondary/50">{repo.full_name}</p>
          </div>
        </div>
        <p className="mb-3 mt-2.5 line-clamp-2 min-h-10 flex-1 font-body-sm text-body-sm text-secondary/65">
          {repo.description || "No description provided."}
        </p>
        <div className="mb-3 flex items-center gap-3 border-t border-outline-variant/20 pt-3 text-secondary/60">
          <span className="font-label-sm text-label-sm">{repo.language || "Code"}</span>
          <span className="flex items-center gap-1 font-label-sm text-label-sm"><Star size={12} />{repo.stargazers_count}</span>
          <span className="flex items-center gap-1 font-label-sm text-label-sm"><GitFork size={12} />{repo.forks_count}</span>
          <span className="ml-auto font-label-sm text-label-sm">Updated {timeAgo(repo.pushed_at || repo.updated_at)}</span>
        </div>
        <button
          type="button"
          onClick={() => onClone(repo)}
          disabled={cloning}
          className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 font-label-md text-label-md text-on-primary transition hover:brightness-110 disabled:opacity-60"
        >
          {cloning ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
          {cloning ? "Cloning…" : "Clone and open"}
        </button>
      </div>
    </article>
  );
}
