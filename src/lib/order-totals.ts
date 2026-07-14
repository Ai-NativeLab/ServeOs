// The ONLY place order money math lives. Server (placeOrder) computes and
// persists these numbers; checkout renders the same breakdown client-side.

export type CheckoutPricing = {
  vatEnabled: boolean;
  vatRate: number;           // percent, e.g. 14
  pricesIncludeVat: boolean; // true: VAT shown as informational, already in prices
  serviceChargeRate: number; // percent; 0 = off (capability-gated upstream)
};

export type OrderTotals = {
  subtotal: number;
  serviceChargeAmount: number;
  vatRate: number;
  vatAmount: number;
  vatIncludedInPrices: boolean;
  deliveryFee: number;
  total: number;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeOrderTotals(pricing: CheckoutPricing, subtotal: number, deliveryFee: number): OrderTotals {
  const sub = round2(subtotal);
  const fee = round2(deliveryFee);
  const serviceChargeAmount = round2(sub * (pricing.serviceChargeRate / 100));
  const taxable = round2(sub + serviceChargeAmount);

  if (!pricing.vatEnabled) {
    return { subtotal: sub, serviceChargeAmount, vatRate: 0, vatAmount: 0, vatIncludedInPrices: false, deliveryFee: fee, total: round2(taxable + fee) };
  }
  if (pricing.pricesIncludeVat) {
    const vatAmount = round2(taxable * (pricing.vatRate / (100 + pricing.vatRate)));
    return { subtotal: sub, serviceChargeAmount, vatRate: pricing.vatRate, vatAmount, vatIncludedInPrices: true, deliveryFee: fee, total: round2(taxable + fee) };
  }
  const vatAmount = round2(taxable * (pricing.vatRate / 100));
  return { subtotal: sub, serviceChargeAmount, vatRate: pricing.vatRate, vatAmount, vatIncludedInPrices: false, deliveryFee: fee, total: round2(taxable + vatAmount + fee) };
}

export type LineForTotals = { unitPrice: number; quantity: number; discountAmount?: number };
export type CartTotals = OrderTotals & { discountAmount: number };

/** A line's money after its own discount. Never negative. */
export function computeLineTotal(line: LineForTotals): number {
  const gross = round2(line.unitPrice * line.quantity);
  return Math.max(0, round2(gross - round2(line.discountAmount ?? 0)));
}

/**
 * The whole cart. Discounts reduce the taxable base, so they are applied
 * BEFORE the service charge and VAT — computeOrderTotals is called exactly
 * once, with the already-discounted subtotal. POS delivery fee is always 0.
 */
export function computeCartTotals(
  pricing: CheckoutPricing,
  lines: LineForTotals[],
  orderDiscountAmount = 0,
): CartTotals {
  const gross = round2(lines.reduce((s, l) => s + computeLineTotal(l), 0));
  const orderDiscount = Math.min(round2(orderDiscountAmount), gross);
  const discounted = round2(gross - orderDiscount);

  const lineDiscounts = round2(
    lines.reduce((s, l) => s + Math.min(round2(l.discountAmount ?? 0), round2(l.unitPrice * l.quantity)), 0),
  );

  return {
    ...computeOrderTotals(pricing, discounted, 0),
    discountAmount: round2(lineDiscounts + orderDiscount),
  };
}
