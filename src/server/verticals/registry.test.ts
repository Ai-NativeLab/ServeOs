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

  it("restaurant: modifiers on, variants/stock off, menu template", () => {
    const caps = getCapabilities("restaurant");
    expect(caps).toEqual({ modifiers: true, variants: false, stockTracking: false, serviceCharge: true });
    expect(getVerticalDescriptor("restaurant").storefront.template).toBe("menu");
  });

  it("retail, pharmacy, timber: variants/stock on, modifiers off, shop template", () => {
    for (const key of ["retail", "pharmacy", "timber"] as VerticalId[]) {
      const caps = getCapabilities(key);
      expect(caps, key).toEqual({ modifiers: false, variants: true, stockTracking: true, serviceCharge: false });
      expect(getVerticalDescriptor(key).storefront.template, key).toBe("shop");
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

  it("only the restaurant shows the WhatsApp CTA", () => {
    (Object.keys(VERTICAL_STOREFRONT_COPY) as VerticalId[]).forEach((v) => {
      expect(VERTICAL_STOREFRONT_COPY[v].showWhatsapp).toBe(v === "restaurant");
    });
  });

  it("selectStorefrontTemplate falls back to restaurant for unknown values", () => {
    expect(selectStorefrontTemplate("retail")).toBe("retail");
    expect(selectStorefrontTemplate(null)).toBe("restaurant");
    expect(selectStorefrontTemplate("bogus" as VerticalId)).toBe("restaurant");
  });
});
