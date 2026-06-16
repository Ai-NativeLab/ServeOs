import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globalSetup: ["./src/db/test-global-setup.ts"],
    setupFiles: ["./src/db/test-setup.ts"],
    fileParallelism: false,
    // Integration tests hit a remote Supabase Postgres; the heaviest (ordering
    // checkout, which does many sequential round-trips) need headroom when the
    // network/DB is slow, so the budget is generous.
    testTimeout: 60000,
    hookTimeout: 60000,
    env: { NODE_ENV: "test" },
  },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
