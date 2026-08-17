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
    // The offline SQLite store/sync tests are parked (need the native
    // better-sqlite3 build); exclude them from the default online-first run.
    //
    // dist-electron is excluded too: vitest's defaults cover **/dist/** but not
    // **/dist-electron/**, so a tree still holding a pre-`--noEmit` build had
    // its compiled _offline/*.test.js collected and failed on `require("vitest")`.
    // The build no longer emits those, but a stale checkout should not be a
    // red test run.
    exclude: [
      ...configDefaults.exclude,
      "**/electron/_offline/**",
      "**/dist-electron/**",
    ],
  },
});
