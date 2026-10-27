import {
  type LucideIcon,
  ArrowUpRight,
  FolderOpen,
  Store,
  PlusCircle,
  FileDown,
  Folder,
  Star,
  ExternalLink
} from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { useWorkspaceStore } from "@/Workspace/workspaceStore";
import { useRecentStore } from "@/Workspace/recentStore";
import type { RecentProject } from "@/Workspace/recentStore";

interface QuickAction {
  icon: LucideIcon;
  title: string;
  description: string;
  buttonLabel: string;
  buttonIcon: LucideIcon;
  accent?: boolean;
  onAction?: () => void;
}

const quickActions: QuickAction[] = [
  {
    icon: FolderOpen,
    title: "Open Project",
    description: "Browse and launch your local codebases.",
    buttonLabel: "Open",
    buttonIcon: FolderOpen,
    accent: true,
    onAction: () => useWorkspaceStore.getState().openProject()
  },
  {
    icon: Store,
    title: "Marketplace",
    description: "Starter projects and templates.",
    buttonLabel: "Browse",
    buttonIcon: Store,
    onAction: () => useWorkspaceStore.getState().setTab("marketplace")
  },
  {
    icon: PlusCircle,
    title: "New Project",
    description: "Start fresh with scaffolding.",
    buttonLabel: "Create",
    buttonIcon: PlusCircle,
    onAction: () => void useWorkspaceStore.getState().openNewProject()
  },
  {
    icon: FileDown,
    title: "Clone Repo",
    description: "Pull from any Git host.",
    buttonLabel: "Clone",
    buttonIcon: FileDown,
    onAction: () => useWorkspaceStore.getState().setTab("marketplace")
  }
];

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

function formatTime(): string {
  const now = new Date();
  const hour = now.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
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
    md: "Markdown",
    yaml: "YAML",
    yml: "YAML",
    toml: "TOML",
    sh: "Shell",
    bash: "Shell",
    c: "C",
    cpp: "C++",
    cs: "C#",
    swift: "Swift",
    kt: "Kotlin"
  };
  return map[ext] ?? ext.toUpperCase() ?? "Text";
}

