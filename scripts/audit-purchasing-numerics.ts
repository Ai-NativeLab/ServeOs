/**
 * Read-only: does this database carry purchasing numerics that no shipped code
 * path can repair? Answers issue #166.
 *
 *   ENV_FILE=.env.production npm run db:audit:purchasing
 *
 * Thin CLI over `runAudit` in src/server/purchasing/numeric-audit.ts, which
 * holds the checks, the column list and the reasoning (NaN semantics, RLS).
 *
 * Exits 1 if anything is found OR if the audit refuses to vouch for its census
 * (no tenants, or zero visible rows), so it can gate a release. Prints CLEAN
 * only when every numeric column was checked over a non-zero census.
 */
import { config } from "dotenv";

config({ path: process.env.ENV_FILE ?? ".env.local", override: true, quiet: true });

async function main(): Promise<number> {
  const { pool } = await import("../src/db/client");
  const { runAudit, NUMERIC_RULES } = await import("../src/server/purchasing/numeric-audit");
  const env = process.env.ENV_FILE ?? ".env.local";

  let result;
  try {
    result = await runAudit(pool);
  } finally {
    await pool.end();
  }

  console.log(`${env} — audited as ${result.role} (bypasses RLS: ${result.bypass})`);
  console.log(`${result.tenantCount} tenant(s) on this database\n`);
  console.log("scanned (rows actually VISIBLE to this audit):");
  for (const [table, n] of Object.entries(result.scanned)) console.log(`  ${table.padEnd(22)} ${n}`);
  console.log(`\nchecked ${NUMERIC_RULES.length} numeric column(s) for NaN/Infinity and out-of-range values, plus header drift\n`);

  for (const f of result.findings) {
    console.log(`\n=== ${f.label} — ${f.rows.length} row(s) ===`);
    console.table(f.rows.slice(0, 50));
    if (f.rows.length > 50) console.log(`  ... and ${f.rows.length - 50} more`);
  }

  if (result.status === "refused") {
    console.error(`\nREFUSING TO REPORT CLEAN: ${result.refusal}`);
    return 1;
  }

  if (result.status === "clean") {
    console.log("CLEAN — no poisoned, out-of-range or drifted purchasing numerics found.");
    console.log("This is a real result: the census above proves the rows were visible.");
    return 0;
  }

  const drift = result.findings.find((f) => f.kind === "drift")?.rows ?? [];
  const frozen = drift.filter((r) => r.status !== "draft" && r.status !== "cancelled");
  if (frozen.length) {
    console.log(
      `\n${frozen.length} drifted header(s) are past 'draft' and have NO repair path in shipped code.` +
      `\nThese need the one-off repair script described in issue #166.`,
    );
  }

  console.log(`\n${result.findings.reduce((n, f) => n + f.rows.length, 0)} row(s) need attention. See issue #166.`);
  return 1;
}

main().then(
  (code) => { process.exitCode = code; },
  (e) => { console.error(e); process.exitCode = 1; },
);
