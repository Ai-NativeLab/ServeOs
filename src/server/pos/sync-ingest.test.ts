import { describe, it, expect } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { auditEvents } from "@/server/audit/schema";
import { deactivateStaff } from "@/server/auth/staff";
import { ingestEvents, type SyncEvent, type SyncEventType, type SyncResult } from "./sync-ingest";
import { posSyncEventReceipts } from "./schema";
import { cashMovements, posShifts } from "./shift-schema";
import { orders } from "@/server/ordering/schema";
import { seedPosContext, openShiftForCtx } from "./test-helpers";
import type { PosCashierContext } from "./require-cashier";
import type { PosDeviceContext } from "./require-device";

function toDevice(ctx: PosCashierContext): PosDeviceContext {
  return { deviceId: ctx.deviceId, tenantId: ctx.tenantId, branchId: ctx.branchId, createdByUserId: ctx.cashierUserId };
}

function event(
  actorUserId: string,
  seq: number,
  type: SyncEventType,
  payload: Record<string, unknown>,
  extra: Partial<SyncEvent> = {},
): SyncEvent {
  return {
    eventId: crypto.randomUUID(),
    seq,
    type,
    occurredAt: new Date().toISOString(),
    actorUserId,
    payload,
    ...extra,
  };
}

const shiftOpened = (actorUserId: string, seq: number, payload: Record<string, unknown> = {}) =>
  event(actorUserId, seq, "shift.opened", { openingFloat: 100, ...payload });

const cashMovement = (actorUserId: string, seq: number, payload: Record<string, unknown>) =>
  event(actorUserId, seq, "cash.movement", payload);

const ticketHeld = (actorUserId: string, seq: number, extra: Partial<SyncEvent> = {}) =>
  event(actorUserId, seq, "ticket.held", { clientTicketId: crypto.randomUUID(), label: "Table 1" }, extra);

const grantIssued = (actorUserId: string, authorizedByUserId: string, seq: number) =>
  event(actorUserId, seq, "grant.issued", { permission: "reconciliation:manage" }, { authorizedByUserId });

const sessionSignedIn = (actorUserId: string, seq: number, outcome?: "success" | "failed") =>
  event(actorUserId, seq, "session.signed_in", outcome ? { outcome } : {});

function assertFailed(r: SyncResult): asserts r is Extract<SyncResult, { status: "failed" }> {
  expect(r.status).toBe("failed");
}

/** result is only present on applied/duplicate — callers assert status first. */
function resultOf(r: SyncResult): Record<string, unknown> {
  return (r as Extract<SyncResult, { status: "applied" | "duplicate" }>).result;
}

