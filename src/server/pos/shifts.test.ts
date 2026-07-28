import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { auditEvents } from "@/server/audit/schema";
import { openShift, findOpenShift } from "./shifts";
import { posShifts, cashCounts } from "./shift-schema";
import { ShiftAlreadyOpenError, CashCountMismatchError } from "./errors";
import { seedPosContext } from "./test-helpers";

describe("openShift", () => {
  it("opens the drawer with an opening float and a matching opening count", async () => {
    const { ctx } = await seedPosContext("owner");

    const shift = await openShift(ctx, { openingFloat: 200 });

    expect(shift.status).toBe("open");
    expect(shift.openingFloat).toBe("200.00");
    expect(shift.openedByUserId).toBe(ctx.cashierUserId);
    expect(shift.closedByUserId).toBeNull();
    expect(shift.closedAt).toBeNull();
    expect(shift.deviceId).toBe(ctx.deviceId);
    expect(shift.branchId).toBe(ctx.branchId);

    const counts = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(cashCounts).where(eq(cashCounts.shiftId, shift.id)),
    );
    expect(counts).toHaveLength(1);
    // The opening count is the float by definition: counted IS expected, so the
    // shift starts with zero variance.
    expect(counts[0].kind).toBe("opening");
    expect(counts[0].countedTotal).toBe("200.00");
    expect(counts[0].expectedTotal).toBe("200.00");
    expect(counts[0].variance).toBe("0.00");
    expect(counts[0].byUserId).toBe(ctx.cashierUserId);
  });

  it("enforces one open shift per device", async () => {
    const { ctx } = await seedPosContext("owner");
    await openShift(ctx, { openingFloat: 100 });

    await expect(openShift(ctx, { openingFloat: 100 })).rejects.toBeInstanceOf(ShiftAlreadyOpenError);

    const open = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(posShifts).where(and(eq(posShifts.deviceId, ctx.deviceId), eq(posShifts.status, "open"))),
    );
    expect(open).toHaveLength(1);
  });

  it("stores the denominations behind the float", async () => {
    const { ctx } = await seedPosContext("owner");

    const shift = await openShift(ctx, { openingFloat: 300, denominations: { "100": 2, "50": 2 } });

    const [count] = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(cashCounts).where(eq(cashCounts.shiftId, shift.id)),
    );
    expect(count.denominations).toEqual({ "100": 2, "50": 2 });
  });

  it("refuses denominations that do not sum to the float, writing nothing", async () => {
    const { ctx } = await seedPosContext("owner");

    await expect(
      openShift(ctx, { openingFloat: 300, denominations: { "100": 2 } }),
    ).rejects.toBeInstanceOf(CashCountMismatchError);

    const shifts = await withTenant(ctx.tenantId, (tx) => tx.select().from(posShifts));
    expect(shifts).toHaveLength(0);
  });

  it("appends exactly one shift.open audit event carrying the float", async () => {
    const { ctx } = await seedPosContext("owner");

    const shift = await openShift(ctx, { openingFloat: 150 });

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, "shift.open")),
    );
    expect(events).toHaveLength(1);
    expect(events[0].entityType).toBe("pos_shift");
    expect(events[0].entityId).toBe(shift.id);
    expect(events[0].actorUserId).toBe(ctx.cashierUserId);
    expect(events[0].metadata).toMatchObject({ deviceId: ctx.deviceId, openingFloat: "150.00" });
  });
});

describe("findOpenShift", () => {
  it("returns the device's open shift", async () => {
    const { ctx } = await seedPosContext("owner");
    const shift = await openShift(ctx, { openingFloat: 100 });

    const found = await findOpenShift(ctx.tenantId, ctx.deviceId);
    expect(found?.id).toBe(shift.id);
  });

  it("returns null for a device with no open shift", async () => {
    const { ctx } = await seedPosContext("owner");
    expect(await findOpenShift(ctx.tenantId, ctx.deviceId)).toBeNull();
  });

  it("never sees another tenant's shift", async () => {
    const a = await seedPosContext("owner");
    const b = await seedPosContext("owner");
    await openShift(a.ctx, { openingFloat: 100 });

    // Tenant B asking about tenant A's drawer gets nothing — RLS, not a filter.
    expect(await findOpenShift(b.ctx.tenantId, a.ctx.deviceId)).toBeNull();
  });
});
