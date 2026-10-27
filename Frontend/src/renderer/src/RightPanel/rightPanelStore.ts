import { create } from "zustand";

export type RightPanelView = "agent" | "browser" | "browser-agent";

const WIDTH_KEY = "xvie-right-panel-width";
const MIN_WIDTH = 340;
const MAX_WIDTH = 760;

function initialWidth(): number {
  if (typeof localStorage === "undefined") return 480;
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(stored) && stored >= MIN_WIDTH && stored <= MAX_WIDTH ? stored : 480;
  } catch {
    return 480;
  }
}

interface RightPanelState {
  open: boolean;
  view: RightPanelView;
  width: number;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setView: (view: RightPanelView) => void;
  setWidth: (width: number) => void;
}

export const useRightPanelStore = create<RightPanelState>((set) => ({
  open: false,
  view: "agent",
  width: initialWidth(),
  setOpen: (open) => set({ open }),
  toggle: () => set((state) => ({ open: !state.open })),
  setView: (view) => set({ view, open: true }),
  setWidth: (width) => {
    const nextWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(width)));
    try { localStorage.setItem(WIDTH_KEY, String(nextWidth)); } catch { /* storage is optional */ }
    set({ width: nextWidth });
  }
}));
