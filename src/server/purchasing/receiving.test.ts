import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, pool } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { users } from "@/server/auth/schema";
import { seedInventoryTenant, seedItem } from "@/server/inventory/test-helpers";
import { inventoryItems, inventoryLots, stockLedger } from "@/server/inventory/schema";
import { DimensionalUomError } from "@/server/inventory/errors";
import type { Uom } from "@/server/inventory/uom";
import { verifyChain } from "@/server/audit/verifier";
import { auditEvents } from "@/server/audit/schema";
import { purchaseOrders, purchaseOrderLines, poReceipts, poReceiptLines } from "./schema";
import type { PurchasingActor } from "./suppliers";
import { createSupplier } from "./suppliers";
import { createDraftPo } from "./service";
import { postReceipt } from "./receiving";
import { getPoVariance } from "./variance";
import { InvalidPoInputError, InvalidPoTransitionError, PoNotFoundError, ReceiptUomMismatchError } from "./errors";

async function seedActor(tenantId: string, branchId: string): Promise<PurchasingActor> {
  const [user] = await db.insert(users).values({
    tenantId, name: "Receiver", email: `rec-${crypto.randomUUID().slice(0, 8)}@x.com`, status: "active",
  }).returning({ id: users.id });
  return { tenantId, branchId, actorUserId: user.id, vertical: "restaurant" as const };
}

