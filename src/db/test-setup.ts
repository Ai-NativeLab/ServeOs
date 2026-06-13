import { config } from "dotenv";
import { afterAll, beforeEach } from "vitest";

config({ path: ".env.test", override: true });

beforeEach(async () => {
  // Dynamic import is intentional: static imports are hoisted before the dotenv
  // config() call above, which would make client.ts throw on its DATABASE_URL check.
  const { truncateAll } = await import("./test-harness");
  await truncateAll();
});

afterAll(async () => {
  const { pool } = await import("./client");
  await pool.end();
});
