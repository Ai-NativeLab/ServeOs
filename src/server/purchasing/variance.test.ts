import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { users } from "@/server/auth/schema";
import { seedInventoryTenant, seedItem } from "@/server/inventory/test-helpers";
import { verifyChain } from "@/server/audit/verifier";
import { auditEvents } from "@/server/audit/schema";
import { purchaseOrders, purchaseOrderLines } from "./schema";
import { createSupplier } from "./suppliers";
import { createDraftPo } from "./service";
import { postReceipt } from "./receiving";
import { getPoVariance, enterInvoiceTotal, closePurchaseOrder } from "./variance";
import { InvalidPoInputError, InvalidPoTransitionError } from "./errors";
import type { PurchasingActor } from "./suppliers";

async function seedActor(tenantId: string, branchId: string): Promise<PurchasingActor> {
  const [user] = await db.insert(users).values({
    tenantId, name: "Owner", email: `own-${crypto.randomUUID().slice(0, 8)}@x.com`, status: "active",
  }).returning({ id: users.id });
  return { tenantId, branchId, actorUserId: user.id, vertical: "restaurant" as const };
}

/** A `sent` PO for `qtyOrdered` of an item at `unitCost` each. */
async function seedSentPo(qtyOrdered = 10, unitCost = 5) {
  const { tenantId, branchId } = await seedInventoryTenant();
  const actor = await seedActor(tenantId, branchId);
  const supplierId = await createSupplier(actor, { name: "Sup" });
  const itemId = await seedItem(tenantId, { baseUom: "each" });
  const { poId } = await createDraftPo(actor, {
    supplierId, branchId,
    lines: [{ itemId, qtyOrdered, uom: "each", unitCost }],
  });
  await withTenant(tenantId, (tx) =>
    tx.update(purchaseOrders).set({ status: "sent" }).where(eq(purchaseOrders.id, poId)));
  const [poLine] = await withTenant(tenantId, (tx) =>
    tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, poId)));
  return { tenantId, branchId, actor, supplierId, itemId, poId, poLineId: poLine!.id };
}

describe("purchase order variance", () => {
  it("three-way variance: received below ordered, invoiced above received", async () => {
    const { tenantId, actor, poId, poLineId } = await seedSentPo(10, 10); // total 100.00
    await postReceipt(actor, poId, { lines: [{ poLineId, receivedQty: 9, uom: "each", unitCost: 10 }] });
    await enterInvoiceTotal(actor, poId, 95);

    const v = await getPoVariance(tenantId, poId);
    expect(v.total).toBe("100.00");
    expect(v.receivedTotal).toBe("90.00");
    expect(v.invoiceTotal).toBe("95.00");
    expect(v.receivedVsOrdered).toBe("-10.00");
    expect(v.invoiceVsReceived).toBe("5.00");
    expect(v.overReceived).toBe(false);
  });

  it("over-receipt flags overReceived and reports a positive receivedVsOrdered", async () => {
    const { tenantId, actor, poId, poLineId } = await seedSentPo(10, 10); // total 100.00
    await postReceipt(actor, poId, { lines: [{ poLineId, receivedQty: 11, uom: "each", unitCost: 10 }] });

    const v = await getPoVariance(tenantId, poId);
    expect(v.receivedTotal).toBe("110.00");
    expect(v.receivedVsOrdered).toBe("10.00");
    expect(v.overReceived).toBe(true);
    expect(v.invoiceTotal).toBeNull();
    expect(v.invoiceVsReceived).toBeNull();
  });

  it("enterInvoiceTotal rejects a draft PO (status guard)", async () => {
    const { tenantId, actor, supplierId, branchId, itemId } = await seedSentPo();
    const { poId } = await createDraftPo(actor, {
      supplierId, branchId,
      lines: [{ itemId, qtyOrdered: 10, uom: "each", unitCost: 5 }],
    });
    await expect(enterInvoiceTotal(actor, poId, 55)).rejects.toThrow(InvalidPoTransitionError);
    const [po] = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)));
    expect(po?.invoiceTotal).toBeNull();
  });

  it("enterInvoiceTotal rejects a negative total at the service boundary", async () => {
    const { tenantId, actor, poId } = await seedSentPo();
    await expect(enterInvoiceTotal(actor, poId, -5)).rejects.toThrow(InvalidPoInputError);
    const [po] = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)));
    expect(po?.invoiceTotal).toBeNull();
  });

  it("enterInvoiceTotal audits po.invoiced once and keeps the chain verifiable", async () => {
    const { tenantId, actor, poId } = await seedSentPo();
    await enterInvoiceTotal(actor, poId, 55);

    const events = await withTenant(tenantId, (tx) => tx.select().from(auditEvents)
      .where(eq(auditEvents.action, "po.invoiced")));
    expect(events).toHaveLength(1);
    expect(events[0]?.entityId).toBe(poId);
    expect((await verifyChain(tenantId)).ok).toBe(true);

    const [po] = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)));
    expect(po?.invoiceTotal).toBe("55.00");
  });

  it("closePurchaseOrder moves a received PO to closed and audits po.closed", async () => {
    const { tenantId, actor, poId, poLineId } = await seedSentPo();
    await postReceipt(actor, poId, { lines: [{ poLineId, receivedQty: 10, uom: "each", unitCost: 5 }] });

    await closePurchaseOrder(actor, poId);

    const [po] = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)));
    expect(po?.status).toBe("closed");

    const events = await withTenant(tenantId, (tx) => tx.select().from(auditEvents)
      .where(eq(auditEvents.action, "po.closed")));
    expect(events).toHaveLength(1);
    expect((await verifyChain(tenantId)).ok).toBe(true);
  });

  it("closePurchaseOrder on a sent PO throws InvalidPoTransitionError", async () => {
    const { tenantId, actor, poId } = await seedSentPo();
    await expect(closePurchaseOrder(actor, poId)).rejects.toThrow(InvalidPoTransitionError);
    const [po] = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)));
    expect(po?.status).toBe("sent");
  });
});
