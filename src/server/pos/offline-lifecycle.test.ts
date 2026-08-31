import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { users, roles, userRoles } from "@/server/auth/schema";
import { tenantSettings } from "@/server/tenancy/schema";
import { getCheckoutPricing } from "@/server/tenancy/settings";
import { computeCartTotals } from "@/lib/order-totals";
import { auditEvents } from "@/server/audit/schema";
import { verifyChain } from "@/server/audit/verifier";
import { orders, orderItems } from "@/server/ordering/schema";
import { updateProduct } from "@/server/catalog/service";
import { updateBranchOrdering } from "@/server/branches/service";
import { localDateKey, wallClock } from "@/server/branches/slots";
import { stockLedger } from "@/server/inventory/schema";
import { seedFinishedGood } from "@/server/inventory/test-helpers";
import { getOnHand } from "@/server/inventory/read";
import { notifications } from "@/server/notifications/schema";
import { posSyncEventReceipts } from "./schema";
import { posShifts, cashCounts, cashMovements } from "./shift-schema";
import { orderPayments, posAdjustmentEvents } from "./tender-schema";
import { ingestEvents, type SyncEvent, type SyncResult } from "./sync-ingest";
import { seedPosContext } from "./test-helpers";
import type { PosDeviceContext } from "./require-device";
import type { VerticalId } from "@/server/verticals";

const HOUR = 60 * 60 * 1000;
/** The outage started 30h ago: far enough back that every claimed timestamp
 *  falls on a DIFFERENT Africa/Cairo calendar day than the ingest, which is
 *  what makes the business-day assertions meaningful, and still inside
 *  sync-ingest's 48h clock-skew window so nothing is skew-flagged. */
const OUTAGE_START_MS = 30 * HOUR;

const PAYOUT_THRESHOLD = 50;
const OPENING_FLOAT = 200;
const PAYOUT_AMOUNT = 100;
const LINE_DISCOUNT = 10;
const TZ = "Africa/Cairo";

type Seed = {
  device: PosDeviceContext;
  tenantId: string;
  branchId: string;
  productId: string;
  /** Opened the drawer, rang sale A, moved the cash, counted and closed. */
  cashierId: string;
  /** Took over the till for sale B — proves per-event attribution. */
  cashierBId: string;
  /** Never touches the till; authorizes the discount and the pay-out offline. */
  managerId: string;
  totalA: number;
  totalB: number;
};

/**
 * A staff cashier and a POS device, plus the drawer policy the batch below
 * needs: `payoutThreshold` makes the pay-out a manager's call (so the offline
 * authorizer is actually exercised rather than defaulting to null), and
 * `allowNegativeStock` lets the second sale oversell instead of rolling back —
 * the "negative on-hand + notification" half of the inventory assertion.
 */
async function seedLifecycle(opts: { vertical?: VerticalId; allowNegativeStock?: boolean } = {}): Promise<Seed> {
  const { ctx, tenantId, branchId, productId, managerId } = await seedPosContext("staff", {
    vertical: opts.vertical ?? "restaurant",
  });
  expect(ctx.permissions).not.toContain("pos:discount");
  expect(ctx.permissions).not.toContain("reconciliation:manage");

  await withTenant(tenantId, (tx) => tx.insert(tenantSettings).values({
    tenantId,
    data: {
      shiftPolicy: { payoutThreshold: PAYOUT_THRESHOLD },
      ...(opts.allowNegativeStock !== undefined ? { allowNegativeStock: opts.allowNegativeStock } : {}),
    },
  }));

  // A second cashier on the SAME staff role row — roles are unique per
  // (tenant, key), so this reuses seedPosContext's rather than inserting a rival.
  const [staffRole] = await db.select().from(roles)
    .where(and(eq(roles.tenantId, tenantId), eq(roles.key, "staff"))).limit(1);
  const [cashierB] = await db.insert(users).values({
    tenantId, name: "Cash Ier B", email: `cashier-b-${crypto.randomUUID()}@x.com`, status: "active",
  }).returning();
  await db.insert(userRoles).values({ userId: cashierB.id, roleId: staffRole.id });

  const pricing = await getCheckoutPricing(tenantId);
  return {
    device: {
      deviceId: ctx.deviceId, tenantId, branchId, createdByUserId: managerId,
    },
    tenantId,
    branchId,
    productId,
    cashierId: ctx.cashierUserId,
    cashierBId: cashierB.id,
    managerId,
    totalA: computeCartTotals(pricing, [{ unitPrice: 100, quantity: 2 }], 0).total,
    totalB: computeCartTotals(pricing, [{ unitPrice: 100, quantity: 1, discountAmount: LINE_DISCOUNT }], 0).total,
  };
}

