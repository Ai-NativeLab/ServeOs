/**
 * Pure URL + pagination logic for the storefront's paginated and
 * category-grid catalog views. The URL (?category=, ?page=) is the single
 * source of truth so Back/Forward and deep links land on the same view the
 * server rendered.
 */

export const ALL_CATEGORIES = "all";

export type CatalogUrlState = {
  /** A known category id, or "all". */
  category: string;
  /** Whole number >= 1 (not yet clamped to the page count). */
  page: number;
  /** True when ?page= was present but not a whole number >= 1, so the
   *  caller should replaceState the canonical value back. */
  pageWasInvalid: boolean;
};

export type ParamSource = { get(name: string): string | null };

export function parseCatalogParams(params: ParamSource, categoryIds: readonly string[]): CatalogUrlState {
  const rawCategory = params.get("category");
  const category = rawCategory && categoryIds.includes(rawCategory) ? rawCategory : ALL_CATEGORIES;

  const rawPage = params.get("page");
  if (rawPage === null) return { category, page: 1, pageWasInvalid: false };
  const page = /^\d+$/.test(rawPage) ? Number(rawPage) : NaN;
  if (!Number.isSafeInteger(page) || page < 1) return { category, page: 1, pageWasInvalid: true };
  return { category, page, pageWasInvalid: false };
}

export function totalPagesFor(itemCount: number, perPage: number): number {
  return Math.max(1, Math.ceil(itemCount / perPage));
}

export function clampPage(page: number, totalPages: number): number {
  return Math.min(Math.max(1, Math.trunc(page)), Math.max(1, totalPages));
}

export function pageSlice<T>(items: readonly T[], page: number, perPage: number): T[] {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

/** The query string for a catalog state: page 1 and "all" are the defaults
 * and are left out so the canonical URL stays clean. Other params (e.g.
 * ?branch=) are kept. */
export function catalogSearch(current: string, state: { category?: string; page?: number }): string {
  const params = new URLSearchParams(current);
  if (state.category !== undefined) {
    if (state.category === ALL_CATEGORIES) params.delete("category");
    else params.set("category", state.category);
  }
  if (state.page !== undefined) {
    if (state.page <= 1) params.delete("page");
    else params.set("page", String(state.page));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export type PageToken = number | "ellipsis-start" | "ellipsis-end";

/** First, last, and current±2, with an ellipsis for each gap. */
export function paginationWindow(current: number, total: number, radius = 2): PageToken[] {
  if (total <= 1) return [1];
  const pages = new Set<number>([1, total]);
  for (let p = current - radius; p <= current + radius; p++) {
    if (p >= 1 && p <= total) pages.add(p);
  }
  const sorted = [...pages].sort((a, b) => a - b);
  const out: PageToken[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    const prev = sorted[i - 1];
    if (prev !== undefined && p - prev > 1) {
      // A gap of exactly one page is shown as that page, not "…".
      if (p - prev === 2) out.push(prev + 1);
      else out.push(p <= current ? "ellipsis-start" : "ellipsis-end");
    }
    out.push(p);
  }
  return out;
}
