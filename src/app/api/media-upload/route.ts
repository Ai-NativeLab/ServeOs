import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireDashboardUser } from "@/server/auth/dashboard-context";

const ALLOWED_TYPES = ["category", "product", "banner", "logo", "cover"] as const;
type MediaType = (typeof ALLOWED_TYPES)[number];

const ALLOWED_CONTENT_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const BUCKET = "media";

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
  const file = form.get("file");

  if (typeof type !== "string" || !ALLOWED_TYPES.includes(type as MediaType)) {
    return NextResponse.json({ error: "Invalid upload type" }, { status: 400 });
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  const ext = ALLOWED_CONTENT_TYPES[file.type];
  if (!ext) {
    return NextResponse.json({ error: "Unsupported image format (use JPG, PNG, WebP, or GIF)" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "Image is too large (max 5 MB)" }, { status: 400 });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json({ error: "Image storage is not configured" }, { status: 500 });
  }

  const path = `${ctx.tenantId}/${type}/${randomUUID()}.${ext}`;

  const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": file.type,
      "x-upsert": "false",
      "cache-control": "3600",
    },
    body: await file.arrayBuffer(),
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    return NextResponse.json({ error: `Storage error: ${err}` }, { status: 502 });
  }

  const url = `${supabaseUrl}/storage/v1/object/public/${BUCKET}/${path}`;
  return NextResponse.json({ url });
}
