import type { Pool, PoolClient } from "pg";

/**
 * Read-only audit: does this database carry purchasing numerics that no
 * shipped code path can repair? Answers issue #166. `scripts/audit-purchasing-numerics.ts`
 * is the CLI; this module is the logic, so the "cannot report a false clean"
 * claim is covered by numeric-audit.test.ts against a real database.
 *
 * PR #161 closed the paths that WRITE bad numerics. It repaired no existing
 * row. Two kinds of bad value can be sitting in the database from before then:
 *
 *   - NON-FINITE. Postgres `numeric` accepts the literals 'NaN', 'Infinity' and
 *     '-Infinity'. A poisoned `purchase_order_lines.unit_cost` makes the line
 *     permanently unreceivable (postReceipt rejects it); a poisoned
 *     `supplier_items.last_unit_cost` silently drafts at 0 forever (checkReorder
 *     falls back); a poisoned `qty_ordered` breaks `receiptStatus` and the
 *     header total.
 *   - OUT OF RANGE. Finite, but a value every shipped write path now rejects
 *     (a negative cost, a zero ordered quantity, a tax rate stored as a
 *     percentage). See each rule's `why` for the code that defines legality.
 *
 * Plus one relation between columns:
 *
 *   - DRIFT. `purchase_orders.total` disagreeing with its own lines. Nothing
 *     repairs a PO past `draft`, so each such header is a permanent phantom
 *     delta on `receivedVsOrdered` in the three-way match.
 *
 * NaN TEST. Do not reach for the IEEE-754 test `NOT (x = x)`. Postgres defines
 * NaN as EQUAL to NaN — for `numeric` AND for `float8` — and greater than every
 * non-NaN value, so the types can be sorted and B-tree indexed. `NOT (x = x)`
 * is false for every value including NaN; an audit built on it reports clean
 * for a database full of poison. The literal-set test (`x IN ('NaN',
 * 'Infinity', '-Infinity')`) is the one that works, and numeric-poison.test.ts
 * pins that. It is also why range checks below exclude non-finite values
 * first: NaN compares greater than everything, so `NaN > 1` is TRUE.
 *
 * RLS. Every purchasing table is FORCE ROW LEVEL SECURITY with a
 * `tenant_id = current_setting('app.tenant_id')` policy, so a plain
 * cross-tenant SELECT by the app role sees ZERO rows. The audit iterates
 * tenants with `app.tenant_id` set (or runs once unscoped for a superuser /
 * BYPASSRLS role), counts the rows it could actually see, and REFUSES to
 * report clean off a census of zero.
 */

/** The literal set that identifies a non-finite `numeric`. See the module docstring. */
const NON_FINITE = `('NaN', 'Infinity', '-Infinity')`;

/** Money is 2dp; a header is "drifted" from one whole cent up. */
export const DRIFT_EPSILON = "0.01";

/**
 * Every tenant-scoped purchasing table. The census counts each one, and the
 * schema guard below insists that every `numeric` column in them has a rule.
 */
export const PURCHASING_TABLES = [
  "suppliers",
  "supplier_items",
  "purchase_orders",
  "purchase_order_lines",
  "po_receipts",
  "po_receipt_lines",
  "reorder_rules",
] as const;
export type PurchasingTable = (typeof PURCHASING_TABLES)[number];

export type NumericRule = {
  table: PurchasingTable;
  column: string;
  /**
   * SQL predicate over `v` (the column, finite and non-null) that is TRUE when
   * the value is illegal. Non-finite values are checked separately and never
   * reach this.
   */
  illegalWhen: string;
  /** Human-readable form of `illegalWhen`, for the report. */
  legalRange: string;
  /** Where in shipped code the legal range is defined. */
  why: string;
};

/**
 * Every `numeric` column in the purchasing tables, and what a legal value is.
 * `checkSchemaCoverage` fails the audit if the live schema has a numeric
 * column that is not listed here, so a new column cannot be silently skipped.
 */
