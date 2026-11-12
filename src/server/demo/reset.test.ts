import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { orders } from "@/server/ordering/schema";
import { etaSubmissions, etaTenantConfig } from "@/server/fiscal/schema";
import { activateFiscal, openShiftForCtx, seedPosContext } from "@/server/pos/test-helpers";
import { recordSale } from "@/server/pos/record-sale";
import { issueRefund } from "@/server/pos/refund";
import { dropDemoTenant } from "./reset";

/**
 * The nightly demo reset against an EG demo tenant that holds fiscal records —
 * the case the ETA tables' ON DELETE RESTRICT guards (statutory retention) used
 * to turn into a failed reset.
 */
async function seedFiscalDemoTenant(slug: string) {
  const s = await seedPosContext("owner");
  await db.update(tenants).set({ slug }).where(eq(tenants.id, s.tenantId));
  await activateFiscal(s.tenantId);
  // The online-channel device nomination: RESTRICT on pos_devices (0049).
  await withTenant(s.tenantId, (tx) =>
    tx.update(etaTenantConfig).set({ onlineDeviceId: s.ctx.deviceId }).where(eq(etaTenantConfig.tenantId, s.tenantId)));
  await openShiftForCtx(s.ctx);
  const receipt = await recordSale(s.ctx, {
    clientOrderId: `demo-reset-${slug}`,
    lines: [{ productId: s.productId, quantity: 1, selectedOptionIds: [] }],
    expectedTotal: s.total,
    payments: [{ clientPaymentId: "p-1", method: "cash", amount: s.total, tenderedAmount: s.total }],
  });
  await issueRefund(
    { tenantId: s.tenantId, branchId: s.branchId, actorUserId: s.ctx.cashierUserId, permissions: [...s.ctx.permissions] },
    {
      orderId: receipt.orderId, kind: "full", lines: [], payments: [{ method: "cash", amount: s.total }],
      reasonCode: "customer_changed_mind", clientRefundId: `r-${slug}`,
    },
  );
  return s;
}

describe("dropDemoTenant", () => {
  it("drops an EG demo tenant holding eta_submissions (sale + refund) and its config", async () => {
    const s = await seedFiscalDemoTenant("demo-fiscal-1");
    const rows = await withTenant(s.tenantId, (tx) =>
      tx.select().from(etaSubmissions).where(eq(etaSubmissions.tenantId, s.tenantId)));
    // Non-vacuity: the fiscal rows that RESTRICT the cascade really exist.
    expect(rows.map((r) => r.docType).sort()).toEqual(["e_receipt", "return_receipt"]);

    // The retention guard is live: the order a fiscal record names cannot be
    // deleted. Whether a bare `DELETE FROM tenants` trips it depends on the
    // order Postgres fires the cascades in (RI triggers fire by trigger NAME,
    // i.e. effectively by OID), so it can pass on one database and fail on
    // another — which is why the reset deletes fiscal rows first rather than
    // relying on the cascade order.
    await expect(withTenant(s.tenantId, (tx) => tx.delete(orders).where(eq(orders.tenantId, s.tenantId))))
      .rejects.toThrow();

    // The reset path drops the tenant regardless.
    expect(await dropDemoTenant("demo-fiscal-1")).toBe(true);
    expect(await db.select().from(tenants).where(eq(tenants.id, s.tenantId))).toHaveLength(0);
    expect(await withTenant(s.tenantId, (tx) => tx.select().from(orders))).toHaveLength(0);
  });

  it("is a no-op for a slug with no tenant, and refuses a non-demo slug outright", async () => {
    expect(await dropDemoTenant("demo-does-not-exist")).toBe(false);
    await expect(dropDemoTenant("acme")).rejects.toThrow(/only demo- tenants/);
  });
});
