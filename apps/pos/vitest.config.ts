import { defineConfig, configDefaults } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@shared": path.resolve(__dirname, "../../src/lib"),
    },
  },
  test: {
    // The _offline tests are no longer parked — better-sqlite3 is a real
    // dependency and they cover the event log, reducer and sync engine.
    //
    // dist-electron stays excluded: vitest's defaults cover **/dist/** but not
    // **/dist-electron/**, so a tree still holding a pre-`--noEmit` build had
    // its compiled _offline/*.test.js collected and failed on `require("vitest")`.
    exclude: [...configDefaults.exclude, "**/dist-electron/**"],
  },
});
