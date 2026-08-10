import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { posAdjustmentEvents } from "@/server/pos/tender-schema";
import { placeOrder, transitionStatus } from "@/server/ordering/service";
import { getCheckoutPricing } from "@/server/tenancy/settings";
import { computeCartTotals } from "@/lib/order-totals";
import { recordSale } from "@/server/pos/record-sale";
import { seedPosContext, openShiftForCtx } from "@/server/pos/test-helpers";
import { seedInventoryTenant, seedItem } from "@/server/inventory/test-helpers";
import { users } from "@/server/auth/schema";
import { purchaseOrders, purchaseOrderLines } from "@/server/purchasing/schema";
import { createSupplier } from "@/server/purchasing/suppliers";
import { createDraftPo, cancelPurchaseOrder } from "@/server/purchasing/service";
import { postReceipt } from "@/server/purchasing/receiving";
import { enterInvoiceTotal } from "@/server/purchasing/variance";
import type { PurchasingActor } from "@/server/purchasing/suppliers";
import {
  getRevenueTrend,
  getSalesByChannel,
  getSalesByBranch,
  getSalesByCashier,
  getSalesByPaymentMethod,
  getDiscountsGiven,
  getTendersAndTips,
  getRefundsAndVoids,
  getReconciliationSummary,
  getInventoryValuation,
  getInventoryConsumption,
  getInventoryWastage,
  getCountVariance,
  getLowStock,
  getSpendBySupplier,
  getReceivedVsInvoiced,
} from "./service";

/**
 * A tenant with real traffic on BOTH channels:
 *  - POS sale 1 — cash, line discount 10 (promo), tendered 20 over → change 20
 *  - POS sale 2 — card, tip 5
 *  - two web pickup orders (qty 1 and qty 2), no cashier
 *  - one CANCELLED web order — must be invisible to every money measure
 *    (docs/ailab/specs/reporting-metrics.md)
 */
async function seedMixed() {
  const { ctx, tenantId, branchId, productId, managerId, total } = await seedPosContext("owner");
  await openShiftForCtx(ctx); // 200.00 float; cash tenders need an open drawer

  const pricing = await getCheckoutPricing(tenantId);
  const discounted = computeCartTotals(pricing, [{ unitPrice: 100, quantity: 1, discountAmount: 10 }], 0).total;

  await recordSale(ctx, {
    clientOrderId: "rep-cash",
    lines: [{ productId, quantity: 1, selectedOptionIds: [], discountAmount: 10, discountReason: "promo" }],
    expectedTotal: discounted,
    payments: [{ clientPaymentId: "rp-1", method: "cash", amount: discounted, tenderedAmount: discounted + 20 }],
  });
  await recordSale(ctx, {
    clientOrderId: "rep-card",
    lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
    expectedTotal: total,
    payments: [{ clientPaymentId: "rp-2", method: "card", amount: total, tipAmount: 5, reference: "4242" }],
  });

  const webOrder = (n: string, quantity: number) =>
    placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup",
      customerName: n, customerPhone: n,
      lines: [{ productId, quantity, selectedOptionIds: [] }],
    });
  await webOrder("W1", 1);
  await webOrder("W2", 2);
  const dead = await webOrder("W3", 5); // big on purpose: leaking it is loud
  await transitionStatus(tenantId, dead.orderId, "cancelled", managerId, "customer_changed_mind");

  return { ctx, tenantId, total, discounted };
}