export const NUMERIC_RULES: readonly NumericRule[] = [
  {
    table: "supplier_items", column: "last_unit_cost",
    illegalWhen: "v < 0", legalRange: ">= 0",
    why: "suppliers.ts upsertSupplierItem floors it; reorder.ts treats < 0 as poison and prices the line at 0",
  },
  {
    table: "purchase_orders", column: "total",
    illegalWhen: "v < 0", legalRange: ">= 0",
    why: "service.ts lineTotal sums lines whose qty > 0, cost >= 0 and tax in [0, 1]",
  },
  {
    table: "purchase_orders", column: "invoice_total",
    illegalWhen: "v < 0", legalRange: ">= 0",
    why: "variance.ts enterInvoiceTotal rejects < 0",
  },
  {
    table: "purchase_order_lines", column: "qty_ordered",
    illegalWhen: "v <= 0", legalRange: "> 0",
    why: "service.ts assertLineNumbers/snapQuantities reject <= 0; a zero line reports itself fully received",
  },
  {
    table: "purchase_order_lines", column: "unit_cost",
    illegalWhen: "v < 0", legalRange: ">= 0",
    why: "service.ts assertLineNumbers rejects < 0; receiving.ts postReceipt refuses to receive it",
  },
  {
    table: "purchase_order_lines", column: "tax_rate",
    illegalWhen: "v < 0 OR v > 1", legalRange: "0..1 (a fraction, not a percentage)",
    why: "service.ts assertLineNumbers: a fraction; 14 for 14% multiplies the line by 15",
  },
  {
    table: "purchase_order_lines", column: "qty_received",
    illegalWhen: "v < 0", legalRange: ">= 0",
    why: "receiving.ts only ever adds a positive received quantity to a 0 default",
  },
  {
    table: "po_receipt_lines", column: "received_qty",
    illegalWhen: "v <= 0", legalRange: "> 0",
    why: "receiving.ts postReceipt rejects a received quantity that stores as <= 0",
  },
  {
    table: "po_receipt_lines", column: "unit_cost",
    illegalWhen: "v < 0", legalRange: ">= 0",
    why: "receiving.ts copies the ordered line's cost and rejects < 0",
  },
  {
    table: "reorder_rules", column: "reorder_point",
    illegalWhen: "v < 0", legalRange: ">= 0",
    why: "reorder.ts assertRuleNumbers rejects < 0",
  },
  {
    table: "reorder_rules", column: "reorder_qty",
    illegalWhen: "v <= 0", legalRange: "> 0",
    why: "reorder.ts assertRuleNumbers rejects <= 0; it becomes an auto-drafted line's qty_ordered",
  },
];

/** Extra columns reported alongside a bad row, so an operator can find it in the UI. */
const CONTEXT: Record<PurchasingTable, string> = {
  suppliers: "",
  supplier_items: ", t.supplier_id, t.item_id",
  purchase_orders: ", t.po_number, t.status",
  purchase_order_lines: ", t.po_id, (SELECT po_number FROM purchase_orders p WHERE p.id = t.po_id) AS po_number, (SELECT status FROM purchase_orders p WHERE p.id = t.po_id) AS status",
  po_receipts: "",
  po_receipt_lines: ", t.po_line_id, t.po_receipt_id",
  reorder_rules: ", t.item_id, t.location_id",
};

export type Row = Record<string, unknown>;

export type FindingKind = "non_finite" | "out_of_range" | "drift" | "unaudited_column";

export type Finding = {
  /** Stable id, e.g. `purchase_order_lines.qty_ordered:non_finite` or `purchase_orders.total:drift`. */
  check: string;
  kind: FindingKind;
  label: string;
  rows: Row[];
};

