/**
 * Applies or records a migration that drizzle will never reach on its own.
 *
 *   npm run db:repair -- <tag>                   # dry run: show what would happen
 *   npm run db:repair -- <tag> --apply           # run the SQL, then record it
 *   npm run db:repair -- <tag> --mark-applied    # record it only (DDL already present)
 *   ENV_FILE=.env.test npm run db:repair -- <tag> --apply
 *
 * Use --mark-applied when the objects already exist because another branch's
 * version of the same change was applied first; use --apply otherwise. Run
 * `npm run db:check` first — it names the tag and tells you which case you are in.
 */
import { config } from "dotenv";
import { readFileSync } from "node:fs";

config({ path: process.env.ENV_FILE ?? ".env.local", override: true, quiet: true });

const [tag, ...flags] = process.argv.slice(2);
const APPLY = flags.includes("--apply");
const MARK = flags.includes("--mark-applied");

async function main() {
  if (!tag) {
    console.error("usage: npm run db:repair -- <tag> [--apply | --mark-applied]");
    process.exit(1);
  }
  if (APPLY && MARK) {
    console.error("--apply and --mark-applied are mutually exclusive.");
    process.exit(1);
  }

  const { pool } = await import("../src/db/client");
  const { getMigrationStatus, readJournal } = await import("../src/db/migration-status");

  // Same MIGRATIONS_DIR override as db:check, so a database running another
  // branch's code is repaired against THAT branch's migrations.
  const migrationsDir = process.env.MIGRATIONS_DIR ?? "drizzle";
  const entry = readJournal(migrationsDir).find((e) => e.tag === tag);
  if (!entry) {
    console.error(`No migration tagged "${tag}" in drizzle/meta/_journal.json.`);
    await pool.end();
    process.exit(1);
  }

  const status = await getMigrationStatus(pool, migrationsDir);
  if (status.applied.some((e) => e.hash === entry.hash)) {
    console.log(`${tag} is already recorded as applied — nothing to do.`);
    await pool.end();
    return;
  }

  const { splitStatements, partitionEnumAdditions } = await import("../src/db/migration-sql");

  const sql = readFileSync(`${migrationsDir}/${entry.tag}.sql`, "utf8");
  const statements = splitStatements(sql);
  // `ALTER TYPE … ADD VALUE` cannot share a transaction with statements that use
  // the new value, so it runs first, on its own, and is skipped if already present.
  const { enumAdditions: enumAdds, rest } = partitionEnumAdditions(statements);

  console.log(`${tag}: ${statements.length} statement(s), when=${entry.when}`);
  console.log(`ledger row to insert: hash=${entry.hash.slice(0, 12)}… created_at=${entry.when}`);

  if (!APPLY && !MARK) {
    for (const s of statements) console.log(`  · ${s.split("\n")[0].slice(0, 100)}`);
    console.log("\nDRY RUN — pass --apply to run these, or --mark-applied to record without running.");
    await pool.end();
    return;
  }

  if (MARK) {
    await pool.query(
      `insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)`,
      [entry.hash, entry.when],
    );
    console.log(`Recorded ${tag} as applied WITHOUT running it.`);
    await pool.end();
    return;
  }

  for (const { statement, type, value } of enumAdds) {
    const present = await pool.query(
      `select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
        where t.typname = $1 and e.enumlabel = $2`,
      [type, value],
    );
    if (present.rowCount) {
      console.log(`  skip (exists): ${type}.${value}`);
      continue;
    }
    await pool.query(statement);
    console.log(`  added enum value: ${type}.${value}`);
  }

  // The DDL and its ledger row commit together — a half-applied migration that
  // claims to be applied is the state this whole tool exists to prevent.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const stmt of rest) await client.query(stmt);
    await client.query(
      `insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)`,
      [entry.hash, entry.when],
    );
    await client.query("COMMIT");
    console.log(`Applied ${tag} and recorded it.`);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("ROLLED BACK — nothing changed:", (e as Error).message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
