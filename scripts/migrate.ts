import { config } from "dotenv";
import { migrate } from "drizzle-orm/node-postgres/migrator";

config({ path: process.env.ENV_FILE ?? ".env.local", override: true });

async function main() {
  // Dynamic import is intentional: static imports are hoisted before the dotenv
  // config() call above, which would make client.ts throw on its DATABASE_URL check.
  const { db, pool } = await import("../src/db/client");
  await migrate(db, { migrationsFolder: "./drizzle" });

  // Then VERIFY. drizzle decides what to run from a single high-water mark, so
  // it reports success even when it skipped a migration whose timestamp predates
  // the newest ledger row — and it will skip that one on every future run too.
  // Silence here used to mean "the schema is fine"; it meant nothing.
  const { getMigrationStatus, formatMigrationStatus } = await import("../src/db/migration-status");
  const status = await getMigrationStatus(pool);
  await pool.end();

  if (status.pending.length) {
    console.error(formatMigrationStatus(status));
    console.error("\nERROR: migrations ran, but the schema is INCOMPLETE (see above).");
    process.exit(1);
  }
  console.log(formatMigrationStatus(status));
  console.log("migrations applied");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
