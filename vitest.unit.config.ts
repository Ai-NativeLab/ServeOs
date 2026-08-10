import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Pure-logic tests only — no globalSetup, no DB truncation harness.
 * The default vitest.config.ts still runs everything, including these.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/marketing-locale.test.ts",
      "src/proxy.test.ts",
      "src/app/\\(marketing\\)/**/*.test.ts",
      "src/server/demo/**/*.test.ts",
    ],
    env: { NODE_ENV: "test" },
  },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
