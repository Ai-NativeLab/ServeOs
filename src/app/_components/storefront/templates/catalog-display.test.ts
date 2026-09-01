import { describe, it, expect } from "vitest";

describe("Catalog Display Mode logic", () => {
  const dummyProducts = Array.from({ length: 25 }, (_, i) => ({
    id: `prod-${i + 1}`,
    categoryId: i < 10 ? "cat-1" : i < 20 ? "cat-2" : "cat-3",
    nameEn: `Product ${i + 1}`,
    nameAr: `منتج ${i + 1}`,
    effectivePrice: 50 + i,
  }));

  describe("Pagination slicing", () => {
    it("slices products into exact pages", () => {
      const itemsPerPage = 10;
      const page1 = dummyProducts.slice(0, itemsPerPage);
      const page2 = dummyProducts.slice(itemsPerPage, itemsPerPage * 2);
      const page3 = dummyProducts.slice(itemsPerPage * 2, itemsPerPage * 3);

      expect(page1).toHaveLength(10);
      expect(page1[0].id).toBe("prod-1");
      expect(page2).toHaveLength(10);
      expect(page2[0].id).toBe("prod-11");
      expect(page3).toHaveLength(5);
      expect(page3[0].id).toBe("prod-21");
    });

    it("computes correct total pages", () => {
      const itemsPerPage = 12;
      const totalPages = Math.ceil(dummyProducts.length / itemsPerPage);
      expect(totalPages).toBe(3); // 25 / 12 = 2.08 -> 3
    });
  });

  describe("Category Grid drilldown filtering", () => {
    it("filters products strictly by selected category", () => {
      const cat1Products = dummyProducts.filter((p) => p.categoryId === "cat-1");
      const cat3Products = dummyProducts.filter((p) => p.categoryId === "cat-3");

      expect(cat1Products).toHaveLength(10);
      expect(cat3Products).toHaveLength(5);
    });
  });
});
