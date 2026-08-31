import { and, eq } from "drizzle-orm";
import { withTenant, type Tx } from "@/db/with-tenant";
import { recordAuditEvent } from "@/server/audit/service";
import { publishTenantEvent } from "@/server/realtime/publish";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { money, restockRefundedLines } from "@/server/ordering/service";
import { orders, orderItems, type Order, type OrderItem } from "@/server/ordering/schema";
import { branches } from "@/server/branches/schema";
import { orderPayments } from "./tender-schema";
import { refunds, refundLines, refundPayments } from "./refund-schema";
import { resolveAuthorizer } from "./grants";
import { REASON_CODES, type ReasonCode } from "./record-sale";
import { PosRefundError } from "./errors";
import type { Permission } from "@/server/rbac/permissions";
import { isFiscalEnabled, enqueueFiscalDocument } from "@/server/fiscal/enqueue";
// `@/server/fiscal/decimal` is a PURE, side-effect-free module (scaled-bigint
// string arithmetic — no db, no config, no I/O), so the refund domain imports
// it rather than growing a second, drifting copy of exact money math.
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

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The tender methods a refund may move money OUT on (mirrors refund_method enum). */
const REFUND_METHODS = ["cash", "card", "store_credit", "other"] as const;

export type RefundActor = {
  tenantId: string;
  branchId: string;
  actorUserId: string;
  permissions: Permission[];
};

export type RefundLineInput = {
  orderItemId: string;
  quantity: number;
  amount: number;
  restock: boolean;
};

export type RefundPaymentInput = {
  method: "cash" | "card" | "store_credit" | "other";
  amount: number;
  reference?: string;
};

export type RefundInput = {
  orderId: string;
  kind: "full" | "partial";
  lines: RefundLineInput[];
  payments: RefundPaymentInput[];
  reasonCode: ReasonCode;
  reasonText?: string;
  clientRefundId: string;
  shiftId?: string | null;
  grantToken?: string;
};

/** The VAT this refund carries: the header figure and, for an itemised refund,
 *  one figure per input line in the SAME order as `RefundInput.lines`. */
type RefundVat = { headerVat: string; lineVats: string[] };

/**
 * The VAT contained in a refund — the one new money computation in the refund
 * domain, done ONCE here so every downstream reader (the fiscal return receipt
 * above all) maps a stored figure instead of re-deriving one.
 *
 * WHY IT EXISTS. `refunds` stored only money, so an EG tenant's return receipt
 * had no VAT to reverse and the tenant over-declared output VAT on every
 * refund. The order already knows its VAT (`orders.vatAmount`, written by
 * `computeOrderTotals`); what was missing was *how much of it came back*.
 *
 * THE BASIS, MIRRORING `computeOrderTotals` (src/lib/order-totals.ts:23-38,
 * and its cart wrapper at :54-71). VAT is charged on
 * `taxable = subtotal − discount + serviceCharge`; `deliveryFee` is OUTSIDE the
 * taxable base and therefore carries no VAT and never appears below.
 * `orders.subtotal` is already the discounted subtotal (placeOrder passes
 * `subtotal − orderDiscount` into `computeOrderTotals`), and each
 * `order_items.lineTotal` is already net of its own line discount, so the two
 * are consistent weights for a proportional split.
 *
 * THE SERVICE-CHARGE DECISION (and its consequence). The service charge is
 * order-level: it bears VAT but has no `order_items` row to hang it on. It is
 * therefore given its OWN weight bucket, and a PARTIAL refund's item lines only
 * ever claim the item bucket. The consequence, stated plainly: an itemised
 * partial refund reverses exactly the VAT inside the money handed back for
 * those items and NOT the service charge's VAT share — that share stays
 * declared until the balance itself is refunded. The alternative — spreading
 * the service charge's VAT across the items — would make a line's stored VAT
 * exceed the VAT actually contained in that line's refunded amount (on a 14%
 * VAT-inclusive 100.00 item under a 10% service charge: 6.14 of VAT in 50.00
 * returned, but 6.76 stored), i.e. it would over-reverse output VAT.
 * Under-reversing a service charge nobody itemises is the safe side of that
 * trade, and the refund of the balance is what recovers it.
 *
 * THE ITEMISED-FULL TOP-UP. A `full` refund whose payments cover the whole
 * outstanding balance returns ALL the remaining money — the service charge
 * included — so ALL the remaining VAT belongs in its stored figures, whether or
 * not the refund happened to name lines. Left as Σ lines, an itemised full
 * refund would orphan the service charge's share permanently: no balance
 * remains for a later refund to recover it (unlike the partial case above). So
 * the residual `remaining − Σ lines` is distributed across THIS refund's lines,
 * largest-remainder over their amounts, making `Σ lines == header == remaining`
 * — which is also what Task 2's `Σ taxableItems == taxTotals` reconciliation
 * needs. Attributing an order-level charge's VAT to product lines is the same
 * documented pro-rata simplification round 1's full-refund gross split already
 * makes (`finalize.ts` resolveFullRefundLines). An itemised full refund of LESS
 * than the balance is a goodwill payment that leaves money outstanding, so it
 * gets no top-up.
 *
 * EXACTNESS, AND WHAT IS AND IS NOT FLOAT-FREE. Every split is
 * `allocateLargestRemainder`, so the parts sum to the whole to the cent, and
 * each item's VAT is split again across its own UNITS — so a 1-of-2 return
 * takes one unit's cents and a later 1-of-2 return takes the rest. (A
 * `lineVat × qty/orderQty` half-up would store 4.10 twice against a line whose
 * VAT is 8.19, reversing a cent that was never charged, and would then trip the
 * invariant below on a perfectly legitimate second return.) All arithmetic
 * introduced here is scaled-BigInt end to end. Two INPUTS are not: `thisTotal`
 * and `outstanding` arrive as `money(n)` of pre-existing float sums
 * (issueRefund's `thisTotal`/`netPaid`, computed with `round2` at :420-424).
 * That is deliberate — they are the very figures the net-paid ceiling enforces
 * and `refunds.totalAmount` stores, so the VAT scales against exactly the money
 * the refund recorded rather than a second, differently-derived total.
 */
