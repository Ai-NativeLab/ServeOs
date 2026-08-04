import { NextRequest, NextResponse } from "next/server";
import { requireInventoryPermission } from "@/app/dashboard/inventory-permission";
import { UnauthorizedError } from "@/server/rbac/authorize";
import { withTenant } from "@/db/with-tenant";
import { listCounts, getOnHand } from "@/server/inventory/read";
import { stockCounts, stockCountLines } from "@/server/inventory/schema";
import type { StockCount } from "@/server/inventory/schema";
import { qty } from "@/server/inventory/uom";

export async function GET(req: NextRequest) {
  let ctx;
  try {
    ctx = await requireInventoryPermission("inventory:view");
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    throw e;
  }
  const p = req.nextUrl.searchParams;
  return NextResponse.json(await listCounts(ctx.tenantId, {
    status: (p.get("status") as StockCount["status"]) ?? undefined,
    limit: p.get("limit") ? Number(p.get("limit")) : undefined,
  }));
}

/**
 * Opens a count and snapshots each line's `systemQty` at that moment, so the
 * variance recorded on commit is measured against what the system believed when
 * counting started — not against a figure that moved while someone walked the
 * shelves. `inventory:count` is enough: staff count, managers reconfigure.
 */
export async function POST(req: NextRequest) {
  let ctx;
  try {
    ctx = await requireInventoryPermission("inventory:count");
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    throw e;
  }
  const body = await req.json();
  if (!body?.branchId || !body?.locationId) {
    return NextResponse.json({ error: "branchId and locationId are required" }, { status: 400 });
  }
  const lines: { itemId: string; countedQty: number }[] = Array.isArray(body.lines) ? body.lines : [];

  const count = await withTenant(ctx.tenantId, async (tx) => {
    const [created] = await tx.insert(stockCounts).values({
      tenantId: ctx.tenantId, branchId: body.branchId, locationId: body.locationId,
      startedByUserId: ctx.user.id,
    }).returning();

    if (lines.length > 0) {
      const onHandRows = await getOnHand(ctx.tenantId, { locationId: body.locationId });
      const systemByItem = new Map(onHandRows.map((r) => [r.itemId, r.onHand]));
      await tx.insert(stockCountLines).values(lines.map((l) => {
        const system = systemByItem.get(l.itemId) ?? 0;
        return {
          tenantId: ctx.tenantId, countId: created.id, itemId: l.itemId,
          systemQty: qty(system), countedQty: qty(l.countedQty),
          varianceQty: qty(l.countedQty - system),
        };
      }));
    }
    return created;
  });

  return NextResponse.json(count, { status: 201 });
}
