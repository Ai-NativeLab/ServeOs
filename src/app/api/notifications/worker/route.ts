import { NextRequest, NextResponse } from "next/server";
import { activeEmailProvider } from "@/server/email";
import { drainOutbox } from "@/server/notifications/worker";
import { drainWhatsappStatus } from "@/server/whatsapp/status-worker";
import { CloudApiProvider } from "@/server/whatsapp/cloud-api-provider";

/**
 * The outbox drain, fired by Vercel Cron (vercel.json). CRON_SECRET-gated:
 * Vercel sends `Authorization: Bearer ${CRON_SECRET}`; anything else is 401.
 * Anyone triggering it early only makes queued mail leave sooner — but the
 * gate stays, because an open endpoint invites hammering the provider.
 *
 * The ETA fiscal drain used to ride this tick and no longer does: it owns
 * `/api/fiscal/worker`, driven every 15 minutes by a GitHub Actions schedule
 * (Vercel Hobby rejects sub-daily crons), because this route's daily 3am slot
 * leaves a receipt almost no margin inside ETA's 24-hour submission window.
 * See that route for the full reasoning and the go-live gate.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // One scheduled tick, two outboxes: transactional email and WhatsApp
  // order-status messages share the drain discipline (claim / attempt / back
  // off / alert) and the cron slot.
  const email = await drainOutbox(activeEmailProvider());
  const whatsapp = await drainWhatsappStatus(new CloudApiProvider());
  return NextResponse.json({ email, whatsapp });
}