async function computeRefundVat(
  tx: Tx,
  order: Order,
  kind: RefundInput["kind"],
  lines: RefundLineInput[],
  items: OrderItem[],
  alreadyReturned: Map<string, number>,
  thisTotal: string,
  outstanding: string,
): Promise<RefundVat> {
  const priorRefunds = await tx
    .select({ vatAmount: refunds.vatAmount })
    .from(refunds)
    .where(eq(refunds.orderId, order.id));
  const priorVat = sumDecimal("prior refund VAT", priorRefunds.map((r) => r.vatAmount));
  const remaining = subtractDecimal("remaining order VAT", order.vatAmount, priorVat);
  // A full refund that clears the balance takes the rest of the VAT with it,
  // lines or no lines — see THE ITEMISED-FULL TOP-UP above.
  const clearsBalance = kind === "full" && compareDecimal(thisTotal, outstanding) >= 0;

  const lineVats = lines.length
    ? topUpToRemaining(itemisedLineVat(order, lines, items, alreadyReturned), lines, clearsBalance ? remaining : null)
    : [];
  const headerVat = lines.length
    ? sumDecimal("refund VAT", lineVats)
    : headerlessRefundVat(remaining, thisTotal, outstanding);

  // INVARIANT: an order's refunds may never reverse more VAT than the order
  // charged. It holds by construction within either path on its own, but not
  // ACROSS them: a goodwill full refund takes a scaled share of the remaining
  // VAT without naming items, and itemising those same units afterwards would
  // claim their VAT a second time. Fail closed — a refund that cannot be
  // accounted for honestly is refused, not silently clamped.
  if (compareDecimal(addDecimal("refund VAT", priorVat, headerVat), order.vatAmount) > 0) {
    throw new PosRefundError(
      `This refund would reverse ${headerVat} of VAT on top of ${priorVat} already returned, above the ${order.vatAmount} the order charged` +
        " — this order's items were already covered by an earlier goodwill refund; issue this as a full refund without item lines instead",
    );
  }

  return { headerVat, lineVats };
}

/** The VAT of each refunded line: the order's VAT split over the service-charge
 *  and item buckets, then over the items, then over each item's units — with
 *  the units already returned by earlier refunds skipped. */
