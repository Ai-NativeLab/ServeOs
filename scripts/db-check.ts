/**
 * Read-only: does this database have every migration this branch expects?
 *
 *   npm run db:check                        # .env.local
 *   ENV_FILE=.env.test npm run db:check     # any other environment
 *
 * Exits 1 if anything on disk has not been applied, so it can gate a deploy.
 */
import { config } from "dotenv";

config({ path: process.env.ENV_FILE ?? ".env.local", override: true });

async function main() {
  const { pool } = await import("../src/db/client");
  const { getMigrationStatus, formatMigrationStatus } = await import("../src/db/migration-status");

  const status = await getMigrationStatus(pool);
  await pool.end();

  console.log(`${process.env.ENV_FILE ?? ".env.local"}: ${formatMigrationStatus(status)}`);
  if (status.pending.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
