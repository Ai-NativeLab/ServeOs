/**
 * Scheduled Spec 9 reorder sweep.
 *
 * Iterates every ACTIVE tenant and runs `checkReorder` for it, so low-stock
 * rules notify the owner + manager and pre-fill draft POs on a schedule instead
 * of only when someone hits `POST /api/inventory/reorder/check` from a browser.
 * The manual route is the same function with an interactive actor; this script
 * is the cron body with a per-tenant system actor.
 *
 * The system actor resolves the tenant's first branch (by sortOrder, exactly as
 * `resolvePurchasingActor` does for an interactive request) and its owner user
 * (roles.key = 'owner'), because draft POs carry `created_by_user_id` — a real,
 * tenant-local user must back the sweep or the FK would reject the insert.
 *
 * Debounce and idempotence live inside `checkReorder` (24h lastAlertedAt skip,
 * rules with no supplier emit no PO), so a re-run or an overlapping schedule
 * cannot duplicate alerts or draft POs.
 *
 * Run: ENV_FILE=.env.local npx tsx scripts/reorder-check.ts
 */
import { config } from "dotenv";

config({ path: process.env.ENV_FILE ?? ".env.local", override: true, quiet: true });

import { and, eq, asc } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { roles, userRoles } from "@/server/auth/schema";
import { checkReorder } from "@/server/purchasing/reorder";
import type { PurchasingActor } from "@/server/purchasing/suppliers";
import type { VerticalId } from "@/server/verticals/types";

export type ReorderCheckReport = {
  tenantId: string;
  triggered: number;
  draftsCreated: number;
};

export async function checkTenantReorder(tenantId: string): Promise<ReorderCheckReport> {
  return withTenant(tenantId, async (tx) => {
    const [branch] = await tx.select({ id: branches.id })
      .from(branches).where(eq(branches.tenantId, tenantId))
      .orderBy(asc(branches.sortOrder)).limit(1);
    const [t] = await tx.select({ vertical: tenants.vertical })
      .from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    const [owner] = await tx.select({ userId: userRoles.userId })
      .from(userRoles).innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(and(eq(roles.tenantId, tenantId), eq(roles.key, "owner"))).limit(1);
    if (!owner || !branch) {
      return { tenantId, triggered: 0, draftsCreated: 0 };
    }
    const actor: PurchasingActor = {
      tenantId,
      branchId: branch.id,
      actorUserId: owner.userId,
      vertical: (t?.vertical ?? "restaurant") as VerticalId,
    };
    const run = await checkReorder(actor);
    return { tenantId, ...run };
  });
}

async function main(): Promise<void> {
  const active = await db.select({ id: tenants.id, slug: tenants.slug })
    .from(tenants).where(eq(tenants.status, "active")).orderBy(asc(tenants.slug));

  let alerts = 0;
  let drafts = 0;
  for (const t of active) {
    const r = await checkTenantReorder(t.id);
    alerts += r.triggered;
    drafts += r.draftsCreated;
    console.log(`${t.slug}: ${r.triggered} triggered, ${r.draftsCreated} draft PO(s)`);
  }
  console.log(`\nreorder check complete — ${alerts} item(s) below reorder point, ${drafts} draft PO(s) across ${active.length} active tenant(s)`);
}

// Only run when invoked directly, so the test suite can import checkTenantReorder.
if (process.argv[1]?.includes("reorder-check")) {
  main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}