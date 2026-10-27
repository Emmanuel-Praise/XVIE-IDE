import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ChevronDown, Loader2, Search, X } from "lucide-react";
import {
  CATEGORIES,
  sortBy,
  type SortKey
} from "@/Workspace/Marketplace/marketplaceData";
import ProjectCard from "@/Workspace/Marketplace/ProjectCard";
import ReadmeModal from "@/Workspace/Marketplace/ReadmeModal";
import { prefetchPreviews } from "@/Workspace/Marketplace/repoPreview";
import { useMarketplaceStore } from "@/Workspace/Marketplace/marketplaceStore";
import { useWorkspaceStore } from "@/Workspace/workspaceStore";

const ALL_CATEGORIES = "All Categories";

const sortOptions: Array<{ value: SortKey; label: string }> = [
  { value: "popular", label: "Most Stars" },
  { value: "recent", label: "Recently Updated" },
  { value: "forks", label: "Most Forks" }
];

export default function MarketplacePage(): React.JSX.Element {
  const [category, setCategory] = useState<string>(ALL_CATEGORIES);
  const [language, setLanguage] = useState("All languages");
  const [sort, setSort] = useState<SortKey>("popular");
  const [searchInput, setSearchInput] = useState("");
  const [bookmarked, setBookmarked] = useState<Set<string>>(new Set());

  const projects = useMarketplaceStore((state) => state.projects);
  const loading = useMarketplaceStore((state) => state.loading);
  const loadingMore = useMarketplaceStore((state) => state.loadingMore);
  const error = useMarketplaceStore((state) => state.error);
  const query = useMarketplaceStore((state) => state.query);
  const totalCount = useMarketplaceStore((state) => state.totalCount);
  const loadedCount = useMarketplaceStore((state) => state.loadedCount);
  const clones = useMarketplaceStore((state) => state.clones);
  const readme = useMarketplaceStore((state) => state.readme);
  const search = useMarketplaceStore((state) => state.search);
  const loadMore = useMarketplaceStore((state) => state.loadMore);
  const cloneRepo = useMarketplaceStore((state) => state.cloneRepo);
  const viewReadme = useMarketplaceStore((state) => state.viewReadme);
  const closeReadme = useMarketplaceStore((state) => state.closeReadme);
  const clearError = useMarketplaceStore((state) => state.clearError);
  const openRecentProject = useWorkspaceStore((state) => state.openRecentProject);

  useEffect(() => {
    void search("");
  }, [search]);

  const filtered = useMemo(() => {
    const scoped =
      category === ALL_CATEGORIES
        ? projects
        : projects.filter((project) => project.category === category);
    const languageFiltered = language === "All languages" ? scoped : scoped.filter((project) => project.rawRepo?.language === language);
    return [...languageFiltered].sort(sortBy[sort]);
  }, [projects, category, language, sort]);

  const languages = useMemo(() => [...new Set(projects.map((project) => project.rawRepo?.language).filter((value): value is string => Boolean(value)))].sort(), [projects]);

  // Warm the preview cache for above-the-fold cards during idle time.
  useEffect(() => {
    const raws = projects.slice(0, 8).map((p) => p.rawRepo).filter((r): r is NonNullable<typeof r> => Boolean(r));
    if (!raws.length) return;
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    if (typeof idle === "function") {
      const id = idle(() => prefetchPreviews(raws));
      return () => (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback?.(id);
    }
    const timer = window.setTimeout(() => prefetchPreviews(raws), 400);
    return () => window.clearTimeout(timer);
  }, [projects]);

  function submitSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void search(searchInput);
  }

  function changeCategory(next: string): void {
    setCategory(next);
  }

  function changeSort(next: SortKey): void {
    setSort(next);
  }

  function toggleBookmark(id: string): void {
    setBookmarked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  const selectClasses =
    "cursor-pointer appearance-none rounded-lg border border-outline-variant/50 bg-surface-container-lowest py-1.5 pl-3 pr-8 font-label-md text-label-md text-primary transition-colors focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30";

  return (
    <div className="flex flex-1 flex-col gap-xl">
      <div>
        <h1 className="font-headline-lg text-headline-lg font-bold text-primary">Marketplace</h1>
        <p className="mt-xs max-w-2xl font-body-lg text-body-lg text-secondary">
          Discover and deploy open-source projects pulled live from GitHub.
        </p>
      </div>

      <form onSubmit={submitSearch} role="search" className="flex w-full max-w-3xl items-center gap-3">
        <div className="relative flex-1">
          <Search
            size={18}
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-secondary"
          />
          <input
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search GitHub repositories…"
            aria-label="Search GitHub repositories"
            className="h-11 w-full rounded-xl border border-outline-variant/50 bg-surface-container-lowest py-2 pl-11 pr-10 font-body-md text-body-md text-primary transition-colors placeholder:text-secondary/40 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => setSearchInput("")}
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 cursor-pointer rounded p-1 text-secondary transition-colors hover:text-primary"
            >
              <X size={16} />
            </button>
          )}
        </div>
        <button
          type="submit"
          className="h-11 cursor-pointer rounded-xl bg-primary px-6 font-label-md text-label-md text-on-primary shadow-[0_1px_3px_rgba(0,0,0,0.12)] transition-all duration-150 hover:shadow-[0_4px_12px_rgba(0,0,0,0.18)] hover:brightness-110 active:scale-[0.97]"
        >
          Search
        </button>
      </form>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <select
              value={category}
              onChange={(event) => changeCategory(event.target.value)}
              aria-label="Filter by category"
              className={selectClasses}
            >
              <option value={ALL_CATEGORIES}>{ALL_CATEGORIES}</option>
              {CATEGORIES.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            <ChevronDown
              size={18}
              className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-secondary"
            />
          </div>
          <div className="relative">
            <select value={language} onChange={(event) => setLanguage(event.target.value)} aria-label="Filter by language" className={selectClasses}>
              <option>All languages</option>
              {languages.map((item) => <option key={item}>{item}</option>)}
            </select>
            <ChevronDown size={18} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-secondary" />
          </div>
          <div className="relative">
            <select
              value={sort}
              onChange={(event) => changeSort(event.target.value as SortKey)}
              aria-label="Sort projects"
              className={selectClasses}
            >
              {sortOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <ChevronDown
              size={18}
              className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-secondary"
            />
          </div>
        </div>
        {!loading && totalCount > 0 && (
          <span className="font-body-sm text-body-sm text-secondary">
            {loadedCount.toLocaleString()} of {totalCount.toLocaleString()} results
            {query ? ` for "${query}"` : ""}
          </span>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-xl border border-error/20 bg-error-container/30 px-md py-sm"
        >
          <p className="font-body-md text-body-md text-on-error-container">{error}</p>
          <button
            type="button"
            onClick={clearError}
            aria-label="Dismiss error"
            className="cursor-pointer rounded p-0.5 text-on-error-container/70 transition-colors hover:text-on-error-container"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-secondary">
          <Loader2 size={28} className="animate-spin text-primary" />
          <span className="font-body-md text-body-md">Loading repositories from GitHub…</span>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {filtered.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                bookmarked={bookmarked.has(project.id)}
                onToggleBookmark={toggleBookmark}
                onView={viewReadme}
                onClone={cloneRepo}
                onOpenCloned={(path, name) => void openRecentProject(path, name)}
                cloneState={project.cloneUrl ? clones[project.cloneUrl] : undefined}
              />
            ))}
          </div>

          {filtered.length === 0 && (
            <p className="rounded-xl border border-dashed border-outline-variant/40 bg-surface-container-low/30 px-md py-lg text-center font-body-md text-body-md text-secondary/50">
              {error ? "No live repositories are available right now." : "No repositories match this search or category."}
            </p>
          )}

          {!loadingMore && loadedCount < totalCount && filtered.length > 0 && (
            <div className="mt-lg flex justify-center">
              <button
                type="button"
                onClick={() => void loadMore()}
                className="cursor-pointer rounded-lg border border-outline-variant/50 bg-surface-container-lowest px-6 py-2 font-label-md text-label-md text-primary transition-all duration-150 hover:border-outline-variant hover:bg-surface-container-low hover:shadow-sm active:scale-[0.97]"
              >
                Load More Projects
              </button>
            </div>
          )}
          {loadingMore && (
            <div className="mt-lg flex justify-center text-secondary">
              <Loader2 size={20} className="animate-spin text-primary" />
            </div>
          )}
        </>
      )}

      {readme.repo && (
        <ReadmeModal
          repo={readme.repo}
          html={readme.html}
          error={readme.error}
          loading={readme.loading}
          onClose={closeReadme}
        />
      )}
    </div>
  );
}
