# Migration Drift Guard — design & runbook

**Date:** 2026-07-28
**Status:** Implemented
**Scope:** Make a silently-skipped Drizzle migration impossible to miss, and give it a repair path.

---

## The failure this prevents

On 2026-07-28 the dashboard's home and orders tabs both threw. The cause was not a
missed `db:migrate` run — it was that `db:migrate` **could never have fixed it**.

Drizzle's migrator (`drizzle-orm/pg-core/dialect`, `migrate`) reads exactly one row:

```sql
select id, hash, created_at from drizzle.__drizzle_migrations order by created_at desc limit 1
```

then applies a migration only when `lastApplied.created_at < migration.folderMillis`.
It never checks migrations individually. One high-water mark decides everything.

So when a merge leaves the ledger holding a row **newer** than a migration that has
not run yet, that migration is skipped on every future run, permanently and
silently. `db:migrate` prints "migrations applied" and exits 0.

Concretely: four ledger rows from `feat/subscription-billing` (created_at
≈ 1784.89e9) sat newer than `0016_bitter_beast` (when = 1784065231197). 0016 was
therefore never applied to the dev database, so `orders` lacked `cashier_user_id`,
`discount_amount` and `discount_reason`. Every page calling `listOrders` — which
selects an explicit column list — threw. Nothing anywhere reported the drift.

**The invariant being restored:** *what is on disk and what has been applied must
be the same set, and any mismatch must be loud.*

---

## Design

One module owns the comparison; three entry points consume it.

### `src/db/migration-status.ts`

Reads `drizzle/meta/_journal.json`, hashes each `.sql` with sha256 (byte-for-byte
what drizzle stores), and compares against `drizzle.__drizzle_migrations`:

| Field | Meaning |
|---|---|
| `applied` | on disk and in the ledger |
| `pending` | **on disk, never applied** — the bug |
| `orphans` | in the ledger, no file on this branch — usually another branch's migrations, and the usual *cause* |
| `watermark` | newest `created_at`: drizzle's high-water mark |

`isUnreachable(entry, watermark)` distinguishes the two kinds of pending:
a migration newer than the watermark will simply run next time; one **older**
than it is stuck forever and needs `db:repair`.

`compareMigrations` is pure, so the logic is unit-tested without a database.

### Entry points

1. **`npm run db:migrate`** — migrates, then verifies, and exits non-zero naming
   anything pending. The tool that lied now tells the truth.
2. **`npm run db:check`** — read-only, any environment
   (`ENV_FILE=.env.test npm run db:check`). Exits 1 on drift, so it can gate a deploy.
3. **`npm run db:repair -- <tag> [--apply | --mark-applied]`** — dry-run by default.
   `--apply` runs the statements (`ALTER TYPE … ADD VALUE` outside the transaction
   and skipped if the value exists; everything else inside one transaction with
   the ledger row, so a half-applied migration can never claim to be applied).
   `--mark-applied` records it without running it.

---

## Runbook

**`db:check` reports a pending migration.** Decide which case you are in:

- **The objects do not exist** (the normal case) → `npm run db:repair -- <tag> --apply`.
- **The objects already exist**, because another branch's version of the same
  change was applied first → `npm run db:repair -- <tag> --mark-applied`.

Verify the objects first — `select to_regclass('public.<table>')`, or check
`information_schema.columns` — rather than guessing. Then re-run `db:check`.

**`db:check` reports orphans but nothing pending.** Informational. It means this
database has applied migrations that do not exist on the current branch. Harmless
on its own; it is the condition that *causes* a future skip, so treat a growing
orphan list as a warning that branches are diverging.

---

## Merging branches that both added migrations

This is what creates the problem, so handle it deliberately.

1. Before merging, run `npm run db:check` on every environment that matters.
2. If both branches added migrations at the same index, **renumber the incoming
   branch's files** — rename the `.sql`, rename its `meta/NNNN_snapshot.json`, and
   update `idx` and `tag` in `_journal.json`. **Keep the `when` values unchanged**
   so the ordering that drizzle actually uses is preserved.
3. Never regenerate a migration that has already been applied somewhere. The
   ledger is keyed on the **file's content hash**, not its name (verified in
   `drizzle-orm/migrator`: `createHash("sha256").update(query)`), so renaming is
   safe and re-generating is not.
4. After merging, run `npm run db:migrate` — it now fails loudly if step 2 was
   done wrong.

Applied here: `feat/shifts-cash-drawer` carried `0017_strong_madame_masque`
(audit) and `0018_gorgeous_rocket_racer` (shifts), while `main` carried a
different `0017_gigantic_fantastic_four` (subscription billing). The branch's two
were renumbered to `0018` and `0019` with timestamps untouched; both the dev and
test databases confirmed 19/19 applied afterwards with no re-application.

---

## What this does not do

- It does not reorder or auto-repair anything. Out-of-order DDL is not always
  valid, so the decision stays with a human; the tooling only makes the choice
  visible and the execution safe.
- It does not run in CI, because this repo has no CI. `db:check` is the hook to
  wire in when that changes.
- It does not gate the test suite. The suite asserts logic, not the state of a
  particular database.
