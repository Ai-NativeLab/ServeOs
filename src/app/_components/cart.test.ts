import { describe, it, expect } from "vitest";
import { cartSubtotal, mergeLine, withLineQuantity, type Cart, type CartLine } from "./cart";

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

const line = (over: Partial<CartLine> = {}): CartLine => ({
  productId: "p1", nameEn: "A", nameAr: "أ", quantity: 1, unitPrice: 100,
  selectedOptionIds: [], modifierSummaryEn: "", ...over,
});

describe("mergeLine", () => {
  it("merges identical product + options (order-insensitive) by adding quantities", () => {
    const cart: Cart = { branchId: "b1", lines: [line({ selectedOptionIds: ["o1", "o2"], quantity: 2 })] };
    const next = mergeLine(cart, "b1", line({ selectedOptionIds: ["o2", "o1"], quantity: 1 }));
    expect(next.lines).toHaveLength(1);
    expect(next.lines[0].quantity).toBe(3);
  });
  it("keeps different option sets as separate lines", () => {
    const cart: Cart = { branchId: "b1", lines: [line({ selectedOptionIds: ["o1"] })] };
    const next = mergeLine(cart, "b1", line({ selectedOptionIds: [] }));
    expect(next.lines).toHaveLength(2);
  });
  it("resets the cart when the branch changes", () => {
    const cart: Cart = { branchId: "b1", lines: [line()] };
    const next = mergeLine(cart, "b2", line({ productId: "p9" }));
    expect(next.branchId).toBe("b2");
    expect(next.lines).toHaveLength(1);
    expect(next.lines[0].productId).toBe("p9");
  });
});

describe("withLineQuantity", () => {
  it("sets a line's quantity", () => {
    const cart: Cart = { branchId: null, lines: [line({ quantity: 1 })] };
    expect(withLineQuantity(cart, 0, 4).lines[0].quantity).toBe(4);
  });
  it("removes the line at quantity 0", () => {
    const cart: Cart = { branchId: null, lines: [line()] };
    expect(withLineQuantity(cart, 0, 0).lines).toHaveLength(0);
  });
  it("ignores an out-of-range index", () => {
    const cart: Cart = { branchId: null, lines: [line()] };
    expect(withLineQuantity(cart, 5, 2).lines).toHaveLength(1);
  });
});

describe("variant-aware merge", () => {
  const line = (productId: string, variantId?: string): CartLine => ({
    productId, variantId, variantNameEn: variantId ? "35mm" : undefined,
    nameEn: "Hinge", nameAr: "مفصلة", quantity: 1, unitPrice: 55,
    selectedOptionIds: [], modifierSummaryEn: "",
  });

  it("merges same product + same variant", () => {
    const c1 = mergeLine({ branchId: null, lines: [] }, "b1", line("p1", "v1"));
    const c2 = mergeLine(c1, "b1", line("p1", "v1"));
    expect(c2.lines.length).toBe(1);
    expect(c2.lines[0].quantity).toBe(2);
  });

  it("keeps different variants of the same product as separate lines", () => {
    const c1 = mergeLine({ branchId: null, lines: [] }, "b1", line("p1", "v1"));
    const c2 = mergeLine(c1, "b1", line("p1", "v2"));
    expect(c2.lines.length).toBe(2);
  });

  it("keeps a variant line separate from a no-variant line (legacy cart compat)", () => {
    const c1 = mergeLine({ branchId: null, lines: [] }, "b1", line("p1"));
    const c2 = mergeLine(c1, "b1", line("p1", "v1"));
    expect(c2.lines.length).toBe(2);
  });
});
