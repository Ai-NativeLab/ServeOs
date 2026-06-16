import { NextRequest, NextResponse } from "next/server";
import { getTenantBySlug } from "@/server/tenancy";
import { getOrderByToken } from "@/server/ordering/service";

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const slug = req.headers.get("x-tenant-slug") ?? new URL(req.url).searchParams.get("slug");
  if (!slug) return NextResponse.json({ error: "slug is required" }, { status: 400 });

  const tenant = await getTenantBySlug(slug);
  if (!tenant) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const order = await getOrderByToken(tenant.id, token);
  if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ status: order.status, paymentStatus: order.paymentStatus, fulfillmentType: order.fulfillmentType });
}
