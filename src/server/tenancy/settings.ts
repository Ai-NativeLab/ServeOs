import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants, tenantSettings } from "./schema";
import { InvalidWhatsappNumberError } from "./errors";
import { getCapabilities } from "@/server/verticals/registry";
import type { VerticalId } from "@/server/verticals/types";
import type { CheckoutPricing } from "@/lib/order-totals";

export type TenantSettingsData = {
  vatRate?: number;
  vatEnabled?: boolean;
  pricesIncludeVat?: boolean;
  serviceChargeRate?: number;
  whatsappNumber?: string;
  upgradeRequest?: { planKey: string; requestedAt: string };
};

const E164_RE = /^\+[1-9]\d{6,14}$/;

/** tenant_settings is RLS-backed → read/write through withTenant. */
export async function getTenantSettings(tenantId: string): Promise<TenantSettingsData> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select().from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId)).limit(1),
  );
  return (row?.data as TenantSettingsData | undefined) ?? {};
}

/** Merges `patch` into the tenant's settings bag, creating the row if needed.
 * Keys set to `undefined` in `patch` are dropped from the stored JSON. */
async function patchTenantSettings(tenantId: string, patch: Partial<TenantSettingsData>): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [row] = await tx.select().from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId)).limit(1);
    const data: TenantSettingsData = { ...((row?.data as TenantSettingsData | undefined) ?? {}), ...patch };
    if (row) {
      await tx.update(tenantSettings).set({ data }).where(eq(tenantSettings.id, row.id));
    } else {
      await tx.insert(tenantSettings).values({ tenantId, data });
    }
  });
}

export async function setVatRate(tenantId: string, vatRate: number): Promise<void> {
  await patchTenantSettings(tenantId, { vatRate });
}

export function defaultVatRate(country: string): number {
  return country === "SA" ? 15 : 14;
}

/** Configured VAT rate, or the country default. tenants is a control table → plain db. */
export async function getVatRate(tenantId: string): Promise<number> {
  const settings = await getTenantSettings(tenantId);
  if (typeof settings.vatRate === "number") return settings.vatRate;
  const [t] = await db.select({ country: tenants.country }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return defaultVatRate(t?.country ?? "EG");
}

export async function getCheckoutPricing(tenantId: string): Promise<CheckoutPricing> {
  const settings = await getTenantSettings(tenantId);
  const [t] = await db.select({ country: tenants.country, vertical: tenants.vertical }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const caps = getCapabilities((t?.vertical ?? "restaurant") as VerticalId);
  return {
    vatEnabled: settings.vatEnabled ?? true,
    vatRate: typeof settings.vatRate === "number" ? settings.vatRate : defaultVatRate(t?.country ?? "EG"),
    pricesIncludeVat: settings.pricesIncludeVat ?? false,
    serviceChargeRate: caps.serviceCharge ? (settings.serviceChargeRate ?? 0) : 0,
  };
}

export async function setVatEnabled(tenantId: string, enabled: boolean): Promise<void> {
  await patchTenantSettings(tenantId, { vatEnabled: enabled });
}

export async function setPricesIncludeVat(tenantId: string, inclusive: boolean): Promise<void> {
  await patchTenantSettings(tenantId, { pricesIncludeVat: inclusive });
}

export async function setServiceChargeRate(tenantId: string, rate: number | null): Promise<void> {
  if (rate !== null && (Number.isNaN(rate) || rate < 0 || rate > 100)) throw new Error(`Invalid service charge rate: ${rate}`);
  await patchTenantSettings(tenantId, { serviceChargeRate: rate ?? undefined });
}

export async function getWhatsappNumber(tenantId: string): Promise<string | null> {
  const settings = await getTenantSettings(tenantId);
  return settings.whatsappNumber ?? null;
}

/** Pass `null` to disable click-to-chat (removes the stored number). */
export async function setWhatsappNumber(tenantId: string, number: string | null): Promise<void> {
  if (number !== null && !E164_RE.test(number)) {
    throw new InvalidWhatsappNumberError(number);
  }
  await patchTenantSettings(tenantId, { whatsappNumber: number ?? undefined });
}

export async function requestPlanUpgrade(tenantId: string, planKey: string): Promise<void> {
  await patchTenantSettings(tenantId, { upgradeRequest: { planKey, requestedAt: new Date().toISOString() } });
}

export async function getUpgradeRequest(tenantId: string): Promise<TenantSettingsData["upgradeRequest"] | null> {
  const settings = await getTenantSettings(tenantId);
  return settings.upgradeRequest ?? null;
}
