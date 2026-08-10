# CI E2E + Deploy Watchdog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or build to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the existing Playwright suite in CI on every PR and every push to `main`/`qa`, and verify every push to `main`/`qa` actually became a READY Vercel deployment serving that exact commit.

**Architecture:** Three components from `docs/moai/specs/2026-08-09-ci-e2e-and-deploy-watch-design.md` (spec review applied 2026-08-10): a DB-free `/api/health` route that reports the deployed commit SHA; a `deploy-watch.yml` workflow that polls the Vercel REST API in three phases (deployment exists → reaches READY → live domain serves the SHA); and an `e2e` job in `ci.yml` that seeds two tenants, widens opening hours, and runs Playwright serially against a production build.

**Tech Stack:** Next.js 16 route handlers, vitest, Playwright, GitHub Actions (bash + curl + jq), Vercel REST API, tsx scripts with dotenv `ENV_FILE` convention.

---

**Read the spec first:** `docs/moai/specs/2026-08-09-ci-e2e-and-deploy-watch-design.md`. Every decision below is justified there; this plan only adds the how.

**Branch:** create `feat/ci-e2e-deploy-watch` off `origin/main` (use the worktree skill).

**Local prerequisites for the vitest steps:** `npm run test` runs vitest with a DB-backed globalSetup that reads `.env.test`. The dev machine already has `.env.test` pointing at the local test Postgres. If a fresh clone lacks it, copy the CI shape:
`DATABASE_URL=postgresql://serveos_ci:serveos_ci@localhost:5432/serveos_test` and `ROOT_DOMAIN=serveos.localhost`.

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/app/api/health/route.ts` | Create | DB-free liveness + deployed-SHA endpoint |
| `src/app/api/health/route.test.ts` | Create | Unit tests for the health route |
| `src/proxy.test.ts` | Create | Pins `/api/health` pass-through per host class |
| `scripts/ci-e2e-hours.ts` | Create | CI-only post-seed step: roma → 24/7 hours |
| `playwright.config.ts` | Modify | CI switches: prod server, `workers: 1`, retries, trace |
| `.github/workflows/deploy-watch.yml` | Create | Three-phase Vercel deployment watchdog |
| `.github/workflows/ci.yml` | Modify | Add `qa` push trigger + the `e2e` job |

---

### Task 1: Preconditions (manual — required before merge, not before coding)

No files. Two dashboard actions the watchdog depends on. Do them early; the PR must not merge until both are done, or deploy-watch goes red on its very first push.

- [ ] **Step 1: Create the Vercel token and add it as a repo secret**

In the Vercel dashboard (the team that owns `serve-os` and `serve-os-qa`): Account Settings → Tokens → Create. Scope: that team; expiry: 1 year. Name it `deploy-watch (GitHub Actions)`. Vercel tokens cannot be scoped to a single project — note the account-wide blast radius in the token description.

Then add it to the repo (GitHub writes need the `mohanedsayed` account — the default gh account is pull-only):

```bash
gh secret set VERCEL_TOKEN --repo Ai-NativeLab/ServeOs
# paste the token when prompted
```

Expected: `✓ Set Actions secret VERCEL_TOKEN for Ai-NativeLab/ServeOs`

- [ ] **Step 2: Confirm serve-os-qa's Production Branch is `qa`**

Vercel dashboard → `serve-os-qa` project → Settings → Environments → Production. The Branch Tracking value must be `qa`. The watchdog no longer filters on `target=production` (spec, Component 2), so this doesn't break the watchdog either way — but a mismatch would mean qa deploys aren't what we think they are. If it isn't `qa`, fix it and note it in the PR description.

---

### Task 2: `/api/health` route (TDD)

**Files:**
- Create: `src/app/api/health/route.test.ts`
- Create: `src/app/api/health/route.ts`

- [ ] **Step 1: Write the failing test**

Create `src/app/api/health/route.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { GET } from "./route";

