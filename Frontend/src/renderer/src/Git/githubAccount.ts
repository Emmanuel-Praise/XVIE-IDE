import { create } from "zustand";
import type { GitHubUser } from "../../../shared/ipc-types";

interface GithubAccountState {
  user: GitHubUser | null;
  configured: boolean;
  loading: boolean;
  connecting: boolean;
  error: string | null;
  deviceCode: string;
  deviceUrl: string;
  refresh: () => Promise<void>;
  connectToken: (token: string) => Promise<boolean>;
  startDevice: () => Promise<void>;
  cancelDevice: () => void;
  signOut: () => Promise<void>;
  clearError: () => void;
}

let pollTimer: number | null = null;

function stopPolling(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

export const useGithubAccount = create<GithubAccountState>((set, get) => ({
  user: null,
  configured: false,
  loading: false,
  connecting: false,
  error: null,
  deviceCode: "",
  deviceUrl: "",
  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const status = await window.api.github.authStatus();
      set({
        user: status.user,
        configured: status.configured ?? get().configured,
        loading: false
      });
      try {
        const config = await window.api.github.authConfig();
        set({ configured: config.configured });
      } catch {
        /* auth-config is optional on older preloads */
      }
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },
  connectToken: async (token) => {
    set({ connecting: true, error: null });
    try {
      const result = await window.api.github.connectToken(token);
      if (!result.success || !result.user) {
        set({ connecting: false, error: result.error ?? "Could not connect with this token." });
        return false;
      }
      stopPolling();
      set({ user: result.user, deviceCode: "", deviceUrl: "", connecting: false, error: null });
      return true;
    } catch (error) {
      set({ connecting: false, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  },
  startDevice: async () => {
    set({ connecting: true, error: null });
    const result = await window.api.github.startSignIn();
    if (!result.success || !result.userCode) {
      set({ connecting: false, error: result.error ?? "Could not start GitHub sign-in." });
      return;
    }
    set({ deviceCode: result.userCode, deviceUrl: result.verificationUri ?? "https://github.com/login/device", connecting: false });
    stopPolling();
    pollTimer = window.setInterval(() => {
      void window.api.github.pollSignIn().then((poll) => {
        if (poll.pending) return;
        stopPolling();
        if (poll.success && poll.user) {
          set({ user: poll.user, deviceCode: "", deviceUrl: "", error: null });
        } else {
          set({ error: poll.error ?? "GitHub sign-in failed." });
        }
      }).catch((error: unknown) => {
        stopPolling();
        set({ error: error instanceof Error ? error.message : String(error) });
      });
    }, 5000);
  },
  cancelDevice: () => {
    stopPolling();
    set({ deviceCode: "", deviceUrl: "" });
  },
  signOut: async () => {
    stopPolling();
    await window.api.github.signOut();
    set({ user: null, deviceCode: "", deviceUrl: "", error: null });
  },
  clearError: () => set({ error: null })
}));
