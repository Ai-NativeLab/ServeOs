import { describe, it, expect, vi, afterEach } from "vitest";
import { db } from "@/db/client";
import { eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { orders } from "./schema";
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

  it("places an offline (vodafone_cash) order as pending_verification with the proof", async () => {
    const { t, branch, pizza } = await setup("pay-vc");
    const { upsertOfflineMethod } = await import("@/server/payments/offline/methods");
    await upsertOfflineMethod(t.id, { type: "vodafone_cash", label: "Vodafone Cash", payToDetail: "0100" });
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      paymentMethod: "vodafone_cash", paymentReference: "VC-99887",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });
    const { getOrder } = await import("./service");
    const order = await getOrder(t.id, res.orderId);
    expect(order.paymentStatus).toBe("pending_verification");
    expect(order.paymentMethod).toBe("vodafone_cash");
    expect(order.paymentReference).toBe("VC-99887");
  });

  it("rejects an offline method the tenant hasn't enabled", async () => {
    const { t, branch, pizza } = await setup("pay-vc2");
    const { PaymentMethodNotEnabledError } = await import("@/server/payments/offline");
    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      paymentMethod: "instapay", paymentReference: "X",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(PaymentMethodNotEnabledError);
  });

  it("requires a reference for offline methods", async () => {
    const { t, branch, pizza } = await setup("pay-vc3");
    const { upsertOfflineMethod } = await import("@/server/payments/offline/methods");
    const { InvalidProofError } = await import("@/server/payments/offline");
    await upsertOfflineMethod(t.id, { type: "instapay", label: "InstaPay", payToDetail: "a@instapay" });
    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      paymentMethod: "instapay",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(InvalidProofError);
  });

  it("keeps cash orders unpaid exactly as before", async () => {
    const { t, branch, pizza } = await setup("pay-cash");
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });
    const { getOrder } = await import("./service");
    const order = await getOrder(t.id, res.orderId);
    expect(order.paymentStatus).toBe("unpaid");
    expect(order.paymentMethod).toBe("cash");
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

  // Stock now lives in the ledger, so these seed lots rather than the legacy
  // integer — which no longer drives deduction at all.
  it("deducts through the ledger and rejects when insufficient", async () => {
    const { t, branch, hinge, v35 } = await setupRetail("rv2");
    const { OutOfStockError } = await import("./errors");
    const { seedFinishedGood } = await import("@/server/inventory/test-helpers");
    const { onHand } = await import("@/server/inventory/service");
    const { itemId, locationId } = await seedFinishedGood(t.id, {
      branchId: branch.id, productId: hinge.id, variantId: v35.id, onHand: 2,
    });

    await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: hinge.id, variantId: v35.id, quantity: 2, selectedOptionIds: [] }],
    });
    expect(await onHand(t.id, itemId, locationId)).toBe(0);

    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "B", customerPhone: "2",
      lines: [{ productId: hinge.id, variantId: v35.id, quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(OutOfStockError);

    // Retail blocks rather than going negative, and the rejected order left nothing behind.
    expect(await onHand(t.id, itemId, locationId)).toBe(0);
  });

  it("exactly one of two concurrent orders for the last unit succeeds", async () => {
    const { t, branch, hinge } = await setupRetail("rv3");
    const { upsertVariant } = await import("@/server/catalog/variants");
    const { seedFinishedGood } = await import("@/server/inventory/test-helpers");
    const { onHand } = await import("@/server/inventory/service");
    const last = await upsertVariant(t.id, hinge.id, { nameEn: "40mm", nameAr: "٤٠مم", price: "60" });
    const { itemId, locationId } = await seedFinishedGood(t.id, {
      branchId: branch.id, productId: hinge.id, variantId: last.id, onHand: 1,
    });

    const attempt = (name: string) => placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: name, customerPhone: "1",
      lines: [{ productId: hinge.id, variantId: last.id, quantity: 1, selectedOptionIds: [] }],
    });
    const results = await Promise.allSettled([attempt("A"), attempt("B")]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok.length).toBe(1);
    expect(failed.length).toBe(1);
    // The per-lot guarded UPDATE serialized them: one unit sold, never oversold.
    expect(await onHand(t.id, itemId, locationId)).toBe(0);
  });

  it("rejects an unknown or inactive variant", async () => {
    const { t, branch, hinge } = await setupRetail("rv4");
    const { InvalidVariantError } = await import("@/server/catalog/errors");
    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: hinge.id, variantId: "00000000-0000-0000-0000-000000000000", quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(InvalidVariantError);
  });

  it("restocks on customer cancel by reversing the ledger to the same lot", async () => {
    const { t, branch, hinge, v35 } = await setupRetail("rv5");
    const { seedFinishedGood } = await import("@/server/inventory/test-helpers");
    const { onHand } = await import("@/server/inventory/service");
    const { itemId, locationId, lotId } = await seedFinishedGood(t.id, {
      branchId: branch.id, productId: hinge.id, variantId: v35.id, onHand: 2,
    });

    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: hinge.id, variantId: v35.id, quantity: 2, selectedOptionIds: [] }],
    });
    expect(await onHand(t.id, itemId, locationId)).toBe(0);

    const { cancelOrderByToken } = await import("./service");
    await cancelOrderByToken(t.id, res.statusToken);

    expect(await onHand(t.id, itemId, locationId)).toBe(2); // back to full
    // Restored to the ORIGINAL lot, so its cost layer is not lost.
    const { withTenant } = await import("@/db/with-tenant");
    const { inventoryLots, stockLedger } = await import("@/server/inventory/schema");
    const { eq } = await import("drizzle-orm");
    const [lot] = await withTenant(t.id, (tx) =>
      tx.select().from(inventoryLots).where(eq(inventoryLots.id, lotId)));
    expect(Number(lot.qtyRemaining)).toBe(2);
    const restocks = await withTenant(t.id, (tx) =>
      tx.select().from(stockLedger).where(eq(stockLedger.type, "refund_restock")));
    expect(restocks).toHaveLength(1);
    expect(restocks[0].lotId).toBe(lotId);
  });
});

