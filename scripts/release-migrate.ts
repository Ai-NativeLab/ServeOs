/**
 * The release step: applies migrations during a PRODUCTION Vercel build, before
 * the new deployment is ever activated.
 *
 * Why here and not after the deploy: Vercel activates a deployment the moment
 * its build succeeds. Anything that runs afterwards is racing live traffic
 * against a schema that has not caught up — which is exactly how production
 * ended up serving code that expected columns the database did not have. A
 * failed migration fails the build, so a broken schema never serves a request.
 *
 * Preview and development builds SKIP this deliberately: preview deployments
 * typically share the production database, so migrating from a feature branch
 * would apply unshipped schema to production.
 */
import { config } from "dotenv";

// A no-op on Vercel (no env file); locally it lets the script be exercised.
config({ path: process.env.ENV_FILE ?? ".env.local", override: false, quiet: true });

async function main() {
  const target = process.env.VERCEL_ENV;

  // Kept in src/db so the rule is unit-tested — this branch is the only thing
  // stopping a pull request from migrating production.
  const { shouldReleaseMigrate } = await import("../src/db/release-guard");
  if (!shouldReleaseMigrate(target)) {
    console.log(`release-migrate: VERCEL_ENV=${target ?? "unset"} — skipping migrations (production only).`);
    return;
  }

  if (!process.env.DATABASE_URL) {
    console.error(
      "release-migrate: VERCEL_ENV=production but DATABASE_URL is not set at BUILD time.\n" +
      "Vercel environment variables marked Sensitive are runtime-only and invisible to the\n" +
      "build. Expose DATABASE_URL to the build (Project Settings -> Environment Variables),\n" +
      "or migrations cannot run here.",
    );
    process.exit(1);
  }

  const { migrateAndVerify } = await import("../src/db/run-migrations");
  const { formatMigrationStatus } = await import("../src/db/migration-status");

  const status = await migrateAndVerify();
  console.log(formatMigrationStatus(status));

  if (status.pending.length) {
    console.error("\nrelease-migrate: schema is INCOMPLETE after migrating — failing the build.");
    process.exit(1);
  }
  console.log("release-migrate: production schema is up to date.");
}

main().catch((e) => {
  console.error("release-migrate: FAILED — the build is stopped so a broken schema cannot ship.");
  console.error(e);
  process.exit(1);
});
