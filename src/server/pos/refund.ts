import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { money, restockRefundedLines } from "@/server/ordering/service";
import { orders, orderItems, type Order } from "@/server/ordering/schema";
import { orderPayments } from "./tender-schema";
import { refunds, refundLines, refundPayments } from "./refund-schema";
import { resolveAuthorizer } from "./grants";
import { REASON_CODES, type ReasonCode } from "./record-sale";
import { PosRefundError } from "./errors";
import type { Permission } from "@/server/rbac/permissions";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The Drizzle transaction type every withTenant callback receives. */
type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

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

export type RefundResult = {
  refundId: string;
  totalAmount: number;
  paymentStatus: Order["paymentStatus"];
  idempotent: boolean;
};

/**
 * FORWARD DEP (#111): the refund.issued audit emission, atomic with this refund
 * (it receives the same tx). Issue #111 replaces this stub with the settable
 * emitter in refund-audit.ts. Inert today — a refund completes without one and
 * is never blocked by the absence of an emitter.
 */
async function emitRefundIssued(
  _ctx: { tenantId: string; branchId: string; actorUserId: string },
  _event: {
    refundId: string; orderId: string; kind: string; totalAmount: string; reasonCode: string;
    paymentStatus: string; byUserId: string; authorizedByUserId: string | null;
  },
  _tx: Tx,
): Promise<void> {}

/**
 * Returns money against a completed, paid sale — full or partial — in ONE
 * withTenant transaction. Idempotent on (orderId, clientRefundId); gated by
 * pos:refund through resolveAuthorizer (a manager grant lets a pos:sell-only
 * cashier refund, captured as authorizedByUserId). The original order is never
 * mutated: only the three refund tables are written plus the DERIVED
 * payment_status on the order. Any failure rolls back the whole refund.
 */
