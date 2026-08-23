import { describe, it, expect } from "vitest";
import { pool } from "@/db/client";

/**
 * Pins the Postgres `numeric` NaN semantics that `scripts/audit-purchasing-numerics.ts`
 * depends on. This exists because the obvious test is WRONG and the wrong version
 * looks completely reasonable in review.
 *
 * IEEE 754 says NaN != NaN, so `NOT (x = x)` is the canonical NaN test in most
 * languages and for Postgres `float8`. Postgres `numeric` deliberately breaks
 * that — it defines NaN as EQUAL to NaN and greater than every non-NaN value,
 * so the type can be sorted and B-tree indexed.
 *
 * The consequence is severe and silent: an audit written with `NOT (x = x)`
 * returns zero rows against a database full of NaN and reads as a clean bill of
 * health. If someone "simplifies" the audit's literal-set predicate back to the
 * IEEE form, these tests fail loudly instead.
 */
describe("postgres numeric poison predicates", () => {
  const POISON = ["NaN", "Infinity", "-Infinity"] as const;

  it.each(POISON)("treats '%s' as equal to itself, so the IEEE NaN test never fires", async (v) => {
    const { rows: [r] } = await pool.query<{ eq: boolean; ieee: boolean }>(
      `SELECT ($1::numeric = $1::numeric) AS eq, NOT ($1::numeric = $1::numeric) AS ieee`, [v],
    );
    expect(r.eq).toBe(true);
    // The trap: this is the test that "obviously" finds NaN, and it finds nothing.
    expect(r.ieee).toBe(false);
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

  it("accepts all three poison literals into a numeric column at all", async () => {
    // The premise of the whole audit: these are storable, not rejected by the
    // type. If a future migration adds a CHECK constraint that makes them
    // unstorable, this fails and the audit can be retired.
    for (const v of POISON) {
      const { rows: [r] } = await pool.query<{ stored: string }>(
        `SELECT $1::numeric::text AS stored`, [v],
      );
      expect(r.stored).toBe(v);
    }
  });
});
