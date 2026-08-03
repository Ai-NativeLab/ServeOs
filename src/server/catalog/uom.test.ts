import { describe, it, expect } from "vitest";
import { DIMENSIONAL_UOMS, requiredDimensions } from "./uom";

describe("unit of measure", () => {
  it("lists exactly the three dimensional units the roadmap names", () => {
    expect([...DIMENSIONAL_UOMS].sort()).toEqual(["bf", "m", "m2"]);
  });

  it("requires only the dimensions each unit actually needs", () => {
    expect(requiredDimensions("m")).toEqual(["lengthMm"]);
    expect(requiredDimensions("m2")).toEqual(["lengthMm", "widthMm"]);
    expect(requiredDimensions("bf")).toEqual(["lengthMm", "widthMm", "thicknessMm"]);
  });

  it("a non-dimensional unit needs no dimensions", () => {
    expect(requiredDimensions("each")).toEqual([]);
    expect(requiredDimensions("kg")).toEqual([]);
  });
});
