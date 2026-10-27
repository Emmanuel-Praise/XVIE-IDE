import type { BrowserSiteId } from "../../../shared/ipc-types";

/**
 * Curated guidance for the model welcome screens.
 * Sourced from docs/browser-models-strengths.md — keep the two in sync.
 */

export interface BrowserModelMeta {
  id: BrowserSiteId;
  /** Short hero subtitle shown under the model name. */
  tagline: string;
  /** Short tags shown on the card, e.g. "Code", "Research". */
  bestFor: string[];
  /** One-line "use when…" guidance. */
  useWhen: string;
  /** One-line caution shown on expand / tooltip. */
  watchOut: string;
  /** Clickable starter prompts for the welcome composer. */
  examplePrompts: string[];
  /** True while the site is single-chat only (not usable in Browser Agent). */
  chatOnly?: boolean;
}

export const BROWSER_MODEL_META: Record<BrowserSiteId, BrowserModelMeta> = {
  chatgpt: {
    id: "chatgpt",
    tagline: "Everyday answers, ideas, and writing.",
    bestFor: ["Brainstorm", "Writing", "Explaining", "Images"],
    useWhen: "Default pick for everyday questions, docs, and ideas.",
    watchOut: "Double-check facts and hard multi-file code.",
    examplePrompts: [
      "Summarize this document in five bullet points",
      "Rewrite this paragraph so it reads more clearly",
      "Brainstorm ten names for this feature"
    ]
  },
  claude: {
    id: "claude",
    tagline: "Your coding and long-form partner.",
    bestFor: ["Code", "Debug", "Plans", "Review"],
    useWhen: "Anything in your codebase — features, fixes, refactors.",
    watchOut: "No image generation; slower on long outputs.",
    examplePrompts: [
      "Review this file for bugs and edge cases",
      "Refactor this function and explain the change",
      "Plan the steps to add this feature"
    ]
  },
  gemini: {
    id: "gemini",
    tagline: "Huge context and fresh, current info.",
    bestFor: ["Long docs", "Current info", "Math"],
    useWhen: "Huge pasted context or questions needing fresh info.",
    watchOut: "Verify generated code by running it.",
    examplePrompts: [
      "Compare these documents and list the differences",
      "Explain this topic with recent examples",
      "Solve and explain this math problem step by step"
    ]
  },
  deepseek: {
    id: "deepseek",
    tagline: "Deep reasoning for code and logic.",
    bestFor: ["Code", "Reasoning", "Math", "Tests"],
    useWhen: "Debugging and algorithms when you want to see the reasoning.",
    watchOut: "Keep prompts structured; long writes continue automatically.",
    examplePrompts: [
      "Debug this traceback and propose a fix",
      "Write tests for this module",
      "Walk through this algorithm and its complexity"
    ]
  },
  grok: {
    id: "grok",
    tagline: "Fast takes on what's happening now.",
    bestFor: ["Current info", "Brainstorm", "Quick takes"],
    useWhen: "What's happening now, or a second opinion on a plan.",
    watchOut: "Not the pick for careful multi-file coding.",
    examplePrompts: [
      "What are people saying about this today?",
      "Give me a quick second opinion on this plan",
      "Summarize the latest news on this topic"
    ]
  },
  qwen: {
    id: "qwen",
    tagline: "Code plus multilingual fluency.",
    bestFor: ["Code", "Multilingual"],
    useWhen: "Code tasks plus Chinese / non-English sources or UI strings.",
    watchOut: "English creative writing trails ChatGPT and Claude.",
    examplePrompts: [
      "Translate this UI copy to Chinese",
      "Find the bug in this code",
      "Explain this Chinese technical doc"
    ]
  },
  perplexity: {
    id: "perplexity",
    tagline: "Cited research you can verify.",
    bestFor: ["Research", "Current info", "Citations"],
    useWhen: "Research questions where you want cited, sourced answers.",
    watchOut: "Chat only for now — not available in Browser Agent runs.",
    examplePrompts: [
      "Research this topic and cite your sources",
      "Find recent statistics with citations",
      "Summarize expert opinions with links"
    ],
    chatOnly: true
  }
};

/** Sites usable as Browser Agent coordinator/workers (excludes chat-only). */
export function agentEligibleSites(ids: readonly BrowserSiteId[]): BrowserSiteId[] {
  return ids.filter((id) => BROWSER_MODEL_META[id]?.chatOnly !== true);
}

export function isChatOnlySite(id: BrowserSiteId): boolean {
  return BROWSER_MODEL_META[id]?.chatOnly === true;
}