describe("cross-channel sales aggregations", () => {
  it("slices the same four sold orders by channel, branch, cashier, method, discount and tender", async () => {
    const { ctx, tenantId, total, discounted } = await seedMixed();
    const days = 7;

    // 1. By channel — 2 web + 2 pos, cancelled excluded, AOV = revenue/count.
    const byChannel = await getSalesByChannel(tenantId, days);
    const web = byChannel.find((r) => r.channel === "web")!;
    const pos = byChannel.find((r) => r.channel === "pos")!;
    expect(web.orderCount).toBe(2);
    expect(pos.orderCount).toBe(2);
    expect(pos.revenue).toBeCloseTo(discounted + total, 2);
    expect(pos.averageOrderValue).toBeCloseTo(pos.revenue / pos.orderCount, 2);
    expect(web.averageOrderValue).toBeCloseTo(web.revenue / web.orderCount, 2);

    // 2. CROSS-CHANNEL PARITY — the invariant that proves the union:
    //    combined revenue == Σ per-channel revenue.
    const trend = await getRevenueTrend(tenantId, days);
    const combined = trend.reduce((s, p) => s + p.revenue, 0);
    const summed = byChannel.reduce((s, r) => s + r.revenue, 0);
    expect(summed).toBeCloseTo(combined, 2);

    // 3. By branch — one branch carries all four sold orders.
    const byBranch = await getSalesByBranch(tenantId, days);
    expect(byBranch).toHaveLength(1);
    expect(byBranch[0].branchName).toBe("Main");
    expect(byBranch[0].orderCount).toBe(4);
    expect(byBranch[0].revenue).toBeCloseTo(combined, 2);

    // 4. By cashier — the null bucket IS the web/online row.
    const byCashier = await getSalesByCashier(tenantId, days);
    const mine = byCashier.find((r) => r.cashierUserId === ctx.cashierUserId)!;
    const online = byCashier.find((r) => r.cashierUserId === null)!;
    expect(mine.orderCount).toBe(2);
    expect(mine.cashierName).toBe(ctx.cashierName);
    expect(online.orderCount).toBe(2);
    expect(online.cashierName).toBeNull();

    // 5. By payment method — sums order_payments.amount per method.
    const byMethod = await getSalesByPaymentMethod(tenantId, days);
    expect(byMethod.find((r) => r.method === "cash")!.amount).toBeCloseTo(discounted, 2);
    expect(byMethod.find((r) => r.method === "card")!.amount).toBeCloseTo(total, 2);

    // 6. Discounts — the promo line discount, by reason and by cashier.
    const d = await getDiscountsGiven(tenantId, days);
    expect(d.total).toBeCloseTo(10, 2);
    expect(d.byReason).toEqual([{ reasonCode: "promo", amount: 10, count: 1 }]);
    expect(d.byCashier).toHaveLength(1);
    expect(d.byCashier[0].cashierUserId).toBe(ctx.cashierUserId);
    expect(d.byCashier[0].amount).toBeCloseTo(10, 2);

    // 7. Tenders & tips — tips ride tenders and are not revenue.
    const t = await getTendersAndTips(tenantId, days);
    expect(t.byMethod.find((r) => r.method === "cash")!.amount).toBeCloseTo(discounted, 2);
    expect(t.byMethod.find((r) => r.method === "card")!.count).toBe(1);
    expect(t.tips).toBeCloseTo(5, 2);
    expect(t.cashTendered).toBeCloseTo(discounted + 20, 2);
    expect(t.cashChange).toBeCloseTo(20, 2);
  });

  it("getRefundsAndVoids reads voids from pos_adjustment_events; refunds is an empty rollup once the table exists", async () => {
    const { ctx, tenantId, productId, managerId, total } = await seedPosContext("owner");
    await openShiftForCtx(ctx);
    const sale = await recordSale(ctx, {
      clientOrderId: "void-1",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "vp-1", method: "cash", amount: total, tenderedAmount: total }],
    });

    // No void-recording API exists yet (Spec 3 owns it); the append-only
    // adjustment trail is the source of truth, so the fixture writes it.
    await withTenant(tenantId, (tx) =>
      tx.insert(posAdjustmentEvents).values([
        {
          tenantId, orderId: sale.orderId, type: "line_void", amount: "30",
          reasonCode: "wrong_item", byUserId: ctx.cashierUserId, authorizedByUserId: managerId,
        },
        {
          tenantId, orderId: sale.orderId, type: "order_void", amount: "50",
          reasonCode: "customer_changed_mind", byUserId: ctx.cashierUserId, authorizedByUserId: managerId,
        },
      ]),
    );

    const rv = await getRefundsAndVoids(tenantId, 30);
    expect(rv.voids.reduce((s, v) => s + v.count, 0)).toBe(2);
    expect(rv.voids.find((v) => v.type === "line_void")!.amount).toBeCloseTo(30, 2);
    expect(rv.voids.find((v) => v.type === "order_void")!.amount).toBeCloseTo(50, 2);
    // refunds now exists (Spec 3 shipped): no refunds → an empty rollup, never an error.
    expect(rv.refunds).toEqual({ amount: 0, count: 0, byReason: [] });
  });

  it("getReconciliationSummary degrades to [] while reconciliation_runs is absent (Spec 7)", async () => {
    const { tenantId } = await seedPosContext("owner");
    await expect(getReconciliationSummary(tenantId, 30)).resolves.toEqual([]);
  });

  // Spec 8 has migrated, so the inventory reports now execute real SQL against
  // empty tables — this asserts they return [] on no data, which also means a
  // column-name drift between Spec 8's schema and these queries fails loudly
  // here instead of hiding behind the old missing-table guard. Purchasing
  // (Spec 9) and low-stock (needs Spec 9's reorder_rules) are still guarded.
  it("every inventory + purchasing report returns [] with no inventory data", async () => {
    const { tenantId } = await seedPosContext("owner");
    const guarded: [string, () => Promise<unknown[]>][] = [
      ["getInventoryValuation", () => getInventoryValuation(tenantId)],
      ["getInventoryConsumption", () => getInventoryConsumption(tenantId, 30)],
      ["getInventoryWastage", () => getInventoryWastage(tenantId, 30)],
      ["getCountVariance", () => getCountVariance(tenantId, 30)],
      ["getLowStock", () => getLowStock(tenantId)],
      ["getSpendBySupplier", () => getSpendBySupplier(tenantId, 30)],
      ["getReceivedVsInvoiced", () => getReceivedVsInvoiced(tenantId, 30)],
    ];
    for (const [name, fn] of guarded) {
      await expect(fn(), name).resolves.toEqual([]);
    }
  });

  // Spec 9 ships the real purchasing services, so these queries now execute
  // against real rows (the PR #116 lesson, handled in-PR this time). Seed one
  // received+invoiced PO and one cancelled PO through the actual services and
  // assert all three purchasing reports read them correctly.
  it("purchasing analytics read a real received+invoiced PO; cancelled POs are excluded", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const [user] = await db.insert(users).values({
      tenantId, name: "Buyer", email: `buy-${crypto.randomUUID().slice(0, 8)}@x.com`, status: "active",
    }).returning({ id: users.id });
    const actor: PurchasingActor = { tenantId, branchId, actorUserId: user.id, vertical: "restaurant" };
    const supplierId = await createSupplier(actor, { name: "Main Supplier" });
    const itemId = await seedItem(tenantId, { baseUom: "each" });

    // Received + invoiced: 10 of item @ 5 = 100.00 ordered (wait, 10 × 5 = 50).
    const { poId } = await createDraftPo(actor, {
      supplierId, branchId, lines: [{ itemId, qtyOrdered: 20, uom: "each", unitCost: 5 }], // total 100.00
    });
    await withTenant(tenantId, (tx) =>
      tx.update(purchaseOrders).set({ status: "sent" }).where(eq(purchaseOrders.id, poId)));
    const [poLine] = await withTenant(tenantId, (tx) =>
      tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, poId)));
    await postReceipt(actor, poId, { lines: [{ poLineId: poLine!.id, receivedQty: 18, uom: "each", unitCost: 5 }] });
    await enterInvoiceTotal(actor, poId, 95);

    // Cancelled PO — must not appear in spend.
    const dead = await createDraftPo(actor, {
      supplierId, branchId, lines: [{ itemId, qtyOrdered: 10, uom: "each", unitCost: 100 }],
    });
    await cancelPurchaseOrder(actor, dead.poId);

    const spend = await getSpendBySupplier(tenantId, 30);
    expect(spend).toHaveLength(1);
    expect(spend[0].name).toBe("Main Supplier");
    expect(spend[0].poCount).toBe(1); // the cancelled one is excluded
    expect(spend[0].spend).toBeCloseTo(100, 2); // ordered total, not received

    const rvi = await getReceivedVsInvoiced(tenantId, 30);
    expect(rvi).toHaveLength(1);
    expect(rvi[0].poNumber).toBe(1);
    expect(rvi[0].ordered).toBeCloseTo(100, 2);
    expect(rvi[0].received).toBeCloseTo(90, 2); // 18 × 5
    expect(rvi[0].invoiced).toBeCloseTo(95, 2);
    expect(rvi[0].variance).toBeCloseTo(-5, 2);

    // reorder_rules exists but nothing is below a point → still empty.
    await expect(getLowStock(tenantId)).resolves.toEqual([]);
  });

  it("RLS: a second tenant's orders never leak into any breakdown", async () => {
    const { tenantId } = await seedMixed();

    // A rival tenant rings its own sale...
    const rival = await seedPosContext("owner");
    await openShiftForCtx(rival.ctx);
    await recordSale(rival.ctx, {
      clientOrderId: "rival-1",
      lines: [{ productId: rival.productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: rival.total,
      payments: [{ clientPaymentId: "rv-1", method: "cash", amount: rival.total, tenderedAmount: rival.total }],
    });

    // ...and the first tenant's numbers do not move.
    const byChannel = await getSalesByChannel(tenantId, 7);
    expect(byChannel.reduce((s, r) => s + r.orderCount, 0)).toBe(4);
    const byCashier = await getSalesByCashier(tenantId, 7);
    expect(byCashier.some((r) => r.cashierUserId === rival.ctx.cashierUserId)).toBe(false);
  });
});
