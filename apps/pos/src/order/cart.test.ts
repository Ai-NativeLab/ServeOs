import { describe, it, expect } from "vitest";
import { cartTotal, type CartLine } from "./cart";

function line(productId: string, unitPrice: number, quantity = 1, selectedOptionIds: string[] = []): CartLine {
  return { productId, name: productId, quantity, selectedOptionIds, unitPrice };
}

describe("cartTotal", () => {
  it("single base-only product at 10.00 x1 = 10", () => {
    const lines = [line("p1", 10, 1)];
    expect(cartTotal(lines)).toBe(10);
  });

  it("product 10.00 + option 2.50, qty 3 = 37.50", () => {
    const lines = [line("p1", 10 + 2.5, 3, ["o1"])];
    expect(cartTotal(lines)).toBe(37.5);
  });

  it("sums two lines", () => {
    const lines = [line("p1", 10, 2), line("p2", 5.25, 4)];
    // 10*2 + 5.25*4 = 20 + 21 = 41
    expect(cartTotal(lines)).toBe(41);
  });
});
