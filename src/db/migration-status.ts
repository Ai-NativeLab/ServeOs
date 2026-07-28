import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool } from "pg";

/**
 * Compares the migrations on disk against the ones the database has actually
 * applied.
 *
 * Why this exists: drizzle's migrator reads only the NEWEST row of
 * `drizzle.__drizzle_migrations` and applies a migration when
 * `lastApplied.created_at < migration.when` (see `pg-core/dialect`'s `migrate`).
 * It never checks migrations individually. So a single out-of-order ledger row —
 * which is what merging two branches that each added migrations produces —
 * silently and permanently disables every earlier migration that has not run
 * yet. Nothing reports it: `db:migrate` prints success and the schema is quietly
 * wrong until something queries a missing column.
 *
 * This module restores the property drizzle assumes but never verifies: what is
 * on disk and what has been applied must be the same set.
 */

/** A migration file on disk, as named by `drizzle/meta/_journal.json`. */
export type MigrationEntry = {
  idx: number;
  tag: string;
  /** Journal timestamp. Drizzle compares this against the ledger watermark. */
  when: number;
  /** sha256 of the file's contents — exactly what drizzle stores in the ledger. */
  hash: string;
};

/** A row of `drizzle.__drizzle_migrations`. */
export type LedgerRow = { hash: string; createdAt: number };

export type MigrationStatus = {
  applied: MigrationEntry[];
  /** On disk but never applied. Non-empty means the schema is not what the code expects. */
  pending: MigrationEntry[];
  /** Applied but with no file on this branch — usually another branch's migrations. */
  orphans: LedgerRow[];
  /** The newest `created_at` in the ledger: drizzle's high-water mark. */
  watermark: number | null;
};

/** Reads the journal and hashes each migration file the way drizzle does. */
export function readJournal(migrationsFolder = "drizzle"): MigrationEntry[] {
  const journal = JSON.parse(
    readFileSync(`${migrationsFolder}/meta/_journal.json`, "utf8"),
  ) as { entries: { idx: number; tag: string; when: number }[] };

  return journal.entries.map((entry) => ({
    idx: entry.idx,
    tag: entry.tag,
    when: entry.when,
    hash: createHash("sha256")
      .update(readFileSync(`${migrationsFolder}/${entry.tag}.sql`, "utf8"))
      .digest("hex"),
  }));
}

/** Pure set comparison — no filesystem, no database. */
export function compareMigrations(entries: MigrationEntry[], ledger: LedgerRow[]): MigrationStatus {
  const appliedHashes = new Set(ledger.map((row) => row.hash));
  const diskHashes = new Set(entries.map((entry) => entry.hash));

  return {
    applied: entries.filter((entry) => appliedHashes.has(entry.hash)),
    pending: entries.filter((entry) => !appliedHashes.has(entry.hash)),
    orphans: ledger.filter((row) => !diskHashes.has(row.hash)),
    watermark: ledger.length ? Math.max(...ledger.map((row) => row.createdAt)) : null,
  };
}

/**
 * True when drizzle will never apply this migration on its own: its timestamp
 * is behind the ledger's high-water mark, so the migrator skips straight past
 * it every run. These are the ones that need `db:repair`.
 */
export function isUnreachable(entry: MigrationEntry, watermark: number | null): boolean {
  return watermark !== null && entry.when <= watermark;
}

export async function getMigrationStatus(pool: Pool, migrationsFolder = "drizzle"): Promise<MigrationStatus> {
  const { rows } = await pool.query<{ hash: string; created_at: string }>(
    `select hash, created_at from drizzle.__drizzle_migrations order by created_at`,
  );
  return compareMigrations(
    readJournal(migrationsFolder),
    rows.map((row) => ({ hash: row.hash, createdAt: Number(row.created_at) })),
  );
}

/** A human-readable report. Returns the lines; the caller decides where they go. */
export function formatMigrationStatus(status: MigrationStatus): string {
  const lines: string[] = [
    `applied: ${status.applied.length}/${status.applied.length + status.pending.length} migrations`,
  ];

  if (status.orphans.length) {
    lines.push(
      `${status.orphans.length} ledger row(s) have no migration file on this branch (applied from another branch):`,
      ...status.orphans.map((row) => `    ${row.hash.slice(0, 12)}…  created_at=${row.createdAt}`),
    );
  }

  if (!status.pending.length) {
    lines.push("every migration on disk has been applied.");
    return lines.join("\n");
  }

  lines.push(`${status.pending.length} migration(s) on disk have NOT been applied:`);
  for (const entry of status.pending) {
    const unreachable = isUnreachable(entry, status.watermark);
    lines.push(
      `    ${entry.tag}  (when=${entry.when})${unreachable ? "  <-- UNREACHABLE" : ""}`,
    );
  }
  if (status.pending.some((entry) => isUnreachable(entry, status.watermark))) {
    lines.push(
      "",
      `An UNREACHABLE migration predates the newest ledger row (${status.watermark}), so`,
      "drizzle skips it on every run and `db:migrate` will never apply it. Fix it with:",
      "    npm run db:repair -- <tag> --apply          # run the SQL and record it",
      "    npm run db:repair -- <tag> --mark-applied   # record it (DDL already present)",
    );
  }
  return lines.join("\n");
}
