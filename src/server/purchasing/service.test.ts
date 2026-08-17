import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, pool } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { users } from "@/server/auth/schema";
import { seedInventoryTenant, seedItem } from "@/server/inventory/test-helpers";
import { inventoryLots, stockLedger } from "@/server/inventory/schema";
import { DimensionalUomError } from "@/server/inventory/errors";
import { verifyChain } from "@/server/audit/verifier";
import { auditEvents } from "@/server/audit/schema";
import { purchaseOrders, purchaseOrderLines } from "./schema";
import { createSupplier } from "./suppliers";
import { createDraftPo, updateDraftPo, cancelPurchaseOrder, getPurchaseOrder, listPurchaseOrders, type DraftPoLineInput } from "./service";
import { postReceipt } from "./receiving";
import { sendPurchaseOrder } from "./send";
import { enterInvoiceTotal, getPoVariance, closePurchaseOrder } from "./variance";
import { InvalidPoInputError, InvalidPoTransitionError } from "./errors";

async function seedActor(tenantId: string, branchId: string) {
  const [user] = await db.insert(users).values({
    tenantId, name: "Owner", email: `own-${crypto.randomUUID().slice(0, 8)}@x.com`, status: "active",
  }).returning({ id: users.id });
  return { tenantId, branchId, actorUserId: user.id, vertical: "restaurant" as const };
}

async function seedSupplier(tenantId: string, branchId: string): Promise<string> {
  const actor = await seedActor(tenantId, branchId);
  return createSupplier(actor, { name: "Supplier" });
}

function line(itemId: string, over: Partial<DraftPoLineInput> = {}): DraftPoLineInput {
  return { itemId, qtyOrdered: 10, uom: "each", unitCost: 5, ...over };
}

