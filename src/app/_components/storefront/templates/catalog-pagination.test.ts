import { describe, it, expect } from "vitest";
import {
  parseCatalogParams, totalPagesFor, clampPage, pageSlice, catalogSearch, paginationWindow,
} from "./catalog-pagination";

const cats = ["cat-1", "cat-2"];
const q = (s: string) => new URLSearchParams(s);

describe("parseCatalogParams", () => {
  it("defaults to all / page 1 when the URL has neither", () => {
    expect(parseCatalogParams(q(""), cats)).toEqual({ category: "all", page: 1, pageWasInvalid: false });
  });

  it("reads a known category and a whole page number", () => {
    expect(parseCatalogParams(q("category=cat-2&page=3"), cats)).toEqual({ category: "cat-2", page: 3, pageWasInvalid: false });
  });

  it("falls back to all for an unknown category", () => {
    expect(parseCatalogParams(q("category=nope"), cats).category).toBe("all");
  });

  it.each(["2.5", "0", "-1", "abc", "", "1e3", " 2"])("rejects ?page=%s as page 1 and flags it for replaceState", (raw) => {
    expect(parseCatalogParams(q(`page=${encodeURIComponent(raw)}`), cats)).toMatchObject({ page: 1, pageWasInvalid: true });
  });

  it("Back to a URL without ?page / ?category lands on page 1 of all (state is derived, not remembered)", () => {
    // Forward: user went to ?category=cat-1&page=2 …
    expect(parseCatalogParams(q("category=cat-1&page=2"), cats)).toMatchObject({ category: "cat-1", page: 2 });
    // … Back pops to the bare URL: the view must reset, not keep page 2.
    expect(parseCatalogParams(q(""), cats)).toMatchObject({ category: "all", page: 1 });
  });
});

describe("paging math", () => {
  it("counts pages and clamps out-of-range pages", () => {
    expect(totalPagesFor(25, 12)).toBe(3);
    expect(totalPagesFor(0, 12)).toBe(1);
    expect(clampPage(9, 3)).toBe(3);
    expect(clampPage(0, 3)).toBe(1);
  });

  it("slices one page of items", () => {
    const items = Array.from({ length: 25 }, (_, i) => i + 1);
    expect(pageSlice(items, 1, 12)).toEqual(items.slice(0, 12));
    expect(pageSlice(items, 3, 12)).toEqual([25]);
  });
});

describe("catalogSearch", () => {
  it("drops defaults and keeps unrelated params", () => {
    expect(catalogSearch("?branch=b1&page=3", { page: 1 })).toBe("?branch=b1");
    expect(catalogSearch("?branch=b1", { category: "cat-1", page: 2 })).toBe("?branch=b1&category=cat-1&page=2");
    expect(catalogSearch("?category=cat-1", { category: "all" })).toBe("");
  });
});

describe("paginationWindow", () => {
  it("shows every page when there are few", () => {
    expect(paginationWindow(1, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("shows first, last, current±2 and ellipses", () => {
    expect(paginationWindow(10, 20)).toEqual([1, "ellipsis-start", 8, 9, 10, 11, 12, "ellipsis-end", 20]);
    expect(paginationWindow(1, 20)).toEqual([1, 2, 3, "ellipsis-end", 20]);
    expect(paginationWindow(20, 20)).toEqual([1, "ellipsis-start", 18, 19, 20]);
  });

  it("fills a one-page gap with the page instead of an ellipsis", () => {
    expect(paginationWindow(5, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, "ellipsis-end", 10]);
  });
});
