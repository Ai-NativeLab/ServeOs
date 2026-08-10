import { describe, it, expect } from "vitest";
import {
  VERTICAL_IDS, getVerticalDescriptor, getCapabilities, getVerticalTerms, requireCapability,
  VERTICAL_ACCENTS, VERTICAL_STOREFRONT_COPY, selectStorefrontTemplate, type VerticalId,
} from "./registry";
import { CapabilityNotEnabledError } from "./errors";

describe("vertical registry", () => {
  it("defines a complete descriptor for every vertical (fails when a vertical is half-added)", () => {
    expect(VERTICAL_IDS).toEqual(["restaurant", "retail", "pharmacy", "timber"]);
    for (const key of VERTICAL_IDS) {
      const d = getVerticalDescriptor(key);
      expect(d.key).toBe(key);
      expect(["menu", "shop"]).toContain(d.storefront.template);
      expect(d.accent).toMatch(/^#[0-9A-Fa-f]{6}$/);
      // every terminology label has non-empty en + ar
      for (const [term, label] of Object.entries(d.terminology)) {
        expect(label.en, `${key}.${term}.en`).toBeTruthy();
        expect(label.ar, `${key}.${term}.ar`).toBeTruthy();
      }
      // serviceCharge capability must match the declared adjustments
      expect(d.checkout.adjustments.includes("service_charge")).toBe(d.capabilities.serviceCharge);
      expect(d.checkout.adjustments.includes("vat")).toBe(true);
    }
  });

  it("restaurant: modifiers on, variants off, stock/inventory/recipes on, menu template, no P4 flags", () => {
    const caps = getCapabilities("restaurant");
    expect(caps).toEqual({
      modifiers: true, variants: false, stockTracking: true, serviceCharge: true,
      dimensionalProducts: false, unitsOfMeasure: false, tradeAccounts: false,
      prescriptionUpload: false, pharmacistReview: false, taxClasses: false,
      inventory: true, recipes: true,
    });
    expect(getVerticalDescriptor("restaurant").storefront.template).toBe("menu");
  });

  it("retail: variants/stock/inventory on, modifiers/recipes off, shop template, no P3/P4 flags", () => {
    expect(getCapabilities("retail")).toEqual({
      modifiers: false, variants: true, stockTracking: true, serviceCharge: false,
      dimensionalProducts: false, unitsOfMeasure: false, tradeAccounts: false,
      prescriptionUpload: false, pharmacistReview: false, taxClasses: false,
      inventory: true, recipes: false,
    });
    expect(getVerticalDescriptor("retail").storefront.template).toBe("shop");
  });

  it("pharmacy: shop template plus the P3 Rx flags, no P4 flags, no recipes", () => {
    expect(getCapabilities("pharmacy")).toEqual({
      modifiers: false, variants: true, stockTracking: true, serviceCharge: false,
      dimensionalProducts: false, unitsOfMeasure: false, tradeAccounts: false,
      prescriptionUpload: true, pharmacistReview: true, taxClasses: false,
      inventory: true, recipes: false,
    });
    expect(getVerticalDescriptor("pharmacy").storefront.template).toBe("shop");
  });

  it("timber: variants/stock/inventory on, modifiers/recipes off, shop template, ALL P4 flags on", () => {
    const caps = getCapabilities("timber");
    expect(caps).toEqual({
      modifiers: false, variants: true, stockTracking: true, serviceCharge: false,
      dimensionalProducts: true, unitsOfMeasure: true, tradeAccounts: true,
      prescriptionUpload: false, pharmacistReview: false, taxClasses: false,
      inventory: true, recipes: false,
    });
    expect(getVerticalDescriptor("timber").storefront.template).toBe("shop");
  });

  it("stockTracking is a strict legacy alias of inventory for every vertical", () => {
    for (const key of VERTICAL_IDS) {
      const c = getCapabilities(key);
      expect(c.stockTracking, key).toBe(c.inventory);
    }
  });

  it("recipes is restaurant-only", () => {
    for (const key of VERTICAL_IDS) {
      expect(getCapabilities(key).recipes, key).toBe(key === "restaurant");
    }
  });

  it("terminology differs where it matters", () => {
    expect(getVerticalTerms("restaurant").catalogNoun.en).toBe("Menu");
    expect(getVerticalTerms("retail").catalogNoun.en).toBe("Products");
    expect(getVerticalTerms("timber").storefrontHeading.en).toBe("Yard");
  });

  it("requireCapability throws a typed error for a disabled capability", () => {
    expect(() => requireCapability("retail", "modifiers")).toThrow(CapabilityNotEnabledError);
    expect(() => requireCapability("restaurant", "modifiers")).not.toThrow();
  });

  // ── absorbed from src/server/tenancy/verticals.test.ts ──
  it("defines the four trades with distinct accents", () => {
    expect(new Set(Object.values(VERTICAL_ACCENTS)).size).toBe(4);
  });

  it("shows the WhatsApp CTA on every vertical — the bot handles variants since Phase 2", () => {
    (Object.keys(VERTICAL_STOREFRONT_COPY) as VerticalId[]).forEach((v) => {
      expect(VERTICAL_STOREFRONT_COPY[v].showWhatsapp).toBe(true);
    });
  });

  it("selectStorefrontTemplate falls back to restaurant for unknown values", () => {
    expect(selectStorefrontTemplate("retail")).toBe("retail");
    expect(selectStorefrontTemplate(null)).toBe("restaurant");
    expect(selectStorefrontTemplate("bogus" as VerticalId)).toBe("restaurant");
  });

  it("offers WhatsApp on every vertical now that the bot handles variants", () => {
    for (const id of VERTICAL_IDS) {
      expect(getVerticalDescriptor(id).storefront.showWhatsapp).toBe(true);
    }
  });
});

describe("P4 capability flags", () => {
  it("dimensional products, UoM and trade accounts are timber-only", () => {
    for (const id of VERTICAL_IDS) {
      const caps = getCapabilities(id);
      const expected = id === "timber";
      expect(caps.dimensionalProducts).toBe(expected);
      expect(caps.unitsOfMeasure).toBe(expected);
      expect(caps.tradeAccounts).toBe(expected);
    }
  });
});

describe("P3 capability flags", () => {
  it("prescription upload and pharmacist review are pharmacy-only", () => {
    for (const id of VERTICAL_IDS) {
      const caps = getCapabilities(id);
      const expected = id === "pharmacy";
      expect(caps.prescriptionUpload, id).toBe(expected);
      expect(caps.pharmacistReview, id).toBe(expected);
      // taxClasses ships in the fast-follow — off everywhere for now.
      expect(caps.taxClasses, id).toBe(false);
    }
  });
});
