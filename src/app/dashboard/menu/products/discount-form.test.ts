import { describe, it, expect } from "vitest";
import { parseDiscountFormData, type DiscountFormResult } from "./discount-form";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

function value(r: DiscountFormResult) {
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`);
  return r.value;
}

describe("parseDiscountFormData", () => {
  it("returns no discount when discountActive is not true", () => {
    const r = parseDiscountFormData(form({ discountActive: "false", discountPercent: "20" }), 100);
    expect(value(r)).toEqual({
      discountActive: false, discountPercent: null, salePrice: null, discountStartsAt: null, discountEndsAt: null,
    });
  });

  it("percent mode stores ONLY the percent (no derived sale price)", () => {
    const r = value(parseDiscountFormData(form({ discountActive: "true", discountType: "percent", discountPercent: "25" }), 100));
    expect(r).toMatchObject({ discountActive: true, discountPercent: 25, salePrice: null });
  });

  it("sale-price mode stores ONLY the sale price", () => {
    const r = value(parseDiscountFormData(form({ discountActive: "true", discountType: "sale_price", salePrice: "80" }), 100));
    expect(r).toMatchObject({ discountActive: true, salePrice: "80.00", discountPercent: null });
  });

  it.each([
    ["105", "out of range"],
    ["0", "zero"],
    ["12.5", "not a whole number"],
    ["", "missing"],
    ["abc", "not a number"],
  ])("rejects percent %s (%s) with an error instead of clearing the discount", (pct) => {
    const r = parseDiscountFormData(form({ discountActive: "true", discountType: "percent", discountPercent: pct }), 100);
    expect(r).toEqual({ ok: false, error: expect.any(String) });
  });

  it.each([["120"], ["100"], ["0"], [""], ["-5"]])("rejects sale price %s", (sale) => {
    const r = parseDiscountFormData(form({ discountActive: "true", discountType: "sale_price", salePrice: sale }), 100);
    expect(r).toEqual({ ok: false, error: expect.any(String) });
  });

  it("keeps UTC instants exactly as submitted, whatever the server timezone", () => {
    // The browser sends new Date(local).toISOString(); 10:00 in Cairo (UTC+3
    // in summer) is 07:00Z. The parser must not reinterpret it in its own TZ.
    const r = value(parseDiscountFormData(form({
      discountActive: "true", discountType: "percent", discountPercent: "20",
      discountStartsAt: "2026-09-01T07:00:00.000Z", discountEndsAt: "2026-09-05T15:00:00.000Z",
    }), 100));
    expect(r.discountStartsAt?.toISOString()).toBe("2026-09-01T07:00:00.000Z");
    expect(r.discountEndsAt?.toISOString()).toBe("2026-09-05T15:00:00.000Z");
  });

  it("accepts an explicit offset and normalises it to the same instant", () => {
    const r = value(parseDiscountFormData(form({
      discountActive: "true", discountType: "percent", discountPercent: "20", discountStartsAt: "2026-09-01T10:00:00+03:00",
    }), 100));
    expect(r.discountStartsAt?.toISOString()).toBe("2026-09-01T07:00:00.000Z");
  });

  it("rejects a zone-less datetime (it would be read in the server's timezone)", () => {
    const r = parseDiscountFormData(form({
      discountActive: "true", discountType: "percent", discountPercent: "20", discountStartsAt: "2026-09-01T10:00",
    }), 100);
    expect(r).toEqual({ ok: false, error: expect.any(String) });
  });

  it("rejects an end that is not after the start", () => {
    const base = { discountActive: "true", discountType: "percent", discountPercent: "20" };
    expect(parseDiscountFormData(form({ ...base, discountStartsAt: "2026-09-05T00:00:00.000Z", discountEndsAt: "2026-09-01T00:00:00.000Z" }), 100).ok).toBe(false);
    expect(parseDiscountFormData(form({ ...base, discountStartsAt: "2026-09-05T00:00:00.000Z", discountEndsAt: "2026-09-05T00:00:00.000Z" }), 100).ok).toBe(false);
  });

  it("allows open-ended windows", () => {
    const r = value(parseDiscountFormData(form({
      discountActive: "true", discountType: "percent", discountPercent: "20", discountEndsAt: "2026-09-05T00:00:00.000Z",
    }), 100));
    expect(r.discountStartsAt).toBeNull();
    expect(r.discountEndsAt).toBeInstanceOf(Date);
  });
});
