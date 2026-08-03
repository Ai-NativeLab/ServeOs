import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { createBranch, updateBranchOrdering } from "@/server/branches/service";
import { createCategory, createProduct, updateProduct } from "@/server/catalog/service";
import { placeOrder } from "@/server/ordering/service";
import { orders } from "@/server/ordering/schema";
import { registerCustomer, listCustomerOrders } from "./service";

async function seed(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG", vertical: "restaurant" }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro");
  const branch = await createBranch(t.id, { name: "Main" });
  await updateBranchOrdering(t.id, branch.id, { acceptingOrders: true });
  const cat = await createCategory(t.id, { nameEn: "P", nameAr: "ب" });
  const prod = await createProduct(t.id, { nameEn: "Pie", nameAr: "فطيرة", basePrice: "100", categoryId: cat.id });
  await updateProduct(t.id, prod.id, { isPublished: true });
  return { tenantId: t.id, branchId: branch.id, productId: prod.id };
}

describe("checkout attach", () => {
  it("stamps customerId on a signed-in order and lists it in the customer's history", async () => {
    const { tenantId, branchId, productId } = await seed("att-1");
    const me = await registerCustomer(tenantId, { name: "Ahmed", email: "a@x.com", password: "secret123" });

    const res = await placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "Ahmed", customerPhone: "+2011",
      customerId: me.id, lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
    });
    const [row] = await withTenant(tenantId, (tx) => tx.select().from(orders).where(eq(orders.id, res.orderId)));
    expect(row.customerId).toBe(me.id);

    const history = await listCustomerOrders(tenantId, me.id);
    expect(history.map((o) => o.id)).toEqual([res.orderId]);
  });

  it("a guest order keeps customerId null forever", async () => {
    const { tenantId, branchId, productId } = await seed("att-2");
    const res = await placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "Guest", customerPhone: "+2012",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
    });
    const [row] = await withTenant(tenantId, (tx) => tx.select().from(orders).where(eq(orders.id, res.orderId)));
    expect(row.customerId).toBeNull();
  });
});
