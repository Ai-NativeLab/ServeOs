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
    // sync.ts/sync.test.ts still test the old parked SyncEngine (order_outbox
    // + postOrder), superseded by the local_events-driven engine Task 10
    // builds. Leave them out until that rewrite lands; everything else under
    // _offline (db/store/reducer, Task 8) runs for real against better-sqlite3.
    exclude: [...configDefaults.exclude, "**/electron/_offline/sync.test.ts"],
  },
});
