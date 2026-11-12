import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { recordAuditEvent, type AuditActorInput } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { bumpCatalogVersion } from "@/server/catalog/version";
import { tenants, tenantSettings } from "./schema";
import { InvalidWhatsappNumberError } from "./errors";
import { getCapabilities } from "@/server/verticals/registry";
import type { VerticalId } from "@/server/verticals/types";
import type { CheckoutPricing } from "@/lib/order-totals";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function auditCtx(tenantId: string, audit?: AuditActorInput) {
  return { tenantId, actorUserId: audit?.actorUserId ?? null, fingerprint: audit?.fingerprint ?? emptyFingerprint() };
}

/**
 * How this tenant runs its drawers. `blindClose` withholds expected/variance
 * from a cashier closing without `reconciliation:manage`; the thresholds are in
 * tenant currency — a pay-out above `payoutThreshold` needs a manager, and a
 * close whose |variance| exceeds `varianceThreshold` is flagged. Zero means
 * "no threshold", which is the default.
 */
export type ShiftPolicy = {
  blindClose: boolean;
  payoutThreshold: number;
  varianceThreshold: number;
};

export type TenantSettingsData = {
  vatRate?: number;
  vatEnabled?: boolean;
  pricesIncludeVat?: boolean;
  serviceChargeRate?: number;
  whatsappNumber?: string;
  upgradeRequest?: { planKey: string; requestedAt: string };
  shiftPolicy?: Partial<ShiftPolicy>;
  allowNegativeStock?: boolean;
};

const E164_RE = /^\+[1-9]\d{6,14}$/;

/** tenant_settings is RLS-backed → read/write through withTenant. */
export async function getTenantSettings(tenantId: string): Promise<TenantSettingsData> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select().from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId)).limit(1),
  );
  return (row?.data as TenantSettingsData | undefined) ?? {};
}

// The catalog response's pricing block (getCheckoutPricing) is built from
// exactly these keys — any other settings key (whatsappNumber, shiftPolicy,
// ...) is invisible to the catalog and must not move its version.
const PRICING_KEYS = ["vatRate", "vatEnabled", "pricesIncludeVat", "serviceChargeRate"] as const;

/** Merges `patch` into the tenant's settings bag on the given tx, creating the
 * row if needed. Keys set to `undefined` in `patch` are dropped from the JSON. */
async function applySettingsPatch(tx: Tx, tenantId: string, patch: Partial<TenantSettingsData>): Promise<TenantSettingsData> {
  const [row] = await tx.select().from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId)).limit(1);
  const before: TenantSettingsData = (row?.data as TenantSettingsData | undefined) ?? {};
  const data: TenantSettingsData = { ...before, ...patch };
  if (row) {
    await tx.update(tenantSettings).set({ data }).where(eq(tenantSettings.id, row.id));
  } else {
    await tx.insert(tenantSettings).values({ tenantId, data });
  }
  // Bump only when a key the catalog actually surfaces moved — a patch that
  // only touches, say, the WhatsApp number must not bump it.
  if (PRICING_KEYS.some((k) => before[k] !== data[k])) await bumpCatalogVersion(tenantId, tx);
  return before;
}

async function patchTenantSettings(tenantId: string, patch: Partial<TenantSettingsData>): Promise<void> {
  await withTenant(tenantId, (tx) => applySettingsPatch(tx, tenantId, patch));
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
export async function setWhatsappNumber(tenantId: string, number: string | null, audit?: AuditActorInput): Promise<void> {
  if (number !== null && !E164_RE.test(number)) {
    throw new InvalidWhatsappNumberError(number);
  }
  await withTenant(tenantId, async (tx) => {
    await applySettingsPatch(tx, tenantId, { whatsappNumber: number ?? undefined });
    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "settings.whatsapp_changed", entityType: "settings", entityId: "whatsapp",
      summary: number ? "WhatsApp number set" : "WhatsApp number cleared",
      metadata: { hasNumber: number !== null, roleKey: audit?.roleKey ?? null }, actorType: audit?.actorType,
    }, tx);
  });
}

export async function requestPlanUpgrade(tenantId: string, planKey: string, audit?: AuditActorInput): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await applySettingsPatch(tx, tenantId, { upgradeRequest: { planKey, requestedAt: new Date().toISOString() } });
    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "subscription.upgrade_requested", entityType: "subscription", entityId: "upgrade_request",
      summary: `Upgrade to ${planKey} requested`,
      metadata: { planKey, roleKey: audit?.roleKey ?? null }, actorType: audit?.actorType,
    }, tx);
  });
}

