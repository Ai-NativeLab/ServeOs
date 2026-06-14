import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import {
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  upsertModifierGroup,
  upsertModifierOption,
  deleteModifierGroup,
  setBranchAvailability,
  getPublishedMenu,
} from "./service";
import { CategoryNotEmptyError, ProductNotFoundError, InvalidModifierRulesError } from "./errors";
import { createBranch } from "@/server/branches/service";

async function makeTenant(slug = "c1") {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG" }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "basic");
  return t;
}

describe("catalog: categories", () => {
  it("creates and lists categories", async () => {
    const t = await makeTenant();
    const cat = await createCategory(t.id, { nameEn: "Burgers", nameAr: "برجر" });
    expect(cat.nameEn).toBe("Burgers");
    const list = await listCategories(t.id);
    expect(list).toHaveLength(1);
  });

  it("updateCategory changes name", async () => {
    const t = await makeTenant("c2");
    const cat = await createCategory(t.id, { nameEn: "A", nameAr: "أ" });
    const updated = await updateCategory(t.id, cat.id, { nameEn: "B" });
    expect(updated.nameEn).toBe("B");
    expect(updated.nameAr).toBe("أ");
  });

  it("deleteCategory throws CategoryNotEmptyError when products exist", async () => {
    const t = await makeTenant("c3");
    const cat = await createCategory(t.id, { nameEn: "X", nameAr: "س" });
    // insert a product directly to simulate non-empty (must use withTenant — RLS enforced on app role)
    const { products } = await import("./schema");
    await withTenant(t.id, (tx) =>
      tx.insert(products).values({
        tenantId: t.id,
        categoryId: cat.id,
        nameEn: "P",
        nameAr: "ب",
        basePrice: "10",
      }),
    );
    await expect(deleteCategory(t.id, cat.id)).rejects.toThrow(CategoryNotEmptyError);
  });

  it("deleteCategory succeeds for empty category", async () => {
    const t = await makeTenant("c4");
    const cat = await createCategory(t.id, { nameEn: "Empty", nameAr: "فارغ" });
    await deleteCategory(t.id, cat.id);
    const list = await listCategories(t.id);
    expect(list).toHaveLength(0);
  });

  it("RLS: tenant A cannot see tenant B categories", async () => {
    const a = await makeTenant("rls-cat-a");
    const b = await makeTenant("rls-cat-b");
    await createCategory(a.id, { nameEn: "A-Cat", nameAr: "أ" });
    expect(await listCategories(b.id)).toHaveLength(0);
  });
});

