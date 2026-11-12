import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import {
  etaDeviceChains,
  etaPosCredentials,
  etaSubmissions,
  etaTenantConfig,
} from "@/server/fiscal/schema";
import { isDemoSlug } from "./entry";

/**
 * Drops ONE demo tenant (and, through `onDelete: cascade`, everything it owns)
 * so the nightly reset can re-seed it from scratch. Returns whether a tenant
 * with that slug existed.
 *
 * THE FISCAL ROWS GO FIRST, BY HAND, AND ONLY HERE. The ETA tables keep their
 * statutory-retention guards: `eta_submissions.order_id` / `.refund_id` and
 * `eta_device_chains.device_id` / `eta_tenant_config.online_device_id` are
 * `ON DELETE RESTRICT` (migrations 0048/0049), so deleting an order, refund or
 * POS device that a fiscal record names is refused — which is exactly right for
 * a real taxpayer, whose documents must outlive any cleanup. It also means a
 * bare `DELETE FROM tenants` fails for any EG demo tenant a visitor rang a sale
 * on: the cascade reaches `orders` before `eta_submissions`, and RESTRICT checks
 * immediately. A demo tenant files nothing real (it is never ETA-activated), so
 * its fiscal rows are clutter, not records, and are deleted explicitly — inside
 * the tenant's own RLS context (the tables are FORCE RLS) — before the tenant.
 *
 * Refuses any slug that is not `demo-…`: this is a destructive path reachable
 * from a scheduled workflow, and it must be impossible to point at a real
 * tenant.
 */
export async function dropDemoTenant(slug: string): Promise<boolean> {
  if (!isDemoSlug(slug)) {
    throw new Error(`refusing to reset "${slug}" — only demo- tenants may be dropped`);
  }
  const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug)).limit(1);
  if (!tenant) return false;

  await withTenant(tenant.id, async (tx) => {
    await tx.delete(etaSubmissions).where(eq(etaSubmissions.tenantId, tenant.id));
    await tx.delete(etaDeviceChains).where(eq(etaDeviceChains.tenantId, tenant.id));
    await tx.delete(etaPosCredentials).where(eq(etaPosCredentials.tenantId, tenant.id));
    await tx.delete(etaTenantConfig).where(eq(etaTenantConfig.tenantId, tenant.id));
  });
  await db.delete(tenants).where(eq(tenants.id, tenant.id));
  return true;
}
