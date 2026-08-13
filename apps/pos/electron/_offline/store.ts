import type Database from "better-sqlite3";
import crypto from "node:crypto";

export interface OutboxRow {
  client_order_id: string;
  draft_json: string;
  status: string;
  order_number: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeviceRow {
  token: string | null;
  tenant_id: string | null;
  branch_id: string | null;
  branch_name: string | null;
}

export type EventStatus = "pending" | "synced" | "failed";

/** One row of the append-only event log. `payload` and `server_response` are
 *  JSON text as stored — callers parse/stringify at the boundary, the same
 *  discipline `order_outbox.draft_json` already uses. */
export interface EventRow {
  event_id: string;
  seq: number;
  type: string;
  payload: string;
  occurred_at: string;
  status: EventStatus;
  server_response: string | null;
}

/** Mirrors the server's `PosRosterUser` (src/app/api/pos/v1/sync/auth/route.ts)
 *  field for field, so the offline roster and the online roster never drift
 *  apart in shape. `passwordHash` is stored exactly as given — encrypting it
 *  at rest (safeStorage) is the caller's job, not the store's. */
export interface AuthUser {
  userId: string;
  name: string;
  email: string;
  passwordHash: string;
  permissions: string[];
}

interface AuthCacheRow {
  user_id: string;
  name: string;
  email: string;
  password_hash: string;
  permissions: string;
  synced_at: string;
}

export class Store {
  constructor(private db: Database.Database) {}

  // ---- catalog (existing table; gains pricing + version, Task 8) ----

  saveCatalog(json: string, pricingJson: string, catalogVersion: number, syncedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO catalog_cache (id, json, pricing_json, catalog_version, synced_at) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           json = excluded.json,
           pricing_json = excluded.pricing_json,
           catalog_version = excluded.catalog_version,
           synced_at = excluded.synced_at`,
      )
      .run(json, pricingJson, catalogVersion, syncedAt);
  }

  getCatalog(): { json: string; pricingJson: string | null; catalogVersion: number | null; syncedAt: string } | null {
    const row = this.db
      .prepare(
        `SELECT json, pricing_json AS pricingJson, catalog_version AS catalogVersion, synced_at AS syncedAt
         FROM catalog_cache WHERE id = 1`,
      )
      .get() as { json: string; pricingJson: string | null; catalogVersion: number | null; syncedAt: string } | undefined;
    return row ?? null;
  }

  // ---- order outbox (pre-existing; superseded by local_events for new work) ----

  enqueueOrder(clientOrderId: string, draftJson: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO order_outbox (client_order_id, draft_json, status, order_number, error, created_at, updated_at)
         VALUES (?, ?, 'pending', NULL, NULL, ?, ?)`,
      )
      .run(clientOrderId, draftJson, now, now);
  }

  pendingOrders(): OutboxRow[] {
    return this.db
      .prepare("SELECT * FROM order_outbox WHERE status = 'pending' ORDER BY created_at ASC")
      .all() as OutboxRow[];
  }

