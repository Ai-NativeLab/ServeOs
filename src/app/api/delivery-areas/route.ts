import { NextRequest, NextResponse } from "next/server";
import { getTenantBySlug, isTenantServable } from "@/server/tenancy";
import { listDeliveryAreas } from "@/server/branches/service";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const slug = searchParams.get("slug");
  const branchId = searchParams.get("branch");
  if (!slug || !branchId) return NextResponse.json({ error: "slug and branch are required" }, { status: 400 });

  const tenant = await getTenantBySlug(slug);
  if (!tenant || !isTenantServable(tenant)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const areas = await listDeliveryAreas(tenant.id, branchId);
  return NextResponse.json(
    areas.filter((a) => a.isActive).map((a) => ({ id: a.id, nameEn: a.nameEn, nameAr: a.nameAr, deliveryFee: a.deliveryFee, minOrderAmount: a.minOrderAmount, etaMinutes: a.etaMinutes })),
  );
}
