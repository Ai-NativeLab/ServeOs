import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants, tenantSettings } from "./schema";
import {
  getVatRate, setVatRate, getTenantSettings, getWhatsappNumber, setWhatsappNumber,
  requestPlanUpgrade, getUpgradeRequest, getCheckoutPricing, setServiceChargeRate,
  getShiftPolicy, getAllowNegativeStock, setAllowNegativeStock,
} from "./settings";
import { InvalidWhatsappNumberError } from "./errors";
import type { VerticalId } from "@/server/verticals";

async function makeTenant(slug: string, country = "EG", vertical: VerticalId = "restaurant") {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country, vertical }).returning();
  return t;
}

describe("tenant VAT settings", () => {
  it("defaults to 14 for EG and 15 for SA when unset", async () => {
    const eg = await makeTenant("vat-eg", "EG");
    const sa = await makeTenant("vat-sa", "SA");
    expect(await getVatRate(eg.id)).toBe(14);
    expect(await getVatRate(sa.id)).toBe(15);
  });
  it("setVatRate overrides the default and persists", async () => {
    const t = await makeTenant("vat-set", "EG");
    await setVatRate(t.id, 10);
    expect(await getVatRate(t.id)).toBe(10);
    expect((await getTenantSettings(t.id)).vatRate).toBe(10);
  });
});

describe("tenant WhatsApp settings", () => {
  it("defaults to no WhatsApp number", async () => {
    const t = await makeTenant("wa-default");
    expect(await getWhatsappNumber(t.id)).toBeNull();
  });

  it("sets and retrieves a valid E.164 number", async () => {
    const t = await makeTenant("wa-set");
    await setWhatsappNumber(t.id, "+201234567890");
    expect(await getWhatsappNumber(t.id)).toBe("+201234567890");
  });

  it("rejects a number without international formatting", async () => {
    const t = await makeTenant("wa-invalid");
    await expect(setWhatsappNumber(t.id, "01234567890")).rejects.toBeInstanceOf(InvalidWhatsappNumberError);
  });

  it("clearing the number removes it", async () => {
    const t = await makeTenant("wa-clear");
    await setWhatsappNumber(t.id, "+201234567890");
    await setWhatsappNumber(t.id, null);
    expect(await getWhatsappNumber(t.id)).toBeNull();
  });

  it("setting WhatsApp doesn't clobber an existing VAT rate", async () => {
    const t = await makeTenant("wa-vat-coexist");
    await setVatRate(t.id, 12);
    await setWhatsappNumber(t.id, "+201234567890");
    expect(await getVatRate(t.id)).toBe(12);
    expect(await getWhatsappNumber(t.id)).toBe("+201234567890");
  });
});

describe("tenant checkout pricing", () => {
  it("defaults for a restaurant tenant: VAT on at the country rate, prices exclusive, no service charge", async () => {
    const t = await makeTenant("pricing-restaurant-defaults", "EG", "restaurant");
    expect(await getCheckoutPricing(t.id)).toEqual({
      vatEnabled: true,
      vatRate: 14,
      pricesIncludeVat: false,
      serviceChargeRate: 0,
    });
  });

  it("zeroes the service charge for a retail tenant even when a rate is stored (capability gate)", async () => {
    const t = await makeTenant("pricing-retail-gated", "EG", "retail");
    await setServiceChargeRate(t.id, 12);
    const pricing = await getCheckoutPricing(t.id);
    expect(pricing.serviceChargeRate).toBe(0);
  });
});

describe("setServiceChargeRate validation", () => {
  it("rejects a rate below 0", async () => {
    const t = await makeTenant("sc-negative");
    await expect(setServiceChargeRate(t.id, -1)).rejects.toThrow();
  });

  it("rejects a rate above 100", async () => {
    const t = await makeTenant("sc-over-100");
    await expect(setServiceChargeRate(t.id, 101)).rejects.toThrow();
  });

  it("clears the stored value when passed null", async () => {
    const t = await makeTenant("sc-clear");
    await setServiceChargeRate(t.id, 15);
    expect((await getTenantSettings(t.id)).serviceChargeRate).toBe(15);
    await setServiceChargeRate(t.id, null);
    expect((await getTenantSettings(t.id)).serviceChargeRate).toBeUndefined();
  });
});

describe("tenant shift policy", () => {
  it("defaults to an open (non-blind) close with no thresholds", async () => {
    const t = await makeTenant("shift-policy-default");
    expect(await getShiftPolicy(t.id)).toEqual({
      blindClose: false,
      payoutThreshold: 0,
      varianceThreshold: 0,
    });
  });

  it("round-trips a stored policy", async () => {
    const t = await makeTenant("shift-policy-stored");
    await withTenant(t.id, (tx) =>
      tx.insert(tenantSettings).values({
        tenantId: t.id,
        data: { shiftPolicy: { blindClose: true, payoutThreshold: 500, varianceThreshold: 20 } },
      }),
    );
    expect(await getShiftPolicy(t.id)).toEqual({
      blindClose: true,
      payoutThreshold: 500,
      varianceThreshold: 20,
    });
  });

  it("fills in defaults for a partially stored policy", async () => {
    const t = await makeTenant("shift-policy-partial");
    await withTenant(t.id, (tx) =>
      tx.insert(tenantSettings).values({ tenantId: t.id, data: { shiftPolicy: { blindClose: true } } }),
    );
    expect(await getShiftPolicy(t.id)).toEqual({
      blindClose: true,
      payoutThreshold: 0,
      varianceThreshold: 0,
    });
  });
});

describe("allowNegativeStock policy", () => {
  it("defaults allowNegativeStock true for restaurant, false for retail", async () => {
    const r = await makeTenant("stock-neg-restaurant", "EG", "restaurant");
    const s = await makeTenant("stock-neg-retail", "EG", "retail");
    expect(await getAllowNegativeStock(r.id)).toBe(true);
    expect(await getAllowNegativeStock(s.id)).toBe(false);
  });

  it("an explicit override wins over the vertical default", async () => {
    const s = await makeTenant("stock-neg-override", "EG", "retail");
    await setAllowNegativeStock(s.id, true);
    expect(await getAllowNegativeStock(s.id)).toBe(true);
  });

  it("passing null clears the override, reverting to the vertical default", async () => {
    const s = await makeTenant("stock-neg-clear", "EG", "retail");
    await setAllowNegativeStock(s.id, true);
    await setAllowNegativeStock(s.id, null);
    expect(await getAllowNegativeStock(s.id)).toBe(false);
  });
});

describe("tenant plan upgrade requests", () => {
  it("has no upgrade request by default", async () => {
    const t = await makeTenant("upgrade-default");
    expect(await getUpgradeRequest(t.id)).toBeNull();
  });

  it("records the requested plan and a timestamp", async () => {
    const t = await makeTenant("upgrade-request");
    await requestPlanUpgrade(t.id, "pro");
    const req = await getUpgradeRequest(t.id);
    expect(req?.planKey).toBe("pro");
    expect(typeof req?.requestedAt).toBe("string");
  });
});
