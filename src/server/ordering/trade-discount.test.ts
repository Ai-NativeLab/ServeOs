import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { createBranch, updateBranchOrdering } from "@/server/branches/service";
import { createCategory, createProduct, updateProduct } from "@/server/catalog/service";
import { registerCustomer } from "@/server/customers/service";
import { withTenant } from "@/db/with-tenant";
import { customers } from "@/server/customers/schema";
import { eq } from "drizzle-orm";
import { placeOrder } from "./service";

async function seed(slug: string, vertical: "timber" | "restaurant" = "timber") {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG", vertical }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro");
  const branch = await createBranch(t.id, { name: "Yard" });
  await updateBranchOrdering(t.id, branch.id, { acceptingOrders: true });
  const cat = await createCategory(t.id, { nameEn: "Beam", nameAr: "عارضة" });
  const prod = await createProduct(t.id, { nameEn: "Beam", nameAr: "عارضة", basePrice: "100.00", categoryId: cat.id });
  await updateProduct(t.id, prod.id, { isPublished: true });
  return { tenantId: t.id, branchId: branch.id, productId: prod.id };
}

async function tradeApprove(tenantId: string, customerId: string, percent: number) {
  await withTenant(tenantId, (tx) => tx.update(customers)
    .set({ tradeApproved: true, tradeDiscountPercent: String(percent) })
    .where(eq(customers.id, customerId)));
}

describe("trade-account discount", () => {
  it("applies the customer's discount percent to a timber order", async () => {
    const { tenantId, branchId, productId } = await seed("trade-1");
    const me = await registerCustomer(tenantId, { name: "Yard Co", email: "y@x.com", password: "secret123" });
    await tradeApprove(tenantId, me.id, 10); // 10% off

    const res = await placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "Yard Co", customerPhone: "+201011111111",
      customerId: me.id, lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
    });
    // 100 gross - 10% = 90, then +14% VAT = 102.60.
    expect(res.total).toBeCloseTo(102.6, 1);
  });

  it("a non-trade-approved customer pays full price", async () => {
    const { tenantId, branchId, productId } = await seed("trade-2");
    const me = await registerCustomer(tenantId, { name: "Regular", email: "r@x.com", password: "secret123" });

    const res = await placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "Regular", customerPhone: "+201122222222",
      customerId: me.id, lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
    });
    expect(res.total).toBeCloseTo(114, 1); // 100 + 14% VAT, no discount
  });

  it("trade approval on a NON-timber tenant grants no discount (capability-gated)", async () => {
    const { tenantId, branchId, productId } = await seed("trade-3", "restaurant");
    const me = await registerCustomer(tenantId, { name: "R", email: "r2@x.com", password: "secret123" });
    await tradeApprove(tenantId, me.id, 10);

    const res = await placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "R", customerPhone: "+201233333333",
      customerId: me.id, lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
    });
    expect(res.total).toBeCloseTo(114, 1); // capability off -> full price despite approval
  });

  it("a guest (no customerId) never gets a trade discount", async () => {
    const { tenantId, branchId, productId } = await seed("trade-4");
    const res = await placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "Guest", customerPhone: "+201544444444",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
    });
    expect(res.total).toBeCloseTo(114, 1);
  });
});
