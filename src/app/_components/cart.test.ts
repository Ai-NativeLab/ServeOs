import { describe, it, expect } from "vitest";
import {
  cartSubtotal,
  mergeLine,
  withLineQuantity,
  getProductQuantity,
  isProductConfigurable,
  changeSimpleProductQuantity,
  type Cart,
  type CartLine,
} from "./cart";

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

describe("dimensional merge (P4)", () => {
  const cutLine = (dims: CartLine["dimensions"]): CartLine => ({
    productId: "ply-1", nameEn: "Ply Sheet", nameAr: "أبلكاش", quantity: 1,
    unitPrice: 72, selectedOptionIds: [], modifierSummaryEn: "", dimensions: dims,
  });

  it("merges two identical cuts into one line with summed quantity", () => {
    const c1 = mergeLine({ branchId: null, lines: [] }, "b1", cutLine({ lengthMm: 2400, widthMm: 600 }));
    const c2 = mergeLine(c1, "b1", cutLine({ lengthMm: 2400, widthMm: 600 }));
    expect(c2.lines.length).toBe(1);
    expect(c2.lines[0].quantity).toBe(2);
  });

  it("keeps two DIFFERENT cuts of the same product as separate lines, not summed quantities", () => {
    const c1 = mergeLine({ branchId: null, lines: [] }, "b1", cutLine({ lengthMm: 2400, widthMm: 600 }));
    const c2 = mergeLine(c1, "b1", cutLine({ lengthMm: 1000, widthMm: 1000 }));
    expect(c2.lines.length).toBe(2);
  });
});

describe("getProductQuantity", () => {
  it("returns total quantity of product across all lines", () => {
    const cart: Cart = {
      branchId: "b1",
      lines: [
        line({ productId: "p1", quantity: 2 }),
        line({ productId: "p1", variantId: "v1", quantity: 3 }),
        line({ productId: "p2", quantity: 1 }),
      ],
    };
    expect(getProductQuantity(cart, "p1")).toBe(5);
    expect(getProductQuantity(cart, "p2")).toBe(1);
    expect(getProductQuantity(cart, "p3")).toBe(0);
  });
});

describe("isProductConfigurable", () => {
  it("returns false for a simple product with no modifiers, variants, or dimensional UoM", () => {
    expect(isProductConfigurable({ modifierGroups: [], variants: [] })).toBe(false);
    expect(isProductConfigurable({})).toBe(false);
  });

  it("returns true if product has modifier groups", () => {
    expect(isProductConfigurable({ modifierGroups: [{ id: "m1" }] })).toBe(true);
  });

  it("returns true if product has variants", () => {
    expect(isProductConfigurable({ variants: [{ id: "v1" }] })).toBe(true);
  });

  it("returns true if product has dimensional unit of measure", () => {
    expect(isProductConfigurable({ unitOfMeasure: "m" })).toBe(true);
    expect(isProductConfigurable({ unitOfMeasure: "m2" })).toBe(true);
    expect(isProductConfigurable({ unitOfMeasure: "each" })).toBe(false);
  });
});

describe("changeSimpleProductQuantity", () => {
  const prod = { id: "p1", nameEn: "Cola", nameAr: "كولا", effectivePrice: 20 };

  it("adds a simple product when delta is +1 and item is not in cart", () => {
    const cart: Cart = { branchId: "b1", lines: [] };
    const next = changeSimpleProductQuantity(cart, "b1", prod, 1);
    expect(next.lines).toHaveLength(1);
    expect(next.lines[0].productId).toBe("p1");
    expect(next.lines[0].quantity).toBe(1);
    expect(next.lines[0].unitPrice).toBe(20);
    expect(next.lines[0].selectedOptionIds).toEqual([]);
  });

  it("increments quantity when item is already in cart", () => {
    const cart: Cart = {
      branchId: "b1",
      lines: [{ productId: "p1", nameEn: "Cola", nameAr: "كولا", quantity: 1, unitPrice: 20, selectedOptionIds: [], modifierSummaryEn: "" }],
    };
    const next = changeSimpleProductQuantity(cart, "b1", prod, 1);
    expect(next.lines).toHaveLength(1);
    expect(next.lines[0].quantity).toBe(2);
  });

  it("decrements quantity when delta is -1", () => {
    const cart: Cart = {
      branchId: "b1",
      lines: [{ productId: "p1", nameEn: "Cola", nameAr: "كولا", quantity: 3, unitPrice: 20, selectedOptionIds: [], modifierSummaryEn: "" }],
    };
    const next = changeSimpleProductQuantity(cart, "b1", prod, -1);
    expect(next.lines).toHaveLength(1);
    expect(next.lines[0].quantity).toBe(2);
  });

  it("removes the line when decrementing from 1 to 0", () => {
    const cart: Cart = {
      branchId: "b1",
      lines: [{ productId: "p1", nameEn: "Cola", nameAr: "كولا", quantity: 1, unitPrice: 20, selectedOptionIds: [], modifierSummaryEn: "" }],
    };
    const next = changeSimpleProductQuantity(cart, "b1", prod, -1);
    expect(next.lines).toHaveLength(0);
  });

  it("ignores negative delta when item is not in cart", () => {
    const cart: Cart = { branchId: "b1", lines: [] };
    const next = changeSimpleProductQuantity(cart, "b1", prod, -1);
    expect(next.lines).toHaveLength(0);
  });
});

