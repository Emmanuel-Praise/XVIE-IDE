import type { BrowserSiteId, BrowserSiteInfo } from "../../../shared/ipc-types";

/** Hardcoded sites — mirrors Backend/browser-agent/sites.py. */
export const BROWSER_SITES: BrowserSiteInfo[] = [
  { id: "chatgpt", label: "ChatGPT", url: "https://chatgpt.com/", domains: ["chatgpt.com"] },
  { id: "claude", label: "Claude", url: "https://claude.ai/", domains: ["claude.ai"] },
  { id: "gemini", label: "Gemini", url: "https://gemini.google.com/", domains: ["gemini.google.com"] },
  { id: "deepseek", label: "DeepSeek", url: "https://chat.deepseek.com/", domains: ["chat.deepseek.com"] },
  { id: "grok", label: "Grok", url: "https://grok.com/", domains: ["grok.com"] },
  { id: "qwen", label: "Qwen", url: "https://chat.qwen.ai/", domains: ["chat.qwen.ai"] },
  { id: "perplexity", label: "Perplexity", url: "https://www.perplexity.ai/", domains: ["perplexity.ai"] }
];

export function siteById(id: BrowserSiteId | null): BrowserSiteInfo | null {
  if (!id) return null;
  return BROWSER_SITES.find((s) => s.id === id) ?? null;
}
