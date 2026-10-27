/// <reference types="vite/client" />

interface Window {
  api: import("../../shared/ipc-types").XvieApi;
}

declare module "monaco-editor/esm/vs/editor/editor.api.js" {
  export const editor: typeof import("monaco-editor").editor;
  export const languages: typeof import("monaco-editor").languages;
  export const Uri: typeof import("monaco-editor").Uri;
  export const KeyMod: typeof import("monaco-editor").KeyMod;
  export const KeyCode: typeof import("monaco-editor").KeyCode;
  export const Position: typeof import("monaco-editor").Position;
  export const Range: typeof import("monaco-editor").Range;
}

declare module "monaco-editor/esm/vs/languages/definitions/*" {
  export const conf: import("monaco-editor").languages.LanguageConfiguration;
  export const language: import("monaco-editor").languages.IMonarchLanguage;
}

declare module "monaco-editor/esm/vs/languages/features/*/register" {
  export const jsonDefaults: unknown;
  export const cssDefaults: unknown;
  export const lessDefaults: unknown;
  export const scssDefaults: unknown;
}

/*
 * Monaco's contrib feature modules are side-effect imports (they register
 * commands/contributions on import) resolved at build time via the Vite alias
 * in electron.vite.config.ts. Ambient declarations keep TypeScript happy.
 */
declare module "monaco-editor/esm/vs/editor/contrib/*.js";
declare module "monaco-editor/esm/vs/languages/features/*.js";

/*
 * The pdf.js worker bundle (legacy "fake worker" entry) ships without its own
 * type declarations; importing the namespace registers
 * WorkerMessageHandler for in-process rendering.
 */
declare module "pdfjs-dist/build/pdf.worker.min.mjs";
