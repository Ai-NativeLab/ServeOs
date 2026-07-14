import { describe, it, expect } from "vitest";
import { computeOrderTotals, type CheckoutPricing, computeLineTotal, computeCartTotals } from "./order-totals";

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

const pricing = { vatEnabled: true, vatRate: 14, pricesIncludeVat: false, serviceChargeRate: 10 };

describe("computeLineTotal", () => {
  it("subtracts the line discount", () => {
    expect(computeLineTotal({ unitPrice: 100, quantity: 2, discountAmount: 50 })).toBe(150);
  });

  it("treats a missing discount as zero", () => {
    expect(computeLineTotal({ unitPrice: 100, quantity: 2 })).toBe(200);
  });

  it("never returns a negative line", () => {
    expect(computeLineTotal({ unitPrice: 100, quantity: 1, discountAmount: 500 })).toBe(0);
  });
});

describe("computeCartTotals", () => {
  it("applies discounts before service charge and VAT", () => {
    // subtotal 200 - 50 line - 50 order = 100
    // service charge 10% = 10 -> taxable 110 -> VAT 14% = 15.4 -> total 125.4
    const t = computeCartTotals(
      pricing,
      [{ unitPrice: 100, quantity: 2, discountAmount: 50 }],
      50,
    );
    expect(t.subtotal).toBe(100);
    expect(t.discountAmount).toBe(100);
    expect(t.serviceChargeAmount).toBe(10);
    expect(t.vatAmount).toBe(15.4);
    expect(t.total).toBe(125.4);
  });

  it("matches computeOrderTotals exactly when there are no discounts", () => {
    const lines = [{ unitPrice: 100, quantity: 2 }];
    const cart = computeCartTotals(pricing, lines, 0);
    const order = computeOrderTotals(pricing, 200, 0);
    expect(cart.total).toBe(order.total);
    expect(cart.vatAmount).toBe(order.vatAmount);
    expect(cart.serviceChargeAmount).toBe(order.serviceChargeAmount);
  });

  it("clamps an order discount larger than the subtotal to zero, never negative", () => {
    const t = computeCartTotals(pricing, [{ unitPrice: 100, quantity: 1 }], 500);
    expect(t.subtotal).toBe(0);
    expect(t.total).toBe(0);
  });
});
