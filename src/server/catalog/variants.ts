// setProductStock / setVariantStock are SUPERSEDED by POST /inventory/adjustments.
// They survive only to mirror the legacy products.stockQuantity /
// product_variants.stockQuantity integers during the migration window, because
// the storefront's inStock computation still reads them. Both these shims and
// those columns are dropped once inStock reads on-hand from the ledger
// (spec Migration §5 / follow-up). New code must go through the inventory service.
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { getTenantById } from "@/server/tenancy";
import { requireCapability, type VerticalId } from "@/server/verticals";
import { recordAuditEvent, type AuditActorInput } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { bumpCatalogVersion } from "./version";
import { productInventoryLinks, inventoryItems, stockLedger } from "@/server/inventory/schema";
import { adjustStock, getOrCreateDefaultLocation, onHandOnTx } from "@/server/inventory/service";
import { assertInventoryUom } from "@/server/inventory/uom";
import { branches } from "@/server/branches/schema";
import { productVariants, products, type ProductVariant } from "./schema";
import { ProductNotFoundError } from "./errors";

function auditCtx(tenantId: string, audit?: AuditActorInput) {
  return { tenantId, actorUserId: audit?.actorUserId ?? null, fingerprint: audit?.fingerprint ?? emptyFingerprint() };
}
function auditMeta(audit: AuditActorInput | undefined, extra: Record<string, unknown> = {}) {
  return { roleKey: audit?.roleKey ?? null, ...extra };
}

export type VariantInput = {
  id?: string;
  nameEn: string;
  nameAr: string;
  sku?: string | null;
  price: string;
  stockQuantity?: number | null;
  isActive?: boolean;
  sortOrder?: number;
};

async function requireTenantCapability(tenantId: string, cap: "variants" | "stockTracking" | "inventory"): Promise<void> {
  const tenant = await getTenantById(tenantId);
  if (!tenant) throw new ProductNotFoundError();
  requireCapability(tenant.vertical as VerticalId, cap);
}

export async function listVariants(tenantId: string, productId: string): Promise<ProductVariant[]> {
  return withTenant(tenantId, (tx) =>
    tx.select().from(productVariants).where(eq(productVariants.productId, productId)).orderBy(productVariants.sortOrder),
  );
}

export async function upsertVariant(tenantId: string, productId: string, input: VariantInput, audit?: AuditActorInput): Promise<ProductVariant> {
  await requireTenantCapability(tenantId, "variants");
  return withTenant(tenantId, async (tx) => {
    let row: ProductVariant | undefined;
    if (input.id) {
      [row] = await tx.update(productVariants)
        .set({ nameEn: input.nameEn, nameAr: input.nameAr, sku: input.sku ?? null, price: input.price, stockQuantity: input.stockQuantity ?? null, isActive: input.isActive ?? true, sortOrder: input.sortOrder ?? 0 })
        .where(and(eq(productVariants.id, input.id!), eq(productVariants.productId, productId)))
        .returning();
      if (!row) throw new ProductNotFoundError();
    } else {
      [row] = await tx.insert(productVariants)
        .values({ tenantId, productId, nameEn: input.nameEn, nameAr: input.nameAr, sku: input.sku ?? null, price: input.price, stockQuantity: input.stockQuantity ?? null, isActive: input.isActive ?? true, sortOrder: input.sortOrder ?? 0 })
        .returning();
    }
    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "catalog.variant.upserted", entityType: "product_variant", entityId: row.id,
      summary: `Variant "${row.nameEn}" saved`, metadata: auditMeta(audit, { productId, price: row.price }), actorType: audit?.actorType,
    }, tx);
    await bumpCatalogVersion(tenantId, tx);
    return row;
  });
}

export async function deleteVariant(tenantId: string, variantId: string, audit?: AuditActorInput): Promise<void> {
  await requireTenantCapability(tenantId, "variants");
  await withTenant(tenantId, async (tx) => {
    await tx.delete(productVariants).where(eq(productVariants.id, variantId));
    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "catalog.variant.deleted", entityType: "product_variant", entityId: variantId,
      summary: `Variant deleted`, metadata: auditMeta(audit), actorType: audit?.actorType,
    }, tx);
    await bumpCatalogVersion(tenantId, tx);
  });
}

