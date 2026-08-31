/**
 * Pure pricing calculations for catalog items and promotional discounts.
 * No DB or external dependencies — safe for unit testing and client/server reuse.
 */

export type ProductDiscountInput = {
  basePrice: number | string;
  salePrice?: number | string | null;
  discountPercent?: number | null;
  discountStartsAt?: Date | string | null;
  discountEndsAt?: Date | string | null;
  discountActive?: boolean | null;
};

export type ComputedPricing = {
  effectivePrice: number;
  originalPrice: number;
  discountPercent: number | null;
  hasDiscount: boolean;
};

/**
 * Computes the effective selling price and promotional discount state for a product.
 *
 * @param input The product pricing and discount configuration.
 * @param now Optional date for testing validity windows (defaults to new Date()).
 * @returns ComputedPricing object with effectivePrice, originalPrice, discountPercent, and hasDiscount flag.
 */
export function computeEffectivePrice(
  input: ProductDiscountInput,
  now: Date = new Date(),
): ComputedPricing {
  const original = Number(input.basePrice);

  if (Number.isNaN(original) || original <= 0) {
    return {
      effectivePrice: 0,
      originalPrice: 0,
      discountPercent: null,
      hasDiscount: false,
    };
  }

  // 1. If discount is not explicitly active, return base price
  if (!input.discountActive) {
    return {
      effectivePrice: original,
      originalPrice: original,
      discountPercent: null,
      hasDiscount: false,
    };
  }

  // 2. Check scheduled validity dates (if set)
  if (input.discountStartsAt && now < new Date(input.discountStartsAt)) {
    return {
      effectivePrice: original,
      originalPrice: original,
      discountPercent: null,
      hasDiscount: false,
    };
  }

  if (input.discountEndsAt && now > new Date(input.discountEndsAt)) {
    return {
      effectivePrice: original,
      originalPrice: original,
      discountPercent: null,
      hasDiscount: false,
    };
  }

  // 3. Explicit fixed sale price (e.g. 100 -> 75)
  if (input.salePrice !== null && input.salePrice !== undefined && input.salePrice !== "") {
    const sale = Number(input.salePrice);
    if (!Number.isNaN(sale) && sale > 0 && sale < original) {
      const roundedSale = Math.round(sale * 100) / 100;
      const computedPercent = Math.round(((original - roundedSale) / original) * 100);
      return {
        effectivePrice: roundedSale,
        originalPrice: original,
        discountPercent: computedPercent,
        hasDiscount: true,
      };
    }
  }

  // 4. Percentage discount (e.g. 20% off 100 -> 80)
  if (
    typeof input.discountPercent === "number" &&
    !Number.isNaN(input.discountPercent) &&
    input.discountPercent > 0 &&
    input.discountPercent < 100
  ) {
    const discounted = original * (1 - input.discountPercent / 100);
    const roundedEffective = Math.round(discounted * 100) / 100;
    return {
      effectivePrice: roundedEffective,
      originalPrice: original,
      discountPercent: input.discountPercent,
      hasDiscount: true,
    };
  }

  // Fallback if discountActive was true but no valid discount values were provided
  return {
    effectivePrice: original,
    originalPrice: original,
    discountPercent: null,
    hasDiscount: false,
  };
}
