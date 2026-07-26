import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { users, roles, userRoles } from "@/server/auth/schema";
import { hashPassword } from "@/server/auth/password";
import { getCheckoutPricing } from "@/server/tenancy/settings";
import { computeCartTotals } from "@/lib/order-totals";
import { auditEvents } from "./schema";
import { verifyChain } from "./verifier";
import { recordSale, addTender } from "@/server/pos/record-sale";
import { signInCashier } from "@/server/pos/cashier";
import { holdTicket, discardHeldTicket } from "@/server/pos/held-tickets";
import { createPairingCode, redeemPairingCode, revokeDevice, resolveDevice } from "@/server/pos/service";
import { PosCashierError } from "@/server/pos/errors";
import { seedPosContext } from "@/server/pos/test-helpers";

async function eventsFor(tenantId: string, action: string) {
  return withTenant(tenantId, (tx) =>
    tx.select().from(auditEvents).where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.action, action))));
}
const fp = () => ({ deviceId: null, deviceTokenHash: null, appVersion: null, ip: null, userAgent: null });

let cn = 0;
async function seedCashierUser() {
  const [t] = await db.insert(tenants).values({
    slug: `audit-signin-${cn++}`, name: "T", country: "EG", vertical: "restaurant",
  }).returning();
  const [u] = await db.insert(users).values({
    tenantId: t.id, name: "Cash Ier", email: `signin-${cn}@x.com`,
    passwordHash: await hashPassword("pw123456"), status: "active",
  }).returning();
  const [r] = await db.insert(roles).values({ tenantId: t.id, key: "owner", name: "owner" }).returning();
  await db.insert(userRoles).values({ userId: u.id, roleId: r.id });
  return { tenantId: t.id, email: u.email! };
}

describe("audit emission — POS", () => {
  it("recordSale emits sale.recorded and one discount.line_applied per discounted line", async () => {
    const { ctx, productId, tenantId } = await seedPosContext("owner");
    const pricing = await getCheckoutPricing(tenantId);
    const expectedTotal = computeCartTotals(pricing, [{ unitPrice: 100, quantity: 1, discountAmount: 10 }], 0).total;
    await recordSale(ctx, {
      clientOrderId: "sale-1",
      lines: [{ productId, quantity: 1, selectedOptionIds: [], discountAmount: 10, discountReason: "promo" }],
      expectedTotal,
      payments: [{ clientPaymentId: "p-1", method: "cash", amount: expectedTotal, tenderedAmount: expectedTotal }],
    });
    expect(await eventsFor(tenantId, "sale.recorded")).toHaveLength(1);
    expect(await eventsFor(tenantId, "discount.line_applied")).toHaveLength(1);
    expect((await verifyChain(tenantId)).ok).toBe(true);
  });

  it("addTender emits payment.tender_added", async () => {
    const { ctx, productId, tenantId, total } = await seedPosContext("owner");
    const sale = await recordSale(ctx, {
      clientOrderId: "sale-2",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p-1", method: "card", amount: 1 }],
    });
    await addTender(ctx, sale.orderId, { clientPaymentId: "p-2", method: "cash", amount: total - 1, tenderedAmount: total - 1 });
    expect(await eventsFor(tenantId, "payment.tender_added")).toHaveLength(1);
  });

  it("signInCashier emits auth.cashier_signed_in on success", async () => {
    const { tenantId, email } = await seedCashierUser();
    await signInCashier(tenantId, email, "pw123456", { fingerprint: fp() });
    const [row] = await eventsFor(tenantId, "auth.cashier_signed_in");
    expect(row.actorType).toBe("user");
  });

  it("signInCashier emits auth.login_failed with null actor on wrong password", async () => {
    const { tenantId, email } = await seedCashierUser();
    await expect(signInCashier(tenantId, email, "wrong", { fingerprint: fp() })).rejects.toThrow(PosCashierError);
    const [row] = await eventsFor(tenantId, "auth.login_failed");
    expect(row.actorUserId).toBeNull();
    expect(row.metadata).toMatchObject({ email });
  });

  it("holdTicket emits ticket.held and discardHeldTicket emits ticket.discarded", async () => {
    const { ctx, tenantId } = await seedPosContext("owner");
    const { id } = await holdTicket(ctx, "Table 5", { lines: [] });
    expect(await eventsFor(tenantId, "ticket.held")).toHaveLength(1);
    await discardHeldTicket(ctx, id);
    expect(await eventsFor(tenantId, "ticket.discarded")).toHaveLength(1);
  });

  it("redeemPairingCode emits device.paired and revokeDevice emits device.revoked", async () => {
    const { tenantId, branchId, managerId } = await seedPosContext("owner");
    const { code } = await createPairingCode(tenantId, branchId, "till-2", managerId);
    const { deviceToken } = await redeemPairingCode(code);
    expect((await eventsFor(tenantId, "device.paired")).length).toBeGreaterThanOrEqual(1);
    expect((await verifyChain(tenantId)).ok).toBe(true);

    const device = (await resolveDevice(deviceToken))!;
    await revokeDevice(tenantId, device.deviceId, { fingerprint: fp() });
    expect(await eventsFor(tenantId, "device.revoked")).toHaveLength(1);
    expect((await verifyChain(tenantId)).ok).toBe(true);
  });
});
