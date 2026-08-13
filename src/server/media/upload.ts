import { randomUUID } from "node:crypto";
import { ALLOWED_IMAGE_TYPES, MAX_UPLOAD_BYTES } from "@/lib/upload-limits";

/**
 * Image upload to Supabase storage, shared by every surface that accepts one.
 *
 * Extracted from /api/media-upload when payment proof needed the same limits
 * from a route with a completely different authorisation model (a dashboard
 * session there, an order's status token here). The validation is the part
 * that must not diverge — a second hand-rolled copy is how one of them ends up
 * without a size cap.
 */

const BUCKET = "media";

export type UploadResult = { ok: true; url: string } | { ok: false; status: number; error: string };

/**
 * `kind` becomes a path segment under the tenant's prefix, so callers must
 * pass a fixed literal — never anything derived from the request body, or the
 * path could be steered out of the tenant's own folder.
 */
export async function uploadImage(opts: {
  tenantId: string;
  kind: string;
  file: unknown;
}): Promise<UploadResult> {
  const { tenantId, kind, file } = opts;

  if (!(file instanceof File)) return { ok: false, status: 400, error: "No file provided" };

  const ext = ALLOWED_IMAGE_TYPES[file.type];
  if (!ext) {
    return { ok: false, status: 400, error: "Unsupported image format (use JPG, PNG, WebP, or GIF)" };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, status: 400, error: "Image is too large (max 5 MB)" };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return { ok: false, status: 500, error: "Image storage is not configured" };
  }

  const path = `${tenantId}/${kind}/${randomUUID()}.${ext}`;

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
    return { ok: false, status: 502, error: `Storage error: ${await uploadRes.text()}` };
  }

  return { ok: true, url: `${supabaseUrl}/storage/v1/object/public/${BUCKET}/${path}` };
}
