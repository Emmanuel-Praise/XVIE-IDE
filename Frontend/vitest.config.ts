import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src/renderer/src") } },
  test: { include: ["src/renderer/test/**/*.test.ts"], environment: "node", setupFiles: ["src/renderer/test/setup.ts"] }
});
