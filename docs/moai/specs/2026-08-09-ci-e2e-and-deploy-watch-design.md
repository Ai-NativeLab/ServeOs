# CI E2E + Deploy Watchdog — Design

**Date:** 2026-08-09 · **Status:** approved approach, pending spec review

## Why now

On 2026-08-03 a `*/5 * * * *` cron in `vercel.json` landed on main. Vercel's
Hobby plan rejects sub-daily crons, so **every deployment for six days was
silently refused** — no failed build, no red commit status, nothing. CI stayed
green the whole time because nothing verifies that a push actually became a
running deployment. Separately, a full Playwright suite (11 specs in
`tests/e2e/`) exists but never runs in CI.

## Goals

1. Every PR and every push to `main`/`qa` runs the Playwright E2E suite.
2. Every push to `main`/`qa` is verified end-to-end: a Vercel deployment for
   that exact commit exists, reaches READY, and the live domain serves that
   commit.
3. Failures alert via a red workflow run (GitHub emails the committer). No new
   alerting infrastructure.

## Non-goals

- Gating deploys behind CI (Vercel keeps auto-deploying; we detect, not block).
- Multi-browser E2E (chromium only; webkit/firefox can come later).
- Restoring the 5-minute notifications cron (separate decision: Pro plan or an
  external trigger).

## Component 1 — `e2e` job in `.github/workflows/ci.yml`

Mirrors the existing `test` job's shape:

- `postgres:16` service; `npm ci` with `ELECTRON_SKIP_BINARY_DOWNLOAD=1`.
- Write `.env.test` (CI-local `DATABASE_URL`, `ROOT_DOMAIN=serveos.localhost`),
  reusing the non-superuser bootstrap (`scripts/ci-db-bootstrap.sql`).
- `npm run db:migrate:test`, then seed via `ENV_FILE=.env.test npm run db:seed`
  (the specs' documented prerequisite — roma tenant, admin + owner accounts).
- `npx playwright install --with-deps chromium`.
- `next build` then run the suite against `next start` (production build, not
  the dev server): `playwright.config.ts` switches `webServer.command` on
  `process.env.CI`, and gains `retries: 2` + `trace: "on-first-retry"` in CI.
  Next does not read `.env.test`, so the job exports `DATABASE_URL` and
  `ROOT_DOMAIN` as step env for the build and start steps.
- On failure, upload `playwright-report/` and `test-results/` as artifacts.
- Trigger: same as the workflow today — `pull_request`, plus `push` to `main`;
  add `qa` to the push branches so the deploy branch gets the full suite too.
- Tenant-subdomain navigation (`roma.serveos.localhost`) relies on chromium
  resolving `*.localhost` to loopback; if a spec proves otherwise on the
  runner, add explicit `/etc/hosts` entries in the job.

## Component 2 — `.github/workflows/deploy-watch.yml`

New workflow, `on: push` to `main` and `qa` (plus `workflow_dispatch` with a
`sha` input for testing).

Branch → target mapping (inline env, not secrets — project IDs are not
sensitive):

| Branch | Vercel project | Domain checked |
|---|---|---|
| `main` | `serve-os` (`prj_qdLE3YwFEsATt8gaKdgLeJBWzcs2`) | `https://www.serveos.tech` |
| `qa` | `serve-os-qa` (`prj_T2r2hWgyqU02OmQDk2dRMtOqc9sZ`) | `https://qa.serveos.tech` |

Single job, three phases, all via the Vercel REST API with a `VERCEL_TOKEN`
repo secret (token created on the account that owns the projects):

1. **Existence** — poll `GET /v6/deployments?projectId=…&target=production&
   meta-githubCommitSha=<sha>` for up to **5 minutes**. No deployment record →
   fail: *"Vercel created no deployment for this push — likely rejected at
   validation (check vercel.json against plan limits)."* This is the exact
   failure mode that went unnoticed for a week.
2. **Readiness** — poll the deployment's `readyState` for up to **15 minutes**.
   `ERROR`/`CANCELED` → fail with the deployment URL. Timeout → fail.
3. **Live smoke** — `GET <domain>/api/health` (retried ~2 min for alias
   propagation) and assert the returned `sha` equals the pushed commit.
   Catches "READY but the domain still serves an old build".

## Component 3 — `/api/health` route

`src/app/api/health/route.ts`: no auth, no database, returns
`{ ok: true, sha: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev" }` with
`dynamic = "force-dynamic"`. Deliberately DB-free so its signal is purely "is
this build serving traffic" — the backup canary already covers the database.

**Implementation checkpoint:** the proxy matcher
(`src/proxy.ts`) routes `/api/*` by host; verify `/api/health` passes through
unrewritten for the apex, `www`, `qa`, and unknown-tenant hosts, and add a unit
test alongside `middleware-routing.test.ts` for it.

## Error handling

- Watchdog API calls retry with backoff inside their polling windows; a Vercel
  API outage surfaces as a timeout failure (better a false red than silence).
- E2E flakes: `retries: 2` in CI plus trace artifacts; a spec that stays flaky
  gets fixed or quarantined explicitly, never ignored.

## Testing the work itself

- Health route + proxy pass-through: vitest unit tests.
- E2E job: proven by a PR that runs it green, plus one deliberate red
  (temporarily broken spec) to confirm artifacts upload.
- Watchdog: `workflow_dispatch` against the current prod SHA (green path);
  dispatch with a bogus SHA to confirm the no-deployment red path.

## Rollout order

1. Health route (+ tests) → lands on `main`/`qa`, deploys.
2. `deploy-watch.yml` (needs `VERCEL_TOKEN` secret first).
3. `e2e` job + playwright.config CI changes.

## Costs / limits

- E2E adds ~5–10 min per PR on GitHub-hosted runners (free for public repos;
  private-repo minutes come from the 2 000/month free tier — watch usage the
  first month).
- Watchdog is negligible (a few API calls per push).
