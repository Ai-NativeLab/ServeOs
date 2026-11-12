import {
  isCatalogDisplayMode, isCatalogItemsPerPage, type CatalogDisplayMode, type CatalogItemsPerPage,
} from "@/server/tenancy/catalog-display-values";

export type ParsedCatalogDisplayForm = {
  catalogDisplayMode: CatalogDisplayMode;
  /** Undefined when the form didn't send one (a non-paginated mode hides the
   *  picker), so saving another mode leaves the stored page size alone. */
  itemsPerPage?: CatalogItemsPerPage;
};

export type CatalogDisplayFormResult =
  | { ok: true; value: ParsedCatalogDisplayForm }
  | { ok: false; error: string };

export function parseCatalogDisplayFormData(formData: FormData): CatalogDisplayFormResult {
  const mode = formData.get("catalogDisplayMode");
  if (!isCatalogDisplayMode(mode)) return { ok: false, error: "Choose a display mode." };

  const rawPerPage = formData.get("itemsPerPage");
  if (rawPerPage === null || rawPerPage === "") return { ok: true, value: { catalogDisplayMode: mode } };
  const perPage = typeof rawPerPage === "string" && /^\d+$/.test(rawPerPage) ? Number(rawPerPage) : NaN;
  if (!isCatalogItemsPerPage(perPage)) return { ok: false, error: "Products per page must be 12, 24 or 48." };
  return { ok: true, value: { catalogDisplayMode: mode, itemsPerPage: perPage } };
}
