import { describe, it, expect } from "vitest";
import { qty, dimensionOf, assertSameDimension, assertInventoryUom, toBase, withWaste, scaleForYield } from "./uom";
import { DimensionalUomError } from "./errors";

const gramItem = { baseUom: "g" as const, stockToBase: "1000", purchaseToBase: "1000", recipeToBase: "1" };

describe("qty", () => {
  it("formats to fixed scale-3 numeric string (the money(n) analog for quantities)", () => {
    expect(qty(1)).toBe("1.000");
    expect(qty(0.5)).toBe("0.500");
    expect(qty(1 / 3)).toBe("0.333");
  });

  it("keeps the sign, so a deduction round-trips as a negative ledger qty", () => {
    expect(qty(-2.5)).toBe("-2.500");
  });
});

describe("dimension checks", () => {
  it("classifies each uom", () => {
    expect(dimensionOf("kg")).toBe("mass");
    expect(dimensionOf("l")).toBe("volume");
    expect(dimensionOf("each")).toBe("count");
  });

  it("rejects cross-dimension conversion (g↔ml — density not modelled)", () => {
    expect(() => assertSameDimension("g", "ml")).toThrow(DimensionalUomError);
    expect(() => assertSameDimension("kg", "g")).not.toThrow();
  });
});

describe("assertInventoryUom", () => {
  // The shared unit_of_measure enum is a superset: it also carries P4's sellable
  // dimensional units. The DB cannot express the subset, so this guard is the
  // only thing keeping an m2 out of the ledger.
  it("accepts the five stockable units", () => {
    for (const u of ["each", "g", "kg", "ml", "l"] as const) {
      expect(assertInventoryUom(u)).toBe(u);
    }
  });

  it("rejects P4 sellable dimensional units", () => {
    for (const u of ["m", "m2", "bf"] as const) {
      expect(() => assertInventoryUom(u)).toThrow(DimensionalUomError);
    }
  });
});

describe("toBase", () => {
  it("normalizes kg → g when base is g (250 g)", () => {
    expect(toBase(0.25, "kg", gramItem)).toBe(250);
  });

  it("passes through when already base", () => {
    expect(toBase(120, "g", gramItem)).toBe(120);
  });

  it("throws when the source dimension can't reach the base", () => {
    expect(() => toBase(1, "ml", gramItem)).toThrow(DimensionalUomError);
  });

  it("uses the item's explicit factor when a factorKind is named", () => {
    // A 24-can case: purchaseToBase = 24 with base `each`. The dimensional
    // route would say 1, so this proves the per-item factor wins.
    const caseItem = { baseUom: "each" as const, stockToBase: "1", purchaseToBase: "24", recipeToBase: "1" };
    expect(toBase(2, "each", caseItem, "purchase")).toBe(48);
  });
});

describe("scaling", () => {
  // Exact equality is deliberate: 100 * 1.1 is 110.00000000000001 in binary
  // float, so this passes only because the module snaps every result to scale 3.
  // Relaxing it to toBeCloseTo would let drift back in, and the FIFO loop's
  // remainder comparison depends on these numbers landing exactly.
  it("applies waste percentage", () => { expect(withWaste(100, 10)).toBe(110); });
  it("scales components by soldQty / yieldQty", () => { expect(scaleForYield(50, 4, 2)).toBe(100); });

  it("treats a zero yield as one batch rather than dividing by zero", () => {
    expect(scaleForYield(50, 2, 0)).toBe(100);
  });
});
