import { sql } from "drizzle-orm";
import type { db } from "@/db/client";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * True iff a table exists in the public schema. Lets a report over a
 * not-yet-shipped spec's tables return empty instead of raising
 * "relation does not exist" — sections degrade independently, which is
 * what lets Spec 10 ship ahead of Specs 3/7/8/9.
 */
export async function tableExists(tx: Tx, name: string): Promise<boolean> {
  const { rows } = await tx.execute<{ reg: string | null }>(sql`SELECT to_regclass(${`public.${name}`}) AS reg`);
  return rows[0]?.reg != null;
}
