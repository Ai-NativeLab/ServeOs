/**
 * How much of an order's VAT a refund takes back — the one new money
 * computation in the refund domain, run ONCE at issuance so every downstream
 * reader (the fiscal return receipt above all) maps a STORED figure instead of
 * re-deriving one months later.
 *
 * PURE BY CONSTRUCTION. No db, no clock, no config: `issueRefund` reads the
 * rows and hands them in (including the prior refunds' VAT figures, which used
 * to be a query in here). The only import is `@/server/fiscal/decimal`, itself
 * a side-effect-free scaled-bigint string library — the sanctioned cross-domain
 * import lives here and nowhere else in the refund domain. Everything below is
 * therefore directly testable without a database, which is what
 * `refund-vat.test.ts`'s property hammer relies on.
 *
 * WHY IT EXISTS. `refunds` stored only money, so an EG tenant's return receipt
 * had no VAT to reverse and the tenant over-declared output VAT on every
 * refund. The order already knows its VAT (`orders.vatAmount`, written by
 * `computeOrderTotals`); what was missing was *how much of it came back*.
 *
 * THE BASIS, MIRRORING `computeOrderTotals` (src/lib/order-totals.ts:23-38, and
 * its cart wrapper at :54-71). VAT is charged on
 * `taxable = subtotal − discount + serviceCharge`; `deliveryFee` is OUTSIDE the
 * taxable base and therefore carries no VAT and never appears below.
 * `orders.subtotal` is already the discounted subtotal (placeOrder passes
 * `subtotal − orderDiscount` into `computeOrderTotals`), and each
 * `order_items.lineTotal` is already net of its own line discount, so the two
 * are consistent weights for a proportional split.
 *
 * THE PIPELINE. Five stages, each stated with what it MAY and MAY NOT change:
 *
 *   orders.vatAmount  (the ceiling — nothing below ever exceeds it)
 *        │
 *   [1] BUCKET   split across [subtotal, serviceCharge]
 *        │       MAY decide how much VAT items can ever claim; MAY NOT change the total.
 *   [2] ITEM     the item bucket split across order_items.lineTotal
 *        │       MAY price each SOLD line; MAY NOT look at what is being refunded.
 *   [3] UNIT     each item's VAT split across its own units
 *        │       MAY hand a refund the units earlier refunds left; MAY NOT re-take one.
 *   [4] TOP-UP   full refund clearing the balance: Σ lines := remaining order VAT
 *        │       MAY raise lines (service charge) or lower them (prior goodwill);
 *        │       MAY NOT run for a partial, nor for a goodwill full refund.
 *   [5] FLOOR    clip negatives to 0.00, re-spread onto lines still holding VAT
 *        │       MAY move cents BETWEEN lines; MAY NOT change their sum.
 *   [6] CEILING  Σ lines > remaining order VAT → scale the lines down to it
 *        │       MAY lower lines (never raise, never below 0); MAY NOT refuse.
 *        ▼
 *   refunds.vatAmount  ==  Σ refund_lines.vatAmount   (itemised refunds, exactly)
 *
 * THE SERVICE-CHARGE DECISION (and its consequence). The service charge is
 * order-level: it bears VAT but has no `order_items` row to hang it on. It is
 * therefore given its OWN weight bucket in stage [1], and a PARTIAL refund's
 * item lines only ever claim the item bucket. The consequence, stated plainly:
 * an itemised partial refund reverses exactly the VAT inside the money handed
 * back for those items and NOT the service charge's VAT share — that share
 * stays declared until the balance itself is refunded. The alternative —
 * spreading the service charge's VAT across the items — would make a line's
 * stored VAT exceed the VAT actually contained in that line's refunded amount
 * (on a 14% VAT-inclusive 100.00 item under a 10% service charge: 6.14 of VAT
 * in 50.00 returned, but 6.76 stored), i.e. it would over-reverse output VAT.
 * Under-reversing a service charge nobody itemises is the safe side of that
 * trade, and the refund of the balance is what recovers it.
 *
 * THE ITEMISED-FULL TOP-UP (stage [4]). A `full` refund whose payments cover
 * the whole outstanding balance returns ALL the remaining money — the service
 * charge included — so ALL the remaining VAT belongs in its stored figures,
 * whether or not the refund happened to name lines. Left as Σ lines, an
 * itemised full refund would orphan the service charge's share permanently: no
 * balance remains for a later refund to recover it (unlike the partial case
 * above). So the residual `remaining − Σ lines` is distributed across THIS
 * refund's lines, largest-remainder over their amounts, making
 * `Σ lines == header == remaining` — which is also what the fiscal layer's
 * `Σ taxableItems == taxTotals` reconciliation needs. Attributing an
 * order-level charge's VAT to product lines is the same documented pro-rata
 * simplification round 1's full-refund gross split already makes
 * (`fiscal/finalize.ts` resolveFullRefundLines). An itemised full refund of
 * LESS than the balance is a goodwill payment that leaves money outstanding, so
 * it gets no top-up.
 *
 * THE FLOOR (stage [5]). The residual is normally positive, but it is NEGATIVE
 * when an earlier goodwill refund already took part of the VAT unattributed,
 * and the pro-rata scale-down can then drive an individual line past zero — a
 * full refund's line amounts are never validated against its tenders, so
 * amounts and VAT weights can point in opposite directions (190.00/10.00 items
 * refunded as 10.00/190.00 lines land on 22.13 / −21.57). A negative
 * `refund_lines.vatAmount` would be an invented input tax credit on the return
 * document, so the order's declared VAT is enforced as a ceiling PER LINE and
 * not only on the header.
 *
 * THE CEILING (stage [6]) — CAPPED, NEVER REFUSED. The order's VAT may be
 * reversed at most once in total, but the two paths can overlap: a goodwill
 * full refund takes a scaled share of the remaining VAT without naming items,
 * and itemising those same units afterwards would claim their VAT a second
 * time. Such a refund is capped — its line VATs are scaled down,
 * largest-remainder over what each line already holds, until they total the
 * VAT not yet reversed (possibly 0.00) — instead of being refused. Refusing
 * would block a refund over a tax figure, which this module must never do: the
 * VAT split runs for EVERY tenant (country-blind, it is stored refund data), so
 * a refusal here also refused refunds for tenants that file nothing at all,
 * which had always succeeded. Capping errs on the safe side — never reversing
 * VAT that was not charged — and the money side of the refund is untouched.
 *
 * EXACTNESS, AND WHAT IS AND IS NOT FLOAT-FREE. Every split is
 * `allocateLargestRemainder`, so the parts sum to the whole to the cent, and
 * each item's VAT is split again across its own UNITS — so a 1-of-2 return
 * takes one unit's cents and a later 1-of-2 return takes the rest. (A
 * `lineVat × qty/orderQty` half-up would store 4.10 twice against a line whose
 * VAT is 8.19, reversing a cent that was never charged, and would then trip the
 * invariant on a perfectly legitimate second return.) All arithmetic introduced
 * here is scaled-BigInt end to end. Two INPUTS are not: `thisTotal` and
 * `outstanding` arrive as `money(n)` of pre-existing float sums (issueRefund's
 * `thisTotal`/`netPaid`, computed with `round2`). That is deliberate — they are
 * the very figures the net-paid ceiling enforces and `refunds.totalAmount`
 * stores, so the VAT scales against exactly the money the refund recorded
 * rather than a second, differently-derived total.
 */

