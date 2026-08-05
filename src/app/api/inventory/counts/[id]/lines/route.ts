import { NextRequest, NextResponse } from "next/server";
import { requireInventoryPermission } from "@/app/dashboard/inventory-permission";
import { UnauthorizedError } from "@/server/rbac/authorize";
import { withTenant } from "@/db/with-tenant";
import { addCountLines } from "@/server/inventory/service";
import { InventoryConfigError } from "@/server/inventory/errors";

/**
 * Adds counted lines to an open count. Separate from opening the count because
 * counting a stockroom happens in passes — this is the endpoint a counter hits
 * repeatedly, and re-submitting an item corrects it rather than double-counting.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let ctx;
  try {
    ctx = await requireInventoryPermission("inventory:count");
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    throw e;
  }
  const { id } = await params;
  const body = await req.json();
  const lines: unknown = body?.lines;
  if (!Array.isArray(lines) || lines.length === 0) {
    return NextResponse.json({ error: "lines[] is required" }, { status: 400 });
  }
  if (!lines.every((l) => l && typeof l.itemId === "string" && typeof l.countedQty === "number")) {
    return NextResponse.json({ error: "each line needs an itemId and a numeric countedQty" }, { status: 400 });
  }

  try {
    await withTenant(ctx.tenantId, (tx) => addCountLines(tx, ctx.tenantId, id, lines));
    return NextResponse.json({ ok: true, added: lines.length }, { status: 201 });
  } catch (e) {
    if (e instanceof InventoryConfigError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
