import { eq } from "drizzle-orm";
import { db } from "@/db/client";
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

/** tenants is a control table → plain db, same as createTenant. */
export async function updateTenantProfile(tenantId: string, input: UpdateTenantProfileInput): Promise<Tenant> {
  const [row] = await db.update(tenants).set(input).where(eq(tenants.id, tenantId)).returning();
  if (!row) throw new Error(`Tenant not found: ${tenantId}`);
  return row;
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