import {
  addDecimal,
  allocateLargestRemainder,
  compareDecimal,
  divideDecimal,
  isZeroDecimal,
  multiplyDecimal,
  subtractDecimal,
  sumDecimal,
} from "@/server/fiscal/decimal";
import { PosRefundError } from "./errors";

/** What this module needs of an order — structurally satisfied by an `Order`
 *  row, and constructible in a test without one. */
export type OrderVatBasis = {
  vatAmount: string;
  subtotal: string;
  serviceChargeAmount: string | null;
};

/** What this module needs of a sold line — structurally satisfied by an
 *  `OrderItem` row. */
export type OrderItemVatBasis = { id: string; quantity: number; lineTotal: string };

/** A line of the refund being issued. `amount` is already a `money(n)` string:
 *  the float→2dp conversion belongs to the caller, so nothing here ever sees a
 *  `number`. */
export type RefundVatLine = { orderItemId: string; quantity: number; amount: string };

/** The VAT this refund carries: the header figure and, for an itemised refund,
 *  one figure per input line in the SAME order they were given. */
export type RefundVat = { headerVat: string; lineVats: string[] };

export type RefundVatInput = {
  order: OrderVatBasis;
  kind: "full" | "partial";
  lines: RefundVatLine[];
  items: OrderItemVatBasis[];
  /** Quantity of each order item returned by EARLIER refunds, by orderItemId. */
  alreadyReturned: Map<string, number>;
  /** Every earlier refund's stored `vatAmount` for this order. */
  priorVatAmounts: string[];
  /** This refund's total, and the balance outstanding immediately before it. */
  thisTotal: string;
  outstanding: string;
};