export async function setVariantStock(tenantId: string, variantId: string, qty: number | null, audit?: AuditActorInput): Promise<void> {
  await requireTenantCapability(tenantId, "inventory");
  await withTenant(tenantId, async (tx) => {
    const [before] = await tx.select({ stockQuantity: productVariants.stockQuantity, productId: productVariants.productId })
      .from(productVariants).where(eq(productVariants.id, variantId)).limit(1);
    await tx.update(productVariants).set({ stockQuantity: qty }).where(eq(productVariants.id, variantId));
    if (before?.productId) {
      await reconcileLinkedOnHand(tx, tenantId, before.productId, variantId, qty, audit);
    }
    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "catalog.stock.set", entityType: "product_variant", entityId: variantId,
      summary: `Variant stock ${before?.stockQuantity ?? "∅"} → ${qty ?? "∅"}`,
      metadata: auditMeta(audit, { before: before?.stockQuantity ?? null, after: qty }), actorType: audit?.actorType,
    }, tx);
    // Stock crossing to/from zero flips inStock on the published menu — a
    // catalog-visible change with no row's updated_at to show for it.
    await bumpCatalogVersion(tenantId, tx);
  });
}

export async function setProductStock(tenantId: string, productId: string, qty: number | null, audit?: AuditActorInput): Promise<void> {
  await requireTenantCapability(tenantId, "inventory");
  await withTenant(tenantId, async (tx) => {
    const [before] = await tx.select({ stockQuantity: products.stockQuantity }).from(products).where(eq(products.id, productId)).limit(1);
    await tx.update(products).set({ stockQuantity: qty, trackStock: qty !== null }).where(eq(products.id, productId));
    await reconcileLinkedOnHand(tx, tenantId, productId, null, qty, audit);
    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "catalog.stock.set", entityType: "product", entityId: productId,
      summary: `Product stock ${before?.stockQuantity ?? "∅"} → ${qty ?? "∅"}`,
      metadata: auditMeta(audit, { before: before?.stockQuantity ?? null, after: qty }), actorType: audit?.actorType,
    }, tx);
    await bumpCatalogVersion(tenantId, tx);
  });
}

/**
 * Keeps the ledger — the real source of on-hand truth — in step when someone
 * sets stock through the legacy integer field. Posts the difference as an
 * `adjustment` against the linked finished-goods item, so "set stock to N"
 * means on-hand really becomes N rather than the two numbers drifting apart.
 *
 * No link means the product predates the backfill or is untracked; there is
 * nothing to reconcile and the integer stands alone.
 */
async function reconcileLinkedOnHand(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string, productId: string, variantId: string | null,
  qty: number | null, audit?: AuditActorInput,
): Promise<void> {
  if (qty === null) return;
  const [link] = await tx.select().from(productInventoryLinks).where(and(
    eq(productInventoryLinks.productId, productId),
    variantId ? eq(productInventoryLinks.variantId, variantId) : isNull(productInventoryLinks.variantId),
  )).limit(1);
  if (!link?.itemId) return;

  const [item] = await tx.select().from(inventoryItems)
    .where(eq(inventoryItems.id, link.itemId)).limit(1);
  if (!item) return;

  // Target the location this item's stock already lives at. The legacy field is
  // a single global number with no branch, so picking "the first retail location"
  // would land a multi-branch tenant's correction on whichever branch happened to
  // sort first — inflating one shelf while the operator was looking at another.
  // Following the existing ledger keeps the correction where the stock is.
  const [existing] = await tx.select({ locationId: stockLedger.locationId }).from(stockLedger)
    .where(eq(stockLedger.itemId, link.itemId))
    .orderBy(desc(stockLedger.createdAt)).limit(1);

  let locationId = existing?.locationId;
  if (!locationId) {
    // Never moved before: fall back to the oldest branch's retail shelf, the same
    // rule the backfill uses, so both land opening stock in the same place.
    const [branch] = await tx.select({ id: branches.id }).from(branches)
      .where(eq(branches.tenantId, tenantId)).orderBy(asc(branches.createdAt)).limit(1);
    if (!branch) return;
    const loc = await getOrCreateDefaultLocation(tx, tenantId, branch.id, "retail");
    locationId = loc.id;
  }

  const current = await onHandOnTx(tx, link.itemId, locationId);
  const delta = qty - current;
  if (Math.abs(delta) < 0.0005) return;
  // The item's own base unit — hardcoding "each" would reject a gram-based item
  // outright now that adjustStock validates the dimension. Narrowed at runtime,
  // not cast: a mis-seeded dimensional base must fail loudly, not sneak through.
  await adjustStock(tx, {
    tenantId, itemId: link.itemId, locationId, baseQty: delta, uom: assertInventoryUom(item.baseUom),
    byUserId: audit?.actorUserId ?? null, note: "legacy stock field set",
  });
}

