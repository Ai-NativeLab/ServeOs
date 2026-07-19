import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { placeOrder, money, type PlaceOrderLine } from "@/server/ordering/service";
import { orders } from "@/server/ordering/schema";
import type { Permission } from "@/server/rbac/permissions";
import { posOrderReceipts } from "./schema";
import { orderPayments, posAdjustmentEvents } from "./tender-schema";
import { resolveAuthorizer } from "./grants";
import { PosSaleError } from "./errors";
import type { PosCashierContext } from "./require-cashier";

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

  // Authorize every discount BEFORE writing anything. resolveAuthorizer throws
  // PosForbiddenError when the cashier lacks the permission and has no grant.
  const grantFor = (p: Permission) => input.grants?.find((g) => g.permission === p)?.token;
  const hasLineDiscount = input.lines.some((l) => (l.discountAmount ?? 0) > 0);
  const hasOrderDiscount = (input.orderDiscountAmount ?? 0) > 0;
  const discountAuthorizer = hasLineDiscount || hasOrderDiscount
    ? resolveAuthorizer(ctx, "pos:discount", grantFor("pos:discount"))
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