describe("placeOrder — legacy stock adoption + storefront mirror", () => {
  it("a product created AFTER the backfill still cannot be oversold", async () => {
    // The backfill only linked rows that existed when it ran. Deduction is gated
    // on a link, so without adoption this product would sell without any limit —
    // the guarded integer UPDATE that used to stop it is gone.
    const { t, branch, hinge, v35 } = await setupRetail("adopt1");
    const { OutOfStockError } = await import("./errors");
    void v35;

    // No inventory seeding at all: `hinge` only has the legacy integer.
    const { setProductStock } = await import("@/server/catalog/variants");
    await setProductStock(t.id, hinge.id, 3);

    await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: hinge.id, quantity: 3, selectedOptionIds: [] }],
    });

    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "B", customerPhone: "2",
      lines: [{ productId: hinge.id, quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(OutOfStockError);
  });

  it("selling down to zero flips the storefront's inStock flag", async () => {
    // placeOrder no longer decrements products.stockQuantity, but the storefront
    // still derives inStock from it — so it must be mirrored back or a sold-out
    // item advertises itself forever.
    const { t, branch } = await setupRetail("mirror1");
    const { setProductStock } = await import("@/server/catalog/variants");
    const { getPublishedMenu, createCategory, createProduct, updateProduct } = await import("@/server/catalog/service");

    // A product with NO variants, so inStock is derived from the product's own
    // stockQuantity rather than from its variants'.
    const cat = await createCategory(t.id, { nameEn: "Screws", nameAr: "براغي" });
    const screw = await createProduct(t.id, { nameEn: "Screw", nameAr: "برغي", basePrice: "10", categoryId: cat.id });
    await updateProduct(t.id, screw.id, { isPublished: true });
    await setProductStock(t.id, screw.id, 2);

    const findProduct = async () =>
      (await getPublishedMenu(t.id)).categories.flatMap((c) => c.products).find((p) => p.id === screw.id);

    expect((await findProduct())?.inStock).toBe(true);

    await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: screw.id, quantity: 2, selectedOptionIds: [] }],
    });

    expect((await findProduct())?.inStock).toBe(false);
  });
});

