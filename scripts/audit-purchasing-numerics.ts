/**
 * Read-only: does this database carry purchasing numerics that no shipped code
 * path can repair? Answers issue #166.
 *
 *   ENV_FILE=.env.production npm run db:audit:purchasing
 *   ENV_FILE=.env.test npm run db:audit:purchasing        # will find nothing; a fresh DB has no history
 *
 * PR #161 closed the paths that WRITE bad numerics. It repaired no existing row.
 * Three classes can be sitting in the database from before those fixes:
 *
 *   1. supplier_items.last_unit_cost = 'NaN' / 'Infinity'
 *      Defused at read (checkReorder falls back to 0 and logs), but the row
 *      stays poisoned and the item silently drafts at zero forever.
 *
 *   2. purchase_order_lines.unit_cost = 'NaN' / 'Infinity'
 *      Defused at read (postReceipt rejects it) — which means such a PO line is
 *      now PERMANENTLY UNRECEIVABLE: a 400 with no UI path to re-cost it.
 *
 *   3. purchase_orders.total disagreeing with its own lines.
 *      NOT repaired anywhere. `updateDraftPo` recomputes a draft's header and
 *      checkReorder's merge branch repairs a draft it merges into, but nothing
 *      touches a PO at `sent` or beyond. Those headers are frozen at whatever
 *      the pre-#156 code stored, and each one puts a permanent phantom delta on
 *      `receivedVsOrdered` in the three-way match.
 *
 * Postgres `numeric` accepts the literals 'NaN', 'Infinity' and '-Infinity',
 * which is why any of this is representable.
 *
 * DO NOT reach for the IEEE-754 NaN test `NOT (x = x)` here. Postgres
 * deliberately breaks IEEE for `numeric` so the type can be sorted and B-tree
 * indexed: it defines NaN AS EQUAL TO NaN, and greater than every non-NaN
 * value. So `NOT (x = x)` is false for EVERY numeric including NaN — the test
 * never fires, and an audit built on it reports a clean bill of health for a
 * database full of poison. Verified directly against Postgres:
 *
 *      value    | x = x  | NOT (x = x) | x IN ('NaN','Infinity','-Infinity')
 *     ----------+--------+-------------+-------------------------------------
 *      NaN      | true   | false  <--- | true
 *      Infinity | true   | false       | true
 *      1.5      | true   | false       | false
 *
 * The literal-set test below is the one that works. It is also why the drift
 * query cannot use `x = x` as a stand-in for "is finite".
 *
 * RLS: purchase_orders, purchase_order_lines and supplier_items are all
 * FORCE ROW LEVEL SECURITY with a `tenant_id = current_setting('app.tenant_id')`
 * policy, so a plain cross-tenant SELECT sees ZERO rows and would report a
 * clean bill of health for a database full of poison. This script refuses to
 * let that happen: it iterates tenants with `app.tenant_id` set, counts the rows
 * it could actually see, and exits non-zero rather than reporting CLEAN off a
 * census of zero.
 *
 * Exits 1 if anything is found, so it can gate a release.
 */
import { config } from "dotenv";

config({ path: process.env.ENV_FILE ?? ".env.local", override: true, quiet: true });

/** Money is 2dp; a header is "drifted" only beyond a rounding cent. */
const DRIFT_EPSILON = "0.01";

type Row = Record<string, unknown>;
type Finding = { label: string; rows: Row[] };
/** Runs one SQL statement inside whatever RLS scope the caller established. */
type Query = (sql: string, params?: unknown[]) => Promise<Row[]>;

