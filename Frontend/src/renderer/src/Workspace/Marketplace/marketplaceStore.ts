import { create } from "zustand";
import {
  mapGitHubRepo,
  type MarketplaceProject
} from "@/Workspace/Marketplace/marketplaceData";

const PAGE_SIZE = 30;

export interface CloneState {
  phase: "idle" | "starting" | "cloning" | "done" | "error";
  message?: string;
  destination?: string;
  error?: string;
}

export interface ReadmeState {
  repo: MarketplaceProject | null;
  html: string | null;
  error: string | null;
  loading: boolean;
}

interface MarketplaceState {
  projects: MarketplaceProject[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  query: string;
  totalCount: number;
  loadedCount: number;
  clones: Record<string, CloneState>;
  readme: ReadmeState;
  search: (query: string) => Promise<void>;
  loadMore: () => Promise<void>;
  cloneRepo: (repo: MarketplaceProject) => Promise<void>;
  viewReadme: (repo: MarketplaceProject) => Promise<void>;
  closeReadme: () => void;
  clearError: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let searchVersion = 0;

const useMarketplaceStore = create<MarketplaceState>((set, get) => ({
  projects: [],
  loading: false,
  loadingMore: false,
  error: null,
  query: "",
  totalCount: 0,
  loadedCount: 0,
  clones: {},
  readme: { repo: null, html: null, error: null, loading: false },

  search: async (query) => {
    const q = query.trim();
    const version = ++searchVersion;
    set({
      loading: true,
      loadingMore: false,
      error: null,
      query: q,
      projects: [],
      totalCount: 0,
      loadedCount: 0,
      clones: {}
    });
    try {
      const { items, totalCount } = await window.api.github.search(q, 1);
      if (version !== searchVersion) return;
      set({
        projects: items.map(mapGitHubRepo),
        totalCount,
        loadedCount: items.length,
        loading: false
      });
    } catch (error) {
      if (version !== searchVersion) return;
      set({
        projects: [],
        loading: false,
        error: `Couldn't reach GitHub (${errorMessage(error)}). Check your connection and try again.`
      });
    }
  },

  loadMore: async () => {
    const { loadingMore, loadedCount, totalCount, query } = get();
    if (loadingMore || loadedCount >= totalCount) return;
    const version = searchVersion;
    const nextPage = Math.floor(loadedCount / PAGE_SIZE) + 1;
    set({ loadingMore: true });
    try {
      const { items, totalCount: total } = await window.api.github.search(query, nextPage);
      if (version !== searchVersion) return;
      set((state) => ({
        projects: [...state.projects, ...items.map(mapGitHubRepo)],
        loadedCount: state.loadedCount + items.length,
        totalCount: total,
        loadingMore: false
      }));
    } catch (error) {
      if (version !== searchVersion) return;
      set({ loadingMore: false, error: `Couldn't load more results (${errorMessage(error)}).` });
    }
  },

  cloneRepo: async (repo) => {
    const url = repo.cloneUrl ?? (repo.repoUrl ? `${repo.repoUrl}.git` : undefined);
    if (!url) return;
    set((state) => ({ clones: { ...state.clones, [url]: { phase: "starting" } } }));
    try {
      const result = await window.api.github.clone(url);
      set((state) => {
        if (result.canceled) {
          return { clones: { ...state.clones, [url]: { phase: "idle" } } };
        }
        if (result.success) {
          return {
            clones: { ...state.clones, [url]: { phase: "done", destination: result.destination } }
          };
        }
        return { clones: { ...state.clones, [url]: { phase: "error", error: result.error } } };
      });
    } catch (error) {
      set((state) => ({
        clones: { ...state.clones, [url]: { phase: "error", error: errorMessage(error) } }
      }));
    }
  },

  viewReadme: async (repo) => {
    if (!repo.repoUrl) return;
    const [owner, ...rest] = repo.id.split("/");
    const name = rest.join("/");
    set({ readme: { repo, html: null, error: null, loading: true } });
    try {
      const { html, error } = await window.api.github.readme(owner, name);
      set({ readme: { repo, html, error, loading: false } });
    } catch (error) {
      set({
        readme: { repo, html: null, error: errorMessage(error), loading: false }
      });
    }
  },

  closeReadme: () => set({ readme: { repo: null, html: null, error: null, loading: false } }),
  clearError: () => set({ error: null })
}));

window.api.github.onCloneProgress((progress) => {
  useMarketplaceStore.setState((state) => {
    const current = state.clones[progress.repo];
    if (!current) return state;
    const phase: CloneState["phase"] =
      progress.phase === "done"
        ? "done"
        : progress.phase === "error"
          ? "error"
          : "cloning";
    return {
      clones: {
        ...state.clones,
        [progress.repo]: {
          ...current,
          phase,
          message: progress.message,
          destination: progress.destination
        }
      }
    };
  });
});

export { useMarketplaceStore };