describe("placeOrder — restaurant recipes (BOM)", () => {
  it("selling a dish deducts its recipe ingredients from the branch kitchen", async () => {
    const { t, branch, pizza } = await setup("bom1");
    const { seedRecipeProduct } = await import("@/server/inventory/test-helpers");
    const { onHand } = await import("@/server/inventory/service");
    const { locationId, itemIds } = await seedRecipeProduct(t.id, {
      branchId: branch.id, productId: pizza.id,
      components: [
        { nameEn: "Dough", qty: "200", uom: "g", onHand: 1000 },
        { nameEn: "Mozzarella", qty: "150", uom: "g", onHand: 1000 },
      ],
    });

    await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: pizza.id, quantity: 2, selectedOptionIds: [] }],
    });

    expect(await onHand(t.id, itemIds[0], locationId)).toBe(600); // 1000 - 2*200
    expect(await onHand(t.id, itemIds[1], locationId)).toBe(700); // 1000 - 2*150
  });

  it("a kitchen is never blocked at the till: the sale completes and on-hand goes negative", async () => {
    const { t, branch, pizza } = await setup("bom2");
    const { seedRecipeProduct } = await import("@/server/inventory/test-helpers");
    const { onHand } = await import("@/server/inventory/service");
    // Only 100 g of dough on hand, but the customer is ordering two pizzas.
    const { locationId, itemIds } = await seedRecipeProduct(t.id, {
      branchId: branch.id, productId: pizza.id,
      components: [{ nameEn: "Dough", qty: "200", uom: "g", onHand: 100 }],
    });

    // Restaurant default allowNegativeStock=true, so this must NOT throw.
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: pizza.id, quantity: 2, selectedOptionIds: [] }],
    });
    expect(res.orderId).toBeTruthy();

    // 100 taken from the lot, 300 recorded as a lot-less shortfall.
    expect(await onHand(t.id, itemIds[0], locationId)).toBe(-300);
  });

  it("a dish with no recipe link still sells — a restaurant can enable inventory before building recipes", async () => {
    const { t, branch, pizza } = await setup("bom3");
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: pizza.id, quantity: 3, selectedOptionIds: [] }],
    });
    expect(res.orderId).toBeTruthy();
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

describe("confirmOrderPayment / rejectOrderPayment", () => {
  it("confirms an offline order payment → paid, idempotently", async () => {
    const { t, branch, pizza, user } = await setup("cf1");
    const { upsertOfflineMethod } = await import("@/server/payments/offline/methods");
    await upsertOfflineMethod(t.id, { type: "instapay", label: "InstaPay", payToDetail: "a@instapay" });
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      paymentMethod: "instapay", paymentReference: "IP-1",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });
    const { confirmOrderPayment, getOrder } = await import("./service");
    await confirmOrderPayment(t.id, res.orderId, user.id);
    expect((await getOrder(t.id, res.orderId)).paymentStatus).toBe("paid");
    const { PaymentAlreadyResolvedError } = await import("@/server/payments/offline");
    await expect(confirmOrderPayment(t.id, res.orderId, user.id))
      .rejects.toThrow(PaymentAlreadyResolvedError);
  });

  it("rejecting an offline order payment cancels + restocks", async () => {
    const { t, branch, pizza, user } = await setup("cf2");
    const { upsertOfflineMethod } = await import("@/server/payments/offline/methods");
    await upsertOfflineMethod(t.id, { type: "instapay", label: "InstaPay", payToDetail: "a@instapay" });
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      paymentMethod: "instapay", paymentReference: "IP-2",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });
    const { rejectOrderPayment } = await import("./service");
    const o = await rejectOrderPayment(t.id, res.orderId, user.id, "no funds received");
    expect(o.status).toBe("cancelled");
  });

  it("reject then confirm is refused", async () => {
    const { t, branch, pizza, user } = await setup("cf3");
    const { upsertOfflineMethod } = await import("@/server/payments/offline/methods");
    await upsertOfflineMethod(t.id, { type: "instapay", label: "InstaPay", payToDetail: "a@instapay" });
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      paymentMethod: "instapay", paymentReference: "IP-3",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });
    const { confirmOrderPayment, rejectOrderPayment, getOrder } = await import("./service");
    const { PaymentAlreadyResolvedError } = await import("@/server/payments/offline");
    await rejectOrderPayment(t.id, res.orderId, user.id, "no funds received");
    await expect(confirmOrderPayment(t.id, res.orderId, user.id))
      .rejects.toThrow(PaymentAlreadyResolvedError);
    const order = await getOrder(t.id, res.orderId);
    expect(order.status).toBe("cancelled");
    expect(order.paymentStatus).not.toBe("paid");
  });

  it("confirm then reject is refused", async () => {
    const { t, branch, pizza, user } = await setup("cf4");
    const { upsertOfflineMethod } = await import("@/server/payments/offline/methods");
    await upsertOfflineMethod(t.id, { type: "instapay", label: "InstaPay", payToDetail: "a@instapay" });
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      paymentMethod: "instapay", paymentReference: "IP-4",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });
    const { confirmOrderPayment, rejectOrderPayment, getOrder } = await import("./service");
    const { PaymentAlreadyResolvedError } = await import("@/server/payments/offline");
    await confirmOrderPayment(t.id, res.orderId, user.id);
    await expect(rejectOrderPayment(t.id, res.orderId, user.id, "no funds received"))
      .rejects.toThrow(PaymentAlreadyResolvedError);
    const order = await getOrder(t.id, res.orderId);
    expect(order.paymentStatus).toBe("paid");
    expect(order.status).not.toBe("cancelled");
  });
});

