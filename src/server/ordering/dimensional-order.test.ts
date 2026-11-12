import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { createBranch, updateBranchOrdering } from "@/server/branches/service";
import { createCategory, createProduct, updateProduct } from "@/server/catalog/service";
import { products } from "@/server/catalog/schema";
import { placeOrder } from "./service";
import { orderItems } from "./schema";
import { OrderValidationError } from "./errors";

async function seed(slug: string, opts: { unitOfMeasure?: "m" | "m2" | "bf" } = {}) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG", vertical: "timber" }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro");
  const branch = await createBranch(t.id, { name: "Yard" });
  await updateBranchOrdering(t.id, branch.id, { acceptingOrders: true });
  const cat = await createCategory(t.id, { nameEn: "Ply", nameAr: "أبلكاش" });
  // basePrice here means EGP per m² (decision T2) — 50.00/m2.
  const prod = await createProduct(t.id, {
    nameEn: "18mm Ply Sheet", nameAr: "أبلكاش 18مم", basePrice: "50.00", categoryId: cat.id,
  });
  if (opts.unitOfMeasure) {
    await withTenant(t.id, (tx) =>
      tx.update(products).set({ unitOfMeasure: opts.unitOfMeasure }).where(eq(products.id, prod.id)));
  }
  await updateProduct(t.id, prod.id, { isPublished: true });
  return { tenantId: t.id, branchId: branch.id, productId: prod.id };
}

describe("dimensional cut-list ordering", () => {
  it("prices a dimensional line from its dimensions, feeding the unchanged totals pipeline", async () => {
    const { tenantId, branchId, productId } = await seed("dim-1", { unitOfMeasure: "m2" });
    // 2.4m x 0.6m = 1.44 m2 x 50.00 = 72.00 per sheet, 2 sheets = 144.00 pre-tax.
    const res = await placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "Y", customerPhone: "01012345678",
      lines: [{
        productId, quantity: 2, selectedOptionIds: [],
        dimensions: { lengthMm: 2400, widthMm: 600 },
      }],
    });

    const [item] = await withTenant(tenantId, (tx) => tx.select().from(orderItems).where(eq(orderItems.orderId, res.orderId)));
    expect(Number(item.unitBasePrice)).toBeCloseTo(72, 2);
    expect(item.dimensions).toEqual({ lengthMm: 2400, widthMm: 600 });
    expect(res.total).toBeGreaterThan(144); // 144 + VAT
  });

  it("rejects a dimensional product ordered without dimensions", async () => {
    const { tenantId, branchId, productId } = await seed("dim-2", { unitOfMeasure: "m" });
    await expect(placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "Y", customerPhone: "01012345678",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(OrderValidationError);
  });

  it("rejects dimensions supplied on a NON-dimensional product rather than silently ignoring them", async () => {
    const { tenantId, branchId, productId } = await seed("dim-3"); // no unitOfMeasure
    await expect(placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "Y", customerPhone: "01012345678",
      lines: [{ productId, quantity: 1, selectedOptionIds: [], dimensions: { lengthMm: 1000 } }],
    })).rejects.toThrow(OrderValidationError);
  });

  it("a normal fixed-price order is provably unaffected (regression)", async () => {
    const { tenantId, branchId, productId } = await seed("dim-4"); // no unitOfMeasure
    const res = await placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "Y", customerPhone: "01012345678",
      lines: [{ productId, quantity: 3, selectedOptionIds: [] }],
    });
    const [item] = await withTenant(tenantId, (tx) => tx.select().from(orderItems).where(eq(orderItems.orderId, res.orderId)));
    expect(Number(item.unitBasePrice)).toBeCloseTo(50, 2); // plain basePrice, unchanged
    expect(item.dimensions).toBeNull();
  });
});
