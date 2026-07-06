import Database from "better-sqlite3";

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
  `);
  return db;
}
