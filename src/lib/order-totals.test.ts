import { describe, it, expect } from "vitest";
import { computeOrderTotals, type CheckoutPricing } from "./order-totals";

const base: CheckoutPricing = { vatEnabled: true, vatRate: 14, pricesIncludeVat: false, serviceChargeRate: 0 };

describe("computeOrderTotals", () => {
  it("matches today's computation with default settings (exclusive VAT, no service charge)", () => {
    const t = computeOrderTotals(base, 200, 25);
    expect(t).toEqual({ subtotal: 200, serviceChargeAmount: 0, vatRate: 14, vatAmount: 28, vatIncludedInPrices: false, deliveryFee: 25, total: 253 });
  });

  it("applies service charge before VAT (restaurant)", () => {
    const t = computeOrderTotals({ ...base, serviceChargeRate: 12 }, 100, 0);
    expect(t.serviceChargeAmount).toBe(12);
    expect(t.vatAmount).toBe(15.68); // 14% of 112
    expect(t.total).toBe(127.68);
  });

  it("inclusive VAT extracts an informational amount without changing the total", () => {
    const t = computeOrderTotals({ ...base, pricesIncludeVat: true }, 114, 10);
    expect(t.vatAmount).toBe(14); // 114 * 14/114
    expect(t.vatIncludedInPrices).toBe(true);
    expect(t.total).toBe(124); // subtotal + fee, VAT already inside
  });

  it("vatEnabled=false charges no VAT", () => {
    const t = computeOrderTotals({ ...base, vatEnabled: false }, 100, 0);
    expect(t.vatAmount).toBe(0);
    expect(t.vatRate).toBe(0);
    expect(t.total).toBe(100);
  });

  it("rounds each line to 2dp and lines sum to total", () => {
    const t = computeOrderTotals(base, 33.335, 0);
    expect(t.subtotal + t.serviceChargeAmount + t.vatAmount).toBeCloseTo(t.total, 10);
  });
});
