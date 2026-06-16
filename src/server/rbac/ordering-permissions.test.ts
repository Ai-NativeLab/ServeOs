import { describe, it, expect } from "vitest";
import { can } from "./authorize";

describe("ordering permissions", () => {
  it("staff can manage orders but not fulfillment config", () => {
    expect(can(["staff"], "orders:manage")).toBe(true);
    expect(can(["staff"], "fulfillment:manage")).toBe(false);
  });
  it("manager and owner can manage both", () => {
    for (const role of ["owner", "manager"] as const) {
      expect(can([role], "orders:manage")).toBe(true);
      expect(can([role], "fulfillment:manage")).toBe(true);
    }
  });
});
