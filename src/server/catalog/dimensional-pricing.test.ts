import { describe, it, expect } from "vitest";
import { computeDimensionalQuantity, computeDimensionalUnitPrice, MissingDimensionError } from "./dimensional-pricing";

describe("computeDimensionalQuantity", () => {
  it("linear meters: quantity is length in metres", () => {
    expect(computeDimensionalQuantity("m", { lengthMm: 2400 })).toBeCloseTo(2.4, 3);
  });

  it("square meters: quantity is length x width in m²", () => {
    // A 2.4m x 0.6m sheet -> 1.44 m²
    expect(computeDimensionalQuantity("m2", { lengthMm: 2400, widthMm: 600 })).toBeCloseTo(1.44, 3);
  });

  it("board feet: the standard lumber formula, mm converted to inches", () => {
    // Nominal 2in x 4in x 8ft, in mm: 50.8 x 101.6 x 2438.4.
    // bf = (thickness_in * width_in * length_in) / 144 = (2*4*96)/144 = 5.333
    const bf = computeDimensionalQuantity("bf", { lengthMm: 2438.4, widthMm: 101.6, thicknessMm: 50.8 });
    expect(bf).toBeCloseTo(5.333, 2);
  });

  it("throws MissingDimensionError naming exactly what's missing", () => {
    expect(() => computeDimensionalQuantity("m2", { lengthMm: 2400 })).toThrow(MissingDimensionError);
    expect(() => computeDimensionalQuantity("bf", { lengthMm: 2400, widthMm: 100 })).toThrow(/thicknessMm/);
  });

  it("rejects a non-positive dimension", () => {
    expect(() => computeDimensionalQuantity("m", { lengthMm: 0 })).toThrow();
    expect(() => computeDimensionalQuantity("m", { lengthMm: -5 })).toThrow();
  });
});

describe("computeDimensionalUnitPrice", () => {
  it("multiplies price-per-unit by the computed quantity, rounded to money", () => {
    // 45.50/m2 x 1.44 m2 = 65.52
    expect(computeDimensionalUnitPrice(45.5, "m2", { lengthMm: 2400, widthMm: 600 })).toBeCloseTo(65.52, 2);
  });
});
