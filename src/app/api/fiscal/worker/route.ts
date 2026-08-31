import { NextRequest, NextResponse } from "next/server";
import { drainEtaSubmissions } from "@/server/fiscal/worker";

// The schedule this route is registered under in vercel.json. Written as a line
// comment because the cron literal contains the characters that close a block
// comment: */15 * * * *
//
// VERCEL TIER GATE — DEPLOY REVIEW MUST CONFIRM. Cron jobs on Vercel's Hobby
// plan run at DAILY granularity only; a 15-minute schedule needs Pro or above.
// On Hobby the entry silently does not run at the stated interval, and no EG
// tenant should go live until the tier is confirmed — the compliance window
// below depends on it.

/**
 * The ETA submission drain, on its OWN Vercel Cron entry (see the schedule note
 * above). CRON_SECRET-gated exactly like `/api/notifications/worker`: Vercel
 * sends `Authorization: Bearer ${CRON_SECRET}`; anything else is 401.
 *
 * WHY IT LEFT THE NOTIFICATIONS TICK. It rode that route's inherited daily
 * 3am slot, which is too slow to be safe: ETA gives ~24 hours from issuance to
 * submit a receipt, so a sale rung just after a once-daily run has almost no
 * margin left, and a single transient failure burns a whole day of backoff. The
 * worker's own constants are sized for a sub-hourly cadence — `CLAIM_LEASE_MS`
 * (5 min) plus the 60s fetch timeout is deliberately under ETA's ~10-minute
 * duplicate-submission window — so a daily tick also leaves every lease long
 * expired between passes.
 *
 * SINGLE OWNERSHIP: this route is the only caller of `drainEtaSubmissions`.
 * `/api/notifications/worker` no longer calls it, so the drain cannot be
 * scheduled twice under two cadences.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // Visits EG tenants only (country gate, F1/F2), so this is a cheap no-op for
  // a deployment with none.
  const fiscal = await drainEtaSubmissions();
  return NextResponse.json({ fiscal });
}
