import { NextRequest, NextResponse } from "next/server";
import { ingestWebhook, WebhookSignatureError } from "@/server/whatsapp/ingest";

/** Meta will not deliver a body larger than this; anything bigger is abuse. */
const MAX_BODY_BYTES = 1_000_000;

/** Meta's subscription handshake. */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  if (p.get("hub.mode") === "subscribe" && p.get("hub.verify_token") === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new NextResponse(p.get("hub.challenge") ?? "", { status: 200 });
  }
  return new NextResponse("forbidden", { status: 403 });
}

export async function POST(req: NextRequest) {
  // RAW body: the HMAC is over exactly the bytes Meta signed, so this must not
  // be req.json() followed by a re-stringify.
  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) return new NextResponse("payload too large", { status: 413 });

  try {
    await ingestWebhook(rawBody, req.headers.get("x-hub-signature-256"));
  } catch (e) {
    if (e instanceof WebhookSignatureError) return new NextResponse("forbidden", { status: 403 });
    throw e;
  }
  // Always 200 on accepted work — a non-2xx makes Meta retry for up to 7 days.
  return NextResponse.json({ ok: true });
}
