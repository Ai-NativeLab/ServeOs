import type { PublishedMenu } from "@/server/catalog/schema";

type Categories = PublishedMenu["categories"];

/** Case-insensitive filter over name (en/ar) and brand; drops empty categories. */
export function filterCatalog(categories: Categories, query: string): Categories {
  const q = query.trim().toLowerCase();
  if (!q) return categories;
  return categories
    .map((c) => ({
      ...c,
      products: c.products.filter((p) =>
        [p.nameEn, p.nameAr, p.brand ?? ""].some((s) => s.toLowerCase().includes(q)),
      ),
    }))
    .filter((c) => c.products.length > 0);
}
