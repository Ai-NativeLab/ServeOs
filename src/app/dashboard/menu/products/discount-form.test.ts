import { describe, it, expect } from "vitest";
import { parseDiscountFormData } from "./discount-form";

describe("parseDiscountFormData", () => {
  it("returns inactive discount when discountActive is not true", () => {
    const fd = new FormData();
    fd.set("discountActive", "false");
    fd.set("discountPercent", "20");

    const result = parseDiscountFormData(fd, 100);
    expect(result).toEqual({
      discountActive: false,
      discountPercent: null,
      salePrice: null,
      discountStartsAt: null,
      discountEndsAt: null,
    });
  });

  it("parses valid percentage discount", () => {
    const fd = new FormData();
    fd.set("discountActive", "true");
    fd.set("discountType", "percent");
    fd.set("discountPercent", "25");

    const result = parseDiscountFormData(fd, 100);
    expect(result.discountActive).toBe(true);
    expect(result.discountPercent).toBe(25);
    expect(result.salePrice).toBe("75.00");
  });

  it("parses valid fixed sale price", () => {
    const fd = new FormData();
    fd.set("discountActive", "true");
    fd.set("discountType", "sale_price");
    fd.set("salePrice", "80.00");

    const result = parseDiscountFormData(fd, 100);
    expect(result.discountActive).toBe(true);
    expect(result.salePrice).toBe("80");
    expect(result.discountPercent).toBe(20);
  });

  it("rejects fixed sale price greater than or equal to base price", () => {
    const fd = new FormData();
    fd.set("discountActive", "true");
    fd.set("discountType", "sale_price");
    fd.set("salePrice", "120.00");

    const result = parseDiscountFormData(fd, 100);
    expect(result.discountActive).toBe(false);
    expect(result.salePrice).toBe(null);
    expect(result.discountPercent).toBe(null);
  });

  it("rejects invalid percentage values (<=0 or >=100)", () => {
    const fd = new FormData();
    fd.set("discountActive", "true");
    fd.set("discountType", "percent");
    fd.set("discountPercent", "105");

    const result = parseDiscountFormData(fd, 100);
    expect(result.discountActive).toBe(false);
    expect(result.discountPercent).toBe(null);
  });

  it("parses start and end validity timestamps", () => {
    const fd = new FormData();
    fd.set("discountActive", "true");
    fd.set("discountType", "percent");
    fd.set("discountPercent", "20");
    fd.set("discountStartsAt", "2026-09-01T10:00");
    fd.set("discountEndsAt", "2026-09-05T18:00");

    const result = parseDiscountFormData(fd, 100);
    expect(result.discountActive).toBe(true);
    expect(result.discountStartsAt).toBeInstanceOf(Date);
    expect(result.discountEndsAt).toBeInstanceOf(Date);
    expect(result.discountStartsAt?.toISOString()).toBe(new Date("2026-09-01T10:00").toISOString());
    expect(result.discountEndsAt?.toISOString()).toBe(new Date("2026-09-05T18:00").toISOString());
  });
});
