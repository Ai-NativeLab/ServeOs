export type CartLine = {
  productId: string;
  variantId?: string;
  variantNameEn?: string;
  nameEn: string;
  nameAr: string;
  quantity: number;
  unitPrice: number; // base + selected modifier deltas, for display only
  selectedOptionIds: string[];
  modifierSummaryEn: string;
  /** P4: the cut-list dimensions this line was priced from (client-computed
   *  preview; the server re-derives unitPrice from these at placeOrder). */
  dimensions?: { lengthMm?: number; widthMm?: number; thicknessMm?: number };
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

/** Two dimensional lines are the same purchase only if every measurement
 * matches — a 2.4m cut and a 1m cut of the same sheet are different lines,
 * never quantities of one another. */
function sameDimensions(a?: CartLine["dimensions"], b?: CartLine["dimensions"]): boolean {
  return (a?.lengthMm ?? null) === (b?.lengthMm ?? null)
    && (a?.widthMm ?? null) === (b?.widthMm ?? null)
    && (a?.thicknessMm ?? null) === (b?.thicknessMm ?? null);
}

/** Pure merge: same product + same option set (order-insensitive) + same
 * dimensions (if any) adds quantities; a branch change resets the cart first. */
export function mergeLine(current: Cart, branchId: string | null, line: CartLine): Cart {
  const cart: Cart = current.branchId && current.branchId !== branchId
    ? { branchId, lines: [] }
    : { branchId: branchId ?? current.branchId, lines: [...current.lines] };
  const i = cart.lines.findIndex(
    (l) =>
      l.productId === line.productId &&
      (l.variantId ?? null) === (line.variantId ?? null) &&
      sameOptions(l.selectedOptionIds, line.selectedOptionIds) &&
      sameDimensions(l.dimensions, line.dimensions),
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

/** Total quantity of a product across all variants, cuts, and modifier configurations. */
export function getProductQuantity(cart: Cart, productId: string): number {
  return cart.lines
    .filter((l) => l.productId === productId)
    .reduce((sum, l) => sum + l.quantity, 0);
}

/** Quantity of the simple (unconfigured) line for a product in the cart. */
export function getSimpleProductQuantity(cart: Cart, productId: string): number {
  const line = cart.lines.find(
    (l) => l.productId === productId && !l.variantId && l.selectedOptionIds.length === 0 && !l.dimensions,
  );
  return line ? line.quantity : 0;
}

/** Returns true if a product requires configuration (modifiers, retail variants, or cut dimensions). */
export function isProductConfigurable(product: {
  modifierGroups?: unknown[];
  variants?: unknown[];
  unitOfMeasure?: string | null;
}): boolean {
  if (product.modifierGroups && product.modifierGroups.length > 0) return true;
  if (product.variants && product.variants.length > 0) return true;
  if (product.unitOfMeasure && (product.unitOfMeasure === "m" || product.unitOfMeasure === "m2" || product.unitOfMeasure === "bf")) {
    return true;
  }
  return false;
}

/** Pure function to increment or decrement a simple product's quantity in the cart. */
export function changeSimpleProductQuantity(
  current: Cart,
  branchId: string | null,
  product: { id: string; nameEn: string; nameAr: string; effectivePrice: number },
  delta: number,
): Cart {
  const idx = current.lines.findIndex(
    (l) => l.productId === product.id && !l.variantId && l.selectedOptionIds.length === 0 && !l.dimensions,
  );

  if (delta > 0) {
    if (idx >= 0) {
      return withLineQuantity(current, idx, current.lines[idx].quantity + delta);
    }
    return mergeLine(current, branchId, {
      productId: product.id,
      nameEn: product.nameEn,
      nameAr: product.nameAr,
      quantity: delta,
      unitPrice: product.effectivePrice,
      selectedOptionIds: [],
      modifierSummaryEn: "",
    });
  }

  if (delta < 0 && idx >= 0) {
    return withLineQuantity(current, idx, current.lines[idx].quantity + delta);
  }

  return current;
}

/** Impure helper that updates a simple product's quantity, persists to localStorage, and emits the cart change event. */
export function updateSimpleProductQuantity(
  branchId: string | null,
  product: { id: string; nameEn: string; nameAr: string; effectivePrice: number },
  delta: number,
): Cart {
  const cart = changeSimpleProductQuantity(loadCart(), branchId, product, delta);
  saveCart(cart);
  return cart;
}
