# Inventory Backfill Automation — Design

**Date:** 2026-08-10 · **Status:** approved in brainstorm — pending spec review

## Why

PR #127 moved stock onto the inventory ledger. Sellables still carrying the
legacy flat `stockQuantity` integer are invisible to the ledger until they are
*adopted* — an item, a `product_inventory_links` row, and an opening-balance
lot. Adoption happens two ways today:

1. **Lazily, per product, on first sale** (`adoptLegacyTrackedStock` inside
   `deductForOrderLine`) — correctness is therefore already self-healing; no
   sale ever loses a deduction.
2. **In bulk, via `scripts/backfill-inventory.ts`** — idempotent, but manual:
   someone must remember to run it, and its per-tenant summary (including the
   multi-branch "NEEDS A STOCK COUNT" list) prints to whatever terminal ran it.

The gap is operational, not correctness: until a product sells once or someone
runs the script, it is missing from stock screens, counts, and low-stock
logic; and the stock-count follow-up list has no durable home.

## What ships

One new workflow, `.github/workflows/inventory-backfill.yml`. **No app code
changes and no script changes** — `backfill-inventory.ts` already does the
work, is idempotent (re-runs skip everything linked), and needs only
`DATABASE_URL` in process env (`src/db/client.ts` reads it lazily; no dotenv
required).

### Triggers

1. `workflow_run` on **Deploy Watch** `completed` + `conclusion == success` —
   backfills the environment that just deployed (`head_branch` `main` → prod,
   `qa` → qa). Running after the watchdog means the schema is migrated (build
   time, `release-migrate`) and the deployment is verified live. This leg
   stays dormant until PR #130 (which adds Deploy Watch) merges, then
   activates by itself — the workflows are otherwise independent.
2. `schedule: cron "0 4 * * *"` — daily, both environments, offset from
   db-backup's 03:00. Catches products created via the legacy path between
   deploys; an idle run is read-only and exits in seconds.
3. `workflow_dispatch` — manual, both environments (or filtered by input).

### Job shape

Mirrors `db-backup.yml`'s matrix: `[prod → PROD_DATABASE_URL, qa →
QA_DATABASE_URL]` (secrets already exist), `fail-fast: false` so one
environment's failure never blocks the other. On `workflow_run`, the matrix is
filtered to the environment whose branch triggered the watch. Steps: checkout
→ setup-node 22 + npm cache → `npm ci` (with `ELECTRON_SKIP_BINARY_DOWNLOAD`)
→ `npx tsx scripts/backfill-inventory.ts` with `DATABASE_URL` from the matrix
secret.

### Visibility

- Script output is appended to `$GITHUB_STEP_SUMMARY`, so every run's
  per-tenant counts are one click away in the Actions UI.
- If the output contains `NEEDS A STOCK COUNT`, the job emits a `::warning::`
  annotation naming the tenants — visible in the run list without opening
  logs. (Seeding a multi-branch tenant lands the opening balance on the
  oldest branch only; the others need a physical count. Single-branch tenants
  need nothing.)
- A **zero-tenant canary** fails the job when the script reports `across 0
  tenant(s)`. Both environments always have tenants, so zero means the role
  cannot read `public.tenants` (RLS/grants) or the database is empty — the
  same silent-success failure `db-backup.yml`'s row-count canary exists to
  catch. Without it, a misconfigured role would report a clean green no-op
  indefinitely.
- A failed run is a red workflow → GitHub emails the actor. Same alerting
  model as deploy-watch; no new infrastructure.

### Safety

- Per-environment concurrency group (`inventory-backfill-<env>`), no
  cancel-in-progress — a second trigger queues instead of overlapping the
  same database. Belt-and-braces: the script's per-tenant transactions and
  the partial unique index on links already make concurrent runs safe (the
  same arbiter that handles two tills racing a first sale).
- Worst-case mid-run failure leaves some tenants adopted and others not —
  exactly the state lazy adoption already tolerates; the next run finishes.

## Non-goals

- **No schema migrations from GitHub Actions.** Prod/qa schema migrates
  during the Vercel build (`vercel-build` → `scripts/release-migrate.ts`,
  before activation, production-guarded). CI's `db:migrate:test` only sets up
  ephemeral test databases. This workflow assumes the schema is current,
  which the Deploy Watch trigger ordering guarantees.
- No fail-closed change to `deductForOrderLine` — untracked sellables keep
  selling freely by design, and lazy adoption covers tracked ones.
- No per-branch split of legacy stock — unchanged backfill semantics.

## Testing the work itself

- YAML parses (js-yaml), workflow logic reviewed against db-backup's proven
  matrix/secret pattern.
- After merge: one `workflow_dispatch` against qa → summary shows per-tenant
  counts; confirm idempotency by dispatching twice (second run: all skipped).
- Confirm the 04:00 scheduled run appears; after PR #130 merges, confirm one
  deploy-triggered run fires from a push.

## Costs

~1–2 GitHub-hosted minutes per environment per run (checkout + npm ci
dominate; the script itself is seconds). Daily on both environments ≈ 60–120
min/month from the shared Actions pool — versus one e2e run at ~10–15 min.
Database load: a few SELECTs per tenant when idle; one-time inserts per
newly-adopted sellable otherwise.
