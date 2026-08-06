import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { orders } from "@/server/ordering/schema";
import { getCheckoutPricing } from "@/server/tenancy/settings";
import { computeCartTotals } from "@/lib/order-totals";
import { getOrder, placeOrder, cancelOrderByToken } from "@/server/ordering/service";
import { PosForbiddenError } from "./errors";
import { issueRefund, type RefundActor } from "./refund";
import { recordSale } from "./record-sale";
import { seedPosContext, openShiftForCtx } from "./test-helpers";
import { assertPermission, type PosCashierContext } from "./require-cashier";
import { listSales, getSale, reprintReceipt, refundPaymentsOut } from "./sales-history";

const actorFrom = (ctx: PosCashierContext): RefundActor => ({
  tenantId: ctx.tenantId,
  branchId: ctx.branchId,
  actorUserId: ctx.cashierUserId,
  permissions: [...ctx.permissions],
});

/** Rings one more sale on an EXISTING seed's context (same tenant/device), so a
 *  test can hold two sales in one tenant — the shape the date/cashier/number
 *  filters need. Returns the receipt + total of the new sale. */
async function ringSale(ctx: PosCashierContext, productId: string, quantity: number, clientOrderId: string) {
  const pricing = await getCheckoutPricing(ctx.tenantId);
  const total = computeCartTotals(pricing, [{ unitPrice: 100, quantity }], 0).total;
  const receipt = await recordSale(ctx, {
    clientOrderId,
    lines: [{ productId, quantity, selectedOptionIds: [] }],
    expectedTotal: total,
    payments: [{ clientPaymentId: `pay-${clientOrderId}`, method: "cash", amount: total, tenderedAmount: total }],
  });
  return { receipt, total };
}

async function seedPaidSale(role: "owner" | "manager" | "staff" = "owner", quantity = 1) {
  const s = await seedPosContext(role);
  await openShiftForCtx(s.ctx);
  return { ...s, ...(await ringSale(s.ctx, s.productId, quantity, "sale-1")) };
}

/** The money one unit is worth in a `quantity`-unit fixture sale (for 1-of-n line refunds). */
const perUnit = (paidAmount: number, quantity: number) => Math.round((paidAmount / quantity) * 100) / 100;

