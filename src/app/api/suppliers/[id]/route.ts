import { NextRequest, NextResponse } from "next/server";
import { resolvePurchasingContext, resolvePurchasingActor } from "@/app/dashboard/purchasing-permission";
import { updateSupplier } from "@/server/purchasing/suppliers";
import { purchasingErrorResponse } from "../../purchasing-errors";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { ctx, denied } = await resolvePurchasingContext("suppliers:manage");
  if (denied) return denied;
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const input: Parameters<typeof updateSupplier>[2] = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      return NextResponse.json({ error: "name must be a non-empty string" }, { status: 400 });
    }
    input.name = body.name.trim();
  }
  for (const k of ["contactName", "email", "phone", "paymentTerms", "notes"] as const) {
    if (body[k] !== undefined) {
      if (body[k] !== null && typeof body[k] !== "string") {
        return NextResponse.json({ error: `${k} must be a string or null` }, { status: 400 });
      }
      input[k] = body[k] === null ? null : (body[k] as string);
    }
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") {
      return NextResponse.json({ error: "isActive must be a boolean" }, { status: 400 });
    }
    input.isActive = body.isActive;
  }
  if (Object.keys(input).length === 0) {
    return NextResponse.json({ error: "no fields to update" }, { status: 400 });
  }
  try {
    const supplier = await updateSupplier(await resolvePurchasingActor(ctx), id, input);
    if (!supplier) return NextResponse.json({ error: "Supplier not found" }, { status: 404 });
    return NextResponse.json({ supplier });
  } catch (e) {
    const mapped = purchasingErrorResponse(e);
    if (mapped) return mapped;
    console.error("updateSupplier failed", { tenantId: ctx.tenantId, supplierId: id, error: e });
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
