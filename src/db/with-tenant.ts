import { sql } from "drizzle-orm";
import { db } from "./client";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Runs `fn` inside a transaction with the Postgres session var `app.tenant_id`
 * set (transaction-local), so every query inside is constrained by RLS policies
 * to that tenant. Outside withTenant, RLS fails closed: no rows are visible.
 */
export async function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T> | T): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
