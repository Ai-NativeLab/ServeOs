import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { auditEvents } from "@/server/audit/schema";
import { posSyncEventReceipts } from "./schema";
import { openShift, closeShift, recordMidShiftCount, buildXReport } from "./shifts";
import { recordCashMovement } from "./cash-movements";
import { holdTicket, discardHeldTicket, recallHeldTicket } from "./held-tickets";
import { recordSale } from "./record-sale";
import { issueGrant } from "./grants";
import { posShifts, cashCounts, cashMovements } from "./shift-schema";
import { posHeldTickets, orderPayments } from "./tender-schema";
import { ShiftClosedError } from "./errors";
import { seedPosContext } from "./test-helpers";
import type { SyncReceipt } from "./sync-receipt";
import type { PosCashierContext } from "./require-cashier";
import type { Permission } from "@/server/rbac/permissions";

const past = new Date(Date.now() - 60 * 60 * 1000);

function receiptFor(ctx: PosCashierContext, eventId: string, type: string): SyncReceipt {
  return { deviceId: ctx.deviceId, eventId, type, occurredAt: past, clockSkewFlagged: false };
}

function asCashier(ctx: PosCashierContext, cashierUserId: string, permissions: Permission[]): PosCashierContext {
  return { ...ctx, cashierUserId, permissions };
}

describe("openShift replay", () => {
  it("is idempotent on (deviceId, clientShiftId)", async () => {
    const { ctx } = await seedPosContext("owner");
    const CSID = crypto.randomUUID();

    const a = await openShift(ctx, { openingFloat: 100, clientShiftId: CSID, occurredAt: past });
    const b = await openShift(ctx, { openingFloat: 100, clientShiftId: CSID, occurredAt: past });

    expect(b.id).toBe(a.id);
    const rows = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(posShifts).where(eq(posShifts.clientShiftId, CSID)));
    expect(rows).toHaveLength(1); // the retry inserted nothing
  });

  it("honours the device-claimed occurredAt for openedAt", async () => {
    const { ctx } = await seedPosContext("owner");
    const s = await openShift(ctx, { openingFloat: 100, clientShiftId: crypto.randomUUID(), occurredAt: past });
    expect(s.openedAt.getTime()).toBe(past.getTime());
  });

  it("writes the sync receipt as the last statement of the same commit", async () => {
    const { ctx } = await seedPosContext("owner");
    const EVT = crypto.randomUUID();

    const shift = await openShift(ctx, {
      openingFloat: 100, clientShiftId: crypto.randomUUID(), occurredAt: past,
      syncReceipt: receiptFor(ctx, EVT, "shift.opened"),
    });

    const rows = await db.select().from(posSyncEventReceipts)
      .where(and(eq(posSyncEventReceipts.deviceId, ctx.deviceId), eq(posSyncEventReceipts.eventId, EVT)));
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("shift.opened");
    expect((rows[0].resultJson as { id: string }).id).toBe(shift.id);
  });
});

