import { useEffect, useState } from "react";
import { ExternalLink, Folder, FolderOpen, FolderPlus, GitBranch, Globe2, KeyRound, LayoutGrid, List, Loader2, RefreshCw, Star, User, X } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import EmptyState from "@/Workspace/components/empty-state";
import GithubRepoCard from "@/Workspace/Projects/GithubRepoCard";
import { prefetchPreviews } from "@/Workspace/Marketplace/repoPreview";
import { useWorkspaceStore } from "@/Workspace/workspaceStore";
import { useRecentStore } from "@/Workspace/recentStore";
import { useGithubAccount } from "@/Git/githubAccount";
import type { GitHubRepo } from "../../../../shared/ipc-types";

type ProjectMode = "local" | "online";
type LocalView = "grid" | "list";

const LOCAL_VIEW_KEY = "xvie-projects-local-view";

function loadLocalView(): LocalView {
  try {
    return localStorage.getItem(LOCAL_VIEW_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

export default function ProjectsPage(): React.JSX.Element {
  const recentProjects = useRecentStore((s) => s.recentProjects);
  const starredProjects = useRecentStore((s) => s.starredProjects);
  const toggleStarred = useRecentStore((s) => s.toggleStarred);
  const openRecentProject = useWorkspaceStore((s) => s.openRecentProject);
  const openProject = useWorkspaceStore((s) => s.openProject);
  const openNewProject = useWorkspaceStore((s) => s.openNewProject);

  const user = useGithubAccount((s) => s.user);
  const configured = useGithubAccount((s) => s.configured);
  const accountLoading = useGithubAccount((s) => s.loading);
  const connecting = useGithubAccount((s) => s.connecting);
  const accountError = useGithubAccount((s) => s.error);
  const deviceCode = useGithubAccount((s) => s.deviceCode);
  const deviceUrl = useGithubAccount((s) => s.deviceUrl);
  const refreshAccount = useGithubAccount((s) => s.refresh);
  const connectToken = useGithubAccount((s) => s.connectToken);
  const startDevice = useGithubAccount((s) => s.startDevice);
  const cancelDevice = useGithubAccount((s) => s.cancelDevice);
  const signOut = useGithubAccount((s) => s.signOut);
  const clearAccountError = useGithubAccount((s) => s.clearError);

  const [mode, setMode] = useState<ProjectMode>("local");
  const [localView, setLocalView] = useState<LocalView>(loadLocalView);
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [repoPage, setRepoPage] = useState(1);
  const [hasMoreRepos, setHasMoreRepos] = useState(false);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [repoError, setRepoError] = useState("");
  const [cloning, setCloning] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [showTokenForm, setShowTokenForm] = useState(false);

  const changeLocalView = (view: LocalView): void => {
    setLocalView(view);
    try {
      localStorage.setItem(LOCAL_VIEW_KEY, view);
    } catch {
      // storage unavailable — best-effort
    }
  };

  const loadRepos = async (page: number, append: boolean): Promise<void> => {
    setLoadingRepos(true);
    setRepoError("");
    try {
      const result = await window.api.github.repositories(page);
      setRepos((current) => (append ? [...current, ...result.items] : result.items));
      setRepoPage(page);
      setHasMoreRepos(result.hasMore);
    } catch (e) {
      setRepoError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingRepos(false);
    }
  };

  useEffect(() => {
    void refreshAccount();
  }, [refreshAccount]);

  useEffect(() => {
    if (user) void loadRepos(1, false);
    else {
      setRepos([]);
      setHasMoreRepos(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Warm preview images for the first cards so heroes appear fast.
  useEffect(() => {
    if (!repos.length) return;
    const timer = window.setTimeout(() => prefetchPreviews(repos.slice(0, 8)), 400);
    return () => window.clearTimeout(timer);
  }, [repos]);

  const error = repoError || accountError;

  const openOnline = async (repo: GitHubRepo): Promise<void> => {
    setCloning(repo.full_name);
    setRepoError("");
    try {
      const result = await window.api.github.clone(repo.clone_url);
      if (result.canceled) return;
      if (!result.success) throw new Error(result.error);
      await openRecentProject(result.destination, repo.name);
    } catch (e) {
      setRepoError(e instanceof Error ? e.message : String(e));
    } finally {
      setCloning(null);
    }
  };

  return (
    <div className="flex flex-1 flex-col gap-xl">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div><h1 className="font-headline-lg text-headline-lg text-primary">Projects</h1><p className="mt-sm font-body-md text-body-md text-secondary/70">Your local work and GitHub repositories, together.</p></div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void openProject()} className="flex cursor-pointer items-center gap-2 rounded-lg border border-outline-variant/60 bg-surface px-3 py-2 font-label-md text-label-md text-primary hover:bg-surface-container-low"><FolderOpen size={15} /> Open project</button>
          <button type="button" onClick={openNewProject} className="flex cursor-pointer items-center gap-2 rounded-lg bg-primary px-3 py-2 font-label-md text-label-md font-medium text-on-primary hover:opacity-90"><FolderPlus size={15} /> New project</button>
        </div>
      </div>

      {/* Compact GitHub account bar */}
      <section className="flex flex-wrap items-center gap-3 rounded-xl border border-outline-variant/50 bg-surface px-4 py-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border border-outline-variant/50 bg-surface-container-high">
          {user && !avatarError ? <img src={user.avatar_url} alt={`${user.login} profile`} onError={() => setAvatarError(true)} className="h-full w-full object-cover" /> : user ? <User size={18} className="text-secondary" /> : <GitBranch size={18} className="text-secondary" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-label-md text-label-md font-medium text-primary">{user ? user.name || user.login : "Connect GitHub"}</p>
          {user ? (
            <p className="flex items-center gap-1.5 truncate font-body-sm text-body-sm text-secondary/65">
              <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
              Connected · @{user.login} · {user.public_repos} public repositor{user.public_repos === 1 ? "y" : "ies"}
            </p>
          ) : (
            <p className="truncate font-body-sm text-body-sm text-secondary/65">Clone repos, publish work, and sync from the Git overlay.</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {user ? (
            <>
              <button type="button" onClick={() => void loadRepos(1, false)} disabled={loadingRepos} aria-label="Refresh GitHub repositories" className="rounded-lg border border-outline-variant/50 p-1.5 text-secondary hover:bg-surface-container">
                <RefreshCw size={15} className={cn(loadingRepos && "animate-spin")} />
              </button>
              <button type="button" onClick={() => { void signOut(); setMode("local"); }} className="rounded-lg border border-outline-variant/50 px-3 py-1.5 font-label-sm text-label-sm text-secondary hover:text-primary">Disconnect</button>
            </>
          ) : configured ? (
            <button type="button" onClick={() => void startDevice()} disabled={connecting} className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 font-label-md text-label-md font-medium text-on-primary hover:opacity-90 disabled:opacity-50">
              {connecting ? <Loader2 size={16} className="animate-spin" /> : <GitBranch size={16} />} Connect GitHub
            </button>
          ) : (
            <button type="button" onClick={() => setShowTokenForm((v) => !v)} className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 font-label-md text-label-md font-medium text-on-primary hover:opacity-90">
              <KeyRound size={16} /> Connect with token
            </button>
          )}
        </div>
      </section>

      {/* Connection panel: device code OR token — always available */}
      {!user && (deviceCode || showTokenForm || !configured) && (
        <section className="rounded-xl border border-outline-variant/50 bg-surface p-4">
          {deviceCode ? (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="font-label-md text-label-md font-medium text-primary">Finish signing in to GitHub</p>
                <p className="mt-1 font-body-sm text-body-sm text-secondary">Enter this one-time code where GitHub asks for it.</p>
              </div>
              <div className="flex items-center gap-3">
                <code className="rounded-lg bg-surface-container px-3 py-2 font-mono text-lg tracking-[0.18em] text-primary">{deviceCode}</code>
                <a href={deviceUrl} target="_blank" rel="noreferrer" className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-on-primary">Open GitHub</a>
                <button type="button" onClick={cancelDevice} aria-label="Cancel GitHub sign-in" className="p-1 text-secondary hover:text-primary"><X size={16} /></button>
              </div>
            </div>
          ) : (
            <form
              className="flex flex-col gap-2.5"
              onSubmit={(e) => {
                e.preventDefault();
                void connectToken(tokenInput).then((ok) => {
                  if (ok) {
                    setTokenInput("");
                    setShowTokenForm(false);
                  }
                });
              }}
            >
              <div className="flex items-center gap-2">
                <KeyRound size={15} className="text-secondary" />
                <p className="text-sm font-medium text-primary">Paste a personal access token</p>
                {accountLoading && <Loader2 size={14} className="animate-spin text-secondary" />}
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="password"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder="ghp_… or github_pat_… (needs ‘repo’ scope)"
                  aria-label="GitHub personal access token"
                  autoComplete="off"
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded-lg border border-outline-variant/50 bg-background px-3 py-2.5 font-mono text-sm text-primary outline-none placeholder:text-secondary/40 focus:border-primary"
                />
                <button type="submit" disabled={connecting || !tokenInput.trim()} className="flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-on-primary disabled:opacity-40">
                  {connecting && <Loader2 size={14} className="animate-spin" />} Connect
                </button>
              </div>
              <p className="text-[11px] leading-relaxed text-secondary/60">
                GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token with <strong>repo</strong> scope. Stored encrypted on this device only.
                {configured && " Device sign-in is also available above."}
              </p>
            </form>
          )}
        </section>
      )}

      {error && (
        <p role="alert" className="rounded-xl border border-error/30 bg-error-container/30 px-4 py-3 font-body-sm text-body-sm text-on-error-container">
          {error}
          <button type="button" onClick={() => { setRepoError(""); clearAccountError(); }} aria-label="Dismiss error" className="float-right"><X size={15} /></button>
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-outline-variant/50 pb-3">
        <div className="inline-flex rounded-xl border border-outline-variant/50 bg-surface-container-low p-1" role="tablist" aria-label="Project source">
          {(["local", "online"] as ProjectMode[]).map((source) => (
            <button key={source} type="button" role="tab" aria-selected={mode === source} onClick={() => setMode(source)} className={cn("flex cursor-pointer items-center gap-2 rounded-lg px-4 py-2 font-label-md text-label-md capitalize transition", mode === source ? "bg-surface text-primary shadow-sm" : "text-secondary hover:text-primary")}>
              {source === "local" ? <Folder size={15} /> : <Globe2 size={15} />}{source === "online" ? "Online projects" : "Local projects"}{source === "local" ? ` · ${recentProjects.length}` : user ? ` · ${repos.length}` : ""}
            </button>
          ))}
        </div>
        {mode === "local" ? (
          <div className="inline-flex items-center gap-0.5 rounded-lg border border-outline-variant/50 bg-surface-container-low p-0.5" role="group" aria-label="Local project layout">
            {([["grid", LayoutGrid], ["list", List]] as const).map(([value, Icon]) => (
              <button key={value} type="button" aria-pressed={localView === value} onClick={() => changeLocalView(value)} aria-label={value === "grid" ? "Grid view" : "List view"} className={cn("cursor-pointer rounded-md p-1.5 transition", localView === value ? "bg-surface text-primary shadow-sm" : "text-secondary hover:text-primary")}>
                <Icon size={16} />
              </button>
            ))}
          </div>
        ) : user ? (
          <span className="font-body-sm text-body-sm text-secondary/60">Repositories from @{user.login}</span>
        ) : null}
      </div>

      {mode === "local" ? (
        recentProjects.length === 0 ? (
          <div className="flex flex-1 items-center justify-center"><EmptyState icon={Folder} title="No local projects yet" description="Open an existing project or create a new one to get started." actionLabel="New Project" actionIcon={FolderPlus} onAction={openNewProject} /></div>
        ) : (
          <div className={cn(localView === "grid" ? "grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5" : "flex flex-col gap-2")}>
            {recentProjects.map((project) => {
              const isStarred = starredProjects.some((s) => s.path === project.path);
              const openedLabel = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(project.lastOpened);
              if (localView === "list") {
                return (
                  <article key={project.path} className="group flex items-center gap-3 rounded-xl border border-outline-variant/40 bg-surface px-3.5 py-2.5 transition hover:border-outline-variant hover:shadow-sm">
                    <button type="button" onClick={() => void openRecentProject(project.path, project.name)} className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-container text-secondary group-hover:text-primary"><Folder size={16} /></span>
                      <span className="min-w-0 flex-1"><span className="block truncate font-headline-sm text-headline-sm font-medium text-primary">{project.name}</span><span className="mt-0.5 block truncate font-body-sm text-body-sm text-secondary/55">{project.path}</span></span>
                    </button>
                    <span className="hidden shrink-0 font-body-sm text-body-sm text-secondary/55 lg:block">Opened {openedLabel}</span>
                    <div className="flex shrink-0 items-center gap-1">
                      <button type="button" onClick={() => toggleStarred(project)} aria-label={isStarred ? "Unstar project" : "Star project"} className={cn("rounded p-1.5", isStarred ? "text-primary" : "text-secondary/50 hover:text-primary")}><Star size={15} className={cn(isStarred && "fill-primary")} /></button>
                      <button type="button" onClick={() => void openRecentProject(project.path, project.name)} aria-label="Open project" className="rounded p-1.5 text-secondary/50 hover:text-primary"><ExternalLink size={15} /></button>
                    </div>
                  </article>
                );
              }
              return (
                <article key={project.path} className="group flex flex-col rounded-xl border border-outline-variant/40 bg-surface p-3 transition hover:border-outline-variant hover:shadow-md">
                  <button type="button" onClick={() => void openRecentProject(project.path, project.name)} className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 text-left">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-container text-secondary group-hover:text-primary"><Folder size={16} /></span>
                    <span className="min-w-0 flex-1"><span className="block truncate font-headline-sm text-headline-sm font-medium text-primary">{project.name}</span><span className="mt-0.5 block truncate font-body-sm text-body-sm text-secondary/50">{project.path}</span></span>
                  </button>
                  <div className="mt-2.5 flex items-center justify-between border-t border-outline-variant/30 pt-2.5">
                    <span className="truncate font-body-sm text-body-sm text-secondary/50">Opened {openedLabel}</span>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button type="button" onClick={() => toggleStarred(project)} aria-label={isStarred ? "Unstar project" : "Star project"} className={cn("rounded p-1", isStarred ? "text-primary" : "text-secondary/50 hover:text-primary")}><Star size={14} className={cn(isStarred && "fill-primary")} /></button>
                      <button type="button" onClick={() => void openRecentProject(project.path, project.name)} aria-label="Open project" className="rounded p-1 text-secondary/50 hover:text-primary"><ExternalLink size={14} /></button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )
      ) : !user ? (
        <div className="rounded-2xl border border-dashed border-outline-variant/60 px-6 py-12 text-center">
          <GitBranch size={30} className="mx-auto text-secondary/60" />
          <h3 className="mt-3 font-headline-sm text-headline-sm font-medium text-primary">Connect your GitHub account</h3>
          <p className="mt-1 font-body-sm text-body-sm text-secondary/60">Your repositories will appear here after sign-in.</p>
          <button type="button" onClick={() => (configured ? void startDevice() : setShowTokenForm(true))} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 font-label-md text-label-md text-on-primary"><GitBranch size={14} /> Connect GitHub</button>
        </div>
      ) : loadingRepos && !repos.length ? (
        <div className="py-12 text-center font-body-sm text-body-sm text-secondary">Loading your repositories…</div>
      ) : repos.length === 0 ? (
        <div className="rounded-xl border border-dashed border-outline-variant/50 py-12 text-center font-body-sm text-body-sm text-secondary">No repositories found for this account.</div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {repos.map((repo) => (
            <GithubRepoCard key={repo.id} repo={repo} cloning={cloning === repo.full_name} onClone={(r) => void openOnline(r)} />
          ))}
        </div>
      )}
      {mode === "online" && user && hasMoreRepos && !loadingRepos && (
        <button type="button" onClick={() => void loadRepos(repoPage + 1, true)} className="mx-auto rounded-lg border border-outline-variant/50 px-5 py-2 font-label-sm text-label-sm text-primary hover:bg-surface-container-low">Load more repositories</button>
      )}
    </div>
  );
}
