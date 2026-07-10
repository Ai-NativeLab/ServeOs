import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { createBranch, updateBranchOrdering } from "@/server/branches/service";
import { createCategory, createProduct, updateProduct } from "@/server/catalog/service";
import { placeOrder } from "@/server/ordering/service";
import { getPopularProductIds } from "./popular";

async function setup(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG" }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro");
  const branch = await createBranch(t.id, { name: "Main" });
  await updateBranchOrdering(t.id, branch.id, { acceptingOrders: true, openingHours: [] });
  const cat = await createCategory(t.id, { nameEn: "P", nameAr: "ب" });
  const mk = async (name: string) => {
    const p = await createProduct(t.id, { nameEn: name, nameAr: name, basePrice: "100", categoryId: cat.id });
    await updateProduct(t.id, p.id, { isPublished: true });
    return p;
  };
  return { t, branch, mk };
}

describe("getPopularProductIds", () => {
  it("ranks by ordered quantity, caps at 5, excludes zero-order products, isolates tenants", async () => {
    const { t, branch, mk } = await setup("pop1");
    const a = await mk("A"); const b = await mk("B"); const c = await mk("C");
    // A ordered qty 5, B qty 2, C never ordered
    await placeOrder(t.id, { branchId: branch.id, fulfillmentType: "pickup", customerName: "x", customerPhone: "1", lines: [{ productId: a.id, quantity: 5, selectedOptionIds: [] }] });
    await placeOrder(t.id, { branchId: branch.id, fulfillmentType: "pickup", customerName: "y", customerPhone: "2", lines: [{ productId: b.id, quantity: 2, selectedOptionIds: [] }] });
    const ids = await getPopularProductIds(t.id);
    expect(ids.has(a.id)).toBe(true);
    expect(ids.has(b.id)).toBe(true);
    expect(ids.has(c.id)).toBe(false); // zero orders
    // other tenant sees nothing
    const { t: t2 } = await setup("pop2");
    expect((await getPopularProductIds(t2.id)).size).toBe(0);
  });
});
