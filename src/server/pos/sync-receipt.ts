import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { posSyncEventReceipts, type PosSyncEventReceipt } from "./schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The atomicity seam every replayable non-sale service (shifts, cash
 * movements, counts, held tickets — Task 5) accepts optionally. A service
 * with no natural idempotency key gets one from this descriptor; each writes
 * it into `pos_sync_event_receipts` as the LAST statement of its own tenant
 * transaction (see schema.ts for why that table carries no RLS). Defined
 * here, not in the ingestion endpoint, because this module has no callers
 * upstream of it — Task 6 imports this type rather than the reverse.
 */
export type SyncReceipt = {
  deviceId: string;
  eventId: string;
  type: string;
  occurredAt: Date;
  clockSkewFlagged: boolean;
};

/**
 * Looks up a prior receipt for (deviceId, eventId). The table has no RLS (see
 * schema.ts), so this runs equally well on the bare `db` handle — a cheap
 * bail-out before a service spends a grant token or opens a transaction — or
 * inside a tenant tx, which is the authoritative check: re-run after the
 * service's own lock is held, it is what stops two concurrent replays of the
 * same event from both applying the effect.
 */
export async function findSyncReceipt(
  ref: Pick<SyncReceipt, "deviceId" | "eventId">,
  executor: typeof db | Tx = db,
): Promise<PosSyncEventReceipt | null> {
  const [row] = await executor
    .select()
    .from(posSyncEventReceipts)
    .where(and(eq(posSyncEventReceipts.deviceId, ref.deviceId), eq(posSyncEventReceipts.eventId, ref.eventId)))
    .limit(1);
  return row ?? null;
}

/**
 * jsonb round-trips a Date column to an ISO string. A service that answers a
 * replay by returning a stored `resultJson` verbatim needs the named fields
 * back as real Date instances for its declared return type to hold.
 */
export function reviveDates<T extends Record<string, unknown>>(row: T, keys: (keyof T)[]): T {
  const out = { ...row };
  for (const k of keys) {
    const v = out[k];
    if (typeof v === "string") out[k] = new Date(v) as T[typeof k];
  }
  return out;
}
