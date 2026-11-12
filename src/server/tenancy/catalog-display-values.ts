/**
 * Pure catalog-display values — NO drizzle/db import, so client components
 * (the storefront views, the dashboard settings card) can use them without
 * pulling the database into a browser bundle. settings.ts re-exports these
 * and is the only place that reads/writes them.
 */
export const CATALOG_DISPLAY_MODES = ["sections", "category_grid", "paginated"] as const;
export type CatalogDisplayMode = (typeof CATALOG_DISPLAY_MODES)[number];

export const CATALOG_ITEMS_PER_PAGE = [12, 24, 48] as const;
export type CatalogItemsPerPage = (typeof CATALOG_ITEMS_PER_PAGE)[number];

export const DEFAULT_CATALOG_DISPLAY_MODE: CatalogDisplayMode = "sections";
export const DEFAULT_ITEMS_PER_PAGE: CatalogItemsPerPage = 12;

export function isCatalogDisplayMode(v: unknown): v is CatalogDisplayMode {
  return typeof v === "string" && (CATALOG_DISPLAY_MODES as readonly string[]).includes(v);
}

export function isCatalogItemsPerPage(v: unknown): v is CatalogItemsPerPage {
  return typeof v === "number" && (CATALOG_ITEMS_PER_PAGE as readonly number[]).includes(v);
}
