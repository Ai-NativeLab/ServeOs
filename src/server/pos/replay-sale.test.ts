import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { orders, orderItems } from "@/server/ordering/schema";
import { BranchNotAcceptingOrdersError, OrderValidationError, TotalMismatchError } from "@/server/ordering/errors";
import { getCheckoutPricing } from "@/server/tenancy/settings";
import { computeCartTotals } from "@/lib/order-totals";
import { products } from "@/server/catalog/schema";
import { updateProduct } from "@/server/catalog/service";
import { updateBranchOrdering } from "@/server/branches/service";
import { wallClock } from "@/server/branches/slots";
import { deactivateStaff } from "@/server/auth/staff";
import { auditEvents } from "@/server/audit/schema";
import { posAdjustmentEvents } from "./tender-schema";
import { recordSale } from "./record-sale";
import { seedPosContext, openShiftForCtx } from "./test-helpers";

const past = new Date(Date.now() - 60 * 60 * 1000);

/** A Date instance that falls on `targetDay` (0=Sun…6=Sat) in Africa/Cairo —
 *  the tenant default timezone — regardless of the real day the suite runs
 *  on. Used to prove occurredAt, not replay time, governs opening hours. */
function dateOnCairoWeekday(targetDay: number): Date {
  let d = new Date();
  for (let i = 0; i < 8; i++) {
    if (wallClock(d, "Africa/Cairo").day === targetDay) return d;
    d = new Date(d.getTime() + 24 * 60 * 60 * 1000);
  }
  throw new Error("unreachable");
}

