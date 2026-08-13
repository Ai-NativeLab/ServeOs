import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { placeOrder, money, type PlaceOrderLine } from "@/server/ordering/service";
import { orders } from "@/server/ordering/schema";
import type { Permission } from "@/server/rbac/permissions";
import { posOrderReceipts } from "./schema";
import { orderPayments, posAdjustmentEvents } from "./tender-schema";
import { posShifts } from "./shift-schema";
import { findOpenShift } from "./shifts";
import { resolveAuthorizer } from "./grants";
import { NoOpenShiftError, PosSaleError } from "./errors";
import type { PosCashierContext } from "./require-cashier";
import { recordAuditEvent } from "@/server/audit/service";

export const REASON_CODES = [
  "staff_meal", "comp_service", "promo", "manager_discretion",
  "wrong_item", "customer_changed_mind", "other",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export type TenderInput = {
  clientPaymentId: string;
  method: "cash" | "card" | "other";
  amount: number;
  tipAmount?: number;
  tenderedAmount?: number;
  reference?: string;
};

export type RecordSaleInput = {
  clientOrderId: string;
  lines: PlaceOrderLine[];
  orderDiscountAmount?: number;
  orderDiscountReason?: ReasonCode;
  expectedTotal: number;
  payments: TenderInput[];
  grants?: { permission: Permission; token: string }[];
  notes?: string;
};

export type SaleReceipt = {
  orderId: string;
  orderNumber: string;
  total: number;
  paidAmount: number;
  changeAmount: number;
  paymentStatus: "paid" | "partially_paid";
  idempotent: boolean;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function recordSale(ctx: PosCashierContext, input: RecordSaleInput): Promise<SaleReceipt> {
  // Idempotency: a retried submit returns the original sale rather than
  // charging the customer twice. `pos_order_receipts` has no RLS.
  const [existing] = await db
    .select()
    .from(posOrderReceipts)
    .where(and(
      eq(posOrderReceipts.deviceId, ctx.deviceId),
      eq(posOrderReceipts.clientOrderId, input.clientOrderId),
    ))
    .limit(1);

  if (existing) {
    const [order] = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(orders).where(eq(orders.id, existing.orderId)).limit(1),
    );
    const tenders = await db.select().from(orderPayments).where(eq(orderPayments.orderId, existing.orderId));
    const paidAmount = round2(tenders.reduce((s, t) => s + Number(t.amount), 0));
    return {
      orderId: existing.orderId,
      orderNumber: existing.orderNumber,
      total: Number(order.total),
      paidAmount,
      changeAmount: round2(tenders.reduce((s, t) => s + Number(t.changeAmount ?? 0), 0)),
      paymentStatus: order.paymentStatus === "paid" ? "paid" : "partially_paid",
      idempotent: true,
    };
  }

  // Cash must land in an accounted drawer. Resolve the device's shift once,
  // before placeOrder, so a refusal leaves no orphan order behind. Card/other
  // tenders are allowed with no shift and simply carry a null shiftId.
  const shift = await findOpenShift(ctx.tenantId, ctx.deviceId);
  if (!shift && input.payments.some((p) => p.method === "cash")) throw new NoOpenShiftError();

  // Authorize every discount BEFORE writing anything. resolveAuthorizer throws
  // PosForbiddenError when the cashier lacks the permission and has no grant.
  const grantFor = (p: Permission) => input.grants?.find((g) => g.permission === p)?.token;
  const hasLineDiscount = input.lines.some((l) => (l.discountAmount ?? 0) > 0);
  const hasOrderDiscount = (input.orderDiscountAmount ?? 0) > 0;
  const discountAuthorizer = hasLineDiscount || hasOrderDiscount
    ? await resolveAuthorizer(ctx, "pos:discount", grantFor("pos:discount"))
    : null;

  // Validate tenders before touching the DB.
  for (const p of input.payments) {
    if (!(p.amount > 0)) throw new PosSaleError("A tender must be a positive amount");
    if (p.method !== "cash" && p.tenderedAmount !== undefined && p.tenderedAmount !== p.amount) {
      throw new PosSaleError("Only a cash tender can give change");
    }
  }

  const placed = await placeOrder(ctx.tenantId, {
    branchId: ctx.branchId,
    fulfillmentType: "pickup",
    customerName: "Walk-in",
    customerPhone: "000000000",
    notes: input.notes,
    lines: input.lines,
    channel: "pos",
    cashierUserId: ctx.cashierUserId,
    orderDiscountAmount: input.orderDiscountAmount,
    orderDiscountReason: input.orderDiscountReason,
    expectedTotal: input.expectedTotal,
    audit: { fingerprint: ctx.fingerprint, actorUserId: ctx.cashierUserId, actorType: "user" },
  });

  const paidAmount = round2(input.payments.reduce((s, p) => s + p.amount, 0));
  if (paidAmount > placed.total + 0.001) {
    throw new PosSaleError("Tenders exceed the amount due");
  }

  // Only cash produces change: it is the difference between what was handed
  // over and what was applied to the order.
  let changeAmount = 0;
  const tenderRows = input.payments.map((p) => {
    const change = p.method === "cash" && p.tenderedAmount !== undefined
      ? Math.max(0, round2(p.tenderedAmount - p.amount))
      : 0;
    changeAmount = round2(changeAmount + change);
    return {
      tenantId: ctx.tenantId,
      orderId: placed.orderId,
      method: p.method,
      amount: money(p.amount),
      tipAmount: money(p.tipAmount ?? 0),
      tenderedAmount: p.tenderedAmount !== undefined ? money(p.tenderedAmount) : null,
      changeAmount: p.method === "cash" ? money(change) : null,
      reference: p.reference ?? null,
      takenByUserId: ctx.cashierUserId,
      shiftId: shift?.id ?? null,
      clientPaymentId: p.clientPaymentId,
    };
  });

  const paymentStatus: "paid" | "partially_paid" =
    paidAmount >= placed.total - 0.001 ? "paid" : "partially_paid";

  await withTenant(ctx.tenantId, async (tx) => {
    if (tenderRows.length > 0) await tx.insert(orderPayments).values(tenderRows);

    const events = [];
    input.lines.forEach((line, i) => {
      if ((line.discountAmount ?? 0) > 0) {
        events.push({
          tenantId: ctx.tenantId,
          orderId: placed.orderId,
          orderItemId: placed.itemIds[i],
          type: "line_discount" as const,
          amount: money(line.discountAmount!),
          reasonCode: line.discountReason ?? "other",
          byUserId: ctx.cashierUserId,
          authorizedByUserId: discountAuthorizer!,
        });
      }
    });
    if (hasOrderDiscount) {
      events.push({
        tenantId: ctx.tenantId,
        orderId: placed.orderId,
        orderItemId: null,
        type: "order_discount" as const,
        amount: money(input.orderDiscountAmount!),
        reasonCode: input.orderDiscountReason ?? "other",
        byUserId: ctx.cashierUserId,
        authorizedByUserId: discountAuthorizer!,
      });
    }
    if (events.length > 0) await tx.insert(posAdjustmentEvents).values(events);

    await tx.update(orders).set({ paymentStatus, updatedAt: new Date() }).where(eq(orders.id, placed.orderId));

    // Emit the audit chain for this sale on the SAME tx. order.placed was already
    // appended by placeOrder above; discount.* rows come next, and sale.recorded
    // last so it is the tip. Forward emission points (void.line, void.order,
    // refund.*, inventory/PO/ETA events) attach to this same helper in
    // Specs 3/8/9/11 — no chain change.
    const auditCtx = { tenantId: ctx.tenantId, branchId: ctx.branchId, actorUserId: ctx.cashierUserId, fingerprint: ctx.fingerprint };
    for (let i = 0; i < input.lines.length; i++) {
      const line = input.lines[i];
      if ((line.discountAmount ?? 0) > 0) {
        await recordAuditEvent(auditCtx, {
          action: "discount.line_applied", entityType: "order", entityId: placed.orderId,
          summary: `Line discount ${money(line.discountAmount!)}`,
          metadata: { orderItemId: placed.itemIds[i], amount: money(line.discountAmount!), reasonCode: line.discountReason ?? "other", byUserId: ctx.cashierUserId, authorizedByUserId: discountAuthorizer },
          actorType: "user",
        }, tx);
      }
    }
    if (hasOrderDiscount) {
      await recordAuditEvent(auditCtx, {
        action: "discount.order_applied", entityType: "order", entityId: placed.orderId,
        summary: `Order discount ${money(input.orderDiscountAmount!)}`,
        metadata: { amount: money(input.orderDiscountAmount!), reasonCode: input.orderDiscountReason ?? "other", byUserId: ctx.cashierUserId, authorizedByUserId: discountAuthorizer },
        actorType: "user",
      }, tx);
    }
    await recordAuditEvent(auditCtx, {
      action: "sale.recorded", entityType: "order", entityId: placed.orderId,
      summary: `Sale #${placed.orderNumber} — ${paymentStatus}`,
      metadata: {
        orderNumber: String(placed.orderNumber), total: money(placed.total), paymentStatus,
        tenders: input.payments.map((p) => ({ method: p.method, amount: money(p.amount) })),
      }, actorType: "user",
    }, tx);
  });

  await db.insert(posOrderReceipts).values({
    deviceId: ctx.deviceId,
    clientOrderId: input.clientOrderId,
    orderId: placed.orderId,
    orderNumber: String(placed.orderNumber),
  });

  return {
    orderId: placed.orderId,
    orderNumber: String(placed.orderNumber),
    total: placed.total,
    paidAmount,
    changeAmount,
    paymentStatus,
    idempotent: false,
  };
}

/** Adds a tender to an existing (typically partially_paid) sale. Idempotent on clientPaymentId. */
export async function addTender(
  ctx: PosCashierContext,
  orderId: string,
  tender: TenderInput,
): Promise<SaleReceipt> {
  if (!(tender.amount > 0)) throw new PosSaleError("A tender must be a positive amount");
  if (tender.method !== "cash" && tender.tenderedAmount !== undefined && tender.tenderedAmount !== tender.amount) {
    throw new PosSaleError("Only a cash tender can give change");
  }

  return withTenant(ctx.tenantId, async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new PosSaleError("Unknown order");

    const existingTenders = await tx.select().from(orderPayments).where(eq(orderPayments.orderId, orderId));
    const already = existingTenders.find((t) => t.clientPaymentId === tender.clientPaymentId);

    const paidBefore = round2(existingTenders.reduce((s, t) => s + Number(t.amount), 0));
    const total = Number(order.total);

    if (!already) {
      if (paidBefore + tender.amount > total + 0.001) {
        throw new PosSaleError("Tender exceeds the amount due");
      }
      // Resolved on this tx so the stamp and the tender commit together. Only a
      // genuinely new tender needs a drawer — a retry of one already recorded
      // must stay idempotent even if that shift has since closed.
      const [shift] = await tx.select().from(posShifts)
        .where(and(eq(posShifts.deviceId, ctx.deviceId), eq(posShifts.status, "open")))
        .limit(1);
      if (tender.method === "cash" && !shift) throw new NoOpenShiftError();

      const change = tender.method === "cash" && tender.tenderedAmount !== undefined
        ? Math.max(0, round2(tender.tenderedAmount - tender.amount))
        : 0;
      await tx.insert(orderPayments).values({
        tenantId: ctx.tenantId,
        orderId,
        method: tender.method,
        amount: money(tender.amount),
        tipAmount: money(tender.tipAmount ?? 0),
        tenderedAmount: tender.tenderedAmount !== undefined ? money(tender.tenderedAmount) : null,
        changeAmount: tender.method === "cash" ? money(change) : null,
        reference: tender.reference ?? null,
        takenByUserId: ctx.cashierUserId,
        shiftId: shift?.id ?? null,
        clientPaymentId: tender.clientPaymentId,
      });
    }

    const after = await tx.select().from(orderPayments).where(eq(orderPayments.orderId, orderId));
    const paidAmount = round2(after.reduce((s, t) => s + Number(t.amount), 0));
    const paymentStatus: "paid" | "partially_paid" =
      paidAmount >= total - 0.001 ? "paid" : "partially_paid";

    await tx.update(orders).set({ paymentStatus, updatedAt: new Date() }).where(eq(orders.id, orderId));

    // Only a genuinely new tender advances the chain — a retried clientPaymentId
    // is idempotent and must not append a second audit row.
    if (!already) {
      await recordAuditEvent(
        { tenantId: ctx.tenantId, branchId: ctx.branchId, actorUserId: ctx.cashierUserId, fingerprint: ctx.fingerprint },
        { action: "payment.tender_added", entityType: "order", entityId: orderId,
          summary: `Tender ${tender.method} ${money(tender.amount)}`,
          metadata: { method: tender.method, amount: money(tender.amount), paymentStatus }, actorType: "user" },
        tx,
      );
    }

    return {
      orderId,
      orderNumber: String(order.orderNumber),
      total,
      paidAmount,
      changeAmount: round2(after.reduce((s, t) => s + Number(t.changeAmount ?? 0), 0)),
      paymentStatus,
      idempotent: Boolean(already),
    };
  });
}
