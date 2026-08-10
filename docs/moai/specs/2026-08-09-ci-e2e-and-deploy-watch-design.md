# CI E2E + Deploy Watchdog — Design

**Date:** 2026-08-09 · **Status:** spec review applied 2026-08-10 — ready to
implement

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

**Known hole in Goal 2:** a commit message containing `[skip ci]` suppresses
all GitHub workflows — including deploy-watch — while Vercel still deploys.
Accepted as a documented exception; don't push `[skip ci]` commits to
`main`/`qa`.

## Non-goals

- Gating deploys behind CI (Vercel keeps auto-deploying; we detect, not block).
- Multi-browser E2E (chromium only; webkit/firefox can come later).
- Restoring the 5-minute notifications cron (separate decision: Pro plan or an
  external trigger).

## Component 1 — `e2e` job in `.github/workflows/ci.yml`

Mirrors the existing `test` job's shape (`postgres:16` service; `npm ci` with
`ELECTRON_SKIP_BINARY_DOWNLOAD=1`; the non-superuser bootstrap
`scripts/ci-db-bootstrap.sql`; a CI-written `.env.test`), then diverges into
its own environment. Two facts make the environment section normative rather
than illustrative: the database is reached from **two** processes (the Next
server *and* the Playwright process itself — `offline-payment.spec.ts` runs
service code in `beforeAll`), and the suite needs **two** seeded tenants, not
one.

### CI e2e environment (normative)

- **Env:** declare `DATABASE_URL` and `ROOT_DOMAIN=serveos.localhost` as
  **job-level env**, not per-step. `next build`/`next start` need them (Next
  does not read `.env.test`), and so does the Playwright test process:
  `offline-payment.spec.ts` imports server services and queries the database
  directly from `beforeAll`, and its dotenv fallback reads `.env.local`,
  which does not exist in CI.
- **Migrate:** `npm run db:migrate:test`.
- **Seed — two scripts, both required:**
  1. `ENV_FILE=.env.test npm run db:seed` — roma tenant, admin + owner
     accounts. Documented prerequisite of 9 of the 11 specs.
  2. `ENV_FILE=.env.test npx tsx scripts/seed-retail-showcase.ts` — nobio
     retail tenant, required by `shop.spec.ts` and
     `storefront-responsive.spec.ts`. Both scripts honor `ENV_FILE`
     identically (same dotenv preamble).
- **Widen hours (CI-only post-seed step):** set roma's opening hours to 24/7
  via `updateBranchOrdering` (`src/server/branches/service.ts` — the same
  service the seed itself uses). The seed's 10:00–23:00 window plus
  `placeOrder`'s real-clock validation (`src/server/ordering/service.ts`)
  would otherwise fail immediate-order flows (`offline-payment.spec.ts`
  places a real order; the storefront gates ordering while closed) whenever
  CI runs outside the tenant's business hours — a deterministic-by-clock
  flake class that `retries: 2` cannot fix. Inline `tsx -e` or a small
  `scripts/ci-e2e-hours.ts`; implementer's choice.
- **Browsers:** `npx playwright install --with-deps chromium`.
- **Build & run:** `npm run build` as its own step (a build failure gets its
  own red step), then the suite runs against `next start` — production build,
  not the dev server.
- **Artifacts:** on failure or timeout-cancellation, upload `playwright-report/` and `test-results/`.

### `playwright.config.ts` changes (all switched on `process.env.CI`)

- `webServer.command`: `npm run dev` locally → `npm run start` in CI (the
  build already ran as a job step).
- `retries: 2` and `trace: "on-first-retry"` in CI.
- reporter: dot + html (open: never) in CI so the uploaded playwright-report/
  artifact actually exists; list locally.
- `workers: 1` in CI. Playwright's default (~half the runner's cores) runs
  spec *files* in parallel against one shared, mutable seeded database —
  `offline-payment.spec.ts` enables a payment method and creates orders
  mid-run that `ordering`/`scheduling`/`dashboard` specs render. Serial is
  the only safe default; revisit only with per-spec data isolation.

### Triggers and hosts

- **Trigger:** the workflow's existing events (`pull_request`, `push` to
  `main`) plus `qa` in the push branches. This is workflow-level, so qa
  pushes will also run `typecheck` and `test` — intentional: qa is a deploy
  branch and gets the full gate.
- **Hostnames:** the specs navigate to exactly three hosts —
  `serveos.localhost`, `roma.serveos.localhost`, `nobio.serveos.localhost`.
  Chromium resolves any `*.localhost` (nested included) to loopback
  internally; if a spec proves otherwise on the runner, add those three as
  explicit per-host `/etc/hosts` entries (no wildcards — hosts files don't
  support them).

## Component 2 — `.github/workflows/deploy-watch.yml`

New workflow, `on: push` to `main` and `qa` (plus `workflow_dispatch` with a
`sha` input for testing), with:

```yaml
concurrency:
  group: deploy-watch-${{ github.ref }}-${{ github.event_name }}
  cancel-in-progress: true
```

Without this, two pushes racing inside the ~20-minute watch window produce
false reds on a healthy pipeline: watch-A's phase 3 sees the domain (correctly)
serving SHA B, and Vercel may cancel A's superseded build outright. Recurring
false alarms would teach everyone to ignore the watchdog — recreating the
original incident's blindness. `ci.yml` already models this exact block.

Branch → target mapping (inline env, not secrets — project IDs are not
sensitive):

| Branch | Vercel project | Domain checked |
|---|---|---|
| `main` | `serve-os` (`prj_qdLE3YwFEsATt8gaKdgLeJBWzcs2`) | `https://www.serveos.tech` |
| `qa` | `serve-os-qa` (`prj_T2r2hWgyqU02OmQDk2dRMtOqc9sZ`) | `https://qa.serveos.tech` |

