import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireDashboardUser } from "@/server/auth/dashboard-context";

const ALLOWED_TYPES = ["category", "product", "banner"] as const;
type MediaType = (typeof ALLOWED_TYPES)[number];

export async function POST(req: NextRequest) {
  let ctx: Awaited<ReturnType<typeof requireDashboardUser>>;
  try {
    ctx = await requireDashboardUser();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json() as { type?: string; filename?: string; contentType?: string };
  const { type, filename, contentType } = body;

  if (!type || !ALLOWED_TYPES.includes(type as MediaType) || !filename || !contentType) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const ext = filename.split(".").pop() ?? "bin";
  const path = `${ctx.tenantId}/${type}/${randomUUID()}.${ext}`;
  const bucket = "media";

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json({ error: "Storage not configured" }, { status: 500 });
  }

  const signRes = await fetch(`${supabaseUrl}/storage/v1/object/upload/sign/${bucket}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ upsert: false }),
  });

  if (!signRes.ok) {
    const err = await signRes.text();
    return NextResponse.json({ error: `Storage error: ${err}` }, { status: 502 });
  }

  const { signedURL } = (await signRes.json()) as { signedURL: string };
  const publicUrl = `${supabaseUrl}/storage/v1/object/public/${bucket}/${path}`;

  return NextResponse.json({ uploadUrl: signedURL, publicUrl });
}
