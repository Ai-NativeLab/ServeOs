import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    // The offline SQLite store/sync tests are parked (need the native
    // better-sqlite3 build); exclude them from the default online-first run.
    exclude: [...configDefaults.exclude, "**/electron/_offline/**"],
  },
});
