import { actionId } from "./ids";
import { ROW_TITLE_MAX, type ListRow } from "./provider";

/** Meta allows 10 rows TOTAL across all sections; one is reserved for "next". */
export const PAGE_SIZE = 9;

export function truncateTitle(s: string): string {
  return s.length <= ROW_TITLE_MAX ? s : s.slice(0, ROW_TITLE_MAX - 1) + "…";
}

/**
 * Slices `items` into one Meta-legal page. Price and unit belong in the
 * 72-char description, never the 24-char title.
 */
export function renderRows(
  items: { id: string; name: string; description?: string }[],
  page: number,
  action: string,
  version: number,
): { rows: ListRow[]; hasMore: boolean } {
  const start = page * PAGE_SIZE;
  const slice = items.slice(start, start + PAGE_SIZE);
  return {
    rows: slice.map((i) => ({
      id: actionId(action, version, i.id),
      title: truncateTitle(i.name),
      ...(i.description ? { description: i.description.slice(0, 72) } : {}),
    })),
    hasMore: start + PAGE_SIZE < items.length,
  };
}
