import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, pool } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { users } from "@/server/auth/schema";
import { seedInventoryTenant, seedItem } from "@/server/inventory/test-helpers";
import { inventoryItems, inventoryLots, stockLedger } from "@/server/inventory/schema";
import { DimensionalUomError } from "@/server/inventory/errors";
import { verifyChain } from "@/server/audit/verifier";
import { auditEvents } from "@/server/audit/schema";
import { purchaseOrders, purchaseOrderLines, poReceipts, poReceiptLines } from "./schema";
import type { PurchasingActor } from "./suppliers";
import { createSupplier } from "./suppliers";
import { createDraftPo } from "./service";
import { postReceipt } from "./receiving";
import { InvalidPoTransitionError, PoNotFoundError } from "./errors";

async function seedActor(tenantId: string, branchId: string): Promise<PurchasingActor> {
  const [user] = await db.insert(users).values({
    tenantId, name: "Receiver", email: `rec-${crypto.randomUUID().slice(0, 8)}@x.com`, status: "active",
  }).returning({ id: users.id });
  return { tenantId, branchId, actorUserId: user.id, vertical: "restaurant" as const };
}

/** A supplier + one item, and a `sent` PO for 10 of it at 5.00. */
async function seedSentPo(purchaseToBase = "1") {
  const { tenantId, branchId } = await seedInventoryTenant();
  const actor = await seedActor(tenantId, branchId);
  const supplierId = await createSupplier(actor, { name: "Sup", email: "sup@x.com" });
  const itemId = await seedItem(tenantId, { baseUom: "each" });
  if (purchaseToBase !== "1") {
    await withTenant(tenantId, (tx) =>
      tx.update(inventoryItems).set({ purchaseToBase }).where(eq(inventoryItems.id, itemId)));
  }
  const { poId } = await createDraftPo(actor, {
    supplierId, branchId,
    lines: [{ itemId, qtyOrdered: 10, uom: "each", unitCost: 5 }],
  });
  await withTenant(tenantId, (tx) =>
    tx.update(purchaseOrders).set({ status: "sent" }).where(eq(purchaseOrders.id, poId)));
  const [poLine] = await withTenant(tenantId, (tx) =>
    tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, poId)));
  return { tenantId, branchId, actor, supplierId, itemId, poId, poLineId: poLine!.id };
}

function receiptLine(poLineId: string, over: Record<string, unknown> = {}) {
  return { poLineId, receivedQty: 4, uom: "each", unitCost: 5, ...over } as const;
}

