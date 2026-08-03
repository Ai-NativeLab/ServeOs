import { NextRequest, NextResponse } from "next/server";
import { activeEmailProvider } from "@/server/email";
import { drainOutbox } from "@/server/notifications/worker";

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
  const result = await drainOutbox(activeEmailProvider());
  return NextResponse.json(result);
}
