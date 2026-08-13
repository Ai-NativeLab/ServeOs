import type { AuthUser, EventRow, Store } from "./store";

/**
 * `halted` is not a flavour of offline: the network is fine, the server
 * refused an event, and nothing more may be sent until an operator resolves
 * it (Task 11's alert → `retryFailed`).
 */
export type SyncState = "online" | "offline" | "syncing" | "halted";

/** Everything the badge and the halt alert render (Task 11). */
export type SyncStatus = {
  state: SyncState;
  /** Events still owed to the server. */
  pending: number;
  /** Set only while `state === "halted"` — the event the queue is stuck on. */
  haltedOn?: { eventId: string; type: string; error: string };
  /** Last non-network failure that was nobody's single event (a 4xx on the
   *  batch itself, a roster pull refused). Diagnostic only — never a halt. */
  lastError?: string;
};

/**
 * The wire envelope, mirroring src/server/pos/sync-ingest.ts's `SyncEvent`.
 * `actorUserId`/`authorizedByUserId` live here, not in `payload` — the server
 * validates them on the envelope and hands the payload to a per-type
 * validator that never looks for them.
 */
export type SyncEvent = {
  eventId: string;
  seq: number;
  type: string;
  occurredAt: string;
  actorUserId: string;
  authorizedByUserId?: string;
  payload: Record<string, unknown>;
};

export type SyncResult =
  | { eventId: string; status: "applied" | "duplicate"; result: Record<string, unknown>; flags?: string[] }
  | { eventId: string; status: "failed"; error: { code: string; message: string } };

export type CatalogSnapshot = {
  menu: unknown;
  pricing: unknown;
  catalogVersion: number;
  syncedAt: string;
};

/**
 * The four calls the engine makes. Injected rather than constructed so the
 * engine is testable without Electron, fetch, or a server (api.ts builds the
 * real one).
 */
export interface PosApiClient {
  ping(): Promise<void>;
  getCatalog(): Promise<CatalogSnapshot>;
  getAuthRoster(): Promise<{ users: AuthUser[]; syncedAt: string }>;
  postEvents(events: SyncEvent[]): Promise<SyncResult[]>;
}

/** Set by api.ts on anything the till should read as "the network is gone",
 *  including 5xx and request timeouts — the distinction that decides between
 *  "retry later" (offline) and "an operator must intervene" (halted). */