describe("purchase order drafting", () => {
  it("createDraftPo assigns poNumber 1 then 2 for the same tenant and computes total", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const actor = await seedActor(tenantId, branchId);
    const supplierId = await seedSupplier(tenantId, branchId);
    const itemId = await seedItem(tenantId, { baseUom: "each" });

    const one = await createDraftPo(actor, {
      supplierId, branchId, lines: [line(itemId)],
    });
    const two = await createDraftPo(actor, {
      supplierId, branchId, lines: [line(itemId, { qtyOrdered: 3, unitCost: 2.5 })],
    });

    expect(one.poNumber).toBe(1);
    expect(two.poNumber).toBe(2);

    const [po] = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, one.poId)));
    expect(po?.status).toBe("draft");
    expect(po?.total).toBe("50.00");

    const lines = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, one.poId)));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.qtyReceived).toBe("0");
  });

  it("rejects a non-inventory UoM at the boundary", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const actor = await seedActor(tenantId, branchId);
    const supplierId = await seedSupplier(tenantId, branchId);
    const itemId = await seedItem(tenantId, { baseUom: "each" });

    await expect(createDraftPo(actor, {
      supplierId, branchId,
      lines: [{ itemId, qtyOrdered: 1, uom: "m", unitCost: 5 }],
    })).rejects.toThrow(DimensionalUomError);
  });

  it("getPurchaseOrder returns the PO", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const actor = await seedActor(tenantId, branchId);
    const supplierId = await seedSupplier(tenantId, branchId);
    const itemId = await seedItem(tenantId, { baseUom: "each" });

    const { poId } = await createDraftPo(actor, { supplierId, branchId, lines: [line(itemId)] });
    const po = await getPurchaseOrder(tenantId, poId);
    expect(po?.id).toBe(poId);
    expect(po?.poNumber).toBe(1);
  });

  it("updateDraftPo replaces lines and recomputes total while draft", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const actor = await seedActor(tenantId, branchId);
    const supplierId = await seedSupplier(tenantId, branchId);
    const itemA = await seedItem(tenantId, { baseUom: "each" });
    const itemB = await seedItem(tenantId, { baseUom: "each" });

    const { poId } = await createDraftPo(actor, { supplierId, branchId, lines: [line(itemA)] });

    await updateDraftPo(actor, poId, {
      supplierId, branchId,
      lines: [line(itemA), line(itemB, { qtyOrdered: 2, unitCost: 7 })],
    });

    const lines = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, poId)));
    expect(lines).toHaveLength(2);
    const [po] = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)));
    expect(po?.total).toBe("64.00"); // 10Ã—5 + 2Ã—7
  });

  it("editing a sent PO throws InvalidPoTransitionError", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const actor = await seedActor(tenantId, branchId);
    const supplierId = await seedSupplier(tenantId, branchId);
    const itemId = await seedItem(tenantId, { baseUom: "each" });

    const { poId } = await createDraftPo(actor, { supplierId, branchId, lines: [line(itemId)] });
    await withTenant(tenantId, (tx) =>
      tx.update(purchaseOrders).set({ status: "sent" }).where(eq(purchaseOrders.id, poId)));

    await expect(updateDraftPo(actor, poId, { supplierId, branchId, lines: [line(itemId)] }))
      .rejects.toThrow(InvalidPoTransitionError);
  });

  it("cancelPurchaseOrder moves a draft PO to cancelled and audits po.cancelled", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const actor = await seedActor(tenantId, branchId);
    const supplierId = await seedSupplier(tenantId, branchId);
    const itemId = await seedItem(tenantId, { baseUom: "each" });

    const { poId } = await createDraftPo(actor, { supplierId, branchId, lines: [line(itemId)] });
    await cancelPurchaseOrder(actor, poId);

    const [po] = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)));
    expect(po?.status).toBe("cancelled");

    const events = await withTenant(tenantId, (tx) => tx.select().from(auditEvents)
      .where(and(eq(auditEvents.action, "po.cancelled"), eq(auditEvents.entityId, poId))));
    expect(events).toHaveLength(1);
    expect((await verifyChain(tenantId)).ok).toBe(true);
  });

  it("cancelling a partially_received PO throws", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const actor = await seedActor(tenantId, branchId);
    const supplierId = await seedSupplier(tenantId, branchId);
    const itemId = await seedItem(tenantId, { baseUom: "each" });

    const { poId } = await createDraftPo(actor, { supplierId, branchId, lines: [line(itemId)] });
    await withTenant(tenantId, (tx) =>
      tx.update(purchaseOrders).set({ status: "partially_received" }).where(eq(purchaseOrders.id, poId)));

    await expect(cancelPurchaseOrder(actor, poId)).rejects.toThrow(InvalidPoTransitionError);
  });

  it("rejects a body-supplied branchId/supplierId from another tenant (I13)", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const actor = await seedActor(tenantId, branchId);
    const itemId = await seedItem(tenantId, { baseUom: "each" });
    const supplierId = await seedSupplier(tenantId, branchId);

    // Another tenant's branch + supplier, both invisible under tenant A's RLS.
    const other = await seedInventoryTenant();
    const otherActor = await seedActor(other.tenantId, other.branchId);
    const otherSupplierId = await seedSupplier(other.tenantId, other.branchId);

    await expect(createDraftPo(actor, { supplierId, branchId: other.branchId, lines: [line(itemId)] }))
      .rejects.toThrow(InvalidPoInputError);
    await expect(createDraftPo(actor, { supplierId: otherSupplierId, branchId, lines: [line(itemId)] }))
      .rejects.toThrow(InvalidPoInputError);
    // Same guards on the update path.
    const { poId } = await createDraftPo(actor, { supplierId, branchId, lines: [line(itemId)] });
    await expect(updateDraftPo(actor, poId, { supplierId: otherSupplierId, branchId, lines: [line(itemId)] }))
      .rejects.toThrow(InvalidPoInputError);
    void otherActor;
  });

  it("a po.created audit event exists after drafting, and the chain stays verifiable", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const actor = await seedActor(tenantId, branchId);
    const supplierId = await seedSupplier(tenantId, branchId);
    const itemId = await seedItem(tenantId, { baseUom: "each" });

    const { poId } = await createDraftPo(actor, { supplierId, branchId, lines: [line(itemId)] });

    const events = await withTenant(tenantId, (tx) => tx.select().from(auditEvents)
      .where(and(eq(auditEvents.action, "po.created"), eq(auditEvents.entityId, poId))));
    expect(events).toHaveLength(1);
    expect((await verifyChain(tenantId)).ok).toBe(true);
  });

  it("two concurrent createDraftPo calls yield poNumber 1 and 2, never a duplicate", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const actor = await seedActor(tenantId, branchId);
    const supplierId = await seedSupplier(tenantId, branchId);
    const itemId = await seedItem(tenantId, { baseUom: "each" });

    const results = await Promise.allSettled([
      createDraftPo(actor, { supplierId, branchId, lines: [line(itemId)] }),
      createDraftPo(actor, { supplierId, branchId, lines: [line(itemId)] }),
    ]);
    const ok = results.filter((r): r is PromiseFulfilledResult<{ poId: string; poNumber: number }> => r.status === "fulfilled");
    expect(ok.length).toBe(2);
    expect(ok.map((r) => r.value.poNumber).sort()).toEqual([1, 2]);
  });

  // `taxRate` is a FRACTION (0.14), but this codebase also carries a PERCENTAGE
  // convention under a near-identical name — getVatRate returns 14, not 0.14.
  // Nothing bounded the field, so a caller reading "tax rate" and passing 14
  // silently ordered 10 x 5.00 as 750.00, stored it, and emailed it to the
  // supplier as the amount to bill.
  it("rejects a taxRate expressed as a percentage instead of a fraction", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const actor = await seedActor(tenantId, branchId);
    const supplierId = await seedSupplier(tenantId, branchId);
    const itemId = await seedItem(tenantId, { baseUom: "each" });

    await expect(createDraftPo(actor, {
      supplierId, branchId, lines: [line(itemId, { taxRate: 14 })],
    })).rejects.toBeInstanceOf(InvalidPoInputError);

    // The fraction form is still accepted, at the boundary too.
    const ok = await createDraftPo(actor, {
      supplierId, branchId, lines: [line(itemId, { taxRate: 0.14 })],
    });
    expect(ok.poNumber).toBeGreaterThan(0);
  });

  it("getPurchaseOrder returns null for an unknown PO", async () => {
    const { tenantId } = await seedInventoryTenant();
    expect(await getPurchaseOrder(tenantId, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  // Without this, `poLineId` is unobtainable through any service or route, so
  // POST /purchase-orders/:id/receipts cannot be called by ANY client — the
  // acceptance walk below has to reach into purchase_order_lines directly.
  it("getPurchaseOrder returns the PO's lines, so a receipt can name a poLineId", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const actor = await seedActor(tenantId, branchId);
    const supplierId = await createSupplier(actor, { name: "Supplier", email: "s@x.com" });
    const itemId = await seedItem(tenantId, { baseUom: "each", nameEn: "Tomatoes" });

    const { poId } = await createDraftPo(actor, { supplierId, branchId, lines: [line(itemId)] });
    const po = await getPurchaseOrder(tenantId, poId);

    expect(po?.lines).toHaveLength(1);
    expect(po?.lines[0].itemId).toBe(itemId);
    expect(po?.lines[0].itemNameEn).toBe("Tomatoes");
    expect(po?.lines[0].qtyOrdered).toBe("10.000");
    expect(po?.lines[0].id).toEqual(expect.any(String));
    // A receipt posted with ONLY what the read path returned must succeed.
    await sendPurchaseOrder(actor, poId);
    const posted = await postReceipt(actor, poId, {
      lines: [{ poLineId: po!.lines[0].id, receivedQty: 10, uom: "each", unitCost: 5 }],
    });
    expect(posted.status).toBe("received");
  });

  it("getPurchaseOrder returns receipts posted against the PO", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const actor = await seedActor(tenantId, branchId);
    const supplierId = await createSupplier(actor, { name: "Supplier", email: "s@x.com" });
    const itemId = await seedItem(tenantId, { baseUom: "each" });

    const { poId } = await createDraftPo(actor, { supplierId, branchId, lines: [line(itemId)] });
    await sendPurchaseOrder(actor, poId);
    const before = await getPurchaseOrder(tenantId, poId);
    expect(before?.receipts).toHaveLength(0);

    const po = await getPurchaseOrder(tenantId, poId);
    await postReceipt(actor, poId, {
      lines: [{ poLineId: po!.lines[0].id, receivedQty: 4, uom: "each", unitCost: 5 }],
      supplierDeliveryNote: "DN-7",
    });

    const after = await getPurchaseOrder(tenantId, poId);
    expect(after?.receipts).toHaveLength(1);
    expect(after?.receipts[0].supplierDeliveryNote).toBe("DN-7");
    expect(after?.lines[0].qtyReceived).toBe("4.000");
  });

  it("acceptance walk: draft → sent → two partial receipts (lots + ledger) → invoiced → variance → closed, with po.* audit on every step", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const actor = await seedActor(tenantId, branchId);
    const supplierId = await createSupplier(actor, { name: "Acme Foods", email: "sup@x.com" });
    const itemId = await seedItem(tenantId, { baseUom: "each" });

    // draft
    const { poId, poNumber } = await createDraftPo(actor, {
      supplierId, branchId, lines: [line(itemId)], // 10 × 5 = 50.00
    });
    expect(poNumber).toBe(1);

    // sent — outbox email + status flip
    await sendPurchaseOrder(actor, poId);
    let [po] = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)));
    expect(po?.status).toBe("sent");

    // two partial receipts → two lots, one receive ledger row each.
    // The poLineId comes from the PUBLIC read path, not a raw table read — this
    // walk must be reproducible by any API client, not only by the test suite.
    const [poLine] = (await getPurchaseOrder(tenantId, poId))!.lines;
    const first = await postReceipt(actor, poId, { lines: [{ poLineId: poLine!.id, receivedQty: 4, uom: "each", unitCost: 5 }] });
    expect(first.status).toBe("partially_received");
    const second = await postReceipt(actor, poId, { lines: [{ poLineId: poLine!.id, receivedQty: 6, uom: "each", unitCost: 5 }] });
    expect(second.status).toBe("received");

    const lots = await withTenant(tenantId, (tx) => tx.select().from(inventoryLots).where(eq(inventoryLots.itemId, itemId)));
    expect(lots).toHaveLength(2);
    expect(lots.reduce((s, l) => s + Number(l.qtyRemaining), 0)).toBe(10);
    const ledger = await withTenant(tenantId, (tx) => tx.select().from(stockLedger)
      .where(and(eq(stockLedger.type, "receive"), eq(stockLedger.tenantId, tenantId))));
    expect(ledger).toHaveLength(2);

    // invoice + three-way variance
    await enterInvoiceTotal(actor, poId, 48);
    const variance = await getPoVariance(tenantId, poId);
    expect(variance.total).toBe("50.00");
    expect(variance.receivedTotal).toBe("50.00");
    expect(variance.invoiceTotal).toBe("48.00");
    expect(variance.invoiceVsReceived).toBe("-2.00");

    // close (only legal from received)
    await closePurchaseOrder(actor, poId);
    [po] = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)));
    expect(po?.status).toBe("closed");

    // po.* audit event per step, in order, chain intact
    const events = await withTenant(tenantId, (tx) => tx.select().from(auditEvents)
      .where(eq(auditEvents.entityId, poId)).orderBy(auditEvents.createdAt));
    const actions = events.map((e) => e.action);
    expect(actions).toContain("po.created");
    expect(actions).toContain("po.sent");
    expect(actions.filter((a) => a === "po.received")).toHaveLength(2);
    expect(actions).toContain("po.invoiced");
    expect(actions).toContain("po.closed");
    expect((await verifyChain(tenantId)).ok).toBe(true);
  });

  it("serializes a draft edit against a concurrent send — the edit fails, not the send (FOR UPDATE on loadPo)", async () => {
    // PO is drafted. A rival commits status=sent while our edit is in flight.
    // Under READ COMMITTED a plain loadPo read would see draft, and the edit
    // would land after the email went out (the review's C1 probe: status sent,
    // total 98901.00, qtyOrdered 999). loadPo's FOR UPDATE is the serialization
    // point: our edit blocks until the rival commits, then re-reads sent and
    // throws InvalidPoTransitionError. Same forcing pattern as receiving.test.ts.
    const { tenantId, branchId } = await seedInventoryTenant();
    const actor = await seedActor(tenantId, branchId);
    const supplierId = await seedSupplier(tenantId, branchId);
    const itemId = await seedItem(tenantId, { baseUom: "each" });
    const { poId } = await createDraftPo(actor, {
      supplierId, branchId,
      lines: [line(itemId)],
    });

    const rival = await pool.connect();
    try {
      await rival.query("BEGIN");
      await rival.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      // A competing send flips the header to sent but has not committed yet.
      // The UPDATE holds the row with FOR NO KEY UPDATE, which conflicts with
      // the FOR UPDATE our edit takes on loadPo — that lock is the serialization
      // point (a stray FOR SHARE would not conflict with a plain read, masking
      // the very race this test exists to prove).
      await rival.query(
        "UPDATE purchase_orders SET status = 'sent' WHERE id = $1",
        [poId],
      );

      const ours = updateDraftPo(actor, poId, {
        supplierId, branchId,
        lines: [line(itemId, { qtyOrdered: 999, unitCost: 99 })],
      });

      // Wait until our edit is genuinely blocked on the rival's row lock.
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
      await expect(ours).rejects.toThrow(InvalidPoTransitionError);
    } finally {
      rival.release();
    }

    // The edit never landed: total stayed at the draft's 50.00, qtyOrdered 10.
    const [po] = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)));
    expect(po?.status).toBe("sent");
    expect(po?.total).toBe("50.00");
    const [poLine] = await withTenant(tenantId, (tx) =>
      tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, poId)));
    expect(poLine?.qtyOrdered).toBe("10.000");
  });
});

