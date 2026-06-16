import { describe, it, expect } from "vitest";
import { cartSubtotal, type CartLine } from "./cart";

const lines: CartLine[] = [
  { productId: "p1", nameEn: "A", nameAr: "أ", quantity: 2, unitPrice: 100, selectedOptionIds: [], modifierSummaryEn: "" },
  { productId: "p2", nameEn: "B", nameAr: "ب", quantity: 1, unitPrice: 50, selectedOptionIds: [], modifierSummaryEn: "" },
];

describe("cart helpers", () => {
  it("cartSubtotal sums quantity × unitPrice", () => {
    expect(cartSubtotal(lines)).toBe(250);
  });
  it("empty cart subtotal is 0", () => {
    expect(cartSubtotal([])).toBe(0);
  });
});
