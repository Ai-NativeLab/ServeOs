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

function sameOptions(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** Pure merge: same product + same option set (order-insensitive) adds
 * quantities; a branch change resets the cart to the new branch first. */
export function mergeLine(current: Cart, branchId: string | null, line: CartLine): Cart {
  const cart: Cart = current.branchId && current.branchId !== branchId
    ? { branchId, lines: [] }
    : { branchId: branchId ?? current.branchId, lines: [...current.lines] };
  const i = cart.lines.findIndex(
    (l) => l.productId === line.productId && sameOptions(l.selectedOptionIds, line.selectedOptionIds),
  );
  if (i >= 0) cart.lines[i] = { ...cart.lines[i], quantity: cart.lines[i].quantity + line.quantity };
  else cart.lines.push(line);
  return cart;
}

/** Pure quantity update; quantity ≤ 0 removes the line. */
export function withLineQuantity(cart: Cart, index: number, quantity: number): Cart {
  if (!cart.lines[index]) return cart;
  const lines = [...cart.lines];
  if (quantity <= 0) lines.splice(index, 1);
  else lines[index] = { ...lines[index], quantity };
  return { ...cart, lines };
}

/** Adds a line (merging duplicates). If the branch changed, the cart resets first. */
export function addLine(branchId: string | null, line: CartLine): Cart {
  const cart = mergeLine(loadCart(), branchId, line);
  saveCart(cart);
  return cart;
}

export function setLineQuantity(index: number, quantity: number): Cart {
  const cart = withLineQuantity(loadCart(), index, quantity);
  saveCart(cart);
  return cart;
}

export function removeLine(index: number): Cart {
  return setLineQuantity(index, 0);
}
