import { NextRequest, NextResponse } from "next/server";
import { requirePosDevice } from "@/server/pos/require-device";
import { ingestEvents, type SyncEvent } from "@/server/pos/sync-ingest";
import { posAuthResponse } from "@/server/pos/errors";

/** Matches the cap advertised to the client (Tasks 8-10): a queue this deep
 *  is flushed in several requests, not one giant one. */
const MAX_BATCH_SIZE = 50;

/**
 * Device-authenticated only — deliberately NOT requirePosCashier. A live
 * cashier token cannot exist after the outage that produced this batch (see
 * sync-ingest.ts's doc comment); every event inside carries its own
 * actorUserId instead, resolved per event, so a batch may span cashiers.
 */
export async function POST(req: NextRequest) {
  let device;
  try {
    device = await requirePosDevice(req);
  } catch (e) {
    const authRes = posAuthResponse(e);
    if (authRes) return authRes;
    throw e;
  }

  const body = (await req.json()) as { events?: unknown };
  if (!Array.isArray(body.events)) {
    return NextResponse.json({ error: "Missing events" }, { status: 400 });
  }
  if (body.events.length > MAX_BATCH_SIZE) {
    return NextResponse.json({ error: `A batch is capped at ${MAX_BATCH_SIZE} events` }, { status: 400 });
  }

  const results = await ingestEvents(device, body.events as SyncEvent[]);
  return NextResponse.json({ results });
}
