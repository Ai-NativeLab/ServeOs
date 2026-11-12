import { describe, it, expect } from "vitest";
import { ingestEvents, type SyncEvent, type SyncEventType } from "./sync-ingest";
import { listClockSkewFlaggedReceipts } from "./sync-receipt";
import { seedPosContext } from "./test-helpers";
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
  return { eventId: crypto.randomUUID(), seq, type, occurredAt: new Date().toISOString(), actorUserId, payload, ...extra };
}

const ticketHeld = (actorUserId: string, seq: number, extra: Partial<SyncEvent> = {}) =>
  event(actorUserId, seq, "ticket.held", { clientTicketId: crypto.randomUUID(), label: "Table 1" }, extra);

/** Outside sync-ingest's 48h clock-skew window (CLOCK_SKEW_THRESHOLD_MS). */
const SKEWED_OCCURRED_AT = new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString();

describe("listClockSkewFlaggedReceipts", () => {
  it("is empty for a tenant with no receipts yet", async () => {
    const { ctx } = await seedPosContext("owner");
    expect(await listClockSkewFlaggedReceipts(ctx.tenantId)).toEqual([]);
  });

  it("surfaces a receipt whose till clock was >48h off the server's", async () => {
    const { ctx } = await seedPosContext("owner");
    const device = toDevice(ctx);
    const e = ticketHeld(ctx.cashierUserId, 1, { occurredAt: SKEWED_OCCURRED_AT });

    await ingestEvents(device, [e]);
    const rows = await listClockSkewFlaggedReceipts(ctx.tenantId);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventId: e.eventId, deviceId: device.deviceId, type: "ticket.held" });
    expect(rows[0].occurredAt.toISOString()).toBe(SKEWED_OCCURRED_AT);
  });

  it("does not surface a receipt whose clock was within the window", async () => {
    const { ctx } = await seedPosContext("owner");
    const device = toDevice(ctx);
    await ingestEvents(device, [ticketHeld(ctx.cashierUserId, 1)]);

    expect(await listClockSkewFlaggedReceipts(ctx.tenantId)).toEqual([]);
  });

  it("never leaks another tenant's skewed receipts — pos_sync_event_receipts carries no RLS, so this scoping is load-bearing", async () => {
    const a = await seedPosContext("owner");
    const b = await seedPosContext("owner");
    await ingestEvents(toDevice(a.ctx), [ticketHeld(a.ctx.cashierUserId, 1, { occurredAt: SKEWED_OCCURRED_AT })]);

    expect(await listClockSkewFlaggedReceipts(b.ctx.tenantId)).toEqual([]);
    expect(await listClockSkewFlaggedReceipts(a.ctx.tenantId)).toHaveLength(1);
  });
});
