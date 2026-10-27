import { History, Folder, Star, ExternalLink, Trash2 } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import EmptyState from "@/Workspace/components/empty-state";
import { useRecentStore } from "@/Workspace/recentStore";
import { useWorkspaceStore } from "@/Workspace/workspaceStore";

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function detectLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "TypeScript",
    tsx: "React",
    jsx: "React",
    js: "JavaScript",
    py: "Python",
    go: "Go",
    rs: "Rust",
    java: "Java",
    rb: "Ruby",
    php: "PHP",
    css: "CSS",
    html: "HTML",
    json: "JSON",
    md: "Markdown"
  };
  return map[ext] ?? ext.toUpperCase() ?? "Text";
}

export default function HistoryPage(): React.JSX.Element {
  const recentProjects = useRecentStore((s) => s.recentProjects);
  const starredProjects = useRecentStore((s) => s.starredProjects);
  const toggleStarred = useRecentStore((s) => s.toggleStarred);
  const openRecentProject = useWorkspaceStore((s) => s.openRecentProject);

  return (
    <div className="flex flex-1 flex-col gap-xl">
      <div className="mb-sm">
        <h1 className="font-headline-lg text-headline-lg text-primary">History</h1>
        <p className="mt-sm font-body-md text-body-md text-secondary/70">
          Recently opened projects and actions.
        </p>
      </div>

      {recentProjects.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={History}
            title="Nothing here yet"
            description="Projects and actions you open will show up here for quick access."
          />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {recentProjects.map((project, i) => {
            const isStarred = starredProjects.some((s) => s.path === project.path);
            return (
              <div
                key={project.path}
                className={cn(
                  "group flex items-center justify-between rounded-xl border border-outline-variant/40 bg-surface px-md py-3 transition-all duration-200 hover:-translate-y-0.5 hover:border-outline-variant hover:shadow-[0_4px_16px_-4px_rgba(0,0,0,0.08)] dark:hover:shadow-[0_4px_16px_-4px_rgba(0,0,0,0.3)]"
                )}
              >
                <div
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-3"
                  onClick={() => openRecentProject(project.path, project.name)}
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-container">
                    <Folder
                      size={18}
                      strokeWidth={1.8}
                      className="text-secondary transition-colors group-hover:text-primary"
                    />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-label-md text-label-md text-primary">
                      {project.name}
                    </p>
                    <div className="mt-0.5 flex items-center gap-2">
                      <span className="font-body-sm text-body-sm text-secondary/50">
                        {formatTimeAgo(project.lastOpened)}
                      </span>
                      <span className="text-secondary/30">·</span>
                      <span className="font-label-sm text-[10px] text-secondary/40">
                        {detectLanguage(project.path)}
                      </span>
                      <span className="text-secondary/30">·</span>
                      <span className="max-w-[200px] truncate font-label-sm text-[10px] text-secondary/30">
                        {project.path}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => toggleStarred(project)}
                    className={cn(
                      "cursor-pointer rounded p-1.5 transition-all",
                      isStarred
                        ? "text-primary"
                        : "text-secondary/30 hover:text-primary"
                    )}
                    aria-label={isStarred ? "Unstar project" : "Star project"}
                  >
                    <Star size={14} strokeWidth={1.8} className={isStarred ? "fill-primary" : ""} />
                  </button>
                  <ExternalLink
                    size={14}
                    strokeWidth={1.8}
                    className="text-secondary/0 transition-all group-hover:text-secondary/40"
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
