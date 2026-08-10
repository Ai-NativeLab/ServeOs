import { and, asc, eq, isNull } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { getTenantById } from "@/server/tenancy";
import { requireCapability, type VerticalId } from "@/server/verticals";
import { recordAuditEvent, type AuditActorInput } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { products, productVariants } from "@/server/catalog/schema";
import {
  recipes, recipeComponents, inventoryItems, productInventoryLinks,
  type Recipe, type RecipeComponent, type ProductInventoryLink,
} from "./schema";
import { assertInventoryUom, toBase } from "./uom";
import { isDimensionalUom } from "@/server/catalog/uom-values";
import { InventoryConfigError } from "./errors";
import type { UnitOfMeasure } from "@/server/catalog/uom-values";

function auditCtx(tenantId: string, audit?: AuditActorInput) {
  return { tenantId, actorUserId: audit?.actorUserId ?? null, fingerprint: audit?.fingerprint ?? emptyFingerprint() };
}

/**
 * Recipes are restaurant-only (`recipes` capability); linking a sellable to
 * stock at all needs `inventory`. Gating here rather than only at the route
 * keeps a vertical that has no concept of a recipe from acquiring one through
 * any other caller.
 */
async function requireTenantCapability(tenantId: string, cap: "inventory" | "recipes"): Promise<void> {
  const tenant = await getTenantById(tenantId);
  if (!tenant) throw new InventoryConfigError("unknown tenant");
  requireCapability(tenant.vertical as VerticalId, cap);
}

export type RecipeComponentInput = {
  itemId: string;
  qty: string;
  uom: UnitOfMeasure;
  wastePct?: string;
};

export type RecipeWithComponents = Recipe & { components: RecipeComponent[] };

export async function listRecipes(tenantId: string): Promise<Recipe[]> {
  return withTenant(tenantId, (tx) => tx.select().from(recipes).orderBy(asc(recipes.nameEn)));
}

export async function getRecipe(tenantId: string, recipeId: string): Promise<RecipeWithComponents | null> {
  return withTenant(tenantId, async (tx) => {
    const [recipe] = await tx.select().from(recipes).where(eq(recipes.id, recipeId)).limit(1);
    if (!recipe) return null;
    const components = await tx.select().from(recipeComponents)
      .where(eq(recipeComponents.recipeId, recipeId));
    return { ...recipe, components };
  });
}

export async function createRecipe(
  tenantId: string,
  input: { nameEn: string; nameAr: string; yieldQty?: string; yieldUom?: UnitOfMeasure; components?: RecipeComponentInput[] },
  audit?: AuditActorInput,
): Promise<RecipeWithComponents> {
  await requireTenantCapability(tenantId, "recipes");
  if (input.yieldQty !== undefined && Number(input.yieldQty) <= 0) {
    throw new InventoryConfigError("yieldQty must be greater than zero");
  }
  const yieldUom = assertInventoryUom(input.yieldUom ?? "each");

  return withTenant(tenantId, async (tx) => {
    const [recipe] = await tx.insert(recipes).values({
      tenantId, nameEn: input.nameEn, nameAr: input.nameAr,
      yieldQty: input.yieldQty ?? "1", yieldUom,
    }).returning();

    const components = input.components?.length
      ? await writeComponents(tx, tenantId, recipe.id, input.components)
      : [];

    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "inventory.recipe.created", entityType: "recipe", entityId: recipe.id,
      summary: `Recipe "${recipe.nameEn}" created with ${components.length} component(s)`,
      metadata: { yieldQty: recipe.yieldQty, yieldUom: recipe.yieldUom, components: components.length },
      actorType: audit?.actorType,
    }, tx);

    return { ...recipe, components };
  });
}

