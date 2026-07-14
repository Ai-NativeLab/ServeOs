import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { eq } from "drizzle-orm";
import { tenants } from "@/server/tenancy/schema";
import { users } from "@/server/auth/schema";
import { plans, subscriptions } from "@/server/subscription/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { createBranch, updateBranchOrdering, createDeliveryArea, updateDeliveryArea } from "@/server/branches/service";
import { createCategory, createProduct, updateProduct, upsertModifierGroup, upsertModifierOption } from "@/server/catalog/service";
import { placeOrder } from "./service";
import { TotalMismatchError } from "./errors";

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
  const [user] = await db.insert(users).values({ tenantId: t.id, name: "Cashier" }).returning();
  return { t, branch, pizza, cheese, area, user };
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

  it("rejects a modifier option that belongs to another product", async () => {
    const { t, branch, pizza } = await setup("po7");
    const { OrderValidationError } = await import("./errors");
    const cat2 = await createCategory(t.id, { nameEn: "Drinks", nameAr: "مشروبات" });
    const cola = await createProduct(t.id, { nameEn: "Cola", nameAr: "كولا", basePrice: "20", categoryId: cat2.id });
    await updateProduct(t.id, cola.id, { isPublished: true });
    const g2 = await upsertModifierGroup(t.id, cola.id, { nameEn: "Size", nameAr: "حجم", required: false, minSelections: 0, maxSelections: 1 });
    const large = await upsertModifierOption(t.id, g2.id, { nameEn: "Large", nameAr: "كبير", priceDelta: "5" });
    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [large.id] }],
    })).rejects.toThrow(OrderValidationError);
  });

  it("rejects a delivery area that belongs to another branch", async () => {
    const { t, branch, pizza } = await setup("po8");
    const { AreaNotDeliverableError } = await import("./errors");
    const branch2 = await createBranch(t.id, { name: "Second" });
    const foreignArea = await createDeliveryArea(t.id, branch2.id, { nameEn: "Other", nameAr: "أخرى", deliveryFee: "10", minOrderAmount: "0" });
    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "delivery", customerName: "A", customerPhone: "1",
      areaId: foreignArea.id, addressText: "x", lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(AreaNotDeliverableError);
  });

  it("rejects when the branch is inactive (soft-deleted)", async () => {
    const { t, branch, pizza } = await setup("po9");
    const { BranchNotAcceptingOrdersError } = await import("./errors");
    const { deleteBranch } = await import("@/server/branches/service");
    await deleteBranch(t.id, branch.id);
    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(BranchNotAcceptingOrdersError);
  });

  it("persists a valid scheduledFor", async () => {
    const { t, branch, pizza } = await setup("po-sched1");
    const scheduled = new Date(Date.now() + 2 * 60 * 60 * 1000); // +2h
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      scheduledFor: scheduled.toISOString(),
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });
    const { getOrderByToken } = await import("./service");
    const order = await getOrderByToken(t.id, res.statusToken);
    expect(order?.scheduledFor).not.toBeNull();
    expect(Math.abs(order!.scheduledFor!.getTime() - scheduled.getTime())).toBeLessThan(1000);
  });

  it("rejects a scheduledFor under the minimum lead", async () => {
    const { t, branch, pizza } = await setup("po-sched2");
    const { InvalidScheduleError } = await import("./errors");
    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      scheduledFor: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // +10min < 30min lead
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(InvalidScheduleError);
  });

  it("rejects a scheduledFor beyond today+tomorrow", async () => {
    const { t, branch, pizza } = await setup("po-sched3");
    const { InvalidScheduleError } = await import("./errors");
    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      scheduledFor: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(), // +3 days
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(InvalidScheduleError);
  });

  it("rejects an unparseable scheduledFor", async () => {
    const { t, branch, pizza } = await setup("po-sched4");
    const { InvalidScheduleError } = await import("./errors");
    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      scheduledFor: "not-a-date",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(InvalidScheduleError);
  });

  it("rejects a scheduledFor when the branch is closed at that time, but allows a pre-order while closed now", async () => {
    const { t, branch, pizza } = await setup("po-sched5");
    const { InvalidScheduleError } = await import("./errors");
    // Open 10:00–23:00 every day (tenant tz Africa/Cairo, the default).
    await updateBranchOrdering(t.id, branch.id, {
      acceptingOrders: true,
      openingHours: Array.from({ length: 7 }, (_, day) => ({ day, open: "10:00", close: "23:00", closed: false })),
    });
    const { listSlots } = await import("@/server/branches/slots");
    const { getBranch } = await import("@/server/branches/service");
    const b = await getBranch(t.id, branch.id);
    const slots = listSlots(b, "Africa/Cairo", new Date());
    // A valid slot exists regardless of current wall-clock (today or tomorrow):
    expect(slots.length).toBeGreaterThan(0);
    const ok = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      scheduledFor: slots[0].toISOString(),
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });
    expect(ok.orderNumber).toBe(1);
    // Tomorrow 01:00 UTC = 04:00 Cairo — inside the horizon, outside the
    // 10:00–23:00 hours. (setUTCDate(getUTCDate()+1) rolls months correctly.)
    const closedAt = new Date();
    closedAt.setUTCDate(closedAt.getUTCDate() + 1);
    closedAt.setUTCHours(1, 0, 0, 0);
    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      scheduledFor: closedAt.toISOString(),
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(InvalidScheduleError);
  });

  it("keeps default totals identical to the legacy computation (VAT exclusive, no service charge)", async () => {
    const { t, branch, pizza } = await setup("po-tot1");
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });
    const { getOrder } = await import("./service");
    const order = await getOrder(t.id, res.orderId);
    expect(order.subtotal).toBe("100.00");
    expect(order.vatAmount).toBe("14.00");     // EG default 14%
    expect(order.serviceChargeAmount).toBeNull();
    expect(order.total).toBe("114.00");
  });

  it("applies a configured service charge for a restaurant tenant", async () => {
    const { t, branch, pizza } = await setup("po-tot2");
    const { setServiceChargeRate } = await import("@/server/tenancy");
    await setServiceChargeRate(t.id, 10);
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });
    const { getOrder } = await import("./service");
    const order = await getOrder(t.id, res.orderId);
    expect(order.serviceChargeAmount).toBe("10.00");
    expect(order.vatAmount).toBe("15.40"); // 14% of 110
    expect(order.total).toBe("125.40");
  });
});

