import { NextRequest, NextResponse } from "next/server";
import { drainEtaSubmissions } from "@/server/fiscal/worker";

// SCHEDULING. Two callers hit this route, both with the same bearer:
//   1. .github/workflows/fiscal-worker.yml — the REAL cadence, every 15 min
//      (needs repo variable FISCAL_WORKER_URL + secret CRON_SECRET).
//   2. vercel.json — a DAILY safety-net entry only. Vercel's Hobby plan REJECTS
//      any sub-daily cron at deploy time (the whole deployment fails, see commit
//      ab3b8f2), so a 15-minute schedule cannot live in vercel.json on Hobby.
// GO-LIVE GATE: no EG tenant goes live until the GitHub workflow is confirmed
// running against production — with only the daily entry, the 24h compliance
// window below has almost no margin.

/**
 * The ETA submission drain, on its OWN schedule (see the note above).
 * CRON_SECRET-gated exactly like `/api/notifications/worker`: Vercel Cron and
 * the GitHub workflow both send `Authorization: Bearer ${CRON_SECRET}`;
 * anything else is 401.
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