export async function updateRecipe(
  tenantId: string, recipeId: string,
  patch: { nameEn?: string; nameAr?: string; yieldQty?: string; yieldUom?: UnitOfMeasure; isActive?: boolean },
  audit?: AuditActorInput,
): Promise<Recipe> {
  await requireTenantCapability(tenantId, "recipes");
  if (patch.yieldQty !== undefined && Number(patch.yieldQty) <= 0) {
    throw new InventoryConfigError("yieldQty must be greater than zero");
  }

  return withTenant(tenantId, async (tx) => {
    const set: Partial<typeof recipes.$inferInsert> = {};
    if (patch.nameEn !== undefined) set.nameEn = patch.nameEn;
    if (patch.nameAr !== undefined) set.nameAr = patch.nameAr;
    if (patch.yieldQty !== undefined) set.yieldQty = patch.yieldQty;
    if (patch.yieldUom !== undefined) set.yieldUom = assertInventoryUom(patch.yieldUom);
    if (patch.isActive !== undefined) set.isActive = patch.isActive;
    if (Object.keys(set).length === 0) throw new InventoryConfigError("no editable fields supplied");

    const [updated] = await tx.update(recipes).set(set).where(eq(recipes.id, recipeId)).returning();
    if (!updated) throw new InventoryConfigError("recipe not found");

    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "inventory.recipe.updated", entityType: "recipe", entityId: recipeId,
      summary: `Recipe "${updated.nameEn}" updated`,
      metadata: { changed: Object.keys(set) }, actorType: audit?.actorType,
    }, tx);
    return updated;
  });
}

/**
 * Replaces a recipe's component list wholesale. A bill of materials is edited as
 * a whole — "these are the ingredients now" — so replace-all avoids the
 * add/remove/reorder bookkeeping a diffing API would push onto every caller.
 */
export async function setRecipeComponents(
  tenantId: string, recipeId: string, components: RecipeComponentInput[], audit?: AuditActorInput,
): Promise<RecipeComponent[]> {
  await requireTenantCapability(tenantId, "recipes");

  return withTenant(tenantId, async (tx) => {
    const [recipe] = await tx.select().from(recipes).where(eq(recipes.id, recipeId)).limit(1);
    if (!recipe) throw new InventoryConfigError("recipe not found");

    await tx.delete(recipeComponents).where(eq(recipeComponents.recipeId, recipeId));
    const written = await writeComponents(tx, tenantId, recipeId, components);

    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "inventory.recipe.components_set", entityType: "recipe", entityId: recipeId,
      summary: `Recipe "${recipe.nameEn}" now has ${written.length} component(s)`,
      metadata: { components: written.map((c) => ({ itemId: c.itemId, qty: c.qty, uom: c.uom })) },
      actorType: audit?.actorType,
    }, tx);
    return written;
  });
}

/**
 * Validates and inserts component rows. Each quantity is converted to the item's
 * base unit purely to prove it CAN be — that rejects "200 ml of mozzarella"
 * (mass vs volume) at authoring time rather than at the till, where the failure
 * would surface as a mysterious refused sale.
 */
async function writeComponents(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string, recipeId: string, components: RecipeComponentInput[],
): Promise<RecipeComponent[]> {
  const out: RecipeComponent[] = [];
  for (const c of components) {
    if (Number(c.qty) <= 0) throw new InventoryConfigError("a component quantity must be greater than zero");
    if (c.wastePct !== undefined && Number(c.wastePct) < 0) {
      throw new InventoryConfigError("wastePct cannot be negative");
    }
    const [item] = await tx.select().from(inventoryItems).where(eq(inventoryItems.id, c.itemId)).limit(1);
    if (!item) throw new InventoryConfigError("component item not found");

    const uom = assertInventoryUom(c.uom);
    toBase(Number(c.qty), uom, {
      baseUom: assertInventoryUom(item.baseUom),
      stockToBase: item.stockToBase, purchaseToBase: item.purchaseToBase, recipeToBase: item.recipeToBase,
    });

    const [row] = await tx.insert(recipeComponents).values({
      tenantId, recipeId, itemId: c.itemId, qty: c.qty, uom, wastePct: c.wastePct ?? "0",
    }).returning();
    out.push(row);
  }
  return out;
}

export type LinkInput =
  | { productId: string; variantId?: string | null; linkType: "recipe"; recipeId: string }
  | { productId: string; variantId?: string | null; linkType: "finished_good"; itemId: string };

/**
 * Points a sellable at what it consumes. Replaces any existing link for the same
 * (product, variant) so a product cannot end up resolving to two different
 * things — the DB backs that with a partial unique index, and the XOR CHECK
 * backs the recipe/finished-good exclusivity.
 */
