import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { createBranch } from "@/server/branches/service";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import type { VerticalId } from "@/server/verticals/types";
import { inventoryItems, productInventoryLinks, recipes, recipeComponents } from "./schema";
import { receiveStock, getOrCreateDefaultLocation } from "./service";
import type { Uom } from "./uom";

let n = 0;

/** A tenant + branch, the minimum an inventory movement needs. */
export async function seedInventoryTenant(vertical: VerticalId = "restaurant"): Promise<{ tenantId: string; branchId: string }> {
  const i = n++;
  const [t] = await db.insert(tenants).values({
    slug: `inv-${vertical}-${Date.now()}-${i}`, name: "Inv T", country: "EG", vertical,
  }).returning();
  // createBranch enforces a plan quota, so a tenant needs an entitlement before
  // it can own a branch — same order seedPosContext uses.
  await seedDefaultPlans();
  await startTrial(t.id, "pro");
  const branch = await createBranch(t.id, { name: "Main" });
  return { tenantId: t.id, branchId: branch.id };
}

export async function seedItem(tenantId: string, opts: {
  nameEn?: string; baseUom?: Uom; stockUom?: Uom; purchaseUom?: Uom; recipeUom?: Uom;
  kind?: "ingredient" | "finished_good" | "raw_material"; isPerishable?: boolean;
} = {}): Promise<string> {
  const base = opts.baseUom ?? "each";
  const [item] = await withTenant(tenantId, (tx) => tx.insert(inventoryItems).values({
    tenantId,
    nameEn: opts.nameEn ?? "Item", nameAr: "عنصر",
    kind: opts.kind ?? "ingredient",
    baseUom: base,
    stockUom: opts.stockUom ?? base,
    purchaseUom: opts.purchaseUom ?? base,
    recipeUom: opts.recipeUom ?? base,
    isPerishable: opts.isPerishable ?? false,
  }).returning({ id: inventoryItems.id }));
  return item.id;
}

export async function seedLocation(
  tenantId: string, branchId: string, kind: "kitchen" | "retail" | "back_of_house" | "transit" = "kitchen",
): Promise<string> {
  const loc = await withTenant(tenantId, (tx) => getOrCreateDefaultLocation(tx, tenantId, branchId, kind));
  return loc.id;
}

/** Puts `baseQty` of an item on a location's shelf as one lot. */
export async function stockLot(tenantId: string, args: {
  itemId: string; locationId: string; baseQty: number; uom: Uom;
  unitCost?: string; receivedAt?: Date; expiryAt?: Date | null;
}): Promise<string> {
  const { lotId } = await withTenant(tenantId, (tx) => receiveStock(tx, {
    tenantId, itemId: args.itemId, locationId: args.locationId, baseQty: args.baseQty,
    uom: args.uom, unitCost: args.unitCost ?? "1", receivedAt: args.receivedAt, expiryAt: args.expiryAt ?? null,
  }));
  return lotId;
}

/**
 * Links a sellable product to finished-goods stock and puts `onHand` on the
 * branch's retail shelf — the retail shape that replaces seeding the flat
 * `stockQuantity` integer in the order tests.
 */
export async function seedFinishedGood(tenantId: string, args: {
  branchId: string; productId: string; variantId?: string | null; onHand: number; unitCost?: string;
}): Promise<{ itemId: string; locationId: string; lotId: string }> {
  const itemId = await seedItem(tenantId, { nameEn: "Cola Can", kind: "finished_good", baseUom: "each" });
  const locationId = await seedLocation(tenantId, args.branchId, "retail");
  const lotId = await stockLot(tenantId, {
    itemId, locationId, baseQty: args.onHand, uom: "each", unitCost: args.unitCost ?? "5",
  });
  await withTenant(tenantId, (tx) => tx.insert(productInventoryLinks).values({
    tenantId, productId: args.productId, variantId: args.variantId ?? null,
    linkType: "finished_good", itemId,
  }));
  return { itemId, locationId, lotId };
}

/**
 * Links a sellable product to a recipe and stocks each ingredient in the
 * branch kitchen — the restaurant shape the flat counter could never express.
 */
export async function seedRecipeProduct(tenantId: string, args: {
  branchId: string; productId: string; variantId?: string | null; yieldQty?: string;
  components: { nameEn?: string; qty: string; uom: Uom; baseUom?: Uom; wastePct?: string; onHand: number }[];
}): Promise<{ recipeId: string; locationId: string; itemIds: string[] }> {
  const locationId = await seedLocation(tenantId, args.branchId, "kitchen");
  const [recipe] = await withTenant(tenantId, (tx) => tx.insert(recipes).values({
    tenantId, nameEn: "Recipe", nameAr: "وصفة", yieldQty: args.yieldQty ?? "1",
  }).returning({ id: recipes.id }));

  const itemIds: string[] = [];
  for (const c of args.components) {
    const baseUom = c.baseUom ?? c.uom;
    const itemId = await seedItem(tenantId, { nameEn: c.nameEn ?? "Ingredient", baseUom });
    itemIds.push(itemId);
    if (c.onHand > 0) {
      await stockLot(tenantId, { itemId, locationId, baseQty: c.onHand, uom: baseUom });
    }
    await withTenant(tenantId, (tx) => tx.insert(recipeComponents).values({
      tenantId, recipeId: recipe.id, itemId, qty: c.qty, uom: c.uom, wastePct: c.wastePct ?? "0",
    }));
  }

  await withTenant(tenantId, (tx) => tx.insert(productInventoryLinks).values({
    tenantId, productId: args.productId, variantId: args.variantId ?? null,
    linkType: "recipe", recipeId: recipe.id,
  }));
  return { recipeId: recipe.id, locationId, itemIds };
}