function itemisedLineVat(
  order: Order,
  lines: RefundLineInput[],
  items: OrderItem[],
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
 * Lifts a full refund's line VATs so they sum to `remaining` — the order's VAT
 * not yet reversed — by spreading the residual across the lines largest-
 * remainder over the money each returned. `null` (a partial refund, or a
 * goodwill full refund that leaves a balance) passes the lines through
 * untouched.
 *
 * The residual is normally positive (the service charge's share, which item
 * weights withhold). It can be negative when an earlier goodwill refund already
 * took part of the VAT unattributed, and then this correctly scales the lines
 * DOWN — the order's declared VAT is a ceiling, enforced PER LINE and not only
 * on the header: a pro-rata scale-down can drive an individual line past zero
 * (a full refund's line amounts are never validated against its tenders, so
 * amounts and VAT weights can point in opposite directions — 190.00/10.00 items
 * refunded as 10.00/190.00 lines), and a NEGATIVE `refund_lines.vatAmount`
 * would be an invented input tax credit on the return document. So each pass
 * floors the offenders at zero and re-spreads what they could not absorb over
 * the lines still carrying VAT, until every line is >= 0 and the parts still sum
 * to `remaining` exactly.
 */
function topUpToRemaining(lineVats: string[], lines: RefundLineInput[], remaining: string | null): string[] {
  if (remaining === null) return lineVats;
  const residual = subtractDecimal("refund VAT top-up", remaining, sumDecimal("refund VAT", lineVats));
  if (isZeroDecimal(residual)) return lineVats;
  // Weight by the money each line returned; a full refund need not itemise its
  // amounts at all (only a partial must equal its tenders), so a set of
  // zero-amount lines falls back to the quantities, which are always present.
  const amounts = lines.map((l) => money(l.amount));
  const weights = isZeroDecimal(sumDecimal("refund line amounts", amounts))
    ? lines.map((l) => String(l.quantity))
    : amounts;
  const shares = allocateLargestRemainder("refund VAT top-up", residual, weights);
  return floorLineVatsAt0(lineVats.map((vat, i) => addDecimal("refund line VAT", vat, shares[i])), remaining);
}

/**
 * Clips negative line VATs to zero and pushes the shortfall onto the lines that
 * can still absorb it, weighted by what they currently hold, until Σ parts is
 * `target` again with nothing below zero.
 *
 * Each pass zeroes at least one line and never revives one, so it terminates in
 * at most one pass per line; the bounded loop is belt-and-braces against a
 * future edit breaking that. When every line floors, Σ is 0 — which can only be
 * consistent if `target` is 0 too, and the invariant in `computeRefundVat`
 * already guarantees `target >= 0`, so a non-zero target there is a bug and
 * says so rather than silently storing a header its lines contradict.
 */
function floorLineVatsAt0(parts: string[], target: string): string[] {
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
        throw new Error(`fiscal: cannot floor refund line VAT at 0 and still total ${target}`);
      }
      return clipped;
    }
    const shares = allocateLargestRemainder("floored refund line VAT", shortfall, absorbing.map(({ p }) => p));
    const share = new Map(absorbing.map(({ i }, k) => [i, shares[k]]));
    current = clipped.map((p, i) => addDecimal("refund line VAT", p, share.get(i) ?? "0.00"));
  }
  throw new Error("fiscal: refund line VAT flooring did not converge");
}

/**
 * The VAT of a HEADERLESS (goodwill or whole-balance) full refund, which names
 * no items: the order's VAT not yet reversed by earlier refunds, scaled by the
 * share of the outstanding balance actually handed back (2dp, half-up). A
 * refund of the whole balance therefore reverses the whole remaining VAT —
 * including the service charge's share, which no item line claims.
 */