describe("recordSale — till-wins replay", () => {
  it("keeps the till's total after a server-side price change, and writes a drift audit event", async () => {
    const { ctx, tenantId, productId, total } = await seedPosContext("owner");
    await openShiftForCtx(ctx);

    // The price moves AFTER the till rang the sale, before this event replays.
    await updateProduct(tenantId, productId, { basePrice: "150" });

    const res = await recordSale(ctx, {
      clientOrderId: "replay-drift-1",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total, // the till's own total, computed at 100/unit
      payments: [{ clientPaymentId: "p1", method: "cash", amount: total, tenderedAmount: total }],
      replay: {
        occurredAt: past,
        lineSnapshots: [{
          productId, productNameEn: "Margherita", productNameAr: "مارجريتا",
          unitPrice: 100, quantity: 1, lineTotal: 100,
        }],
      },
    });

    // Till wins: the order carries the till's number, not the live 150.
    expect(res.total).toBe(total);
    const [order] = await withTenant(tenantId, (tx) => tx.select().from(orders).where(eq(orders.id, res.orderId)));
    expect(order.total).toBe(String(total.toFixed(2)));

    const [item] = await withTenant(tenantId, (tx) =>
      tx.select().from(orderItems).where(eq(orderItems.orderId, res.orderId)));
    expect(Number(item.unitBasePrice)).toBe(100);
    expect(item.nameEn).toBe("Margherita");

    const [drift] = await withTenant(tenantId, (tx) =>
      tx.select().from(auditEvents).where(and(eq(auditEvents.action, "pos.replay.price_drift"), eq(auditEvents.entityId, res.orderId))));
    expect(drift).toBeDefined();
    const meta = drift.metadata as Record<string, unknown>;
    expect(Number(meta.serverTotal)).toBe(total);
    expect(Number(meta.expectedTotal)).toBe(total);
    expect(meta.missingEntities).toEqual([]);
  });

  it("ingests a sale whose product was unpublished mid-outage, built from its snapshot", async () => {
    const { ctx, tenantId, productId, total } = await seedPosContext("owner");
    await openShiftForCtx(ctx);

    await updateProduct(tenantId, productId, { isPublished: false });

    const res = await recordSale(ctx, {
      clientOrderId: "replay-unpublished-1",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p1", method: "cash", amount: total, tenderedAmount: total }],
      replay: {
        occurredAt: past,
        lineSnapshots: [{
          productId, productNameEn: "Margherita", productNameAr: "مارجريتا",
          unitPrice: 100, quantity: 1, lineTotal: 100,
        }],
      },
    });

    const [order] = await withTenant(tenantId, (tx) => tx.select().from(orders).where(eq(orders.id, res.orderId)));
    expect(order.id).toBeDefined();
    expect(order.total).toBe(String(total.toFixed(2)));

    const [drift] = await withTenant(tenantId, (tx) =>
      tx.select().from(auditEvents).where(and(eq(auditEvents.action, "pos.replay.price_drift"), eq(auditEvents.entityId, res.orderId))));
    expect(drift).toBeDefined();
    const meta = drift.metadata as { missingEntities: Array<{ productId: string; reason: string }> };
    expect(meta.missingEntities).toHaveLength(1);
    expect(meta.missingEntities[0].productId).toBe(productId);
    expect(meta.missingEntities[0].reason).toBe("product unavailable");
  });

  it("ingests a replay whose occurredAt was inside opening hours, replayed outside them, and placedAt equals occurredAt", async () => {
    const { ctx, tenantId, branchId, productId, total } = await seedPosContext("owner");
    await openShiftForCtx(ctx);

    const todayCairo = wallClock(new Date(), "Africa/Cairo").day;
    const allowedDay = (todayCairo + 3) % 7;
    await updateBranchOrdering(tenantId, branchId, {
      acceptingOrders: true,
      openingHours: [{ day: allowedDay, open: "00:00", close: "00:00", closed: false }], // 24h on allowedDay only
    });
    const occurredAt = dateOnCairoWeekday(allowedDay);

    // Sanity: right now, under these hours, a live sale is refused.
    await expect(recordSale(ctx, {
      clientOrderId: "hours-live",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p1", method: "cash", amount: total, tenderedAmount: total }],
    })).rejects.toThrow(BranchNotAcceptingOrdersError);

    const res = await recordSale(ctx, {
      clientOrderId: "hours-replay",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p1", method: "cash", amount: total, tenderedAmount: total }],
      replay: {
        occurredAt,
        lineSnapshots: [{
          productId, productNameEn: "Margherita", productNameAr: "مارجريتا",
          unitPrice: 100, quantity: 1, lineTotal: 100,
        }],
      },
    });

    const [order] = await withTenant(tenantId, (tx) => tx.select().from(orders).where(eq(orders.id, res.orderId)));
    expect(order.placedAt.getTime()).toBe(occurredAt.getTime());
  });

  it("records a discounted replay's authorizer as the offline manager — pos:sell-only actor, no grant token", async () => {
    const { ctx, productId, managerId, tenantId } = await seedPosContext("staff");
    expect(ctx.permissions).not.toContain("pos:discount");

    const pricing = await getCheckoutPricing(tenantId);
    const expectedTotal = computeCartTotals(pricing, [{ unitPrice: 100, quantity: 1, discountAmount: 10 }], 0).total;

    const res = await recordSale(ctx, {
      clientOrderId: "replay-discount-1",
      lines: [{ productId, quantity: 1, selectedOptionIds: [], discountAmount: 10, discountReason: "promo" }],
      expectedTotal,
      payments: [],
      authorizedByUserId: managerId,
      replay: {
        occurredAt: past,
        lineSnapshots: [{
          productId, productNameEn: "Margherita", productNameAr: "مارجريتا",
          unitPrice: 100, quantity: 1, lineTotal: 90, discountAmount: 10,
        }],
      },
    });

    const [ev] = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(posAdjustmentEvents).where(eq(posAdjustmentEvents.orderId, res.orderId)));
    expect(ev.type).toBe("line_discount");
    expect(ev.authorizedByUserId).toBe(managerId);
    expect(ev.byUserId).toBe(ctx.cashierUserId);
  });

  it("flags, but does not reject, a discount authorizer deactivated since the outage", async () => {
    const { ctx, productId, managerId, tenantId } = await seedPosContext("staff");
    await deactivateStaff(tenantId, managerId);

    const pricing = await getCheckoutPricing(tenantId);
    const expectedTotal = computeCartTotals(pricing, [{ unitPrice: 100, quantity: 1, discountAmount: 10 }], 0).total;

    const res = await recordSale(ctx, {
      clientOrderId: "replay-discount-deactivated",
      lines: [{ productId, quantity: 1, selectedOptionIds: [], discountAmount: 10, discountReason: "promo" }],
      expectedTotal,
      payments: [],
      authorizedByUserId: managerId,
      replay: {
        occurredAt: past,
        lineSnapshots: [{
          productId, productNameEn: "Margherita", productNameAr: "مارجريتا",
          unitPrice: 100, quantity: 1, lineTotal: 90, discountAmount: 10,
        }],
      },
    });

    const [ev] = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(posAdjustmentEvents).where(eq(posAdjustmentEvents.orderId, res.orderId)));
    expect(ev.authorizedByUserId).toBe(managerId); // authorized, not rejected

    const [auditRow] = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(auditEvents).where(and(eq(auditEvents.action, "discount.line_applied"), eq(auditEvents.entityId, res.orderId))));
    expect((auditRow.metadata as Record<string, unknown>).authorizerDeactivated).toBe(true);
  });

  it("rejects a replayed discount whose authorizedByUserId names no one in this tenant", async () => {
    const { ctx, productId, tenantId } = await seedPosContext("staff");
    const pricing = await getCheckoutPricing(tenantId);
    const expectedTotal = computeCartTotals(pricing, [{ unitPrice: 100, quantity: 1, discountAmount: 10 }], 0).total;

    await expect(recordSale(ctx, {
      clientOrderId: "replay-discount-bad-authorizer",
      lines: [{ productId, quantity: 1, selectedOptionIds: [], discountAmount: 10, discountReason: "promo" }],
      expectedTotal,
      payments: [],
      authorizedByUserId: crypto.randomUUID(),
      replay: {
        occurredAt: past,
        lineSnapshots: [{
          productId, productNameEn: "Margherita", productNameAr: "مارجريتا",
          unitPrice: 100, quantity: 1, lineTotal: 90, discountAmount: 10,
        }],
      },
    })).rejects.toThrow(/discount/i);
  });
});

