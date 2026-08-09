"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withTenant } from "@/db/with-tenant";
import { requireInventoryPermission } from "../inventory-permission";
import { actionAudit } from "@/server/audit/action-context";
import { inventoryItems } from "@/server/inventory/schema";
import { receiveStock, adjustStock, transferStock, getOrCreateDefaultLocation } from "@/server/inventory/service";
import { createRecipe, setRecipeComponents, linkProduct, unlinkProduct } from "@/server/inventory/recipes";
import { assertInventoryUom } from "@/server/inventory/uom";
import type { UnitOfMeasure } from "@/server/catalog/uom-values";
import { recordAuditEvent } from "@/server/audit/service";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const num = (f: FormData, k: string) => Number(f.get(k));
const optional = (f: FormData, k: string) => (str(f, k) === "" ? null : str(f, k));

/**
 * Resolves the location a form posted, falling back to the branch's default
 * shelf. Forms let an operator omit it — most tenants have exactly one place
 * stock lives, and asking them to pick it every time is friction for nothing.
 */
async function resolveLocation(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string, form: FormData, kind: "retail" | "kitchen" | "back_of_house",
): Promise<string> {
  const explicit = optional(form, "locationId");
  if (explicit) return explicit;
  const branchId = str(form, "branchId");
  const loc = await getOrCreateDefaultLocation(tx, tenantId, branchId, kind);
  return loc.id;
}

export async function createItemAction(formData: FormData) {
  const ctx = await requireInventoryPermission("inventory:manage");
  const baseUom = assertInventoryUom(str(formData, "baseUom") as UnitOfMeasure);
  const audit = await actionAudit(ctx);

  await withTenant(ctx.tenantId, async (tx) => {
    const [item] = await tx.insert(inventoryItems).values({
      tenantId: ctx.tenantId,
      nameEn: str(formData, "nameEn"),
      nameAr: str(formData, "nameAr") || str(formData, "nameEn"),
      sku: optional(formData, "sku"),
      kind: (str(formData, "kind") || "ingredient") as "ingredient" | "finished_good" | "raw_material",
      // Stock/purchase/recipe units default to the base unit. An item that is
      // bought by the case or consumed in a different unit sets those on the
      // item edit screen rather than at creation, so this form stays short.
      baseUom, stockUom: baseUom, purchaseUom: baseUom, recipeUom: baseUom,
      isPerishable: formData.get("isPerishable") === "true",
    }).returning({ id: inventoryItems.id });

    await recordAuditEvent(
      { tenantId: ctx.tenantId, actorUserId: audit.actorUserId, fingerprint: audit.fingerprint },
      {
        action: "inventory.item.created", entityType: "inventory_item", entityId: item.id,
        summary: `Item "${str(formData, "nameEn")}" created`,
        metadata: { baseUom, kind: str(formData, "kind") },
      },
      tx,
    );
  });
  revalidatePath("/dashboard/inventory");
  redirect("/dashboard/inventory");
}

/** Goods in — the delivery path. Creates a lot, so the stock is sellable. */
export async function receiveStockAction(formData: FormData) {
  const ctx = await requireInventoryPermission("inventory:manage");
  const audit = await actionAudit(ctx);
  const itemId = str(formData, "itemId");

  await withTenant(ctx.tenantId, async (tx) => {
    const locationId = await resolveLocation(tx, ctx.tenantId, formData, "retail");
    const { lotId } = await receiveStock(tx, {
      tenantId: ctx.tenantId, itemId, locationId,
      baseQty: num(formData, "qty"),
      uom: str(formData, "uom") as UnitOfMeasure as never,
      unitCost: optional(formData, "unitCost"),
      lotCode: optional(formData, "lotCode"),
      lengthMm: optional(formData, "lengthMm") ? num(formData, "lengthMm") : null,
      expiryAt: optional(formData, "expiryAt") ? new Date(str(formData, "expiryAt")) : null,
      byUserId: audit.actorUserId ?? null,
    });
    await recordAuditEvent(
      { tenantId: ctx.tenantId, actorUserId: audit.actorUserId, fingerprint: audit.fingerprint },
      {
        action: "inventory.received", entityType: "inventory_item", entityId: itemId,
        summary: `Received ${num(formData, "qty")} ${str(formData, "uom")}`,
        metadata: { locationId, lotId, unitCost: optional(formData, "unitCost") },
      },
      tx,
    );
  });
  revalidatePath("/dashboard/inventory");
}

