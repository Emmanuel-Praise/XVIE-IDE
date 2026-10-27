export interface Suggestion {
  id: string;
  icon: string;
  title: string;
  description: string;
  tags: string[];
  prompt: string;
}

export const SUGGESTIONS: Suggestion[] = [
  { id: "refactor", icon: "refactor", title: "Refactor component", description: "Clean up the active file — split it, name things well, keep behavior identical.", tags: ["Refactor", "Quality"], prompt: "Refactor the currently active file: extract reusable pieces, improve naming, remove dead code, and keep the behavior exactly the same." },
  { id: "feature", icon: "feature", title: "Add a feature", description: "Describe a feature and let the team implement it end to end, with tests.", tags: ["Feature", "Full-stack"], prompt: "Implement a new feature end to end: plan it, create the necessary files, wire everything up, and add verification steps." },
  { id: "bug", icon: "bug", title: "Fix a bug", description: "Find the root cause of an error, patch it, and confirm the fix with diagnostics.", tags: ["Debug", "Diagnostics"], prompt: "Investigate and fix the reported bug: reproduce the failure, find the root cause, apply a minimal fix, and run diagnostics to confirm." },
  { id: "explain", icon: "explain", title: "Explain codebase", description: "Get an architecture overview of this project with a guided summary.", tags: ["Research", "Docs"], prompt: "Explain this codebase: map the architecture, list the main modules, describe data flow, and highlight the most important files." },
  { id: "tests", icon: "tests", title: "Add tests", description: "Cover critical paths with unit tests and point out risky edges.", tags: ["Testing", "Verification"], prompt: "Add unit tests for the core logic: identify critical paths, write focused tests, run them, and report coverage." },
  { id: "review", icon: "review", title: "Review changes", description: "Audit recent edits for bugs, performance traps, and style issues.", tags: ["Review", "Quality"], prompt: "Review the latest changes in this project: look for bugs, performance issues, security concerns, and style violations, then propose fixes." }
];

export interface ExamplePrompt {
  icon: string;
  label: string;
}

export const EXAMPLE_PROMPTS: ExamplePrompt[] = [
  { icon: "zap", label: "Build a login form with validation" },
  { icon: "search", label: "Find where authentication is handled" },
  { icon: "test", label: "Write tests for the API layer" },
  { icon: "paint", label: "Improve the dark theme tokens" }
];

export interface Shortcut {
  keys: string;
  label: string;
}

export const SHORTCUTS: Shortcut[] = [
  { keys: "Enter", label: "Send request" },
  { keys: "@", label: "Attach a file to context" },
  { keys: "#", label: "Mention a symbol" },
  { keys: "Esc", label: "Stop generation" }
];
