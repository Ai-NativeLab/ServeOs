import { NextRequest, NextResponse } from "next/server";
import { getTenantBySlug, isTenantServable } from "@/server/tenancy";
import { placeOrder, type PlaceOrderInput, type PlaceOrderLine } from "@/server/ordering/service";
import { DomainError } from "@/shared/errors";

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const slug = typeof body.slug === "string" ? body.slug : undefined;
  const locale: "en" | "ar" = body.locale === "ar" ? "ar" : "en";
  if (!slug) return NextResponse.json({ error: "slug is required" }, { status: 400 });

  const tenant = await getTenantBySlug(slug);
  if (!tenant || !isTenantServable(tenant)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Build the order input from an explicit allowlist — never spread the raw
  // body. In particular `now` is server-controlled only (it drives the
  // opening-hours check) and must not be accepted from the client.
  const input: PlaceOrderInput = {
    branchId: String(body.branchId ?? ""),
    fulfillmentType: body.fulfillmentType === "delivery" ? "delivery" : "pickup",
    customerName: String(body.customerName ?? ""),
    customerPhone: String(body.customerPhone ?? ""),
    notes: typeof body.notes === "string" ? body.notes : undefined,
    areaId: typeof body.areaId === "string" ? body.areaId : undefined,
    addressText: typeof body.addressText === "string" ? body.addressText : undefined,
    scheduledFor: typeof body.scheduledFor === "string" ? body.scheduledFor : undefined,
    paymentMethod: body.paymentMethod === "instapay" || body.paymentMethod === "vodafone_cash" || body.paymentMethod === "mobile_wallet" ? body.paymentMethod : "cash",
    paymentReference: typeof body.paymentReference === "string" ? body.paymentReference : undefined,
    paymentProofUrl: typeof body.paymentProofUrl === "string" ? body.paymentProofUrl : undefined,
    lines: Array.isArray(body.lines)
      ? (body.lines as unknown[]).map((l): PlaceOrderLine => {
          const line = (l ?? {}) as Record<string, unknown>;
          return {
            productId: String(line.productId ?? ""),
            variantId: typeof line.variantId === "string" ? line.variantId : undefined,
            quantity: Number(line.quantity),
            selectedOptionIds: Array.isArray(line.selectedOptionIds)
              ? (line.selectedOptionIds as unknown[]).map(String)
              : [],
          };
        })
      : [],
  };

  try {
    const result = await placeOrder(tenant.id, input);
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof DomainError) {
      return NextResponse.json({ error: e.messageFor(locale), code: e.code }, { status: 422 });
    }
    console.error("placeOrder failed", { tenantId: tenant.id, error: e });
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
