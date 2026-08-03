import { randomUUID } from "node:crypto";

/**
 * Prescription images live in a PRIVATE bucket (decision R4) — separate from
 * the public `media` bucket product photos use. A script is medical data; a
 * guessable public object URL is not an acceptable store for it, so staff
 * read it only through a short-lived signed URL minted per view.
 */
const BUCKET = "prescriptions";
const SIGNED_URL_TTL_SECONDS = 5 * 60;

export const RX_ALLOWED_CONTENT_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf", // a pharmacy commonly receives a scanned PDF script
};

export const RX_MAX_BYTES = 8 * 1024 * 1024;

function storageConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}

/** Uploads to the private bucket, returning the PATH to persist (never a URL). */
export async function uploadPrescriptionImage(
  tenantId: string,
  customerId: string,
  file: File,
): Promise<{ path: string } | { error: string; status: number }> {
  const ext = RX_ALLOWED_CONTENT_TYPES[file.type];
  if (!ext) return { error: "Unsupported file type (use JPG, PNG, WebP or PDF)", status: 400 };
  if (file.size > RX_MAX_BYTES) return { error: "File is too large (max 8 MB)", status: 400 };

  const cfg = storageConfig();
  if (!cfg) return { error: "Prescription storage is not configured", status: 500 };

  const path = `${tenantId}/${customerId}/${randomUUID()}.${ext}`;
  const res = await fetch(`${cfg.url}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.key}`,
      "Content-Type": file.type,
      "x-upsert": "false",
      // No public caching for medical data.
      "cache-control": "no-store",
    },
    body: await file.arrayBuffer(),
  });
  if (!res.ok) return { error: "Storage error", status: 502 };
  return { path };
}

/**
 * A short-lived signed URL for a reviewing pharmacist. Minted per view and
 * expiring in minutes, so a link pasted anywhere stops working quickly.
 */
export async function signedPrescriptionUrl(path: string): Promise<string | null> {
  const cfg = storageConfig();
  if (!cfg) return null;
  const res = await fetch(`${cfg.url}/storage/v1/object/sign/${BUCKET}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { signedURL?: string };
  return json.signedURL ? `${cfg.url}/storage/v1${json.signedURL}` : null;
}