describe("purchase order totals and input floor", () => {
  it("folds taxRate into the header total, and stores the rate unrounded", async () => {
    // invoiceTotal (what the supplier actually bills) is tax-inclusive, so a
    // tax-exclusive header made invoiceVsReceived report a variance on EVERY
    // tax-bearing PO — burying real discrepancies in structural noise.
    const { tenantId, branchId } = await seedInventoryTenant();
    const actor = await seedActor(tenantId, branchId);
    const supplierId = await seedSupplier(tenantId, branchId);
    const itemId = await seedItem(tenantId, { baseUom: "each" });

    const { poId } = await createDraftPo(actor, {
      supplierId, branchId,
      lines: [{ itemId, qtyOrdered: 10, uom: "each", unitCost: 5, taxRate: 0.14 }],
    });

    const po = await getPurchaseOrder(tenantId, poId);
    expect(po?.total).toBe("57.00");           // 10 x 5 x 1.14, not 50.00

    const [line] = await withTenant(tenantId, (tx) =>
      tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, poId)));
    // `money()` is a 2dp CURRENCY formatter; a rate is not currency and 12.5%
    // must not round to 13%.
    expect(Number(line?.taxRate)).toBe(0.14);
  });

  it("stores a fractional tax rate without rounding it to two decimals", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const actor = await seedActor(tenantId, branchId);
    const supplierId = await seedSupplier(tenantId, branchId);
    const itemId = await seedItem(tenantId, { baseUom: "each" });

    const { poId } = await createDraftPo(actor, {
      supplierId, branchId,
      lines: [{ itemId, qtyOrdered: 1, uom: "each", unitCost: 100, taxRate: 0.125 }],
    });
    const [line] = await withTenant(tenantId, (tx) =>
      tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, poId)));
    expect(Number(line?.taxRate)).toBe(0.125);  // money() would have stored 0.13
  });

  it("rejects non-finite and non-positive line numbers at the SERVICE boundary", async () => {
    // The routes validate too, but cron/scripts/tests call these directly.
    const { tenantId, branchId } = await seedInventoryTenant();
    const actor = await seedActor(tenantId, branchId);
    const supplierId = await seedSupplier(tenantId, branchId);
    const itemId = await seedItem(tenantId, { baseUom: "each" });
    const line = (over: Partial<DraftPoLineInput>): DraftPoLineInput =>
      ({ itemId, qtyOrdered: 1, uom: "each", unitCost: 1, ...over });

    for (const bad of [
      line({ qtyOrdered: Number.NaN }),
      line({ qtyOrdered: 0 }),
      line({ qtyOrdered: -1 }),
      line({ unitCost: Number.NaN }),
      line({ unitCost: -1 }),
      line({ taxRate: Number.NaN }),
    ]) {
      await expect(createDraftPo(actor, { supplierId, branchId, lines: [bad] }))
        .rejects.toBeInstanceOf(InvalidPoInputError);
    }
    await expect(createDraftPo(actor, { supplierId, branchId, lines: [] }))
      .rejects.toBeInstanceOf(InvalidPoInputError);

    // Nothing was written by any of the rejected attempts.
    const pos = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders));
    expect(pos).toHaveLength(0);
  });

  it("listPurchaseOrders returns supplierName joined from suppliers", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const actor = await seedActor(tenantId, branchId);
    const supplierId = await seedSupplier(tenantId, branchId);
    const itemId = await seedItem(tenantId, { baseUom: "each" });

    await createDraftPo(actor, { supplierId, branchId, lines: [line(itemId)] });
    const [po] = await listPurchaseOrders(tenantId);

    expect(po?.supplierName).toBe("Supplier");
  });
});