describe("ingestEvents", () => {
  it("processes an ordered batch and stops at the first failure", async () => {
    const { ctx } = await seedPosContext("owner");
    const device = toDevice(ctx);

    const e1 = shiftOpened(ctx.cashierUserId, 1);
    // Missing reasonCode — a well-formed envelope, malformed payload.
    const e2 = cashMovement(ctx.cashierUserId, 2, { type: "pay_in", amount: 10 });
    const e3 = cashMovement(ctx.cashierUserId, 3, { type: "pay_in", amount: 10, reasonCode: "float_top_up" });

    const results = await ingestEvents(device, [e1, e2, e3]);

    expect(results).toHaveLength(2); // e3 never touched
    expect(results[0].status).toBe("applied");
    assertFailed(results[1]);
    expect(results[1].error.code).toBe("invalid_event");

    const movements = await withTenant(ctx.tenantId, (tx) => tx.select().from(cashMovements));
    expect(movements).toHaveLength(0); // neither e2 nor e3 wrote anything
  });

  it("replaying a synced batch returns identical results and writes nothing new", async () => {
    const { ctx } = await seedPosContext("owner");
    const device = toDevice(ctx);
    const batch = [
      shiftOpened(ctx.cashierUserId, 1),
      cashMovement(ctx.cashierUserId, 2, { type: "pay_in", amount: 10, reasonCode: "float_top_up" }),
    ];

    const first = await ingestEvents(device, batch);
    expect(first.map((r) => r.status)).toEqual(["applied", "applied"]);

    const countRows = async () => ({
      shifts: (await withTenant(ctx.tenantId, (tx) => tx.select().from(posShifts))).length,
      movements: (await withTenant(ctx.tenantId, (tx) => tx.select().from(cashMovements))).length,
      receipts: (await db.select().from(posSyncEventReceipts)
        .where(eq(posSyncEventReceipts.deviceId, device.deviceId))).length,
    });
    const before = await countRows();

    const second = await ingestEvents(device, batch);
    expect(second.map((r) => r.status)).toEqual(["duplicate", "duplicate"]);
    expect(second.map(resultOf)).toEqual(first.map(resultOf));

    expect(await countRows()).toEqual(before);
  });

  it("a batch spanning two cashiers attributes each event to its own actor", async () => {
    const { ctx, managerId } = await seedPosContext("owner");
    const device = toDevice(ctx);

    const e1 = shiftOpened(ctx.cashierUserId, 1);
    const e2 = cashMovement(managerId, 2, { type: "pay_in", amount: 10, reasonCode: "float_top_up" });

    const results = await ingestEvents(device, [e1, e2]);
    expect(results.map((r) => r.status)).toEqual(["applied", "applied"]);

    const [shift] = await withTenant(ctx.tenantId, (tx) => tx.select().from(posShifts));
    expect(shift.openedByUserId).toBe(ctx.cashierUserId);

    const [movement] = await withTenant(ctx.tenantId, (tx) => tx.select().from(cashMovements));
    expect(movement.byUserId).toBe(managerId);
  });

  it("a deactivated-since-outage actor is flagged, not rejected", async () => {
    const { ctx } = await seedPosContext("owner");
    const device = toDevice(ctx);
    await deactivateStaff(ctx.tenantId, ctx.cashierUserId);

    const results = await ingestEvents(device, [shiftOpened(ctx.cashierUserId, 1)]);

    expect(results[0].status).toBe("applied");
    expect(results[0]).toMatchObject({ flags: ["actor_deactivated"] });

    const [shift] = await withTenant(ctx.tenantId, (tx) => tx.select().from(posShifts));
    expect(shift.openedByUserId).toBe(ctx.cashierUserId); // authorized, not rejected
  });

  it("concurrent duplicate ingest resolves as duplicate, not failure", async () => {
    const { ctx, managerId } = await seedPosContext("owner");
    const device = toDevice(ctx);
    const e = grantIssued(ctx.cashierUserId, managerId, 1);

    const settled = await Promise.allSettled([
      ingestEvents(device, [e]),
      ingestEvents(device, [e]),
    ]);

    expect(settled.every((r) => r.status === "fulfilled")).toBe(true);
    const statuses = (settled as PromiseFulfilledResult<SyncResult[]>[]).map((r) => r.value[0].status).sort();
    expect(statuses).toEqual(["applied", "duplicate"]);

    const rows = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, "pos.grant_issued_offline")));
    expect(rows).toHaveLength(1); // the loser's whole transaction rolled back
  });

  it("an out-of-order seq is rejected with code out_of_order", async () => {
    const { ctx } = await seedPosContext("owner");
    const device = toDevice(ctx);
    await ingestEvents(device, [shiftOpened(ctx.cashierUserId, 1, { clientShiftId: crypto.randomUUID() })]);

    const results = await ingestEvents(device, [shiftOpened(ctx.cashierUserId, 1, { clientShiftId: crypto.randomUUID() })]);

    assertFailed(results[0]);
    expect(results[0].error.code).toBe("out_of_order");
  });

  it("flags but accepts events with >48h clock skew", async () => {
    const { ctx } = await seedPosContext("owner");
    const device = toDevice(ctx);
    const skewed = new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString();
    const e = ticketHeld(ctx.cashierUserId, 1, { occurredAt: skewed });

    const results = await ingestEvents(device, [e]);
    expect(results[0].status).toBe("applied");

    const [row] = await db.select().from(posSyncEventReceipts)
      .where(and(eq(posSyncEventReceipts.deviceId, device.deviceId), eq(posSyncEventReceipts.eventId, e.eventId)));
    expect(row.clockSkewFlagged).toBe(true);
    expect(row.seq).toBe(1);
  });

  it("an unknown event type fails that event without crashing the batch", async () => {
    const { ctx } = await seedPosContext("owner");
    const device = toDevice(ctx);
    const bad = event(ctx.cashierUserId, 1, "bogus.type" as SyncEventType, {});
    const good = ticketHeld(ctx.cashierUserId, 2);

    const results = await ingestEvents(device, [bad, good]);

    expect(results).toHaveLength(1); // good never touched — batch stopped
    assertFailed(results[0]);
    expect(results[0].error.code).toBe("unknown_event_type");
  });

  it("sale.recorded dispatches through recordSale, and its receipt makes a later replay a duplicate", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
    await openShiftForCtx(ctx);
    const device = toDevice(ctx);

    const saleEvent = event(ctx.cashierUserId, 1, "sale.recorded", {
      clientOrderId: "sync-sale-1",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      lineSnapshots: [{
        productId, productNameEn: "Margherita", productNameAr: "مارجريتا",
        unitPrice: 100, quantity: 1, lineTotal: 100,
      }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p1", method: "cash", amount: total, tenderedAmount: total }],
    });

    const first = await ingestEvents(device, [saleEvent]);
    expect(first[0].status).toBe("applied");
    expect(first[0]).toMatchObject({ result: { paymentStatus: "paid" } });

    // sale.recorded gets a pos_sync_event_receipts row too (record-sale.ts's
    // OWN addition for Task 6b) — not just pos_order_receipts — so seq
    // tracking and the generic duplicate path work for sales like every
    // other type.
    const [receiptRow] = await db.select().from(posSyncEventReceipts)
      .where(and(eq(posSyncEventReceipts.deviceId, device.deviceId), eq(posSyncEventReceipts.eventId, saleEvent.eventId)));
    expect(receiptRow.seq).toBe(1);

    const second = await ingestEvents(device, [saleEvent]);
    expect(second[0].status).toBe("duplicate");
    expect(resultOf(second[0])).toEqual(resultOf(first[0]));

    const placedOrders = await withTenant(ctx.tenantId, (tx) => tx.select().from(orders));
    expect(placedOrders).toHaveLength(1); // the replay placed no second order
  });

  it("grant.issued and session.signed_in land in the audit chain", async () => {
    const { ctx, managerId } = await seedPosContext("owner");
    const device = toDevice(ctx);

    const results = await ingestEvents(device, [
      grantIssued(ctx.cashierUserId, managerId, 1),
      sessionSignedIn(ctx.cashierUserId, 2),
    ]);
    expect(results.map((r) => r.status)).toEqual(["applied", "applied"]);

    const [grantRow] = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, "pos.grant_issued_offline")));
    expect(grantRow.actorUserId).toBe(ctx.cashierUserId);
    expect(grantRow.metadata).toMatchObject({ permission: "reconciliation:manage", authorizedByUserId: managerId });

    // seedPosContext's own signInCashier call already emitted one
    // auth.cashier_signed_in row (live, metadata {}) — take the latest, ours.
    const [signInRow] = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, "auth.cashier_signed_in")).orderBy(desc(auditEvents.seq)).limit(1));
    expect(signInRow.actorUserId).toBe(ctx.cashierUserId);
    expect(signInRow.metadata).toMatchObject({ offline: true });
  });
});
