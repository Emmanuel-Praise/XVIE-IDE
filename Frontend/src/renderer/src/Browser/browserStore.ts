import { create } from "zustand";
import type {
  BrowserSiteId,
  BrowserSiteInfo,
  BrowserConversation,
  BrowserStatus,
  BrowserStreamEvent
} from "../../../shared/ipc-types";
import { BROWSER_SITES } from "./browserSites";

export interface BrowserChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  files?: string[];
  images?: string[];
  status: "done" | "streaming" | "error";
  needsLogin?: boolean;
  signinPrompt?: boolean;
  timestamp: number;
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Persistent greeting bubble shown when a fresh chat is entered. */
export function modelGreeting(id: BrowserSiteId): BrowserChatMessage {
  const label = BROWSER_SITES.find((site) => site.id === id)?.label ?? id;
  return {
    id: uid("greet"),
    role: "assistant",
    content: `Hi, I'm ${label}. Ask me anything — what would you like to work on?`,
    status: "done",
    timestamp: Date.now()
  };
}

const MIN_CHAT_WIDTH = 280;
const MAX_CHAT_WIDTH = 560;

function emptyThreads(): Record<BrowserSiteId, BrowserChatMessage[]> {
  return {
    chatgpt: [],
    claude: [],
    gemini: [],
    deepseek: [],
    grok: [],
    qwen: [],
    perplexity: []
  };
}

function emptyLogins(): Record<BrowserSiteId, boolean | null> {
  return {
    chatgpt: null,
    claude: null,
    gemini: null,
    deepseek: null,
    grok: null,
    qwen: null,
    perplexity: null
  };
}

const api = (): Window["api"]["browser"] | undefined =>
  typeof window !== "undefined" ? window.api?.browser : undefined;

interface BrowserState {
  sites: BrowserSiteInfo[];
  activeSiteId: BrowserSiteId | null;
  status: BrowserStatus | null;
  statusLoading: boolean;
  sidecarStarting: boolean;
  sidecarError: string | null;
  chromeBusy: boolean;
  chromeError: string | null;
  connectingSite: BrowserSiteId | null;
  loginState: Record<BrowserSiteId, boolean | null>;
  messages: Record<BrowserSiteId, BrowserChatMessage[]>;
  conversations: Record<BrowserSiteId, BrowserConversation[]>;
  activeConversationId: Record<BrowserSiteId, string | null>;
  draft: string;
  sending: boolean;
  chatWidth: number;
  setActiveSite: (id: BrowserSiteId | null) => void;
  setDraft: (draft: string) => void;
  resetSending: () => void;
  setChatWidth: (width: number) => void;
  loadSites: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  startSidecar: () => Promise<void>;
  ensureChrome: (visible?: boolean) => Promise<{ success: boolean; error?: string }>;
  restartChrome: (visible?: boolean) => Promise<{ success: boolean; error?: string }>;
  /** Select a site: opens its welcome in the dock (Chrome starts on send/Chat). */
  selectSite: (id: BrowserSiteId) => Promise<void>;
  /** Enter the chat for a model, seeding a persistent greeting if empty. */
  startChat: (id: BrowserSiteId) => Promise<void>;
  /** Show the dedicated browser window (log in there if a site asks). */
  showBrowserWindow: () => Promise<void>;
  refreshLogin: (id?: BrowserSiteId, create?: boolean) => Promise<void>;
  newChat: (id: BrowserSiteId) => Promise<void>;
  deleteConversation: (id: BrowserSiteId, conversationId: string) => Promise<void>;
  openConversation: (id: BrowserSiteId, conversationId: string) => Promise<void>;
  send: (text: string, filePaths: string[]) => Promise<void>;
}

