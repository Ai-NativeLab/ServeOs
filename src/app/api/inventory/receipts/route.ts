import { NextRequest, NextResponse } from "next/server";
import { resolveInventoryContext } from "@/app/dashboard/inventory-permission";
import { withTenant } from "@/db/with-tenant";
import { receiveStock } from "@/server/inventory/service";
import { DimensionalUomError, InventoryConfigError } from "@/server/inventory/errors";
import { recordAuditEvent } from "@/server/audit/service";
import { webFingerprint } from "@/server/audit/fingerprint";

/**
 * Goods in. Creates a cost-carrying lot and the balancing `receive` ledger row.
 *
 * Deliberately NOT a purchase order: Spec 9 owns suppliers and the PO lifecycle
 * (draft → sent → received), and this does not pretend to be it. It is the plain
 * "a delivery arrived, put it on the shelf" path, which until now existed only
 * inside the backfill script — so the only ways stock could enter were a
 * migration or a correction dressed up as an adjustment. `supplierId` and
 * `poReceiptLineId` stay open on the lot for Spec 9 to fill in.
 *
 * Quantities are given in whatever unit the receiver is holding; the service
 * converts to the item's base unit, and `factorKind: "purchase"` lets an item
 * declare that its purchase unit is a case rather than a single.
 */
export async function POST(req: NextRequest) {
  const { ctx, denied } = await resolveInventoryContext("inventory:manage");
  if (denied) return denied;

  const body = await req.json();
  if (!body?.itemId || !body?.locationId || !body?.uom || !Number.isFinite(body?.qty)) {
    return NextResponse.json(
      { error: "itemId, locationId, uom and a numeric qty are required" }, { status: 400 },
    );
  }
  if (body.qty <= 0) {
    return NextResponse.json({ error: "a receipt quantity must be positive" }, { status: 400 });
  }

  try {
    const { lotId } = await withTenant(ctx.tenantId, async (tx) => {
      const result = await receiveStock(tx, {
        tenantId: ctx.tenantId,
        itemId: body.itemId, locationId: body.locationId,
        baseQty: body.qty, uom: body.uom,
        factorKind: body.byPurchaseUnit ? "purchase" : undefined,
        unitCost: body.unitCost ?? null,
        lotCode: body.lotCode ?? null,
        // Cut-to-size stock: the length of each piece received, so a cut can
        // consume a board and return its offcut.
        lengthMm: Number.isFinite(body.lengthMm) ? body.lengthMm : null,
        expiryAt: body.expiryAt ? new Date(body.expiryAt) : null,
        byUserId: ctx.user.id,
        note: body.note ?? null,
      });
      await recordAuditEvent(
        { tenantId: ctx.tenantId, actorUserId: ctx.user.id, fingerprint: webFingerprint(req) },
        {
          action: "inventory.received", entityType: "inventory_item", entityId: body.itemId,
          summary: `Received ${body.qty} ${body.uom}`,
          metadata: {
            locationId: body.locationId, qty: body.qty, uom: body.uom,
            unitCost: body.unitCost ?? null, lotCode: body.lotCode ?? null, lotId: result.lotId,
          },
        },
        tx,
      );
      return result;
    });
    return NextResponse.json({ ok: true, lotId }, { status: 201 });
  } catch (e) {
    if (e instanceof DimensionalUomError || e instanceof InventoryConfigError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}
