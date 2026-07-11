import { NextRequest, NextResponse } from "next/server";
import { getTenantBySlug } from "@/server/tenancy";
import { cancelOrderByToken } from "@/server/ordering/service";
import { DomainError } from "@/shared/errors";

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const slug = req.headers.get("x-tenant-slug") ?? new URL(req.url).searchParams.get("slug");
  if (!slug) return NextResponse.json({ error: "slug is required" }, { status: 400 });

  const tenant = await getTenantBySlug(slug);
  if (!tenant) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const order = await cancelOrderByToken(tenant.id, token);
    return NextResponse.json({ status: order.status });
  } catch (e) {
    if (e instanceof DomainError) {
      return NextResponse.json({ error: e.messageFor("en"), code: e.code }, { status: 422 });
    }
    console.error("cancelOrderByToken failed", { tenantId: tenant.id, error: e });
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
