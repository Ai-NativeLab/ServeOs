import { describe, it, expect } from "vitest";
import { formatMoney } from "./money";

describe("formatMoney", () => {
  it("formats EGP with code and two decimals", () => {
    expect(formatMoney(120, "EGP")).toBe("EGP 120.00");
  });
  it("formats SAR", () => {
    expect(formatMoney(45.5, "SAR")).toBe("SAR 45.50");
  });
  it("rounds to two decimals", () => {
    expect(formatMoney(10.005, "EGP")).toBe("EGP 10.01");
  });
});
