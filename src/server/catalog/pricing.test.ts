import { describe, it, expect } from "vitest";
import { computeEffectivePrice, type ProductDiscountInput } from "./pricing";

describe("computeEffectivePrice", () => {
  const baseProduct: ProductDiscountInput = {
    basePrice: 100,
    salePrice: null,
    discountPercent: null,
    discountStartsAt: null,
    discountEndsAt: null,
    discountActive: false,
  };

  it("returns base price when discount is inactive", () => {
    const result = computeEffectivePrice(baseProduct);
    expect(result).toEqual({
      effectivePrice: 100,
      originalPrice: 100,
      discountPercent: null,
      hasDiscount: false,
    });
  });

  it("returns base price when discountActive is false even if salePrice/percent are set", () => {
    const result = computeEffectivePrice({
      ...baseProduct,
      salePrice: 80,
      discountPercent: 20,
      discountActive: false,
    });
    expect(result).toEqual({
      effectivePrice: 100,
      originalPrice: 100,
      discountPercent: null,
      hasDiscount: false,
    });
  });

  it("computes percentage discount when discountActive is true", () => {
    const result = computeEffectivePrice({
      ...baseProduct,
      discountPercent: 20,
      discountActive: true,
    });
    expect(result).toEqual({
      effectivePrice: 80,
      originalPrice: 100,
      discountPercent: 20,
      hasDiscount: true,
    });
  });

  it("computes fixed sale price discount when discountActive is true", () => {
    const result = computeEffectivePrice({
      ...baseProduct,
      salePrice: 75,
      discountActive: true,
    });
    expect(result).toEqual({
      effectivePrice: 75,
      originalPrice: 100,
      discountPercent: 25,
      hasDiscount: true,
    });
  });

  it("prefers explicit salePrice over percentage discount when both are provided", () => {
    const result = computeEffectivePrice({
      ...baseProduct,
      salePrice: 60,
      discountPercent: 20,
      discountActive: true,
    });
    expect(result).toEqual({
      effectivePrice: 60,
      originalPrice: 100,
      discountPercent: 40,
      hasDiscount: true,
    });
  });

  it("handles string numeric inputs from Postgres columns cleanly", () => {
    const result = computeEffectivePrice({
      basePrice: "150.00",
      salePrice: "120.00",
      discountActive: true,
    });
    expect(result).toEqual({
      effectivePrice: 120,
      originalPrice: 150,
      discountPercent: 20,
      hasDiscount: true,
    });
  });

  describe("scheduled validity dates", () => {
    const startsAt = new Date("2026-09-01T00:00:00Z");
    const endsAt = new Date("2026-09-10T23:59:59Z");

    const promo: ProductDiscountInput = {
      basePrice: 200,
      discountPercent: 25,
      discountActive: true,
      discountStartsAt: startsAt,
      discountEndsAt: endsAt,
    };

    it("is inactive before start date", () => {
      const before = new Date("2026-08-31T23:59:59Z");
      const result = computeEffectivePrice(promo, before);
      expect(result.hasDiscount).toBe(false);
      expect(result.effectivePrice).toBe(200);
    });

    it("is active between start and end date", () => {
      const during = new Date("2026-09-05T12:00:00Z");
      const result = computeEffectivePrice(promo, during);
      expect(result.hasDiscount).toBe(true);
      expect(result.effectivePrice).toBe(150);
      expect(result.discountPercent).toBe(25);
    });

    it("is inactive after end date", () => {
      const after = new Date("2026-09-11T00:00:00Z");
      const result = computeEffectivePrice(promo, after);
      expect(result.hasDiscount).toBe(false);
      expect(result.effectivePrice).toBe(200);
    });
  });

  describe("edge cases & invalid inputs", () => {
    it("falls back to base price if salePrice is greater than or equal to basePrice", () => {
      const result = computeEffectivePrice({
        basePrice: 100,
        salePrice: 120,
        discountActive: true,
      });
      expect(result.hasDiscount).toBe(false);
      expect(result.effectivePrice).toBe(100);
    });

    it("falls back to base price if salePrice is zero or negative", () => {
      const result = computeEffectivePrice({
        basePrice: 100,
        salePrice: 0,
        discountActive: true,
      });
      expect(result.hasDiscount).toBe(false);
      expect(result.effectivePrice).toBe(100);
    });

    it("falls back to base price if discountPercent is invalid (<=0 or >=100)", () => {
      expect(computeEffectivePrice({ basePrice: 100, discountPercent: 0, discountActive: true }).hasDiscount).toBe(false);
      expect(computeEffectivePrice({ basePrice: 100, discountPercent: 100, discountActive: true }).hasDiscount).toBe(false);
      expect(computeEffectivePrice({ basePrice: 100, discountPercent: -10, discountActive: true }).hasDiscount).toBe(false);
    });

    it("rounds decimal prices accurately to 2 decimal places", () => {
      const result = computeEffectivePrice({
        basePrice: 99.99,
        discountPercent: 33,
        discountActive: true,
      });
      // 99.99 * 0.67 = 66.9933 -> 66.99
      expect(result.effectivePrice).toBe(66.99);
      expect(result.originalPrice).toBe(99.99);
      expect(result.discountPercent).toBe(33);
      expect(result.hasDiscount).toBe(true);
    });
  });
});
