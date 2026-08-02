import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies Meta's X-Hub-Signature-256 over the RAW request body.
 *
 * Fails closed on every abnormal input and never throws: timingSafeEqual raises
 * on unequal buffer lengths, and an uncaught raise here would turn "verify" into
 * "crash", which a caller could mistake for a transport error and retry.
 */
export function verifyWebhookSignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const provided = header.slice("sha256=".length);
  // Hex of a sha256 digest is always 64 chars; anything else cannot match.
  if (provided.length !== 64 || !/^[0-9a-f]+$/i.test(provided)) return false;

  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  try {
    return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}