export type AuditResult = {
  /**
   * `clean` only when every check ran over a non-zero census and found nothing.
   * `refused` whenever the audit cannot vouch for what it saw, regardless of findings.
   */
  status: "clean" | "findings" | "refused";
  role: string;
  bypass: boolean;
  tenantCount: number;
  /** Rows actually VISIBLE to the audit, per purchasing table. */
  scanned: Record<PurchasingTable, number>;
  findings: Finding[];
  refusal: string | null;
};

/** Runs one SQL statement inside whatever RLS scope the caller established. */
type Query = (sql: string, params?: unknown[]) => Promise<Row[]>;

/** The subset of `pg.Pool` the audit uses. */
export type AuditPool = Pick<Pool, "query" | "connect">;

export function nonFiniteSql(rule: NumericRule): string {
  return `SELECT t.tenant_id, t.id${CONTEXT[rule.table]}, t.${rule.column}::text AS value
            FROM ${rule.table} t
           WHERE t.${rule.column} IN ${NON_FINITE}`;
}

export function outOfRangeSql(rule: NumericRule): string {
  const predicate = rule.illegalWhen.replace(/\bv\b/g, `t.${rule.column}`);
  return `SELECT t.tenant_id, t.id${CONTEXT[rule.table]}, t.${rule.column}::text AS value
            FROM ${rule.table} t
           WHERE t.${rule.column} NOT IN ${NON_FINITE}
             AND (${predicate})`;
}

/**
 * Headers that disagree with their own lines (the pre-#156 drift).
 * Tax-inclusive, matching service.ts's `lineTotal`.
 *
 * A PO with ANY non-finite line input is excluded whole: its lines are
 * reported as non-finite findings above, and summing only its finite lines
 * would compare the header against a partial total. A PO with no lines is
 * compared against 0 (LEFT JOIN), so a header with nothing under it is caught.
 * `status` is carried because it decides whether a repair path exists at all:
 * a draft is fixable by editing it, anything later is frozen.
 */
export const DRIFT_SQL = `
  WITH per_po AS (
    SELECT po.tenant_id, po.id, po.po_number, po.status, po.total,
           round(COALESCE(SUM(l.qty_ordered * l.unit_cost * (1 + COALESCE(l.tax_rate, 0))), 0), 2) AS from_lines
      FROM purchase_orders po
      LEFT JOIN purchase_order_lines l ON l.po_id = po.id
     WHERE po.total NOT IN ${NON_FINITE}
     GROUP BY po.tenant_id, po.id, po.po_number, po.status, po.total
    HAVING bool_and(
             l.id IS NULL
             OR (    l.qty_ordered NOT IN ${NON_FINITE}
                 AND l.unit_cost   NOT IN ${NON_FINITE}
                 AND COALESCE(l.tax_rate, 0) NOT IN ${NON_FINITE}))
  )
  SELECT tenant_id, id, po_number, status, total::text AS stored_total, from_lines::text AS from_lines
    FROM per_po
   WHERE abs(from_lines - total) >= $1::numeric
   ORDER BY abs(from_lines - total) DESC`;

/**
 * Any `numeric` column on a purchasing table that has no rule. Returned as a
 * finding, so a schema change that adds one turns the audit red until the
 * column is given a legal range here.
 */