describe("recordSale — live sales are unaffected by the replay path", () => {
  it("still 409s a stale total, writing nothing", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
    await openShiftForCtx(ctx);
    await expect(recordSale(ctx, {
      clientOrderId: "live-mismatch",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total > 1 ? 1 : total + 1, // deliberately wrong
      payments: [{ clientPaymentId: "p1", method: "cash", amount: total, tenderedAmount: total }],
    })).rejects.toThrow(TotalMismatchError);

    const written = await withTenant(ctx.tenantId, (tx) => tx.select().from(orders));
    expect(written).toHaveLength(0);
  });

  it("still throws on an unpublished product — no snapshot fallback without replay", async () => {
    const { ctx, productId, tenantId, total } = await seedPosContext("owner");
    await updateProduct(tenantId, productId, { isPublished: false });

    await expect(recordSale(ctx, {
      clientOrderId: "live-unpublished",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [],
    })).rejects.toThrow(OrderValidationError);

    const written = await withTenant(ctx.tenantId, (tx) => tx.select().from(orders));
    expect(written).toHaveLength(0);
  });

  // C1 (PR #187 review): stock hitting zero while the till was offline must
  // not veto the replay — the sale physically happened. The gate honours
  // allowNegative, which replay forces true.
  it("records an out-of-stock sale during replay instead of refusing it", async () => {
    const { ctx, tenantId, productId, total } = await seedPosContext("owner");
    await openShiftForCtx(ctx);

    await updateProduct(tenantId, productId, { trackStock: true });
    await withTenant(tenantId, (tx) =>
      tx.update(products).set({ stockQuantity: 0 }).where(eq(products.id, productId)),
    );

    const res = await recordSale(ctx, {
      clientOrderId: "replay-oos-1",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p1", method: "cash", amount: total, tenderedAmount: total }],
      replay: {
        occurredAt: past,
        lineSnapshots: [{
          productId, productNameEn: "Margherita", productNameAr: "????????",
          unitPrice: 100, quantity: 1, lineTotal: 100,
        }],
      },
    });

    expect(res.total).toBe(total);
    const written = await withTenant(tenantId, (tx) => tx.select().from(orders));
    expect(written).toHaveLength(1);
  });
});