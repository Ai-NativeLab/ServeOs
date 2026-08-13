import { NextRequest, NextResponse } from "next/server";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { uploadImage } from "@/server/media/upload";

const ALLOWED_TYPES = ["category", "product", "banner", "logo", "cover"] as const;
type MediaType = (typeof ALLOWED_TYPES)[number];

export async function POST(req: NextRequest) {
  let ctx: Awaited<ReturnType<typeof requireDashboardUser>>;
  try {
    ctx = await requireDashboardUser();
  } catch (e) {
    if (typeof (e as { digest?: string }).digest === "string") throw e;
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const form = await req.formData();
  const type = form.get("type");

  // Checked against the allowlist before it is used as a path segment, so the
  // upload cannot be steered outside this tenant's own prefix.
  if (typeof type !== "string" || !ALLOWED_TYPES.includes(type as MediaType)) {
    return NextResponse.json({ error: "Invalid upload type" }, { status: 400 });
  }

  const result = await uploadImage({ tenantId: ctx.tenantId, kind: type, file: form.get("file") });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ url: result.url });
}
