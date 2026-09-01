import type { CatalogDisplayMode } from "@/server/tenancy/settings";

export type ParsedCatalogDisplayForm = {
  catalogDisplayMode: CatalogDisplayMode;
  itemsPerPage: number;
};

export function parseCatalogDisplayFormData(formData: FormData): ParsedCatalogDisplayForm {
  const modeRaw = String(formData.get("catalogDisplayMode") || "");
  const mode: CatalogDisplayMode =
    modeRaw === "category_grid" || modeRaw === "paginated" || modeRaw === "sections"
      ? modeRaw
      : "sections";

  const perPageRaw = Number(formData.get("itemsPerPage"));
  const itemsPerPage = !Number.isNaN(perPageRaw) && perPageRaw > 0 ? perPageRaw : 12;

  return { catalogDisplayMode: mode, itemsPerPage };
}
