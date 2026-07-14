import { describe, it, expect } from "vitest";
import { filterCatalog } from "./shop-search";

const cats = [
  { id: "c1", nameEn: "Hinges", nameAr: "مفصلات", imageUrl: null, products: [
    { id: "p1", nameEn: "Soft-Close Hinge", nameAr: "مفصلة", brand: "Grimme" },
    { id: "p2", nameEn: "Standard Hinge", nameAr: "مفصلة عادية", brand: "Egger" },
  ]},
  { id: "c2", nameEn: "Worktops", nameAr: "أسطح", imageUrl: null, products: [
    { id: "p3", nameEn: "Oak Worktop", nameAr: "سطح بلوط", brand: "Egger" },
  ]},
] as never; // structural subset of PublishedMenu["categories"] for the test

describe("filterCatalog", () => {
  it("returns everything for an empty query", () => {
    expect(filterCatalog(cats, "  ").length).toBe(2);
  });
  it("matches by name and drops empty categories", () => {
    const r = filterCatalog(cats, "soft-close");
    expect(r.length).toBe(1);
    expect(r[0].products.map((p) => p.id)).toEqual(["p1"]);
  });
  it("matches by brand across categories", () => {
    const r = filterCatalog(cats, "egger");
    expect(r.flatMap((c) => c.products.map((p) => p.id))).toEqual(["p2", "p3"]);
  });
  it("matches Arabic names", () => {
    expect(filterCatalog(cats, "بلوط")[0].products[0].id).toBe("p3");
  });
});
