import { and, eq, sql } from "drizzle-orm";
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
  /** Optional, not threaded through Task 5's services — see schema.ts's `seq`
   *  column comment. sync-ingest.ts (Task 6b) always sets it. */
  seq?: number;
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
 * The device's own ordering position: the highest `seq` this device has ever
 * committed a receipt for, or 0 if it has none yet. Rows with no seq (see
 * schema.ts) are simply invisible to MAX() — only sync-ingest's own prior
 * writes can move this, which is exactly what ordering-gap detection needs.
 */
export async function lastReceiptSeq(deviceId: string): Promise<number> {
  const [row] = await db
    .select({ maxSeq: sql<number | null>`max(${posSyncEventReceipts.seq})` })
    .from(posSyncEventReceipts)
    .where(eq(posSyncEventReceipts.deviceId, deviceId));
  return row?.maxSeq ?? 0;
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

/** Every unique constraint a replayable service's own natural key or receipt
 *  insert can legitimately collide on under a genuine concurrent replay —
 *  not a real failure, just the loser of a race that its own advisory lock
 *  should normally have serialized. Kept in one place so nothing has to
 *  hardcode a single constraint name (`pos_sync_event_receipts_key`) and miss
 *  the natural-key ones each service also owns. */
const REPLAY_UNIQUE_CONSTRAINTS = new Set([
  "pos_sync_event_receipts_key",
  "pos_shifts_device_client",
  "pos_held_tickets_device_client",
  // recordSale's own natural key (Task 6b wires it into the sync dispatcher
  // too): a concurrent duplicate sale.recorded ingest races here before it
  // ever reaches pos_sync_event_receipts.
  "pos_order_receipts_device_client",
]);

/**
 * True for a Postgres unique-violation (23505) on one of the constraints
 * above — the one honest place to ask "was this just a concurrent duplicate
 * of a sync event?" instead of treating it as a hard failure. `.cause` is
 * checked too: a driver/ORM layer sometimes wraps the original pg error.
 */
export function isReplayUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; constraint?: unknown; cause?: { code?: unknown; constraint?: unknown } };
  const code = e.code ?? e.cause?.code;
  const constraint = e.constraint ?? e.cause?.constraint;
  return code === "23505" && typeof constraint === "string" && REPLAY_UNIQUE_CONSTRAINTS.has(constraint);
}
