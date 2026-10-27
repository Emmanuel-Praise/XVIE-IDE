import { Children, isValidElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle, ArrowUp, Check, ChevronDown, CircleDot, Clock3, FolderGit2,
  GitBranch, GitCommitHorizontal, GitFork, GitMerge, LoaderCircle, LockKeyhole, Plus,
  LocateFixed, RefreshCw, Search, SlidersHorizontal, Star, X, ZoomIn, ZoomOut
} from "lucide-react";
import type { GitCommit, GitHubRepo, GitStatus } from "../../../shared/ipc-types";
import { buildGitGraphLayout, commitChangeTotals, type GraphSpacing } from "./gitGraphLayout";
import { useFileSystemStore } from "@/Editor/fs/fileSystemStore";
import { useRecentStore, type RecentProject } from "@/Workspace/recentStore";
import { useWorkspaceStore } from "@/Workspace/workspaceStore";
import { useGithubAccount } from "@/Git/githubAccount";
import { cn } from "@/shared/lib/utils";

type GitTab = "repositories" | "git";
const laneColors = ["#65b4ca", "#a99bd0", "#74b99c", "#c5a66c", "#c98e98", "#72aaa5"];

function shortHash(hash: string): string { return hash.slice(0, 7); }
function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
function normalizedRemote(value: string | null | undefined): string {
  return (value ?? "").replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();
}

