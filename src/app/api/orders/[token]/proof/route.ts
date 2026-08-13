import { NextRequest, NextResponse } from "next/server";
import { getTenantBySlug, isTenantServable } from "@/server/tenancy";
import { attachPaymentProof } from "@/server/ordering/service";
import { uploadImage } from "@/server/media/upload";
import { webFingerprint } from "@/server/audit/fingerprint";
import { DomainError } from "@/shared/errors";

/**
 * Attaches a transfer screenshot to an order awaiting the merchant's
 * confirmation. Authorised by the order's status token, exactly like
 * /cancel — the customer may be a guest with no session, and an anonymous
 * upload endpoint in an app with no rate limiting is not something to add.
 *
 * The upload happens before the DB write, so a rejected file (wrong type, too
 * large) never touches the order; a stored object whose attach then fails is
 * orphaned in the bucket, which is the cheaper of the two failure modes.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const slug = req.headers.get("x-tenant-slug") ?? new URL(req.url).searchParams.get("slug");
  if (!slug) return NextResponse.json({ error: "slug is required" }, { status: 400 });

  const tenant = await getTenantBySlug(slug);
  if (!tenant || !isTenantServable(tenant)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const form = await req.formData();
  const uploaded = await uploadImage({ tenantId: tenant.id, kind: "payment-proof", file: form.get("file") });
  if (!uploaded.ok) return NextResponse.json({ error: uploaded.error }, { status: uploaded.status });

  try {
    await attachPaymentProof(tenant.id, token, uploaded.url, { fingerprint: webFingerprint(req) });
    return NextResponse.json({ url: uploaded.url });
  } catch (e) {
    if (e instanceof DomainError) {
      return NextResponse.json({ error: e.messageFor("en"), code: e.code }, { status: 422 });
    }
    console.error("attachPaymentProof failed", { tenantId: tenant.id, error: e });
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
