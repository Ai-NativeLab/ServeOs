import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { tenantSettings } from "@/server/tenancy/schema";
import { auditEvents } from "@/server/audit/schema";
import { recordCashMovement } from "./cash-movements";
import { cashMovements } from "./shift-schema";
import { CashMovementError, NoOpenShiftError, PosForbiddenError } from "./errors";
import { issueGrant } from "./grants";
import { seedPosContext, openShiftForCtx } from "./test-helpers";

async function setPayoutThreshold(tenantId: string, payoutThreshold: number) {
  await withTenant(tenantId, (tx) =>
    tx.insert(tenantSettings).values({ tenantId, data: { shiftPolicy: { payoutThreshold } } }),
  );
}

describe("recordCashMovement", () => {
  it("signs the amount by type", async () => {
    const { ctx } = await seedPosContext("owner");
    await openShiftForCtx(ctx);

    const payIn = await recordCashMovement(ctx, { type: "pay_in", amount: 50, reasonCode: "float_top_up" });
    const payOut = await recordCashMovement(ctx, { type: "pay_out", amount: 30, reasonCode: "supplier" });
    const drop = await recordCashMovement(ctx, { type: "safe_drop", amount: 100, reasonCode: "drop" });
    const noSale = await recordCashMovement(ctx, { type: "no_sale", amount: 0, reasonCode: "change_given" });

    // Cash in is positive; cash leaving the drawer is negative; a no-sale is a
    // drawer opening that moves nothing.
    expect(payIn.amount).toBe("50.00");
    expect(payOut.amount).toBe("-30.00");
    expect(drop.amount).toBe("-100.00");
    expect(noSale.amount).toBe("0.00");
  });

  it("attributes the movement to the cashier and the open shift", async () => {
    const { ctx } = await seedPosContext("owner");
    const shift = await openShiftForCtx(ctx);

    const row = await recordCashMovement(ctx, { type: "pay_in", amount: 20, reasonCode: "float_top_up", reasonText: "extra change" });

    expect(row.shiftId).toBe(shift.id);
    expect(row.byUserId).toBe(ctx.cashierUserId);
    expect(row.reasonCode).toBe("float_top_up");
    expect(row.reasonText).toBe("extra change");
    expect(row.authorizedByUserId).toBeNull();
  });

  it("refuses any movement with no open shift", async () => {
    const { ctx } = await seedPosContext("owner");
    await expect(
      recordCashMovement(ctx, { type: "pay_in", amount: 10, reasonCode: "float_top_up" }),
    ).rejects.toBeInstanceOf(NoOpenShiftError);
  });

  it("rejects an amount that contradicts the type, before touching the DB", async () => {
    const { ctx } = await seedPosContext("owner");
    await openShiftForCtx(ctx);

    await expect(recordCashMovement(ctx, { type: "pay_in", amount: 0, reasonCode: "x" }))
      .rejects.toBeInstanceOf(CashMovementError);
    await expect(recordCashMovement(ctx, { type: "pay_out", amount: -5, reasonCode: "x" }))
      .rejects.toBeInstanceOf(CashMovementError);
    await expect(recordCashMovement(ctx, { type: "no_sale", amount: 5, reasonCode: "x" }))
      .rejects.toBeInstanceOf(CashMovementError);

    const rows = await withTenant(ctx.tenantId, (tx) => tx.select().from(cashMovements));
    expect(rows).toHaveLength(0);
  });

  it("lets a staff cashier pay out at or under the threshold unaided", async () => {
    const { ctx, tenantId } = await seedPosContext("staff");
    await setPayoutThreshold(tenantId, 100);
    await openShiftForCtx(ctx);

    const row = await recordCashMovement(ctx, { type: "pay_out", amount: 100, reasonCode: "supplier" });
    expect(row.amount).toBe("-100.00");
    expect(row.authorizedByUserId).toBeNull();
  });

  it("forbids an over-threshold pay_out without a manager grant", async () => {
    const { ctx, tenantId } = await seedPosContext("staff");
    await setPayoutThreshold(tenantId, 100);
    await openShiftForCtx(ctx);

    await expect(
      recordCashMovement(ctx, { type: "pay_out", amount: 150, reasonCode: "supplier" }),
    ).rejects.toBeInstanceOf(PosForbiddenError);

    const rows = await withTenant(ctx.tenantId, (tx) => tx.select().from(cashMovements));
    expect(rows).toHaveLength(0);
  });

  it("records the manager behind an over-threshold pay_out grant", async () => {
    const { ctx, tenantId, managerId } = await seedPosContext("staff");
    await setPayoutThreshold(tenantId, 100);
    await openShiftForCtx(ctx);
    const token = issueGrant(tenantId, "reconciliation:manage", managerId);

    const row = await recordCashMovement(ctx, {
      type: "pay_out", amount: 150, reasonCode: "supplier",
      grants: [{ permission: "reconciliation:manage", token }],
    });

    expect(row.amount).toBe("-150.00");
    expect(row.authorizedByUserId).toBe(managerId);
  });

  it("stamps an owner's own authority on an over-threshold pay_out", async () => {
    const { ctx, tenantId } = await seedPosContext("owner");
    await setPayoutThreshold(tenantId, 100);
    await openShiftForCtx(ctx);

    const row = await recordCashMovement(ctx, { type: "pay_out", amount: 150, reasonCode: "supplier" });
    expect(row.authorizedByUserId).toBe(ctx.cashierUserId);
  });

  it("appends one cash.movement audit event per movement", async () => {
    const { ctx } = await seedPosContext("owner");
    const shift = await openShiftForCtx(ctx);

    const row = await recordCashMovement(ctx, { type: "safe_drop", amount: 200, reasonCode: "drop" });

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, "cash.movement")),
    );
    expect(events).toHaveLength(1);
    expect(events[0].entityId).toBe(row.id);
    expect(events[0].metadata).toMatchObject({ shiftId: shift.id, type: "safe_drop", amount: "-200.00" });
  });
});