describe("closeShift replay", () => {
  it("commits the receipt and the close atomically; a retry returns the stored result", async () => {
    const { ctx } = await seedPosContext("owner");
    const shift = await openShift(ctx, { openingFloat: 100 });
    const EVT = crypto.randomUUID();
    const input = {
      count: { countedTotal: 100 },
      occurredAt: past,
      syncReceipt: receiptFor(ctx, EVT, "shift.closed"),
    };

    const first = await closeShift(ctx, shift.id, input);
    expect(first.idempotent).toBe(false);

    const again = await closeShift(ctx, shift.id, input);
    expect(again.idempotent).toBe(true); // receipt found → stored result, not ShiftClosedError
    expect(again.shiftId).toBe(first.shiftId);
    expect(again.cash).toEqual(first.cash);

    const counts = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(cashCounts).where(eq(cashCounts.kind, "closing")));
    expect(counts).toHaveLength(1); // the retry wrote no second count

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, "shift.close")));
    expect(events).toHaveLength(1); // and no second audit event

    // The atomicity claim itself, checked directly rather than through the
    // function's return value: the receipt that exists in the DB and the
    // shift row that exists in the DB agree, because they committed together.
    const [receiptRow] = await db.select().from(posSyncEventReceipts)
      .where(and(eq(posSyncEventReceipts.deviceId, ctx.deviceId), eq(posSyncEventReceipts.eventId, EVT)));
    const [shiftRow] = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(posShifts).where(eq(posShifts.id, shift.id)));
    expect(shiftRow.status).toBe("closed");
    expect((receiptRow.resultJson as { shiftId: string }).shiftId).toBe(shiftRow.id);
  });

  it("honours the device-claimed occurredAt for closedAt", async () => {
    const { ctx } = await seedPosContext("owner");
    const shift = await openShift(ctx, { openingFloat: 100 });

    const z = await closeShift(ctx, shift.id, { count: { countedTotal: 100 }, occurredAt: past });

    expect(new Date(z.closedAt).getTime()).toBe(past.getTime());
    const [closed] = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(posShifts).where(eq(posShifts.id, shift.id)));
    expect(closed.closedAt!.getTime()).toBe(past.getTime());
  });

  it("does not spend a manager grant twice on a retried cross-user close", async () => {
    const { ctx, tenantId, managerId } = await seedPosContext("staff");
    const shift = await openShift(ctx, { openingFloat: 100 });
    const other = asCashier(ctx, managerId, ["pos:sell", "reconciliation:manage"]);
    const token = await issueGrant(tenantId, "reconciliation:manage", managerId);
    const EVT = crypto.randomUUID();
    const input = {
      count: { countedTotal: 100 },
      grants: [{ permission: "reconciliation:manage" as const, token }],
      syncReceipt: receiptFor(ctx, EVT, "shift.closed"),
    };
    const other2 = asCashier(ctx, managerId, ["pos:sell"]); // needs the grant this time

    const first = await closeShift(other, shift.id, input);
    expect(first.idempotent).toBe(false);

    // A single-use token already spent by the first call: if the retry tried
    // to authorize again, this would throw PosForbiddenError instead of
    // returning the stored result.
    const again = await closeShift(other2, shift.id, input);
    expect(again.idempotent).toBe(true);
  });

  it("refuses a second close with no syncReceipt, exactly as before", async () => {
    const { ctx } = await seedPosContext("owner");
    const shift = await openShift(ctx, { openingFloat: 100 });
    await closeShift(ctx, shift.id, { count: { countedTotal: 100 } });

    await expect(closeShift(ctx, shift.id, { count: { countedTotal: 100 } }))
      .rejects.toBeInstanceOf(ShiftClosedError);
  });
});

describe("recordCashMovement replay", () => {
  it("applies a movement with the same syncReceipt eventId exactly once", async () => {
    const { ctx } = await seedPosContext("owner");
    const shift = await openShift(ctx, { openingFloat: 100 });
    const EVT = crypto.randomUUID();
    const input = {
      type: "pay_in" as const, amount: 30, reasonCode: "float_top_up",
      occurredAt: past, syncReceipt: receiptFor(ctx, EVT, "cash.movement"),
    };

    const a = await recordCashMovement(ctx, input);
    const b = await recordCashMovement(ctx, input);

    expect(b.id).toBe(a.id);
    expect(b.amount).toBe(a.amount);
    const rows = await withTenant(ctx.tenantId, (tx) => tx.select().from(cashMovements));
    expect(rows).toHaveLength(1); // the retry inserted nothing

    // The number that actually matters: a replayed pay-in must not double the
    // drawer's expected cash.
    const x = await buildXReport(ctx.tenantId, shift);
    expect(x.cash.expected).toBe(130);
  });

  it("honours the device-claimed occurredAt for createdAt", async () => {
    const { ctx } = await seedPosContext("owner");
    await openShift(ctx, { openingFloat: 100 });
    const row = await recordCashMovement(ctx, { type: "pay_in", amount: 10, reasonCode: "x", occurredAt: past });
    expect(row.createdAt.getTime()).toBe(past.getTime());
  });
});

describe("recordMidShiftCount replay", () => {
  it("applies a count with the same syncReceipt eventId exactly once", async () => {
    const { ctx } = await seedPosContext("owner");
    const shift = await openShift(ctx, { openingFloat: 100 });
    const EVT = crypto.randomUUID();
    const input = { countedTotal: 100, occurredAt: past, syncReceipt: receiptFor(ctx, EVT, "count.recorded") };

    const a = await recordMidShiftCount(ctx, shift.id, input);
    const b = await recordMidShiftCount(ctx, shift.id, input);

    expect(b.id).toBe(a.id);
    const rows = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(cashCounts).where(eq(cashCounts.kind, "mid_shift")));
    expect(rows).toHaveLength(1);
  });
});

