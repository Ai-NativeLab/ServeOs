import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { recordAuditEvent, type AuditActorInput } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { tenants, type NewTenant, type Tenant } from "./schema";

const RESERVED = new Set(["app", "admin", "www", "api"]);

export async function createTenant(
  input: Pick<NewTenant, "slug" | "name" | "country"> & Partial<NewTenant>,
): Promise<Tenant> {
  const currency = input.country === "SA" ? "SAR" : "EGP";
  const timezone = input.country === "SA" ? "Asia/Riyadh" : "Africa/Cairo";
  const [row] = await db
    .insert(tenants)
    .values({ ...input, currency, timezone })
    .returning();
  return row;
}

export type UpdateTenantProfileInput = Partial<
  Pick<Tenant, "name" | "logoUrl" | "coverImageUrl" | "primaryColor" | "defaultLocale" | "timezone" | "tagline" | "cuisine">
>;

/** tenants is a control table (no RLS); the withTenant wrap is for the audit
 *  insert's app.tenant_id — the profile update itself is unaffected. */
export async function updateTenantProfile(tenantId: string, input: UpdateTenantProfileInput, audit?: AuditActorInput): Promise<Tenant> {
  return withTenant(tenantId, async (tx) => {
    const [before] = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    const [row] = await tx.update(tenants).set(input).where(eq(tenants.id, tenantId)).returning();
    if (!row) throw new Error(`Tenant not found: ${tenantId}`);
    const ctx = { tenantId, actorUserId: audit?.actorUserId ?? null, fingerprint: audit?.fingerprint ?? emptyFingerprint() };
    await recordAuditEvent(ctx, {
      action: "settings.profile_updated", entityType: "tenant", entityId: tenantId,
      summary: `Profile updated`, metadata: { roleKey: audit?.roleKey ?? null }, actorType: audit?.actorType,
    }, tx);
    const themeChanged = before && (
      (input.logoUrl !== undefined && input.logoUrl !== before.logoUrl) ||
      (input.coverImageUrl !== undefined && input.coverImageUrl !== before.coverImageUrl) ||
      (input.primaryColor !== undefined && input.primaryColor !== before.primaryColor)
    );
    if (themeChanged) {
      await recordAuditEvent(ctx, {
        action: "settings.theme_changed", entityType: "tenant", entityId: tenantId,
        summary: `Theme updated`,
        metadata: {
          before: { logoUrl: before!.logoUrl, coverImageUrl: before!.coverImageUrl, primaryColor: before!.primaryColor },
          after: { logoUrl: row.logoUrl, coverImageUrl: row.coverImageUrl, primaryColor: row.primaryColor },
          roleKey: audit?.roleKey ?? null,
        },
        actorType: audit?.actorType,
      }, tx);
    }
    return row;
  });
}

/** Extracts the subdomain slug from a host, or null if it's the root / reserved host. */
export function subdomainFromHost(host: string, rootDomain: string): string | null {
  const h = host.split(":")[0].toLowerCase();
  if (h === rootDomain) return null;
  if (!h.endsWith(`.${rootDomain}`)) return null;
  const sub = h.slice(0, -(`.${rootDomain}`.length));
  if (!sub || sub.includes(".") || RESERVED.has(sub)) return null;
  return sub;
}

export async function resolveTenantByHost(host: string, rootDomain: string): Promise<Tenant | null> {
  const slug = subdomainFromHost(host, rootDomain);
  if (!slug) return null;
  const [row] = await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
  return row ?? null;
}

export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  const [row] = await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
  return row ?? null;
}

export async function getTenantById(id: string): Promise<Tenant | null> {
  const [row] = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
  return row ?? null;
}

export function isTenantServable(tenant: { status: string }): boolean {
  return tenant.status === "active" || tenant.status === "trial";
}