describe("listAwaitingPaymentOrders", () => {
  it("returns only pending_verification orders, newest first", async () => {
    const { t, branch, pizza, user } = await setup("aw1");
    const { upsertOfflineMethod } = await import("@/server/payments/offline/methods");
    await upsertOfflineMethod(t.id, { type: "instapay", label: "InstaPay", payToDetail: "a@instapay" });

    // Cash order stays "unpaid" — must be excluded from the confirmation queue.
    await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "Cash", customerPhone: "1",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });

    const older = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "Older", customerPhone: "2",
      paymentMethod: "instapay", paymentReference: "IP-OLD",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });
    const newer = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "Newer", customerPhone: "3",
      paymentMethod: "instapay", paymentReference: "IP-NEW",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });

    // A confirmed order was pending_verification too — must be excluded once resolved.
    const confirmed = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "Confirmed", customerPhone: "4",
      paymentMethod: "instapay", paymentReference: "IP-CONF",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });
    const { confirmOrderPayment, listAwaitingPaymentOrders } = await import("./service");
    await confirmOrderPayment(t.id, confirmed.orderId, user.id);

    // Force a deterministic newest/oldest gap, independent of wall-clock timing between inserts.
    const { withTenant } = await import("@/db/with-tenant");
    const { orders } = await import("./schema");
    await withTenant(t.id, (tx) => tx.update(orders).set({ placedAt: new Date(Date.now() - 60_000) }).where(eq(orders.id, older.orderId)));
    await withTenant(t.id, (tx) => tx.update(orders).set({ placedAt: new Date() }).where(eq(orders.id, newer.orderId)));

    const queue = await listAwaitingPaymentOrders(t.id);
    expect(queue.map((o) => o.id)).toEqual([newer.orderId, older.orderId]);
    expect(queue.every((o) => o.paymentStatus === "pending_verification")).toBe(true);
  });
});

describe("placeOrder paymentProofUrl sanitization", () => {
  it("drops a javascript: proof URL (stored XSS) and stores null instead", async () => {
    const { t, branch, pizza } = await setup("xss1");
    const { upsertOfflineMethod } = await import("@/server/payments/offline/methods");
    await upsertOfflineMethod(t.id, { type: "instapay", label: "InstaPay", payToDetail: "a@instapay" });
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      paymentMethod: "instapay", paymentReference: "IP-XSS",
      paymentProofUrl: "javascript:alert(1)",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });
    const { getOrder } = await import("./service");
    const order = await getOrder(t.id, res.orderId);
    expect(order.paymentProofUrl).toBeNull();
  });
});

describe("markPaid vs offline payment authorization gate", () => {
  it("refuses to mark an offline pending_verification order paid, bypassing the payments:confirm gate", async () => {
    const { t, branch, pizza, user } = await setup("mp1");
    const { upsertOfflineMethod } = await import("@/server/payments/offline/methods");
    await upsertOfflineMethod(t.id, { type: "instapay", label: "InstaPay", payToDetail: "a@instapay" });
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      paymentMethod: "instapay", paymentReference: "IP-MP1",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });
    const { markPaid, getOrder } = await import("./service");
    const { InvalidTransitionError } = await import("./errors");
    await expect(markPaid(t.id, res.orderId, user.id)).rejects.toThrow(InvalidTransitionError);
    const order = await getOrder(t.id, res.orderId);
    expect(order.paymentStatus).toBe("pending_verification");
  });
});

