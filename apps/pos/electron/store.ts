import type Database from "better-sqlite3";

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

export class Store {
  constructor(private db: Database.Database) {}

  saveCatalog(json: string, syncedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO catalog_cache (id, json, synced_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json, synced_at = excluded.synced_at`,
      )
      .run(json, syncedAt);
  }

  getCatalog(): { json: string; syncedAt: string } | null {
    const row = this.db
      .prepare("SELECT json, synced_at AS syncedAt FROM catalog_cache WHERE id = 1")
      .get() as { json: string; syncedAt: string } | undefined;
    return row ? { json: row.json, syncedAt: row.syncedAt } : null;
  }

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
}
