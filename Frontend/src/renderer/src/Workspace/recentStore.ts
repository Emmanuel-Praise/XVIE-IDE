import { create } from "zustand";

const RECENT_PROJECTS_KEY = "xvie-recent-projects";
const RECENT_FILES_KEY = "xvie-recent-files";
const STARRED_KEY = "xvie-starred-projects";

const MAX_RECENT_PROJECTS = 20;
const MAX_RECENT_FILES = 30;

export interface RecentProject {
  path: string;
  name: string;
  lastOpened: number;
}

export interface RecentFile {
  path: string;
  name: string;
  workspacePath: string;
  lastOpened: number;
}

function loadJSON<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable — best-effort
  }
}

interface RecentState {
  recentProjects: RecentProject[];
  recentFiles: RecentFile[];
  starredProjects: RecentProject[];
  addRecentProject: (project: { path: string; name: string }) => void;
  addRecentFile: (file: { path: string; name: string; workspacePath: string }) => void;
  toggleStarred: (project: { path: string; name: string }) => void;
  isStarred: (path: string) => boolean;
  removeRecentProject: (path: string) => void;
}

export const useRecentStore = create<RecentState>((set, get) => ({
  recentProjects: loadJSON<RecentProject[]>(RECENT_PROJECTS_KEY) ?? [],
  recentFiles: loadJSON<RecentFile[]>(RECENT_FILES_KEY) ?? [],
  starredProjects: loadJSON<RecentProject[]>(STARRED_KEY) ?? [],

  addRecentProject: (project) => {
    set((state) => {
      const now = Date.now();
      const filtered = state.recentProjects.filter((p) => p.path !== project.path);
      const updated = [{ path: project.path, name: project.name, lastOpened: now }, ...filtered].slice(
        0,
        MAX_RECENT_PROJECTS
      );
      saveJSON(RECENT_PROJECTS_KEY, updated);
      return { recentProjects: updated };
    });
  },

  addRecentFile: (file) => {
    set((state) => {
      const now = Date.now();
      const filtered = state.recentFiles.filter((f) => f.path !== file.path);
      const updated = [
        { path: file.path, name: file.name, workspacePath: file.workspacePath, lastOpened: now },
        ...filtered
      ].slice(0, MAX_RECENT_FILES);
      saveJSON(RECENT_FILES_KEY, updated);
      return { recentFiles: updated };
    });
  },

  toggleStarred: (project) => {
    set((state) => {
      const exists = state.starredProjects.find((p) => p.path === project.path);
      const updated: RecentProject[] = exists
        ? state.starredProjects.filter((p) => p.path !== project.path)
        : [...state.starredProjects, { path: project.path, name: project.name, lastOpened: Date.now() }];
      saveJSON(STARRED_KEY, updated);
      return { starredProjects: updated } satisfies Partial<RecentState>;
    });
  },

  isStarred: (path) => {
    return get().starredProjects.some((p) => p.path === path);
  },

  removeRecentProject: (path) => {
    set((state) => {
      const updated = state.recentProjects.filter((p) => p.path !== path);
      saveJSON(RECENT_PROJECTS_KEY, updated);
      return { recentProjects: updated };
    });
  }
}));
