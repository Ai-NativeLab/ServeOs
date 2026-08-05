import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { CapabilityNotEnabledError } from "@/server/verticals/errors";
import {
  createRecipe, updateRecipe, setRecipeComponents, getRecipe, listRecipes,
  linkProduct, unlinkProduct, listProductLinks,
} from "./recipes";
import { deductForOrderLine, onHand } from "./service";
import { productInventoryLinks } from "./schema";
import { InventoryConfigError, DimensionalUomError } from "./errors";
import { seedInventoryTenant, seedItem, seedLocation, stockLot } from "./test-helpers";

async function seedProduct(tenantId: string, nameEn = "Margherita"): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const cat = await tx.execute<{ id: string }>(sql`
      INSERT INTO categories (tenant_id, name_en, name_ar) VALUES (${tenantId}, 'C', 'ج') RETURNING id`);
    const prod = await tx.execute<{ id: string }>(sql`
      INSERT INTO products (tenant_id, category_id, name_en, name_ar, base_price)
      VALUES (${tenantId}, ${cat.rows[0].id}, ${nameEn}, 'ب', '120.00') RETURNING id`);
    return prod.rows[0].id;
  });
}

describe("recipe authoring", () => {
  it("creates a recipe with components and reads it back", async () => {
    const { tenantId } = await seedInventoryTenant();
    const dough = await seedItem(tenantId, { nameEn: "Dough", baseUom: "g" });
    const cheese = await seedItem(tenantId, { nameEn: "Cheese", baseUom: "g" });

    const recipe = await createRecipe(tenantId, {
      nameEn: "Margherita", nameAr: "مارجريتا", yieldQty: "2",
      components: [
        { itemId: dough, qty: "200", uom: "g" },
        { itemId: cheese, qty: "0.1", uom: "kg", wastePct: "10" },
      ],
    });

    expect(recipe.components).toHaveLength(2);
    const fetched = await getRecipe(tenantId, recipe.id);
    expect(fetched?.yieldQty).toBe("2");
    expect(fetched?.components).toHaveLength(2);
    expect((await listRecipes(tenantId)).map((r) => r.nameEn)).toEqual(["Margherita"]);
  });

  it("rejects a component whose unit cannot reach the item's base unit", async () => {
    const { tenantId } = await seedInventoryTenant();
    const cheese = await seedItem(tenantId, { nameEn: "Cheese", baseUom: "g" });
    // 200 ml of a mass-based ingredient — density is not modelled, so this is
    // caught at authoring time rather than surfacing as a refused sale.
    await expect(createRecipe(tenantId, {
      nameEn: "R", nameAr: "ر", components: [{ itemId: cheese, qty: "200", uom: "ml" }],
    })).rejects.toThrow(DimensionalUomError);
  });

  it("rejects a sellable dimensional unit and non-positive quantities", async () => {
    const { tenantId } = await seedInventoryTenant();
    const dough = await seedItem(tenantId, { nameEn: "Dough", baseUom: "g" });

    await expect(createRecipe(tenantId, {
      nameEn: "R", nameAr: "ر", components: [{ itemId: dough, qty: "1", uom: "m2" }],
    })).rejects.toThrow(DimensionalUomError);

    await expect(createRecipe(tenantId, {
      nameEn: "R", nameAr: "ر", components: [{ itemId: dough, qty: "0", uom: "g" }],
    })).rejects.toThrow(InventoryConfigError);

    await expect(createRecipe(tenantId, { nameEn: "R", nameAr: "ر", yieldQty: "0" }))
      .rejects.toThrow(InventoryConfigError);
  });

  it("is restaurant-only — a retail tenant cannot author a recipe", async () => {
    const { tenantId } = await seedInventoryTenant("retail");
    await expect(createRecipe(tenantId, { nameEn: "R", nameAr: "ر" }))
      .rejects.toThrow(CapabilityNotEnabledError);
  });

  it("setRecipeComponents replaces the list wholesale rather than appending", async () => {
    const { tenantId } = await seedInventoryTenant();
    const a = await seedItem(tenantId, { nameEn: "A", baseUom: "g" });
    const b = await seedItem(tenantId, { nameEn: "B", baseUom: "g" });
    const recipe = await createRecipe(tenantId, {
      nameEn: "R", nameAr: "ر", components: [{ itemId: a, qty: "100", uom: "g" }],
    });

    await setRecipeComponents(tenantId, recipe.id, [{ itemId: b, qty: "50", uom: "g" }]);

    const fetched = await getRecipe(tenantId, recipe.id);
    expect(fetched?.components).toHaveLength(1);
    expect(fetched?.components[0].itemId).toBe(b);
  });

  it("updateRecipe edits the header and refuses an empty patch", async () => {
    const { tenantId } = await seedInventoryTenant();
    const recipe = await createRecipe(tenantId, { nameEn: "R", nameAr: "ر" });

    const updated = await updateRecipe(tenantId, recipe.id, { nameEn: "Renamed", yieldQty: "4" });
    expect(updated.nameEn).toBe("Renamed");
    expect(updated.yieldQty).toBe("4");

    await expect(updateRecipe(tenantId, recipe.id, {})).rejects.toThrow(InventoryConfigError);
  });

  it("linking a product replaces any previous link so a sellable resolves to one thing", async () => {
    const { tenantId } = await seedInventoryTenant();
    const productId = await seedProduct(tenantId);
    const item = await seedItem(tenantId, { nameEn: "Can", kind: "finished_good", baseUom: "each" });
    const recipe = await createRecipe(tenantId, { nameEn: "R", nameAr: "ر" });

    await linkProduct(tenantId, { productId, linkType: "finished_good", itemId: item });
    await linkProduct(tenantId, { productId, linkType: "recipe", recipeId: recipe.id });

    const links = await withTenant(tenantId, (tx) =>
      tx.select().from(productInventoryLinks).where(eq(productInventoryLinks.productId, productId)));
    expect(links).toHaveLength(1);
    expect(links[0].linkType).toBe("recipe");
    expect(links[0].recipeId).toBe(recipe.id);
    expect(links[0].itemId).toBeNull(); // the XOR holds
  });

  it("rejects a link to a recipe, item, product or variant that does not exist", async () => {
    const { tenantId } = await seedInventoryTenant();
    const productId = await seedProduct(tenantId);
    const missing = "00000000-0000-0000-0000-0000000000ff";

    await expect(linkProduct(tenantId, { productId, linkType: "recipe", recipeId: missing }))
      .rejects.toThrow(InventoryConfigError);
    await expect(linkProduct(tenantId, { productId, linkType: "finished_good", itemId: missing }))
      .rejects.toThrow(InventoryConfigError);
    await expect(linkProduct(tenantId, { productId: missing, linkType: "finished_good", itemId: missing }))
      .rejects.toThrow(InventoryConfigError);
  });

  it("unlinking makes the product sell without deducting again", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const productId = await seedProduct(tenantId);
    const kitchen = await seedLocation(tenantId, branchId, "kitchen");
    const dough = await seedItem(tenantId, { nameEn: "Dough", baseUom: "g" });
    await stockLot(tenantId, { itemId: dough, locationId: kitchen, baseQty: 1000, uom: "g" });

    const recipe = await createRecipe(tenantId, {
      nameEn: "R", nameAr: "ر", components: [{ itemId: dough, qty: "200", uom: "g" }],
    });
    await linkProduct(tenantId, { productId, linkType: "recipe", recipeId: recipe.id });

    const deduct = (orderItemId: string) => withTenant(tenantId, (tx) => deductForOrderLine(tx, {
      tenantId, branchId, productId, variantId: null, quantity: 1, orderItemId,
      allowNegative: true, byUserId: null, productNameEn: "P", productNameAr: "ب",
    }));

    await deduct("00000000-0000-0000-0000-00000000ab01");
    expect(await onHand(tenantId, dough, kitchen)).toBe(800);

    await unlinkProduct(tenantId, productId, null);
    expect(await listProductLinks(tenantId)).toHaveLength(0);

    await deduct("00000000-0000-0000-0000-00000000ab02");
    expect(await onHand(tenantId, dough, kitchen)).toBe(800); // untouched
    await expect(unlinkProduct(tenantId, productId, null)).rejects.toThrow(InventoryConfigError);
  });

  it("an authored recipe actually drives deduction end to end", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const productId = await seedProduct(tenantId);
    const kitchen = await seedLocation(tenantId, branchId, "kitchen");
    const dough = await seedItem(tenantId, { nameEn: "Dough", baseUom: "g" });
    const cheese = await seedItem(tenantId, { nameEn: "Cheese", baseUom: "g" });
    await stockLot(tenantId, { itemId: dough, locationId: kitchen, baseQty: 1000, uom: "g" });
    await stockLot(tenantId, { itemId: cheese, locationId: kitchen, baseQty: 1000, uom: "g" });

    // Authored entirely through the public API — no direct table writes.
    const recipe = await createRecipe(tenantId, {
      nameEn: "Margherita", nameAr: "مارجريتا", yieldQty: "2",
      components: [
        { itemId: dough, qty: "200", uom: "g" },
        { itemId: cheese, qty: "0.1", uom: "kg", wastePct: "10" }, // 100 g + 10% = 110 g per batch
      ],
    });
    await linkProduct(tenantId, { productId, linkType: "recipe", recipeId: recipe.id });

    await withTenant(tenantId, (tx) => deductForOrderLine(tx, {
      tenantId, branchId, productId, variantId: null, quantity: 3,
      orderItemId: "00000000-0000-0000-0000-00000000ac01",
      allowNegative: true, byUserId: null, productNameEn: "P", productNameAr: "ب",
    }));

    // Sell 3 from a 2-yield batch: dough 200 * 3/2 = 300; cheese 110 * 3/2 = 165.
    expect(await onHand(tenantId, dough, kitchen)).toBe(700);
    expect(await onHand(tenantId, cheese, kitchen)).toBe(835);
  });

  it("hides another tenant's recipes and links (RLS)", async () => {
    const a = await seedInventoryTenant();
    const b = await seedInventoryTenant();
    const item = await seedItem(a.tenantId, { nameEn: "X", baseUom: "g" });
    const recipe = await createRecipe(a.tenantId, {
      nameEn: "Secret", nameAr: "س", components: [{ itemId: item, qty: "1", uom: "g" }],
    });

    expect(await listRecipes(b.tenantId)).toHaveLength(0);
    expect(await getRecipe(b.tenantId, recipe.id)).toBeNull();
    expect(await listProductLinks(b.tenantId)).toHaveLength(0);
  });
});