// vi.stubEnv can't delete a var on older vitest majors; save/restore by hand.
const ORIGINAL_SHA = process.env.VERCEL_GIT_COMMIT_SHA;
afterEach(() => {
  if (ORIGINAL_SHA === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
  else process.env.VERCEL_GIT_COMMIT_SHA = ORIGINAL_SHA;
});

describe("GET /api/health", () => {
  it("returns ok plus the commit sha Vercel baked into the build", async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = "abc1234";
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sha: "abc1234" });
  });

  it("falls back to 'dev' when no sha is present (local dev)", async () => {
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    const res = GET();
    expect(await res.json()).toEqual({ ok: true, sha: "dev" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/app/api/health/route.test.ts`
Expected: FAIL — vitest cannot resolve `./route` (module not found). Note: globalSetup applies migrations first; that's normal and takes a few seconds.

- [ ] **Step 3: Write the minimal implementation**

Create `src/app/api/health/route.ts`:

```ts
import { NextResponse } from "next/server";

// Deliberately DB-free: deploy-watch phase 3 asserts "this build serves
// traffic on this domain"; database health is the backup canary's job.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    ok: true,
    sha: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev",
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/app/api/health/route.test.ts`
Expected: PASS — 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/health/route.ts src/app/api/health/route.test.ts
git commit -m "feat(health): DB-free /api/health returns the deployed commit sha"
```

---

### Task 3: Pin `/api/health` pass-through in `proxy()`

**Files:**
- Create: `src/proxy.test.ts`

Pass-through is structural — `proxy()` (`src/proxy.ts`) has no rewrite path at all and its matcher doesn't exclude `/api/*` — so this is a characterization test, not red-green TDD: it pins today's behavior so a future rewrite path can't silently swallow `/api/health`. (`src/middleware-routing.test.ts` tests the pure `classifyHost` helper and is the wrong home for this.)

- [ ] **Step 1: Write the pin test**

Create `src/proxy.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

afterEach(() => vi.unstubAllEnvs());

function run(host: string, extraHeaders: Record<string, string> = {}) {
  return proxy(
    new NextRequest(`http://${host}/api/health`, {
      headers: { host, ...extraHeaders },
    }),
  );
}

// NextResponse.next() encodes its verdict in response headers:
//   x-middleware-rewrite      → present only when a rewrite happened
//   x-middleware-request-*    → the request headers passed to the route
//   x-middleware-override-headers → the full list of forwarded header keys
describe("proxy() passes /api/health through unrewritten", () => {
  it.each([
    ["serveos.tech", "marketing"], // prod apex
    ["www.serveos.tech", "marketing"], // prod www
    ["ghost.serveos.tech", "storefront"], // unknown tenant still passes through
  ])("%s → surface %s, no rewrite", (host, surface) => {
    vi.stubEnv("ROOT_DOMAIN", "serveos.tech");
    const res = run(host);
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-surface")).toBe(surface);
  });

  it("qa apex (ROOT_DOMAIN=qa.serveos.tech) → marketing, no rewrite", () => {
    vi.stubEnv("ROOT_DOMAIN", "qa.serveos.tech");
    const res = run("qa.serveos.tech");
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-surface")).toBe("marketing");
  });

  it("sets the tenant slug for a storefront host", () => {
    vi.stubEnv("ROOT_DOMAIN", "serveos.tech");
    const res = run("roma.serveos.tech");
    expect(res.headers.get("x-middleware-request-x-surface")).toBe("storefront");
    expect(res.headers.get("x-middleware-request-x-tenant-slug")).toBe("roma");
  });

  it("strips a spoofed x-tenant-slug on non-storefront hosts", () => {
    vi.stubEnv("ROOT_DOMAIN", "serveos.tech");
    const res = run("www.serveos.tech", { "x-tenant-slug": "evil" });
    expect(res.headers.get("x-middleware-request-x-tenant-slug")).toBeNull();
    expect(res.headers.get("x-middleware-override-headers")).not.toContain(
      "x-tenant-slug",
    );
  });
});
```

- [ ] **Step 2: Run it — expect immediate PASS**

Run: `npx vitest run src/proxy.test.ts`
Expected: PASS — 6 passed (the `it.each` counts as 3). If any case fails, `proxy()` has diverged from the spec's assumption — stop and re-read `src/proxy.ts` before touching anything else.

- [ ] **Step 3: Commit**

```bash
git add src/proxy.test.ts
git commit -m "test(proxy): pin /api/health pass-through on every host class"
```

---

### Task 4: `scripts/ci-e2e-hours.ts` — widen roma to 24/7 in CI

**Files:**
- Create: `scripts/ci-e2e-hours.ts`

Why: the seed sets roma's hours to 10:00–23:00 and `placeOrder` validates opening hours against the real clock (`src/server/ordering/service.ts`), so immediate-order e2e flows fail whenever CI runs outside that window — a clock-deterministic flake `retries: 2` can't fix. `open === close` means "open 24h" (`src/server/branches/orderability.ts:19`).

- [ ] **Step 1: Write the script**

Create `scripts/ci-e2e-hours.ts` (same dotenv preamble + dynamic-import pattern as `scripts/seed.ts`):

```ts
import { config } from "dotenv";
config({ path: process.env.ENV_FILE ?? ".env.local", override: true });

