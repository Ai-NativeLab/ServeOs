import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { catalogVersions } from "./schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Bumps the tenant's catalog version by 1, ON THE CALLER'S TRANSACTION — same
 * shape as recordAuditEvent (audit/service.ts): never opens its own
 * transaction, so the bump commits or rolls back atomically with the
 * mutation it describes. Upserts because the counter starts at 1 on a
 * tenant's first-ever catalog write, not 0.
 *
 * Deliberately kept out of AUDITED_SERVICE_FILES (audit/coverage.ts): this is
 * infrastructure alongside a mutation's own audit event, not a domain event
 * itself — the same reasoning that exempts audit/service.ts.
 */
export async function bumpCatalogVersion(tenantId: string, tx: Tx): Promise<number> {
  const [row] = await tx
    .insert(catalogVersions)
    .values({ tenantId, version: 1 })
    .onConflictDoUpdate({
      target: catalogVersions.tenantId,
      set: { version: sql`${catalogVersions.version} + 1` },
    })
    .returning({ version: catalogVersions.version });
  return row.version;
}

/** Current version, or 0 if this tenant's catalog has never been bumped.
 *  RLS-scoped read for the catalog route; opens its own transaction since a
 *  plain read never participates in a mutation's transaction. */
export async function getCatalogVersion(tenantId: string): Promise<number> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select({ version: catalogVersions.version }).from(catalogVersions)
      .where(eq(catalogVersions.tenantId, tenantId)).limit(1),
  );
  return row?.version ?? 0;
}