describe("rejectOrderPayment atomicity", () => {
  it("refuses to reject once the order has reached a non-cancellable terminal status, without touching paymentStatus", async () => {
    const { t, branch, pizza, user } = await setup("rp1");
    const { upsertOfflineMethod } = await import("@/server/payments/offline/methods");
    await upsertOfflineMethod(t.id, { type: "instapay", label: "InstaPay", payToDetail: "a@instapay" });
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      paymentMethod: "instapay", paymentReference: "IP-RP1",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });
    const { transitionStatus, rejectOrderPayment, getOrder } = await import("./service");
    const { InvalidTransitionError } = await import("./errors");
    const userId = user.id;
    // Advance the fulfillment status all the way to "completed" — a reachable
    // terminal status per the real state machine (pending → confirmed →
    // preparing → ready → completed for pickup) — WITHOUT resolving the
    // payment, so paymentStatus stays pending_verification throughout.
    await transitionStatus(t.id, res.orderId, "confirmed", userId);
    await transitionStatus(t.id, res.orderId, "preparing", userId);
    await transitionStatus(t.id, res.orderId, "ready", userId);
    await transitionStatus(t.id, res.orderId, "completed", userId);

    const before = await getOrder(t.id, res.orderId);
    expect(before.status).toBe("completed");
    expect(before.paymentStatus).toBe("pending_verification");

    await expect(rejectOrderPayment(t.id, res.orderId, userId, "no funds received")).rejects.toThrow(InvalidTransitionError);

    const after = await getOrder(t.id, res.orderId);
    expect(after.status).toBe("completed");
    // The claim must never have run: paymentStatus is untouched, not flipped to "unpaid".
    expect(after.paymentStatus).toBe("pending_verification");
  });

  it("exactly one of concurrent confirm/reject wins, and the order never ends up cancelled+paid", async () => {
    const { t, branch, pizza, user } = await setup("rp2");
    const { upsertOfflineMethod } = await import("@/server/payments/offline/methods");
    await upsertOfflineMethod(t.id, { type: "instapay", label: "InstaPay", payToDetail: "a@instapay" });
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      paymentMethod: "instapay", paymentReference: "IP-RP2",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });
    const { confirmOrderPayment, rejectOrderPayment, getOrder } = await import("./service");
    const userId = user.id;
    const results = await Promise.allSettled([
      confirmOrderPayment(t.id, res.orderId, userId),
      rejectOrderPayment(t.id, res.orderId, userId, "no funds received"),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok.length).toBe(1);
    expect(failed.length).toBe(1);

    const order = await getOrder(t.id, res.orderId);
    // The corrupt state this atomicity fix guards against: cancelled status
    // with paymentStatus somehow left/landed on "paid".
    expect(order.status === "cancelled" && order.paymentStatus === "paid").toBe(false);
  });
});

/** Every broadcast the ordering service made, plus whether the row it names
 *  was already committed at the moment the publisher reached for the network. */
type SeenBroadcast = { event: string; entityIds: string[]; committed: boolean };

function captureBroadcasts(tenantId: string): SeenBroadcast[] {
  const seen: SeenBroadcast[] = [];
  vi.stubEnv("SUPABASE_URL", "https://proj.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "svc-key");
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const msg = JSON.parse(String(init.body)).messages[0];
    const entityIds: string[] = msg.payload.entityIds;
    // Read on a DIFFERENT connection than the order's transaction used: if the
    // publish had been made inside that transaction, this select could not see
    // the row yet.
    const rows = entityIds.length
      ? await withTenant(tenantId, (tx) => tx.select().from(orders).where(eq(orders.id, entityIds[0])))
      : [];
    seen.push({ event: msg.event, entityIds, committed: rows.length === 1 });
    return new Response(null, { status: 202 });
  }));
  return seen;
}

describe("placeOrder realtime propagation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("broadcasts orders.changed with the order id, after the order has committed", async () => {
    const { t, branch, pizza } = await setup("rt1");
    const seen = captureBroadcasts(t.id);

    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });

    expect(seen).toEqual([{ event: "orders.changed", entityIds: [res.orderId], committed: true }]);
  });

  it("still places the order when the broadcast fails", async () => {
    const { t, branch, pizza } = await setup("rt2");
    vi.stubEnv("SUPABASE_URL", "https://proj.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "svc-key");
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("realtime is down");
    }));

    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });

    expect(res.orderNumber).toBe(1);
    const rows = await withTenant(t.id, (tx) => tx.select().from(orders).where(eq(orders.id, res.orderId)));
    expect(rows).toHaveLength(1);
  });

  it("broadcasts on a status transition and on a payment confirmation", async () => {
    const { t, branch, pizza, user } = await setup("rt3");
    const { upsertOfflineMethod } = await import("@/server/payments/offline/methods");
    await upsertOfflineMethod(t.id, { type: "instapay", label: "InstaPay", payToDetail: "a@instapay" });
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      paymentMethod: "instapay", paymentReference: "IP-RT3",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });

    const seen = captureBroadcasts(t.id);
    const { confirmOrderPayment, transitionStatus } = await import("./service");
    await confirmOrderPayment(t.id, res.orderId, user.id);
    await transitionStatus(t.id, res.orderId, "confirmed", user.id);

    expect(seen).toEqual([
      { event: "orders.changed", entityIds: [res.orderId], committed: true },
      { event: "orders.changed", entityIds: [res.orderId], committed: true },
    ]);
  });
});
