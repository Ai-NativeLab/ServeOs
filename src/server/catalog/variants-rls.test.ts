import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { categories, products, productVariants } from "./schema";

async function tenantWithProduct(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG", vertical: "retail" }).returning();
  const cat = await withTenant(t.id, async (tx) => {
    const [c] = await tx.insert(categories).values({ tenantId: t.id, nameEn: "Cat", nameAr: "فئة" }).returning();
    return c;
  });
  const prod = await withTenant(t.id, async (tx) => {
    const [p] = await tx.insert(products).values({ tenantId: t.id, categoryId: cat.id, nameEn: "P", nameAr: "منتج", basePrice: "10" }).returning();
    return p;
  });
  return { t, prod };
}

describe("product_variants RLS", () => {
  it("isolates variants per tenant and fails closed outside withTenant", async () => {
    const a = await tenantWithProduct("vrls-a");
    const b = await tenantWithProduct("vrls-b");
    await withTenant(a.t.id, (tx) =>
      tx.insert(productVariants).values({ tenantId: a.t.id, productId: a.prod.id, nameEn: "500g", nameAr: "٥٠٠ جم", price: "25", stockQuantity: 5 }),
    );
    const mine = await withTenant(a.t.id, (tx) => tx.select().from(productVariants));
    const theirs = await withTenant(b.t.id, (tx) => tx.select().from(productVariants));
    const bare = await db.select().from(productVariants);
    expect(mine.length).toBe(1);
    expect(theirs.length).toBe(0);
    expect(bare.length).toBe(0); // FORCE RLS fails closed without app.tenant_id
  });
});
