import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { createCategory, createProduct, upsertModifierGroup } from "./service";
import { listVariants, upsertVariant, deleteVariant, setVariantStock } from "./variants";
import { CapabilityNotEnabledError } from "@/server/verticals";

async function setup(slug: string, vertical: "restaurant" | "retail") {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG", vertical }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro");
  const cat = await createCategory(t.id, { nameEn: "Cat", nameAr: "فئة" });
  const prod = await createProduct(t.id, { nameEn: "Hinge", nameAr: "مفصلة", basePrice: "50", categoryId: cat.id });
  return { t, prod };
}

describe("variants service", () => {
  it("creates, updates, lists, deletes variants for a retail tenant", async () => {
    const { t, prod } = await setup("var1", "retail");
    const v = await upsertVariant(t.id, prod.id, { nameEn: "35mm", nameAr: "٣٥مم", price: "55", stockQuantity: 10 });
    expect(v.nameEn).toBe("35mm");
    const updated = await upsertVariant(t.id, prod.id, { id: v.id, nameEn: "35mm Soft-Close", nameAr: "٣٥مم", price: "65", stockQuantity: 10 });
    expect(updated.price).toBe("65");
    await setVariantStock(t.id, v.id, 3);
    const list = await listVariants(t.id, prod.id);
    expect(list.length).toBe(1);
    expect(list[0].stockQuantity).toBe(3);
    await deleteVariant(t.id, v.id);
    expect((await listVariants(t.id, prod.id)).length).toBe(0);
  });

  it("rejects variants for a restaurant tenant (capability gate)", async () => {
    const { t, prod } = await setup("var2", "restaurant");
    await expect(upsertVariant(t.id, prod.id, { nameEn: "X", nameAr: "س", price: "10" }))
      .rejects.toThrow(CapabilityNotEnabledError);
  });

  it("rejects deleteVariant for a restaurant tenant (capability gate)", async () => {
    const { t } = await setup("var-del", "restaurant");
    await expect(deleteVariant(t.id, "00000000-0000-0000-0000-000000000000"))
      .rejects.toThrow(CapabilityNotEnabledError);
  });

  it("rejects modifier groups for a retail tenant (capability gate)", async () => {
    const { t, prod } = await setup("var3", "retail");
    await expect(upsertModifierGroup(t.id, prod.id, { nameEn: "Extras", nameAr: "إضافات", required: false, minSelections: 0, maxSelections: 1 }))
      .rejects.toThrow(CapabilityNotEnabledError);
  });
});