export const useBrowserStore = create<BrowserState>((set, get) => {
  // Global SSE subscription — routes partial/done/error frames into the
  // matching in-flight assistant message.
  if (typeof window !== "undefined" && window.api?.browser) {
    window.api.browser.onStream((evt: BrowserStreamEvent) => {
      const state = get();
      if (!state.sending) return;
      const site = state.activeSiteId;
      if (!site) return;
      const pending = [...state.messages[site]]
        .reverse()
        .find((m) => m.role === "assistant" && m.status === "streaming");
      if (!pending || pending.id !== evt.streamId) return;
      if (evt.type === "partial") {
        set((s) => ({
          messages: {
            ...s.messages,
            [site]: s.messages[site].map((m) =>
              m.id === pending.id ? { ...m, content: evt.text } : m
            )
          }
        }));
      } else if (evt.type === "done") {
        set((s) => ({
          sending: false,
          messages: {
            ...s.messages,
            [site]: s.messages[site].map((m) =>
              m.id === pending.id
                ? { ...m, status: "done", content: evt.answer, images: evt.images }
                : m
            )
          }
        }));
      } else {
        set((s) => ({
          sending: false,
          messages: {
            ...s.messages,
            [site]: s.messages[site].map((m) =>
              m.id === pending.id
                ? {
                    ...m,
                    status: "error",
                    content: evt.error,
                    needsLogin: evt.needsLogin
                  }
                : m
            )
          }
        }));
        if (evt.needsLogin) {
          set((s) => ({ loginState: { ...s.loginState, [site]: false } }));
        }
      }
    });
  }

  return {
    sites: BROWSER_SITES,
    activeSiteId: null,
    status: null,
    statusLoading: false,
    sidecarStarting: false,
    sidecarError: null,
    chromeBusy: false,
    chromeError: null,
    connectingSite: null,
    loginState: emptyLogins(),
    messages: emptyThreads(),
    conversations: { chatgpt: [], claude: [], gemini: [], deepseek: [], grok: [], qwen: [], perplexity: [] },
    activeConversationId: { chatgpt: null, claude: null, gemini: null, deepseek: null, grok: null, qwen: null, perplexity: null },
    draft: "",
    sending: false,
    chatWidth: 360,

    setActiveSite: (id) => {
      // Allow switching sites even mid-send: the global sending flag
      // previously trapped the user on a stuck thread with no way out.
      set({ activeSiteId: id });
      if (id) {
        void get().refreshStatus();
        // Probe sign-in without opening a provider tab (Chrome starts on send).
        void get().refreshLogin(id);
        const bridge = api();
        if (bridge) {
          void bridge.conversations(id).then((items) => {
            set((state) => ({ conversations: { ...state.conversations, [id]: items } }));
            const active = get().activeConversationId[id];
            const selected = active ? items.find((item) => item.id === active) : items[0];
            if (selected && get().messages[id].length === 0) void get().openConversation(id, selected.id);
            else if (!selected && items.length === 0) {
              void bridge.history(id).then((messages) => {
                if (!messages.length) return;
                set((state) => ({ messages: { ...state.messages, [id]: messages.slice(-50).map((m) => ({
                  id: uid("hist"), role: m.role, content: m.content, status: "done" as const,
                  timestamp: m.timestamp ? Date.parse(m.timestamp) || Date.now() : Date.now()
                })) } }));
              }).catch(() => undefined);
            }
          }).catch(() => undefined);
        }
      }
    },

    setDraft: (draft) => set({ draft }),

    // Manual escape hatch: stuck sending (lost SSE, backend restart) left
    // the composer disabled with no way out. UI exposes this as Reset.
    resetSending: () => {
      const state = get();
      const site = state.activeSiteId;
      if (!site) { set({ sending: false }); return; }
      set((s) => ({
        sending: false,
        messages: {
          ...s.messages,
          [site]: s.messages[site].map((m) =>
            m.status === "streaming"
              ? { ...m, status: "error" as const, content: m.content || "Send state was reset. Retry your message." }
              : m
          )
        }
      }));
    },

    setChatWidth: (width) => {
      const clamped = Math.min(MAX_CHAT_WIDTH, Math.max(MIN_CHAT_WIDTH, Math.round(width)));
      if (clamped !== get().chatWidth) set({ chatWidth: clamped });
    },

    loadSites: async () => {
      const bridge = api();
      if (!bridge) return;
      try {
        const sites = await bridge.sites();
        if (sites && sites.length > 0) set({ sites });
      } catch {
        // fall back to hardcoded list
      }
    },

    refreshStatus: async () => {
      const bridge = api();
      if (!bridge) return;
      // Never starts the backend — pure probe. Use startSidecar() for that.
      set({ statusLoading: true });
      try {
        const status = await bridge.status();
        set({ status, statusLoading: false });
      } catch {
        set({ statusLoading: false });
      }
    },

    startSidecar: async () => {
      const bridge = api();
      if (!bridge || get().sidecarStarting) return;
      set({ sidecarStarting: true, sidecarError: null });
      try {
        const result = await bridge.startSidecar();
        if (!result.success) {
          set({ sidecarStarting: false, sidecarError: result.error ?? "Failed to start." });
          return;
        }
        const status = await bridge.status();
        set({ sidecarStarting: false, status });
        void get().refreshLogin();
      } catch (err) {
        set({
          sidecarStarting: false,
          sidecarError: err instanceof Error ? err.message : String(err)
        });
      }
    },

    ensureChrome: async (visible) => {
      const bridge = api();
      if (!bridge) return { success: false, error: "Browser bridge unavailable." };
      // Drop stale success immediately so views cannot say "Browser ready"
      // while a new connection attempt is failing.
      set({ chromeBusy: true, chromeError: null, status: null, statusLoading: true });
      try {
        const result = await bridge.ensureChrome(visible);
        if (!result.success) set({ chromeError: result.error ?? "Could not start the browser." });
        return result;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        set({ chromeError: error });
        return { success: false, error };
      } finally {
        set({ chromeBusy: false });
        void get().refreshStatus();
      }
    },

    restartChrome: async (visible = true) => {
      const bridge = api();
      if (!bridge) return { success: false, error: "Browser bridge unavailable." };
      set({ chromeBusy: true, chromeError: null, status: null, statusLoading: true });
      try {
        const result = await bridge.restartChrome(visible);
        if (!result.success) set({ chromeError: result.error ?? "Could not restart the managed browser." });
        return result;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        set({ chromeError: error });
        return { success: false, error };
      } finally {
        set({ chromeBusy: false });
        void get().refreshStatus();
      }
    },

    selectSite: async (id) => {
      if (get().sending) return;
      if (get().activeSiteId === id) {
        get().setActiveSite(null);
        return;
      }
      // Open the welcome immediately; the hidden browser starts on send/Chat.
      get().setActiveSite(id);
    },

    startChat: async (id) => {
      if (get().sending) return;
      if (get().messages[id]?.length) return;
      set((state) => ({
        messages: { ...state.messages, [id]: [modelGreeting(id)] }
      }));
      try {
        await get().ensureChrome(false);
      } catch {
        // The chat still opens; errors surface on first send.
      }
    },

    showBrowserWindow: async () => {
      await get().ensureChrome(true);
    },

    refreshLogin: async (id, create) => {
      const bridge = api();
      if (!bridge) return;
      const openTab = create === true;
      const targets = id ? [id] : (Object.keys(emptyLogins()) as BrowserSiteId[]);
      await Promise.all(
        targets.map((site) =>
          bridge
            .loginStatus(site, openTab, openTab)
            .then((r) =>
              set((s) => ({ loginState: { ...s.loginState, [site]: r.logged_in } }))
            )
            .catch(() => undefined)
        )
      );
    },

    newChat: async (id) => {
      if (get().sending) return;
      const bridge = api();
      if (!bridge) return;
      try {
        const item = await bridge.newConversation(id);
        if ("error" in item) throw new Error(item.error);
        set((state) => ({
          messages: { ...state.messages, [id]: [] },
          activeConversationId: { ...state.activeConversationId, [id]: item.id },
          conversations: { ...state.conversations, [id]: [item, ...state.conversations[id]] }
        }));
      } catch (err) {
        set({ chromeError: err instanceof Error ? err.message : String(err) });
      }
    },

    deleteConversation: async (id, conversationId) => {
      if (get().sending) return;
      const bridge = api();
      if (!bridge) return;
      try {
        const result = await bridge.deleteConversation(id, conversationId);
        if (!result.success) throw new Error(result.error ?? "Could not delete this conversation.");
        window.dispatchEvent(new CustomEvent("xvie:browser-conversation-deleted", { detail: { conversationId } }));
        // Browser Agent and Browser Chat share the local provider conversation
        // IDs. Forget a deleted ID everywhere the agent could restore it.
        try {
          const key = "xvie-browser-agent-conversations";
          const saved = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, string>;
          let changed = false;
          for (const [thread, value] of Object.entries(saved)) {
            if (value === conversationId) { delete saved[thread]; changed = true; }
          }
          if (changed) localStorage.setItem(key, JSON.stringify(saved));
          const historyKey = "xvie-browser-agent-history";
          const history = JSON.parse(localStorage.getItem(historyKey) ?? "[]") as Array<{ conversationId?: string }>;
          const updatedHistory = history.map((entry) => {
            if (entry.conversationId !== conversationId) return entry;
            const { conversationId: _deleted, ...remaining } = entry;
            return remaining;
          });
          if (updatedHistory.some((entry, index) => entry !== history[index])) {
            localStorage.setItem(historyKey, JSON.stringify(updatedHistory));
          }
        } catch { /* local chat deletion should still succeed */ }
        const wasActive = get().activeConversationId[id] === conversationId;
        set((state) => ({
          conversations: { ...state.conversations, [id]: state.conversations[id].filter((item) => item.id !== conversationId) },
          ...(wasActive ? {
            messages: { ...state.messages, [id]: [] },
            activeConversationId: { ...state.activeConversationId, [id]: null },
          } : {}),
        }));
        if (wasActive) await get().newChat(id);
      } catch (err) {
        set({ chromeError: err instanceof Error ? err.message : String(err) });
      }
    },

    openConversation: async (id, conversationId) => {
      if (get().sending) return;
      const bridge = api();
      if (!bridge) return;
      try {
        const [items, opened] = await Promise.all([
          bridge.history(id, conversationId),
          bridge.openConversation(id, conversationId)
        ]);
        if ("error" in opened) throw new Error(opened.error);
        set((state) => ({
          activeConversationId: { ...state.activeConversationId, [id]: conversationId },
          messages: { ...state.messages, [id]: items.map((m) => ({
            id: uid("hist"), role: m.role, content: m.content, status: "done" as const,
            timestamp: m.timestamp ? Date.parse(m.timestamp) || Date.now() : Date.now()
          })) }
        }));
      } catch (err) {
        set({ chromeError: err instanceof Error ? err.message : String(err) });
      }
    },

    send: async (text, filePaths) => {
      const { activeSiteId, sending } = get();
      const trimmed = text.trim();
      if (!trimmed || !activeSiteId || sending) return;
      const bridge = api();
      const site = activeSiteId;
      const conversationId = get().activeConversationId[site] ?? undefined;
      const userMsg: BrowserChatMessage = {
        id: uid("msg"),
        role: "user",
        content: trimmed,
        files: filePaths.length > 0 ? [...filePaths] : undefined,
        status: "done",
        timestamp: Date.now()
      };

      // Known signed-out → show the sign-in prompt immediately, no backend call.
      if (get().loginState[site] === false) {
        set((state) => ({
          draft: "",
          messages: {
            ...state.messages,
            [site]: [
              ...state.messages[site],
              ...(state.messages[site].length ? [] : [modelGreeting(site)]),
              userMsg,
              {
                id: uid("msg"),
                role: "assistant",
                content: `You're not signed in to ${site}.`,
                status: "error",
                needsLogin: true,
                signinPrompt: true,
                timestamp: Date.now()
              }
            ]
          }
        }));
        return;
      }

      const streamId = uid("msg");
      set((state) => ({
        sending: true,
        draft: "",
        messages: {
          ...state.messages,
          [site]: [
            ...state.messages[site],
            ...(state.messages[site].length ? [] : [modelGreeting(site)]),
            userMsg,
            {
              id: streamId,
              role: "assistant",
              content: "",
              status: "streaming",
              timestamp: Date.now()
            }
          ]
        }
      }));

      if (!bridge) {
        set((state) => ({
          sending: false,
          messages: {
            ...state.messages,
            [site]: state.messages[site].map((m) =>
              m.id === streamId
                ? { ...m, status: "error", content: "Browser bridge unavailable (not running inside Electron)." }
                : m
            )
          }
        }));
        return;
      }

      // Live SSE stream first (partial text as the model types); fall back to
      // the blocking call if the stream can't start.
      // Watchdog: if no done/error frame arrives (backend restart, lost
      // SSE, streamId mismatch), unblock the composer instead of leaving
      // it disabled forever.
      const watchdog = window.setTimeout(() => {
        const s = get();
        if (!s.sending) return;
        const stuck = s.messages[site]?.some((m) => m.id === streamId && m.status === "streaming");
        if (stuck) {
          set((prev) => ({
            sending: false,
            messages: {
              ...prev.messages,
              [site]: prev.messages[site].map((m) =>
                m.id === streamId
                  ? { ...m, status: "error" as const, content: "No response arrived (stream lost). Press Reset and retry." }
                  : m
              )
            }
          }));
        }
      }, 180_000);
      try {
        const started = await bridge.askStream(streamId, site, trimmed, filePaths, conversationId);
        if (!started.accepted) throw new Error(started.error ?? "Stream rejected.");
        return;
      } catch {
        window.clearTimeout(watchdog);
        // fall through to blocking ask
      }

      // Blocking fallback gets its own timeout so a hung IPC never locks
      // the composer: 9 min matches the workflow ask() ceiling.
      const BLOCK_TIMEOUT_MS = 540_000;
      const blockTimeout = new Promise<never>((_, reject) => {
        window.setTimeout(() => reject(new Error("Timed out waiting for the model answer. Press Reset and retry.")), BLOCK_TIMEOUT_MS);
      });
      try {
        const result = await Promise.race([
          bridge.ask(site, trimmed, filePaths, conversationId),
          blockTimeout,
        ]);
        window.clearTimeout(watchdog);
        // Sticky thread: backend creates/returns the conversation id when
        // none was passed — remember it so the next message resumes the
        // same thread instead of starting over (the "forgetting" bug).
        const returnedId = result.success ? (result.conversation_id ?? conversationId) : conversationId;
        set((state) => ({
          sending: false,
          activeConversationId: returnedId
            ? { ...state.activeConversationId, [site]: returnedId }
            : state.activeConversationId,
          messages: {
            ...state.messages,
            [site]: state.messages[site].map((m) =>
              m.id === streamId
                ? result.success
                  ? { ...m, status: "done", content: result.answer, images: result.images ?? [] }
                  : {
                      ...m,
                      status: "error",
                      content: result.error,
                      needsLogin: result.needsLogin
                    }
                : m
            )
          }
        }));
        if (!result.success && result.needsLogin) {
          set((s) => ({ loginState: { ...s.loginState, [site]: false } }));
        }
      } catch (err) {
        window.clearTimeout(watchdog);
        set((state) => ({
          sending: false,
          messages: {
            ...state.messages,
            [site]: state.messages[site].map((m) =>
              m.id === streamId
                ? { ...m, status: "error", content: err instanceof Error ? err.message : String(err) }
                : m
            )
          }
        }));
      }
    }
  };
});
