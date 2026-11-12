/**
 * Pure parsing and validation for promotional discount inputs in dashboard product forms.
 *
 * Exactly one discount method is stored: percent mode stores discountPercent
 * (salePrice null), sale-price mode stores salePrice (discountPercent null).
 * computeEffectivePrice prefers salePrice, so a derived salePrice in percent
 * mode would be an absolute price that ignores branch price overrides.
 *
 * Dates arrive as UTC ISO instants (the client converts its datetime-local
 * value before submitting), so the server's own timezone never shifts them.
 */

export type ParsedDiscountForm = {
  discountActive: boolean;
  discountPercent: number | null;
  salePrice: string | null;
  discountStartsAt: Date | null;
  discountEndsAt: Date | null;
};

export type DiscountFormResult =
  | { ok: true; value: ParsedDiscountForm }
  | { ok: false; error: string };

const NO_DISCOUNT: ParsedDiscountForm = {
  discountActive: false,
  discountPercent: null,
  salePrice: null,
  discountStartsAt: null,
  discountEndsAt: null,
};

// An instant with an explicit zone (Z or ±hh:mm). A bare "2026-05-01T10:00"
// would be read in the server's timezone (UTC on Vercel), which is exactly
// the 2-3h shift this format exists to prevent.
const ZONED_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function text(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === "string" ? v.trim() : "";
}

function parseInstant(raw: string): Date | null | "invalid" {
  if (raw === "") return null;
  if (!ZONED_ISO.test(raw)) return "invalid";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? "invalid" : d;
}

export function parseDiscountFormData(formData: FormData, basePrice: number): DiscountFormResult {
  if (formData.get("discountActive") !== "true") return { ok: true, value: NO_DISCOUNT };

  let discountPercent: number | null = null;
  let salePrice: string | null = null;

  if (formData.get("discountType") === "sale_price") {
    const raw = text(formData, "salePrice");
    const sale = Number(raw);
    if (raw === "" || !Number.isFinite(sale) || Math.round(sale * 100) <= 0) {
      return { ok: false, error: "Enter a sale price greater than 0." };
    }
    if (Number.isFinite(basePrice) && basePrice > 0 && sale >= basePrice) {
      return { ok: false, error: "The sale price must be lower than the base price." };
    }
    salePrice = (Math.round(sale * 100) / 100).toFixed(2);
  } else {
    const raw = text(formData, "discountPercent");
    const pct = Number(raw);
    if (raw === "" || !Number.isInteger(pct) || pct < 1 || pct > 99) {
      return { ok: false, error: "Enter a whole-number discount from 1 to 99%." };
    }
    discountPercent = pct;
  }

  const starts = parseInstant(text(formData, "discountStartsAt"));
  const ends = parseInstant(text(formData, "discountEndsAt"));
  if (starts === "invalid") return { ok: false, error: "The start date is not a valid date." };
  if (ends === "invalid") return { ok: false, error: "The end date is not a valid date." };
  if (starts && ends && ends.getTime() <= starts.getTime()) {
    return { ok: false, error: "The end date must be after the start date." };
  }

  return {
    ok: true,
    value: { discountActive: true, discountPercent, salePrice, discountStartsAt: starts, discountEndsAt: ends },
  };
}
