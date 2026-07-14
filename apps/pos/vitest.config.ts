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
    exclude: [...configDefaults.exclude, "**/electron/_offline/**"],
  },
});