/** A supplier + one item, and a `sent` PO for 10 of it at 5.00. */
async function seedSentPo(opts: { purchaseToBase?: string; baseUom?: Uom; purchaseUom?: Uom; orderUom?: Uom } = {}) {
  const { purchaseToBase = "1", baseUom = "each", purchaseUom = baseUom, orderUom = baseUom } = opts;
  const { tenantId, branchId } = await seedInventoryTenant();
  const actor = await seedActor(tenantId, branchId);
  const supplierId = await createSupplier(actor, { name: "Sup", email: "sup@x.com" });
  const itemId = await seedItem(tenantId, { baseUom, purchaseUom });
  if (purchaseToBase !== "1") {
    await withTenant(tenantId, (tx) =>
      tx.update(inventoryItems).set({ purchaseToBase }).where(eq(inventoryItems.id, itemId)));
  }
  const { poId } = await createDraftPo(actor, {
    supplierId, branchId,
    lines: [{ itemId, qtyOrdered: 10, uom: orderUom, unitCost: 5 }],
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
    const seeded = await seedSentPo({ purchaseToBase: "24" });
    await postReceipt(seeded.actor, seeded.poId, {
      lines: [{ poLineId: seeded.poLineId, receivedQty: 2, uom: "each", unitCost: 50 }],
    });

    const lots = await withTenant(seeded.tenantId, (tx) =>
      tx.select().from(inventoryLots).where(eq(inventoryLots.itemId, seeded.itemId)));
    expect(lots).toHaveLength(1);
    expect(lots[0]?.qtyRemaining).toBe("48.000");
    // C1: the unit cost must be per BASE unit, not per receipt unit. It must
    // also be EXACT, not a 2dp money() rounding: 2 cases @ 50.00 = 100.00
    // across 48 cans is 2.0833… per can — rounding to 2.08 would make the lot
    // value 99.84 against the 100.00 actually paid, wedging this report from
    // getPoVariance's sum.
    expect(Number(lots[0]?.unitCost)).toBeCloseTo(2.0833333333333335, 12);
  });

  it("rejects a receipt line whose uom differs from the PO line's uom", async () => {
    // Base g, ordered in kg. Posting a receipt in g would silently re-scale by
    // purchaseToBase again (500 g × 1000 = 500000) instead of matching the order.
    const seeded = await seedSentPo({ purchaseToBase: "1000", baseUom: "g", orderUom: "kg" });

    await expect(postReceipt(seeded.actor, seeded.poId, {
      lines: [{ poLineId: seeded.poLineId, receivedQty: 500, uom: "g", unitCost: 5 }],
    })).rejects.toThrow(ReceiptUomMismatchError);

    const lots = await withTenant(seeded.tenantId, (tx) =>
      tx.select().from(inventoryLots).where(eq(inventoryLots.itemId, seeded.itemId)));
    expect(lots).toHaveLength(0);
  });

  it("never applies purchaseToBase to a unit other than the item's purchaseUom (over-credit)", async () => {
    // Base g, purchaseUom kg, factor 1000 — but the order AND receipt are both
    // in g. Both fields agree with each other, so the UoM-mismatch guard passes;
    // the purchase factor is still wrong to apply here (500 g × 1000 = 500000
    // instead of 500). The factor only ever applies to the declared purchase
    // unit; anything else converts dimensionally.
    const seeded = await seedSentPo({
      purchaseToBase: "1000", baseUom: "g", purchaseUom: "kg", orderUom: "g",
    });

    const { status } = await postReceipt(seeded.actor, seeded.poId, {
      lines: [{ poLineId: seeded.poLineId, receivedQty: 500, uom: "g", unitCost: 5 }],
    });
    expect(status).toBe("received");

    const lots = await withTenant(seeded.tenantId, (tx) =>
      tx.select().from(inventoryLots).where(eq(inventoryLots.itemId, seeded.itemId)));
    expect(lots).toHaveLength(1);
    // Dimensionally: 500 g → 500 base g, NOT 500 × 1000.
    expect(lots[0]?.qtyRemaining).toBe("500.000");

    const [line] = await withTenant(seeded.tenantId, (tx) =>
      tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.id, seeded.poLineId)));
    expect(line?.qtyReceived).toBe("500.000");
  });

  it("rejects a receipt that converts to zero base units (ledger-poisoning denominator)", async () => {
    // Sub-milli quantities clear the receivedQty > 0 guard but round to a zero
    // baseQty, which would make the per-base-unit cost Infinity → "Infinity" in
    // numeric → NaN in every SUM. That is the exact ledger poison the NaN guard
    // was written to remove.
    const seeded = await seedSentPo({ baseUom: "g", purchaseUom: "g" });
    await expect(postReceipt(seeded.actor, seeded.poId, {
      lines: [{ poLineId: seeded.poLineId, receivedQty: 0.0004, uom: "g", unitCost: 5 }],
    })).rejects.toThrow(InvalidPoInputError);

    const lots = await withTenant(seeded.tenantId, (tx) =>
      tx.select().from(inventoryLots).where(eq(inventoryLots.itemId, seeded.itemId)));
    expect(lots).toHaveLength(0);
  });

  it("rejects a negative unitCost", async () => {
    const seeded = await seedSentPo();
    await expect(postReceipt(seeded.actor, seeded.poId, {
      lines: [{ poLineId: seeded.poLineId, receivedQty: 4, uom: "each", unitCost: -100 }],
    })).rejects.toThrow(InvalidPoInputError);
  });

  it("two receipt lines for the same poLineId accumulate, not last-write-wins", async () => {
    const { tenantId, actor, poId, poLineId } = await seedSentPo();
    await postReceipt(actor, poId, {
      lines: [receiptLine(poLineId), receiptLine(poLineId, { receivedQty: 6 })],
    });

    const [line] = await withTenant(tenantId, (tx) =>
      tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.id, poLineId)));
    expect(line?.qtyReceived).toBe("10.000");

    const [po] = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)));
    expect(po?.status).toBe("received");

    const [receipt] = await withTenant(tenantId, (tx) =>
      tx.select().from(poReceipts).where(eq(poReceipts.purchaseOrderId, poId)));
    const lines = await withTenant(tenantId, (tx) =>
      tx.select().from(poReceiptLines).where(eq(poReceiptLines.poReceiptId, receipt!.id)));
    expect(lines).toHaveLength(2);
  });

  it("rejects non-finite / non-positive quantities and non-finite unit costs", async () => {
    const { actor, poId, poLineId } = await seedSentPo();
    await expect(postReceipt(actor, poId, { lines: [receiptLine(poLineId, { receivedQty: Number.NaN })] }))
      .rejects.toThrow(InvalidPoInputError);
    await expect(postReceipt(actor, poId, { lines: [receiptLine(poLineId, { receivedQty: 0 })] }))
      .rejects.toThrow(InvalidPoInputError);
    await expect(postReceipt(actor, poId, { lines: [receiptLine(poLineId, { receivedQty: -1 })] }))
      .rejects.toThrow(InvalidPoInputError);
    await expect(postReceipt(actor, poId, { lines: [receiptLine(poLineId, { unitCost: Number.POSITIVE_INFINITY })] }))
      .rejects.toThrow(InvalidPoInputError);
    await expect(postReceipt(actor, poId, { lines: [receiptLine(poLineId, { unitCost: Number.NaN })] }))
      .rejects.toThrow(InvalidPoInputError);
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

  it("rejects a receipt whose cost overflows to a non-finite number", async () => {
    // receivedQty and unitCost are each finite, but their PRODUCT can overflow
    // to Infinity — and String(Infinity) is accepted by Postgres numeric, so the
    // same un-correctable ledger poison arrives through the quotient instead.
    const seeded = await seedSentPo({ baseUom: "g", purchaseUom: "g", orderUom: "g" });
    await expect(postReceipt(seeded.actor, seeded.poId, {
      lines: [{ poLineId: seeded.poLineId, receivedQty: 1e300, uom: "g", unitCost: 1e300 }],
    })).rejects.toThrow(InvalidPoInputError);

    const lots = await withTenant(seeded.tenantId, (tx) =>
      tx.select().from(inventoryLots).where(eq(inventoryLots.itemId, seeded.itemId)));
    expect(lots).toHaveLength(0);
  });

  it("rejects an item that declares a purchase factor against its own base unit", async () => {
    // purchaseUom === baseUom with a factor other than 1 is contradictory for
    // mass/volume, and applying it silently over-credits by that factor. (For
    // `count` it is legitimate — that is how a 24-can case is expressed — so the
    // guard is scoped to non-count dimensions.)
    const seeded = await seedSentPo({ purchaseToBase: "1000", baseUom: "g", purchaseUom: "g", orderUom: "g" });
    await expect(postReceipt(seeded.actor, seeded.poId, {
      lines: [{ poLineId: seeded.poLineId, receivedQty: 500, uom: "g", unitCost: 5 }],
    })).rejects.toThrow(InvalidPoInputError);
  });

  it("still applies a count-dimension pack factor (24-can case)", async () => {
    const seeded = await seedSentPo({ purchaseToBase: "24", baseUom: "each", purchaseUom: "each", orderUom: "each" });
    await postReceipt(seeded.actor, seeded.poId, {
      lines: [{ poLineId: seeded.poLineId, receivedQty: 2, uom: "each", unitCost: 50 }],
    });
    const lots = await withTenant(seeded.tenantId, (tx) =>
      tx.select().from(inventoryLots).where(eq(inventoryLots.itemId, seeded.itemId)));
    expect(lots[0]?.qtyRemaining).toBe("48.000");
    // 100.00 paid across 48 base units, stored exactly rather than rounded to 2dp.
    expect(Number(lots[0]?.unitCost) * 48).toBeCloseTo(100, 10);
  });

  it("defaults unitCost from poLine when omitted and computes non-zero receivedTotal in variance", async () => {
    // PO was created for 10 @ 5.00 (= 50.00 ordered)
    const seeded = await seedSentPo();
    const { status } = await postReceipt(seeded.actor, seeded.poId, {
      lines: [{ poLineId: seeded.poLineId, receivedQty: 10, uom: "each" }],
    });
    expect(status).toBe("received");

    const lots = await withTenant(seeded.tenantId, (tx) =>
      tx.select().from(inventoryLots).where(eq(inventoryLots.itemId, seeded.itemId)));
    expect(lots).toHaveLength(1);
    expect(Number(lots[0]?.unitCost)).toBe(5);

    const variance = await getPoVariance(seeded.tenantId, seeded.poId);
    expect(variance.receivedTotal).toBe("50.00");
    expect(variance.total).toBe("50.00");
    expect(variance.receivedVsOrdered).toBe("0.00");
  });
});
