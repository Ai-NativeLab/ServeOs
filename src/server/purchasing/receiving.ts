import { eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { recordAuditEvent } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { requireCapability } from "@/server/verticals/registry";
import type { UnitOfMeasure } from "@/server/catalog/uom";
import { assertInventoryUom, qty, toBase } from "@/server/inventory/uom";
import { receiveStock, getOrCreateDefaultLocation } from "@/server/inventory/service";
import { inventoryItems } from "@/server/inventory/schema";
import { money } from "@/server/ordering/service";
import { purchaseOrders, purchaseOrderLines, poReceipts, poReceiptLines } from "./schema";
import type { PurchasingActor } from "./suppliers";
import { InvalidPoTransitionError, PoNotFoundError } from "./errors";
import { assertTransition, receiptStatus } from "./status";
import type { PoStatus } from "./status";

function auditCtx(actor: PurchasingActor) {
  return {
    tenantId: actor.tenantId,
    branchId: actor.branchId,
    actorUserId: actor.actorUserId,
    fingerprint: emptyFingerprint(),
  };
}

export type PostReceiptLineInput = {
  poLineId: string;
  receivedQty: number;
  uom: UnitOfMeasure;
  unitCost: number;
  lotCode?: string;
  expiryAt?: Date | null;
};

export type PostReceiptInput = {
  supplierDeliveryNote?: string;
  note?: string;
  lines: PostReceiptLineInput[];
};

/**
 * Bridges a PO into inventory: one transaction that, per line, converts the
 * received qty to base UoM (the item's own `purchaseToBase` factor wins),
 * calls Spec 8's `receiveStock` (lot + positive `receive` ledger row), bumps
 * `purchase_order_lines.qty_received`, then recomputes the PO status from
 * Σ received vs Σ ordered. Over-receipt is allowed. Emits `po.received`.
 */
export async function postReceipt(
  actor: PurchasingActor,
  poId: string,
  input: PostReceiptInput,
): Promise<{ receiptId: string; status: PoStatus }> {
  requireCapability(actor.vertical, "inventory");
  return withTenant(actor.tenantId, async (tx) => {
    // 1. SERIALIZE receipts per PO. The qty_received bump is a read-then-write
    //    under READ COMMITTED, and the status recompute reads the same stale
    //    snapshot: two receipts on the same PO in the same instant could both
    //    read qty_received=0 (lost update → final "4" not "8") and both compute
    //    the next status from data missing the other's commit (→ "partially_received"
    //    when the sum should have reached "received"). Locking the PO row first
    //    makes the loser wait, then re-read the winner's committed lines and
    //    status — the same pattern issueRefund uses on the order row.
    const [po] = await tx
      .select()
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, poId))
      .for("update")
      .limit(1);
    if (!po) throw new PoNotFoundError();
    if (po.status !== "sent" && po.status !== "partially_received") {
      throw new InvalidPoTransitionError(po.status as PoStatus, "partially_received");
    }

    const location = await getOrCreateDefaultLocation(tx, actor.tenantId, po.branchId, "back_of_house");
    const [receipt] = await tx.insert(poReceipts).values({
      tenantId: actor.tenantId,
      purchaseOrderId: poId,
      receivedByUserId: actor.actorUserId,
      supplierDeliveryNote: input.supplierDeliveryNote ?? null,
      note: input.note ?? null,
    }).returning({ id: poReceipts.id, receivedAt: poReceipts.receivedAt });

    const poLines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, poId));

    for (const l of input.lines) {
      const poLine = poLines.find((x) => x.id === l.poLineId);
      if (!poLine) throw new PoNotFoundError();

      const [item] = await tx.select().from(inventoryItems).where(eq(inventoryItems.id, poLine.itemId));
      if (!item) throw new PoNotFoundError();

      const uom = assertInventoryUom(l.uom);
      const baseUom = assertInventoryUom(item.baseUom);
      const [receiptLine] = await tx.insert(poReceiptLines).values({
        tenantId: actor.tenantId,
        poReceiptId: receipt.id,
        poLineId: l.poLineId,
        itemId: poLine.itemId,
        receivedQty: qty(l.receivedQty),
        uom,
        unitCost: money(l.unitCost),
        lotCode: l.lotCode ?? null,
        expiryAt: l.expiryAt ?? null,
      }).returning({ id: poReceiptLines.id });

      const baseQty = toBase(l.receivedQty, uom, { ...item, baseUom }, "purchase");
      await receiveStock(tx, {
        tenantId: actor.tenantId,
        itemId: poLine.itemId,
        locationId: location.id,
        baseQty,
        uom: baseUom,
        unitCost: money(l.unitCost),
        lotCode: l.lotCode ?? null,
        supplierId: po.supplierId,
        poReceiptLineId: receiptLine.id,
        expiryAt: l.expiryAt ?? null,
        receivedAt: receipt.receivedAt,
        byUserId: actor.actorUserId,
      });

      await tx.update(purchaseOrderLines)
        .set({ qtyReceived: qty(Number(poLine.qtyReceived) + l.receivedQty) })
        .where(eq(purchaseOrderLines.id, l.poLineId));
    }

    const fresh = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, poId));
    const next = receiptStatus(fresh);
    if (next !== po.status) {
      assertTransition(po.status as PoStatus, next);
      await tx.update(purchaseOrders).set({ status: next }).where(eq(purchaseOrders.id, poId));
    }

    await recordAuditEvent(auditCtx(actor), {
      action: "po.received",
      entityType: "purchase_order",
      entityId: poId,
      summary: `Receipt on PO #${po.poNumber}`,
      metadata: { receiptId: receipt.id, lineCount: input.lines.length, status: next },
    }, tx);

    return { receiptId: receipt.id, status: next };
  });
}
