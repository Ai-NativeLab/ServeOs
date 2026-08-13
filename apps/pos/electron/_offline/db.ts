import Database from "better-sqlite3";

/**
 * At-rest encryption seam (Task 14). Electron's `safeStorage` cannot be
 * imported here: this file is pulled into a bare vitest process by every
 * `_offline` test (no Electron runtime to provide it), the same reason
 * `PosApiClient` and the realtime transport are injected rather than
 * constructed (Tasks 8-11). `pos-main.ts` builds the real implementation over
 * `safeStorage` and hands it to `Store`; every test gets `noCipher` by default.
 */
export interface AtRestCipher {
  isAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(ciphertext: Buffer): string;
}

/** What every test — and a `safeStorage.isEncryptionAvailable() === false`
 *  platform (headless Linux CI, no secret store) — gets: writes land as
 *  plaintext, exactly like disabled safeStorage. */
export const noCipher: AtRestCipher = {
  isAvailable: () => false,
  encryptString: (s) => Buffer.from(s, "utf8"),
  decryptString: (b) => b.toString("utf8"),
};

/** Tags an encrypted value so `decryptAtRest` can tell it apart from a
 *  plaintext row written before encryption existed, or by a cipher that was
 *  unavailable at write time — both must keep reading correctly forever,
 *  since there is no migration pass over `auth_cache`/`catalog_cache` (Task
 *  14: encryption applies going forward, on the next write of a row, not
 *  retroactively). */
const ENC_PREFIX = "enc:v1:";

export function encryptAtRest(cipher: AtRestCipher, plaintext: string): string {
  if (!cipher.isAvailable()) return plaintext;
  return ENC_PREFIX + cipher.encryptString(plaintext).toString("base64");
}

/** Untagged input (no `enc:v1:` prefix) is read back as-is — a pre-encryption
 *  row, or one written while `isAvailable()` was false. Never throws on a
 *  plaintext row just because a cipher is now available. */
export function decryptAtRest(cipher: AtRestCipher, stored: string): string {
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  return cipher.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), "base64"));
}

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
  // The branch's cash-movement policy (payoutThreshold, blindClose) — synced
  // alongside pricing so pos-main's cashMovement gate can match the server's
  // exactly instead of always requiring a manager (Part B fold-in fix).
  addColumnIfMissing(db, "catalog_cache", "shift_policy_json", "shift_policy_json TEXT");

  return db;
}
