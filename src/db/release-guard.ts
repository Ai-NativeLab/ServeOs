/**
 * Decides whether a Vercel build is allowed to migrate the database.
 *
 * Preview deployments share the production DATABASE_URL, so a build that
 * migrated from a feature branch would apply unshipped schema to production
 * before review — a pull request would silently become a release.
 *
 * Fails closed: only the exact string "production" qualifies. An unrecognised,
 * renamed or newly added Vercel environment is treated as not-production, so
 * the failure mode is "migrations did not run" rather than "a PR migrated
 * production".
 */
export function shouldReleaseMigrate(vercelEnv: string | undefined): boolean {
  return vercelEnv === "production";
}