/**
 * The whole pipeline. Never refuses a refund over VAT: a result that would
 * breach the order's declared VAT is capped (stage [6]). Throws only
 * `PosRefundError`, and only for an internal inconsistency that the stages
 * below make unreachable — never a bare `Error` (which a route maps to a 500).
 */
export function computeRefundVat(input: RefundVatInput): RefundVat {
  const { order, kind, lines, items, alreadyReturned, thisTotal, outstanding } = input;
  const priorVat = sumDecimal("prior refund VAT", input.priorVatAmounts);
  const unreversed = subtractDecimal("remaining order VAT", order.vatAmount, priorVat);
  // Data that ALREADY breaches the ceiling (earlier refunds summing past the
  // order's VAT) reads as "nothing left to reverse" rather than a negative
  // target the stages below cannot honour — this refund then reverses 0.00.
  const remaining = compareDecimal(unreversed, "0") < 0 ? "0.00" : unreversed;
  // A full refund that clears the balance takes the rest of the VAT with it,
  // lines or no lines — see THE ITEMISED-FULL TOP-UP in the module header.
  const clearsBalance = kind === "full" && compareDecimal(thisTotal, outstanding) >= 0;

  const lineVats = lines.length
    ? capAtRemaining(
        topUpToRemaining(itemisedLineVat(order, lines, items, alreadyReturned), lines, clearsBalance ? remaining : null),
        remaining,
      )
    : [];
  const headerVat = lines.length
    ? sumDecimal("refund VAT", lineVats)
    : headerlessRefundVat(remaining, thisTotal, outstanding);

  // INVARIANT: this refund never reverses more than the VAT not yet reversed.
  // Both paths now hold it by construction — the itemised one through the
  // ceiling stage, the headerless one because it scales `remaining` by a share
  // <= 1 — so this is a tripwire for a future edit, and it trips as a
  // `PosRefundError` (a 400 naming the figures), never a bare 500.
  if (compareDecimal(headerVat, remaining) > 0) {
    throw new PosRefundError(
      `refund VAT ${headerVat} exceeds the ${remaining} of the order's ${order.vatAmount} VAT not yet reversed — please report this`,
    );
  }

  return { headerVat, lineVats };
}

/**
 * Stages [1]–[3]: the VAT of each refunded line — the order's VAT split over
 * the service-charge and item buckets, then over the items, then over each
 * item's units, with the units already returned by earlier refunds skipped.
 *
 * Exported for direct unit tests; `issueRefund` only ever calls
 * `computeRefundVat`.
 */
export function itemisedLineVat(
  order: OrderVatBasis,
  lines: RefundVatLine[],
  items: OrderItemVatBasis[],
  alreadyReturned: Map<string, number>,
): string[] {
  // Sorted so the allocation is deterministic for a given order: the largest
  // remainder decides which line takes an odd cent, and only an exact TIE falls
  // through to input order — which `order_items` has no column to guarantee.
  const sorted = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const [itemsVat] = allocateLargestRemainder("orders.vatAmount", order.vatAmount, [
    order.subtotal,
    order.serviceChargeAmount ?? "0",
  ]);
  const perItem = allocateLargestRemainder("order item VAT", itemsVat, sorted.map((i) => i.lineTotal));
  const perUnit = new Map(
    sorted.map((item, i) => [
      item.id,
      allocateLargestRemainder("order item unit VAT", perItem[i], Array.from({ length: item.quantity }, () => "1")),
    ]),
  );

  // A cursor, not a lookup: two lines of the same order item inside ONE refund
  // must take DIFFERENT units, never the same ones twice.
  const cursor = new Map(alreadyReturned);
  return lines.map((l) => {
    const taken = cursor.get(l.orderItemId) ?? 0;
    cursor.set(l.orderItemId, taken + l.quantity);
    // `slice` past the end yields fewer units, so a line that somehow claims
    // more than was sold can only ever under-allocate VAT, never invent it.
    return sumDecimal("refund line VAT", (perUnit.get(l.orderItemId) ?? []).slice(taken, taken + l.quantity));
  });
}

/**
 * Stage [4]: lifts a full refund's line VATs so they sum to `remaining` — the
 * order's VAT not yet reversed — by spreading the residual across the lines
 * largest-remainder over the money each returned, then flooring (stage [5]).
 * `null` (a partial refund, or a goodwill full refund that leaves a balance)
 * passes the lines through untouched.
 *
 * Exported for direct unit tests.
 */