export default function OverviewPage(): React.JSX.Element {
  const recentProjects = useRecentStore((s) => s.recentProjects);
  const starredProjects = useRecentStore((s) => s.starredProjects);
  const toggleStarred = useRecentStore((s) => s.toggleStarred);
  const openRecentProject = useWorkspaceStore((s) => s.openRecentProject);
  const setTab = useWorkspaceStore((s) => s.setTab);

  return (
    <div className="flex flex-col gap-xl">
      <section className="rounded-2xl bg-gradient-to-br from-surface-container-low to-surface-container px-lg py-lg">
        <div>
          <h1 className="font-headline-lg text-headline-lg text-primary">{formatTime()}</h1>
          <p className="mt-1 font-body-md text-body-md text-secondary">Pick up where you left off, or start something new.</p>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        {quickActions.map(
          ({ icon: Icon, title, description, buttonLabel, buttonIcon: ButtonIcon, accent, onAction }, index) => (
            <div
              key={title}
              className={cn(
                "group flex cursor-pointer flex-col justify-between rounded-xl border border-outline-variant/40 p-md transition-all duration-200 hover:-translate-y-0.5 hover:border-outline-variant hover:shadow-[0_4px_16px_-4px_rgba(0,0,0,0.08)] dark:hover:shadow-[0_4px_16px_-4px_rgba(0,0,0,0.3)]",
                accent
                  ? "bg-gradient-to-br from-primary/5 to-transparent"
                  : "bg-surface"
              )}
            >
              <div>
                <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-surface-container transition-colors duration-200 group-hover:bg-primary group-hover:text-on-primary">
                  <Icon size={20} strokeWidth={1.8} />
                </div>
                <h3 className="font-headline-sm text-headline-sm text-primary">{title}</h3>
                <p className="mt-1 line-clamp-2 font-body-sm text-body-sm text-secondary/70">
                  {description}
                </p>
              </div>
              <button
                type="button"
                onClick={onAction}
                className="mt-4 flex w-fit cursor-pointer items-center gap-1.5 rounded-md bg-surface-container-low px-3 py-1.5 font-label-md text-label-md text-primary transition-all duration-150 hover:bg-surface-container-high hover:shadow-sm active:scale-[0.97]"
              >
                <ButtonIcon size={13} strokeWidth={2} />
                {buttonLabel}
              </button>
            </div>
          )
        )}
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="flex flex-col overflow-hidden rounded-xl border border-outline-variant/40 bg-surface lg:col-span-3">
          <div className="flex items-center justify-between border-b border-outline-variant/30 bg-surface-container-low/50 px-md py-3">
            <h3 className="font-headline-sm text-headline-sm text-primary">Recent</h3>
            {recentProjects.length > 3 && (
              <button
                type="button"
                onClick={() => setTab("history")}
                className="flex cursor-pointer items-center gap-1 font-label-sm text-label-sm text-secondary/60 transition-colors hover:text-primary"
              >
                View all
                <ArrowUpRight size={12} strokeWidth={2} />
              </button>
            )}
          </div>
          {recentProjects.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-md py-10 text-center">
              <Folder size={22} className="text-secondary/30" strokeWidth={1.5} />
              <p className="font-body-sm text-body-sm text-secondary/50">
                No recent projects yet. Open a project to get started.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col">
              {recentProjects.slice(0, 5).map((project, i) => (
                <RecentProjectItem
                  key={project.path}
                  project={project}
                  index={i}
                  total={Math.min(recentProjects.length, 5)}
                  isStarred={starredProjects.some((s) => s.path === project.path)}
                  onOpen={openRecentProject}
                  onToggleStar={toggleStarred}
                />
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-col overflow-hidden rounded-xl border border-outline-variant/40 bg-surface lg:col-span-2">
          <div className="border-b border-outline-variant/30 bg-surface-container-low/50 px-md py-3">
            <h3 className="font-headline-sm text-headline-sm text-primary">Starred</h3>
          </div>
          {starredProjects.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-md py-10 text-center">
              <Star size={22} className="text-secondary/30" strokeWidth={1.5} />
              <p className="font-body-sm text-body-sm text-secondary/50">
                Star projects to pin them here
              </p>
            </div>
          ) : (
            <ul className="flex flex-col">
              {starredProjects.map((project, i) => (
                <li
                  key={project.path}
                  className={cn(
                    "group flex cursor-pointer items-center gap-3 px-md py-3 transition-colors hover:bg-surface-container-low/50",
                    i < starredProjects.length - 1 && "border-b border-outline-variant/20"
                  )}
                  onClick={() => openRecentProject(project.path, project.name)}
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleStarred(project);
                    }}
                    className="shrink-0 cursor-pointer"
                  >
                    <Star size={14} strokeWidth={1.8} className="fill-primary/60 text-primary/60" />
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-label-md text-label-md text-primary">{project.name}</p>
                    <div className="mt-1 flex gap-1.5">
                      <span className="rounded-md bg-surface-container px-1.5 py-px font-label-sm text-[10px] text-secondary/50">
                        {detectLanguage(project.path)}
                      </span>
                    </div>
                  </div>
                  <ExternalLink
                    size={14}
                    strokeWidth={1.8}
                    className="text-secondary/0 transition-all group-hover:text-secondary/60"
                  />
                </li>
              ))}
            </ul>
          )}
          {starredProjects.length > 0 && (
            <div className="mt-auto border-t border-outline-variant/20 px-md py-2.5 text-center">
              <p className="font-body-sm text-body-sm text-secondary/40">
                Click the star to unpin
              </p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function RecentProjectItem({
  project,
  index,
  total,
  isStarred,
  onOpen,
  onToggleStar
}: {
  project: RecentProject;
  index: number;
  total: number;
  isStarred: boolean;
  onOpen: (path: string, name: string) => void;
  onToggleStar: (project: { path: string; name: string }) => void;
}): React.JSX.Element {
  return (
    <li
      className={cn(
        "group flex cursor-pointer items-center justify-between px-md py-3 transition-colors hover:bg-surface-container-low/50",
        index < total - 1 && "border-b border-outline-variant/20"
      )}
      onClick={() => onOpen(project.path, project.name)}
    >
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface-container">
          <Folder
            size={16}
            strokeWidth={1.8}
            className="text-secondary transition-colors group-hover:text-primary"
          />
        </div>
        <div>
          <p className="font-label-md text-label-md text-primary">{project.name}</p>
          <div className="mt-0.5 flex items-center gap-2">
            <span className="font-body-sm text-body-sm text-secondary/50">
              {formatTimeAgo(project.lastOpened)}
            </span>
            <span className="text-secondary/30">·</span>
            <span className="font-label-sm text-[10px] text-secondary/40">
              {detectLanguage(project.path)}
            </span>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleStar(project);
          }}
          className={cn(
            "cursor-pointer rounded p-1 transition-all",
            isStarred
              ? "text-primary"
              : "text-secondary/0 group-hover:text-secondary/40 hover:text-primary"
          )}
          aria-label={isStarred ? "Unstar project" : "Star project"}
        >
          <Star size={13} strokeWidth={1.8} className={isStarred ? "fill-primary" : ""} />
        </button>
        <ExternalLink
          size={14}
          strokeWidth={1.8}
          className="text-secondary/0 transition-all group-hover:text-secondary/60"
        />
      </div>
    </li>
  );
}
