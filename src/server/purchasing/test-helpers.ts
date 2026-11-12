import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { users } from "@/server/auth/schema";
import { seedInventoryTenant, seedItem, seedLocation } from "@/server/inventory/test-helpers";
import { supplierItems, purchaseOrderLines, poReceipts, poReceiptLines } from "./schema";
import { reorderRules } from "./reorder-schema";
import { createSupplier } from "./suppliers";
import { createDraftPo } from "./service";
import type { PurchasingActor } from "./suppliers";

export async function seedPurchasingActor(tenantId: string, branchId: string): Promise<PurchasingActor> {
  const [user] = await db.insert(users).values({
    tenantId, name: "Owner", email: `pa-${crypto.randomUUID().slice(0, 8)}@x.com`, status: "active",
  }).returning({ id: users.id });
  return { tenantId, branchId, actorUserId: user.id, vertical: "restaurant" as const };
}

/** One row in every purchasing table that carries a numeric column, all legal. */
export type PurchasingRowSet = {
  poId: string;
  poLineId: string;
  poReceiptLineId: string;
  supplierItemId: string;
  reorderRuleId: string;
};

/**
 * A tenant with `sets` independent, fully legal row sets: each one a draft PO
 * (one taxed line) with a receipt line against it, plus a supplier price and a
 * reorder rule for its own item. Written through the shipped services where
 * they exist, and through `withTenant` (the app role, under RLS) where not.
 */
export async function seedPurchasingTenant(sets: number) {
  const { tenantId, branchId } = await seedInventoryTenant();
  const actor = await seedPurchasingActor(tenantId, branchId);
  const supplierId = await createSupplier(actor, { name: "Sup" });
  const locationId = await seedLocation(tenantId, branchId, "kitchen");

  const rowSets: PurchasingRowSet[] = [];
  for (let i = 0; i < sets; i++) {
    const itemId = await seedItem(tenantId, { baseUom: "each" });
    const { poId } = await createDraftPo(actor, {
      supplierId, branchId,
      lines: [{ itemId, qtyOrdered: 3, uom: "each", unitCost: 2.5, taxRate: 0.14 }],
    });
    const ids = await withTenant(tenantId, async (tx) => {
      const [poLine] = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, poId));
      const [receipt] = await tx.insert(poReceipts)
        .values({ tenantId, purchaseOrderId: poId, receivedByUserId: actor.actorUserId })
        .returning({ id: poReceipts.id });
      const [receiptLine] = await tx.insert(poReceiptLines).values({
        tenantId, poReceiptId: receipt.id, poLineId: poLine.id, itemId,
        receivedQty: "1", uom: "each", unitCost: "2.5",
      }).returning({ id: poReceiptLines.id });
      const [supplierItem] = await tx.insert(supplierItems)
        .values({ tenantId, supplierId, itemId, lastUnitCost: "2.5" })
        .returning({ id: supplierItems.id });
      const [rule] = await tx.insert(reorderRules)
        .values({ tenantId, itemId, locationId, reorderPoint: "5", reorderQty: "10" })
        .returning({ id: reorderRules.id });
      return {
        poId, poLineId: poLine.id, poReceiptLineId: receiptLine.id,
        supplierItemId: supplierItem.id, reorderRuleId: rule.id,
      };
    });
    rowSets.push(ids);
  }
  return { tenantId, branchId, actor, supplierId, rowSets };
}

/** The id in a row set that addresses `table`'s row. */
export function rowIdFor(set: PurchasingRowSet, table: string): string {
  switch (table) {
    case "supplier_items": return set.supplierItemId;
    case "purchase_orders": return set.poId;
    case "purchase_order_lines": return set.poLineId;
    case "po_receipt_lines": return set.poReceiptLineId;
    case "reorder_rules": return set.reorderRuleId;
    default: throw new Error(`no fixture row for ${table}`);
  }
}
