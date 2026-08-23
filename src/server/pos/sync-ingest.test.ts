import { describe, it, expect, vi, afterEach } from "vitest";
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
import { createPairingCode, redeemPairingCode, resolveDevice } from "./service";
import { closeShift } from "./shifts";
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

  // Unlike grant.issued's unique-violation race above, holdTicket's loser
  // never throws — it absorbs the replay via its own clientTicketId lock and
  // returns the existing row (held-tickets.ts), the same shape openShift's
  // clientShiftId path uses. This is the honest-status guarantee for that path.
  it("concurrent duplicate ticket.held ingest resolves as duplicate, not two applied", async () => {
    const { ctx } = await seedPosContext("owner");
    const device = toDevice(ctx);
    const e = ticketHeld(ctx.cashierUserId, 1);

    const settled = await Promise.allSettled([
      ingestEvents(device, [e]),
      ingestEvents(device, [e]),
    ]);

    expect(settled.every((r) => r.status === "fulfilled")).toBe(true);
    const statuses = (settled as PromiseFulfilledResult<SyncResult[]>[]).map((r) => r.value[0].status).sort();
    expect(statuses).toEqual(["applied", "duplicate"]);
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
    const shift = await openShiftForCtx(ctx);
    const device = toDevice(ctx);

    const saleEvent = event(ctx.cashierUserId, 1, "sale.recorded", {
      clientOrderId: "sync-sale-1",
      // Every sale.recorded names its drawer — the server refuses to guess,
      // because at ingest time "whichever shift is open" is a different
      // session than the one that rang the sale.
      shiftId: shift.id,
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

describe("ingestEvents realtime propagation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function captureBroadcasts(): { topic: string; event: string; entityIds: string[] }[] {
    const seen: { topic: string; event: string; entityIds: string[] }[] = [];
    vi.stubEnv("SUPABASE_URL", "https://proj.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "svc-key");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const msg = JSON.parse(String(init.body)).messages[0];
      seen.push({ topic: msg.topic, event: msg.event, entityIds: msg.payload.entityIds });
      return new Response(null, { status: 202 });
    }));
    return seen;
  }

  const sale = (
    ctx: PosCashierContext, seq: number, productId: string, total: number,
    clientOrderId: string, shiftId: string,
  ) =>
    event(ctx.cashierUserId, seq, "sale.recorded", {
      clientOrderId,
      shiftId,
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      lineSnapshots: [{ productId, productNameEn: "M", productNameAr: "م", unitPrice: 100, quantity: 1, lineTotal: 100 }],
      expectedTotal: total,
      payments: [{ clientPaymentId: `p-${seq}`, method: "cash", amount: total, tenderedAmount: total }],
    });

  it("publishes once per batch — not once per replayed sale", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
    const shift = await openShiftForCtx(ctx);
    const seen = captureBroadcasts();

    const results = await ingestEvents(toDevice(ctx), [
      sale(ctx, 1, productId, total, "batch-sale-1", shift.id),
      sale(ctx, 2, productId, total, "batch-sale-2", shift.id),
      cashMovement(ctx.cashierUserId, 3, { type: "pay_in", amount: 10, reasonCode: "float_top_up" }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["applied", "applied", "applied"]);

    const orderIds = results.slice(0, 2).map((r) => resultOf(r).orderId as string);
    // Two sales, one signal each for the queues and the stock screens. The
    // per-order broadcast placeOrder makes for a live sale is deliberately
    // suppressed on the replay path.
    expect(seen).toEqual([
      { topic: `tenant:${ctx.tenantId}`, event: "sync.applied", entityIds: orderIds },
      { topic: `tenant:${ctx.tenantId}`, event: "stock.changed", entityIds: orderIds },
    ]);
  });

  it("stays silent when a batch applied nothing new", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
    const shift = await openShiftForCtx(ctx);
    const batch = [sale(ctx, 1, productId, total, "dup-sale-1", shift.id)];
    await ingestEvents(toDevice(ctx), batch);

    const seen = captureBroadcasts();
    const replay = await ingestEvents(toDevice(ctx), batch);

    expect(replay[0].status).toBe("duplicate");
    expect(seen).toEqual([]);
  });

  it("a broadcast failure does not fail the flush", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
    const shift = await openShiftForCtx(ctx);
    vi.stubEnv("SUPABASE_URL", "https://proj.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "svc-key");
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("realtime is down");
    }));

    const results = await ingestEvents(toDevice(ctx), [sale(ctx, 1, productId, total, "fail-sale-1", shift.id)]);
    expect(results[0].status).toBe("applied");
  });
});

