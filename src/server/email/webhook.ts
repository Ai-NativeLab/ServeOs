import { createHmac, timingSafeEqual } from "node:crypto";
import type { ParsedEmailEvent } from "./provider";
import type { EmailEventType } from "@/server/notifications/schema";

export class WebhookSignatureError extends Error {
  constructor() { super("invalid email webhook signature"); }
}

/** Reject webhooks older than this — a captured payload must not replay forever. */
const TOLERANCE_SECONDS = 5 * 60;

/**
 * Verifies a Svix-style signature (what Resend delivers webhooks with):
 * HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${rawBody}` using the
 * base64 secret behind the `whsec_` prefix. The header carries a
 * space-separated list of versioned signatures; any match passes.
 *
 * Fails closed on every abnormal input and never throws.
 */
export function verifySvixSignature(
  rawBody: string,
  headers: Partial<Record<string, string>>,
  secret: string,
): boolean {
  const id = headers["svix-id"];
  const timestamp = headers["svix-timestamp"];
  const signatureHeader = headers["svix-signature"];
  if (!id || !timestamp || !signatureHeader) return false;
  if (!secret.startsWith("whsec_")) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > TOLERANCE_SECONDS) return false;

  let key: Buffer;
  try {
    key = Buffer.from(secret.slice("whsec_".length), "base64");
  } catch {
    return false;
  }
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest();

  for (const part of signatureHeader.split(" ")) {
    const [, sig] = part.split(",", 2);
    if (!sig) continue;
    try {
      const provided = Buffer.from(sig, "base64");
      if (provided.length === expected.length && timingSafeEqual(provided, expected)) return true;
    } catch {
      // malformed entry in the list — try the next one
    }
  }
  return false;
}

const RESEND_EVENT_MAP: Record<string, EmailEventType> = {
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.opened": "opened",
};

/**
 * Verifies and normalizes a Resend delivery webhook.
 *
 * Throws WebhookSignatureError on a bad signature (the route answers 400);
 * returns null for event types we don't track (the route answers 200 so the
 * provider stops retrying). The svix message id is the dedupe key — Resend's
 * payload has no per-event id of its own.
 */
export function parseResendWebhook(
  rawBody: string,
  headers: Partial<Record<string, string>>,
  secret: string,
): ParsedEmailEvent | null {
  if (!verifySvixSignature(rawBody, headers, secret)) throw new WebhookSignatureError();

  let payload: { type?: string; data?: { email_id?: string } };
  try {
    payload = JSON.parse(rawBody) as typeof payload;
  } catch {
    return null;
  }

  const eventType = payload.type ? RESEND_EVENT_MAP[payload.type] : undefined;
  const providerMessageId = payload.data?.email_id;
  const providerEventId = headers["svix-id"];
  if (!eventType || !providerMessageId || !providerEventId) return null;

  return {
    provider: "resend",
    providerMessageId,
    providerEventId,
    eventType,
    raw: payload as Record<string, unknown>,
  };
}