describe("held tickets replay", () => {
  it("holdTicket is idempotent on (deviceId, clientTicketId)", async () => {
    const { ctx } = await seedPosContext("owner");
    const CTID = crypto.randomUUID();
    const opts = { clientTicketId: CTID, occurredAt: past, syncReceipt: receiptFor(ctx, crypto.randomUUID(), "ticket.held") };

    const a = await holdTicket(ctx, "Table 4", { lines: [] }, opts);
    const b = await holdTicket(ctx, "Table 4", { lines: [] }, opts);

    expect(b.id).toBe(a.id);
    const rows = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(posHeldTickets).where(eq(posHeldTickets.clientTicketId, CTID)));
    expect(rows).toHaveLength(1);
  });

  it("discardHeldTicket resolves an offline-created ticket by clientTicketId", async () => {
    const { ctx } = await seedPosContext("owner");
    const CTID = crypto.randomUUID();
    await holdTicket(ctx, "Table 9", { lines: [] }, { clientTicketId: CTID });

    await discardHeldTicket(ctx, null, { clientTicketId: CTID });

    const rows = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(posHeldTickets).where(eq(posHeldTickets.clientTicketId, CTID)));
    expect(rows).toHaveLength(0);
  });

  it("discardHeldTicket replay is idempotent on syncReceipt eventId", async () => {
    const { ctx } = await seedPosContext("owner");
    const CTID = crypto.randomUUID();
    await holdTicket(ctx, "Table 1", { lines: [] }, { clientTicketId: CTID });
    const EVT = crypto.randomUUID();
    const opts = { clientTicketId: CTID, syncReceipt: receiptFor(ctx, EVT, "ticket.discarded") };

    await discardHeldTicket(ctx, null, opts);
    await expect(discardHeldTicket(ctx, null, opts)).resolves.toBeUndefined();

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, "ticket.discarded")));
    expect(events).toHaveLength(1); // the retry appended nothing
  });

  it("recallHeldTicket deletes by clientTicketId and is idempotent on replay", async () => {
    const { ctx } = await seedPosContext("owner");
    const CTID = crypto.randomUUID();
    await holdTicket(ctx, "Table 2", { lines: [] }, { clientTicketId: CTID });
    const EVT = crypto.randomUUID();
    const opts = { syncReceipt: receiptFor(ctx, EVT, "ticket.recalled") };

    await recallHeldTicket(ctx, CTID, opts);
    const rows = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(posHeldTickets).where(eq(posHeldTickets.clientTicketId, CTID)));
    expect(rows).toHaveLength(0);

    await expect(recallHeldTicket(ctx, CTID, opts)).resolves.toBeUndefined();
    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, "ticket.recalled")));
    expect(events).toHaveLength(1);
  });
});

describe("recordSale replay — shift resolution", () => {
  it("resolves the drawer from clientShiftId, tolerating a shift the server has since closed", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
    const CSID = crypto.randomUUID();
    const shiftA = await openShift(ctx, { openingFloat: 100, clientShiftId: CSID });
    await closeShift(ctx, shiftA.id, { count: { countedTotal: 100 } });

    const res = await recordSale(ctx, {
      clientOrderId: "replay-1",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p-1", method: "cash", amount: total, tenderedAmount: total }],
      clientShiftId: CSID,
    });

    const tenders = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(orderPayments).where(eq(orderPayments.orderId, res.orderId)));
    expect(tenders[0].shiftId).toBe(shiftA.id); // stamped against the (now-closed) drawer it actually belongs to

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, "sale.recorded")));
    expect(events[0].metadata).toMatchObject({ shiftClosedAtReplay: true });
  });

  it("resolves the drawer from the server shiftId when the shift was opened online", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
    const shift = await openShift(ctx, { openingFloat: 100 }); // no clientShiftId: opened online

    const res = await recordSale(ctx, {
      clientOrderId: "replay-2",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p-1", method: "cash", amount: total, tenderedAmount: total }],
      shiftId: shift.id,
    });

    const tenders = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(orderPayments).where(eq(orderPayments.orderId, res.orderId)));
    expect(tenders[0].shiftId).toBe(shift.id);

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, "sale.recorded")));
    expect(events[0].metadata).not.toHaveProperty("shiftClosedAtReplay"); // still open: no flag
  });

  it("live (non-replay) sales keep resolving via findOpenShift", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
    await openShift(ctx, { openingFloat: 100 });

    const res = await recordSale(ctx, {
      clientOrderId: "live-1",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p-1", method: "cash", amount: total, tenderedAmount: total }],
    });

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(auditEvents).where(and(eq(auditEvents.action, "sale.recorded"), eq(auditEvents.entityId, res.orderId))));
    expect(events[0].metadata).not.toHaveProperty("shiftClosedAtReplay");
  });
});
