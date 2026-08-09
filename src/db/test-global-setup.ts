import { config } from "dotenv";
import { existsSync } from "node:fs";

config({ path: ".env.test", override: true, quiet: true });

export default async function globalSetup() {
  if (!existsSync("./drizzle/meta/_journal.json")) return;
  // Dynamic import is intentional: static imports are hoisted before the dotenv
  // config() call above, which would make client.ts throw on its DATABASE_URL check.
  const { pool } = await import("./client");
  const { applyMigrations } = await import("./run-migrations");
  await applyMigrations(pool, "drizzle");
  await pool.end();
}
