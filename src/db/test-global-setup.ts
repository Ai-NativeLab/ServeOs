import { config } from "dotenv";
import { existsSync } from "node:fs";

config({ path: ".env.test", override: true, quiet: true });

export default async function globalSetup() {
  if (!existsSync("./drizzle/meta/_journal.json")) return;
  // Dynamic import is intentional: static imports are hoisted before the dotenv
  // config() call above, which would make client.ts throw on its DATABASE_URL check.
  const { pool } = await import("./client");

  // Whole runs are serialized on the database. Isolation is TRUNCATE-based, so
  // two concurrent runs (a second terminal, an IDE watcher, overlapping CI
  // jobs) truncate each other's seeds mid-test and fail with FK violations that
  // look like real bugs. The advisory lock is session-scoped: this client stays
  // open for the entire run, a second runner blocks here until the first
  // finishes, and a crashed run releases the lock with its dying session.
  const lockHolder = await pool.connect();
  await lockHolder.query("SELECT pg_advisory_lock(hashtext('serveos_test_runner'))");

  const { applyMigrations } = await import("./run-migrations");
  await applyMigrations(pool, "drizzle");

  return async () => {
    await lockHolder.query("SELECT pg_advisory_unlock(hashtext('serveos_test_runner'))");
    lockHolder.release();
    await pool.end();
  };
}
