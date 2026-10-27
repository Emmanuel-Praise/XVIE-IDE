import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, CircleCheck, KeyRound, LockKeyhole, Save, Server, X } from "lucide-react";
import { useAgentStore } from "../../agentStore";
import type { AgentProviderProfile } from "../../../../../shared/ipc-types";

export default function ProviderSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const profiles = useAgentStore((state) => state.providers);
  const selected = useAgentStore((state) => state.selectedProvider);
  const setSelected = useAgentStore((state) => state.setSelectedProvider);
  const refresh = useAgentStore((state) => state.refreshProviders);
  const save = useAgentStore((state) => state.saveProvider);
  const [name, setName] = useState("openrouter");
  const [baseUrl, setBaseUrl] = useState("https://openrouter.ai/api/v1");
  const [model, setModel] = useState("deepseek/deepseek-chat-v3-0324");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => { if (open) void refresh(); }, [open, refresh]);
  useEffect(() => {
    const profile = profiles.find((item) => item.name === selected) ?? profiles[0];
    if (!profile) return;
    setName(profile.name);
    setBaseUrl(profile.baseUrl);
    setModel(profile.model);
    setApiKey("");
  }, [profiles, selected]);

  const chooseProfile = (profile: AgentProviderProfile): void => {
    setSelected(profile.name);
    setName(profile.name);
    setBaseUrl(profile.baseUrl);
    setModel(profile.model);
    setApiKey("");
    setMessage("");
  };

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    setMessage("");
    const result = await save({ name, baseUrl, model, apiKey });
    setSaving(false);
    if (!result.success) { setMessage(result.error ?? "Could not save provider settings."); return; }
    setApiKey("");
    setMessage("Provider saved securely.");
  };

  const hasSavedKey = profiles.some((item) => item.name === name && item.configured);
  const isMeterlessRuntime = name.toLowerCase() === "meterless";
  const inputClass = "mt-1.5 w-full rounded-lg border border-outline-variant bg-background px-3 py-2.5 font-label-sm text-label-sm text-on-surface outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15 placeholder:text-secondary/60";

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
        >
          <motion.section
            role="dialog" aria-modal="true" aria-labelledby="agent-provider-title"
            initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.18 }}
            className="flex max-h-[min(88vh,760px)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-outline-variant bg-surface-container-lowest shadow-2xl"
          >
            <header className="flex shrink-0 items-start justify-between gap-4 border-b border-outline-variant px-6 py-5">
              <div className="flex min-w-0 items-start gap-3.5">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Server size={19} />
                </span>
                <div className="min-w-0">
                  <p className="font-label-xs text-label-xs font-semibold uppercase tracking-[0.12em] text-primary">Agent configuration</p>
                  <h2 id="agent-provider-title" className="mt-1 font-headline-sm text-headline-sm font-semibold text-on-surface">Model providers</h2>
                  <p className="mt-1 font-label-sm text-label-sm text-secondary">Connect an OpenAI compatible model endpoint.</p>
                </div>
              </div>
              <button type="button" onClick={onClose} aria-label="Close provider settings" className="rounded-lg p-2 text-secondary transition hover:bg-surface-container hover:text-on-surface"><X size={17} /></button>
            </header>

            <div className="grid min-h-0 flex-1 overflow-y-auto md:grid-cols-[210px_minmax(0,1fr)]">
              <aside className="border-b border-outline-variant bg-surface-container-low/50 p-4 md:border-b-0 md:border-r">
                <div className="mb-3 flex items-center justify-between gap-2 px-1">
                  <h3 className="font-label-xs text-label-xs font-semibold uppercase tracking-[0.1em] text-secondary">Your providers</h3>
                  <span className="rounded-full bg-surface-container px-2 py-0.5 font-label-xs text-label-xs text-secondary">{profiles.length}</span>
                </div>
                <div className="flex gap-2 overflow-x-auto md:flex-col md:overflow-visible">
                  {profiles.map((profile) => {
                    const active = selected === profile.name;
                    return (
                      <button key={profile.name} type="button" onClick={() => chooseProfile(profile)}
                        className={`flex min-w-[150px] items-center gap-3 rounded-xl border p-3 text-left transition md:min-w-0 ${active ? "border-primary/40 bg-primary/10" : "border-transparent bg-transparent hover:border-outline-variant hover:bg-surface-container-low"}`}>
                        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${active ? "bg-primary/15 text-primary" : "bg-surface-container text-secondary"}`}><Server size={15} /></span>
                        <span className="min-w-0 flex-1">
                          <span className={`block truncate font-label-sm text-label-sm font-medium ${active ? "text-on-surface" : "text-secondary"}`}>{profile.name}</span>
                          <span className="mt-0.5 flex items-center gap-1 font-label-xs text-label-xs text-secondary">
                            {profile.configured ? <><CircleCheck size={11} className="text-primary" /> {profile.name.toLowerCase() === "meterless" ? "Token detected" : "Key saved"}</> : "Needs API key"}
                          </span>
                        </span>
                        {active && <Check size={14} className="shrink-0 text-primary" />}
                      </button>
                    );
                  })}
                  {profiles.length === 0 && <p className="px-1 py-2 font-label-xs text-label-xs leading-relaxed text-secondary">No saved providers yet. Add your connection details to get started.</p>}
                </div>
                <div className="mt-4 hidden rounded-xl border border-outline-variant/70 bg-surface-container-low p-3 md:block">
                  <p className="flex items-center gap-2 font-label-xs text-label-xs font-medium text-on-surface"><LockKeyhole size={13} className="text-primary" /> Private by design</p>
                  <p className="mt-1.5 font-label-xs text-label-xs leading-relaxed text-secondary">API keys are stored using your operating system’s secure storage.</p>
                </div>
              </aside>

              <div className="min-w-0 p-5 sm:p-6">
                <div className="mb-5 flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-label-md text-label-md font-semibold text-on-surface">Connection details</h3>
                    <p className="mt-1 font-label-xs text-label-xs text-secondary">Set the endpoint and model used by your agent.</p>
                  </div>
                  {hasSavedKey && <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 font-label-xs text-label-xs font-medium text-primary"><CircleCheck size={12} /> Connected</span>}
                </div>

                <div className="grid gap-x-4 gap-y-4 sm:grid-cols-2">
                  <label className="block min-w-0 font-label-xs text-label-xs font-medium text-secondary">
                    Provider name
                    <input value={name} onChange={(event) => setName(event.target.value)} placeholder="openrouter" className={inputClass} />
                  </label>
                  <label className="block min-w-0 font-label-xs text-label-xs font-medium text-secondary">
                    Model ID
                    <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="provider/model-name" readOnly={isMeterlessRuntime} className={`${inputClass} ${isMeterlessRuntime ? "opacity-70" : ""}`} />
                  </label>
                  <label className="block min-w-0 sm:col-span-2 font-label-xs text-label-xs font-medium text-secondary">
                    Base URL
                    <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" className={inputClass} />
                  </label>
                  <label className="block min-w-0 sm:col-span-2 font-label-xs text-label-xs font-medium text-secondary">
                    <span className="flex items-center gap-1.5"><KeyRound size={13} /> {isMeterlessRuntime ? "Runtime authentication" : "API key"}</span>
                    {isMeterlessRuntime ? (
                      <span className="mt-1.5 block rounded-lg bg-surface-container px-3 py-2.5 font-label-xs text-label-xs font-normal text-secondary">Uses the local Meterless token file automatically. Start the Meterless runtime before running the agent.</span>
                    ) : <>
                      <input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={hasSavedKey ? "Saved key stays unchanged when blank" : "Paste your API key"} className={inputClass} />
                      <span className="mt-1.5 block font-label-xs text-label-xs font-normal text-secondary">{hasSavedKey ? "Leave blank to keep your current key." : "Your key is encrypted and never shown again after saving."}</span>
                    </>}
                  </label>
                </div>

                {message && <p role="status" className={`mt-4 rounded-lg border px-3 py-2 font-label-xs text-label-xs ${message === "Provider saved securely." ? "border-primary/25 bg-primary/5 text-primary" : "border-red-500/25 bg-red-500/5 text-red-500"}`}>{message}</p>}
              </div>
            </div>

            <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-outline-variant bg-surface-container-low/40 px-5 py-4 sm:px-6">
              <p className="flex items-center gap-2 font-label-xs text-label-xs text-secondary md:hidden"><LockKeyhole size={13} className="text-primary" /> API keys are stored securely</p>
              <span className="hidden md:block" />
              <div className="ml-auto flex items-center gap-2">
                <button type="button" onClick={onClose} className="rounded-lg px-3.5 py-2 font-label-sm text-label-sm font-medium text-secondary transition hover:bg-surface-container">Close</button>
                <button type="button" disabled={saving || isMeterlessRuntime || !name.trim() || !baseUrl.trim() || !model.trim()} onClick={() => void handleSave()} className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 font-label-sm text-label-sm font-medium text-on-primary shadow-sm transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50">
                  {saving ? <><span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" /> Saving…</> : <><Save size={14} /> Save provider</>}
                </button>
              </div>
            </footer>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
