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
      // Parens must be escaped: tinyglobby reads (marketing) as an extglob
      // group, and silently matches ZERO files rather than erroring.
      "src/app/\\(marketing\\)/**/*.test.ts",
      // Named files, not a glob: src/server/demo/**/ also swept in
      // session.test.ts, which needs a live database, so `npm run test:unit`
      // failed 6 tests before it ever reached anything pure.
      "src/server/demo/entry.test.ts",
      "src/server/demo/images.test.ts",
      "src/app/subscribe/**/*.test.ts",
      "src/app/register/**/*.test.ts",
      "src/app/_components/**/*.test.ts",
      "src/app/dashboard/**/*.test.ts",
      "src/server/catalog/pricing.test.ts",
    ],
    env: { NODE_ENV: "test" },
  },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