describe("listSales", () => {
  it("returns only finalized sales — an unpaid placed order and a cancelled order are excluded", async () => {
    const s = await seedPaidSale("owner");

    const unpaid = await placeOrder(s.tenantId, {
      branchId: s.branchId,
      fulfillmentType: "pickup",
      customerName: "Walk-in",
      customerPhone: "000000000",
      lines: [{ productId: s.productId, quantity: 1, selectedOptionIds: [] }],
      paymentMethod: "cash",
      channel: "pos",
    });
    const cancelled = await cancelOrderByToken(s.tenantId, unpaid.statusToken);
    expect(cancelled.status).toBe("cancelled");

    const sales = await listSales(s.tenantId, {});
    expect(sales.map((o) => o.id)).toEqual([s.receipt.orderId]);
    expect(sales[0].paymentStatus).toBe("paid");
  });

  it("excludes a paid-then-cancelled order (the status NOT IN guard, not just paymentStatus)", async () => {
    const s = await seedPaidSale("owner");
    // A confirmed+paid order can still be cancelled by the dashboard; the guard
    // keeps it out of sales history even though paymentStatus stayed "paid".
    await withTenant(s.tenantId, (tx) =>
      tx.update(orders).set({ status: "cancelled" }).where(eq(orders.id, s.receipt.orderId)));
    expect(await listSales(s.tenantId, {})).toHaveLength(0);
  });

  it("filters by date range on placedAt", async () => {
    const a = await seedPaidSale("owner");
    const second = await ringSale(a.ctx, a.productId, 1, "sale-2");
    // Push the first sale back a day so only the second falls in the window.
    await withTenant(a.tenantId, (tx) =>
      tx.update(orders).set({ placedAt: new Date(Date.now() - 86400000) }).where(eq(orders.id, a.receipt.orderId)));

    const from = await listSales(a.tenantId, { dateFrom: new Date(Date.now() - 3600000) });
    expect(from.map((o) => o.id)).toEqual([second.receipt.orderId]);
    const to = await listSales(a.tenantId, { dateTo: new Date(Date.now() - 3600000) });
    expect(to.map((o) => o.id)).toEqual([a.receipt.orderId]);
  });

  it("filters by cashierUserId", async () => {
    const s = await seedPaidSale("owner");
    expect((await listSales(s.tenantId, { cashierUserId: s.ctx.cashierUserId })).map((o) => o.id))
      .toEqual([s.receipt.orderId]);
    expect(await listSales(s.tenantId, { cashierUserId: "00000000-0000-0000-0000-000000000000" })).toHaveLength(0);
  });

  it("filters by orderNumber", async () => {
    const s = await seedPaidSale("owner");
    const orderNumber = Number(s.receipt.orderNumber);
    expect((await listSales(s.tenantId, { orderNumber })).map((o) => o.id)).toEqual([s.receipt.orderId]);
    expect(await listSales(s.tenantId, { orderNumber: orderNumber + 1 })).toHaveLength(0);
  });

  it("filters by customerPhone and by amount", async () => {
    const s = await seedPaidSale("owner");
    expect((await listSales(s.tenantId, { customerPhone: "000000000" })).map((o) => o.id)).toEqual([s.receipt.orderId]);
    expect(await listSales(s.tenantId, { customerPhone: "999999999" })).toHaveLength(0);
    expect((await listSales(s.tenantId, { amount: s.total })).map((o) => o.id)).toEqual([s.receipt.orderId]);
    expect(await listSales(s.tenantId, { amount: s.total + 1 })).toHaveLength(0);
  });

  it("filters by branchId and paginates", async () => {
    const s = await seedPaidSale("owner");
    await ringSale(s.ctx, s.productId, 1, "sale-2");
    expect(await listSales(s.tenantId, { branchId: s.branchId })).toHaveLength(2);
    const page1 = await listSales(s.tenantId, { page: 1 });
    expect(page1).toHaveLength(2);
  });

  it("is withTenant-scoped — tenant B never sees tenant A's sales", async () => {
    const a = await seedPaidSale("owner");
    const b = await seedPosContext("owner");
    expect((await listSales(a.tenantId, {})).map((o) => o.id)).toEqual([a.receipt.orderId]);
    expect(await listSales(b.tenantId, {})).toHaveLength(0);
  });
});

describe("getSale", () => {
  it("aggregates items, tenders, pos_adjustment_events, and refunds (each with lines + tenders)", async () => {
    const s = await seedPosContext("owner");
    await openShiftForCtx(s.ctx);
    const pricing = await getCheckoutPricing(s.tenantId);
    const expectedTotal = computeCartTotals(pricing, [{ unitPrice: 100, quantity: 1, discountAmount: 10 }], 0).total;
    const receipt = await recordSale(s.ctx, {
      clientOrderId: "sale-1",
      lines: [{ productId: s.productId, quantity: 1, selectedOptionIds: [], discountAmount: 10, discountReason: "promo" }],
      expectedTotal,
      payments: [{ clientPaymentId: "pay-1", method: "cash", amount: expectedTotal, tenderedAmount: expectedTotal }],
    });

    // A full refund of the discounted sale: the returned money is the discounted total.
    await issueRefund(actorFrom(s.ctx), {
      orderId: receipt.orderId,
      kind: "full",
      lines: [],
      payments: [{ method: "cash", amount: expectedTotal }],
      reasonCode: "wrong_item",
      clientRefundId: "r1",
    });

    const detail = await getSale(s.tenantId, receipt.orderId);
    expect(detail.id).toBe(receipt.orderId);
    expect(detail.items).toHaveLength(1);
    expect(detail.tenders).toHaveLength(1);
    expect(detail.tenders[0].method).toBe("cash");
    expect(detail.adjustments).toHaveLength(1);
    expect(detail.adjustments[0].type).toBe("line_discount");
    expect(detail.refunds).toHaveLength(1);
    expect(detail.refunds[0].kind).toBe("full");
    expect(detail.refunds[0].lines).toHaveLength(0);
    expect(detail.refunds[0].payments).toHaveLength(1);
    expect(Number(detail.refunds[0].payments[0].amount)).toBe(expectedTotal);
  });

  it("throws OrderNotFoundError for a sale in another tenant", async () => {
    const a = await seedPaidSale("owner");
    const b = await seedPosContext("owner");
    await expect(getSale(b.tenantId, a.receipt.orderId)).rejects.toThrow();
  });
});