function headerlessRefundVat(remaining: string, thisTotal: string, outstanding: string): string {
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

export type RefundResult = {
  refundId: string;
  totalAmount: number;
  paymentStatus: Order["paymentStatus"];
  idempotent: boolean;
};

/**
 * Returns money against a completed, paid sale — full or partial — in ONE
 * withTenant transaction. Idempotent on (orderId, clientRefundId); gated by
 * pos:refund through resolveAuthorizer (a manager grant lets a pos:sell-only
 * cashier refund, captured as authorizedByUserId). The original order is never
 * mutated: only the three refund tables are written plus the DERIVED
 * payment_status on the order. Each refund also stores the VAT it takes back
 * (header and per line — see computeRefundVat), computed once here from the
 * order's stored figures so the fiscal layer reverses a recorded number rather
 * than re-deriving one months later. Any failure rolls back the whole refund —
 * including, for an EG tenant, its fiscal `return_receipt` enqueue (step 10
 * below): unlike the sale path's after-commit, catch-and-log enqueue
 * (record-sale.ts), this one runs INSIDE the refund's own transaction on
 * purpose, because the refund has not yet been handed to a customer.
 */
export async function issueRefund(
  actor: RefundActor,
  input: RefundInput,
): Promise<RefundResult> {
  if (!REASON_CODES.includes(input.reasonCode))
    throw new PosRefundError("Unknown reason code");
  if (input.kind !== "full" && input.kind !== "partial")
    throw new PosRefundError("Invalid refund kind");

  // Malformed body: a caller that omitted lines/payments gets a clean
  // PosRefundError here — the refund route maps it to 400, never a 500.
  const payments = input.payments ?? [];
  const lines = input.lines ?? [];
  if (!payments.length)
    throw new PosRefundError("A refund needs at least one refund payment");
  for (const p of payments) {
    if (!REFUND_METHODS.some((m) => m === p.method))
      throw new PosRefundError("Unknown refund payment method");
    if (
      !(
        typeof p.amount === "number" &&
        Number.isFinite(p.amount) &&
        p.amount > 0
      )
    ) {
      throw new PosRefundError("A refund payment must be a positive number");
    }
  }

  // Authorize BEFORE the transaction. resolveAuthorizer throws PosForbiddenError
  // when the actor lacks pos:refund and has no (valid) grant. RefundActor is
  // structurally a PosAuthorizerContext — no cast needed.
  const authorizer = await resolveAuthorizer(
    {
      tenantId: actor.tenantId,
      cashierUserId: actor.actorUserId,
      permissions: actor.permissions,
    },
    "pos:refund",
    input.grantToken,
  );
  const authorizedByUserId =
    authorizer === actor.actorUserId ? null : authorizer;

  // Fiscal (Spec 11): read BEFORE the transaction — same reason as
  // resolveAuthorizer just above, not just the same convention. `withTenant`
  // below holds ONE pool connection for the whole transaction;
  // isFiscalEnabled queries through the global `db`, i.e. a SECOND
  // connection. pg-pool here defaults to max=10 with connectionTimeoutMillis
  // =0 (wait forever for a free connection) — ten concurrent EG refunds each
  // holding their tx's connection while blocked waiting on a second one
  // deadlocks the whole pool permanently. Reading it here, before `tx`
  // exists, means this path only ever holds one connection at a time.
  // `country` is a stable tenant attribute (see isFiscalEnabled's own JSDoc)
  // so a pre-transaction read is not a staleness risk. DO NOT move this back
  // inside the transaction.
  const fiscalEnabled = await isFiscalEnabled(actor.tenantId);

  const result = await withTenant(actor.tenantId, async (tx) => {
    // 1. SERIALIZE refunds per order. The net-paid ceiling is a read-then-write
    //    under READ COMMITTED; without a row lock two concurrent refunds on the
    //    same order (e.g. a dashboard manager and a POS cashier at the same
    //    moment, with different clientRefundIds) could both read the same
    //    "still refundable" number, both pass the ceiling, and BOTH commit —
    //    over-refunding a sale. Locking the order row first makes the loser
    //    wait, then re-read fresh paid data and reject. It also serializes a
    //    concurrent duplicate clientRefundId onto the refunds_order_client
    //    unique index — the loser becomes an idempotent replay, not a 500.
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .for("update")
      .limit(1);
    if (!order) throw new PosRefundError("Unknown order");
    if (order.status === "cancelled" || order.status === "rejected")
      throw new PosRefundError("A voided order has no settled money to refund");
    if (
      order.paymentStatus === "unpaid" ||
      order.paymentStatus === "pending_verification"
    ) {
      throw new PosRefundError(
        "An unpaid order has nothing to refund — void it instead",
      );
    }

    // 2. Branch attribution is owned server-side: the refund's branch must be a
    //    branch of THIS tenant (the FK only proves it exists, which is why a
    //    client-supplied branchId on the dashboard was a hole).
    const [branch] = await tx
      .select({ id: branches.id })
      .from(branches)
      .where(
        and(
          eq(branches.id, actor.branchId),
          eq(branches.tenantId, actor.tenantId),
        ),
      )
      .limit(1);
    if (!branch)
      throw new PosRefundError("Refund branch does not belong to this tenant");

    // 3. Idempotency — INSIDE withTenant because refunds is RLS-scoped (unlike
    //    pos_order_receipts, which has no RLS and is checked outside). The order
    //    is already locked, so a replay observes the settled state.
    const [dup] = await tx
      .select()
      .from(refunds)
      .where(
        and(
          eq(refunds.orderId, input.orderId),
          eq(refunds.clientRefundId, input.clientRefundId),
        ),
      )
      .limit(1);
    if (dup) {
      return {
        refundId: dup.id,
        totalAmount: Number(dup.totalAmount),
        paymentStatus: order.paymentStatus,
        idempotent: true,
      };
    }

    // 4. Net-paid ceiling. order_payments.amount is the APPLIED amount (change
    //    is a separate column, never subtracted here), so gross = Σ amount.
    //    Net-paid = Σ order_payments − Σ prior refund_payments. This refund's
    //    payments may never push cumulative refunds past it.
    const tenders = await tx
      .select()
      .from(orderPayments)
      .where(eq(orderPayments.orderId, input.orderId));
    const prior = await tx
      .select({ refundPayment: refundPayments })
      .from(refundPayments)
      .innerJoin(refunds, eq(refundPayments.refundId, refunds.id))
      .where(eq(refunds.orderId, input.orderId));
    const netPaid = round2(
      tenders.reduce((s, t) => s + Number(t.amount), 0) -
        prior.reduce((s, r) => s + Number(r.refundPayment.amount), 0),
    );
    const thisTotal = round2(payments.reduce((s, p) => s + p.amount, 0));
    if (thisTotal > netPaid + 0.001)
      throw new PosRefundError("Refund exceeds the amount still refundable");

    // 5. Per-line quantity bounds. Applied to ANY refund that names lines (an
    //    itemised full refund included) — "return three of two" is wrong in
    //    every kind. Already-refunded quantities count against the remaining.
    //    Both reads are hoisted out of the loop because step 5b needs the same
    //    two facts — what was sold and what has come back — to split the VAT.
    const items = lines.length
      ? await tx.select().from(orderItems).where(eq(orderItems.orderId, input.orderId))
      : [];
    const priorLines = lines.length
      ? await tx
          .select({ refundLine: refundLines })
          .from(refundLines)
          .innerJoin(refunds, eq(refundLines.refundId, refunds.id))
          .where(eq(refunds.orderId, input.orderId))
      : [];
    const alreadyReturned = new Map<string, number>();
    for (const p of priorLines) {
      alreadyReturned.set(
        p.refundLine.orderItemId,
        (alreadyReturned.get(p.refundLine.orderItemId) ?? 0) + p.refundLine.quantity,
      );
    }
    if (lines.length > 0) {
      for (const l of lines) {
        const item = items.find((i) => i.id === l.orderItemId);
        if (!item)
          throw new PosRefundError("Refund line does not belong to this order");
        const already = alreadyReturned.get(l.orderItemId) ?? 0;
        if (l.quantity < 1 || l.quantity > item.quantity - already)
          throw new PosRefundError("Cannot return more than was sold");
      }
    }

    // A partial refund must be line-itemised and its line amounts must equal the
    // tenders (R8). A full refund may be headerless (goodwill) or itemised; the
    // net-paid ceiling above already bounds the money either way.
    if (input.kind === "partial") {
      if (!lines.length)
        throw new PosRefundError("A partial refund needs at least one line");
      const lineTotal = round2(lines.reduce((s, l) => s + l.amount, 0));
      if (Math.abs(lineTotal - thisTotal) > 0.001)
        throw new PosRefundError(
          "Refund line amounts must equal the refund payments",
        );
    }

    // 5b. The VAT this refund takes back, computed from the order's STORED
    //     figures now that the line amounts are settled — see computeRefundVat.
    //     `netPaid` is the balance outstanding immediately before this refund,
    //     the same figure the ceiling above enforces, so a goodwill full refund
    //     scales against what was actually still owed back.
    const { headerVat, lineVats } = await computeRefundVat(
      tx, order, input.kind, lines, items, alreadyReturned, money(thisTotal), money(netPaid),
    );

    // 6. Insert header → lines → payments. All-or-nothing inside withTenant.
    const [refund] = await tx
      .insert(refunds)
      .values({
        tenantId: actor.tenantId,
        orderId: input.orderId,
        branchId: actor.branchId,
        kind: input.kind,
        reasonCode: input.reasonCode,
        reasonText: input.reasonText ?? null,
        totalAmount: money(thisTotal),
        vatAmount: headerVat,
        byUserId: actor.actorUserId,
        authorizedByUserId,
        shiftId: input.shiftId ?? null,
        clientRefundId: input.clientRefundId,
      })
      .returning();

    if (lines.length) {
      await tx.insert(refundLines).values(
        lines.map((l, i) => ({
          tenantId: actor.tenantId,
          refundId: refund.id,
          orderItemId: l.orderItemId,
          quantity: l.quantity,
          amount: money(l.amount),
          vatAmount: lineVats[i],
          restock: l.restock,
        })),
      );
    }
    await tx.insert(refundPayments).values(
      payments.map((p) => ({
        tenantId: actor.tenantId,
        refundId: refund.id,
        method: p.method,
        amount: money(p.amount),
        reference: p.reference ?? null,
        takenByUserId: actor.actorUserId,
      })),
    );

    // 7. Restock each restock=true line (integer fallback now; Spec 8's
    //    refund_restock ledger is the forward path — no issueRefund change).
    //    NOTE for merge coordination: feat/inventory-core-and-recipes reworks
    //    stock math — this restock path must be realigned to the new inventory
    //    core when that branch lands, or line restocks will double-count.
    await restockRefundedLines(tx, actor.tenantId, lines);

    // 8. payment_status is DERIVED from the math, never set by hand. If this
    //    refund clears net-paid, the order is fully refunded; else partially.
    const paymentStatus: Order["paymentStatus"] =
      round2(netPaid - thisTotal) <= 0.001 ? "refunded" : "partially_refunded";
    await tx
      .update(orders)
      .set({ paymentStatus, updatedAt: new Date() })
      .where(eq(orders.id, input.orderId));

    // 9. Audit — DIRECT recordAuditEvent, same tx, so the refund.issued row
    //    commits/rolls back with the refund. The audit chain is live on-branch
    //    (unlike the plan's seam premise), so this matches record-sale's
    //    sale.recorded pattern rather than a settable emitter. RefundActor has
    //    no device fingerprint (a refund may come from a dashboard user, #112/
    //    #115), so the canonical empty fingerprint is used; attribution is the
    //    actor id, with the manager who authorized captured in metadata.
    await recordAuditEvent(
      {
        tenantId: actor.tenantId,
        branchId: actor.branchId,
        actorUserId: actor.actorUserId,
        fingerprint: emptyFingerprint(),
      },
      {
        action: "refund.issued",
        entityType: "refund",
        entityId: refund.id,
        summary: `Refund ${money(thisTotal)} (${input.kind}) — ${input.reasonCode}`,
        metadata: {
          orderId: input.orderId,
          kind: input.kind,
          totalAmount: money(thisTotal),
          reasonCode: input.reasonCode,
          paymentStatus,
          byUserId: actor.actorUserId,
          authorizedByUserId,
        },
      },
      tx,
    );

    // 10. Fiscal (Spec 11): enqueue a pending return_receipt IN THIS SAME
    //     transaction, atomic with the refund — deliberately unlike the sale
    //     path (record-sale.ts), whose enqueue runs AFTER commit and
    //     swallows its own errors. Here a failed insert rolls the refund
    //     back WITH it, which is correct: unlike a completed sale, this
    //     refund has not yet been handed to a customer, so refusing the
    //     whole operation on a fiscal-write failure is safe and keeps "a
    //     refund exists" and "its fiscal record was durably queued" from
    //     ever diverging. docType is `return_receipt` — the addendum's B2C
    //     refund document (see eta_submissions' JSDoc) — never `credit_note`,
    //     which stays reserved for the deferred B2B e-invoice correction.
    //     `fiscalEnabled` was read ABOVE the transaction (pool-deadlock
    //     avoidance — see that comment); only the WRITE belongs in here.
    if (fiscalEnabled) {
      await enqueueFiscalDocument({ tenantId: actor.tenantId }, { docType: "return_receipt", refundId: refund.id }, tx);
    }

    return {
      refundId: refund.id,
      totalAmount: thisTotal,
      paymentStatus,
      idempotent: false,
    };
  });

  // Post-commit, and only for a refund that actually happened: the sale's row
  // and the stock it put back both moved, and neither screen should wait out a
  // poll to hear it.
  if (!result.idempotent) {
    await publishTenantEvent(actor.tenantId, { type: "orders.changed", entityIds: [input.orderId] });
    await publishTenantEvent(actor.tenantId, { type: "stock.changed", entityIds: [input.orderId] });
  }
  return result;
}
