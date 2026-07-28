import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getMigrationStatus, type MigrationStatus } from "./migration-status";

/**
 * Migrate, then verify — the pair that must never come apart.
 *
 * drizzle reports success even when it skipped a migration whose timestamp
 * predates the newest ledger row, so "migrate returned" is not evidence the
 * schema is correct. Every caller (the CLI and the release step) goes through
 * here so neither can forget the second half.
 */
export async function migrateAndVerify(migrationsFolder = "drizzle"): Promise<MigrationStatus> {
  const { db, pool } = await import("./client");
  await migrate(db, { migrationsFolder: `./${migrationsFolder}` });
  const status = await getMigrationStatus(pool, migrationsFolder);
  await pool.end();
  return status;
}