  markSynced(clientOrderId: string, orderNumber: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE order_outbox SET status = 'synced', order_number = ?, error = NULL, updated_at = ? WHERE client_order_id = ?`,
      )
      .run(orderNumber, now, clientOrderId);
  }

  markFailed(clientOrderId: string, error: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE order_outbox SET status = 'failed', error = ?, updated_at = ? WHERE client_order_id = ?`,
      )
      .run(error, now, clientOrderId);
  }

  allTickets(): OutboxRow[] {
    return this.db
      .prepare("SELECT * FROM order_outbox ORDER BY created_at DESC")
      .all() as OutboxRow[];
  }

  saveDevice(d: { token: string; tenantId: string; branchId: string; branchName: string }): void {
    this.db
      .prepare(
        `INSERT INTO device (id, token, tenant_id, branch_id, branch_name) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET token = excluded.token, tenant_id = excluded.tenant_id, branch_id = excluded.branch_id, branch_name = excluded.branch_name`,
      )
      .run(d.token, d.tenantId, d.branchId, d.branchName);
  }

  getDevice(): DeviceRow | null {
    const row = this.db.prepare("SELECT * FROM device WHERE id = 1").get() as DeviceRow | undefined;
    return row ?? null;
  }

  clearDevice(): void {
    this.db.prepare("DELETE FROM device WHERE id = 1").run();
  }

  // ---- event log (Task 8) ----

  /** Appends one event and assigns it the next seq, gap-free and strictly
   *  increasing per device: `MAX(seq)+1` is read and written inside a single
   *  synchronous better-sqlite3 statement, so there is no window for a second
   *  writer to interleave (there is only ever one, this process). `payload`
   *  carries whatever the wire contract needs on it — actorUserId,
   *  clientShiftId, authorizedByUserId — the store itself is agnostic to
   *  event shape. `occurred_at` is stamped now: it is the till's own clock at
   *  the moment the operator acted, which is what the server's business-day
   *  and clock-skew logic keys off. */
  appendEvent(type: string, payload: unknown): { eventId: string; seq: number; occurredAt: string } {
    const eventId = crypto.randomUUID();
    const occurredAt = new Date().toISOString();
    const row = this.db
      .prepare(
        `INSERT INTO local_events (event_id, seq, type, payload, occurred_at, status)
         VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM local_events), ?, ?, ?, 'pending')
         RETURNING seq`,
      )
      .get(eventId, type, JSON.stringify(payload), occurredAt) as { seq: number };
    return { eventId, seq: row.seq, occurredAt };
  }

  /** Everything still owed to the server, oldest first — the flush order. */
  pendingEvents(): EventRow[] {
    return this.db
      .prepare("SELECT * FROM local_events WHERE status = 'pending' ORDER BY seq ASC")
      .all() as EventRow[];
  }

  /** Pending AND failed, oldest first: everything the server has not accepted,
   *  which is exactly what the till-state snapshot has not absorbed yet (the
   *  snapshot advances one event at a time as each is confirmed). A failed
   *  event still happened at the till — the money moved — so boot must replay
   *  it into local state even though the queue is halted behind it. */
  unsyncedEvents(): EventRow[] {
    return this.db
      .prepare("SELECT * FROM local_events WHERE status <> 'synced' ORDER BY seq ASC")
      .all() as EventRow[];
  }

  /** Sticky-halt guard (Task 10): a failed event must stop the queue, since
   *  skipping past it would replay everything after it out of order. */
  hasFailedEvents(): boolean {
    const row = this.db.prepare("SELECT 1 FROM local_events WHERE status = 'failed' LIMIT 1").get();
    return row !== undefined;
  }

  /** Operator resolution (Task 11's Retry action): a failed event goes back
   *  to pending so the next flush resumes from its seq. Only ever moves
   *  failed → pending — a synced event is not retryable. */
  retryFailedEvent(eventId: string): void {
    this.db
      .prepare(
        `UPDATE local_events SET status = 'pending', server_response = NULL
         WHERE event_id = ? AND status = 'failed'`,
      )
      .run(eventId);
  }

  markEventSynced(eventId: string, response: unknown): void {
    this.db
      .prepare(`UPDATE local_events SET status = 'synced', server_response = ? WHERE event_id = ?`)
      .run(JSON.stringify(response), eventId);
  }

  markEventFailed(eventId: string, error: string): void {
    this.db
      .prepare(`UPDATE local_events SET status = 'failed', server_response = ? WHERE event_id = ?`)
      .run(JSON.stringify({ error }), eventId);
  }

  // ---- auth roster cache (Task 8) ----

  /** Replace-all: the roster is a point-in-time mirror of the server's, so a
   *  user removed/deactivated server-side must disappear from the cache too
   *  — an additive upsert would leave departed users able to sign in
   *  offline forever. Runs in one transaction so a reader never observes an
   *  empty roster mid-swap. */
  saveAuthRoster(users: AuthUser[], syncedAt: string): void {
    const replace = this.db.transaction((rows: AuthUser[]) => {
      this.db.prepare("DELETE FROM auth_cache").run();
      const insert = this.db.prepare(
        `INSERT INTO auth_cache (user_id, name, email, password_hash, permissions, synced_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const u of rows) {
        insert.run(u.userId, u.name, u.email, u.passwordHash, JSON.stringify(u.permissions), syncedAt);
      }
    });
    replace(users);
  }

  findAuthUser(email: string): AuthUser | null {
    const row = this.db
      .prepare("SELECT * FROM auth_cache WHERE email = ?")
      .get(email) as AuthCacheRow | undefined;
    if (!row) return null;
    return {
      userId: row.user_id,
      name: row.name,
      email: row.email,
      passwordHash: row.password_hash,
      permissions: JSON.parse(row.permissions) as string[],
    };
  }

  // ---- generic durable state (Task 8) ----

  getState<T>(key: string): T | null {
    const row = this.db.prepare("SELECT json FROM local_state WHERE key = ?").get(key) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as T) : null;
  }

  setState(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO local_state (key, json) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET json = excluded.json`,
      )
      .run(key, JSON.stringify(value));
  }
}
