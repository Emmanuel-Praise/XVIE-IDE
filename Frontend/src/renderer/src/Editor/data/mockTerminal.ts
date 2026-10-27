export const terminalLines: string[] = [
  "➜  xvie-core git:(main) ✗ npm run dev",
  "> xvie-core@0.4.2 dev",
  "> vite",
  "",
  "VITE v7.3.6  ready in 250 ms",
  "",
  "  ➜  Local:   http://localhost:5173/",
  "  ➜  Network: use --host to expose",
  "  ➜  press h to show help"
];

export interface SearchResult {
  path: string;
  line: number;
  snippet: string;
}

export const searchResults: SearchResult[] = [
  {
    path: "src/workspace.js",
    line: 7,
    snippet: "constructor(config) {"
  },
  {
    path: "src/workspace.js",
    line: 12,
    snippet: "async initialize() {"
  },
  {
    path: "src/layout.js",
    line: 3,
    snippet: "constructor(config) {"
  },
  {
    path: "src/index.js",
    line: 1,
    snippet: "import { WorkspaceManager } from './workspace';"
  }
];

export interface GitChange {
  path: string;
  kind: "modified" | "untracked" | "staged";
}

export const gitChanges: GitChange[] = [
  { path: "src/workspace.js", kind: "modified" },
  { path: "src/styles.css", kind: "modified" },
  { path: "src/layout.js", kind: "untracked" }
];

export interface ProblemItem {
  severity: "error" | "warning";
  message: string;
  source: string;
  line: number;
}

export const problemItems: ProblemItem[] = [
  {
    severity: "error",
    message: "Cannot find module './layout'",
    source: "ESLint",
    line: 4
  },
  {
    severity: "warning",
    message: "'editor' is defined but never used",
    source: "ESLint",
    line: 25
  }
];

export const outputLines: string[] = [
  "[12:04:11] Starting 'watch:renderer'...",
  "[12:04:11] vite v7.3.6 dev server running at:",
  "[12:04:11]   > Local: http://localhost:5173/",
  "[12:04:14] src/workspace.js changed, hot reloading...",
  "[12:04:14] hmr update /src/workspace.js"
];
