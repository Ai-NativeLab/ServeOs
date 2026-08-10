import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { users } from "@/server/auth/schema";
import { branches } from "@/server/branches/schema";
import { seedInventoryTenant, seedItem } from "@/server/inventory/test-helpers";
import { verifyChain } from "@/server/audit/verifier";
import { auditEvents } from "@/server/audit/schema";
import { notificationOutbox } from "@/server/notifications/schema";
import { notifications } from "@/server/notifications/schema";
import { purchaseOrders } from "./schema";
import type { PurchasingActor } from "./suppliers";
import { createSupplier } from "./suppliers";
import { createDraftPo } from "./service";
import { sendPurchaseOrder } from "./send";
import { SupplierEmailMissingError, InvalidPoTransitionError, PoNotFoundError } from "./errors";

async function seedActor(tenantId: string, branchId: string): Promise<PurchasingActor> {
  const [user] = await db.insert(users).values({
    tenantId, name: "Owner", email: `own-${crypto.randomUUID().slice(0, 8)}@x.com`, status: "active",
  }).returning({ id: users.id });
  return { tenantId, branchId, actorUserId: user.id, vertical: "restaurant" as const };
}

async function seedSendablePo(withReplyTo: boolean, email: string | null = "sup@x.com") {
  const { tenantId, branchId } = await seedInventoryTenant();
  const actor = await seedActor(tenantId, branchId);
  if (withReplyTo) {
    await withTenant(tenantId, (tx) => tx.update(branches).set({ replyToEmail: "buy@serveos.com" }));
  }
  const supplierId = await createSupplier(actor, { name: "Acme Foods", email });
  const itemId = await seedItem(tenantId, { nameEn: "Cola Can", baseUom: "each" });
  const { poId } = await createDraftPo(actor, {
    supplierId, branchId,
    lines: [{ itemId, qtyOrdered: 10, uom: "each", unitCost: 5 }],
  });
  return { tenantId, actor, supplierId, itemId, poId };
}

describe("sendPurchaseOrder", () => {
  it("throws SupplierEmailMissingError when the supplier has no email; PO stays draft, no outbox row", async () => {
    const { tenantId, actor, poId } = await seedSendablePo(false, null);

    await expect(sendPurchaseOrder(actor, poId)).rejects.toThrow(SupplierEmailMissingError);

    const [po] = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)));
    expect(po?.status).toBe("draft");
    expect(po?.sentAt).toBeNull();

    const outbox = await withTenant(tenantId, (tx) => tx.select().from(notificationOutbox));
    expect(outbox).toHaveLength(0);
  });

  it("inserts one outbox row, notifies owner+manager, sets sentAt, flips to sent, audits po.sent", async () => {
    const { tenantId, actor, poId } = await seedSendablePo(true);

    await sendPurchaseOrder(actor, poId);

    const outbox = await withTenant(tenantId, (tx) => tx.select().from(notificationOutbox));
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.toEmail).toBe("sup@x.com");
    expect(outbox[0]?.replyTo).toBe("buy@serveos.com");
    expect(outbox[0]?.template).toBe("po_sent");
    expect(outbox[0]?.subject).toContain("#1");
    expect(outbox[0]?.payload?.html).toContain("Cola Can");
    expect(outbox[0]?.payload?.html).toContain("Acme Foods");

    const feed = await withTenant(tenantId, (tx) => tx.select().from(notifications)
      .where(eq(notifications.type, "po_sent")));
    expect(feed).toHaveLength(2);
    expect(feed.map((n) => n.targetRole).sort()).toEqual(["manager", "owner"]);
    expect(feed.every((n) => n.entityType === "purchase_order" && n.entityId === poId)).toBe(true);

    const [po] = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)));
    expect(po?.status).toBe("sent");
    expect(po?.sentAt).not.toBeNull();

    const events = await withTenant(tenantId, (tx) => tx.select().from(auditEvents)
      .where(and(eq(auditEvents.action, "po.sent"), eq(auditEvents.entityId, poId))));
    expect(events).toHaveLength(1);
    expect((await verifyChain(tenantId)).ok).toBe(true);
  });

  it("is re-sendable from sent: a second call inserts a second outbox row and audits again", async () => {
    const { tenantId, actor, poId } = await seedSendablePo(false);

    await sendPurchaseOrder(actor, poId);
    await sendPurchaseOrder(actor, poId);

    const outbox = await withTenant(tenantId, (tx) => tx.select().from(notificationOutbox));
    expect(outbox).toHaveLength(2);

    const events = await withTenant(tenantId, (tx) => tx.select().from(auditEvents)
      .where(and(eq(auditEvents.action, "po.sent"), eq(auditEvents.entityId, poId))));
    expect(events).toHaveLength(2);
  });

  it("throws InvalidPoTransitionError from received/cancelled/closed", async () => {
    const { tenantId, actor, poId } = await seedSendablePo(false);
    for (const status of ["received", "cancelled", "closed"] as const) {
      await withTenant(tenantId, (tx) => tx.update(purchaseOrders).set({ status }).where(eq(purchaseOrders.id, poId)));
      await expect(sendPurchaseOrder(actor, poId)).rejects.toThrow(InvalidPoTransitionError);
    }
  });

  it("throws PoNotFoundError for an unknown PO", async () => {
    const { actor } = await seedSendablePo(false);
    await expect(sendPurchaseOrder(actor, "00000000-0000-0000-0000-000000000000"))
      .rejects.toThrow(PoNotFoundError);
  });
});
