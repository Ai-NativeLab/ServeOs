import { describe, it, expect } from "vitest";
import { parseLines } from "./validation";

const line = (over: Record<string, unknown> = {}) =>
  ({ itemId: "i", qtyOrdered: 1, uom: "each", unitCost: 1, ...over });

describe("parseLines", () => {
  it("accepts numeric strings, as it always has", () => {
    const out = parseLines([line({ qtyOrdered: "5", unitCost: "2.50" })]);
    expect(Array.isArray(out)).toBe(true);
    expect((out as { qtyOrdered: number }[])[0].qtyOrdered).toBe(5);
  });

  it("rejects a bad taxRate at the edge so the route can 400 instead of 500", () => {
    // assertLineNumbers rejects these too, but from inside createDraftPo — i.e.
    // inside the route's blanket catch, which returns 500. The two validators
    // have to agree on every field or the disagreement lands on the wrong side
    // of the HTTP boundary.
    for (const bad of ["abc", -0.1, Number.NaN, Infinity]) {
      const out = parseLines([line({ taxRate: bad })]);
      expect(out, `taxRate=${String(bad)}`).toHaveProperty("error");
    }
    expect(parseLines([line({ taxRate: 0.14 })])).not.toHaveProperty("error");
  });

  it("still rejects the fields it always did", () => {
    expect(parseLines([])).toHaveProperty("error");
    expect(parseLines([line({ qtyOrdered: 0 })])).toHaveProperty("error");
    expect(parseLines([line({ unitCost: -1 })])).toHaveProperty("error");
    expect(parseLines([line({ itemId: "" })])).toHaveProperty("error");
  });
});
