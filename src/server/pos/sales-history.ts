import { and, desc, eq, gte, inArray, lte, notInArray, sql } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { money } from "@/server/ordering/service";
import { OrderNotFoundError } from "@/server/ordering/errors";
import { orders, orderItems, type Order, type OrderItem } from "@/server/ordering/schema";
import { orderPayments, posAdjustmentEvents, type OrderPayment, type PosAdjustmentEvent } from "./tender-schema";
import {
  refunds, refundLines, refundPayments,
  type Refund, type RefundLine, type RefundPayment,
} from "./refund-schema";

/** The finalized money states a sale can be in (never unpaid/pending_verification). */
const FINALIZED_PAYMENT_STATUSES = ["paid", "partially_paid", "refunded", "partially_refunded"] as const;

export type SalesFilters = {
  dateFrom?: Date;
  dateTo?: Date;
  cashierUserId?: string;
  customerPhone?: string;
  orderNumber?: number;
  amount?: number;
  branchId?: string;
  page?: number;
};

/** The finalized sales of a tenant, newest first, 50/page. Payment-status alone
 *  would include a paid-then-cancelled order (cancelling never resets the money
 *  state), so the terminal order-statuses are excluded explicitly. */
export async function listSales(tenantId: string, filters: SalesFilters): Promise<Order[]> {
  return withTenant(tenantId, (tx) => {
    const conds = [
      inArray(orders.paymentStatus, [...FINALIZED_PAYMENT_STATUSES]),
      notInArray(orders.status, ["cancelled", "rejected"]),
    ];
    if (filters.branchId) conds.push(eq(orders.branchId, filters.branchId));
    if (filters.dateFrom) conds.push(gte(orders.placedAt, filters.dateFrom));
    if (filters.dateTo) conds.push(lte(orders.placedAt, filters.dateTo));
    if (filters.cashierUserId) conds.push(eq(orders.cashierUserId, filters.cashierUserId));
    if (filters.orderNumber !== undefined) conds.push(eq(orders.orderNumber, filters.orderNumber));
    if (filters.customerPhone) conds.push(eq(orders.customerPhone, filters.customerPhone));
    if (filters.amount !== undefined) conds.push(eq(orders.total, money(filters.amount)));
    const page = filters.page ?? 1;
    return tx.select().from(orders).where(and(...conds))
      .orderBy(desc(orders.placedAt)).limit(50).offset((page - 1) * 50);
  });
}

export type RefundWithDetails = Refund & { lines: RefundLine[]; payments: RefundPayment[] };
export type SaleDetail = Order & {
  items: OrderItem[];
  tenders: OrderPayment[];
  adjustments: PosAdjustmentEvent[];
  refunds: RefundWithDetails[];
};

/** One order fully loaded: its line items, its tenders, its adjustment events,
 *  and every refund against it (each nesting its returned lines + tenders). */
export async function getSale(tenantId: string, orderId: string): Promise<SaleDetail> {
  return withTenant(tenantId, async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new OrderNotFoundError();

    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    const tenders = await tx.select().from(orderPayments).where(eq(orderPayments.orderId, orderId));
    const adjustments = await tx.select().from(posAdjustmentEvents).where(eq(posAdjustmentEvents.orderId, orderId));
    const refundRows = await tx.select().from(refunds).where(eq(refunds.orderId, orderId)).orderBy(refunds.createdAt);

    const refundsOut: RefundWithDetails[] = [];
    for (const r of refundRows) {
      const lines = await tx.select().from(refundLines).where(eq(refundLines.refundId, r.id));
      const payments = await tx.select().from(refundPayments).where(eq(refundPayments.refundId, r.id));
      refundsOut.push({ ...r, lines, payments });
    }

    return { ...order, items, tenders, adjustments, refunds: refundsOut };
  });
}

/** The original sale shaped for a receipt re-render, plus one slip per refund
 *  (returned lines + money-OUT tenders) so a reprint shows the returns too. */
