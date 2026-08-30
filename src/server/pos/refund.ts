import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { recordAuditEvent } from "@/server/audit/service";
import { publishTenantEvent } from "@/server/realtime/publish";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { money, restockRefundedLines } from "@/server/ordering/service";
import { orders, orderItems, type Order } from "@/server/ordering/schema";
import { branches } from "@/server/branches/schema";
import { orderPayments } from "./tender-schema";
import { refunds, refundLines, refundPayments } from "./refund-schema";
import { resolveAuthorizer } from "./grants";
import { REASON_CODES, type ReasonCode } from "./record-sale";
import { PosRefundError } from "./errors";
import type { Permission } from "@/server/rbac/permissions";
import { isFiscalEnabled, enqueueFiscalDocument } from "@/server/fiscal/enqueue";

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
 * payment_status on the order. Any failure rolls back the whole refund —
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
    if (lines.length > 0) {
      const items = await tx
        .select()
        .from(orderItems)
        .where(eq(orderItems.orderId, input.orderId));
      const priorLines = await tx
        .select({ refundLine: refundLines })
        .from(refundLines)
        .innerJoin(refunds, eq(refundLines.refundId, refunds.id))
        .where(eq(refunds.orderId, input.orderId));
      for (const l of lines) {
        const item = items.find((i) => i.id === l.orderItemId);
        if (!item)
          throw new PosRefundError("Refund line does not belong to this order");
        const already = priorLines
          .filter((p) => p.refundLine.orderItemId === l.orderItemId)
          .reduce((s, p) => s + p.refundLine.quantity, 0);
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
        byUserId: actor.actorUserId,
        authorizedByUserId,
        shiftId: input.shiftId ?? null,
        clientRefundId: input.clientRefundId,
      })
      .returning();

    if (lines.length) {
      await tx.insert(refundLines).values(
        lines.map((l) => ({
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
    if (await isFiscalEnabled(actor.tenantId)) {
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