export type TaxSettingsPatch = {
  vatEnabled?: boolean;
  vatRate?: number;
  pricesIncludeVat?: boolean;
  serviceChargeRate?: number | null;
};

/**
 * One tax-settings write + one snapshot audit event (composing the low-level
 * setters, which are allowlisted). Emits settings.vat_changed always, and
 * settings.service_charge_changed when the service charge actually moved —
 * both carrying {before, after}.
 */
export async function updateTaxSettings(tenantId: string, patch: TaxSettingsPatch, audit?: AuditActorInput): Promise<void> {
  if (patch.serviceChargeRate !== undefined && patch.serviceChargeRate !== null &&
      (Number.isNaN(patch.serviceChargeRate) || patch.serviceChargeRate < 0 || patch.serviceChargeRate > 100)) {
    throw new Error(`Invalid service charge rate: ${patch.serviceChargeRate}`);
  }
  await withTenant(tenantId, async (tx) => {
    const before = await applySettingsPatch(tx, tenantId, {
      vatEnabled: patch.vatEnabled,
      vatRate: patch.vatRate,
      pricesIncludeVat: patch.pricesIncludeVat,
      serviceChargeRate: patch.serviceChargeRate === null ? undefined : patch.serviceChargeRate,
    });
    const after: TenantSettingsData = { ...before,
      ...(patch.vatEnabled !== undefined ? { vatEnabled: patch.vatEnabled } : {}),
      ...(patch.vatRate !== undefined ? { vatRate: patch.vatRate } : {}),
      ...(patch.pricesIncludeVat !== undefined ? { pricesIncludeVat: patch.pricesIncludeVat } : {}),
      ...(patch.serviceChargeRate !== undefined ? { serviceChargeRate: patch.serviceChargeRate ?? undefined } : {}),
    };
    const ctx = auditCtx(tenantId, audit);
    await recordAuditEvent(ctx, {
      action: "settings.vat_changed", entityType: "settings", entityId: "tax",
      summary: `VAT settings updated`,
      metadata: {
        before: before.vatRate ?? null, after: after.vatRate ?? null,
        vatEnabled: after.vatEnabled ?? null, pricesIncludeVat: after.pricesIncludeVat ?? null,
        roleKey: audit?.roleKey ?? null,
      },
      actorType: audit?.actorType,
    }, tx);
    const beforeSc = typeof before.serviceChargeRate === "number" ? before.serviceChargeRate : null;
    const afterSc = typeof after.serviceChargeRate === "number" ? after.serviceChargeRate : null;
    if (beforeSc !== afterSc) {
      await recordAuditEvent(ctx, {
        action: "settings.service_charge_changed", entityType: "settings", entityId: "service_charge",
        summary: `Service charge ${beforeSc ?? "∅"} → ${afterSc ?? "∅"}`,
        metadata: { before: beforeSc, after: afterSc, roleKey: audit?.roleKey ?? null }, actorType: audit?.actorType,
      }, tx);
    }
  });
}

export async function getUpgradeRequest(tenantId: string): Promise<TenantSettingsData["upgradeRequest"] | null> {
  const settings = await getTenantSettings(tenantId);
  return settings.upgradeRequest ?? null;
}

/** The tenant's drawer policy, with every field defaulted. */
export async function getShiftPolicy(tenantId: string): Promise<ShiftPolicy> {
  const stored = (await getTenantSettings(tenantId)).shiftPolicy;
  return {
    blindClose: stored?.blindClose ?? false,
    payoutThreshold: stored?.payoutThreshold ?? 0,
    varianceThreshold: stored?.varianceThreshold ?? 0,
  };
}

/**
 * Whether a stock shortfall at checkout may go negative instead of blocking
 * the order. An explicit per-tenant override always wins; absent one, the
 * default is derived from the vertical.
 */
export async function getAllowNegativeStock(tenantId: string): Promise<boolean> {
  const settings = await getTenantSettings(tenantId);
  if (typeof settings.allowNegativeStock === "boolean") return settings.allowNegativeStock;
  const [t] = await db.select({ vertical: tenants.vertical }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  // Restaurant kitchens are made-to-order and must never be blocked at the till.
  return (t?.vertical ?? "restaurant") === "restaurant";
}

/** Pass `null` to clear the override and revert to the vertical default. */
export async function setAllowNegativeStock(tenantId: string, value: boolean | null): Promise<void> {
  await patchTenantSettings(tenantId, { allowNegativeStock: value ?? undefined });
}
