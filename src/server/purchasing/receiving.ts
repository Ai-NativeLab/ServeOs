import { eq, sql } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { recordAuditEvent } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { requireCapability } from "@/server/verticals/registry";
import type { UnitOfMeasure } from "@/server/catalog/uom";
import { assertInventoryUom, dimensionOf, qty, toBase } from "@/server/inventory/uom";
import { receiveStock, getOrCreateDefaultLocation } from "@/server/inventory/service";
import { inventoryItems } from "@/server/inventory/schema";
import { money } from "@/server/ordering/service";
import { purchaseOrders, purchaseOrderLines, poReceipts, poReceiptLines } from "./schema";
import type { PurchasingActor } from "./suppliers";
import { InvalidPoInputError, InvalidPoTransitionError, PoNotFoundError, ReceiptUomMismatchError } from "./errors";
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
 * Σ received vs Σ ordered. Emits `po.received`.
 *
 * DELIBERATE, both deferred out of this spec rather than overlooked:
 * - Over-receipt is allowed with no tolerance. Suppliers over-ship routinely
 *   and refusing goods at the door is worse than recording them; the excess
 *   surfaces in `getPoVariance().overReceived` for the buyer to chase. A
 *   percentage tolerance with an override flag is the follow-up.
 * - Receipts are NOT idempotent: a retried POST writes a second receipt, and
 *   the PO-row lock serializes rather than collapses it. Fixing that needs a
 *   client-supplied receipt key plus a unique index on
 *   (tenant_id, purchase_order_id, key) — an API-contract change, so it is a
 *   follow-up rather than something to bolt on here.
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
      // 4. Input guardrail first: NaN / non-positive quantities and non-finite
      //    unit costs would otherwise reach `money`/`qty` and store junk ledger.
      if (!Number.isFinite(l.receivedQty) || l.receivedQty <= 0) {
        throw new InvalidPoInputError(`receivedQty must be a positive finite number (got ${l.receivedQty})`);
      }
      if (!Number.isFinite(l.unitCost) || l.unitCost < 0) {
        throw new InvalidPoInputError(`unitCost must be a finite non-negative number (got ${l.unitCost})`);
      }

      const poLine = poLines.find((x) => x.id === l.poLineId);
      if (!poLine) throw new PoNotFoundError();

      const [item] = await tx.select().from(inventoryItems).where(eq(inventoryItems.id, poLine.itemId));
      if (!item) throw new PoNotFoundError();

      const uom = assertInventoryUom(l.uom);
      // Receipts must be stated in the same unit the line was ordered in:
      // otherwise qty_received is not comparable to qty_ordered and the item
      // factor gets applied against a foreign magnitude (500 g vs an order of
      // 5 kg became 500 × 1000 = 500000 base units).
      if (uom !== poLine.uom) throw new ReceiptUomMismatchError(l.poLineId, poLine.uom, uom);

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

      // The purchase factor only ever applies when the receipt's unit IS the
      // item's declared purchase unit (a 24-can case, counted in kg but held in
      // g). Receiving in any other unit converts dimensionally instead — an
      // order placed in the wrong unit must not silently re-scale against a
      // factor meant for the purchase unit (500 g × 1000 = 500000, the
      // over-credit this guard exists to stop).
      // A purchase factor only means something when the purchase unit differs
      // from the base unit (a 24-can case is counted in `each` and held in
      // `each`, so `count` is the one dimension where same-unit + factor is
      // legitimate). For mass/volume, purchaseUom === baseUom with a factor
      // other than 1 is a contradictory item config, and applying it silently
      // over-credits the ledger by that factor — reject it instead.
      const factor = Number(item.purchaseToBase);
      if (uom === item.purchaseUom && uom === baseUom && factor !== 1 && dimensionOf(uom) !== "count") {
        throw new InvalidPoInputError(
          `item ${poLine.itemId} declares purchaseUom ${uom} equal to its base unit but purchaseToBase ${item.purchaseToBase} — the factor cannot be applied to its own base unit`,
        );
      }
      const factorKind: "purchase" | undefined = uom === item.purchaseUom ? "purchase" : undefined;
      const baseQty = toBase(l.receivedQty, uom, { ...item, baseUom }, factorKind);
      if (!(baseQty > 0)) {
        throw new InvalidPoInputError(
          `receivedQty ${l.receivedQty} ${uom} converts to zero base units (${baseUom})`,
        );
      }
      // The lot's unit cost is per BASE unit: 2 cases @ 50.00 against a factor
      // of 24 is 100.00 ÷ 48 per can, not 50.00. totalCost ÷ baseQty is the
      // exact per-base-unit cost, immune to which unit the receipt used. It is
      // NOT a 2dp currency amount, and `money` would round it to one — a
      // permanent wedge between the lot's value (2.08 × 48 = 99.84) and what
      // was actually paid (100.00). `inventory_lots.unit_cost` is unbounded
      // numeric, so the exact quotient is stored as-is.
      const baseUnitCost = (l.unitCost * l.receivedQty) / baseQty;
      // `receivedQty` and `unitCost` are each finite, but their PRODUCT can
      // still overflow to Infinity, and `String(Infinity)` is accepted by
      // Postgres `numeric` — the same un-correctable ledger poison the NaN
      // guard above exists to stop, arriving through the quotient instead.
      if (!Number.isFinite(baseUnitCost)) {
        throw new InvalidPoInputError(
          `receivedQty ${l.receivedQty} x unitCost ${l.unitCost} overflows to a non-finite cost`,
        );
      }
      await receiveStock(tx, {
        tenantId: actor.tenantId,
        itemId: poLine.itemId,
        locationId: location.id,
        baseQty,
        uom: baseUom,
        unitCost: String(baseUnitCost),
        lotCode: l.lotCode ?? null,
        supplierId: po.supplierId,
        poReceiptLineId: receiptLine.id,
        expiryAt: l.expiryAt ?? null,
        receivedAt: receipt.receivedAt,
        byUserId: actor.actorUserId,
      });

      // SQL-side increment: two lines in one receipt may share a poLineId, and
      // each must add to whatever the loop already wrote (read-then-write with a
      // stale value would leave last-write-wins — 6 not 4+6). Under the PO-row
      // lock above this is also safe across concurrent receipts.
      await tx.update(purchaseOrderLines)
        .set({ qtyReceived: sql`${purchaseOrderLines.qtyReceived} + ${qty(l.receivedQty)}` })
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
