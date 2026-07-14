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