type Batch = {
  events: SyncEvent[];
  clientShiftId: string;
  /** Indexed by seq−1, so an assertion can name the claimed time of one event. */
  at: Date[];
  /** openingFloat + cash tenders − pay-outs, computed from the batch itself. */
  expectedCash: number;
};

/**
 * The exact event batch a till produces for one complete offline shift:
 * sign-in → open → sale → offline grant → discounted sale → pay-out → count →
 * close. Every `occurredAt` is the till's own clock during the outage.
 */
function buildBatch(seed: Seed, outageStart: Date): Batch {
  const clientShiftId = crypto.randomUUID();
  const at = [0, 1 / 60, 1, 2, 2 + 1 / 60, 3, 4, 5].map((h) => new Date(outageStart.getTime() + h * HOUR));
  const expectedCash = OPENING_FLOAT + seed.totalA - PAYOUT_AMOUNT;

  const snapshot = (quantity: number, discountAmount?: number) => ({
    productId: seed.productId,
    productNameEn: "Margherita",
    productNameAr: "مارجريتا",
    unitPrice: 100,
    quantity,
    lineTotal: 100 * quantity - (discountAmount ?? 0),
    ...(discountAmount ? { discountAmount } : {}),
  });

  const event = (
    seq: number, type: SyncEvent["type"], actorUserId: string,
    payload: Record<string, unknown>, authorizedByUserId?: string,
  ): SyncEvent => ({
    eventId: crypto.randomUUID(),
    seq,
    type,
    occurredAt: at[seq - 1].toISOString(),
    actorUserId,
    ...(authorizedByUserId ? { authorizedByUserId } : {}),
    payload,
  });

  return {
    clientShiftId,
    at,
    expectedCash,
    events: [
      event(1, "session.signed_in", seed.cashierId, { outcome: "success" }),
      event(2, "shift.opened", seed.cashierId, { openingFloat: OPENING_FLOAT, clientShiftId }),
      event(3, "sale.recorded", seed.cashierId, {
        clientOrderId: "offline-sale-a",
        lines: [{ productId: seed.productId, quantity: 2, selectedOptionIds: [] }],
        lineSnapshots: [snapshot(2)],
        expectedTotal: seed.totalA,
        payments: [{ clientPaymentId: "pay-a", method: "cash", amount: seed.totalA, tenderedAmount: 250 }],
        clientShiftId,
        catalogVersion: 7,
      }),
      // The manager standing at the till, replayed as data: it gates nothing on
      // its own — the sale below carries its own authorizedByUserId.
      event(4, "grant.issued", seed.cashierBId, { permission: "pos:discount" }, seed.managerId),
      event(5, "sale.recorded", seed.cashierBId, {
        clientOrderId: "offline-sale-b",
        lines: [{
          productId: seed.productId, quantity: 1, selectedOptionIds: [],
          discountAmount: LINE_DISCOUNT, discountReason: "promo",
        }],
        lineSnapshots: [snapshot(1, LINE_DISCOUNT)],
        expectedTotal: seed.totalB,
        payments: [{ clientPaymentId: "pay-b", method: "card", amount: seed.totalB }],
        clientShiftId,
        catalogVersion: 7,
      }, seed.managerId),
      event(6, "cash.movement", seed.cashierId, {
        type: "pay_out", amount: PAYOUT_AMOUNT, reasonCode: "supplier_payment", reasonText: "Milk delivery",
      }, seed.managerId),
      event(7, "count.recorded", seed.cashierId, { clientShiftId, countedTotal: expectedCash }),
      event(8, "shift.closed", seed.cashierId, { clientShiftId, countedTotal: expectedCash }),
    ],
  };
}

function statuses(results: SyncResult[]): string[] {
  return results.map((r) => r.status);
}

/** result is only present on applied/duplicate — callers assert status first. */
function resultOf(r: SyncResult): Record<string, unknown> {
  return (r as Extract<SyncResult, { status: "applied" | "duplicate" }>).result;
}

