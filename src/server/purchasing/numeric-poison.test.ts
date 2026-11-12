import { describe, it, expect } from "vitest";
import { pool } from "@/db/client";
import { NUMERIC_RULES } from "./numeric-audit";
import { seedPurchasingTenant, rowIdFor } from "./test-helpers";

/**
 * Pins the Postgres NaN semantics that `./numeric-audit.ts` depends on. This
 * exists because the obvious test is WRONG and the wrong version looks
 * completely reasonable in review.
 *
 * IEEE 754 says NaN != NaN, so `NOT (x = x)` is the canonical NaN test in most
 * languages. Postgres breaks that for BOTH `numeric` and `float8`: it defines
 * NaN as EQUAL to NaN and greater than every non-NaN value, so the types can
 * be sorted and B-tree indexed.
 *
 * The consequence is severe and silent: an audit written with `NOT (x = x)`
 * returns zero rows against a database full of NaN and reads as a clean bill of
 * health. If someone "simplifies" the audit's literal-set predicate back to the
 * IEEE form, these tests fail loudly instead.
 */
describe("postgres numeric poison predicates", () => {
  const POISON = ["NaN", "Infinity", "-Infinity"] as const;

  it.each(POISON)("treats '%s' as equal to itself, so the IEEE NaN test never fires", async (v) => {
    const { rows: [r] } = await pool.query<{ eq: boolean; ieee: boolean; floatIeee: boolean }>(
      `SELECT ($1::numeric = $1::numeric) AS eq, NOT ($1::numeric = $1::numeric) AS ieee,
              NOT ($1::float8 = $1::float8) AS "floatIeee"`, [v],
    );
    expect(r.eq).toBe(true);
    // The trap: this is the test that "obviously" finds NaN, and it finds nothing.
    expect(r.ieee).toBe(false);
    // Not a `numeric` quirk: float8 behaves the same way.
    expect(r.floatIeee).toBe(false);
  });

  it("the literal-set predicate catches every poison value and no legitimate one", async () => {
    const { rows } = await pool.query<{ value: string; flagged: boolean }>(
      `SELECT v::text AS value, (v IN ('NaN','Infinity','-Infinity')) AS flagged
         FROM (VALUES ('NaN'::numeric),('Infinity'),('-Infinity'),
                      ('0'),('1.5'),('-4'),('0.0035'),('99999999.99')) t(v)`,
    );
    const flagged = rows.filter((r) => r.flagged).map((r) => r.value);
    const clean = rows.filter((r) => !r.flagged).map((r) => r.value);

    expect(flagged.sort()).toEqual(["-Infinity", "Infinity", "NaN"]);
    expect(clean.sort()).toEqual(["-4", "0", "0.0035", "1.5", "99999999.99"]);
  });

  it("stores all three poison literals in every audited purchasing column", async () => {
    // The premise of the whole audit: these are storable in the REAL columns,
    // not rejected by the type or a constraint. Each write is made as the app
    // role under RLS and rolled back. If a future migration adds a CHECK that
    // makes them unstorable, this fails and that column's non-finite check can
    // be retired.
    const { tenantId, rowSets: [set] } = await seedPurchasingTenant(1);
    for (const rule of NUMERIC_RULES) {
      for (const v of POISON) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
          const { rows } = await client.query<{ stored: string }>(
            `UPDATE ${rule.table} SET ${rule.column} = $1::numeric WHERE id = $2 RETURNING ${rule.column}::text AS stored`,
            [v, rowIdFor(set, rule.table)],
          );
          expect(rows, `${rule.table}.${rule.column} = ${v}`).toEqual([{ stored: v }]);
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      }
    }
  });
});