/**
 * The ingest endpoint authenticates a DEVICE, with no cashier session — so a
 * shift id arriving in a payload is attacker-controlled. These pin the two
 * halves of that: a drawer is only ever addressable by the device that owns
 * it, and a drawer the till names but the server cannot find is recorded and
 * flagged rather than refused.
 */
describe("ingestEvents — drawer addressing", () => {
  it("a device cannot close another till's drawer", async () => {
    const { ctx, tenantId, branchId, managerId } = await seedPosContext("owner");
    const victimShift = await openShiftForCtx(ctx);

    // A second till, legitimately paired to the same tenant and branch.
    const { code } = await createPairingCode(tenantId, branchId, "counter-2", managerId);
    const { deviceToken } = await redeemPairingCode(code);
    const attacker = (await resolveDevice(deviceToken))!;

    const results = await ingestEvents(
      { deviceId: attacker.deviceId, tenantId, branchId, createdByUserId: managerId },
      [event(ctx.cashierUserId, 1, "shift.closed", { shiftId: victimShift.id, countedTotal: 0 })],
    );

    assertFailed(results[0]);
    const [after] = await withTenant(tenantId, (tx) =>
      tx.select().from(posShifts).where(eq(posShifts.id, victimShift.id)));
    expect(after.status).toBe("open"); // the victim's drawer is untouched
  });

  it("a replayed sale whose drawer never landed is recorded and flagged, not refused", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
    // No shift opened at all: the shift.opened this sale references never
    // synced. Refusing here would sticky-halt every event queued behind it.
    const results = await ingestEvents(toDevice(ctx), [
      event(ctx.cashierUserId, 1, "sale.recorded", {
        clientOrderId: "orphan-sale-1",
        shiftId: crypto.randomUUID(),
        lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
        lineSnapshots: [{
          productId, productNameEn: "M", productNameAr: "م",
          unitPrice: 100, quantity: 1, lineTotal: 100,
        }],
        expectedTotal: total,
        payments: [{ clientPaymentId: "p1", method: "cash", amount: total, tenderedAmount: total }],
      }),
    ]);

    expect(results[0].status).toBe("applied");
    const [placed] = await withTenant(ctx.tenantId, (tx) => tx.select().from(orders));
    expect(placed).toBeDefined();
    const [recorded] = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, "sale.recorded")));
    expect(recorded.metadata).toMatchObject({ shiftUnresolvedAtReplay: true });
  });

  it("a replayed cash movement whose drawer closed out of band is tolerated", async () => {
    const { ctx } = await seedPosContext("owner");
    const shift = await openShiftForCtx(ctx);
    await closeShift(ctx, shift.id, { count: { countedTotal: 200, denominations: { "200": 1 } } });

    // A manager closing the drawer from the dashboard mid-outage must not
    // strand the till's queued pay-out behind an unrecoverable failure.
    const results = await ingestEvents(toDevice(ctx), [
      cashMovement(ctx.cashierUserId, 1, {
        type: "pay_in", amount: 10, reasonCode: "float_top_up", shiftId: shift.id,
      }),
    ]);

    expect(results[0].status).toBe("applied");
    const movements = await withTenant(ctx.tenantId, (tx) => tx.select().from(cashMovements));
    expect(movements).toHaveLength(1);
  });
});
