import { computeCartTotals, type CartTotals, type CheckoutPricing } from "@shared/order-totals";

export type CartLine = {
  productId: string;
  variantId?: string;
  variantName?: string;
  name: string;
  quantity: number;
  selectedOptionIds: string[];
  unitPrice: number;
  discountAmount?: number;
  discountReason?: string;
  note?: string;
};

export function lineKey(l: { productId: string; variantId?: string; selectedOptionIds: string[] }): string {
  return [l.productId, l.variantId ?? "", [...l.selectedOptionIds].sort().join(",")].join("|");
}

export function addLine(lines: CartLine[], line: CartLine): CartLine[] {
  const key = lineKey(line);
  const idx = lines.findIndex((l) => lineKey(l) === key);
  if (idx >= 0) {
    return lines.map((l, i) => (i === idx ? { ...l, quantity: l.quantity + line.quantity } : l));
  }
  return [...lines, line];
}

export function removeLine(lines: CartLine[], index: number): CartLine[] {
  return lines.filter((_, i) => i !== index);
}

export function changeQty(lines: CartLine[], index: number, quantity: number): CartLine[] {
  if (quantity <= 0) return removeLine(lines, index);
  return lines.map((l, i) => (i === index ? { ...l, quantity } : l));
}

export function discountLine(lines: CartLine[], index: number, amount: number, reason: string): CartLine[] {
  return lines.map((l, i) => (i === index ? { ...l, discountAmount: amount, discountReason: reason } : l));
}

/** The ONLY total the POS may display. Delegates to the shared money math. */
export function cartTotals(pricing: CheckoutPricing, lines: CartLine[], orderDiscountAmount = 0): CartTotals {
  return computeCartTotals(pricing, lines, orderDiscountAmount);
}
