import { describe, it, expect } from "vitest";
import { parseCatalogDisplayFormData } from "./display-form";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("parseCatalogDisplayFormData", () => {
  it.each(["sections", "category_grid", "paginated"])("accepts mode %s", (mode) => {
    expect(parseCatalogDisplayFormData(form({ catalogDisplayMode: mode }))).toEqual({ ok: true, value: { catalogDisplayMode: mode } });
  });

  it.each(["12", "24", "48"])("accepts itemsPerPage %s", (n) => {
    expect(parseCatalogDisplayFormData(form({ catalogDisplayMode: "paginated", itemsPerPage: n })))
      .toEqual({ ok: true, value: { catalogDisplayMode: "paginated", itemsPerPage: Number(n) } });
  });

  it("leaves itemsPerPage out when the form didn't send it, so the stored value is untouched", () => {
    const r = parseCatalogDisplayFormData(form({ catalogDisplayMode: "sections" }));
    expect(r.ok && "itemsPerPage" in r.value).toBe(false);
  });

  it.each(["2.5", "1000", "abc", "0", "-12", "12abc"])("rejects itemsPerPage %s", (n) => {
    expect(parseCatalogDisplayFormData(form({ catalogDisplayMode: "paginated", itemsPerPage: n })))
      .toEqual({ ok: false, error: expect.any(String) });
  });

  it.each(["", "carousel"])("rejects mode %j", (mode) => {
    expect(parseCatalogDisplayFormData(form({ catalogDisplayMode: mode })).ok).toBe(false);
  });

  it("rejects a missing mode", () => {
    expect(parseCatalogDisplayFormData(new FormData()).ok).toBe(false);
  });
});
