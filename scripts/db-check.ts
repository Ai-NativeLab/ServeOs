/**
 * Read-only: does this database have every migration this branch expects?
 *
 *   npm run db:check                        # .env.local
 *   ENV_FILE=.env.test npm run db:check     # any other environment
 *
 * Auditing an environment that runs DIFFERENT code (e.g. production on `main`
 * while you are on a feature branch) needs that branch's migrations, or this
 * will report your unshipped ones as missing:
 *
 *   git archive origin/main drizzle | tar -x -C /tmp/main-code
 *   ENV_FILE=.env.production MIGRATIONS_DIR=/tmp/main-code/drizzle npm run db:check
 *
 * Exits 1 if anything on disk has not been applied, so it can gate a deploy.
 */
import { config } from "dotenv";

config({ path: process.env.ENV_FILE ?? ".env.local", override: true, quiet: true });

async function main() {
  const { pool } = await import("../src/db/client");
  const { getMigrationStatus, formatMigrationStatus, findUnjournaledMigrations } =
    await import("../src/db/migration-status");

  const migrationsDir = process.env.MIGRATIONS_DIR ?? "drizzle";
  const status = await getMigrationStatus(pool, migrationsDir);
  await pool.end();

  console.log(`${process.env.ENV_FILE ?? ".env.local"} (migrations: ${migrationsDir})`);
  console.log(formatMigrationStatus(status));

  // Reported separately because it cannot be reported above: a migration the
  // journal does not list never enters the status report at all.
  const unjournaled = findUnjournaledMigrations(migrationsDir);
  if (unjournaled.length) {
    console.error(
      [
        "",
        `${unjournaled.length} migration file(s) are not listed in ${migrationsDir}/meta/_journal.json,`,
        "so nothing will ever apply them:",
        ...unjournaled.map((tag) => `    ${tag}.sql`),
      ].join("\n"),
    );
  }

  if (status.pending.length || unjournaled.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
