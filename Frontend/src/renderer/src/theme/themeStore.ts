import { create } from "zustand";

export type ThemeMode = "light" | "dark";

interface ThemeState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
}

const STORAGE_KEY = "xvie-theme";

function applyMode(mode: ThemeMode): void {
  document.documentElement.classList.toggle("dark", mode === "dark");
  // Keep the native window chrome (title bar, taskbar icon) in sync so it
  // never sticks in light mode while the app is dark (or vice versa).
  try {
    void window.api?.app?.setTheme(mode)?.catch(() => undefined);
  } catch {
    // Preload bridge unavailable (e.g. browser tests) — web UI still themes.
  }
}

const savedMode = window.localStorage.getItem(STORAGE_KEY);
const initialMode: ThemeMode = savedMode === "dark" ? "dark" : "light";

applyMode(initialMode);

export const useThemeStore = create<ThemeState>((set) => ({
  mode: initialMode,
  setMode: (mode) => {
    applyMode(mode);
    window.localStorage.setItem(STORAGE_KEY, mode);
    set({ mode });
  },
  toggle: () => {
    set((state) => {
      const mode = state.mode === "dark" ? "light" : "dark";
      applyMode(mode);
      window.localStorage.setItem(STORAGE_KEY, mode);
      return { mode };
    });
  }
}));
