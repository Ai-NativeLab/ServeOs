import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { auditEvents } from "./schema";
import { verifyChain } from "./verifier";
import { placeOrder, transitionStatus, markPaid, cancelOrderByToken } from "@/server/ordering/service";
import { seedPosContext } from "@/server/pos/test-helpers";

async function eventsFor(tenantId: string, action: string) {
  return withTenant(tenantId, (tx) =>
    tx.select().from(auditEvents).where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.action, action))));
}
const walkIn = (branchId: string, productId: string) => ({
  branchId, fulfillmentType: "pickup" as const, customerName: "Walk-in", customerPhone: "000000000",
  lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
});

describe("audit emission — ordering", () => {
  it("placeOrder emits order.placed and keeps a valid chain", async () => {
    const { ctx, tenantId, branchId, productId } = await seedPosContext("owner");
    await placeOrder(tenantId, {
      ...walkIn(branchId, productId), channel: "pos", cashierUserId: ctx.cashierUserId,
      audit: { fingerprint: ctx.fingerprint, actorUserId: ctx.cashierUserId, actorType: "user" },
    });
    expect(await eventsFor(tenantId, "order.placed")).toHaveLength(1);
    expect((await verifyChain(tenantId)).ok).toBe(true);
  });

  it("transitionStatus emits order.status_changed with before/after", async () => {
    const { ctx, tenantId, branchId, productId } = await seedPosContext("owner");
    const res = await placeOrder(tenantId, { ...walkIn(branchId, productId), audit: { fingerprint: ctx.fingerprint } });
    await transitionStatus(tenantId, res.orderId, "confirmed", ctx.cashierUserId, undefined, { fingerprint: ctx.fingerprint });
    const [row] = await eventsFor(tenantId, "order.status_changed");
    expect(row.metadata).toMatchObject({ before: "pending", after: "confirmed" });
  });

  it("markPaid emits order.marked_paid", async () => {
    const { ctx, tenantId, branchId, productId } = await seedPosContext("owner");
    const res = await placeOrder(tenantId, { ...walkIn(branchId, productId), audit: { fingerprint: ctx.fingerprint } });
    await markPaid(tenantId, res.orderId, ctx.cashierUserId, { fingerprint: ctx.fingerprint });
    expect(await eventsFor(tenantId, "order.marked_paid")).toHaveLength(1);
  });

  it("cancelOrderByToken emits order.cancelled as a customer actor", async () => {
    const { ctx, tenantId, branchId, productId } = await seedPosContext("owner");
    const res = await placeOrder(tenantId, { ...walkIn(branchId, productId), audit: { fingerprint: ctx.fingerprint } });
    await cancelOrderByToken(tenantId, res.statusToken);
    const [row] = await eventsFor(tenantId, "order.cancelled");
    expect(row.actorType).toBe("customer");
    expect((await verifyChain(tenantId)).ok).toBe(true);
  });
});
