import Database from "better-sqlite3";

/** Columns SQLite has no `ADD COLUMN IF NOT EXISTS` for — guarded by reading
 *  the table's own schema first, so re-opening an already-migrated DB is a
 *  no-op instead of an "duplicate column" error. */
function addColumnIfMissing(db: Database.Database, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_cache (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL,
      synced_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS order_outbox (
      client_order_id TEXT PRIMARY KEY,
      draft_json TEXT NOT NULL,
      status TEXT NOT NULL,
      order_number TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS device (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      token TEXT,
      tenant_id TEXT,
      branch_id TEXT,
      branch_name TEXT
    );

    -- Append-only event log: every operator action, replayed onto the server
    -- in seq order on reconnect. seq is assigned by appendEvent from
    -- MAX(seq)+1 inside one synchronous statement (single-process, no race);
    -- the unique index below is a backstop that turns a logic bug into a
    -- constraint violation instead of a silent gap.
    CREATE TABLE IF NOT EXISTS local_events (
      event_id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,                  -- JSON
      occurred_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', -- pending | synced | failed
      server_response TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS local_events_seq_idx ON local_events(seq);

    -- Mirror of the branch's POS-capable roster (auth-sync.ts), for offline
    -- sign-in. password_hash is encrypted with safeStorage by the caller
    -- before insert (Task 9/14) — this table stores whatever string it is
    -- given and does no encryption itself.
    CREATE TABLE IF NOT EXISTS auth_cache (
      user_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      permissions TEXT NOT NULL,               -- JSON array
      synced_at TEXT NOT NULL
    );

    -- Generic durable key/value for the reducer's confirmed till-state
    -- snapshot and any other small durable flags. Nothing but boot's reducer
    -- call is meant to write the till-state key.
    CREATE TABLE IF NOT EXISTS local_state (
      key TEXT PRIMARY KEY,
      json TEXT NOT NULL
    );
  `);

  // catalog_cache predates offline totals math and drift audit: it needs the
  // tenant's checkout pricing (VAT/service charge) and the server's catalog
  // version counter alongside the menu JSON it already stores.
  addColumnIfMissing(db, "catalog_cache", "pricing_json", "pricing_json TEXT");
  addColumnIfMissing(db, "catalog_cache", "catalog_version", "catalog_version INTEGER");

  return db;
}
