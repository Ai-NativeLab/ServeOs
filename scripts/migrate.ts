import { config } from "dotenv";

config({ path: process.env.ENV_FILE ?? ".env.local", override: true });

async function main() {
  // Dynamic import is intentional: static imports are hoisted before the dotenv
  // config() call above, which would make client.ts throw on its DATABASE_URL check.
  // migrateAndVerify pairs the migrate with its verification — drizzle reports
  // success even when it silently skipped one, so the second half is not optional.
  const { migrateAndVerify } = await import("../src/db/run-migrations");
  const { formatMigrationStatus } = await import("../src/db/migration-status");
  const status = await migrateAndVerify(process.env.MIGRATIONS_DIR ?? "drizzle");

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
