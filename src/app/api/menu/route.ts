import { NextRequest, NextResponse } from "next/server";
import { getTenantBySlug } from "@/server/tenancy";
import { getPublishedMenu } from "@/server/catalog/service";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const slug = searchParams.get("slug");
  const branchId = searchParams.get("branch") ?? undefined;

  if (!slug) {
    return NextResponse.json({ error: "slug is required" }, { status: 400 });
  }

  const tenant = await getTenantBySlug(slug);
  if (!tenant || !["active", "trial"].includes(tenant.status)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const menu = await getPublishedMenu(tenant.id, branchId);
  return NextResponse.json(menu);
}
