/**
 * The Arabic description to render beneath the English one, or null.
 *
 * Returns null when the two are the same string. That is not a hypothetical:
 * the demo seed used to write `descriptionAr: p.descEn`, so every product in
 * every seeded environment carries English in its Arabic column. The moment
 * the storefront started rendering descriptionAr, those products showed the
 * identical sentence twice — which reads as a bug to a customer and is one.
 *
 * Data alone cannot be relied on to fix it. The column is editable by hand in
 * the dashboard, and pasting the English in while "we will translate it later"
 * is exactly what people do. Two identical lines are never the intent, so the
 * component refuses to draw the second one wherever it comes from.
 *
 * Trimmed before comparing, because a trailing space is not a translation.
 */
export function arabicDescription(
  descriptionEn: string | null | undefined,
  descriptionAr: string | null | undefined,
): string | null {
  const ar = descriptionAr?.trim();
  if (!ar) return null;
  if (ar === descriptionEn?.trim()) return null;
  return ar;
}