export async function issueRefund(actor: RefundActor, input: RefundInput): Promise<RefundResult> {
  if (!REASON_CODES.includes(input.reasonCode)) throw new PosRefundError("Unknown reason code");
  if (!input.payments.length) throw new PosRefundError("A refund needs at least one refund payment");
  for (const p of input.payments) if (!(p.amount > 0)) throw new PosRefundError("A refund payment must be positive");

  // Authorize BEFORE the transaction. resolveAuthorizer throws PosForbiddenError
  // when the actor lacks pos:refund and has no (valid) grant. RefundActor is
  // structurally a PosAuthorizerContext — no cast needed.
  const authorizer = resolveAuthorizer(
    { tenantId: actor.tenantId, cashierUserId: actor.actorUserId, permissions: actor.permissions },
    "pos:refund",
    input.grantToken,
  );
  const authorizedByUserId = authorizer === actor.actorUserId ? null : authorizer;

  return withTenant(actor.tenantId, async (tx) => {
    // 1. Idempotency — INSIDE withTenant because refunds is RLS-scoped (unlike
    //    pos_order_receipts, which has no RLS and is checked outside).
    const [dup] = await tx
      .select()
      .from(refunds)
      .where(and(eq(refunds.orderId, input.orderId), eq(refunds.clientRefundId, input.clientRefundId)))
      .limit(1);
    if (dup) {
      const [o] = await tx.select().from(orders).where(eq(orders.id, input.orderId)).limit(1);
      return { refundId: dup.id, totalAmount: Number(dup.totalAmount), paymentStatus: o.paymentStatus, idempotent: true };
    }

    // 2. Load the order. A voided order and an unsettled order have no money to
    //    give back — those route to void (Spec 1), never to a refund.
    const [order] = await tx.select().from(orders).where(eq(orders.id, input.orderId)).limit(1);
    if (!order) throw new PosRefundError("Unknown order");
    if (order.status === "cancelled" || order.status === "rejected") throw new PosRefundError("A voided order has no settled money to refund");
    if (order.paymentStatus === "unpaid" || order.paymentStatus === "pending_verification") {
      throw new PosRefundError("An unpaid order has nothing to refund — void it instead");
    }

    // 3. Net-paid ceiling. order_payments.amount is the APPLIED amount (change
    //    is a separate column, never subtracted here), so gross = Σ amount.
    //    Net-paid = Σ order_payments − Σ prior refund_payments. This refund's
    //    payments may never push cumulative refunds past it.
    const tenders = await tx.select().from(orderPayments).where(eq(orderPayments.orderId, input.orderId));
    const prior = await tx
      .select({ refundPayment: refundPayments })
      .from(refundPayments)
      .innerJoin(refunds, eq(refundPayments.refundId, refunds.id))
      .where(eq(refunds.orderId, input.orderId));
    const netPaid = round2(
      tenders.reduce((s, t) => s + Number(t.amount), 0) -
        prior.reduce((s, r) => s + Number(r.refundPayment.amount), 0),
    );
    const thisTotal = round2(input.payments.reduce((s, p) => s + p.amount, 0));
    if (thisTotal > netPaid + 0.001) throw new PosRefundError("Refund exceeds the amount still refundable");

    // 4. Per-line quantity bounds. Applied to ANY refund that names lines (an
    //    itemised full refund included) — "return three of two" is wrong in
    //    every kind. Already-refunded quantities count against the remaining.
    if (input.lines.length > 0) {
      const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, input.orderId));
      const priorLines = await tx
        .select({ refundLine: refundLines })
        .from(refundLines)
        .innerJoin(refunds, eq(refundLines.refundId, refunds.id))
        .where(eq(refunds.orderId, input.orderId));
      for (const l of input.lines) {
        const item = items.find((i) => i.id === l.orderItemId);
        if (!item) throw new PosRefundError("Refund line does not belong to this order");
        const already = priorLines
          .filter((p) => p.refundLine.orderItemId === l.orderItemId)
          .reduce((s, p) => s + p.refundLine.quantity, 0);
        if (l.quantity < 1 || l.quantity > item.quantity - already) throw new PosRefundError("Cannot return more than was sold");
      }
    }

    // A partial refund must be line-itemised and its line amounts must equal the
    // tenders (R8). A full refund may be headerless (goodwill) or itemised; the
    // net-paid ceiling above already bounds the money either way.
    if (input.kind === "partial") {
      if (!input.lines.length) throw new PosRefundError("A partial refund needs at least one line");
      const lineTotal = round2(input.lines.reduce((s, l) => s + l.amount, 0));
      if (Math.abs(lineTotal - thisTotal) > 0.001) throw new PosRefundError("Refund line amounts must equal the refund payments");
    }

    // 5. Insert header → lines → payments. All-or-nothing inside withTenant.
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
        byUserId: actor.actorUserId,
        authorizedByUserId,
        shiftId: input.shiftId ?? null,
        clientRefundId: input.clientRefundId,
      })
      .returning();

    if (input.lines.length) {
      await tx.insert(refundLines).values(
        input.lines.map((l) => ({
          tenantId: actor.tenantId,
          refundId: refund.id,
          orderItemId: l.orderItemId,
          quantity: l.quantity,
          amount: money(l.amount),
          restock: l.restock,
        })),
      );
    }
    await tx.insert(refundPayments).values(
      input.payments.map((p) => ({
        tenantId: actor.tenantId,
        refundId: refund.id,
        method: p.method,
        amount: money(p.amount),
        reference: p.reference ?? null,
        takenByUserId: actor.actorUserId,
      })),
    );

    // 6. Restock each restock=true line (integer fallback now; Spec 8's
    //    refund_restock ledger is the forward path — no issueRefund change).
    await restockRefundedLines(tx, actor.tenantId, input.lines);

    // 7. payment_status is DERIVED from the math, never set by hand. If this
    //    refund clears net-paid, the order is fully refunded; else partially.
    const paymentStatus: Order["paymentStatus"] =
      round2(netPaid - thisTotal) <= 0.001 ? "refunded" : "partially_refunded";
    await tx.update(orders).set({ paymentStatus, updatedAt: new Date() }).where(eq(orders.id, input.orderId));

    // 8. Audit — same tx, so it commits/rolls back with the refund (seam — #111).
    await emitRefundIssued(
      { tenantId: actor.tenantId, branchId: actor.branchId, actorUserId: actor.actorUserId },
      {
        refundId: refund.id,
        orderId: input.orderId,
        kind: input.kind,
        totalAmount: money(thisTotal),
        reasonCode: input.reasonCode,
        paymentStatus,
        byUserId: actor.actorUserId,
        authorizedByUserId,
      },
      tx,
    );

    return { refundId: refund.id, totalAmount: thisTotal, paymentStatus, idempotent: false };
  });
}
