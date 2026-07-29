# QA Environment + Database Backups — Design

**Date:** 2026-07-29
**Status:** Approved
**Problem:** There is no place to test ServeOs without touching production users — Vercel preview deployments share the production database. There are also no backups of any kind for the production (or future QA) database.

## Goals

1. A persistent QA environment — its own database, its own stable URLs — where testers can work without any risk to production data or users.
2. Daily and weekly automated backups of both the Production and QA databases, at ~$0/month running cost.

## Decisions made

| Decision | Choice |
|---|---|
| QA shape | Persistent QA environment (not per-PR previews) |
| Budget | ~$0/month — Supabase Free plan, Vercel Hobby, R2 free tier |
| Backup storage | Cloudflare R2 |
| QA deployment wiring | Second Vercel project with `qa` as its production branch |

## 1. QA environment

### Supabase

- New free-tier Supabase project `serveos-qa` in `eu-central-1` (same region as prod, next to Vercel `fra1`).
- Free-tier caveat: projects pause after ~7 days of inactivity. The nightly backup connection is expected to keep it awake; if it does not, the failed backup job doubles as the alert that QA is paused.

### Vercel

- New Vercel project `serveos-qa` on the same GitHub repo (`Ai-NativeLab/ServeOs`), region `fra1`, with **production branch set to `qa`**.
- Env vars on the QA project: `DATABASE_URL` → QA Supabase (app role), `ROOT_DOMAIN=qa.serveos.com`, and QA-safe values for every other var the prod project defines.
- Because a push to `qa` is that project's *production* deployment (`VERCEL_ENV=production`), the existing `scripts/release-migrate.ts` + `src/db/release-guard.ts` logic runs **unmodified** and migrates the QA database at build time, before the deployment activates — identical semantics to prod. No changes to guarded migration code.

### Domains

- `qa.serveos.com` and wildcard `*.qa.serveos.com` assigned to the QA project.
- Surfaces mirror prod: dashboard `app.qa.serveos.com`, admin `admin.qa.serveos.com`, storefronts `{slug}.qa.serveos.com`.
- No collision with prod: `*.serveos.com` matches only one label, so it never captures `{slug}.qa.serveos.com`, and the explicit `qa.serveos.com` assignment on the QA project outranks the prod wildcard.

### Deploy flow

- To refresh QA: merge (or fast-forward) `main` — or a release-candidate branch — into `qa` and push. Vercel builds, migrates the QA DB, and deploys.

### Data policy

- QA is seeded with **synthetic data only** (`npm run db:seed` / showcase seeds + `scripts/ensure-platform-admin.ts` pointed at the QA DB). Production data is never copied into QA in normal operation — prod users stay out of QA entirely.
- The one exception is the deliberate, manually-triggered restore drill (see §2), which restores a prod dump into QA and is followed by a re-seed.

### Email safety

- QA must not send real email to real addresses. During implementation, verify what `EMAIL_PROVIDER` supports and configure QA with either a no-op/dev provider or a Resend test/sandbox key. This is an acceptance criterion, not a nice-to-have.

### Known accepted limitation

- PR preview deployments (of the original project) still point at the prod database. Testers use QA. Repointing previews at the QA database is an easy later hardening step, deliberately out of scope here.

## 2. Backups

### Mechanism

- A GitHub Actions scheduled workflow — the repo's first — runs `pg_dump -Fc` (custom format, compressed) against **both** databases daily at 03:00 UTC and uploads the dumps to Cloudflare R2 via its S3-compatible API.
- On Sundays, the same dump is additionally written under a `weekly/` prefix. One workflow, two retention classes, day-of-week decided inside the job.

### Storage layout & retention (enforced by R2 lifecycle rules, not code)

```
serveos-backups/
  prod/daily/serveos-prod-YYYY-MM-DD.dump   — expire after 14 days
  prod/weekly/serveos-prod-YYYY-MM-DD.dump  — expire after 90 days
  qa/daily/serveos-qa-YYYY-MM-DD.dump       — expire after 14 days
  qa/weekly/serveos-qa-YYYY-MM-DD.dump      — expire after 90 days
```

### Connection requirements (load-bearing details)

- **Session pooler, port 5432** (`aws-1-eu-central-1.pooler.supabase.com`): GitHub runners are IPv4-only and Supabase Free has no IPv4 direct connection; `pg_dump` requires session mode, so the transaction pooler (6543) is unusable.
- **Dump as the Supabase `postgres` role, never the `app` role**: tenant tables use FORCE Row-Level Security, so the app role would produce empty or failing dumps. `postgres` carries `BYPASSRLS`. If `postgres` lacks SELECT on app-owned tables, grant `pg_read_all_data` to it once.
- **Client/server version match**: the workflow installs the PostgreSQL client matching the server's major version (from PGDG) so `pg_dump` is never older than the server.
- **First-run acceptance criterion**: a dump is downloaded and spot-checked for actual row counts before the job is trusted. An empty-but-green backup is the failure mode this line exists to prevent.

### Alerting

- GitHub's built-in workflow-failure notifications (email to repo watchers). No extra infrastructure. A failing nightly job is also the canary for a paused QA project.
- Caveat noted: GitHub disables cron workflows after 60 days of repo inactivity; the repo is active, and the weekly backup's absence would surface in a restore drill regardless.

### Restore

- A restore runbook is committed to `docs/references/` with exact `pg_restore` commands (`--clean --if-exists --no-owner --no-privileges`) for both "restore prod into prod" (disaster) and "restore prod into QA" (drill).
- A `workflow_dispatch`-only (never scheduled) GitHub Actions job restores the **latest prod dump into QA** for periodic restore drills. Direction is hard-coded QA-ward; nothing automated ever writes to prod.

## 3. Secrets & cost

New GitHub repo secrets:

| Secret | Value |
|---|---|
| `PROD_DATABASE_URL` | Prod Supabase, `postgres` role, session pooler :5432 |
| `QA_DATABASE_URL` | QA Supabase, `postgres` role, session pooler :5432 |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Cloudflare R2 API token scoped to the `serveos-backups` bucket |

Running cost: **$0/month** — two free Supabase projects, second Vercel Hobby project, R2 free tier (10 GB; dumps are small and lifecycle-pruned), roughly 90 GitHub Actions minutes/month.

## 4. Out of scope

- **POS Electron app**: no separate QA build — it targets QA by pointing its server URL at `qa.serveos.com`.
- **Preview deployments → QA DB**: noted as future hardening.
- **Supabase Pro** (built-in daily backups + PITR): the growth path when budget allows; nothing in this design depends on it, and the pg_dump pipeline remains useful for off-vendor copies even after upgrading.

## Success criteria

1. A tester can sign up, create tenants, and place orders on `*.qa.serveos.com` with zero effect on production data or users.
2. Pushing to `qa` migrates and deploys QA automatically; pushing to `main` remains untouched prod behavior.
3. R2 contains dated daily dumps for both environments, weekly dumps on Sundays, and old dumps expire on schedule.
4. A prod dump has been successfully restored into QA at least once (restore drill), and the runbook documents how.
5. QA sends no real email to real users.