export function topUpToRemaining(lineVats: string[], lines: RefundVatLine[], remaining: string | null): string[] {
  if (remaining === null) return lineVats;
  const residual = subtractDecimal("refund VAT top-up", remaining, sumDecimal("refund VAT", lineVats));
  if (isZeroDecimal(residual)) return lineVats;
  // Weight by the money each line returned; a full refund need not itemise its
  // amounts at all (only a partial must equal its tenders), so a set of
  // zero-amount lines falls back to the quantities, which are always present.
  const amounts = lines.map((l) => l.amount);
  const weights = isZeroDecimal(sumDecimal("refund line amounts", amounts))
    ? lines.map((l) => String(l.quantity))
    : amounts;
  const shares = allocateLargestRemainder("refund VAT top-up", residual, weights);
  return floorLineVatsAt0(lineVats.map((vat, i) => addDecimal("refund line VAT", vat, shares[i])), remaining);
}

/**
 * Stage [6]: scales line VATs DOWN so they total at most `remaining` — the VAT
 * not yet reversed. Untouched when they already fit. The scale-down is
 * largest-remainder over what each line holds, so it is exact to the cent, no
 * line goes up, and none goes below zero (the inputs are all >= 0 and their sum
 * exceeds `remaining` >= 0, so the weights are never all zero).
 *
 * Exported for direct unit tests.
 */
export function capAtRemaining(lineVats: string[], remaining: string): string[] {
  if (compareDecimal(sumDecimal("refund VAT", lineVats), remaining) <= 0) return lineVats;
  return allocateLargestRemainder("refund VAT ceiling", remaining, lineVats);
}

/**
 * Stage [5]: clips negative line VATs to zero and pushes the shortfall onto the
 * lines that can still absorb it, weighted by what they currently hold, until Σ
 * parts is `target` again with nothing below zero.
 *
 * Each pass zeroes at least one line and never revives one, so it terminates in
 * at most one pass per line; the bounded loop is belt-and-braces against a
 * future edit breaking that. When every line floors, Σ is 0 — which can only be
 * consistent if `target` is 0 too, and `computeRefundVat`'s invariant already
 * guarantees `target >= 0`, so a non-zero target there is a bug and says so
 * rather than silently storing a header its lines contradict.
 *
 * Exported for direct unit tests.
 */
export function floorLineVatsAt0(parts: string[], target: string): string[] {
  let current = parts;
  for (let pass = 0; pass <= parts.length; pass++) {
    if (current.every((p) => compareDecimal(p, "0") >= 0)) return current;

    const shortfall = sumDecimal("floored refund line VAT", current.filter((p) => compareDecimal(p, "0") < 0));
    const clipped = current.map((p) => (compareDecimal(p, "0") < 0 ? "0.00" : p));
    // Only the lines that still hold VAT take part: a zero-weight entry left in
    // the allocation would be handed a leftover cent by `allocateLargestRemainder`
    // (its remainder of 0 sorts FIRST for a negative total) and go negative again.
    const absorbing = clipped.map((p, i) => ({ p, i })).filter(({ p }) => compareDecimal(p, "0") > 0);
    if (absorbing.length === 0) {
      if (!isZeroDecimal(target)) {
        throw new PosRefundError(`refund: cannot floor refund line VAT at 0 and still total ${target}`);
      }
      return clipped;
    }
    const shares = allocateLargestRemainder("floored refund line VAT", shortfall, absorbing.map(({ p }) => p));
    const share = new Map(absorbing.map(({ i }, k) => [i, shares[k]]));
    current = clipped.map((p, i) => addDecimal("refund line VAT", p, share.get(i) ?? "0.00"));
  }
  throw new PosRefundError("refund: refund line VAT flooring did not converge");
}

/**
 * The VAT of a HEADERLESS (goodwill or whole-balance) full refund, which names
 * no items: the order's VAT not yet reversed by earlier refunds, scaled by the
 * share of the outstanding balance actually handed back (2dp, half-up). A
 * refund of the whole balance therefore reverses the whole remaining VAT —
 * including the service charge's share, which no item line claims.
 *
 * Exported for direct unit tests.
 */
export function headerlessRefundVat(remaining: string, thisTotal: string, outstanding: string): string {
  if (compareDecimal(remaining, "0") <= 0) return "0.00";
  // Guarded rather than assumed: the net-paid ceiling makes a zero balance
  // unreachable for a positive refund, and dividing by it would throw.
  if (compareDecimal(outstanding, "0") <= 0) return "0.00";
  if (compareDecimal(thisTotal, outstanding) >= 0) return remaining;
  return divideDecimal(
    "goodwill refund VAT",
    multiplyDecimal("goodwill refund VAT", remaining, thisTotal),
    outstanding,
    2,
  );
}
