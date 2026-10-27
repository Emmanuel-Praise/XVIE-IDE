import * as monaco from "monaco-editor";
import type * as MonacoType from "monaco-editor";
import { loader } from "@monaco-editor/react";

import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/languages/features/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import { registerCustomLanguages } from "./custom-languages";

export type MonacoApi = Pick<
  typeof MonacoType,
  "editor" | "languages" | "Uri" | "KeyMod" | "KeyCode" | "Position" | "Range"
>;

const api: MonacoApi = monaco;
let environmentConfigured = false;
let loaderConfigured = false;

// Register Xvie's custom language grammars (MQL5, PineScript) eagerly so they
// are available before the first file opens or a Monaco model is created.
registerCustomLanguages(api);

export const APP_DARK_THEME = "xvie-dark-app-surface";

/** Keeps Monaco's native dark token colors while matching the app's editor canvas. */
export function defineAppDarkTheme(): void {
  const background = getComputedStyle(document.documentElement)
    .getPropertyValue("--editor-surface")
    .trim() || "#050505";

  monaco.editor.defineTheme(APP_DARK_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": background,
      "editorGutter.background": background,
      "minimap.background": background,
      "editorStickyScroll.background": background
    }
  });
}

export function getMonaco(): Promise<MonacoApi> {
  return Promise.resolve(api);
}

export function getMonacoSync(): MonacoApi {
  return api;
}

function configureMonacoEnvironment(): void {
  globalThis.MonacoEnvironment = {
    getWorker: (_moduleId: string, label: string): Worker => {
      switch (label) {
        case "typescript":
        case "javascript":
          return new TsWorker();
        case "json":
          return new JsonWorker();
        case "css":
        case "scss":
        case "less":
          return new CssWorker();
        case "html":
        case "handlebars":
        case "razor":
          return new HtmlWorker();
        default:
          return new EditorWorker();
      }
    }
  };
}

/** Configure Monaco's standard local bundle for Electron; no themes or editor options are changed. */
export async function initMonacoProvider(): Promise<MonacoApi> {
  if (!environmentConfigured) {
    configureMonacoEnvironment();
    environmentConfigured = true;
  }
  if (!loaderConfigured) {
    loader.config({ monaco });
    loaderConfigured = true;
  }
  registerCustomLanguages(api);
  return api;
}