describe("receiving", () => {
  it("a partial receipt creates one lot + one receive ledger row and moves the PO to partially_received", async () => {
    const { tenantId, actor, itemId, poId, poLineId } = await seedSentPo();
    const { receiptId, status } = await postReceipt(actor, poId, { lines: [receiptLine(poLineId)] });

    expect(status).toBe("partially_received");

    const lots = await withTenant(tenantId, (tx) => tx.select().from(inventoryLots).where(eq(inventoryLots.itemId, itemId)));
    expect(lots).toHaveLength(1);
    expect(lots[0]?.qtyRemaining).toBe("4.000");

    const ledger = await withTenant(tenantId, (tx) => tx.select().from(stockLedger).where(eq(stockLedger.itemId, itemId)));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.type).toBe("receive");
    expect(ledger[0]?.qty).toBe("4.000");

    const [receiptLineRow] = await withTenant(tenantId, (tx) =>
      tx.select().from(poReceiptLines).where(eq(poReceiptLines.poReceiptId, receiptId)));
    expect(lots[0]?.poReceiptLineId).toBe(receiptLineRow?.id);

    const [line] = await withTenant(tenantId, (tx) =>
      tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.id, poLineId)));
    expect(line?.qtyReceived).toBe("4.000");

    const [po] = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)));
    expect(po?.status).toBe("partially_received");
  });

  it("a second receipt brings the line to ordered qty, the PO to received, and creates a second lot", async () => {
    const { tenantId, actor, itemId, poId, poLineId } = await seedSentPo();
    await postReceipt(actor, poId, { lines: [receiptLine(poLineId)] });
    await postReceipt(actor, poId, { lines: [receiptLine(poLineId, { receivedQty: 6 })] });

    const lots = await withTenant(tenantId, (tx) => tx.select().from(inventoryLots).where(eq(inventoryLots.itemId, itemId)));
    expect(lots).toHaveLength(2);

    const [line] = await withTenant(tenantId, (tx) =>
      tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.id, poLineId)));
    expect(line?.qtyReceived).toBe("10.000");

    const [po] = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)));
    expect(po?.status).toBe("received");
  });

  it("converts via the item's purchaseToBase factor (2 cases x 24 = 48 base units)", async () => {
    const seeded = await seedSentPo("24");
    await postReceipt(seeded.actor, seeded.poId, {
      lines: [{ poLineId: seeded.poLineId, receivedQty: 2, uom: "each", unitCost: 50 }],
    });

    const lots = await withTenant(seeded.tenantId, (tx) =>
      tx.select().from(inventoryLots).where(eq(inventoryLots.itemId, seeded.itemId)));
    expect(lots).toHaveLength(1);
    expect(lots[0]?.qtyRemaining).toBe("48.000");
  });

  it("allows over-receipt beyond the ordered qty", async () => {
    const { tenantId, actor, poId, poLineId } = await seedSentPo();
    await postReceipt(actor, poId, { lines: [receiptLine(poLineId, { receivedQty: 12 })] });

    const [line] = await withTenant(tenantId, (tx) =>
      tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.id, poLineId)));
    expect(line?.qtyReceived).toBe("12.000");

    const [po] = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)));
    expect(po?.status).toBe("received");
  });

  it("rejects receiving against a draft or cancelled PO", async () => {
    const { tenantId, branchId, actor, supplierId, itemId } = await seedSentPo();
    const { poId: draftPoId } = await createDraftPo(actor, {
      supplierId, branchId,
      lines: [{ itemId, qtyOrdered: 10, uom: "each", unitCost: 5 }],
    });
    const [draftLine] = await withTenant(tenantId, (tx) =>
      tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, draftPoId)));
    await expect(postReceipt(actor, draftPoId, { lines: [receiptLine(draftLine!.id)] }))
      .rejects.toThrow(InvalidPoTransitionError);

    const { poId: cancelledPoId } = await createDraftPo(actor, {
      supplierId, branchId,
      lines: [{ itemId, qtyOrdered: 10, uom: "each", unitCost: 5 }],
    });
    await withTenant(tenantId, (tx) =>
      tx.update(purchaseOrders).set({ status: "cancelled" }).where(eq(purchaseOrders.id, cancelledPoId)));
    const [cancelledLine] = await withTenant(tenantId, (tx) =>
      tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, cancelledPoId)));
    await expect(postReceipt(actor, cancelledPoId, { lines: [receiptLine(cancelledLine!.id)] }))
      .rejects.toThrow(InvalidPoTransitionError);
  });

  it("throws PoNotFoundError for an unknown poLineId", async () => {
    const { actor, poId } = await seedSentPo();
    await expect(postReceipt(actor, poId, {
      lines: [{ poLineId: "00000000-0000-0000-0000-000000000000", receivedQty: 1, uom: "each", unitCost: 1 }],
    })).rejects.toThrow(PoNotFoundError);
  });

  it("is atomic: a failing line rolls back the whole receipt", async () => {
    const { tenantId, actor, supplierId, branchId } = await seedSentPo();
    const itemA = await seedItem(tenantId, { baseUom: "each" });
    const itemB = await seedItem(tenantId, { baseUom: "each" });
    const { poId } = await createDraftPo(actor, {
      supplierId, branchId,
      lines: [
        { itemId: itemA, qtyOrdered: 10, uom: "each", unitCost: 5 },
        { itemId: itemB, qtyOrdered: 10, uom: "each", unitCost: 5 },
      ],
    });
    await withTenant(tenantId, (tx) =>
      tx.update(purchaseOrders).set({ status: "sent" }).where(eq(purchaseOrders.id, poId)));
    const lines = await withTenant(tenantId, (tx) =>
      tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, poId)));

    await expect(postReceipt(actor, poId, {
      lines: [
        { poLineId: lines[0]!.id, receivedQty: 4, uom: "each", unitCost: 5 },
        // Line 2 uses a sellable-only UoM the stockable boundary rejects.
        { poLineId: lines[1]!.id, receivedQty: 1, uom: "m", unitCost: 5 },
      ],
    })).rejects.toThrow(DimensionalUomError);

    // Nothing survived the rollback.
    const lotsA = await withTenant(tenantId, (tx) => tx.select().from(inventoryLots).where(eq(inventoryLots.itemId, itemA)));
    const lotsB = await withTenant(tenantId, (tx) => tx.select().from(inventoryLots).where(eq(inventoryLots.itemId, itemB)));
    expect(lotsA).toHaveLength(0);
    expect(lotsB).toHaveLength(0);

    const receipts = await withTenant(tenantId, (tx) => tx.select().from(poReceipts).where(eq(poReceipts.purchaseOrderId, poId)));
    expect(receipts).toHaveLength(0);

    const [firstLine] = await withTenant(tenantId, (tx) =>
      tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.id, lines[0]!.id)));
    expect(firstLine?.qtyReceived).toBe("0");
  });

  it("emits one po.received audit event per receipt and keeps the chain verifiable", async () => {
    const { tenantId, actor, poId, poLineId } = await seedSentPo();
    await postReceipt(actor, poId, { lines: [receiptLine(poLineId)] });
    await postReceipt(actor, poId, { lines: [receiptLine(poLineId, { receivedQty: 6 })] });

    const events = await withTenant(tenantId, (tx) => tx.select().from(auditEvents)
      .where(and(eq(auditEvents.action, "po.received"), eq(auditEvents.entityId, poId))));
    expect(events).toHaveLength(2);
    expect((await verifyChain(tenantId)).ok).toBe(true);
  });

  it("serializes a receipt that commits mid-flight — no lost qtyReceived, final status received (FOR UPDATE)", async () => {
    // PO ordered 10. A competing receipt commits 5 received while our receipt is
    // in flight. Under READ COMMITTED a plain read sees qty_received=0, our bump
    // then overwrites the rival's 5 with 0+5=5 (lost update), and the status
    // recompute sums 5 → "partially_received" instead of "received".
    //
    // The rival holds the PO row with FOR SHARE: compatible with the po_receipts
    // FK's FOR KEY SHARE (so we are NOT incidentally serialized at the INSERT),
    // but in conflict with the FOR UPDATE postReceipt takes as its first
    // statement. That lock is the serialization point: our receipt blocks until
    // the rival commits, then re-reads the fresh line (5) and bumps to 10 →
    // "received". Without it we only block at the line UPDATE (already past the
    // stale read) and persist 5. Same forcing pattern as shifts.test.ts:290.
    const { tenantId, actor, poId, poLineId } = await seedSentPo();

    const rival = await pool.connect();
    try {
      await rival.query("BEGIN");
      await rival.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      // A competing receipt writes 5 received to the line but has not committed.
      await rival.query(
        `UPDATE purchase_order_lines SET qty_received = '5.000' WHERE id = $1`,
        [poLineId],
      );
      // Hold the PO row with FOR SHARE only. Updating the PO status would take
      // FOR NO KEY UPDATE, which blocks our FK insert and hides the race we're
      // testing — this is the minimal lock that still serializes on FOR UPDATE.
      await rival.query(
        "SELECT id FROM purchase_orders WHERE id = $1 FOR SHARE",
        [poId],
      );

      const ours = postReceipt(actor, poId, { lines: [receiptLine(poLineId, { receivedQty: 5 })] });

      // Wait until our receipt is genuinely blocked on the rival's row lock. A
      // blocked FOR UPDATE surfaces as a `transactionid` wait; match it against
      // the rival's own transaction id (via the xid8 `transactionid` column, not
      // the oid `objid` which truncates once xids grow past 2^32). Other test
      // files' in-flight locks can't match, so the rival COMMITs only once we
      // are provably stuck on ITS transaction.
      const { rows: rivalXidRows } = await rival.query<{ xid: string }>("SELECT pg_current_xact_id()::text AS xid");
      const rivalXid = rivalXidRows[0].xid;
      let blocked = false;
      for (let i = 0; i < 200 && !blocked; i++) {
        const { rows } = await rival.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks
           WHERE NOT granted AND locktype = 'transactionid' AND transactionid::text = $1`,
          [rivalXid],
        );
        blocked = rows[0].n > 0;
        if (!blocked) await new Promise((r) => setTimeout(r, 25));
      }
      expect(blocked).toBe(true);

      await rival.query("COMMIT");
      await ours;
    } finally {
      rival.release();
    }

    const [line] = await withTenant(tenantId, (tx) =>
      tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.id, poLineId)));
    expect(line?.qtyReceived).toBe("10.000");

    const [po] = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)));
    expect(po?.status).toBe("received");
  });
});
