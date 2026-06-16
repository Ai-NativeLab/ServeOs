import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { eq } from "drizzle-orm";
import { tenants } from "@/server/tenancy/schema";
import { plans, subscriptions } from "@/server/subscription/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { createBranch, updateBranchOrdering, createDeliveryArea, updateDeliveryArea } from "@/server/branches/service";
import { createCategory, createProduct, updateProduct, upsertModifierGroup, upsertModifierOption } from "@/server/catalog/service";
import { placeOrder } from "./service";

async function setup(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG" }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro"); // pro: branches 3, products 500
  const branch = await createBranch(t.id, { name: "Main" });
  await updateBranchOrdering(t.id, branch.id, { acceptingOrders: true, openingHours: [] });
  const cat = await createCategory(t.id, { nameEn: "Pizza", nameAr: "بيتزا" });
  const pizza = await createProduct(t.id, { nameEn: "Margherita", nameAr: "مارجريتا", basePrice: "100", categoryId: cat.id });
  await updateProduct(t.id, pizza.id, { isPublished: true });
  const group = await upsertModifierGroup(t.id, pizza.id, { nameEn: "Extras", nameAr: "إضافات", required: false, minSelections: 0, maxSelections: 2 });
  const cheese = await upsertModifierOption(t.id, group.id, { nameEn: "Cheese", nameAr: "جبنة", priceDelta: "15" });
  const area = await createDeliveryArea(t.id, branch.id, { nameEn: "Maadi", nameAr: "المعادي", deliveryFee: "25", minOrderAmount: "100" });
  return { t, branch, pizza, cheese, area };
}

describe("placeOrder", () => {
  it("creates a delivery order and returns number + token", async () => {
    const { t, branch, pizza, cheese, area } = await setup("po1");
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "delivery",
      customerName: "Ahmed", customerPhone: "0100",
      areaId: area.id, addressText: "12 St",
      lines: [{ productId: pizza.id, quantity: 2, selectedOptionIds: [cheese.id] }],
    });
    expect(res.orderNumber).toBe(1);
    expect(res.statusToken).toMatch(/.+/);
  });

  it("rejects when subtotal below the area minimum", async () => {
    const { t, branch, pizza, area } = await setup("po2");
    const { MinimumOrderNotMetError } = await import("./errors");
    await updateDeliveryArea(t.id, area.id, { minOrderAmount: "500" });
    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "delivery", customerName: "A", customerPhone: "1",
      areaId: area.id, addressText: "x", lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(MinimumOrderNotMetError);
  });

  it("rejects an unpublished product", async () => {
    const { t, branch, pizza } = await setup("po3");
    const { OrderValidationError } = await import("./errors");
    await updateProduct(t.id, pizza.id, { isPublished: false });
    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(OrderValidationError);
  });

  it("rejects when branch not accepting orders", async () => {
    const { t, branch, pizza } = await setup("po4");
    const { BranchNotAcceptingOrdersError } = await import("./errors");
    await updateBranchOrdering(t.id, branch.id, { acceptingOrders: false });
    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(BranchNotAcceptingOrdersError);
  });

  it("blocks checkout when online_ordering feature is off", async () => {
    const { t, branch, pizza } = await setup("po5");
    const { FeatureNotAvailableError } = await import("@/server/entitlements/errors");
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.tenantId, t.id)).limit(1);
    const [plan] = await db.select().from(plans).where(eq(plans.id, sub.planId)).limit(1);
    await db.update(plans).set({ features: { ...plan.features, online_ordering: false } }).where(eq(plans.id, plan.id));
    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(FeatureNotAvailableError);
  });

  it("increments per-tenant order_number", async () => {
    const { t, branch, pizza } = await setup("po6");
    const a = await placeOrder(t.id, { branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1", lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }] });
    const b = await placeOrder(t.id, { branchId: branch.id, fulfillmentType: "pickup", customerName: "B", customerPhone: "2", lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }] });
    expect(a.orderNumber).toBe(1);
    expect(b.orderNumber).toBe(2);
  });
});