function assertFailed(r: SyncResult): asserts r is Extract<SyncResult, { status: "failed" }> {
  expect(r.status).toBe("failed");
}

/** Every row the batch is supposed to create, counted straight out of the DB —
 *  the only honest way to say "the replay changed nothing". */
async function rowCounts(seed: Seed) {
  const t = seed.tenantId;
  const len = async <T>(rows: Promise<T[]>) => (await rows).length;
  return {
    shifts: await len(withTenant(t, (tx) => tx.select().from(posShifts))),
    orders: await len(withTenant(t, (tx) => tx.select().from(orders))),
    tenders: await len(withTenant(t, (tx) => tx.select().from(orderPayments))),
    adjustments: await len(withTenant(t, (tx) => tx.select().from(posAdjustmentEvents))),
    movements: await len(withTenant(t, (tx) => tx.select().from(cashMovements))),
    counts: await len(withTenant(t, (tx) => tx.select().from(cashCounts))),
    auditEvents: await len(withTenant(t, (tx) => tx.select().from(auditEvents))),
    receipts: await len(db.select().from(posSyncEventReceipts)
      .where(eq(posSyncEventReceipts.deviceId, seed.device.deviceId))),
  };
}

async function receiptFor(seed: Seed, eventId: string) {
  const [row] = await db.select().from(posSyncEventReceipts).where(and(
    eq(posSyncEventReceipts.deviceId, seed.device.deviceId),
    eq(posSyncEventReceipts.eventId, eventId),
  ));
  return row ?? null;
}

async function orderByClientId(seed: Seed, clientOrderId: string) {
  const rows = await withTenant(seed.tenantId, (tx) => tx.select().from(orders));
  const tenders = await withTenant(seed.tenantId, (tx) => tx.select().from(orderPayments));
  const clientPaymentId = clientOrderId === "offline-sale-a" ? "pay-a" : "pay-b";
  const tender = tenders.find((p) => p.clientPaymentId === clientPaymentId);
  return { order: rows.find((o) => o.id === tender?.orderId)!, tender: tender! };
}

