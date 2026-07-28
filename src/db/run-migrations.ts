import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { getMigrationStatus, readJournal, type MigrationStatus } from "./migration-status";
import { partitionEnumAdditions, splitStatements } from "./migration-sql";

/**
 * Applies pending migrations, one file at a time.
 *
 * This replaces drizzle's own migrator, which wraps EVERY pending migration in
 * a single transaction. That is fine until a migration adds an enum value and a
 * later statement uses it — Postgres rejects the use until the addition has
 * committed (55P04), and with one transaction for the whole run there is no
 * commit to be had. `0017_gigantic_fantastic_four.sql` does exactly this, so
 * `db:migrate` against an empty database could not get past it: every
 * environment had to be walked through by hand with `db:repair`.
 *
 * Two differences from drizzle, both required:
 *
 *  - Each migration commits on its own, so later files see earlier ones.
 *  - `ALTER TYPE … ADD VALUE` runs first and outside the transaction, skipping
 *    values that already exist so a re-run is a no-op.
 *
 * Everything else is deliberately identical. The ledger table, its schema and
 * the (hash, created_at) rows written to it match drizzle's format exactly, and
 * a migration is selected by the same rule drizzle uses — newer than the
 * ledger's high-water mark. Migrations that fall behind that mark stay
 * unreachable and stay `db:repair`'s job; this function does not quietly widen
 * what gets applied.
 */
export async function applyMigrations(pool: Pool, migrationsFolder = "drizzle"): Promise<void> {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS drizzle`);
  await pool.query(`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
    id SERIAL PRIMARY KEY,
    hash text NOT NULL,
    created_at bigint
  )`);

  const { rows } = await pool.query<{ created_at: string }>(
    `select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`,
  );
  const watermark = rows.length ? Number(rows[0].created_at) : null;

  const pending = readJournal(migrationsFolder).filter(
    (entry) => watermark === null || entry.when > watermark,
  );

  for (const entry of pending) {
    const statements = splitStatements(readFileSync(`${migrationsFolder}/${entry.tag}.sql`, "utf8"));
    const { enumAdditions, rest } = partitionEnumAdditions(statements);

    // Committed individually, ahead of anything that might reference them.
    // An enum value cannot be removed again, so this half is not rolled back if
    // the rest of the migration fails — re-running skips what is already there.
    for (const addition of enumAdditions) {
      const exists = await pool.query(
        `select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
          where t.typname = $1 and e.enumlabel = $2`,
        [addition.type, addition.value],
      );
      if (exists.rowCount) continue;
      await pool.query(addition.statement);
    }

    // The DDL and its ledger row commit together — a half-applied migration
    // that claims to be applied is the state `db:check` exists to catch.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const statement of rest) await client.query(statement);
      await client.query(
        `insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)`,
        [entry.hash, entry.when],
      );
      await client.query("COMMIT");
    } catch (cause) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${entry.tag} failed and was rolled back`, { cause });
    } finally {
      client.release();
    }
  }
}

/**
 * Migrate, then verify — the pair that must never come apart.
 *
 * Applying a migration is not evidence the schema is correct: a migration whose
 * timestamp predates the newest ledger row is skipped rather than applied, and
 * nothing about the run says so. Every caller (the CLI and the release step)
 * goes through here so neither can forget the second half.
 */
export async function migrateAndVerify(migrationsFolder = "drizzle"): Promise<MigrationStatus> {
  const { pool } = await import("./client");
  await applyMigrations(pool, migrationsFolder);
  const status = await getMigrationStatus(pool, migrationsFolder);
  await pool.end();
  return status;
}