describe("reprintReceipt", () => {
  it("returns the sale shaped for re-render and appends a refund slip once refunds exist", async () => {
    const s = await seedPaidSale("owner", 2);
    const item = (await getOrder(s.tenantId, s.receipt.orderId)).items[0];
    const unit = perUnit(s.receipt.paidAmount, 2);

    const plain = await reprintReceipt(s.tenantId, s.receipt.orderId);
    expect(plain.sale.items).toHaveLength(1);
    expect(plain.sale.tenders).toHaveLength(1);
    expect(plain.sale.total).toBe(s.receipt.paidAmount.toFixed(2));
    expect(plain.refundSlips).toHaveLength(0);

    await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "partial",
      lines: [{ orderItemId: item.id, quantity: 1, amount: unit, restock: false }],
      payments: [{ method: "cash", amount: unit }],
      reasonCode: "wrong_item",
      clientRefundId: "r1",
    });

    const withSlip = await reprintReceipt(s.tenantId, s.receipt.orderId);
    expect(withSlip.refundSlips).toHaveLength(1);
    expect(withSlip.refundSlips[0].kind).toBe("partial");
    expect(withSlip.refundSlips[0].lines).toHaveLength(1);
    expect(withSlip.refundSlips[0].lines[0].orderItemId).toBe(item.id);
    expect(withSlip.refundSlips[0].payments).toHaveLength(1);
    expect(Number(withSlip.refundSlips[0].payments[0].amount)).toBe(unit);
  });
});

describe("refundPaymentsOut", () => {
  it("rolls up money-OUT by method (Spec 7)", async () => {
    const s = await seedPaidSale("owner", 2);
    const item = (await getOrder(s.tenantId, s.receipt.orderId)).items[0];
    const unit = perUnit(s.receipt.paidAmount, 2);
    await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "partial",
      lines: [{ orderItemId: item.id, quantity: 1, amount: unit, restock: false }],
      payments: [{ method: "cash", amount: unit }],
      reasonCode: "wrong_item",
      clientRefundId: "r1",
    });
    expect(await refundPaymentsOut(s.tenantId, {})).toEqual([{ method: "cash", amount: unit }]);
    // A branch filter scopes the rollup.
    expect(await refundPaymentsOut(s.tenantId, { branchId: s.branchId })).toEqual([{ method: "cash", amount: unit }]);
  });
});

describe("route authorization contract", () => {
  it("reprint + search + detail require only pos:sell — a staff cashier passes the assertPermission gate", async () => {
    const s = await seedPosContext("staff");
    expect(s.ctx.permissions).toContain("pos:sell");
    expect(() => assertPermission(s.ctx, "pos:sell")).not.toThrow();
    expect(() => assertPermission(s.ctx, "pos:refund")).toThrow(PosForbiddenError);
  });

  it("refund is privileged: a pos:sell-only actor calling issueRefund without a grant throws PosForbiddenError (the 403 the refund route maps)", async () => {
    const s = await seedPosContext("staff");
    await openShiftForCtx(s.ctx);
    const ring = await ringSale(s.ctx, s.productId, 1, "sale-1");
    await expect(issueRefund(actorFrom(s.ctx), {
      orderId: ring.receipt.orderId,
      kind: "full",
      lines: [],
      payments: [{ method: "cash", amount: ring.total }],
      reasonCode: "other",
      clientRefundId: "r1",
    })).rejects.toBeInstanceOf(PosForbiddenError);
  });
});
