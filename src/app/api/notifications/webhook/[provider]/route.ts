import { NextRequest, NextResponse } from "next/server";
import { parseResendWebhook, WebhookSignatureError } from "@/server/email/webhook";
import { recordEmailEvent } from "@/server/notifications/email-events";

/**
 * Provider delivery callbacks. Signature-authenticated, never RBAC — the
 * request carries no session. 200 on duplicates and on event types we don't
 * track so the provider stops retrying; 400 only on a bad signature.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (provider !== "resend") return NextResponse.json({ error: "unknown provider" }, { status: 404 });

  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "webhook not configured" }, { status: 503 });

  // RAW body — the signature covers exactly the bytes the provider sent.
  const rawBody = await req.text();
  const headers = {
    "svix-id": req.headers.get("svix-id") ?? undefined,
    "svix-timestamp": req.headers.get("svix-timestamp") ?? undefined,
    "svix-signature": req.headers.get("svix-signature") ?? undefined,
  };

  try {
    const parsed = parseResendWebhook(rawBody, headers, secret);
    if (parsed) await recordEmailEvent(parsed);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof WebhookSignatureError) return NextResponse.json({ error: "forbidden" }, { status: 400 });
    throw e;
  }
}
