import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globalSetup: ["./src/db/test-global-setup.ts"],
    setupFiles: ["./src/db/test-setup.ts"],
    fileParallelism: false,
    env: { NODE_ENV: "test" },
  },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
