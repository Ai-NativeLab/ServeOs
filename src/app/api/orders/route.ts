import { NextRequest, NextResponse } from "next/server";
import { getTenantBySlug, isTenantServable } from "@/server/tenancy";
import { placeOrder, type PlaceOrderInput } from "@/server/ordering/service";
import { DomainError } from "@/shared/errors";

export async function POST(req: NextRequest) {
  let body: { slug?: string; locale?: "en" | "ar" } & Partial<PlaceOrderInput>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { slug, locale = "en", ...input } = body;
  if (!slug) return NextResponse.json({ error: "slug is required" }, { status: 400 });

  const tenant = await getTenantBySlug(slug);
  if (!tenant || !isTenantServable(tenant)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const result = await placeOrder(tenant.id, input as PlaceOrderInput);
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof DomainError) {
      return NextResponse.json({ error: e.messageFor(locale), code: e.code }, { status: 422 });
    }
    console.error("placeOrder failed", { tenantId: tenant.id, error: e });
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
