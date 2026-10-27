import { useEffect, useMemo, useRef, useState } from "react";
import {
  Eye,
  EyeOff,
  FileText,
  History,
  Loader2,
  LogIn,
  Paperclip,
  Play,
  Plus,
  Send,
  Trash2,
  X
} from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { useBrowserStore } from "@/Browser/browserStore";
import { siteById } from "@/Browser/browserSites";
import { useEditorStore } from "@/Editor/editorStore";
import { BRAND_TINT, BrandIcon } from "@/Browser/components/brand-icons";
import MessageMarkdown from "@/Agent/components/conversation/message-markdown";
import ModelWelcome from "@/Browser/components/model-welcome";
import "@/Agent/styles/agent-markdown.css";

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export default function BrowserChatPanel(): React.JSX.Element {
  const activeSiteId = useBrowserStore((s) => s.activeSiteId);
  const setActiveSite = useBrowserStore((s) => s.setActiveSite);
  const messages = useBrowserStore((s) =>
    s.activeSiteId ? s.messages[s.activeSiteId] : []
  );
  const draft = useBrowserStore((s) => s.draft);
  const setDraft = useBrowserStore((s) => s.setDraft);
  const sending = useBrowserStore((s) => s.sending);
  const send = useBrowserStore((s) => s.send);
  const resetSending = useBrowserStore((s) => s.resetSending);
  const newChat = useBrowserStore((s) => s.newChat);
  const conversations = useBrowserStore((s) => activeSiteId ? s.conversations[activeSiteId] : []);
  const openConversation = useBrowserStore((s) => s.openConversation);
  const deleteConversation = useBrowserStore((s) => s.deleteConversation);
  const showBrowserWindow = useBrowserStore((s) => s.showBrowserWindow);
  const ensureChrome = useBrowserStore((s) => s.ensureChrome);
  const startChat = useBrowserStore((s) => s.startChat);
  const sidecarOn = useBrowserStore((s) => s.status?.sidecar === true);
  const sidecarStarting = useBrowserStore((s) => s.sidecarStarting);
  const sidecarError = useBrowserStore((s) => s.sidecarError);
  const startSidecar = useBrowserStore((s) => s.startSidecar);
  const chromeUp = useBrowserStore((s) => s.status?.cdp_reachable === true);
  const chromeVisible = useBrowserStore((s) => s.status?.chrome_visible === true);
  const chromeManaged = useBrowserStore((s) => s.status?.chrome_managed === true);

  const [attached, setAttached] = useState<string[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const site = siteById(activeSiteId);
  // NOTE: select the stable groups map here and derive tabs with useMemo.
  // Returning a fresh array from the selector itself retriggers zustand on
  // every render and locks the app in an infinite render loop (blank screen).
  const groups = useEditorStore((s) => s.groups);
  const openTabs = useMemo(
    () => [...new Set(Object.values(groups).flatMap((g) => g.tabs))],
    [groups]
  );

  useEffect(() => {
    setAttached([]);
    setAttachOpen(false);
  }, [activeSiteId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [draft]);

  if (!site || !activeSiteId) return <></>;

  const submit = async (): Promise<void> => {
    if (!draft.trim() || sending) return;
    // First message starts the hidden browser + service automatically.
    await ensureChrome(false);
    void send(draft, attached);
    setAttached([]);
    textareaRef.current?.focus();
  };

  const useExample = (text: string): void => {
    setDraft(text);
    textareaRef.current?.focus();
  };

  const toggleAttach = (path: string): void => {
    setAttached((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]
    );
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-row overflow-hidden bg-surface-container-lowest">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* Header — mirrors the agent panel header */}
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-outline-variant px-3">
          <span
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-md",
              BRAND_TINT[site.id]
            )}
          >
            <BrandIcon id={site.id} size={14} />
          </span>
          <h2 className="min-w-0 flex-1 truncate font-label-md text-label-md font-bold text-on-surface">
            {site.label}
          </h2>
          <button
            type="button"
            title={
              !chromeUp || !chromeManaged
                ? "Show browser window"
                : chromeVisible
                  ? "Hide browser window"
                  : "Show browser window (log in there if asked)"
            }
            aria-label="Toggle browser window"
            onClick={() =>
              void (chromeUp && chromeManaged && chromeVisible
                ? ensureChrome(false)
                : showBrowserWindow())
            }
            className="cursor-pointer rounded-md p-1.5 text-secondary transition-colors hover:bg-surface-container-low hover:text-on-surface"
          >
            {chromeVisible && chromeManaged ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
          <button
            type="button"
            title="New chat"
            aria-label="New chat"
            disabled={sending}
            onClick={() => void newChat(site.id)}
            className="cursor-pointer rounded-md p-1.5 text-secondary transition-colors hover:bg-surface-container-low hover:text-on-surface"
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            title="Conversation history"
            aria-label="Conversation history"
            aria-expanded={historyOpen}
            disabled={sending}
            onClick={() => setHistoryOpen((open) => !open)}
            className={cn("cursor-pointer rounded-md p-1.5 transition-colors hover:bg-surface-container-low hover:text-on-surface", historyOpen ? "text-primary" : "text-secondary")}
          >
            <History size={14} />
          </button>
          <button
            type="button"
            title="Close browser chat"
            aria-label="Close browser chat"
            onClick={() => setActiveSite(null)}
            className="cursor-pointer rounded-md p-1.5 text-secondary transition-colors hover:bg-surface-container-low hover:text-on-surface"
          >
            <X size={14} />
          </button>
        </div>

        {historyOpen && (
          <div className="max-h-48 shrink-0 overflow-y-auto border-b border-outline-variant bg-surface-container-lowest px-2 py-1.5 agent-code-scroll">
            {conversations.length === 0 ? (
              <p className="px-2 py-3 font-label-xs text-label-xs text-secondary">No saved conversations yet.</p>
            ) : conversations.map((conversation) => (
              <div key={conversation.id} className="flex items-center gap-1 rounded-md hover:bg-surface-container-low">
                <button
                  type="button"
                  disabled={sending}
                  onClick={() => { void openConversation(site.id, conversation.id); setHistoryOpen(false); }}
                  className="min-w-0 flex-1 truncate px-2 py-2 text-left font-label-sm text-label-sm text-on-surface"
                  title={conversation.title}
                >
                  {conversation.title || "New conversation"}
                </button>
                <button type="button" disabled={sending} title={`Delete ${conversation.title || "conversation"}`} aria-label={`Delete ${conversation.title || "conversation"}`} onClick={() => void deleteConversation(site.id, conversation.id)} className="mr-1 rounded-md p-1.5 text-secondary hover:bg-surface-container hover:text-error disabled:opacity-50"><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
        )}

        {/* Transcript */}
        <div ref={scrollRef} className="agent-code-scroll min-h-0 flex-1 overflow-y-scroll">
          <div className="flex flex-col gap-4 px-4 py-4">
            {messages.length === 0 && (
              <ModelWelcome
                siteId={site.id}
                onExample={useExample}
                onChat={() => {
                  void startChat(site.id);
                  textareaRef.current?.focus();
                }}
              />
            )}

            {messages.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="flex shrink-0 justify-end">
                  <div className="agent-user-bubble max-w-[90%] rounded-xl rounded-br-sm px-3 py-2">
                    {m.files && m.files.length > 0 && (
                      <div className="mb-1.5 flex flex-col gap-1">
                        {m.files.map((f) => (
                          <span
                            key={f}
                            className="flex items-center gap-1.5 font-label-xs text-label-xs text-secondary"
                          >
                            <FileText size={11} className="shrink-0" />
                            <span className="truncate">{fileNameOf(f)}</span>
                          </span>
                        ))}
                      </div>
                    )}
                    <p className="whitespace-pre-wrap font-body-md text-body-md text-on-surface">
                      {m.content}
                    </p>
                  </div>
                </div>
              ) : (
                <div key={m.id} className="flex min-w-0 shrink-0 flex-col gap-1">
                  {m.status === "streaming" ? (
                    m.content ? (
                      // Plain text while streaming: partial markdown would
                      // flicker with unclosed fences/tables. Full markdown
                      // renders once the reply completes.
                      <div className="agent-prose">
                        <p className="whitespace-pre-wrap">
                          {m.content}
                          <span className="agent-caret" />
                        </p>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 py-1">
                        <Loader2 size={13} className="animate-spin text-secondary" />
                        <span className="font-label-sm text-label-sm text-secondary">
                          {site.label} is answering…
                        </span>
                      </div>
                    )
                  ) : m.status === "error" ? (
                    m.signinPrompt ? (
                      <div className="flex flex-col items-start gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/5 px-3.5 py-3">
                        <span
                          className={cn(
                            "flex h-8 w-8 items-center justify-center rounded-lg",
                            BRAND_TINT[site.id]
                          )}
                        >
                          <BrandIcon id={site.id} size={18} />
                        </span>
                        <p className="font-label-md text-label-md font-medium text-on-surface">
                          Sign in to {site.label} to start chatting
                        </p>
                        <p className="font-body-sm text-body-sm leading-relaxed text-secondary">
                          The browser will appear — sign in there, then come
                          back and send your message again.
                        </p>
                        <button
                          type="button"
                          onClick={() => void showBrowserWindow()}
                          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 font-label-sm text-label-sm font-medium text-on-primary transition-opacity hover:opacity-90"
                        >
                          <LogIn size={13} />
                          Sign in
                        </button>
                      </div>
                    ) : (
                      <div className="rounded-xl border border-error/40 bg-error/5 px-3 py-2.5">
                        <p className="whitespace-pre-wrap font-body-sm text-body-sm text-error">
                          {m.content}
                        </p>
                        {m.needsLogin && (
                          <button
                            type="button"
                            onClick={() => void showBrowserWindow()}
                            className="mt-2 inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-error/40 px-2.5 py-1 font-label-sm text-label-sm text-error transition-colors hover:bg-error/10"
                          >
                            <LogIn size={12} />
                            Sign in to {site.label}
                          </button>
                        )}
                      </div>
                    )
                  ) : (
                    <div className="min-w-0">
                      {m.content && <MessageMarkdown content={m.content} />}
                      {m.images && m.images.length > 0 && (
                        <div className="mt-2 flex flex-col gap-2">
                          {m.images.map((src) => (
                            <img
                              key={src}
                              src={src}
                              loading="lazy"
                              alt={`${site.label} generated image`}
                              className="max-h-72 w-full rounded-xl border border-outline-variant bg-surface-container-low object-contain"
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            )}
          </div>
        </div>

        {/* Service gate — only when the AI service isn't running. */}
        {!sidecarOn && (
          <div className="shrink-0 px-3 pt-2">
            <div className="flex items-center gap-2 rounded-xl border border-outline-variant bg-surface-container-low px-3 py-2">
              <span className={cn("h-2 w-2 shrink-0 rounded-full", sidecarStarting ? "animate-pulse bg-amber-500" : "bg-amber-500")} />
              <span className="min-w-0 flex-1 font-label-xs text-label-xs text-secondary">
                {sidecarStarting ? "Starting AI chat…" : "AI chat isn't connected yet."}
              </span>
              <button
                type="button"
                onClick={() => void startSidecar()}
                disabled={sidecarStarting}
                className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1.5 font-label-xs text-label-xs font-medium text-on-primary transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {sidecarStarting ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                {sidecarStarting ? "Starting…" : "Connect"}
              </button>
            </div>
            {sidecarError && (
              <p className="mt-1.5 max-w-full whitespace-pre-wrap font-label-xs text-label-xs text-red-400/90">{sidecarError}</p>
            )}
          </div>
        )}

        {/* Composer — mirrors the agent PromptArea */}
        <div className="shrink-0 px-3 pb-3 pt-1">
          {attached.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {attached.map((path) => (
                <span
                  key={path}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-outline-variant bg-surface-container-low py-0.5 pl-2 pr-1 font-label-xs text-label-xs text-on-surface"
                >
                  <FileText size={11} className="shrink-0 text-secondary" />
                  <span className="max-w-[180px] truncate">{fileNameOf(path)}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${fileNameOf(path)}`}
                    onClick={() => toggleAttach(path)}
                    className="cursor-pointer rounded p-0.5 text-secondary hover:text-on-surface"
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="rounded-xl border border-outline-variant bg-transparent transition-colors focus-within:border-outline">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setAttachOpen(false);
                  setHistoryOpen(false);
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder={sending ? `Waiting for ${site.label}… (Reset to unlock)` : `Ask ${site.label}…`}
              rows={2}
              disabled={false}
              className="w-full resize-none bg-transparent px-3.5 py-2.5 font-body-md text-body-md text-on-surface placeholder-secondary focus:outline-none disabled:opacity-60"
            />
            <div className="flex items-center justify-between border-t border-outline-variant/70 px-2 py-1.5">
              <div className="relative">
                <button
                  type="button"
                  title="Attach open files"
                  onClick={() => setAttachOpen((v) => !v)}
                  className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 font-label-xs text-label-xs text-secondary transition-colors hover:bg-surface-container-low hover:text-on-surface"
                >
                  <Paperclip size={12} />
                  Attach
                </button>
                {attachOpen && (
                  <>
                    <button
                      type="button"
                      aria-label="Close attach menu"
                      className="fixed inset-0 z-40 cursor-default"
                      onClick={() => setAttachOpen(false)}
                    />
                    <div className="absolute bottom-full left-0 z-50 mb-1.5 max-h-56 w-64 overflow-y-auto rounded-xl border border-outline-variant bg-surface-container-lowest p-1 shadow-lg">
                      {openTabs.length === 0 && (
                        <p className="px-2.5 py-2 font-label-sm text-label-sm text-secondary">
                          No open files. Open a file in the editor first.
                        </p>
                      )}
                      {openTabs.map((path) => (
                        <button
                          key={path}
                          type="button"
                          onClick={() => toggleAttach(path)}
                          className={cn(
                            "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-surface-container",
                            attached.includes(path) && "bg-surface-container-low"
                          )}
                        >
                          <FileText size={13} className="shrink-0 text-secondary" />
                          <span className="min-w-0 flex-1 truncate font-label-sm text-label-sm text-on-surface">
                            {fileNameOf(path)}
                          </span>
                          {attached.includes(path) && (
                            <X size={12} className="shrink-0 text-on-surface" />
                          )}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              <span className="flex items-center gap-1">
                {sending && (
                  <button
                    type="button"
                    onClick={resetSending}
                    className="cursor-pointer rounded px-1 py-0.5 font-label-xs text-label-xs text-secondary hover:text-on-surface"
                    title="Force-unlock the send box if the stream is stuck"
                  >
                    Reset
                  </button>
                )}
                <button
                  type="button"
                  onClick={submit}
                  disabled={!draft.trim() || sending}
                  title="Send"
                  className={cn(
                    "flex h-7 w-7 cursor-pointer items-center justify-center rounded-full transition-colors",
                    draft.trim() && !sending
                      ? "bg-primary text-on-primary hover:opacity-90"
                      : "cursor-not-allowed bg-surface-container-high text-secondary"
                  )}
                >
                  {sending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                </button>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
