import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  retries: process.env.CI ? 2 : 0,
  // Spec files share one mutable seeded database (offline-payment enables a
  // payment method and creates orders that ordering/scheduling/dashboard
  // specs render), so CI must run them serially. Locally the default
  // parallelism stays — dev runs target a disposable dev DB.
  workers: process.env.CI ? 1 : undefined,
  use: {
    baseURL: "http://localhost:3000",
    trace: process.env.CI ? "on-first-retry" : "off",
  },
  webServer: {
    // CI runs `npm run build` as its own job step first (a build failure
    // should be its own red step, not a webServer timeout).
    command: process.env.CI ? "npm run start" : "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
