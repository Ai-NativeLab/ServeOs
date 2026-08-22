import { NextRequest, NextResponse } from "next/server";
import { resolvePurchasingContext, resolvePurchasingActor } from "@/app/dashboard/purchasing-permission";
import { createSupplier, listSuppliers } from "@/server/purchasing/suppliers";
import { purchasingErrorResponse } from "../purchasing-errors";

export async function GET() {
  const { ctx, denied } = await resolvePurchasingContext("suppliers:manage");
  if (denied) return denied;
  const rows = await listSuppliers(ctx.tenantId);
  return NextResponse.json({ suppliers: rows });
}

export async function POST(req: NextRequest) {
  const { ctx, denied } = await resolvePurchasingContext("suppliers:manage");
  if (denied) return denied;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  try {
    const supplierId = await createSupplier(await resolvePurchasingActor(ctx), {
      name: body.name.trim(),
      contactName: typeof body.contactName === "string" ? body.contactName : undefined,
      email: typeof body.email === "string" ? body.email : undefined,
      phone: typeof body.phone === "string" ? body.phone : undefined,
      paymentTerms: typeof body.paymentTerms === "string" ? body.paymentTerms : undefined,
      notes: typeof body.notes === "string" ? body.notes : undefined,
    });
    return NextResponse.json({ id: supplierId }, { status: 201 });
  } catch (e) {
    const mapped = purchasingErrorResponse(e);
    if (mapped) return mapped;
    console.error("createSupplier failed", { tenantId: ctx.tenantId, error: e });
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