describe("catalog: products", () => {
  it("creates and lists products", async () => {
    const t = await makeTenant("p1");
    const cat = await createCategory(t.id, { nameEn: "C", nameAr: "ج" });
    const prod = await createProduct(t.id, { nameEn: "Burger", nameAr: "برجر", basePrice: "25.00", categoryId: cat.id });
    expect(prod.nameEn).toBe("Burger");
    const list = await listProducts(t.id);
    expect(list).toHaveLength(1);
    const byCat = await listProducts(t.id, cat.id);
    expect(byCat).toHaveLength(1);
  });

  it("getProduct throws ProductNotFoundError for unknown id", async () => {
    const t = await makeTenant("p2");
    await expect(getProduct(t.id, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(ProductNotFoundError);
  });

  it("deleteProduct removes a product", async () => {
    const t = await makeTenant("p3");
    const cat = await createCategory(t.id, { nameEn: "C", nameAr: "ج" });
    const prod = await createProduct(t.id, { nameEn: "X", nameAr: "س", basePrice: "10", categoryId: cat.id });
    await deleteProduct(t.id, prod.id);
    expect(await listProducts(t.id)).toHaveLength(0);
  });
});

describe("catalog: modifier groups and options", () => {
  it("inserts group with options and retrieves via getProduct", async () => {
    const t = await makeTenant("mod1");
    const cat = await createCategory(t.id, { nameEn: "C", nameAr: "ج" });
    const prod = await createProduct(t.id, { nameEn: "Pizza", nameAr: "بيتزا", basePrice: "50", categoryId: cat.id });
    const group = await upsertModifierGroup(t.id, prod.id, { nameEn: "Size", nameAr: "الحجم", required: true, minSelections: 1, maxSelections: 1 });
    await upsertModifierOption(t.id, group.id, { nameEn: "Small", nameAr: "صغير", priceDelta: "0" });
    await upsertModifierOption(t.id, group.id, { nameEn: "Large", nameAr: "كبير", priceDelta: "10" });
    const full = await getProduct(t.id, prod.id);
    expect(full.modifierGroups).toHaveLength(1);
    expect(full.modifierGroups[0].options).toHaveLength(2);
  });

  it("upsertModifierGroup throws InvalidModifierRulesError when min > max", async () => {
    const t = await makeTenant("mod2");
    const cat = await createCategory(t.id, { nameEn: "C", nameAr: "ج" });
    const prod = await createProduct(t.id, { nameEn: "X", nameAr: "س", basePrice: "5", categoryId: cat.id });
    await expect(upsertModifierGroup(t.id, prod.id, { nameEn: "G", nameAr: "ج", required: false, minSelections: 3, maxSelections: 1 })).rejects.toThrow(InvalidModifierRulesError);
  });

  it("upsertModifierGroup throws when required=true and min=0", async () => {
    const t = await makeTenant("mod3");
    const cat = await createCategory(t.id, { nameEn: "C", nameAr: "ج" });
    const prod = await createProduct(t.id, { nameEn: "X", nameAr: "س", basePrice: "5", categoryId: cat.id });
    await expect(upsertModifierGroup(t.id, prod.id, { nameEn: "G", nameAr: "ج", required: true, minSelections: 0, maxSelections: 1 })).rejects.toThrow(InvalidModifierRulesError);
  });

  it("deleteModifierGroup cascades options", async () => {
    const t = await makeTenant("mod4");
    const cat = await createCategory(t.id, { nameEn: "C", nameAr: "ج" });
    const prod = await createProduct(t.id, { nameEn: "X", nameAr: "س", basePrice: "5", categoryId: cat.id });
    const group = await upsertModifierGroup(t.id, prod.id, { nameEn: "G", nameAr: "ج", required: false, minSelections: 0, maxSelections: 1 });
    await upsertModifierOption(t.id, group.id, { nameEn: "Opt", nameAr: "خيار" });
    await deleteModifierGroup(t.id, group.id);
    const full = await getProduct(t.id, prod.id);
    expect(full.modifierGroups).toHaveLength(0);
  });

  it("upsertModifierGroup cannot update a group belonging to a different product", async () => {
    const t = await makeTenant("cross-mod");
    const cat = await createCategory(t.id, { nameEn: "C", nameAr: "ج" });
    const prodA = await createProduct(t.id, { nameEn: "A", nameAr: "أ", basePrice: "5", categoryId: cat.id });
    const prodB = await createProduct(t.id, { nameEn: "B", nameAr: "ب", basePrice: "5", categoryId: cat.id });
    // Group belongs to prodB
    const group = await upsertModifierGroup(t.id, prodB.id, {
      nameEn: "G", nameAr: "ج", required: false, minSelections: 0, maxSelections: 1,
    });
    // Attempt to update it via prodA's context — must throw
    await expect(
      upsertModifierGroup(t.id, prodA.id, {
        id: group.id, nameEn: "Hacked", nameAr: "ج", required: false, minSelections: 0, maxSelections: 1,
      }),
    ).rejects.toThrow("Modifier group not found");
  });
});

describe("catalog: branch availability and getPublishedMenu", () => {
  it("getPublishedMenu returns only published products in active categories", async () => {
    const t = await makeTenant("menu1");
    const cat = await createCategory(t.id, { nameEn: "Food", nameAr: "طعام" });
    const pub = await createProduct(t.id, { nameEn: "Pub", nameAr: "منشور", basePrice: "10", categoryId: cat.id });
    await updateProduct(t.id, pub.id, { isPublished: true });
    await createProduct(t.id, { nameEn: "Draft", nameAr: "مسودة", basePrice: "5", categoryId: cat.id });
    const menu = await getPublishedMenu(t.id);
    expect(menu.categories).toHaveLength(1);
    expect(menu.categories[0].products).toHaveLength(1);
    expect(menu.categories[0].products[0].nameEn).toBe("Pub");
  });

  it("getPublishedMenu excludes products unavailable at a branch", async () => {
    const t = await makeTenant("menu2");
    const branch = await createBranch(t.id, { name: "Branch A" });
    const cat = await createCategory(t.id, { nameEn: "Food", nameAr: "طعام" });
    const p1 = await createProduct(t.id, { nameEn: "P1", nameAr: "ب1", basePrice: "10", categoryId: cat.id });
    const p2 = await createProduct(t.id, { nameEn: "P2", nameAr: "ب2", basePrice: "20", categoryId: cat.id });
    await updateProduct(t.id, p1.id, { isPublished: true });
    await updateProduct(t.id, p2.id, { isPublished: true });
    await setBranchAvailability(t.id, branch.id, p2.id, false);
    const menu = await getPublishedMenu(t.id, branch.id);
    expect(menu.categories[0].products.map((p) => p.nameEn)).toEqual(["P1"]);
  });

  it("getPublishedMenu without branchId ignores branch availability", async () => {
    const t = await makeTenant("menu3");
    const branch = await createBranch(t.id, { name: "B" });
    const cat = await createCategory(t.id, { nameEn: "Food", nameAr: "طعام" });
    const p = await createProduct(t.id, { nameEn: "P", nameAr: "ب", basePrice: "10", categoryId: cat.id });
    await updateProduct(t.id, p.id, { isPublished: true });
    await setBranchAvailability(t.id, branch.id, p.id, false);
    const menu = await getPublishedMenu(t.id); // no branch
    expect(menu.categories[0].products).toHaveLength(1);
  });

  it("getPublishedMenu applies price_override as effectivePrice", async () => {
    const t = await makeTenant("menu4");
    const branch = await createBranch(t.id, { name: "B" });
    const cat = await createCategory(t.id, { nameEn: "Food", nameAr: "طعام" });
    const p = await createProduct(t.id, { nameEn: "P", nameAr: "ب", basePrice: "10", categoryId: cat.id });
    await updateProduct(t.id, p.id, { isPublished: true });
    await setBranchAvailability(t.id, branch.id, p.id, true, 15);
    const menu = await getPublishedMenu(t.id, branch.id);
    expect(menu.categories[0].products[0].effectivePrice).toBe(15);
  });

  it("setBranchAvailability deletes row when restoring default", async () => {
    const t = await makeTenant("menu5");
    const branch = await createBranch(t.id, { name: "B" });
    const cat = await createCategory(t.id, { nameEn: "Food", nameAr: "طعام" });
    const p = await createProduct(t.id, { nameEn: "P", nameAr: "ب", basePrice: "10", categoryId: cat.id });
    await updateProduct(t.id, p.id, { isPublished: true });
    await setBranchAvailability(t.id, branch.id, p.id, false);
    await setBranchAvailability(t.id, branch.id, p.id, true); // restore
    const menu = await getPublishedMenu(t.id, branch.id);
    expect(menu.categories[0].products).toHaveLength(1);
  });
});