export async function linkProduct(
  tenantId: string, input: LinkInput, audit?: AuditActorInput,
): Promise<ProductInventoryLink> {
  await requireTenantCapability(tenantId, "inventory");
  if (input.linkType === "recipe") await requireTenantCapability(tenantId, "recipes");

  return withTenant(tenantId, async (tx) => {
    const [product] = await tx.select().from(products).where(eq(products.id, input.productId)).limit(1);
    if (!product) throw new InventoryConfigError("product not found");

    // Cut-to-size is modelled for LINEAR stock only: a board has one length, a
    // cut consumes one board, and the remainder goes back on the rack. Area and
    // board-foot products cut in two or three dimensions, where the remainder is
    // an irregular shape and deciding what is still sellable is a nesting
    // problem this does not attempt. Refusing the link is deliberate — the
    // alternative is deducting one whole sheet per cut and quietly reporting
    // stock the yard does not have.
    if (product.unitOfMeasure && isDimensionalUom(product.unitOfMeasure) && product.unitOfMeasure !== "m") {
      throw new InventoryConfigError(
        `stock tracking for products sold by ${product.unitOfMeasure} is not supported yet — only linear (m) cut-to-size is modelled`,
      );
    }
    if (product.unitOfMeasure === "m" && input.linkType === "finished_good") {
      const [item] = await tx.select().from(inventoryItems).where(eq(inventoryItems.id, input.itemId)).limit(1);
      // Boards are counted, not measured: the piece count lives in qtyRemaining
      // and the length lives on the lot, so the item itself must be `each`.
      if (item && item.baseUom !== "each") {
        throw new InventoryConfigError(
          "a cut-to-size product must link to an item held in `each` — pieces are counted and each lot carries its own length",
        );
      }
    }

    const variantId = input.variantId ?? null;
    if (variantId) {
      const [variant] = await tx.select().from(productVariants)
        .where(and(eq(productVariants.id, variantId), eq(productVariants.productId, input.productId))).limit(1);
      if (!variant) throw new InventoryConfigError("variant not found on this product");
    }

    if (input.linkType === "recipe") {
      const [recipe] = await tx.select().from(recipes).where(eq(recipes.id, input.recipeId)).limit(1);
      if (!recipe) throw new InventoryConfigError("recipe not found");
    } else {
      const [item] = await tx.select().from(inventoryItems).where(eq(inventoryItems.id, input.itemId)).limit(1);
      if (!item) throw new InventoryConfigError("inventory item not found");
    }

    await tx.delete(productInventoryLinks).where(and(
      eq(productInventoryLinks.productId, input.productId),
      variantId ? eq(productInventoryLinks.variantId, variantId) : isNull(productInventoryLinks.variantId),
    ));

    const [link] = await tx.insert(productInventoryLinks).values({
      tenantId, productId: input.productId, variantId,
      linkType: input.linkType,
      recipeId: input.linkType === "recipe" ? input.recipeId : null,
      itemId: input.linkType === "finished_good" ? input.itemId : null,
    }).returning();

    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "inventory.product_link.set", entityType: "product", entityId: input.productId,
      summary: `"${product.nameEn}" now deducts ${input.linkType === "recipe" ? "a recipe" : "finished-goods stock"}`,
      metadata: { variantId, linkType: input.linkType, recipeId: link.recipeId, itemId: link.itemId },
      actorType: audit?.actorType,
    }, tx);
    return link;
  });
}

/** Detaches a sellable from inventory. It then sells without deducting anything. */
export async function unlinkProduct(
  tenantId: string, productId: string, variantId: string | null, audit?: AuditActorInput,
): Promise<void> {
  await requireTenantCapability(tenantId, "inventory");
  await withTenant(tenantId, async (tx) => {
    const deleted = await tx.delete(productInventoryLinks).where(and(
      eq(productInventoryLinks.productId, productId),
      variantId ? eq(productInventoryLinks.variantId, variantId) : isNull(productInventoryLinks.variantId),
    )).returning({ id: productInventoryLinks.id });
    if (deleted.length === 0) throw new InventoryConfigError("no link for this product");

    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "inventory.product_link.removed", entityType: "product", entityId: productId,
      summary: `Product unlinked from inventory — it now sells without deducting`,
      metadata: { variantId }, actorType: audit?.actorType,
    }, tx);
  });
}

export async function listProductLinks(tenantId: string): Promise<ProductInventoryLink[]> {
  return withTenant(tenantId, (tx) => tx.select().from(productInventoryLinks));
}