/** A correction or a write-off. `waste` is its own ledger type, not a negative adjustment. */
export async function adjustStockAction(formData: FormData) {
  const ctx = await requireInventoryPermission("inventory:manage");
  const audit = await actionAudit(ctx);
  const isWaste = str(formData, "mode") === "waste";
  // Waste is always a reduction, however the operator typed the number.
  const magnitude = Math.abs(num(formData, "qty"));

  await withTenant(ctx.tenantId, async (tx) => {
    const locationId = await resolveLocation(tx, ctx.tenantId, formData, "retail");
    await adjustStock(tx, {
      tenantId: ctx.tenantId,
      itemId: str(formData, "itemId"), locationId,
      baseQty: isWaste ? -magnitude : num(formData, "qty"),
      uom: str(formData, "uom") as UnitOfMeasure as never,
      type: isWaste ? "waste" : "adjustment",
      byUserId: audit.actorUserId ?? null,
      note: optional(formData, "note"),
      audit,
    });
  });
  revalidatePath("/dashboard/inventory");
}

export async function transferStockAction(formData: FormData) {
  const ctx = await requireInventoryPermission("inventory:manage");
  const audit = await actionAudit(ctx);

  await withTenant(ctx.tenantId, (tx) => transferStock(tx, {
    tenantId: ctx.tenantId,
    itemId: str(formData, "itemId"),
    fromLocationId: str(formData, "fromLocationId"),
    toLocationId: str(formData, "toLocationId"),
    baseQty: num(formData, "qty"),
    uom: str(formData, "uom") as UnitOfMeasure as never,
    byUserId: audit.actorUserId ?? null,
    note: optional(formData, "note"),
    audit,
  }));
  revalidatePath("/dashboard/inventory");
}

export async function createRecipeAction(formData: FormData) {
  const ctx = await requireInventoryPermission("inventory:manage");
  const recipe = await createRecipe(ctx.tenantId, {
    nameEn: str(formData, "nameEn"),
    nameAr: str(formData, "nameAr") || str(formData, "nameEn"),
    yieldQty: str(formData, "yieldQty") || "1",
  }, await actionAudit(ctx));
  revalidatePath("/dashboard/inventory/recipes");
  redirect(`/dashboard/inventory/recipes/${recipe.id}`);
}

/**
 * Replaces a recipe's components from the repeated form rows. A BOM is edited as
 * a whole, so the form posts the full list and the service swaps it.
 */
export async function setRecipeComponentsAction(recipeId: string, formData: FormData) {
  const ctx = await requireInventoryPermission("inventory:manage");
  const itemIds = formData.getAll("componentItemId").map(String);
  const quantities = formData.getAll("componentQty").map(String);
  const uoms = formData.getAll("componentUom").map(String);
  const wastes = formData.getAll("componentWastePct").map(String);

  const components = itemIds
    .map((itemId, i) => ({
      itemId,
      qty: quantities[i] ?? "0",
      uom: (uoms[i] ?? "g") as UnitOfMeasure,
      wastePct: wastes[i] || "0",
    }))
    // A blank row is how someone removes a line, so drop them rather than
    // failing the whole save on an empty quantity.
    .filter((c) => c.itemId && Number(c.qty) > 0);

  await setRecipeComponents(ctx.tenantId, recipeId, components, await actionAudit(ctx));
  revalidatePath(`/dashboard/inventory/recipes/${recipeId}`);
}

/** Points a sellable at what it consumes — the row placeOrder resolves. */
export async function linkProductAction(formData: FormData) {
  const ctx = await requireInventoryPermission("inventory:manage");
  const audit = await actionAudit(ctx);
  const productId = str(formData, "productId");
  const variantId = optional(formData, "variantId");
  const recipeId = optional(formData, "recipeId");
  const itemId = optional(formData, "itemId");

  await linkProduct(ctx.tenantId, recipeId
    ? { productId, variantId, linkType: "recipe", recipeId }
    : { productId, variantId, linkType: "finished_good", itemId: itemId! },
    audit);
  revalidatePath("/dashboard/inventory");
  revalidatePath("/dashboard/inventory/recipes");
}

export async function unlinkProductAction(formData: FormData) {
  const ctx = await requireInventoryPermission("inventory:manage");
  await unlinkProduct(
    ctx.tenantId, str(formData, "productId"), optional(formData, "variantId"), await actionAudit(ctx),
  );
  revalidatePath("/dashboard/inventory");
}
