Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { api: { workspace: {} }, setTimeout }
});