/**
 * CI-only companion to db:seed. Widens every roma branch to 24/7 so
 * immediate-order e2e flows can't fail when the runner's clock is outside
 * the seeded 10:00–23:00 window. open === close means "open 24h"
 * (src/server/branches/orderability.ts).
 *
 *   ENV_FILE=.env.test npx tsx scripts/ci-e2e-hours.ts
 */
async function main() {
  const { pool } = await import("../src/db/client");
  const { getTenantBySlug } = await import("../src/server/tenancy");
  const { listBranches, updateBranchOrdering } = await import(
    "../src/server/branches/service"
  );

  const tenant = await getTenantBySlug("roma");
  if (!tenant) throw new Error("roma tenant not found — run db:seed first");
  const branches = await listBranches(tenant.id);
  if (branches.length === 0) throw new Error("roma has no branches — run db:seed first");

  for (const branch of branches) {
    await updateBranchOrdering(tenant.id, branch.id, {
      acceptingOrders: true,
      openingHours: Array.from({ length: 7 }, (_, day) => ({
        day,
        open: "00:00",
        close: "00:00",
        closed: false,
      })),
    });
  }
  console.log(`Widened ${branches.length} roma branch(es) to 24/7`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Verify locally (needs the local test DB; otherwise CI proves it in Task 7)**

```bash
ENV_FILE=.env.test npm run db:seed
ENV_FILE=.env.test npx tsx scripts/ci-e2e-hours.ts
```

Expected: last line `Widened 1 roma branch(es) to 24/7`, exit code 0 (the process must terminate on its own — that's what `pool.end()` is for).

- [ ] **Step 3: Commit**

```bash
git add scripts/ci-e2e-hours.ts
git commit -m "feat(scripts): ci-e2e-hours widens roma to 24/7 for CI e2e runs"
```

---

### Task 5: `playwright.config.ts` CI switches

**Files:**
- Modify: `playwright.config.ts` (whole file — it's 12 lines today)

- [ ] **Step 1: Replace the config**

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  retries: process.env.CI ? 2 : 0,
  // Spec files share one mutable seeded database (offline-payment enables a
  // payment method and creates orders that ordering/scheduling/dashboard
  // specs render), so CI must run them serially. Locally the default
  // parallelism stays — dev runs target a disposable dev DB.
  workers: process.env.CI ? 1 : undefined,
  use: {
    baseURL: "http://localhost:3000",
    trace: process.env.CI ? "on-first-retry" : "off",
  },
  webServer: {
    // CI runs `npm run build` as its own job step first (a build failure
    // should be its own red step, not a webServer timeout).
    command: process.env.CI ? "npm run start" : "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
```

- [ ] **Step 2: Sanity-check the config parses and still finds all specs**

Run: `npx playwright test --list | tail -3`
Expected: a list of tests ending with `Total: N tests in 11 files`, exit 0.

- [ ] **Step 3: Commit**

```bash
git add playwright.config.ts
git commit -m "ci(e2e): playwright CI mode — prod server, serial workers, retries and trace"
```

---

### Task 6: `.github/workflows/deploy-watch.yml`

**Files:**
- Create: `.github/workflows/deploy-watch.yml`

Three phases per the spec, Component 2. Notes baked in below: no `target=production` filter (would silently break the qa leg if the project's Production Branch setting drifts); `concurrency.cancel-in-progress` so racing pushes can't false-red; phase 3 follows redirects and skips when superseded. `jq`, `curl`, and `gh` are preinstalled on `ubuntu-latest`.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/deploy-watch.yml`:

```yaml
name: Deploy Watch

# Vercel auto-deploys main/qa with no feedback loop: a push that never becomes
# a deployment (the 2026-08-03 cron rejection), never reaches READY, or never
# reaches the domain is invisible to CI. This workflow makes each of those a
# red run. See docs/moai/specs/2026-08-09-ci-e2e-and-deploy-watch-design.md.
on:
  push:
    branches: [main, qa]
  workflow_dispatch:
    inputs:
      sha:
        description: "Commit SHA to watch (defaults to the branch head)"
        required: false

# Two pushes racing inside the ~20-minute watch window would otherwise
# false-red: the older run's phase 3 sees the domain (correctly) serving the
# newer SHA. Newer push wins; the stale watch is cancelled.
concurrency:
  group: deploy-watch-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  watch:
    # Dispatch only from main or qa — any other ref maps to the qa project.
    runs-on: ubuntu-latest
    timeout-minutes: 25
    env:
      SHA: ${{ inputs.sha || github.sha }}
      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
      # Project IDs are not sensitive without a token; inline beats secrets
      # for greppability. main → serve-os, qa → serve-os-qa.
      PROJECT_ID: ${{ github.ref_name == 'main' && 'prj_qdLE3YwFEsATt8gaKdgLeJBWzcs2' || 'prj_T2r2hWgyqU02OmQDk2dRMtOqc9sZ' }}
      DOMAIN: ${{ github.ref_name == 'main' && 'https://www.serveos.tech' || 'https://qa.serveos.tech' }}
    steps:
      - name: "Phase 1: a deployment exists for this commit"
        id: find
        run: |
          echo "Watching $SHA on project $PROJECT_ID"
          deadline=$(( $(date +%s) + 300 ))
          while :; do
            resp=$(curl -sf -H "Authorization: Bearer $VERCEL_TOKEN" \
              "https://api.vercel.com/v6/deployments?projectId=$PROJECT_ID&meta-githubCommitSha=$SHA&limit=1") || resp="{}"
            uid=$(echo "$resp" | jq -r '.deployments[0].uid // empty')
            if [ -n "$uid" ]; then
              echo "Found deployment $uid"
              echo "uid=$uid" >> "$GITHUB_OUTPUT"
              exit 0
            fi
            if [ "$(date +%s)" -ge "$deadline" ]; then
              echo "::error::Vercel created no deployment for this push — likely rejected at validation (check vercel.json against plan limits). If curl errors appear above, suspect the token/API instead."
              exit 1
            fi
            echo "No deployment yet; retrying in 15s"
            sleep 15
          done

      - name: "Phase 2: the deployment reaches READY"
        run: |
          uid='${{ steps.find.outputs.uid }}'
          deadline=$(( $(date +%s) + 900 ))
          while :; do
            resp=$(curl -sf -H "Authorization: Bearer $VERCEL_TOKEN" \
              "https://api.vercel.com/v13/deployments/$uid") || resp="{}"
            state=$(echo "$resp" | jq -r '.readyState // empty')
            url=$(echo "$resp" | jq -r '.url // empty')
            case "$state" in
              READY)
                echo "READY: https://$url"
                exit 0 ;;
              ERROR|CANCELED)
                echo "::error::Deployment ended $state: https://$url"
                exit 1 ;;
            esac
            if [ "$(date +%s)" -ge "$deadline" ]; then
              echo "::error::Deployment still '$state' after 15 minutes: https://$url"
              exit 1
            fi
            echo "State: ${state:-unknown}; retrying in 20s"
            sleep 20
          done

      - name: "Phase 3: the live domain serves this commit"
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          deadline=$(( $(date +%s) + 120 ))
          while :; do
            # -L: if Vercel ever redirects apex↔www, a non-following GET
            # would see a 307/308 instead of JSON.
            body=$(curl -sfL "$DOMAIN/api/health" || true)
            live=$(echo "$body" | jq -r '.sha // empty' 2>/dev/null || true)
            if [ "$live" = "$SHA" ]; then
              echo "$DOMAIN serves $SHA"
              exit 0
            fi
            if [ "$(date +%s)" -ge "$deadline" ]; then
              # Superseded-push guard: a newer push may have gone live while
              # we watched (dispatch runs, or the cancellation race).
              head=$(gh api "repos/${{ github.repository }}/branches/${{ github.ref_name }}" --jq .commit.sha)
              if [ "$head" != "$SHA" ]; then
                echo "::notice::Superseded — ${{ github.ref_name }} has moved to $head and the domain serves '$live'. Skipping."
                exit 0
              fi
              echo "::error::$DOMAIN serves '$live', expected $SHA — the READY build is not live on the domain."
              exit 1
            fi
            echo "Domain serves '${live:-nothing}'; retrying in 10s"
            sleep 10
          done
```

- [ ] **Step 2: Validate the YAML parses**

Run: `npx --yes js-yaml .github/workflows/deploy-watch.yml > /dev/null && echo YAML-OK`
Expected: `YAML-OK`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy-watch.yml
git commit -m "ci(deploy): deploy-watch verifies push -> deployment -> live domain"
```

---

### Task 7: `e2e` job + `qa` trigger in `.github/workflows/ci.yml`

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add `qa` to the push trigger**

In `.github/workflows/ci.yml`, change the `on:` block (currently lines 6–9):

```yaml
on:
  pull_request:
  push:
    # qa is a deploy branch: it gets the full gate (typecheck + test + e2e),
    # deliberately — not just the e2e job.
    branches: [main, qa]
```

- [ ] **Step 2: Append the `e2e` job**

Add at the end of the file, aligned with the existing `typecheck:` and `test:` keys under `jobs:`:

```yaml
  e2e:
    name: e2e
    runs-on: ubuntu-latest
    timeout-minutes: 30

    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 10

    # Job-level on purpose: `next build`/`next start` don't read .env.test,
    # and the Playwright process itself queries the database in beforeAll
    # (offline-payment.spec.ts), so every step needs these — not just two.
    env:
      DATABASE_URL: postgresql://serveos_ci:serveos_ci@localhost:5432/serveos_test
      ROOT_DOMAIN: serveos.localhost

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - run: npm ci

      - name: Create the non-superuser role and test database
        env:
          PGPASSWORD: postgres
        run: psql -h localhost -U postgres -d postgres -v ON_ERROR_STOP=1 -f scripts/ci-db-bootstrap.sql

      # The db scripts and seeds read .env.test via ENV_FILE; CI writes its own.
      - name: Write .env.test
        run: |
          {
            echo "DATABASE_URL=$DATABASE_URL"
            echo "ROOT_DOMAIN=$ROOT_DOMAIN"
          } > .env.test

      - name: Apply migrations
        run: npm run db:migrate:test

      # Two seeds, both required: roma (9 of 11 specs) + nobio retail
      # (shop.spec.ts, storefront-responsive.spec.ts).
      - name: Seed roma tenant
        run: ENV_FILE=.env.test npm run db:seed

      - name: Seed nobio retail tenant
        run: ENV_FILE=.env.test npx tsx scripts/seed-retail-showcase.ts

      # The seed's 10:00-23:00 window + real-clock order validation would
      # flake any run outside business hours.
      - name: Widen roma hours to 24/7
        run: ENV_FILE=.env.test npx tsx scripts/ci-e2e-hours.ts

      - name: Install chromium
        run: npx playwright install --with-deps chromium

      # Its own step so a build failure is a red "Build", not an opaque
      # webServer timeout inside Playwright.
      - name: Build
        run: npm run build

      - name: E2E
        run: npm run test:e2e

      - name: Upload Playwright artifacts
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-artifacts
          path: |
            playwright-report/
            test-results/
          retention-days: 7
```

- [ ] **Step 3: Validate the YAML parses**

Run: `npx --yes js-yaml .github/workflows/ci.yml > /dev/null && echo YAML-OK`
Expected: `YAML-OK`

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci(e2e): run the Playwright suite on PRs and main/qa pushes"
```

---

### Task 8: Prove it — PR, deliberate red, watchdog dispatches

Per the spec's "Testing the work itself". The PR itself proves the e2e job; the watchdog can only be proven after merge (its trigger is push to main/qa) with `VERCEL_TOKEN` in place (Task 1).

- [ ] **Step 1: Push and open a PR**

```bash
git push -u origin HEAD:feat/ci-e2e-deploy-watch
gh pr create --title "CI E2E job + Vercel deploy watchdog" \
  --body "Implements docs/moai/specs/2026-08-09-ci-e2e-and-deploy-watch-design.md (spec review applied 2026-08-10). Plan: docs/moai/plans/2026-08-10-ci-e2e-and-deploy-watch.md"
```

(GitHub writes need the `mohanedsayed` account.) Expected: PR URL printed; the `e2e` job appears in the PR checks and goes green in ~10–15 min.

- [ ] **Step 2: One deliberate red to prove artifacts upload**

On the PR branch, break one spec assertion (e.g. in `tests/e2e/menu.spec.ts`, change an expected string to `"THIS-SHOULD-FAIL"`), commit, push:

```bash
git commit -am "test: deliberate red to prove artifact upload (revert me)"
git push
```

Expected: `e2e` job fails after retries; the run's Summary page shows a `playwright-artifacts` artifact containing `playwright-report/`. Then revert:

```bash
git revert --no-edit HEAD
git push
```

Expected: `e2e` green again.

- [ ] **Step 3: Merge, then watchdog green path**

After merge (and Task 1 done), the merge push itself runs deploy-watch — watch it:

```bash
gh run list --workflow deploy-watch.yml --limit 3
```

Expected: the run for the merge commit goes green in ~2–6 min (all three phases). This also proves `/api/health` live: `curl -sL https://www.serveos.tech/api/health` returns `{"ok":true,"sha":"<merge sha>"}`.

- [ ] **Step 4: Watchdog red path (bogus SHA)**

```bash
gh workflow run deploy-watch.yml --ref main -f sha=0000000000000000000000000000000000000000
gh run watch $(gh run list --workflow deploy-watch.yml --limit 1 --json databaseId --jq '.[0].databaseId')
```

Expected: phase 1 polls for 5 minutes, then fails with *"Vercel created no deployment for this push…"* — the exact failure mode from the 2026-08-03 incident is now a red run.

- [ ] **Step 5: Off-hours e2e run**

Re-run the `e2e` job (or push any commit) at least once outside 10:00–23:00 Cairo time. Expected: green — proving the hours-widening step killed the clock dependence.

---

## Execution notes

- Tasks 2–7 are independent of Task 1; only Task 8 Step 3+ needs the secret.
- Task order within 2–7 mirrors the spec's rollout order; keep the commits separate as written — they bisect cleanly.
- The spec's rollout order (health route → watchdog → e2e) exists because deploy-watch phase 3 needs `/api/health` deployed. A single PR satisfies it atomically: the merge push that adds `deploy-watch.yml` also contains the route, so the watchdog's first-ever run already has its endpoint. Three sequential PRs are unnecessary.
- If the runner can't resolve `*.serveos.localhost` (spec says chromium resolves any `*.localhost` to loopback; believed but unproven on runners), add exactly three `/etc/hosts` entries in the e2e job before the E2E step — `serveos.localhost`, `roma.serveos.localhost`, `nobio.serveos.localhost` — no wildcards:

```yaml
      - name: Map tenant hosts to loopback
        run: |
          {
            echo "127.0.0.1 serveos.localhost"
            echo "127.0.0.1 roma.serveos.localhost"
            echo "127.0.0.1 nobio.serveos.localhost"
          } | sudo tee -a /etc/hosts
```