export function isNetworkError(e: unknown): boolean {
  return (e as { isNetwork?: boolean } | null)?.isNetwork === true;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const PING_INTERVAL_MS = 15_000;
/** The server caps a batch at 50 (sync/events route); 20 keeps one refused
 *  event from dragging a large payload across the wire on every retry. */
const BATCH_SIZE = 20;

export type SyncEngineOptions = {
  intervalMs?: number;
  batchSize?: number;
  /**
   * Called once per event the server accepted, in seq order, right after it
   * is marked synced. PosMain uses it to advance the confirmed till-state
   * snapshot — the engine itself has no opinion about till state.
   */
  onApplied?: (row: EventRow, result: Record<string, unknown>) => void;
};

/**
 * Lifts the envelope fields off the stored payload. Both were written into
 * the payload by whoever appended the event (local_events has no column for
 * them) and are removed here so the wire payload is exactly what the server's
 * per-type validator expects.
 */
function toWire(row: EventRow): SyncEvent | null {
  const { actorUserId, authorizedByUserId, ...payload } = JSON.parse(row.payload) as Record<string, unknown>;
  if (typeof actorUserId !== "string" || !actorUserId) return null;
  return {
    eventId: row.event_id,
    seq: row.seq,
    type: row.type,
    occurredAt: row.occurred_at,
    actorUserId,
    ...(typeof authorizedByUserId === "string" ? { authorizedByUserId } : {}),
    payload,
  };
}

/**
 * Owns connectivity and the outbound half of sync.
 *
 * Three invariants, in the order they matter:
 *
 * 1. **Ordered.** Events go out in `seq` order and the engine only ever
 *    advances past ones the server acknowledged, so `seq` reaches the server
 *    gap-free and strictly increasing (wire contract rule 5) — a gap is
 *    rejected as `out_of_order`.
 * 2. **Sticky halt.** One refused event stops the queue permanently. `flush`
 *    checks `hasFailedEvents()` FIRST and sends nothing at all when one
 *    exists: skipping it would replay everything behind it out of causal
 *    order, and a sale that lands before the shift that should contain it is
 *    unrecoverable. Only `retryFailed()` clears it.
 * 3. **Single-flight.** The timer, a reconnect, and every write-through
 *    action all trigger flushes; one in-flight promise coalesces them, so the
 *    same event is never in two batches at once.
 */
export class SyncEngine {
  private state: SyncState;
  private haltedOn: SyncStatus["haltedOn"];
  private lastError?: string;
  private online = false;
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(s: SyncStatus) => void>();
  private readonly intervalMs: number;
  private readonly batchSize: number;

  constructor(
    private store: Store,
    private api: PosApiClient,
    private opts: SyncEngineOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? PING_INTERVAL_MS;
    this.batchSize = opts.batchSize ?? BATCH_SIZE;
    // A halt outlives the process: the failed row is still there after a
    // restart, so the engine must come back up halted rather than cheerfully
    // trying to send past it.
    this.haltedOn = this.describeFailure();
    this.state = this.haltedOn ? "halted" : "offline";
  }

  // ---- state ----

  status(): SyncStatus {
    return {
      state: this.state,
      pending: this.store.pendingEvents().length,
      ...(this.haltedOn ? { haltedOn: this.haltedOn } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  /** Subscribe to state changes; returns the unsubscribe. */
  onState(cb: (s: SyncStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  isOnline(): boolean {
    return this.online;
  }

  /** Re-broadcast the current status — for a queue-depth change (an append)
   *  that did not move the state itself. */
  notify(): void {
    const s = this.status();
    for (const cb of this.listeners) cb(s);
  }

  private setState(next: SyncState): void {
    this.state = next;
    this.notify();
  }

  private describeFailure(): SyncStatus["haltedOn"] {
    const failed = this.store.unsyncedEvents().find((e) => e.status === "failed");
    if (!failed) return undefined;
    const stored = failed.server_response ? (JSON.parse(failed.server_response) as { error?: string }) : null;
    return { eventId: failed.event_id, type: failed.type, error: stored?.error ?? "rejected by the server" };
  }

  // ---- loop ----

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // Unref so a headless test or a quitting app is never held open by it.
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One turn of the loop: probe, then catch up. The catalog is pulled only on
   * the offline→online edge (it is large and changes rarely), the roster on
   * every online tick — a cashier removed at head office must stop being able
   * to sign in offline without waiting for the next outage to end.
   */
  async tick(): Promise<void> {
    const wasOnline = this.online;
    try {
      await this.api.ping();
    } catch (e) {
      // Any failed probe means the till cannot sync — a dead network and a
      // refused device token are the same thing from here.
      this.online = false;
      if (!isNetworkError(e)) this.lastError = message(e);
      if (this.state !== "halted") this.setState("offline");
      return;
    }
    this.online = true;

    try {
      if (!wasOnline) await this.pull();
      else await this.pullRoster();
    } catch (e) {
      if (isNetworkError(e)) {
        this.online = false;
        if (this.state !== "halted") this.setState("offline");
        return;
      }
      this.lastError = message(e);
    }

    await this.flush();
  }

  /** Catalog (with pricing + version) and roster, in that order. */
  async pull(): Promise<void> {
    const c = await this.api.getCatalog();
    this.store.saveCatalog(JSON.stringify(c.menu), JSON.stringify(c.pricing), c.catalogVersion, c.syncedAt);
    await this.pullRoster();
  }

  /** Best-effort: `sync/auth` is cashier-gated, so it refuses whenever nobody
   *  is signed in or the cashier signed in offline (no live token). That must
   *  not fail the tick — a network error still propagates, since it means the
   *  connection died mid-pull. */
  private async pullRoster(): Promise<void> {
    try {
      const { users, syncedAt } = await this.api.getAuthRoster();
      this.store.saveAuthRoster(users, syncedAt);
    } catch (e) {
      if (isNetworkError(e)) throw e;
      this.lastError = message(e);
    }
  }

  // ---- flush ----

  /** Single-flight: overlapping triggers await the run already in progress. */
  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runFlush().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runFlush(): Promise<void> {
    // Invariant 2, checked before anything is read for sending: while a failed
    // event exists the queue is frozen, no matter what else is pending.
    if (this.store.hasFailedEvents()) {
      this.haltedOn = this.describeFailure();
      this.setState("halted");
      return;
    }
    if (this.store.pendingEvents().length === 0) {
      this.setState(this.online ? "online" : "offline");
      return;
    }

    this.setState("syncing");
    try {
      for (;;) {
        // Re-read each round: a write-through append during this run is picked
        // up here rather than waiting for the next tick.
        const batch = this.store.pendingEvents().slice(0, this.batchSize);
        if (batch.length === 0) break;

        const wire: SyncEvent[] = [];
        for (const row of batch) {
          const event = toWire(row);
          if (!event) {
            // No actorUserId means the server would reject it as invalid_event
            // and jam the queue anyway; failing it here surfaces the same halt
            // without a round trip.
            this.fail(row, "invalid_event: the stored payload has no actorUserId");
            return;
          }
          wire.push(event);
        }

        let results: SyncResult[];
        try {
          results = await this.api.postEvents(wire);
        } catch (e) {
          if (isNetworkError(e)) {
            this.online = false;
            this.setState("offline");
            return;
          }
          // A refusal of the batch envelope itself (401, malformed request) is
          // not attributable to one event, so nothing is marked failed and
          // nothing halts — the next tick retries.
          this.lastError = message(e);
          this.setState(this.online ? "online" : "offline");
          return;
        }
        this.online = true;

        const byId = new Map(results.map((r) => [r.eventId, r]));
        let progressed = false;
        for (const row of batch) {
          const result = byId.get(row.event_id);
          // The server stops at its first failure, so the tail of the batch
          // comes back unanswered — those events stay pending, untouched.
          if (!result) break;
          if (result.status === "failed") {
            this.fail(row, `${result.error.code}: ${result.error.message}`);
            return;
          }
          // `duplicate` is a success: a batch replayed after a reconnect is
          // answered from the server's receipts, byte-identical to the
          // original apply.
          this.store.markEventSynced(row.event_id, result.result);
          this.opts.onApplied?.(row, result.result);
          progressed = true;
        }
        if (!progressed) {
          this.lastError = "the server returned no result for the first queued event";
          this.setState("online");
          return;
        }
      }
      this.setState("online");
    } catch (e) {
      // Belt and braces: flush is called fire-and-forget from write-through
      // paths and from a timer, so an unexpected throw must not become an
      // unhandled rejection.
      this.lastError = message(e);
      this.setState(this.online ? "online" : "offline");
    }
  }

  private fail(row: EventRow, error: string): void {
    this.store.markEventFailed(row.event_id, error);
    this.haltedOn = { eventId: row.event_id, type: row.type, error };
    this.setState("halted");
  }

  /**
   * The operator's way out of a halt (Task 11's Retry): every failed event
   * goes back to pending — there is at most one, since the queue stops at it
   * — and the next flush resumes from its seq. The server left no receipt for
   * a refused event, so re-sending it at the same seq is correct, not a
   * duplicate.
   */
  async retryFailed(): Promise<void> {
    for (const row of this.store.unsyncedEvents()) {
      if (row.status === "failed") this.store.retryFailedEvent(row.event_id);
    }
    this.haltedOn = undefined;
    this.setState(this.online ? "online" : "offline");
    await this.flush();
  }
}