async function setupRetail(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "R", country: "EG", vertical: "retail" }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro");
  const branch = await createBranch(t.id, { name: "Main" });
  await updateBranchOrdering(t.id, branch.id, { acceptingOrders: true, openingHours: [] });
  const cat = await createCategory(t.id, { nameEn: "Hinges", nameAr: "مفصلات" });
  const hinge = await createProduct(t.id, { nameEn: "Hinge", nameAr: "مفصلة", basePrice: "50", categoryId: cat.id });
  await updateProduct(t.id, hinge.id, { isPublished: true });
  const { upsertVariant } = await import("@/server/catalog/variants");
  const v35 = await upsertVariant(t.id, hinge.id, { nameEn: "35mm", nameAr: "٣٥مم", price: "55", stockQuantity: 2 });
  return { t, branch, hinge, v35 };
}

describe("placeOrder retail variants + stock", () => {
  it("prices a variant line from the DB and snapshots the variant name", async () => {
    const { t, branch, hinge, v35 } = await setupRetail("rv1");
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: hinge.id, variantId: v35.id, quantity: 2, selectedOptionIds: [] }],
    });
    const { getOrder } = await import("./service");
    const order = await getOrder(t.id, res.orderId);
    expect(order.subtotal).toBe("110.00"); // 2 × 55, NOT basePrice 50
    expect(order.items[0].variantNameEn).toBe("35mm");
    expect(order.items[0].variantId).toBe(v35.id);
  });

  it("decrements stock and rejects when insufficient", async () => {
    const { t, branch, hinge, v35 } = await setupRetail("rv2");
    const { OutOfStockError } = await import("./errors");
    await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: hinge.id, variantId: v35.id, quantity: 2, selectedOptionIds: [] }],
    }); // stock now 0
    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "B", customerPhone: "2",
      lines: [{ productId: hinge.id, variantId: v35.id, quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(OutOfStockError);
  });

  it("exactly one of two concurrent orders for the last unit succeeds", async () => {
    const { t, branch, hinge } = await setupRetail("rv3");
    const { upsertVariant } = await import("@/server/catalog/variants");
    const last = await upsertVariant(t.id, hinge.id, { nameEn: "40mm", nameAr: "٤٠مم", price: "60", stockQuantity: 1 });
    const attempt = (name: string) => placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: name, customerPhone: "1",
      lines: [{ productId: hinge.id, variantId: last.id, quantity: 1, selectedOptionIds: [] }],
    });
    const results = await Promise.allSettled([attempt("A"), attempt("B")]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok.length).toBe(1);
    expect(failed.length).toBe(1);
  });

  it("rejects an unknown or inactive variant", async () => {
    const { t, branch, hinge } = await setupRetail("rv4");
    const { InvalidVariantError } = await import("@/server/catalog/errors");
    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: hinge.id, variantId: "00000000-0000-0000-0000-000000000000", quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(InvalidVariantError);
  });

  it("restocks on customer cancel", async () => {
    const { t, branch, hinge, v35 } = await setupRetail("rv5");
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: hinge.id, variantId: v35.id, quantity: 2, selectedOptionIds: [] }],
    });
    const { cancelOrderByToken } = await import("./service");
    await cancelOrderByToken(t.id, res.statusToken);
    const { listVariants } = await import("@/server/catalog/variants");
    const [v] = await listVariants(t.id, hinge.id);
    expect(v.stockQuantity).toBe(2); // back to full
  });
});

