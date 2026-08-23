# Environments & Infrastructure

The live layout as of 2026-08-10. This is the map of where ServeOS actually
runs — read it before touching DNS, Vercel, Supabase, or secrets. Sibling
docs: [qa-environment-setup.md](qa-environment-setup.md) (how QA was stood
up, kept for re-runs) and [backup-restore.md](backup-restore.md) (backup
layout + restore runbook).

## Domains

| Domain | Registrar | Nameservers | Role |
|---|---|---|---|
| `serveos.tech` | Namecheap | `ns1/ns2.vercel-dns.com` | **The** domain. Prod + QA + all tenant wildcards. |
| `serveos.com` | Atom.com (GoDaddy) | `ns1/ns2.atom.com` | 302-redirect to serveos.tech only. Never an action item. |

Host layout (routing in `src/proxy.ts`):

- `www.serveos.tech` — marketing (apex 308s to www)
- `{slug}.serveos.tech` — tenant storefronts
- `app.` / `admin.serveos.tech` — dashboard / platform console
- `qa.serveos.tech` + `*.qa.serveos.tech` — same layout, QA

## Vercel (account `adhamesam82-8776`, Hobby plan)

| Project | ID | Production branch | Domains |
|---|---|---|---|
| `serve-os` (prod) | `prj_qdLE3YwFEsATt8gaKdgLeJBWzcs2` | `main` | `serveos.tech`, `www`, `*.serveos.tech` |
| `serve-os-qa` | `prj_T2r2hWgyqU02OmQDk2dRMtOqc9sZ` | `qa` | `qa.serveos.tech`, `*.qa.serveos.tech` |

Both import `Ai-NativeLab/ServeOs`. A push to `main` deploys prod; a push to
`qa` deploys QA. The build command (`vercel-build` in package.json) runs
`scripts/release-migrate.ts` **before** `next build`, so every production
deploy applies pending Drizzle migrations to its environment's database.

To promote main to QA: `git push origin main:qa` (fast-forward).

**Hobby-plan limits that have bitten us** are in Pitfalls below.

## Supabase (Frankfurt, eu-central-1)

| Project | Ref | Pooler cluster | Used by |
|---|---|---|---|
| prod | see `DATABASE_URL` in the serve-os Vercel project | `aws-1-eu-central-1.pooler.supabase.com` | prod app + backups |
| `ServeOs-qa` | `ndlxgxzkyfmjdbwmfpna` | `aws-0-eu-central-1.pooler.supabase.com` | QA app + backups |

Two Postgres roles per project, deliberately different:

- **`app`** — `NOBYPASSRLS`, owns the schema, used by the running app and
  build-time migrations. Connects via the transaction pooler (**port 6543**).
- **`postgres`** — `BYPASSRLS`, used only by the backup/restore workflows.
  Connects via the session pooler (**port 5432** — pg_dump needs session
  mode; the direct host is IPv6-only and unreachable from Actions runners).

QA is on the Free plan: it **auto-pauses after ~7 idle days**. The nightly
backup doubles as keep-alive, but if QA goes unreachable, check the Supabase
dashboard first.

Supabase **Realtime** (live propagation to dashboards, storefronts and tills)
needs two more things per project — a JWT secret in the environment and one
SQL policy — and stays inert until both exist. See
[realtime.md](realtime.md), including the concurrent-connection budget to
check against the plan before enabling it in production.

## Cloudflare R2

Bucket `serveos-backups` (EU jurisdiction — endpoint
`<ACCOUNT_ID>.eu.r2.cloudflarestorage.com`). Lifecycle: `{prod,qa}/daily/`
kept 14 days, `{prod,qa}/weekly/` kept 90 days. Written by the nightly
`db-backup` workflow (03:00 UTC).

## GitHub (`Ai-NativeLab/ServeOs`)

Workflows: `ci.yml` (typecheck + vitest on PRs and main),
`db-backup.yml` (nightly dumps → R2), `db-restore-drill.yml` (manual,
quarterly). Repo secrets:

| Secret | What |
|---|---|
| `PROD_DATABASE_URL` / `QA_DATABASE_URL` | `postgres` role, session pooler :5432, per-cluster host (aws-1 prod / aws-0 QA) |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 token scoped to `serveos-backups` |
| `VERCEL_TOKEN` | Vercel API token from the account above (deploy watchdog; full-account scope — Vercel has no read-only tokens) |

## Pitfalls (each of these cost us real time)

1. **Vercel Hobby silently rejects entire deployments over plan limits.** A
   `*/5` cron in `vercel.json` blocked every deploy — prod and QA — for six
   days (2026-08-03 → 08-09) with no failed build, no red status, nothing.
   Crons on Hobby are once-daily max. Symptom: pushes that create *no*
   deployment. Check `vercel.json` against plan limits first. The deploy
   watchdog (see `docs/moai/specs/2026-08-09-ci-e2e-and-deploy-watch-design.md`)
   exists to make this loud.
2. **The Supabase pooler cluster differs per project.** Prod is `aws-1`, QA
   is `aws-0`. Pointing at the wrong cluster fails with
   `FATAL: tenant/user … not found` — which looks exactly like a paused or
   deleted project while the dashboard shows Healthy. Copy the host from the
   project's Connect dialog, never from another environment's URL.
3. **Long values pasted into the Vercel env dashboard can arrive truncated.**
   A `DATABASE_URL` was stored cut off mid-hostname — twice. After saving,
   re-read the value (or use `vercel env add NAME production --force` piped
   from a file). Also URL-encode passwords: `/` must be `%2F` inside a
   connection string.
4. **Sensitive env vars work at build time but are unreadable afterwards.**
   A Sensitive `DATABASE_URL` did not break the build-time migration
   (verified 2026-08-10), but nobody — dashboard, CLI, or API — can read the
   value back to check it. Prefer non-sensitive for `DATABASE_URL` so
   operators can verify what is actually stored.
5. **Seed QA from the code that matches the deployed branch.** Running
   `db:seed` from a feature-branch working tree references tables whose
   migrations aren't on `qa` yet. Use a clean worktree:
   `git worktree add /tmp/qa-seed origin/qa --detach`, `npm ci`, then
   `ENV_FILE=.env.qa npm run db:seed` there.

## Local QA access

`.env.qa` (gitignored) holds the `app`-role URL (aws-0, :6543) and
`ROOT_DOMAIN=qa.serveos.tech`. All db scripts accept it via
`ENV_FILE=.env.qa npm run db:<cmd>`.
