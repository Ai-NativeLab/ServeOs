import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { users } from "@/server/auth/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { createBranch, updateBranchOrdering } from "@/server/branches/service";
import { createCategory, createProduct, updateProduct } from "@/server/catalog/service";
import { upsertOfflineMethod } from "@/server/payments/offline/methods";
import { placeOrder, transitionStatus, confirmOrderPayment } from "./service";
import { orders } from "./schema";
import { PaymentNotVerifiedError, InvalidPhoneError } from "./errors";

/**
 * #165: an offline payment still awaiting verification must not hand over
 * goods. The order may enter the kitchen (preparing), but ready /
 * out_for_delivery / completed are refused until the payment is resolved in
 * the payments queue. Cancelling/rejecting stays available so a blocked order
 * is never stuck. COD (`unpaid`) is unaffected — unpaid by design.
 */

async function seed(slug: string) {
  const [t] = await db.insert(tenants).values({
    slug, name: "T", country: "EG", vertical: "restaurant",
  }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro");
  const branch = await createBranch(t.id, { name: "Main" });
  await updateBranchOrdering(t.id, branch.id, { acceptingOrders: true });
  const cat = await createCategory(t.id, { nameEn: "Food", nameAr: "أكل" });
  const prod = await createProduct(t.id, { nameEn: "Mixed Grill", nameAr: "مشويات", basePrice: "120.00", categoryId: cat.id });
  await updateProduct(t.id, prod.id, { isPublished: true });
  // Enable the offline method the customer will "pay" with.
  await upsertOfflineMethod(t.id, { type: "vodafone_cash", label: "Vodafone Cash", payToDetail: "01000000000", enabled: true });
  const [staff] = await db.insert(users).values({ tenantId: t.id, name: "Mgr", email: `mgr-${slug}@x.com`, status: "active" }).returning();
  return { tenantId: t.id, branchId: branch.id, productId: prod.id, staffId: staff.id };
}

const line = (productId: string) => [{ productId, quantity: 1, selectedOptionIds: [] }];

/** An offline-paid order sitting at `confirmed`, payment still unverified. */
async function seedUnverifiedOrder(slug: string) {
  const s = await seed(slug);
  const res = await placeOrder(s.tenantId, {
    branchId: s.branchId, fulfillmentType: "pickup", customerName: "C",
    customerPhone: "01012345678", lines: line(s.productId),
    paymentMethod: "vodafone_cash", paymentReference: "VC-123",
  });
  const [order] = await withTenant(s.tenantId, (tx) => tx.select().from(orders).where(eq(orders.id, res.orderId)));
  expect(order.paymentStatus).toBe("pending_verification");
  // The restaurant has accepted the ticket; only money is still unverified.
  await transitionStatus(s.tenantId, res.orderId, "confirmed", s.staffId);
  return { ...s, orderId: res.orderId };
}

describe("unverified-payment fulfilment gate (#165)", () => {
  it("lets the kitchen start preparing but refuses to hand over while the payment is unverified", async () => {
    const { tenantId, orderId, staffId } = await seedUnverifiedOrder("pvg-1");

    // Into the kitchen is fine...
    await transitionStatus(tenantId, orderId!, "preparing", staffId);

    // ...handing over is not: the next release step refuses and persists nothing.
    // (ready→completed stays unreachable while blocked, so `ready` IS the gate.)
    await expect(transitionStatus(tenantId, orderId!, "ready", staffId))
      .rejects.toBeInstanceOf(PaymentNotVerifiedError);
    const [order] = await withTenant(tenantId, (tx) => tx.select().from(orders).where(eq(orders.id, orderId!)));
    expect(order.status).toBe("preparing");
  });

  it("releases immediately once the payment is confirmed in the queue", async () => {
    const { tenantId, orderId, staffId } = await seedUnverifiedOrder("pvg-2");
    await transitionStatus(tenantId, orderId!, "preparing", staffId);

    await confirmOrderPayment(tenantId, orderId!, staffId);

    await expect(transitionStatus(tenantId, orderId!, "ready", staffId)).resolves.toBeDefined();
    await expect(transitionStatus(tenantId, orderId!, "completed", staffId)).resolves.toBeDefined();
  });

  it("never traps a blocked order: cancelling stays available", async () => {
    const { tenantId, orderId, staffId } = await seedUnverifiedOrder("pvg-3");
    await transitionStatus(tenantId, orderId!, "preparing", staffId);

    await expect(transitionStatus(tenantId, orderId!, "cancelled", staffId, "customer unreachable")).resolves.toBeDefined();
  });

  it("refuses a WEB order that tries the POS walk-in sentinel (#187 review gap)", async () => {
    const { tenantId, branchId, productId } = await seed("pvg-sent");
    // No `channel` field — defaults to "web", which must never accept 000000000.
    await expect(placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "W", customerPhone: "000000000",
      lines: line(productId),
    })).rejects.toBeInstanceOf(InvalidPhoneError);
  });
  it("leaves cash-on-delivery alone — unpaid by design, not unverified", async () => {
    const { tenantId, branchId, productId, staffId } = await seed("pvg-4");
    const res = await placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "C",
      customerPhone: "01012345678", lines: line(productId),
      paymentMethod: "cash",
    });
    const [order] = await withTenant(tenantId, (tx) => tx.select().from(orders).where(eq(orders.id, res.orderId)));
    expect(order.paymentStatus).toBe("unpaid");

    await expect(transitionStatus(tenantId, res.orderId, "confirmed", staffId)).resolves.toBeDefined();
    await expect(transitionStatus(tenantId, res.orderId, "preparing", staffId)).resolves.toBeDefined();
    await expect(transitionStatus(tenantId, res.orderId, "ready", staffId)).resolves.toBeDefined();
    await expect(transitionStatus(tenantId, res.orderId, "completed", staffId)).resolves.toBeDefined();
  });
});