describe("offline shift lifecycle — a full outage replays complete", () => {
  it("ingests the whole batch: claimed times, attribution, inventory, Z-report, chain, and a no-op replay", async () => {
    // Retail + allowNegativeStock: stock genuinely moves here, and the second
    // sale deliberately oversells so both halves of the inventory contract
    // (deducted / negative-on-hand + notification) are proven on one batch.
    const seed = await seedLifecycle({ vertical: "retail", allowNegativeStock: true });
    const { itemId, locationId } = await seedFinishedGood(seed.tenantId, {
      branchId: seed.branchId, productId: seed.productId, onHand: 2,
    });
    const outageStart = new Date(Date.now() - OUTAGE_START_MS);
    const batch = buildBatch(seed, outageStart);

    const results = await ingestEvents(seed.device, batch.events);

    expect(statuses(results)).toEqual(Array(8).fill("applied"));

    // ---- Claimed timestamps -------------------------------------------------
    const [shift] = await withTenant(seed.tenantId, (tx) => tx.select().from(posShifts));
    expect(shift.status).toBe("closed");
    expect(shift.clientShiftId).toBe(batch.clientShiftId);
    expect(shift.openedAt.getTime()).toBe(batch.at[1].getTime());
    expect(shift.closedAt!.getTime()).toBe(batch.at[7].getTime());
    expect(shift.openedByUserId).toBe(seed.cashierId);
    expect(shift.closedByUserId).toBe(seed.cashierId);
    expect(Number(shift.openingFloat)).toBe(OPENING_FLOAT);

    const a = await orderByClientId(seed, "offline-sale-a");
    const b = await orderByClientId(seed, "offline-sale-b");
    expect(a.order.placedAt.getTime()).toBe(batch.at[2].getTime());
    expect(b.order.placedAt.getTime()).toBe(batch.at[4].getTime());
    // The business day the till claims, not the day the queue drained.
    expect(localDateKey(a.order.placedAt, TZ)).toBe(localDateKey(batch.at[2], TZ));
    expect(localDateKey(a.order.placedAt, TZ)).not.toBe(localDateKey(new Date(), TZ));

    // ---- Totals and attribution --------------------------------------------
    expect(Number(a.order.total)).toBe(seed.totalA);
    expect(Number(b.order.total)).toBe(seed.totalB);
    // orders.discountAmount carries ORDER-level discounts only; a line discount
    // lives on the item it reduced (and in the adjustment event below).
    expect(Number(b.order.discountAmount)).toBe(0);
    const [itemB] = await withTenant(seed.tenantId, (tx) => tx.select().from(orderItems)
      .where(eq(orderItems.orderId, b.order.id)));
    expect(Number(itemB.discountAmount)).toBe(LINE_DISCOUNT);
    expect(Number(itemB.lineTotal)).toBe(100 - LINE_DISCOUNT);
    expect(a.order.channel).toBe("pos");
    expect(a.order.cashierUserId).toBe(seed.cashierId);
    expect(b.order.cashierUserId).toBe(seed.cashierBId);

    expect(a.tender.method).toBe("cash");
    expect(Number(a.tender.amount)).toBe(seed.totalA);
    expect(Number(a.tender.changeAmount)).toBe(250 - seed.totalA);
    expect(a.tender.takenByUserId).toBe(seed.cashierId);
    expect(a.tender.shiftId).toBe(shift.id);
    expect(b.tender.method).toBe("card");
    expect(b.tender.takenByUserId).toBe(seed.cashierBId);
    expect(b.tender.shiftId).toBe(shift.id);

    // ---- The offline authorizer --------------------------------------------
    const [discount] = await withTenant(seed.tenantId, (tx) => tx.select().from(posAdjustmentEvents));
    expect(discount.type).toBe("line_discount");
    expect(Number(discount.amount)).toBe(LINE_DISCOUNT);
    expect(discount.byUserId).toBe(seed.cashierBId);
    expect(discount.authorizedByUserId).toBe(seed.managerId);

    const [movement] = await withTenant(seed.tenantId, (tx) => tx.select().from(cashMovements));
    expect(movement.type).toBe("pay_out");
    expect(Number(movement.amount)).toBe(-PAYOUT_AMOUNT); // stored signed by type
    expect(movement.byUserId).toBe(seed.cashierId);
    expect(movement.authorizedByUserId).toBe(seed.managerId); // over threshold: a manager's call
    expect(movement.createdAt.getTime()).toBe(batch.at[5].getTime());

    const [grantRow] = await withTenant(seed.tenantId, (tx) => tx.select().from(auditEvents)
      .where(eq(auditEvents.action, "pos.grant_issued_offline")));
    expect(grantRow.actorUserId).toBe(seed.cashierBId);
    expect(grantRow.metadata).toMatchObject({
      permission: "pos:discount", authorizedByUserId: seed.managerId, occurredAt: batch.at[3].toISOString(),
    });

    // ---- Inventory ----------------------------------------------------------
    const deductions = await withTenant(seed.tenantId, (tx) => tx.select().from(stockLedger)
      .where(and(eq(stockLedger.itemId, itemId), eq(stockLedger.type, "sale_deduction"))));
    expect(deductions.map((d) => Number(d.qty)).sort((x, y) => x - y)).toEqual([-2, -1]);
    const [onHand] = await getOnHand(seed.tenantId, { itemId, locationId });
    expect(onHand.onHand).toBe(-1); // 2 received, 3 sold

    const [oversold] = await withTenant(seed.tenantId, (tx) => tx.select().from(notifications)
      .where(and(eq(notifications.type, "low_stock"), eq(notifications.entityId, itemId))));
    expect(oversold).toBeDefined();
    expect(oversold.severity).toBe("warning");

    // ---- Z-report vs the event math ----------------------------------------
    // Read back off the stored receipt (a DB row), not the ingest return value.
    const closeReceipt = await receiptFor(seed, batch.events[7].eventId);
    const z = closeReceipt!.resultJson as {
      kind: string; openingFloat: number; salesCount: number; discountTotal: number; voidTotal: number;
      refundTotal: number; closedAt: string; flagged: boolean; approvedByUserId: string | null;
      cash: { expected: number; counted: number; variance: number };
      tenders: { method: string; amount: number; tips: number; count: number }[];
      movements: { type: string; total: number; count: number }[];
    };
    expect(z.kind).toBe("z");
    expect(z.openingFloat).toBe(OPENING_FLOAT);
    expect(z.salesCount).toBe(2);
    expect(z.discountTotal).toBe(LINE_DISCOUNT);
    expect(z.voidTotal).toBe(0);
    expect(z.refundTotal).toBe(0);
    expect(z.closedAt).toBe(batch.at[7].toISOString());
    expect(z.cash).toEqual({ expected: batch.expectedCash, counted: batch.expectedCash, variance: 0 });
    expect(z.flagged).toBe(false);
    expect(z.approvedByUserId).toBeNull();
    expect([...z.tenders].sort((x, y) => x.method.localeCompare(y.method))).toEqual([
      { method: "card", amount: seed.totalB, tips: 0, count: 1 },
      { method: "cash", amount: seed.totalA, tips: 0, count: 1 },
    ]);
    expect(z.movements).toEqual([{ type: "pay_out", total: -PAYOUT_AMOUNT, count: 1 }]);

    // The counts behind it, as persisted — the mid-shift one keeps its claimed time.
    const counts = await withTenant(seed.tenantId, (tx) => tx.select().from(cashCounts));
    const byKind = Object.fromEntries(counts.map((c) => [c.kind, c]));
    expect(Number(byKind.opening.countedTotal)).toBe(OPENING_FLOAT);
    expect(Number(byKind.mid_shift.expectedTotal)).toBe(batch.expectedCash);
    expect(Number(byKind.mid_shift.variance)).toBe(0);
    expect(byKind.mid_shift.createdAt.getTime()).toBe(batch.at[6].getTime());
    expect(Number(byKind.closing.expectedTotal)).toBe(batch.expectedCash);
    expect(Number(byKind.closing.variance)).toBe(0);

    // ---- The chain ----------------------------------------------------------
    const chain = await verifyChain(seed.tenantId);
    expect(chain.ok).toBe(true);
    // The chain hashes SERVER time (createdAt) and carries the till's claimed
    // time as metadata — so a backdated batch verifies without the two agreeing.
    expect(grantRow.createdAt.getTime()).toBeGreaterThan(batch.at[3].getTime());

    // ---- The replay ---------------------------------------------------------
    const before = await rowCounts(seed);
    const replay = await ingestEvents(seed.device, batch.events);

    expect(statuses(replay)).toEqual(Array(8).fill("duplicate"));
    expect(replay.map(resultOf)).toEqual(results.map(resultOf));
    expect(await rowCounts(seed)).toEqual(before);
    expect(await verifyChain(seed.tenantId)).toEqual(chain); // same head, same seq
  });
});

