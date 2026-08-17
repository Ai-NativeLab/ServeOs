import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { users } from "@/server/auth/schema";
import { seedInventoryTenant, seedItem, seedLocation } from "@/server/inventory/test-helpers";
import {
  suppliers, supplierItems, purchaseOrders, purchaseOrderLines, poReceipts, poReceiptLines,
} from "./schema";
import { reorderRules } from "./reorder-schema";
import { createSupplier } from "./suppliers";
import { createDraftPo } from "./service";
import { postReceipt } from "./receiving";
import { PoNotFoundError } from "./errors";
import type { PurchasingActor } from "./suppliers";

async function seedActor(tenantId: string, branchId: string): Promise<PurchasingActor> {
  const [user] = await db.insert(users).values({
    tenantId, name: "Owner", email: `rl-${crypto.randomUUID().slice(0, 8)}@x.com`, status: "active",
  }).returning({ id: users.id });
  return { tenantId, branchId, actorUserId: user.id, vertical: "restaurant" as const };
}

/** A tenant with a supplier, a reorder rule and a draft PO (plus receipt FKs). */
async function seedPurchasingTenant() {
  const { tenantId, branchId } = await seedInventoryTenant();
  const actor = await seedActor(tenantId, branchId);
  const supplierId = await createSupplier(actor, { name: "Sup" });
  const itemId = await seedItem(tenantId, { baseUom: "each" });
  const locationId = await seedLocation(tenantId, branchId, "kitchen");
  const { poId } = await createDraftPo(actor, {
    supplierId, branchId,
    lines: [{ itemId, qtyOrdered: 1, uom: "each", unitCost: 1 }],
  });
  const [poLine] = await withTenant(tenantId, (tx) =>
    tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, poId)));
  const [receipt] = await withTenant(tenantId, (tx) =>
    tx.insert(poReceipts).values({ tenantId, purchaseOrderId: poId, receivedByUserId: actor.actorUserId })
      .returning({ id: poReceipts.id }));
  await withTenant(tenantId, (tx) =>
    tx.insert(poReceiptLines).values({
      tenantId, poReceiptId: receipt.id, poLineId: poLine!.id, itemId,
      receivedQty: "1", uom: "each", unitCost: "1",
    }));
  await withTenant(tenantId, (tx) =>
    tx.insert(supplierItems).values({ tenantId, supplierId, itemId }));
  await withTenant(tenantId, (tx) =>
    tx.insert(reorderRules).values({
      tenantId, itemId, locationId, reorderPoint: "5", reorderQty: "10",
    }));
  return { tenantId, actor, itemId, poId, poLineId: poLine!.id };
}

describe("purchasing tables RLS", () => {
  it.each([
    ["suppliers", suppliers as never],
    ["supplier_items", supplierItems as never],
    ["purchase_orders", purchaseOrders as never],
    ["purchase_order_lines", purchaseOrderLines as never],
    ["po_receipts", poReceipts as never],
    ["po_receipt_lines", poReceiptLines as never],
    ["reorder_rules", reorderRules as never],
  ])("%s isolates per tenant and fails closed outside withTenant", async (_name, table) => {
    const a = await seedPurchasingTenant();
    const bare = await seedInventoryTenant(); // owns no purchasing rows

    const mine = await withTenant(a.tenantId, (tx) => tx.select().from(table));
    const theirs = await withTenant(bare.tenantId, (tx) => tx.select().from(table));
    const noTenant = await db.select().from(table);
    expect(mine.length).toBeGreaterThan(0);
    expect(theirs.length).toBe(0);
    expect(noTenant.length).toBe(0); // FORCE RLS fails closed without app.tenant_id
  });

  it("receipt lines cannot reference another tenant's PO — RLS hides it before the write", async () => {
    const a = await seedPurchasingTenant();
    const b = await seedPurchasingTenant();

    // purchase_order_id is a guest FK that RLS's WITH CHECK (tenant_id only)
    // does not police, so the isolation rests on the read: postReceipt's FOR
    // UPDATE re-read of the PO runs under tenant A's RLS, where tenant B's PO
    // does not exist. RLS fails closed, and the write never happens.
    await expect(postReceipt(a.actor, b.poId, {
      lines: [{ poLineId: a.poLineId, receivedQty: 1, uom: "each", unitCost: 1 }],
    })).rejects.toBeInstanceOf(PoNotFoundError);
  });
});