async function checkSchemaCoverage(pool: AuditPool): Promise<Row[]> {
  const { rows } = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])
        AND data_type IN ('numeric', 'real', 'double precision')
      ORDER BY table_name, column_name`,
    [[...PURCHASING_TABLES]],
  );
  const known = new Set(NUMERIC_RULES.map((r) => `${r.table}.${r.column}`));
  return rows
    .filter((r) => !known.has(`${r.table_name}.${r.column_name}`))
    .map((r) => ({ table: r.table_name, column: r.column_name }));
}

export async function runAudit(pool: AuditPool): Promise<AuditResult> {
  // Can this role see past RLS on its own? A superuser or BYPASSRLS role can
  // audit cross-tenant in one pass; the app's own role cannot and must iterate.
  const { rows: [role] } = await pool.query<{ bypass: boolean; who: string }>(
    `SELECT (rolsuper OR rolbypassrls) AS bypass, current_user AS who
       FROM pg_roles WHERE rolname = current_user`,
  );
  const bypass = role?.bypass ?? false;
  const who = role?.who ?? "?";

  const { rows: tenants } = await pool.query<{ id: string }>(`SELECT id FROM tenants ORDER BY created_at`);

  /**
   * Runs `fn` once per tenant with `app.tenant_id` set, or once unscoped when
   * the role bypasses RLS. Each tenant gets its own READ ONLY transaction so
   * `set_config` stays transaction-local and cannot leak between iterations.
   */
  async function forEachScope<T>(fn: (q: Query) => Promise<T>): Promise<T[]> {
    if (bypass) {
      return [await fn(async (sql, params) => (await pool.query<Row>(sql, params)).rows)];
    }
    const out: T[] = [];
    for (const t of tenants) {
      const client: PoolClient = await pool.connect();
      try {
        await client.query("BEGIN READ ONLY");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [t.id]);
        out.push(await fn(async (sql, params) => (await client.query<Row>(sql, params)).rows));
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        // Destroy rather than return a connection whose state is unknown.
        client.release(err as Error);
        throw err;
      }
      client.release();
    }
    return out;
  }

  const collect = async (sql: string, params?: unknown[]) =>
    (await forEachScope((q) => q(sql, params))).flat();

  // --- Visibility census. A zero finding is only meaningful if this is non-zero.
  const scanned = Object.fromEntries(PURCHASING_TABLES.map((t) => [t, 0])) as Record<PurchasingTable, number>;
  await forEachScope(async (q) => {
    for (const table of PURCHASING_TABLES) {
      scanned[table] += Number((await q(`SELECT count(*)::int AS n FROM ${table}`))[0].n);
    }
  });

  const findings: Finding[] = [];

  const unaudited = await checkSchemaCoverage(pool);
  if (unaudited.length) {
    findings.push({
      check: "schema:unaudited_column", kind: "unaudited_column",
      label: "numeric column(s) on a purchasing table with no audit rule — add them to NUMERIC_RULES",
      rows: unaudited,
    });
  }

  for (const rule of NUMERIC_RULES) {
    const col = `${rule.table}.${rule.column}`;
    const nonFinite = await collect(nonFiniteSql(rule));
    if (nonFinite.length) {
      findings.push({ check: `${col}:non_finite`, kind: "non_finite", label: `${col} is NaN/Infinity`, rows: nonFinite });
    }
    const outOfRange = await collect(outOfRangeSql(rule));
    if (outOfRange.length) {
      findings.push({
        check: `${col}:out_of_range`, kind: "out_of_range",
        label: `${col} outside ${rule.legalRange} (${rule.why})`, rows: outOfRange,
      });
    }
  }

  const drift = await collect(DRIFT_SQL, [DRIFT_EPSILON]);
  if (drift.length) {
    findings.push({
      check: "purchase_orders.total:drift", kind: "drift",
      label: `purchase_orders.total disagrees with its own lines by >= ${DRIFT_EPSILON}`, rows: drift,
    });
  }

  let refusal: string | null = null;
  if (!bypass && tenants.length === 0) {
    refusal =
      "no tenants found and this role does not bypass RLS, so every purchasing table is invisible. " +
      "A clean result here would be a lie.";
  } else if (Object.values(scanned).every((n) => n === 0)) {
    refusal =
      "the audit saw zero purchasing rows across every tenant. Either this database genuinely has no " +
      "purchasing data, or RLS hid all of it. Do not record this as a clean result; verify with a role " +
      "that can read the tables.";
  }

  return {
    status: refusal ? "refused" : findings.length ? "findings" : "clean",
    role: who, bypass, tenantCount: tenants.length, scanned, findings, refusal,
  };
}