export type ReceiptDto = {
  sale: {
    orderNumber: number;
    customerName: string;
    customerPhone: string;
    placedAt: Date;
    total: string;
    paymentStatus: Order["paymentStatus"];
    items: {
      nameEn: string;
      nameAr: string;
      variantNameEn: string | null;
      variantNameAr: string | null;
      quantity: number;
      lineTotal: string;
      discountAmount: string;
      selectedModifiers: OrderItem["selectedModifiers"];
    }[];
    tenders: { method: string; amount: string; tipAmount: string; changeAmount: string | null }[];
    adjustments: { type: string; amount: string; reasonCode: string; reasonText: string | null }[];
  };
  refundSlips: {
    kind: Refund["kind"];
    totalAmount: string;
    reasonCode: string;
    reasonText: string | null;
    byUserId: string;
    authorizedByUserId: string | null;
    createdAt: Date;
    lines: { orderItemId: string; quantity: number; amount: string; restock: boolean }[];
    payments: { method: string; amount: string }[];
  }[];
};

export async function reprintReceipt(tenantId: string, orderId: string): Promise<ReceiptDto> {
  const detail = await getSale(tenantId, orderId);
  return {
    sale: {
      orderNumber: detail.orderNumber,
      customerName: detail.customerName,
      customerPhone: detail.customerPhone,
      placedAt: detail.placedAt,
      total: detail.total,
      paymentStatus: detail.paymentStatus,
      items: detail.items.map((i) => ({
        nameEn: i.nameEn,
        nameAr: i.nameAr,
        variantNameEn: i.variantNameEn,
        variantNameAr: i.variantNameAr,
        quantity: i.quantity,
        lineTotal: i.lineTotal,
        discountAmount: i.discountAmount,
        selectedModifiers: i.selectedModifiers,
      })),
      tenders: detail.tenders.map((t) => ({
        method: t.method, amount: t.amount, tipAmount: t.tipAmount, changeAmount: t.changeAmount,
      })),
      adjustments: detail.adjustments.map((a) => ({
        type: a.type, amount: a.amount, reasonCode: a.reasonCode, reasonText: a.reasonText,
      })),
    },
    refundSlips: detail.refunds.map((r) => ({
      kind: r.kind,
      totalAmount: r.totalAmount,
      reasonCode: r.reasonCode,
      reasonText: r.reasonText,
      byUserId: r.byUserId,
      authorizedByUserId: r.authorizedByUserId,
      createdAt: r.createdAt,
      lines: r.lines.map((l) => ({
        orderItemId: l.orderItemId, quantity: l.quantity, amount: l.amount, restock: l.restock,
      })),
      payments: r.payments.map((p) => ({ method: p.method, amount: p.amount })),
    })),
  };
}

/** The Spec 7 money-OUT rollup: cash/card/etc. returned to customers, grouped by
 *  refund tender method. This is what a reconciliation report nets against the
 *  day's gross takings (Σ order_payments − Σ refund_payments). */
export async function refundPaymentsOut(
  tenantId: string,
  filters: { from?: Date; to?: Date; branchId?: string } = {},
): Promise<{ method: RefundPayment["method"]; amount: number }[]> {
  return withTenant(tenantId, async (tx) => {
    const conds = [];
    if (filters.branchId) conds.push(eq(refunds.branchId, filters.branchId));
    if (filters.from) conds.push(gte(refunds.createdAt, filters.from));
    if (filters.to) conds.push(lte(refunds.createdAt, filters.to));
    const rows = await tx
      .select({ method: refundPayments.method, total: sql<number>`sum(${refundPayments.amount})` })
      .from(refundPayments)
      .innerJoin(refunds, eq(refundPayments.refundId, refunds.id))
      .where(and(...conds))
      .groupBy(refundPayments.method);
    return rows.map((r) => ({ method: r.method, amount: Number(r.total) }));
  });
}
