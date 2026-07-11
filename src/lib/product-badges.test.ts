import { describe, it, expect } from "vitest";
import { isNewProduct } from "./product-badges";

describe("isNewProduct", () => {
  const now = new Date("2026-07-10T12:00:00Z");
  it("true within 14 days, false beyond", () => {
    expect(isNewProduct("2026-07-01T12:00:00Z", now)).toBe(true);
    expect(isNewProduct("2026-06-20T12:00:00Z", now)).toBe(false);
  });
});
