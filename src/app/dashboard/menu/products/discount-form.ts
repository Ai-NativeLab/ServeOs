/**
 * Pure parsing and validation for promotional discount inputs in dashboard product forms.
 */

export type ParsedDiscountForm = {
  discountActive: boolean;
  discountPercent: number | null;
  salePrice: string | null;
  discountStartsAt: Date | null;
  discountEndsAt: Date | null;
};

export function parseDiscountFormData(formData: FormData, basePrice: number): ParsedDiscountForm {
  const discountActive = formData.get("discountActive") === "true";

  if (!discountActive) {
    return {
      discountActive: false,
      discountPercent: null,
      salePrice: null,
      discountStartsAt: null,
      discountEndsAt: null,
    };
  }

  const discountType = formData.get("discountType");
  const discountPercentRaw = formData.get("discountPercent");
  const salePriceRaw = formData.get("salePrice");
  const startsAtRaw = formData.get("discountStartsAt");
  const endsAtRaw = formData.get("discountEndsAt");

  let discountPercent: number | null = null;
  let salePrice: string | null = null;

  if (discountType === "sale_price" && salePriceRaw) {
    const sale = Number(salePriceRaw);
    if (!Number.isNaN(sale) && sale > 0 && sale < basePrice) {
      salePrice = String(sale);
      discountPercent = Math.round(((basePrice - sale) / basePrice) * 100);
    }
  } else if (discountPercentRaw) {
    const pct = Number(discountPercentRaw);
    if (!Number.isNaN(pct) && pct >= 1 && pct <= 99) {
      discountPercent = Math.round(pct);
      const discounted = basePrice * (1 - pct / 100);
      salePrice = (Math.round(discounted * 100) / 100).toFixed(2);
    }
  }

  const discountStartsAt =
    startsAtRaw && String(startsAtRaw).trim() !== "" ? new Date(String(startsAtRaw)) : null;
  const discountEndsAt =
    endsAtRaw && String(endsAtRaw).trim() !== "" ? new Date(String(endsAtRaw)) : null;

  const validStartsAt =
    discountStartsAt && !isNaN(discountStartsAt.getTime()) ? discountStartsAt : null;
  const validEndsAt =
    discountEndsAt && !isNaN(discountEndsAt.getTime()) ? discountEndsAt : null;

  const isValid = discountPercent !== null || salePrice !== null;

  return {
    discountActive: isValid,
    discountPercent: isValid ? discountPercent : null,
    salePrice: isValid ? salePrice : null,
    discountStartsAt: isValid ? validStartsAt : null,
    discountEndsAt: isValid ? validEndsAt : null,
  };
}
