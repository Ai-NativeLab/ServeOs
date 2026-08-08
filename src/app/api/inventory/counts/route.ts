import { NextRequest, NextResponse } from "next/server";
import { resolveInventoryContext } from "@/app/dashboard/inventory-permission";
import { withTenant } from "@/db/with-tenant";
import { listCounts } from "@/server/inventory/read";
import { addCountLines } from "@/server/inventory/service";
import { stockCounts } from "@/server/inventory/schema";
import type { StockCount } from "@/server/inventory/schema";

export async function GET(req: NextRequest) {
  const { ctx, denied } = await resolveInventoryContext("inventory:view");
  if (denied) return denied;
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
  const { ctx, denied } = await resolveInventoryContext("inventory:count");
  if (denied) return denied;
  const body = await req.json();
  if (!body?.branchId || !body?.locationId) {
    return NextResponse.json({ error: "branchId and locationId are required" }, { status: 400 });
  }
  // Validated here as well as in /counts/[id]/lines: an unchecked countedQty
  // becomes NaN, then the literal string "NaN" in a numeric column, and the
  // driver error surfaces as a 500 instead of a 400.
  const lines: { itemId: string; countedQty: number }[] = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.every((l) => l && typeof l.itemId === "string" && Number.isFinite(l.countedQty))) {
    return NextResponse.json({ error: "each line needs an itemId and a numeric countedQty" }, { status: 400 });
  }

  const count = await withTenant(ctx.tenantId, async (tx) => {
    const [created] = await tx.insert(stockCounts).values({
      tenantId: ctx.tenantId, branchId: body.branchId, locationId: body.locationId,
      startedByUserId: ctx.user.id,
    }).returning();
    // Opening with lines is a convenience for a one-pass count; the same helper
    // backs POST /counts/:id/lines, so both paths snapshot systemQty identically.
    await addCountLines(tx, ctx.tenantId, created.id, lines);
    return created;
  });

  return NextResponse.json(count, { status: 201 });
}
