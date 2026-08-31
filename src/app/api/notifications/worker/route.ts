import { NextRequest, NextResponse } from "next/server";
import { activeEmailProvider } from "@/server/email";
import { drainOutbox } from "@/server/notifications/worker";
import { drainWhatsappStatus } from "@/server/whatsapp/status-worker";
import { CloudApiProvider } from "@/server/whatsapp/cloud-api-provider";
import { drainEtaSubmissions } from "@/server/fiscal/worker";

/**
 * The outbox drain, fired by Vercel Cron (vercel.json). CRON_SECRET-gated:
 * Vercel sends `Authorization: Bearer ${CRON_SECRET}`; anything else is 401.
 * Anyone triggering it early only makes queued mail leave sooner — but the
 * gate stays, because an open endpoint invites hammering the provider.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // One scheduled tick, three outboxes: transactional email, WhatsApp
  // order-status messages and ETA fiscal submissions all share the drain
  // discipline (claim / attempt / back off / alert) and the cron slot.
  const email = await drainOutbox(activeEmailProvider());
  const whatsapp = await drainWhatsappStatus(new CloudApiProvider());
  // Runs last, and is the only one of the three that can be a no-op for the
  // whole deployment: it visits EG tenants only (country gate, F1/F2).
  //
  // TODO(schedule): the daily `0 3 * * *` slot in vercel.json is inherited
  // from the email outbox and is TOO SLOW for this drain. ETA gives 24 hours
  // from issuance to submit a receipt, so a once-daily tick leaves a sale rung
  // just after the run with almost no margin, and a single transient failure
  // burns a whole day of backoff. Move this to its own cron entry at ~15
  // minutes before an EG tenant goes live — see the plan's Task 5 Step 5.
  const fiscal = await drainEtaSubmissions();
  return NextResponse.json({ email, whatsapp, fiscal });
}
