import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { users } from "@/server/auth/schema";
import { seedInventoryTenant, seedItem } from "@/server/inventory/test-helpers";
import { inventoryLots, stockLedger } from "@/server/inventory/schema";
import { DimensionalUomError } from "@/server/inventory/errors";
import { verifyChain } from "@/server/audit/verifier";
import { auditEvents } from "@/server/audit/schema";
import { purchaseOrders, purchaseOrderLines } from "./schema";
import { createSupplier } from "./suppliers";
import { createDraftPo, updateDraftPo, cancelPurchaseOrder, getPurchaseOrder, type DraftPoLineInput } from "./service";
import { postReceipt } from "./receiving";
import { sendPurchaseOrder } from "./send";
import { enterInvoiceTotal, getPoVariance, closePurchaseOrder } from "./variance";
import { InvalidPoTransitionError } from "./errors";

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

  it("getPurchaseOrder returns null for an unknown PO", async () => {
    const { tenantId } = await seedInventoryTenant();
    expect(await getPurchaseOrder(tenantId, "00000000-0000-0000-0000-000000000000")).toBeNull();
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

    // two partial receipts → two lots, one receive ledger row each
    const [poLine] = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, poId)));
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
});
