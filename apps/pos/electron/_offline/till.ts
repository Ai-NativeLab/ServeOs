import { expectedCash, type TillState } from "./reducer";
// Type-only, so nothing from pos-main.ts (and therefore nothing from
// `electron`) is pulled in at runtime: this module is the Electron-free half
// of the write-through path, the half that decides money.
import type { MovementTotal, SaleLine, ShiftReport, TenderTotal } from "../pos-main";

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Server money format (numeric(12,2) as a string) — what PosShiftSummary and
 *  the cash-count rows carry over IPC. */
export const money = (n: number): string => round2(n).toFixed(2);

/** Σ denomination · quantity, mirroring src/server/pos/shift-math.ts, so the
 *  till refuses a pad that disagrees with its total for the same reason and at
 *  the same boundary the server would. */
export function sumDenominations(denominations: Record<string, number>): number {
  return round2(Object.entries(denominations).reduce((sum, [denom, qty]) => sum + Number(denom) * qty, 0));
}

/** What an offline receipt prints where a server order number would go. Short
 *  enough to read back over the phone and derived from the clientOrderId, so
 *  support can find the sale once it syncs. */
export function shortCode(clientOrderId: string): string {
  return `T-${clientOrderId.replace(/-/g, "").slice(-6).toUpperCase()}`;
}

/** Mirrors src/server/ordering/service.ts's LineSnapshot: the till's own
 *  record of what a line was worth, which the server prefers over its live
 *  catalog when a replayed sale disagrees with it (till-wins). Declared here
 *  rather than imported — everything under src/server/ordering drags the
 *  server's db client along with it, which the Electron main bundle must not
 *  contain. */
export type LineSnapshotModifier = {
  groupId: string; optionId: string;
  groupNameEn: string; groupNameAr: string;
  optionNameEn: string; optionNameAr: string;
  priceDelta: number;
};
export type LineSnapshot = {
  productId: string; productNameEn: string; productNameAr: string;
  variantId?: string; variantNameEn?: string; variantNameAr?: string;
  modifiers?: LineSnapshotModifier[];
  unitPrice: number; quantity: number; lineTotal: number; discountAmount?: number;
};

/** The slice of the cached published menu the snapshot math reads. */
export type CachedOption = { id: string; nameEn: string; nameAr: string; priceDelta: string | number };
export type CachedGroup = { id: string; nameEn: string; nameAr: string; options: CachedOption[] };
export type CachedVariant = { id: string; nameEn: string; nameAr: string; price: number };
export type CachedProduct = {
  id: string; nameEn: string; nameAr: string; effectivePrice: number;
  variants?: CachedVariant[]; modifierGroups?: CachedGroup[];
};
export type CachedMenu = { categories: { products: CachedProduct[] }[] };

/**
 * What this line was worth at the till, from the same cached catalog the cart
 * priced itself with.
 *
 * The server prefers these numbers over its live ones when a replayed sale
 * disagrees, so an inaccurate snapshot is mispriced money — a line the cache
 * cannot resolve is refused outright rather than guessed at.
 */
export function snapshotLine(menu: CachedMenu | undefined, line: SaleLine): LineSnapshot {
  const product = menu?.categories.flatMap((c) => c.products).find((p) => p.id === line.productId);
  if (!product) throw new Error("This item is no longer on the till's menu — review the cart and charge again");

  const variant = line.variantId ? product.variants?.find((v) => v.id === line.variantId) : undefined;
  if (line.variantId && !variant) {
    throw new Error("This item's option is no longer on the till's menu — review the cart and charge again");
  }

  const modifiers: LineSnapshotModifier[] = [];
  if (!variant) {
    // Deduped for the same reason placeOrder dedupes: a repeated option id
    // would otherwise charge its priceDelta twice.
    for (const id of new Set(line.selectedOptionIds)) {
      const group = product.modifierGroups?.find((g) => g.options.some((o) => o.id === id));
      const option = group?.options.find((o) => o.id === id);
      if (!group || !option) throw new Error("A modifier on this line is no longer on the till's menu");
      modifiers.push({
        groupId: group.id, optionId: option.id,
        groupNameEn: group.nameEn, groupNameAr: group.nameAr,
        optionNameEn: option.nameEn, optionNameAr: option.nameAr,
        priceDelta: Number(option.priceDelta),
      });
    }
  }

  // Same composition placeOrder uses: a variant's price REPLACES the base,
  // modifiers add to it (and never apply to a variant line).
  const unitPrice = round2(
    variant ? variant.price : product.effectivePrice + modifiers.reduce((s, m) => s + m.priceDelta, 0),
  );
  const discountAmount = Math.min(Math.max(0, line.discountAmount ?? 0), round2(unitPrice * line.quantity));
  return {
    productId: product.id,
    productNameEn: product.nameEn,
    productNameAr: product.nameAr,
    ...(variant ? { variantId: variant.id, variantNameEn: variant.nameEn, variantNameAr: variant.nameAr } : {}),
    ...(modifiers.length ? { modifiers } : {}),
    unitPrice,
    quantity: line.quantity,
    lineTotal: Math.max(0, round2(round2(unitPrice * line.quantity) - discountAmount)),
    ...(discountAmount > 0 ? { discountAmount } : {}),
  };
}

/**
 * The X/Z projection, built from the same events the server builds its own
 * copy from — so the local report and the synced one agree once the queue
 * drains.
 *
 * Two deliberate zeroes: tips (the till takes no tip on a tender today) and
 * voids/refunds (neither has an offline path). Both stay honest rather than
 * guessed. Blind close is a tenant policy the till cannot read offline, so a
 * local report always reveals expected cash; the server's Z, once the close
 * syncs, is what that policy actually governs.
 */
export function tillReport(kind: "x" | "z", state: TillState, counted?: number): ShiftReport | null {
  const open = state.openShift;
  if (!open) return null;

  const tenders: TenderTotal[] = (["cash", "card", "other"] as const)
    .filter((m) => state.tenderCounts[m] > 0)
    .map((m) => ({ method: m, amount: state.tendersByMethod[m], tips: 0, count: state.tenderCounts[m] }));

  // Reported with the sign the server stores them with, so the two read the same.
  const movements: MovementTotal[] = [];
  if (state.movementCounts.payIn) movements.push({ type: "pay_in", total: state.movements.payIn, count: state.movementCounts.payIn });
  if (state.movementCounts.payOut) movements.push({ type: "pay_out", total: -state.movements.payOut, count: state.movementCounts.payOut });
  if (state.movementCounts.safeDrop) movements.push({ type: "safe_drop", total: -state.movements.safeDrop, count: state.movementCounts.safeDrop });
  if (state.movements.noSaleCount) movements.push({ type: "no_sale", total: 0, count: state.movements.noSaleCount });

  const expected = expectedCash(state);
  return {
    kind,
    shiftId: open.clientShiftId,
    openedAt: open.openedAt,
    openedByUserId: open.openedByUserId,
    openingFloat: open.openingFloat,
    tenders,
    movements,
    salesCount: state.salesCount,
    discountTotal: state.discountTotal,
    voidTotal: 0,
    refundTotal: 0,
    cash: counted === undefined ? { expected } : { expected, counted, variance: round2(counted - expected) },
  };
}
