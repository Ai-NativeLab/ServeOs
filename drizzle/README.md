# Migrations

## These files are immutable once applied

`scripts/db-check.ts` verifies each ledger row against the **hash of the SQL
file**, while `applyMigrations()` selects what to run by the journal's `when`
watermark. So editing an applied migration — even adding a comment — does not
re-run it, but does make `db:check` report the ledger row as belonging to no
file on this branch. Add a new migration instead.

## 0043 deliberately does not match its own snapshot

`drizzle-kit generate` emitted a fourth statement into `0043_woozy_rhino.sql`:

```sql
ALTER TABLE "plans" DROP COLUMN "lemon_squeezy_variant_id";
```

It was removed by hand. `0038` already drops that column. Snapshots `0039`–`0042`
were generated off `0037`, before the forked chain was re-linked, and still list
it — so a diff against the live schema keeps re-proposing a drop that has already
happened. Left in, the migration aborts the deploy on every database where `0038`
ran.

The `0043` snapshot is generated from the TypeScript schema and does not list the
column, so the drift ends there: `0044` and everything after it diff cleanly.
