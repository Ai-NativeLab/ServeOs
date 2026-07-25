import { describe, it, expect } from "vitest";
import { computeOrderTotals } from "@shared/order-totals";
import { addLine, removeLine, changeQty, cartTotals, type CartLine } from "./cart";

const pricing = { vatEnabled: true, vatRate: 14, pricesIncludeVat: false, serviceChargeRate: 10 };
const line = (over: Partial<CartLine> = {}): CartLine => ({
  productId: "p1", name: "Margherita", quantity: 1, selectedOptionIds: [], unitPrice: 100, ...over,
});

describe("cart", () => {
  it("merges an identical line instead of duplicating it", () => {
    const out = addLine([line()], line());
    expect(out).toHaveLength(1);
    expect(out[0].quantity).toBe(2);
  });

  it("removes a line", () => {
    expect(removeLine([line()], 0)).toHaveLength(0);
  });

  it("removes the line when quantity drops to zero", () => {
    expect(changeQty([line()], 0, 0)).toHaveLength(0);
  });
});

describe("cartTotals parity", () => {
  it("agrees with the server's computeOrderTotals for an undiscounted cart", () => {
    const totals = cartTotals(pricing, [line({ quantity: 2 })], 0);
    const server = computeOrderTotals(pricing, 200, 0);
    expect(totals.total).toBe(server.total);
  });

  it("applies a line discount before tax", () => {
    const totals = cartTotals(pricing, [line({ quantity: 2, discountAmount: 50 })], 0);
    // 200 - 50 = 150 -> +10% svc = 165 -> +14% VAT = 188.1
    expect(totals.subtotal).toBe(150);
    expect(totals.total).toBe(188.1);
  });
});
