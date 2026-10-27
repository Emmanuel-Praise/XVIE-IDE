import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";
import { tmpdir } from "os";

// VS Code and other Node hosts can export this flag to their child processes.
// Electron interprets it as "run as Node", which leaves `electron.app`
// undefined and prevents the window from ever being created.
if (process.env.ELECTRON_RUN_AS_NODE) {
  delete process.env.ELECTRON_RUN_AS_NODE;
}

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    // Keep Vite's atomic dependency-cache swaps out of node_modules. On
    // Windows, file scanners and sync tools can hold that directory open and
    // make the deps_temp -> deps rename fail with EPERM.
    cacheDir: resolve(tmpdir(), "xvie-vite-cache"),
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer/src"),
        // Monaco's exports map remaps subpaths ("./*" -> esm/vs/*.js), so
        // "monaco-editor/esm/vs/..." specifiers resolve to the real files.
        "monaco-editor/esm/": resolve(__dirname, "node_modules/monaco-editor/esm/") + "/",
        // The min/ bundle ships editor.main.css which isn't covered by the
        // exports map — alias it so Vite can resolve the import.
        "monaco-editor/min/": resolve(__dirname, "node_modules/monaco-editor/min/") + "/"
      }
    },
    optimizeDeps: {
      // Monaco ships plain ESM; pre-bundling it breaks ?worker imports.
      // Same for the pdf.js worker bundle: it's 1.2 MB of plain ESM and can
      // break esbuild's pre-bundler; serve it through the normal pipeline.
      exclude: ["monaco-editor", "pdfjs-dist/build/pdf.worker.min.mjs"]
    },
    plugins: [react(), tailwindcss()]
  }
});