Single job, three phases, all via the Vercel REST API with a `VERCEL_TOKEN`
repo secret:

1. **Existence** — poll `GET /v6/deployments?projectId=…&
   meta-githubCommitSha=<sha>` for up to **5 minutes**. Deliberately **no
   `target=production` filter**: it would silently break the qa leg if
   `serve-os-qa`'s Production Branch setting is anything but `qa`, and
   projectId + commit SHA already identify the deployment — phase 3 remains
   the authoritative "the domain serves this commit" check. No deployment
   record → fail: *"Vercel created no deployment for this push — likely
   rejected at validation (check vercel.json against plan limits)."* This is
   the exact failure mode that went unnoticed for a week.

   Phase 1 prefers a deployment **created after this run started**
   (fast-forward promotions mean the same SHA can already have an older
   preview deployment; locking onto it would squeeze the real build into
   phase 3's short window), falling back to the newest prior deployment only
   at deadline with a warning — a re-push of an already-deployed commit may
   create no new deployment at all. Dispatch runs get their own concurrency
   group so a manual test never cancels a real watch, and API curls use `-S`
   + `--max-time` so an auth/API failure is visibly distinct from "no
   deployment".
2. **Readiness** — poll the deployment's `readyState` for up to **15 minutes**.
   `ERROR`/`CANCELED`/`DELETED` → fail with the deployment URL. Timeout → fail.
3. **Live smoke** — `GET <domain>/api/health` (retried ~2 min for alias
   propagation), **following redirects** (if Vercel ever redirects apex↔www,
   a non-following GET sees a 307/308, not JSON), and assert the returned
   `sha` equals the pushed commit. Catches "READY but the domain still serves
   an old build". **Superseded-push guard:** before failing, check whether
   the branch head has moved past the watched SHA (GitHub API); if it has,
   exit success with a notice — belt-and-braces for `workflow_dispatch` runs
   and the cancellation race `cancel-in-progress` doesn't quite close.

**`VERCEL_TOKEN` scope:** Vercel tokens are account/team-wide — they cannot be
scoped to a project. Create the token on the team that owns both projects,
with the narrowest available scope, and note the blast radius in the secret's
description. The workflow runs only on `push`/`workflow_dispatch`, so forked
PRs never see the secret.

## Component 3 — `/api/health` route

`src/app/api/health/route.ts`: no auth, no database, returns
`{ ok: true, sha: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev" }` with
`dynamic = "force-dynamic"`. Deliberately DB-free so its signal is purely "is
this build serving traffic" — the backup canary already covers the database.
(If `cacheComponents` ever lands, revisit: Next 16 removes the `dynamic`
segment config under that mode. Even a prerendered handler would bake the
correct per-build SHA, so the signal degrades gracefully.)

**Implementation checkpoint:** pass-through is structural — `proxy()`
(`src/proxy.ts`) contains no rewrite path at all (it only sets
`x-surface`/`x-tenant-slug` headers and returns `NextResponse.next()`), and
its matcher does not exclude `/api/*`. Still, pin it with a `proxy()`-level
test (e.g. `src/proxy.test.ts`): construct `NextRequest`s for `/api/health`
on the apex, `www`, `qa`, and unknown-tenant hosts and assert the response is
a pass-through (`NextResponse.next()` semantics, headers set, no
rewrite/redirect). Note `src/middleware-routing.test.ts` tests the pure
`classifyHost` helper — it is the wrong home for this assertion.

## Alternative considered — `deployment_status` events

Vercel's GitHub integration emits `deployment_status` events, and a workflow
triggered on them could replace phases 1–2 with zero polling. Rejected, on
purpose: the incident's failure mode — **no deployment created at all** —
emits **no event**. Phase 1's existence timeout is the entire point of the
watchdog. Recorded here so a future reader doesn't "simplify" the polling
away and silently lose existence detection.

## Error handling

- Watchdog API calls retry with backoff inside their polling windows; a Vercel
  API outage surfaces as a timeout failure (better a false red than silence).
- Two pushes racing: handled by `concurrency.cancel-in-progress` plus the
  phase-3 superseded-push guard (see Component 2).
- E2E flakes: `retries: 2` in CI plus trace artifacts; a spec that stays flaky
  gets fixed or quarantined explicitly, never ignored.

## Testing the work itself

- Health route + proxy pass-through: vitest unit tests (see Component 3
  checkpoint).
- E2E job: proven by a PR that runs it green, plus one deliberate red
  (temporarily broken spec) to confirm artifacts upload. Run the job at least
  once outside roma's former 10:00–23:00 window to prove the hours-widening
  step removed the time-of-day dependence.
- Watchdog: `workflow_dispatch` against the current prod SHA (green path);
  dispatch with a bogus SHA to confirm the no-deployment red path.

## Rollout order

0. Preconditions: create the team-scoped `VERCEL_TOKEN` and add it as a repo
   secret; confirm in Vercel that `serve-os-qa`'s Production Branch is `qa`
   (the watchdog no longer depends on it, but a mismatch would mean qa
   deploys aren't what we think they are).
1. Health route (+ tests) → lands on `main`/`qa`, deploys.
2. `deploy-watch.yml`.
3. `e2e` job + playwright.config CI changes.

## Costs / limits

- E2E adds ~10–15 min per PR on GitHub-hosted runners with `workers: 1` (free
  for public repos; private-repo minutes come from the 2 000/month free tier —
  watch usage the first month).
- Watchdog is negligible (a few API calls per push).