describe("placeOrder — POS extensions", () => {
  it("applies line and order discounts before tax and stores them", async () => {
    const { t, branch, pizza } = await setup("pos-ext1");
    const res = await placeOrder(t.id, {
      branchId: branch.id,
      fulfillmentType: "pickup",
      customerName: "Walk-in",
      customerPhone: "000000000",
      channel: "pos",
      lines: [{ productId: pizza.id, quantity: 2, selectedOptionIds: [], discountAmount: 50, discountReason: "promo" }],
      orderDiscountAmount: 20,
      orderDiscountReason: "manager_discretion",
    });
    const { getOrder } = await import("./service");
    const order = await getOrder(t.id, res.orderId);
    expect(order.channel).toBe("pos");
    expect(Number(order.discountAmount)).toBe(20);
    // base 100 x2 = 200, less 50 line, less 20 order => subtotal 130
    expect(Number(order.subtotal)).toBe(130);
  });

  it("rejects the sale when the client's expected total disagrees", async () => {
    const { t, branch, pizza } = await setup("pos-ext2");
    await expect(
      placeOrder(t.id, {
        branchId: branch.id,
        fulfillmentType: "pickup",
        customerName: "Walk-in",
        customerPhone: "000000000",
        channel: "pos",
        expectedTotal: 1,
        lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
      }),
    ).rejects.toThrow(TotalMismatchError);
  });

  it("creates no order when the total mismatches", async () => {
    const { t, branch, pizza } = await setup("pos-ext3");
    const { listOrders } = await import("./service");
    const before = await listOrders(t.id, {});
    await expect(
      placeOrder(t.id, {
        branchId: branch.id, fulfillmentType: "pickup", customerName: "Walk-in", customerPhone: "000000000",
        channel: "pos", expectedTotal: 1,
        lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
      }),
    ).rejects.toThrow(TotalMismatchError);
    const after = await listOrders(t.id, {});
    expect(after).toHaveLength(before.length);
  });

  it("attributes the cashier", async () => {
    const { t, branch, pizza, user } = await setup("pos-ext4");
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "Walk-in", customerPhone: "000000000",
      channel: "pos", cashierUserId: user.id,
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });
    const { getOrder } = await import("./service");
    const order = await getOrder(t.id, res.orderId);
    expect(order.cashierUserId).toBe(user.id);
  });

  it("returns total and index-aligned itemIds", async () => {
    const { t, branch, pizza } = await setup("pos-ext5");
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "Walk-in", customerPhone: "000000000",
      lines: [
        { productId: pizza.id, quantity: 1, selectedOptionIds: [] },
        { productId: pizza.id, quantity: 3, selectedOptionIds: [] },
      ],
    });
    const { getOrder } = await import("./service");
    const order = await getOrder(t.id, res.orderId);
    expect(res.itemIds).toHaveLength(2);
    expect(new Set(res.itemIds)).toEqual(new Set(order.items.map((i) => i.id)));
    expect(order.items.find((i) => i.id === res.itemIds[0])?.quantity).toBe(1);
    expect(order.items.find((i) => i.id === res.itemIds[1])?.quantity).toBe(3);
    expect(res.total).toBe(Number(order.total));
  });
});
