import { eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { recordAuditEvent } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { requireCapability } from "@/server/verticals/registry";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { inventoryItems } from "@/server/inventory/schema";
import { notify } from "@/server/notifications/service";
import { notificationOutbox } from "@/server/notifications/schema";
import { purchaseOrders, purchaseOrderLines, suppliers } from "./schema";
import type { PurchasingActor } from "./suppliers";
import { PoNotFoundError, SupplierEmailMissingError } from "./errors";
import { assertTransition } from "./status";
import type { PoStatus } from "./status";
import { renderPurchaseOrderHtml } from "./render";

function auditCtx(actor: PurchasingActor) {
  return {
    tenantId: actor.tenantId,
    branchId: actor.branchId,
    actorUserId: actor.actorUserId,
    fingerprint: emptyFingerprint(),
  };
}

/**
 * Emails the PO to the supplier and flips it to `sent`. The supplier is an
 * external address, so the email goes out through the notification OUTBOX
 * (a direct insert on this tx — `notify()`'s targets are user/role only),
 * while owner + manager get a normal in-app `notify`. Re-sending from `sent`
 * is allowed (a fresh draft→sent transition otherwise).
 */
export async function sendPurchaseOrder(actor: PurchasingActor, poId: string): Promise<void> {
  requireCapability(actor.vertical, "inventory");
  return withTenant(actor.tenantId, async (tx) => {
    const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId));
    if (!po) throw new PoNotFoundError();
    if (po.status !== "sent") assertTransition(po.status as PoStatus, "sent");

    const [supplier] = await tx.select().from(suppliers).where(eq(suppliers.id, po.supplierId));
    if (!supplier) throw new PoNotFoundError();
    if (!supplier.email) throw new SupplierEmailMissingError(supplier.id);

    const [branch] = await tx.select().from(branches).where(eq(branches.id, po.branchId));
    const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, actor.tenantId));
    const lines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, poId));
    const itemRows = await tx.select({ id: inventoryItems.id, nameEn: inventoryItems.nameEn })
      .from(inventoryItems)
      .where(eq(inventoryItems.tenantId, actor.tenantId));
    const itemNames = new Map(itemRows.map((r) => [r.id, r.nameEn]));

    const html = renderPurchaseOrderHtml(po, lines, itemNames, supplier, branch!, tenant!);
    const replyTo = branch?.replyToEmail ?? tenant?.contactEmail ?? null;

    await tx.insert(notificationOutbox).values({
      tenantId: actor.tenantId,
      toEmail: supplier.email,
      replyTo,
      subject: `Purchase Order #${po.poNumber} — ${tenant?.name ?? ""}`,
      template: "po_sent",
      payload: { html },
    });

    await notify({ tenantId: actor.tenantId }, {
      type: "po_sent",
      severity: "info",
      title: `PO #${po.poNumber} sent to ${supplier.name}`,
      body: `${lines.length} lines, total ${po.total} ${po.currency}`,
      targets: [{ role: "owner" }, { role: "manager" }],
      channels: ["in_app"],
      entityType: "purchase_order",
      entityId: poId,
      branchId: po.branchId,
    }, tx);

    await tx.update(purchaseOrders)
      .set({ status: "sent", sentAt: new Date() })
      .where(eq(purchaseOrders.id, poId));

    await recordAuditEvent(auditCtx(actor), {
      action: "po.sent",
      entityType: "purchase_order",
      entityId: poId,
      summary: `PO #${po.poNumber} sent to ${supplier.name}`,
      metadata: { supplierId: supplier.id, to: supplier.email },
    }, tx);
  });
}
