import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { createBranch, updateBranchOrdering } from "@/server/branches/service";
import { createCategory, createProduct, updateProduct } from "@/server/catalog/service";
import { placeOrder, getOrderByToken, getOrder, listOrders, transitionStatus, markPaid, pendingOrderCount, ordersThisMonthCount } from "./service";
import { InvalidTransitionError } from "./errors";

async function setup(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG" }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro");
  const branch = await createBranch(t.id, { name: "Main" });
  await updateBranchOrdering(t.id, branch.id, { acceptingOrders: true });
  const cat = await createCategory(t.id, { nameEn: "P", nameAr: "ب" });
  const prod = await createProduct(t.id, { nameEn: "Pie", nameAr: "فطيرة", basePrice: "100", categoryId: cat.id });
  await updateProduct(t.id, prod.id, { isPublished: true });
  const order = await placeOrder(t.id, { branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1", lines: [{ productId: prod.id, quantity: 1, selectedOptionIds: [] }] });
  return { t, branch, order };
}

describe("orders queries + transitions", () => {
  it("getOrderByToken returns the order with items and computed total", async () => {
    const { t, order } = await setup("o1");
    const found = await getOrderByToken(t.id, order.statusToken);
    expect(found?.orderNumber).toBe(1);
    expect(found?.items).toHaveLength(1);
    expect(Number(found?.total)).toBeCloseTo(114); // 100 + 14% VAT, pickup
  });

  it("getOrderByToken returns null for unknown token", async () => {
    const { t } = await setup("o2");
    expect(await getOrderByToken(t.id, "nope")).toBeNull();
  });

  it("legal transition pending→confirmed writes a status event", async () => {
    const { t, order } = await setup("o3");
    await transitionStatus(t.id, order.orderId, "confirmed", "00000000-0000-0000-0000-000000000001");
    const detail = await getOrder(t.id, order.orderId);
    expect(detail.status).toBe("confirmed");
    expect(detail.events.map((e) => e.toStatus)).toContain("confirmed");
  });

  it("illegal transition throws", async () => {
    const { t, order } = await setup("o4");
    await expect(transitionStatus(t.id, order.orderId, "completed", "00000000-0000-0000-0000-000000000001")).rejects.toThrow(InvalidTransitionError);
  });

  it("cancel records the reason", async () => {
    const { t, order } = await setup("o5");
    const cancelled = await transitionStatus(t.id, order.orderId, "cancelled", "00000000-0000-0000-0000-000000000001", "out of stock");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelReason).toBe("out of stock");
  });

  it("markPaid flips payment independently of status", async () => {
    const { t, order } = await setup("o6");
    const paid = await markPaid(t.id, order.orderId, "00000000-0000-0000-0000-000000000001");
    expect(paid.paymentStatus).toBe("paid");
    expect(paid.status).toBe("pending");
  });

  it("listOrders + pendingOrderCount", async () => {
    const { t } = await setup("o7");
    const list = await listOrders(t.id, {});
    expect(list).toHaveLength(1);
    expect(await pendingOrderCount(t.id)).toBe(1);
  });

  it("ordersThisMonthCount counts orders placed in the current billing period", async () => {
    const { t } = await setup("o8");
    expect(await ordersThisMonthCount(t.id)).toBe(1);
  });
});