describe("offline shift lifecycle — adversarial variants", () => {
  it("ingests the batch when the product was unpublished after the outage began", async () => {
    const seed = await seedLifecycle();
    await updateProduct(seed.tenantId, seed.productId, { isPublished: false });
    const batch = buildBatch(seed, new Date(Date.now() - OUTAGE_START_MS));

    const results = await ingestEvents(seed.device, batch.events);

    expect(statuses(results)).toEqual(Array(8).fill("applied"));

    const a = await orderByClientId(seed, "offline-sale-a");
    expect(Number(a.order.total)).toBe(seed.totalA); // till-wins, built from the snapshot
    const items = await withTenant(seed.tenantId, (tx) => tx.select().from(orderItems)
      .where(eq(orderItems.orderId, a.order.id)));
    expect(items).toHaveLength(1);
    expect(items[0].nameEn).toBe("Margherita");
    expect(Number(items[0].unitBasePrice)).toBe(100);

    const drift = await withTenant(seed.tenantId, (tx) => tx.select().from(auditEvents)
      .where(eq(auditEvents.action, "pos.replay.price_drift")));
    expect(drift).toHaveLength(2); // one per replayed sale
    const meta = drift[0].metadata as {
      catalogVersion: number; missingEntities: { productId: string; reason: string }[];
    };
    expect(meta.catalogVersion).toBe(7);
    expect(meta.missingEntities).toEqual([
      { lineIndex: 0, productId: seed.productId, reason: "product unavailable" },
    ]);

    expect((await verifyChain(seed.tenantId)).ok).toBe(true);
  });

  it("ingests the batch when the replay lands outside the branch's opening hours", async () => {
    const seed = await seedLifecycle();
    const outageStart = new Date(Date.now() - OUTAGE_START_MS);
    const batch = buildBatch(seed, outageStart);

    // 24h trading on exactly the weekday(s) the outage covered. Every claimed
    // time is 25-30h old, so none of them can fall on today's weekday — which
    // is what makes "now" outside opening hours while the batch is inside them.
    const outageDays = [...new Set(batch.at.map((d) => wallClock(d, TZ).day))];
    expect(outageDays).not.toContain(wallClock(new Date(), TZ).day);
    await updateBranchOrdering(seed.tenantId, seed.branchId, {
      acceptingOrders: true,
      openingHours: outageDays.map((day) => ({ day, open: "00:00", close: "00:00", closed: false })),
    });

    const results = await ingestEvents(seed.device, batch.events);

    expect(statuses(results)).toEqual(Array(8).fill("applied"));
    const a = await orderByClientId(seed, "offline-sale-a");
    expect(a.order.placedAt.getTime()).toBe(batch.at[2].getTime());

    // The control: the same sale rung live, right now, is refused by the very
    // hours the replay just walked through.
    const live = await ingestEvents(seed.device, [{
      eventId: crypto.randomUUID(), seq: 9, type: "sale.recorded",
      occurredAt: new Date().toISOString(), actorUserId: seed.cashierId,
      payload: {
        clientOrderId: "live-now",
        lines: [{ productId: seed.productId, quantity: 1, selectedOptionIds: [] }],
        lineSnapshots: [{
          productId: seed.productId, productNameEn: "Margherita", productNameAr: "مارجريتا",
          unitPrice: 100, quantity: 1, lineTotal: 100,
        }],
        expectedTotal: seed.totalB, payments: [], clientShiftId: batch.clientShiftId,
      },
    }]);
    // Replayed through the same dispatcher, but with occurredAt = now: the
    // orderability check runs against the till's clock, so this one refuses.
    assertFailed(live[0]);
    expect(live[0].error.code).toBe("branch_not_accepting_orders");
  });

  it("a second concurrent ingest of the same batch doubles nothing", async () => {
    const seed = await seedLifecycle();
    const batch = buildBatch(seed, new Date(Date.now() - OUTAGE_START_MS));

    const settled = await Promise.allSettled([
      ingestEvents(seed.device, batch.events),
      ingestEvents(seed.device, batch.events),
    ]);

    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled"]);
    const [first, second] = (settled as PromiseFulfilledResult<SyncResult[]>[]).map((s) => s.value);
    // Neither ingest may halt: a device that flushed twice must not be told its
    // queue failed. Which of the two reports `applied` vs `duplicate` for a given
    // event is a race; that no event applies TWICE is the invariant.
    for (const r of [...first, ...second]) expect(r.status).not.toBe("failed");
    expect(first).toHaveLength(8);
    expect(second).toHaveLength(8);

    expect(await rowCounts(seed)).toMatchObject({
      shifts: 1, orders: 2, tenders: 2, adjustments: 1, movements: 1, counts: 3, receipts: 8,
    });
    const [shift] = await withTenant(seed.tenantId, (tx) => tx.select().from(posShifts));
    expect(shift.status).toBe("closed");
    expect((await verifyChain(seed.tenantId)).ok).toBe(true);
  });

  /**
   * Reporting-only race (the test above proves the rows are right regardless):
   * openShift, recordCashMovement, recordMidShiftCount and closeShift each
   * absorb a concurrent replay internally (their own natural-key or receipt
   * check, inside a lock) and return normally — a plain return value the
   * dispatcher couldn't tell apart from a fresh apply. Fixed by having each
   * report `idempotent` on its return (closeShift and recordSale already did)
   * and having applyEvent/ingestEvents derive `status` from that instead of
   * from the pre-apply findSyncReceipt check alone.
   */
  it("reports every event of a second concurrent ingest as a duplicate, never as a second apply", async () => {
    const seed = await seedLifecycle();
    const batch = buildBatch(seed, new Date(Date.now() - OUTAGE_START_MS));

    const settled = await Promise.allSettled([
      ingestEvents(seed.device, batch.events),
      ingestEvents(seed.device, batch.events),
    ]);

    const runs = (settled as PromiseFulfilledResult<SyncResult[]>[]).map((s) => s.value);
    // PER EVENT, not per run: exactly one of the two ingests applies it and the
    // other reports it as a duplicate. That is the property the `idempotent`
    // return value bought — a service that absorbed the replay silently would
    // show up here as a second "applied".
    //
    // Asserted this way rather than as "the losing RUN is uniformly duplicate",
    // which the earlier version of this test used: that form assumed both runs
    // advance through the batch at the same rate, so the lead never changes
    // hands. It stopped holding once EG tenants began finalizing a sale's
    // fiscal receipt inline (Spec 11 Task 5) — sale events now cost visibly
    // more than the rest, so whichever run wins them falls behind on the
    // others and the two interleave. The per-event form is both stronger (it
    // checks all 8 events in both runs) and independent of scheduling.
    for (const event of batch.events) {
      const reported = runs.map((run) => run.find((r) => r.eventId === event.eventId)?.status);
      expect(reported.filter((s) => s === "applied"), `event ${event.eventId} (${event.type})`).toHaveLength(1);
      expect(reported.filter((s) => s === "duplicate"), `event ${event.eventId} (${event.type})`).toHaveLength(1);
    }
  });

  it("halts at a malformed 2nd event, leaves events 3+ untouched, and resumes on a corrected retry", async () => {
    const seed = await seedLifecycle();
    const batch = buildBatch(seed, new Date(Date.now() - OUTAGE_START_MS));
    // A well-formed envelope with a malformed payload: openingFloat missing.
    const broken: SyncEvent = { ...batch.events[1], payload: { clientShiftId: batch.clientShiftId } };
    const halted = [broken, ...batch.events.slice(2)];

    const first = await ingestEvents(seed.device, [batch.events[0], ...halted]);

    expect(statuses(first)).toEqual(["applied", "failed"]);
    assertFailed(first[1]);
    expect(first[1].error.code).toBe("invalid_event");

    // Nothing past the halt may have touched the database — not a row, not a
    // receipt, not an audit entry beyond the one event that did apply.
    expect(await rowCounts(seed)).toMatchObject({
      shifts: 0, orders: 0, tenders: 0, adjustments: 0, movements: 0, counts: 0, receipts: 1,
    });
    for (const e of halted) expect(await receiptFor(seed, e.eventId)).toBeNull();

    // The corrected retry: same seq, same eventId, fixed payload. lastReceiptSeq
    // is 1 (only the sign-in committed), so seq 2 is still the next one owed —
    // the ordering gate must let it through rather than calling it out-of-order.
    const retry = await ingestEvents(seed.device, batch.events.slice(1));

    expect(statuses(retry)).toEqual(Array(7).fill("applied"));

    const [shift] = await withTenant(seed.tenantId, (tx) => tx.select().from(posShifts));
    expect(shift.status).toBe("closed");
    expect(shift.openedAt.getTime()).toBe(batch.at[1].getTime());
    expect(await rowCounts(seed)).toMatchObject({
      shifts: 1, orders: 2, tenders: 2, adjustments: 1, movements: 1, counts: 3, receipts: 8,
    });

    const seqs = (await db.select().from(posSyncEventReceipts)
      .where(eq(posSyncEventReceipts.deviceId, seed.device.deviceId))).map((r) => r.seq).sort((x, y) => x! - y!);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect((await verifyChain(seed.tenantId)).ok).toBe(true);
  });

  /**
   * closeShift's closing count now stamps createdAt from the same claimed
   * occurredAt it already uses for pos_shifts.closedAt (shifts.ts), matching
   * the mid-shift count — so an offline shift's counts land on the business
   * day the till claims, not the day each one happened to commit.
   */
  it("stamps the closing count with the claimed close time, as the mid-shift count is", async () => {
    const seed = await seedLifecycle();
    const batch = buildBatch(seed, new Date(Date.now() - OUTAGE_START_MS));
    const [, open, , , , , , close] = batch.events;

    // Re-seq'd to 1..2: the drawer alone is enough to reach the closing count.
    const results = await ingestEvents(seed.device, [
      { ...open, seq: 1 },
      { ...close, seq: 2, payload: { ...close.payload, countedTotal: OPENING_FLOAT } },
    ]);
    expect(statuses(results)).toEqual(["applied", "applied"]);

    const [closing] = await withTenant(seed.tenantId, (tx) => tx.select().from(cashCounts)
      .where(eq(cashCounts.kind, "closing")));
    expect(closing.createdAt.getTime()).toBe(batch.at[7].getTime());
  });
});
