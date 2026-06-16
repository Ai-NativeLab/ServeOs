export type CartLine = {
  productId: string;
  nameEn: string;
  nameAr: string;
  quantity: number;
  unitPrice: number; // base + selected modifier deltas, for display only
  selectedOptionIds: string[];
  modifierSummaryEn: string;
};

export type Cart = { branchId: string | null; lines: CartLine[] };

const KEY = "serveos.cart";

export function cartSubtotal(lines: CartLine[]): number {
  return lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
}

export function loadCart(): Cart {
  if (typeof window === "undefined") return { branchId: null, lines: [] };
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Cart) : { branchId: null, lines: [] };
  } catch {
    return { branchId: null, lines: [] };
  }
}

export function saveCart(cart: Cart): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, JSON.stringify(cart));
  window.dispatchEvent(new Event("serveos-cart-changed"));
}

export function clearCart(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY);
  window.dispatchEvent(new Event("serveos-cart-changed"));
}

/** Adds a line. If the branch changed, the cart is reset to the new branch first. */
export function addLine(branchId: string | null, line: CartLine): Cart {
  const current = loadCart();
  const cart: Cart = current.branchId && current.branchId !== branchId
    ? { branchId, lines: [] }
    : { branchId: branchId ?? current.branchId, lines: [...current.lines] };
  cart.lines.push(line);
  saveCart(cart);
  return cart;
}

export function removeLine(index: number): Cart {
  const cart = loadCart();
  cart.lines.splice(index, 1);
  saveCart(cart);
  return cart;
}