export default function GitPage(): React.JSX.Element {
  const workspace = useFileSystemStore((state) => state.workspace);
  const recentProjects = useRecentStore((state) => state.recentProjects);
  const openRecentProject = useWorkspaceStore((state) => state.openRecentProject);
  const openProject = useWorkspaceStore((state) => state.openProject);
  const account = useGithubAccount();

  const [tab, setTab] = useState<GitTab>("repositories");
  const [sidebarWidth, setSidebarWidth] = useState(290);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const [githubRepos, setGithubRepos] = useState<GitHubRepo[]>([]);
  const [reposPage, setReposPage] = useState(1);
  const [hasMoreRepos, setHasMoreRepos] = useState(false);
  const [reposLoading, setReposLoading] = useState(false);
  const [repoSearch, setRepoSearch] = useState("");
  const [repoFilter, setRepoFilter] = useState("all");
  const [repoTotal, setRepoTotal] = useState(0);
  const [selectedRepoId, setSelectedRepoId] = useState<number | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [newRepoName, setNewRepoName] = useState("");
  const [newRepoDescription, setNewRepoDescription] = useState("");
  const [newRepoPrivate, setNewRepoPrivate] = useState(true);
  const [identityModalOpen, setIdentityModalOpen] = useState(false);

  const [status, setStatus] = useState<GitStatus | null>(null);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [currentBranch, setCurrentBranch] = useState("");
  const [selectedHash, setSelectedHash] = useState("");
  const [graphSpacing, setGraphSpacing] = useState<GraphSpacing>("compact");
  const [graphZoom, setGraphZoom] = useState(1);
  const [graphPan, setGraphPan] = useState({ x: 0, y: 0 });
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const [openBranches, setOpenBranches] = useState<Set<string>>(() => new Set());
  const [pendingGraphFocus, setPendingGraphFocus] = useState<string | null>(null);
  const graphViewport = useRef<HTMLDivElement>(null);
  const graphPanStart = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [newBranchName, setNewBranchName] = useState("");
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const selectedRepo = githubRepos.find((repo) => repo.id === selectedRepoId) ?? null;
  const selectedCommit = commits.find((commit) => commit.hash === selectedHash) ?? commits[0] ?? null;
  const selectedFileChanges = selectedCommit?.fileChanges ?? selectedCommit?.files.map((path) => ({ path, status: "modified" as const, insertions: 0, deletions: 0, binary: false })) ?? [];
  const connected = !!selectedRepo && normalizedRemote(status?.remote) === normalizedRemote(selectedRepo.clone_url);
  const setZoomAroundCenter = (nextZoom: number): void => {
    const zoom = Math.max(0.4, Math.min(2.5, nextZoom));
    const bounds = graphViewport.current?.getBoundingClientRect();
    const centerX = (bounds?.width ?? 0) / 2;
    const centerY = (bounds?.height ?? 0) / 2;
    const ratio = zoom / graphZoom;
    setGraphPan((pan) => ({ x: centerX - (centerX - pan.x) * ratio, y: centerY - (centerY - pan.y) * ratio }));
    setGraphZoom(zoom);
  };
  const languageFilters = useMemo(() => {
    const counts = new Map<string, number>();
    for (const repo of githubRepos) if (repo.language) counts.set(repo.language, (counts.get(repo.language) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 4);
  }, [githubRepos]);
  const filteredRepos = useMemo(() => {
    const query = repoSearch.trim().toLowerCase();
    return githubRepos.filter((repo) => {
      const matchesQuery = !query || `${repo.full_name} ${repo.description ?? ""}`.toLowerCase().includes(query);
      const matchesFilter = repoFilter === "all" || (repoFilter === "private" ? repo.private : repo.language === repoFilter);
      return matchesQuery && matchesFilter;
    });
  }, [githubRepos, repoSearch, repoFilter]);

  const loadRepositories = useCallback(async (page = 1, append = false): Promise<void> => {
    setReposLoading(true);
    setError("");
    try {
      const result = await window.api.github.repositories(page);
      setRepoTotal(result.totalCount);
      setGithubRepos((current) => {
        const combined = append ? [...current, ...result.items] : result.items;
        return [...new Map(combined.map((repo) => [repo.id, repo])).values()];
      });
      if (selectedRepoId === null && result.items.length) setSelectedRepoId(result.items[0].id);
      setReposPage(page);
      setHasMoreRepos(result.hasMore);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setReposLoading(false); }
  }, [selectedRepoId]);

  const refreshGit = useCallback(async (): Promise<void> => {
    if (!workspace) { setStatus(null); setCommits([]); setBranches([]); setCurrentBranch(""); return; }
    setLoading(true);
    setError("");
    try {
      const nextStatus = await window.api.git.status(workspace.path);
      setStatus(nextStatus);
      if (!nextStatus.initialized) {
        setCommits([]); setBranches([]); setCurrentBranch(""); setSelectedHash("");
        return;
      }
      const [history, branchData] = await Promise.all([
        window.api.git.history(workspace.path),
        window.api.git.branches(workspace.path)
      ]);
      setCommits(history);
      setBranches(branchData.branches);
      setCurrentBranch(branchData.current || nextStatus.branch);
      setSelectedHash((current) => history.some((commit) => commit.hash === current) ? current : history[0]?.hash ?? "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setLoading(false); }
  }, [workspace]);

  useEffect(() => { void account.refresh(); }, []);
  useEffect(() => { if (account.user) void loadRepositories(1); else setGithubRepos([]); }, [account.user]);
  useEffect(() => { void refreshGit(); }, [refreshGit]);

  const runGitAction = async (label: string, operation: () => Promise<{ success: boolean; error?: string }>, successMessage: string): Promise<boolean> => {
    setAction(label); setError(""); setNotice("");
    try {
      const result = await operation();
      if (!result.success) { setError(result.error ?? `${label} failed.`); return false; }
      setNotice(successMessage);
      await refreshGit();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally { setAction(""); }
  };

  const createBranch = async (): Promise<void> => {
    if (!workspace || !newBranchName.trim()) return;
    const name = newBranchName.trim();
    setAction("Create branch"); setError(""); setNotice("");
    try {
      const result = await window.api.git.createBranch(workspace.path, name);
      if (!result.success) throw new Error(result.error ?? `Could not create branch ${name}.`);
      const checkout = await window.api.git.branches(workspace.path);
      if (checkout.current !== name) throw new Error(`Branch ${name} was created, but Git is still on ${checkout.current || "detached HEAD"}. Re-select the branch to switch to it.`);
      setBranches(checkout.branches);
      setCurrentBranch(checkout.current);
      setNotice(`Created and switched to ${name}.`);
      setNewBranchName("");
      await refreshGit();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setAction(""); }
  };

  const connectSelected = async (): Promise<void> => {
    if (!workspace || !selectedRepo) return;
    if (!status?.initialized) {
      setTab("git");
      setError("Initialize Git in the active project first. Your selected GitHub repository is ready to connect afterward.");
      return;
    }
    const ok = await runGitAction("Connect", () => window.api.git.setRemote(workspace.path, selectedRepo.clone_url), `Connected ${selectedRepo.full_name} to ${workspace.name}.`);
    if (ok) setTab("git");
  };

  const createRepository = async (): Promise<void> => {
    if (!newRepoName.trim()) return;
    setReposLoading(true); setError("");
    try {
      const repo = await window.api.github.createRepository(newRepoName.trim(), newRepoDescription.trim(), newRepoPrivate);
      setGithubRepos((current) => [repo, ...current.filter((item) => item.id !== repo.id)]);
      setSelectedRepoId(repo.id);
      setNewRepoName(""); setNewRepoDescription(""); setCreateOpen(false);
      setNotice(`Created ${repo.full_name}. Select it and connect it to the active project to push.`);
      const localStatus = workspace ? await window.api.git.status(workspace.path) : null;
      if (localStatus) setStatus(localStatus);
      if (workspace && localStatus?.initialized) {
        const result = await window.api.git.setRemote(workspace.path, repo.clone_url);
        if (!result.success) throw new Error(result.error ?? "Repository was created, but could not be connected to this project.");
        setNotice(`Created and connected ${repo.full_name}. You can push from the Git tab.`);
        await refreshGit();
        setTab("git");
      } else if (workspace) {
        setTab("git");
        setError("GitHub repository created. Initialize Git in the active project, then connect this repository.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setReposLoading(false); }
  };

  const switchProject = async (path: string): Promise<void> => {
    const project = recentProjects.find((item) => item.path === path);
    if (!project || project.path === workspace?.path) return;
    setError(""); setNotice("");
    await openRecentProject(project.path, project.name);
  };

  const graph = useMemo(() => buildGitGraphLayout(commits, {
    currentBranch,
    branchNames: branches,
    openBranches,
    expandedGroups,
    spacing: graphSpacing
  }), [commits, currentBranch, branches, openBranches, expandedGroups, graphSpacing]);

  const focusCommit = (hash: string): void => {
    setSelectedHash(hash);
    const point = graph.positions.get(graph.groupForHash.get(hash) ?? -1);
    const bounds = graphViewport.current?.getBoundingClientRect();
    if (point && bounds) setGraphPan({ x: bounds.width / 2 - point.x * graphZoom, y: bounds.height / 2 - point.y * graphZoom });
  };

  useEffect(() => {
    if (!pendingGraphFocus) return;
    const point = graph.positions.get(graph.groupForHash.get(pendingGraphFocus) ?? -1);
    const bounds = graphViewport.current?.getBoundingClientRect();
    if (point && bounds) setGraphPan({ x: bounds.width / 2 - point.x * graphZoom, y: bounds.height / 2 - point.y * graphZoom });
    setPendingGraphFocus(null);
  }, [graph, graphZoom, pendingGraphFocus]);

  const toggleBranch = (branchKey: string): void => {
    const branch = graph.branches.find((item) => item.key === branchKey);
    if (!branch) return;
    const closing = openBranches.has(branchKey);
    const affected = new Set<string>([branchKey]);
    if (closing) {
      let changed = true;
      while (changed) {
        changed = false;
        for (const [child, parent] of graph.branchParents) if (affected.has(parent) && !affected.has(child)) {
          affected.add(child);
          changed = true;
        }
      }
    }
    setOpenBranches((current) => {
      const next = new Set(current);
      if (closing) for (const key of affected) next.delete(key);
      else next.add(branchKey);
      return next;
    });
    const target = closing ? branch.forkHash ?? branch.mergeHash ?? branch.tipHash : branch.tipHash;
    if (target) {
      setSelectedHash(target);
      setPendingGraphFocus(target);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside style={{ width: `min(${sidebarWidth}px, max(180px, calc(100vw - 440px)))` }} className="flex min-w-0 shrink-0 flex-col border-r border-outline-variant/80 bg-surface-container-lowest">
          <div className="mx-2 mt-2 grid grid-cols-2 gap-1 rounded-xl bg-surface-container-low p-1">
            <TabButton active={tab === "repositories"} onClick={() => setTab("repositories")}>Repositories</TabButton>
            <TabButton active={tab === "git"} onClick={() => setTab("git")}>Git</TabButton>
          </div>

          {tab === "repositories" ? <>
            <div className="px-3 pb-3 pt-3">
              <div className="mb-3 flex items-center gap-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-container text-[11px] font-semibold text-on-surface">{account.user?.login.slice(0, 2).toUpperCase() ?? "GH"}</span>
                <span className="min-w-0 flex-1"><span className="block font-body-md text-body-md font-semibold text-on-surface">GitHub</span><span className="block truncate font-label-sm text-label-sm text-secondary">{account.user ? `@${account.user.login}` : "Connect an account"}</span></span>
                <button type="button" aria-label="Refresh GitHub repositories" onClick={() => void loadRepositories(1)} disabled={!account.user || reposLoading} className="rounded-lg bg-surface-container-low p-2 text-secondary transition hover:text-on-surface disabled:opacity-40"><RefreshCw size={14} className={reposLoading ? "animate-spin" : ""} /></button>
                <button type="button" aria-label="Create GitHub repository" onClick={() => { setError(""); setNewRepoName(workspace?.name ?? ""); setCreateOpen(true); }} disabled={!account.user} className="rounded-lg bg-surface-container-low p-2 text-secondary transition hover:text-on-surface disabled:opacity-40"><Plus size={14} /></button>
              </div>
              {account.user ? <label className="flex items-center gap-2 rounded-lg bg-surface-container-low px-2.5 py-2 focus-within:ring-1 focus-within:ring-primary/50"><Search size={13} className="shrink-0 text-secondary" /><input value={repoSearch} onChange={(event) => setRepoSearch(event.target.value)} placeholder="Find a repository" className="min-w-0 flex-1 bg-transparent font-body-sm text-body-sm text-on-surface outline-none placeholder:text-secondary" /></label> : <p className="font-body-sm text-body-sm text-secondary">Connect your account to browse repositories.</p>}
            </div>

            {!account.user ? <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
              {account.deviceCode ? <div className="rounded-xl border border-outline-variant bg-surface-container-low p-3 text-center"><p className="font-body-sm text-body-sm text-secondary">Enter this one-time code on GitHub</p><code className="my-2 block font-mono text-xl font-bold tracking-widest text-on-surface">{account.deviceCode}</code><a target="_blank" rel="noreferrer" href={account.deviceUrl} className="font-label-sm text-label-sm text-primary underline">Open GitHub</a><p className="mt-3 flex items-center justify-center gap-2 font-label-sm text-label-sm text-secondary"><LoaderCircle size={13} className="animate-spin" />Waiting for sign-in</p></div> : <button type="button" onClick={() => void account.startDevice()} className="mb-3 flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2.5 font-label-md text-label-md text-on-primary"><GitFork size={15} />Sign in with GitHub</button>}
              {account.error && <p className="mb-3 rounded-lg bg-error-container p-2.5 font-label-sm text-label-sm text-on-error-container">{account.error}</p>}
              <form onSubmit={(event) => { event.preventDefault(); void account.connectToken(tokenInput).then((success) => { if (success) setTokenInput(""); }); }}>
                <label className="mb-1.5 block font-label-sm text-label-sm text-secondary">Or use a personal access token</label>
                <input type="password" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} autoComplete="off" placeholder="Token with repo access" className="mb-2 w-full rounded-lg border border-outline-variant bg-background px-3 py-2 font-mono text-xs text-on-surface outline-none focus:border-primary" />
                <button type="submit" disabled={!tokenInput.trim() || account.connecting} className="w-full rounded-lg border border-outline-variant px-3 py-2 font-label-sm text-label-sm text-on-surface hover:bg-surface-container-low disabled:opacity-50">{account.connecting ? "Connectingâ€¦" : "Connect token"}</button>
              </form>
            </div> : <>
              <div className="flex shrink-0 gap-1.5 overflow-x-auto px-3 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <RepoFilterButton active={repoFilter === "all"} onClick={() => setRepoFilter("all")}>All {repoTotal || githubRepos.length}</RepoFilterButton>
                <RepoFilterButton active={repoFilter === "private"} onClick={() => setRepoFilter("private")}>Private {githubRepos.filter((repo) => repo.private).length}</RepoFilterButton>
                {languageFilters.map(([language, count]) => <RepoFilterButton key={language} active={repoFilter === language} onClick={() => setRepoFilter(language)}>{language} {count}</RepoFilterButton>)}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
                {reposLoading && githubRepos.length === 0 ? <div className="flex justify-center py-8 text-secondary"><LoaderCircle size={18} className="animate-spin" /></div> : filteredRepos.length ? filteredRepos.map((repo) => <button key={repo.id} type="button" onClick={() => setSelectedRepoId(repo.id)} className={cn("group mb-1.5 flex w-full items-start gap-2.5 rounded-xl border px-2.5 py-2.5 text-left transition", selectedRepoId === repo.id ? "-translate-y-0.5 border-emerald-500/80 bg-emerald-500/10 text-on-surface shadow-[0_0_0_1px_rgba(16,185,129,0.12),0_5px_14px_rgba(0,0,0,0.18)]" : "border-outline-variant/50 bg-surface-container-lowest text-secondary hover:bg-surface-container-low")}><span className={cn("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full", selectedRepoId === repo.id ? "bg-emerald-500 text-white" : "bg-surface-container text-secondary")}><GitFork size={12} /></span><span className="min-w-0 flex-1"><span className="flex min-w-0 items-center gap-1"><span className="truncate font-label-md text-label-md font-semibold text-on-surface">{repo.name}</span>{repo.private && <LockKeyhole size={10} className="shrink-0 text-secondary" />}{selectedRepoId === repo.id ? <Check size={12} className="ml-auto shrink-0 text-emerald-400" /> : <span className="ml-auto h-4 w-4 shrink-0 rounded-full border border-outline-variant/70" />}</span><span className="mt-1 flex items-center gap-1.5 text-[11px] leading-4 text-secondary">{repo.language && <><span className="h-1.5 w-1.5 rounded-full bg-sky-400" />{repo.language}</>}{repo.language && repo.default_branch && <span>Â·</span>}{repo.default_branch && <span className="truncate">{repo.default_branch}</span>}<Star size={9} className="ml-auto" />{repo.stargazers_count}</span></span></button>) : <div className="px-3 py-8 text-center"><GitFork size={20} className="mx-auto mb-2 text-secondary/70" /><p className="font-body-sm text-body-sm text-secondary">{repoSearch || repoFilter !== "all" ? "No repositories match these filters." : "No repositories found."}</p></div>}
                {hasMoreRepos && !repoSearch && <button type="button" onClick={() => void loadRepositories(reposPage + 1, true)} disabled={reposLoading} className="my-2 w-full rounded-lg border border-outline-variant px-3 py-2 font-label-sm text-label-sm text-secondary hover:bg-surface-container-low disabled:opacity-50">{reposLoading ? "Loadingâ€¦" : "Load more repositories"}</button>}
              </div>
              <div className="relative z-20 -mt-4 bg-surface-container-lowest px-2 pb-2 pt-4 shadow-[0_-10px_20px_rgba(0,0,0,0.28)]">
                <div className="mb-2 flex min-w-0 items-center justify-between gap-2 px-1"><span className="min-w-0"><span className="block font-label-sm text-label-sm text-secondary">Selected repository</span><span className="block truncate font-label-md text-label-md font-medium text-on-surface">{selectedRepo?.full_name ?? "Choose a repository"}</span></span>{currentBranch && <span className="flex shrink-0 items-center gap-1.5 rounded-lg bg-surface-container-low px-2 py-1.5 font-label-sm text-label-sm text-on-surface"><GitBranch size={11} />{currentBranch}</span>}</div>
                <button type="button" disabled={!selectedRepo || !workspace || action !== ""} onClick={() => void connectSelected()} className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-2.5 py-2.5 font-label-md text-label-md font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-45">{connected ? <Check size={14} /> : <GitBranch size={14} />}{connected ? "Connected to project" : "Connect to project"}</button>
                {!workspace && <p className="mt-2 text-center font-label-sm text-label-sm text-secondary">Open a project in the editor first.</p>}
              </div>
            </>}
          </> : <GitControls
            workspace={workspace}
            projects={recentProjects}
            status={status}
            branches={branches}
            currentBranch={currentBranch}
            commitMessage={commitMessage}
            newBranchName={newBranchName}
            branchMenuOpen={branchMenuOpen}
            action={action}
            onOpenProject={() => void openProject()}
            onSwitchProject={(path) => void switchProject(path)}
            onInitialize={() => { setError(""); setIdentityModalOpen(true); }}
            onBranchMenuOpenChange={setBranchMenuOpen}
            onCommitMessage={setCommitMessage}
            onNewBranchName={setNewBranchName}
            onSwitchBranch={(name) => { if (workspace) void runGitAction("Switch branch", () => window.api.git.switchBranch(workspace.path, name), `Switched to ${name}.`); setBranchMenuOpen(false); }}
            onCreateBranch={() => void createBranch()}
            onCommit={() => { if (workspace) void runGitAction("Commit", () => window.api.git.commit(workspace.path, commitMessage), "Changes committed.").then((ok) => { if (ok) setCommitMessage(""); }); }}
            onPush={() => { if (workspace) void runGitAction("Push", () => window.api.git.push(workspace.path), "Your code was pushed to GitHub."); }}
            onConnectRepo={() => setTab("repositories")}
          />}
        </aside>

        <div
          role="separator"
          aria-label="Resize repository sidebar"
          aria-orientation="vertical"
          onPointerDown={(event) => { resizeStart.current = { x: event.clientX, width: sidebarWidth }; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={(event) => { if (resizeStart.current) setSidebarWidth(Math.max(210, Math.min(420, resizeStart.current.width + event.clientX - resizeStart.current.x))); }}
          onPointerUp={(event) => { resizeStart.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
          onPointerCancel={() => { resizeStart.current = null; }}
          className="z-10 w-1 shrink-0 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-primary/30"
        />

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
          <div className="flex min-h-[64px] shrink-0 items-center justify-between gap-4 border-b border-outline-variant/80 px-5">
            <div className="min-w-0"><h2 className="font-headline-sm text-headline-sm font-semibold text-on-surface">Commit history</h2><p className="font-body-sm text-body-sm text-secondary">{status?.initialized ? `${commits.length} commits Â· ${branches.length} local ${branches.length === 1 ? "branch" : "branches"} Â· flows down from oldest to latest` : "Initialize Git in your project to view its history"}</p></div>
            <div className="flex shrink-0 items-center gap-3">
              <button type="button" aria-label="Refresh Git history" onClick={() => void refreshGit()} disabled={loading} className="rounded-md p-2 text-secondary transition hover:bg-surface-container-low hover:text-on-surface disabled:opacity-50"><RefreshCw size={14} className={loading ? "animate-spin" : ""} /></button>
              <div className="flex items-center gap-1 rounded-lg bg-surface-container-low p-1" aria-label="Graph spacing">
                <SlidersHorizontal size={14} className="ml-1.5 text-secondary" />
                {(["compact", "roomy"] as const).map((spacing) => <button key={spacing} type="button" aria-pressed={graphSpacing === spacing} onClick={() => setGraphSpacing(spacing)} className={cn("rounded-md px-2 py-1 font-label-sm text-label-sm capitalize transition", graphSpacing === spacing ? "bg-surface-container text-on-surface" : "text-secondary hover:text-on-surface")}>{spacing}</button>)}
              </div>
              <span className="flex items-center gap-2 rounded-full bg-surface-container-low px-3 py-1.5 font-label-sm text-label-sm text-on-surface"><span className="h-2 w-2 rounded-full bg-sky-500" />{currentBranch || "No branch"}</span>
            </div>
          </div>
          <div className="relative min-h-0 flex-1 overflow-hidden p-4 lg:p-5">
            {error && <div role="alert" className="mb-3 flex items-start gap-2 rounded-xl border border-error/30 bg-error-container/50 px-3.5 py-3 font-body-sm text-body-sm text-on-error-container"><AlertCircle size={15} className="mt-0.5 shrink-0" />{error}</div>}
            {notice && !error && <div role="status" className="mb-3 flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3.5 py-2.5 font-body-sm text-body-sm text-on-surface"><Check size={15} className="text-emerald-600" />{notice}</div>}
            {loading && commits.length === 0 ? <EmptyGraph><LoaderCircle size={18} className="animate-spin" />Loading historyâ€¦</EmptyGraph> : !workspace ? <EmptyGraph><FolderGit2 size={24} /><strong>Open a project to get started</strong><span>Choose a project in the Git tab, then initialize or connect its Git history.</span><button type="button" onClick={() => setTab("git")} className="mt-2 rounded-lg bg-primary px-3 py-2 font-label-md text-label-md text-on-primary">Choose project</button></EmptyGraph> : !status?.initialized ? <EmptyGraph><GitBranch size={24} /><strong>Start tracking this project</strong><span>Initialize Git in the Git tab to create a real commit history.</span><button type="button" onClick={() => setTab("git")} className="mt-2 rounded-lg bg-primary px-3 py-2 font-label-md text-label-md text-on-primary">Open Git controls</button></EmptyGraph> : commits.length === 0 ? <EmptyGraph><GitCommitHorizontal size={25} /><strong>No commits yet</strong><span>Commit your first changes from the Git tab.</span><button type="button" onClick={() => setTab("git")} className="mt-2 rounded-lg bg-primary px-3 py-2 font-label-md text-label-md text-on-primary">Create first commit</button></EmptyGraph> : <div ref={graphViewport} className="relative h-full min-h-[260px] w-full select-none overflow-hidden" aria-label="Commit graph canvas" onPointerDown={(event) => { if ((event.target as HTMLElement).closest("button")) return; graphPanStart.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX: graphPan.x, panY: graphPan.y }; event.currentTarget.style.cursor = "grabbing"; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { const drag = graphPanStart.current; if (!drag || drag.pointerId !== event.pointerId) return; setGraphPan({ x: drag.panX + event.clientX - drag.x, y: drag.panY + event.clientY - drag.y }); }} onPointerUp={(event) => { graphPanStart.current = null; event.currentTarget.style.cursor = "grab"; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={(event) => { graphPanStart.current = null; event.currentTarget.style.cursor = "grab"; }} style={{ cursor: "grab", touchAction: "none" }}>
              <div className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-lg bg-surface-container-lowest/95 p-1 shadow-lg backdrop-blur">
                <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => setZoomAroundCenter(graphZoom - 0.15)} disabled={graphZoom <= 0.4} className="rounded-md p-2 text-secondary transition hover:bg-surface-container hover:text-on-surface disabled:opacity-40"><ZoomOut size={15} /></button>
                <button type="button" aria-label="Reset graph zoom and position" title="Reset view" onClick={() => { setGraphZoom(1); setGraphPan({ x: 0, y: 0 }); }} className="min-w-12 rounded-md px-1.5 py-1.5 font-mono text-[11px] text-secondary transition hover:bg-surface-container hover:text-on-surface"><span className="sr-only">Reset view </span>{Math.round(graphZoom * 100)}%</button>
                <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => setZoomAroundCenter(graphZoom + 0.15)} disabled={graphZoom >= 2.5} className="rounded-md p-2 text-secondary transition hover:bg-surface-container hover:text-on-surface disabled:opacity-40"><ZoomIn size={15} /></button>
                <span className="mx-0.5 h-5 w-px bg-outline-variant/60" />
                <button type="button" aria-label="Reset graph position" title="Reset position" onClick={() => setGraphPan({ x: 0, y: 0 })} className="rounded-md p-2 text-secondary transition hover:bg-surface-container hover:text-on-surface"><LocateFixed size={14} /></button>
              </div>
              <div className="absolute left-0 top-0" style={{ width: graph.width * graphZoom, height: graph.height * graphZoom, transform: `translate(${graphPan.x}px, ${graphPan.y}px)` }}>
              <div className="relative" style={{ width: graph.width, height: graph.height, transform: `scale(${graphZoom})`, transformOrigin: "top left" }}>
                <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
                  {graph.parentEdges.map((edge, index) => {
                    const source = graph.positions.get(edge.fromGroup);
                    const target = graph.positions.get(edge.toGroup);
                    if (!source || !target) return null;
                    const fromHeight = graph.groupHeights.get(edge.fromGroup) ?? 160;
                    const toHeight = graph.cardHeights.get(edge.toGroup) ?? 160;
                    const color = laneColors[(graph.grouped[edge.toGroup].lane % laneColors.length)];
                    const sourceBottom = source.y - 80 + fromHeight;
                    const targetTop = target.y - toHeight / 2;
                    let path: string;
                    if (source.lane === target.lane) {
                      path = `M ${source.x} ${sourceBottom} V ${targetTop}`;
                    } else {
                      const direction = target.x > source.x ? 1 : -1;
                      const outgoing = graph.parentEdges.filter((candidate) => candidate.parentHash === edge.parentHash);
                      const outgoingIndex = outgoing.findIndex((candidate) => candidate.childHash === edge.childHash);
                      const sourcePortX = source.x + (outgoingIndex - (outgoing.length - 1) / 2) * 14;
                      const incoming = graph.parentEdges.filter((candidate) => candidate.childHash === edge.childHash);
                      const incomingIndex = incoming.findIndex((candidate) => candidate.parentHash === edge.parentHash);
                      const targetPortY = target.y + (incomingIndex - (incoming.length - 1) / 2) * 14;
                      const targetEdge = target.x - direction * graph.cardWidth / 2;
                      const targetGutter = targetEdge - direction * 12;
                      const rowRouteY = (graph.rowGapRoutes.get(source.row) ?? sourceBottom + 8) + (index % 4) * 3;
                      path = `M ${sourcePortX} ${sourceBottom} V ${rowRouteY} H ${targetGutter} V ${targetPortY} H ${targetEdge}`;
                    }
                    return <path key={`${edge.parentHash}-${edge.childHash}-${index}`} d={path} fill="none" stroke={color} strokeWidth={edge.parentHash === graph.grouped[edge.fromGroup].commits.at(-1)?.hash ? 2.6 : 1.8} strokeOpacity=".78" strokeLinecap="round" strokeLinejoin="round" />;
                  })}
                  {graph.foldedForkEdges.map(({ branchKey, fromGroup }, index) => {
                    const source = graph.positions.get(fromGroup);
                    const target = graph.branchPositions.get(branchKey);
                    const branch = graph.visibleBranches.find((item) => item.key === branchKey);
                    if (!source || !target || !branch) return null;
                    const direction = target.x > source.x ? 1 : -1;
                    const startX = source.x + direction * graph.cardWidth / 2;
                    const endX = target.x - direction * graph.branchCardWidth / 2;
                    const color = laneColors[target.lane % laneColors.length];
                    const siblings = graph.foldedForkEdges.filter((edge) => edge.fromGroup === fromGroup);
                    const siblingOffset = (siblings.findIndex((edge) => edge.branchKey === branchKey) - (siblings.length - 1) / 2) * 12;
                    const sourcePortY = source.y + siblingOffset;
                    const path = source.row === target.row && Math.abs(source.lane - target.lane) === 1
                      ? `M ${startX} ${sourcePortY} H ${endX}`
                      : `M ${startX} ${sourcePortY} V ${(graph.rowGapRoutes.get(source.row) ?? source.y + 88) + siblingOffset} H ${endX - direction * 12} V ${target.y} H ${endX}`;
                    return <path key={`fork-${branchKey}`} d={path} fill="none" stroke={color} strokeWidth="2.4" strokeOpacity=".72" strokeDasharray="6 5" strokeLinecap="round" />;
                  })}
                </svg>
                {graph.visibleGroups.map((groupIndex) => {
                  const graphGroup = graph.grouped[groupIndex];
                  const group = graphGroup.commits;
                  const first = group[0];
                  const commit = group[group.length - 1];
                  const point = graph.positions.get(groupIndex) ?? { x: 174, y: 54 };
                  const lane = graphGroup.lane;
                  const color = laneColors[lane % laneColors.length];
                  const selected = group.some((item) => item.hash === selectedCommit?.hash);
                  const labels = commit.refs.map((ref) => ref.startsWith("HEAD -> ") ? ref.slice(8) : ref).filter((ref) => !ref.startsWith("tag: "));
                  const expanded = expandedGroups.has(first.hash);
                  const groupTotals = group.reduce((total, item) => {
                    const changes = commitChangeTotals(item);
                    total.insertions += changes.insertions;
                    total.deletions += changes.deletions;
                    return total;
                  }, { insertions: 0, deletions: 0 });
                  const cardClass = cn("relative flex w-full items-center gap-4 overflow-hidden rounded-2xl border bg-surface-container-lowest px-5 py-4 text-left shadow-lg transition duration-150 hover:-translate-y-0.5 hover:bg-surface-container-low focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60", selected && "ring-2 ring-white/20");
                  const cardStyle = { borderColor: `${color}80`, boxShadow: selected ? `0 0 0 1px ${color}55, 0 8px 20px #0005` : "0 4px 14px #0003" };
                  const cardContents = <><span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border" style={{ color, borderColor: `${color}55`, backgroundColor: `${color}15` }}>{commit.parents.length > 1 ? <GitMerge size={23} /> : <GitCommitHorizontal size={23} />}</span><span className="min-w-0 flex-1"><span className="flex min-w-0 items-center gap-2"><span className="line-clamp-2 font-body-md text-body-md font-semibold leading-snug text-on-surface">{group.length > 1 ? `${group.length} commits` : commit.message || "(no message)"}</span>{commit.parents.length > 1 && <span className="shrink-0 rounded-md bg-amber-400/15 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-amber-300">Merge</span>}</span>{group.length > 1 && <span className="mt-2 block line-clamp-2 text-xs leading-5 text-secondary">{group.map((item) => item.message || "(no message)").join(" / ")}</span>}<span className="mt-3 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-label-sm text-label-sm text-secondary"><span className="max-w-36 truncate font-medium text-on-surface">{commit.author}</span><span>/</span><span className="font-mono">{shortHash(commit.hash)}</span><span className="truncate">{formatDate(commit.date)}</span><span className="flex items-center gap-1"><FolderGit2 size={11} />{commit.files.length} changed</span><span className="flex items-center gap-1.5 rounded-md border border-outline-variant/60 bg-surface-container-low px-2 py-1 font-semibold"><span className="text-emerald-400">+{groupTotals.insertions}</span><span className="text-rose-400">−{groupTotals.deletions}</span><span className="text-secondary">lines</span></span></span>{labels.length > 0 && <span className="mt-2 flex min-w-0 gap-1.5 overflow-hidden">{labels.map((label) => <span key={label} className="max-w-36 truncate rounded-md px-2 py-1 text-[10px] font-semibold" style={{ color, backgroundColor: `${color}20` }}><GitBranch size={10} className="mr-1 inline" />{label}</span>)}</span>}</span>{group.length > 1 && <ChevronDown size={18} className={cn("shrink-0 text-secondary transition-transform", expanded && "rotate-180")} />}</>;
                  return <div key={first.hash} className="absolute" style={{ left: point.x - graph.cardWidth / 2, top: point.y - 80, width: graph.cardWidth }}>
                    {group.length > 1 ? <button type="button" aria-label={`${expanded ? "Collapse" : "Expand"} ${group.length} commits`} onClick={() => setExpandedGroups((current) => { const next = new Set(current); if (next.has(first.hash)) next.delete(first.hash); else next.add(first.hash); return next; })} className={cn(cardClass, "min-h-[160px]")} style={cardStyle}><span aria-hidden="true" className="absolute inset-y-0 left-0 w-1.5" style={{ background: `linear-gradient(180deg, ${color}, ${color}66)` }} />{cardContents}</button> : <button type="button" aria-label={`Select commit ${commit.message}`} onClick={() => setSelectedHash(commit.hash)} className={cn(cardClass, "min-h-[160px]")} style={cardStyle}><span aria-hidden="true" className="absolute inset-y-0 left-0 w-1.5" style={{ background: `linear-gradient(180deg, ${color}, ${color}66)` }} />{cardContents}</button>}
                    {expanded && <div className="mt-1 space-y-1 rounded-xl border border-outline-variant/70 bg-surface-container-low p-1.5">{group.map((item) => <button key={item.hash} type="button" onClick={() => setSelectedHash(item.hash)} className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-surface-container", item.hash === selectedCommit?.hash && "bg-surface-container")}><GitCommitHorizontal size={13} className="shrink-0" style={{ color }} /><span className="min-w-0 flex-1 truncate text-xs text-on-surface">{item.message || "(no message)"}</span><span className="font-mono text-[10px] text-secondary">{shortHash(item.hash)}</span></button>)}</div>}

                  </div>;
                })}
                {graph.visibleBranches.map((branch) => {
                  const point = graph.branchPositions.get(branch.key);
                  if (!point) return null;
                  const color = laneColors[point.lane % laneColors.length];
                  const expanded = openBranches.has(branch.key);
                  return <div key={branch.key} className="absolute z-[1]" style={{ left: point.x - graph.branchCardWidth / 2, top: point.y - 84, width: graph.branchCardWidth }}>
                    <button type="button" aria-expanded={expanded} aria-label={`${expanded ? "Collapse" : "Expand"} ${branch.name} branch history`} onClick={() => toggleBranch(branch.key)} className="relative flex min-h-[132px] w-full flex-col justify-center rounded-2xl border bg-surface-container-lowest px-3.5 py-3 pb-10 pr-16 text-left shadow-lg transition hover:-translate-y-0.5 hover:bg-surface-container-low focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60" style={{ borderColor: `${color}90`, boxShadow: `0 4px 14px #0003, inset 3px 0 ${color}` }}>
                      <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider" style={{ color }}><GitBranch size={12} />{branch.mergeHash ? "Merged branch" : "Branch history"}<ChevronDown size={13} className={cn("ml-auto transition-transform", expanded && "rotate-180")} /></span>
                      <span className="mt-1 truncate text-sm font-semibold text-on-surface">{branch.name}</span>
                      <span className="mt-1 text-[11px] text-secondary">{branch.hashes.length} {branch.hashes.length === 1 ? "commit" : "commits"} &#183; tip {shortHash(branch.tipHash)}</span>
                      <span className="mt-2 flex items-center gap-2 font-mono text-[11px] font-semibold"><span className="text-emerald-500">+{branch.insertions}</span><span className="text-rose-500">&#8722;{branch.deletions}</span><span className="font-sans font-normal text-secondary">lines</span></span>
                      <span className="mt-2 text-[10px] font-medium text-primary">{expanded ? "Hide branch history" : "Open branch history"}</span>
                    </button>
                    {branch.forkHash && <button type="button" aria-label={`Go to fork ${shortHash(branch.forkHash)}`} onClick={() => focusCommit(branch.forkHash!)} className="absolute bottom-2 left-2 rounded-md border border-outline-variant/70 bg-surface-container-low px-2 py-1 font-mono text-[9px] font-semibold text-secondary transition hover:text-on-surface">Fork {shortHash(branch.forkHash)}</button>}
                    {branch.mergeHash && <button type="button" aria-label={`Go to merge ${shortHash(branch.mergeHash)}`} onClick={() => focusCommit(branch.mergeHash!)} className="absolute bottom-2 right-2 rounded-md border border-amber-400/25 bg-amber-400/10 px-2 py-1 font-mono text-[9px] font-semibold text-amber-300 transition hover:bg-amber-400/20">Merge {shortHash(branch.mergeHash)}</button>}
                  </div>;
                })}
              </div>
              </div>
            </div>}
          </div>
        </main>

        <aside className="hidden w-[250px] shrink-0 flex-col border-l border-outline-variant/80 bg-surface-container-lowest md:flex 2xl:w-[290px]">
          <div className="px-4 py-4"><span className="font-label-sm text-label-sm font-semibold uppercase tracking-wider text-secondary">Commit details</span></div>
          {selectedCommit ? <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <h3 className="break-words font-headline-sm text-headline-sm font-semibold leading-snug text-on-surface">{selectedCommit.message || "(no message)"}</h3>
            <div className="mt-4 space-y-3">
              <DetailRow icon={<GitCommitHorizontal size={15} />}><code className="rounded bg-surface-container px-2 py-1 font-mono text-xs text-on-surface">{shortHash(selectedCommit.hash)}</code></DetailRow>
              <DetailRow icon={<span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary">{selectedCommit.author.slice(0, 1).toUpperCase()}</span>}><span className="truncate text-on-surface">{selectedCommit.author}</span></DetailRow>
              <DetailRow icon={<Clock3 size={14} />}>{formatDate(selectedCommit.date)}</DetailRow>
            </div>
            <div className="mt-5 pt-2"><div className="mb-2 flex items-center justify-between"><span className="font-label-sm text-label-sm font-semibold uppercase tracking-wider text-secondary">Changed files</span><span className="rounded-full bg-surface-container px-2 py-0.5 font-label-sm text-label-sm text-secondary">{selectedFileChanges.length}</span></div>{selectedFileChanges.length ? <div className="space-y-1">{selectedFileChanges.map((file) => { const statusColor = file.status === "added" ? "text-emerald-400" : file.status === "deleted" ? "text-rose-400" : "text-secondary"; return <div key={file.path} className="rounded-lg bg-surface-container-low px-2.5 py-2"><div className="flex items-start justify-between gap-2"><span className="break-all font-label-sm text-label-sm text-on-surface">{file.path}</span><span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase", statusColor, file.status === "added" ? "bg-emerald-500/10" : file.status === "deleted" ? "bg-rose-500/10" : "bg-surface-container")}>{file.status}</span></div><div className="mt-1 flex gap-2 font-mono text-[10px] font-semibold">{file.binary ? <span className="text-secondary">Binary file (line counts unavailable)</span> : <><span className="text-emerald-400">+{file.insertions}</span><span className="text-rose-400">âˆ’{file.deletions}</span></>}</div></div>; })}</div> : <p className="font-body-sm text-body-sm text-secondary">No file list available.</p>}</div>
            <div className="mt-5 pt-2"><span className="mb-2 block font-label-sm text-label-sm font-semibold uppercase tracking-wider text-secondary">Branches and refs</span>{selectedCommit.refs.length ? <div className="flex flex-wrap gap-1.5">{selectedCommit.refs.map((ref, index) => { const label = ref.startsWith("HEAD -> ") ? ref.slice(8) : ref; const color = laneColors[index % laneColors.length]; return <span key={ref} className="rounded-full px-2 py-1 font-label-sm text-label-sm" style={{ color, backgroundColor: `${color}20` }}><GitBranch size={11} className="mr-1 inline" />{label}</span>; })}</div> : <p className="font-body-sm text-body-sm text-secondary">No branch label is attached to this commit.</p>}<p className="mt-3 flex items-center gap-2 rounded-lg bg-surface-container-low px-2.5 py-2 font-label-sm text-label-sm text-secondary"><GitBranch size={13} />Current checkout: <span className="font-semibold text-on-surface">{currentBranch || "detached HEAD"}</span></p></div>
          </div> : <div className="flex flex-1 items-center justify-center p-5 text-center font-body-sm text-body-sm text-secondary">Select a commit in the graph to see its details.</div>}
        </aside>
      </div>

      {identityModalOpen && <IdentityDialog onClose={() => setIdentityModalOpen(false)} onInitialize={(name, email) => { if (workspace) void runGitAction("Initialize", () => window.api.git.initialize(workspace.path, name, email), "Git is ready in this project.").then((ok) => { if (ok) setIdentityModalOpen(false); }); }} action={action} error={error} />}
      {createOpen && <CreateRepositoryDialog name={newRepoName} description={newRepoDescription} isPrivate={newRepoPrivate} loading={reposLoading} error={error} onName={setNewRepoName} onDescription={setNewRepoDescription} onPrivate={setNewRepoPrivate} onClose={() => setCreateOpen(false)} onCreate={() => void createRepository()} />}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): React.JSX.Element {
  return <button type="button" onClick={onClick} className={cn("relative rounded-lg px-2 py-2 font-label-md text-label-md transition", active ? "-translate-y-px bg-surface-container-lowest font-semibold text-on-surface shadow-sm" : "text-secondary hover:text-on-surface")}>{children}</button>;
}

function RepoFilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): React.JSX.Element {
  return <button type="button" aria-pressed={active} onClick={onClick} className={cn("shrink-0 rounded-full px-2.5 py-1.5 text-[10px] font-semibold transition", active ? "bg-surface-container-high text-on-surface shadow-sm" : "bg-surface-container-low text-secondary hover:text-on-surface")}>{children}</button>;
}

function EmptyGraph({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex h-full w-full min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-outline-variant bg-surface-container-lowest px-5 py-8 text-center text-secondary">
    <div className="flex shrink-0 flex-col items-center gap-2" style={{ width: 280 }}>
      {Children.map(children, (child) => {
        if (isValidElement<{ children?: React.ReactNode }>(child) && child.type === "span") {
          return <span className="block w-full whitespace-normal break-words font-body-sm text-body-sm text-secondary">{child.props.children}</span>;
        }
        if (isValidElement<{ children?: React.ReactNode }>(child) && child.type === "strong") {
          return <strong className="block w-full whitespace-normal break-words font-headline-sm text-headline-sm text-on-surface">{child.props.children}</strong>;
        }
        if (isValidElement(child) && child.type === "button") {
          return <div className="mt-2 flex w-full justify-center">{child}</div>;
        }
        return child;
      })}
    </div>
  </div>;
}

function DetailRow({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return <div className="flex min-w-0 items-center gap-2.5 font-body-sm text-body-sm text-secondary">{icon}<span className="min-w-0">{children}</span></div>;
}


function GitControls(props: {
  workspace: { path: string; name: string } | null;
  projects: RecentProject[];
  status: GitStatus | null;
  branches: string[];
  currentBranch: string;
  commitMessage: string;
  newBranchName: string;
  branchMenuOpen: boolean;
  action: string;
  onOpenProject: () => void;
  onSwitchProject: (path: string) => void;
  onInitialize: () => void;
  onBranchMenuOpenChange: (open: boolean) => void;
  onCommitMessage: (value: string) => void;
  onNewBranchName: (value: string) => void;
  onSwitchBranch: (name: string) => void;
  onCreateBranch: () => void;
  onCommit: () => void;
  onPush: () => void;
  onConnectRepo: () => void;
}): React.JSX.Element {
  const remoteConnected = Boolean(props.status?.remote);
  return <div className="min-h-0 flex-1 overflow-y-auto p-4">
    <div className="mb-4"><div className="mb-2 flex items-center justify-between"><span className="font-label-sm text-label-sm font-semibold uppercase tracking-wider text-secondary">Local project</span><button type="button" onClick={props.onOpenProject} className="font-label-sm text-label-sm text-primary hover:underline">Open project</button></div>{props.workspace ? <select value={props.workspace.path} onChange={(event) => props.onSwitchProject(event.target.value)} className="w-full truncate rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2.5 font-body-sm text-body-sm font-medium text-on-surface">{props.projects.some((item) => item.path === props.workspace?.path) ? null : <option value={props.workspace.path}>{props.workspace.name}</option>}{props.projects.map((project) => <option key={project.path} value={project.path}>{project.name}</option>)}</select> : <button type="button" onClick={props.onOpenProject} className="flex w-full items-center justify-center gap-2 rounded-lg border border-outline-variant px-3 py-2.5 font-body-sm text-body-sm text-on-surface hover:bg-surface-container-low"><FolderGit2 size={14} />Choose project folder</button>}</div>
    {!props.workspace ? <p className="rounded-xl bg-surface-container-low p-3 font-body-sm text-body-sm text-secondary">Open a local project to manage its Git history.</p> : <>
      <div className="mb-4 rounded-xl border border-outline-variant bg-surface-container-low p-3"><div className="flex items-center gap-2">{props.status?.initialized ? <CircleDot size={15} className="text-emerald-600" /> : <AlertCircle size={15} className="text-amber-600" />}<span className="font-body-sm text-body-sm font-semibold text-on-surface">{props.status?.initialized ? "Git initialized" : "Git not initialized"}</span></div>{props.status?.initialized && <p className="mt-1 truncate font-label-sm text-label-sm text-secondary">{props.status.remote ? "Remote connected" : "No remote connected"}</p>}</div>
      {!props.status?.initialized ? <button type="button" onClick={props.onInitialize} className="mb-4 w-full rounded-lg bg-primary px-3 py-2.5 font-label-md text-label-md font-semibold text-on-primary">Initialize Git</button> : <>
        <div className="mb-4"><span className="mb-1.5 block font-label-sm text-label-sm font-semibold uppercase tracking-wider text-secondary">Branch</span><div className="relative"><button type="button" onClick={() => props.onBranchMenuOpenChange(!props.branchMenuOpen)} className="flex w-full items-center justify-between rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2.5 font-body-sm text-body-sm text-on-surface"><span className="flex min-w-0 items-center gap-2"><GitBranch size={14} className="text-secondary" /><span className="truncate">{props.currentBranch || "Select branch"}</span></span><ChevronDown size={14} className="text-secondary" /></button>{props.branchMenuOpen && <div className="absolute z-20 mt-1 max-h-48 w-full overflow-auto rounded-lg border border-outline-variant bg-surface-container-lowest p-1 shadow-xl">{props.branches.map((branch) => <button key={branch} type="button" onClick={() => props.onSwitchBranch(branch)} className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left font-body-sm text-body-sm text-on-surface hover:bg-surface-container-low">{branch === props.currentBranch ? <Check size={13} /> : <span className="w-[13px]" />}{branch}</button>)}</div>}</div><div className="mt-2 flex gap-1.5"><input value={props.newBranchName} onChange={(event) => props.onNewBranchName(event.target.value)} placeholder="New branch name" className="min-w-0 flex-1 rounded-lg border border-outline-variant bg-surface-container-lowest px-2.5 py-2 font-body-sm text-body-sm text-on-surface" /><button type="button" onClick={props.onCreateBranch} disabled={!props.newBranchName.trim() || !!props.action} className="rounded-lg border border-outline-variant px-2.5 text-secondary hover:bg-surface-container-low disabled:opacity-50"><Plus size={15} /></button></div></div>
        <div className="mb-4"><div className="mb-1.5 flex items-center justify-between"><span className="font-label-sm text-label-sm font-semibold uppercase tracking-wider text-secondary">Working changes</span><span className="rounded-full bg-surface-container px-2 py-0.5 font-label-sm text-label-sm text-secondary">{props.status?.changes.length ?? 0}</span></div>{props.status?.changes.length ? <div className="max-h-40 overflow-y-auto rounded-lg border border-outline-variant bg-surface-container-lowest p-1">{props.status.changes.map((change) => <div key={`${change.status}-${change.path}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 font-label-sm text-label-sm text-on-surface"><span className={cn("w-4 text-center font-bold", change.status.includes("?") || change.status.includes("A") ? "text-emerald-600" : change.status.includes("D") ? "text-red-500" : "text-amber-600")}>{change.status}</span><span className="truncate">{change.path}</span></div>)}</div> : <p className="rounded-lg bg-surface-container-low px-3 py-2 font-body-sm text-body-sm text-secondary">Working tree is clean.</p>}</div>
        <div className="mb-3 rounded-xl border border-outline-variant bg-surface-container-low p-2"><textarea value={props.commitMessage} onChange={(event) => props.onCommitMessage(event.target.value)} placeholder="Describe your changes" rows={2} className="w-full resize-none bg-transparent p-1 font-body-sm text-body-sm text-on-surface placeholder:text-secondary focus:outline-none" /><button type="button" disabled={!props.commitMessage.trim() || !!props.action} onClick={props.onCommit} className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 font-label-md text-label-md font-semibold text-on-primary disabled:opacity-50"><GitCommitHorizontal size={15} />{props.action === "Commit" ? "Committingâ€¦" : "Commit all changes"}</button></div>
        <div className="mb-2 rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2 font-label-sm text-label-sm text-secondary">{remoteConnected ? <><span className="text-emerald-600">Connected</span><span className="mx-1.5">Â·</span><span className="truncate">{props.status?.remote}</span></> : <>No GitHub repository connected. <button type="button" onClick={props.onConnectRepo} className="text-primary underline">Choose one</button></>}</div>
        <button type="button" disabled={!remoteConnected || !!props.action} onClick={props.onPush} className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3 py-2.5 font-label-md text-label-md font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-45"><ArrowUp size={15} />{props.action === "Push" ? "Pushingâ€¦" : "Push to GitHub"}</button>
      </>}
    </>}
  </div>;
}

function IdentityDialog({ onClose, onInitialize, action, error }: { onClose: () => void; onInitialize: (name: string, email: string) => void; action: string; error: string }): React.JSX.Element {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const inputClass = "mt-1.5 block w-full rounded-xl border border-outline-variant/70 bg-surface-container-low px-3.5 py-3 font-body-md text-body-md text-on-surface outline-none transition focus:border-primary/70 focus:ring-2 focus:ring-primary/15";
  return <Dialog title="Initialize Git" onClose={onClose}>
    <div className="mb-5 flex gap-3 rounded-xl bg-surface-container-low p-3.5"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary"><GitBranch size={18} /></span><span><span className="block font-body-sm text-body-sm font-semibold text-on-surface">Set up this project for version control</span><span className="mt-0.5 block font-label-sm text-label-sm text-secondary">Your author details are saved to this repository only.</span></span></div>
    <label className="mb-4 block font-label-md text-label-md font-medium text-on-surface">Author name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" autoComplete="name" className={inputClass} /></label>
    <label className="block font-label-md text-label-md font-medium text-on-surface">Author email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" autoComplete="email" className={inputClass} /></label>
    {email && !validEmail && <p className="mt-1.5 text-xs text-amber-400">Enter a valid email address to continue.</p>}
    {error && <DialogError message={error} />}
    <div className="mt-6 flex justify-end gap-2"><button type="button" onClick={onClose} className="rounded-lg px-3.5 py-2.5 font-label-md text-label-md text-secondary transition hover:bg-surface-container-low hover:text-on-surface">Cancel</button><button type="button" disabled={!name.trim() || !validEmail || !!action} onClick={() => onInitialize(name, email)} className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 font-label-md text-label-md font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-45">{action === "Initialize" && <LoaderCircle size={14} className="animate-spin" />}{action === "Initialize" ? "Initializingâ€¦" : "Initialize Git"}</button></div>
  </Dialog>;
}

function CreateRepositoryDialog({ name, description, isPrivate, loading, error, onName, onDescription, onPrivate, onClose, onCreate }: { name: string; description: string; isPrivate: boolean; loading: boolean; error: string; onName: (value: string) => void; onDescription: (value: string) => void; onPrivate: (value: boolean) => void; onClose: () => void; onCreate: () => void }): React.JSX.Element {
  const validName = /^[A-Za-z0-9._-]{1,100}$/.test(name.trim()) && name.trim() !== "." && name.trim() !== "..";
  const inputClass = "mt-1.5 block w-full rounded-xl border border-outline-variant/70 bg-surface-container-low px-3.5 py-3 font-body-md text-body-md text-on-surface outline-none transition focus:border-primary/70 focus:ring-2 focus:ring-primary/15";
  return <Dialog title="Create GitHub repository" onClose={onClose}>
    <div className="mb-5 flex gap-3 rounded-xl bg-surface-container-low p-3.5"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400"><GitFork size={18} /></span><span><span className="block font-body-sm text-body-sm font-semibold text-on-surface">A new home for your project</span><span className="mt-0.5 block font-label-sm text-label-sm text-secondary">Create it on GitHub, then connect your local project and push.</span></span></div>
    <label className="mb-4 block font-label-md text-label-md font-medium text-on-surface">Repository name<input autoFocus value={name} onChange={(event) => onName(event.target.value)} placeholder="my-project" className={inputClass} /><span className="mt-1 block text-[11px] text-secondary">Use letters, numbers, hyphens, periods, or underscores.</span></label>
    <label className="mb-4 block font-label-md text-label-md font-medium text-on-surface">Description <span className="font-normal text-secondary">(optional)</span><input value={description} onChange={(event) => onDescription(event.target.value)} placeholder="What is this project about?" className={inputClass} /></label>
    <fieldset><legend className="mb-2 font-label-md text-label-md font-medium text-on-surface">Visibility</legend><div className="grid grid-cols-2 gap-2"><label className={cn("flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 transition", isPrivate ? "border-primary/60 bg-primary/10" : "border-outline-variant/60 bg-surface-container-low")}><input type="radio" name="repo-visibility" checked={isPrivate} onChange={() => onPrivate(true)} className="mt-1 accent-primary" /><span><span className="flex items-center gap-1.5 font-label-md text-label-md font-semibold text-on-surface"><LockKeyhole size={13} />Private</span><span className="mt-1 block text-[11px] leading-4 text-secondary">Only you and invited collaborators.</span></span></label><label className={cn("flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 transition", !isPrivate ? "border-primary/60 bg-primary/10" : "border-outline-variant/60 bg-surface-container-low")}><input type="radio" name="repo-visibility" checked={!isPrivate} onChange={() => onPrivate(false)} className="mt-1 accent-primary" /><span><span className="flex items-center gap-1.5 font-label-md text-label-md font-semibold text-on-surface"><GitFork size={13} />Public</span><span className="mt-1 block text-[11px] leading-4 text-secondary">Visible to everyone on GitHub.</span></span></label></div></fieldset>
    {error && <DialogError message={error} />}
    <div className="mt-6 flex justify-end gap-2"><button type="button" onClick={onClose} className="rounded-lg px-3.5 py-2.5 font-label-md text-label-md text-secondary transition hover:bg-surface-container-low hover:text-on-surface">Cancel</button><button type="button" disabled={!validName || loading} onClick={onCreate} className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 font-label-md text-label-md font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-45">{loading ? <LoaderCircle size={14} className="animate-spin" /> : <Plus size={15} />}{loading ? "Creatingâ€¦" : "Create repository"}</button></div>
  </Dialog>;
}

function DialogError({ message }: { message: string }): React.JSX.Element {
  return <p role="alert" className="mt-4 flex items-start gap-2 rounded-xl bg-error-container/70 p-3 text-sm text-on-error-container"><AlertCircle size={15} className="mt-0.5 shrink-0" />{message}</p>;
}

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }): React.JSX.Element {
  return <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div role="dialog" aria-modal="true" aria-label={title} className="w-[min(92vw,32rem)] max-w-[calc(100vw-2rem)] rounded-3xl border border-outline-variant/70 bg-surface-container-lowest p-6 shadow-[0_24px_80px_rgba(0,0,0,0.55)]"><div className="mb-5 flex items-center justify-between"><div className="flex min-w-0 items-center gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary"><GitBranch size={19} /></span><h2 className="truncate font-headline-sm text-headline-sm font-semibold text-on-surface">{title}</h2></div><button type="button" onClick={onClose} aria-label="Close dialog" className="ml-2 shrink-0 rounded-lg p-2 text-secondary transition hover:bg-surface-container-low hover:text-on-surface"><X size={17} /></button></div>{children}</div></div>;
}