async function main() {
  const { pool } = await import("../src/db/client");
  const env = process.env.ENV_FILE ?? ".env.local";

  // Can this role see past RLS on its own? A BYPASSRLS/superuser role can audit
  // cross-tenant in one pass; the app's own role cannot and must iterate.
  const { rows: [role] } = await pool.query<{ bypass: boolean; who: string }>(
    `SELECT rolbypassrls AS bypass, current_user AS who
       FROM pg_roles WHERE rolname = current_user`,
  );
  const bypass = role?.bypass ?? false;

  const { rows: tenants } = await pool.query<{ id: string; name: string | null }>(
    `SELECT id, name FROM tenants ORDER BY created_at`,
  );

  console.log(`${env} — auditing as ${role?.who ?? "?"} (bypassrls: ${bypass})`);
  console.log(`${tenants.length} tenant(s) on this database\n`);

  if (!bypass && tenants.length === 0) {
    console.error(
      "REFUSING TO REPORT: no tenants found and this role does not bypass RLS, so\n" +
      "every purchasing table is invisible. A clean result here would be a lie.",
    );
    await pool.end();
    process.exit(1);
  }

  const findings: Finding[] = [];
  const scanned = { pos: 0, lines: 0, supplierItems: 0 };

  /**
   * Runs `fn` once per tenant with `app.tenant_id` set, or once unscoped when
   * the role bypasses RLS. Each tenant gets its own transaction so `set_config`
   * stays transaction-local and cannot leak between iterations.
   */
  async function forEachScope<T>(fn: (q: Query) => Promise<T>): Promise<T[]> {
    if (bypass) {
      return [await fn(async (sql, params) => (await pool.query<Row>(sql, params)).rows)];
    }
    const out: T[] = [];
    for (const t of tenants) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [t.id]);
        out.push(await fn(async (sql, params) => (await client.query<Row>(sql, params)).rows));
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    }
    return out;
  }

  // --- Visibility census. A zero finding is only meaningful if this is non-zero.
  await forEachScope(async (q) => {
    scanned.pos += Number((await q(`SELECT count(*)::int AS n FROM purchase_orders`))[0].n);
    scanned.lines += Number((await q(`SELECT count(*)::int AS n FROM purchase_order_lines`))[0].n);
    scanned.supplierItems += Number((await q(`SELECT count(*)::int AS n FROM supplier_items`))[0].n);
  });

  // --- 1. Poisoned supplier costs.
  const supplierPoison = (await forEachScope((q) => q(
    `SELECT tenant_id, item_id, supplier_id, last_unit_cost::text AS last_unit_cost
       FROM supplier_items
      WHERE last_unit_cost IS NOT NULL
        AND last_unit_cost IN ('NaN', 'Infinity', '-Infinity')`,
  ))).flat();
  if (supplierPoison.length) findings.push({ label: "supplier_items.last_unit_cost is NaN/Infinity", rows: supplierPoison });

  // --- 2. Poisoned ordered costs. These make a PO line unreceivable.
  const linePoison = (await forEachScope((q) => q(
    `SELECT l.tenant_id, l.po_id, l.id AS line_id, po.po_number, po.status,
            l.unit_cost::text AS unit_cost
       FROM purchase_order_lines l
       JOIN purchase_orders po ON po.id = l.po_id
      WHERE l.unit_cost IN ('NaN', 'Infinity', '-Infinity')`,
  ))).flat();
  if (linePoison.length) findings.push({ label: "purchase_order_lines.unit_cost is NaN/Infinity (PO line is UNRECEIVABLE)", rows: linePoison });

  // --- 3. Poisoned headers.
  const headerPoison = (await forEachScope((q) => q(
    `SELECT tenant_id, id, po_number, status, total::text AS total
       FROM purchase_orders
      WHERE total IN ('NaN', 'Infinity', '-Infinity')`,
  ))).flat();
  if (headerPoison.length) findings.push({ label: "purchase_orders.total is NaN/Infinity", rows: headerPoison });

  // --- 4. Headers that disagree with their own lines (the pre-#156 drift).
  //     Tax-inclusive, matching service.ts's `lineTotal`. Only finite rows are
  //     compared — a NaN header is already reported above, and NaN arithmetic
  //     would swallow it here. `status` is carried because it decides whether a
  //     repair path exists at all: a draft is fixable by editing it, anything
  //     later is frozen.
  const drift = (await forEachScope((q) => q(
    `SELECT po.tenant_id, po.id, po.po_number, po.status, po.total::text AS stored_total,
            round(SUM(l.qty_ordered * l.unit_cost * (1 + COALESCE(l.tax_rate, 0))), 2)::text AS from_lines
       FROM purchase_orders po
       JOIN purchase_order_lines l ON l.po_id = po.id
      WHERE po.total       NOT IN ('NaN', 'Infinity', '-Infinity')
        AND l.unit_cost    NOT IN ('NaN', 'Infinity', '-Infinity')
        AND l.qty_ordered  NOT IN ('NaN', 'Infinity', '-Infinity')
      GROUP BY po.tenant_id, po.id, po.po_number, po.status, po.total
     HAVING abs(round(SUM(l.qty_ordered * l.unit_cost * (1 + COALESCE(l.tax_rate, 0))), 2) - po.total) > $1::numeric
      ORDER BY abs(round(SUM(l.qty_ordered * l.unit_cost * (1 + COALESCE(l.tax_rate, 0))), 2) - po.total) DESC`,
    [DRIFT_EPSILON],
  ))).flat();
  if (drift.length) findings.push({ label: `purchase_orders.total disagrees with its own lines by > ${DRIFT_EPSILON}`, rows: drift });

  await pool.end();

  // --- Report.
  console.log("scanned (rows actually VISIBLE to this audit):");
  console.log(`  purchase_orders       ${scanned.pos}`);
  console.log(`  purchase_order_lines  ${scanned.lines}`);
  console.log(`  supplier_items        ${scanned.supplierItems}\n`);

  if (scanned.pos === 0 && scanned.lines === 0 && scanned.supplierItems === 0) {
    console.error(
      "REFUSING TO REPORT: the audit saw zero purchasing rows across every tenant.\n" +
      "Either this database genuinely has no purchasing data, or RLS hid all of it.\n" +
      "Do not record this as a clean result — verify with a role that can read the tables.",
    );
    process.exit(1);
  }

  if (!findings.length) {
    console.log("CLEAN — no poisoned or drifted purchasing numerics found.");
    console.log("This is a real result: the census above proves the rows were visible.");
    return;
  }

  for (const f of findings) {
    console.log(`\n=== ${f.label} — ${f.rows.length} row(s) ===`);
    console.table(f.rows.slice(0, 50));
    if (f.rows.length > 50) console.log(`  ... and ${f.rows.length - 50} more`);
  }

  const frozen = drift.filter((r) => r.status !== "draft" && r.status !== "cancelled");
  if (frozen.length) {
    console.log(
      `\n${frozen.length} drifted header(s) are past 'draft' and have NO repair path in shipped code.` +
      `\nThese need the one-off repair script described in issue #166.`,
    );
  }

  console.log(`\n${findings.reduce((n, f) => n + f.rows.length, 0)} row(s) need attention. See issue #166.`);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
