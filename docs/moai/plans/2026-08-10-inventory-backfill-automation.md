# Inventory Backfill Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or build to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run `scripts/backfill-inventory.ts` automatically against prod and qa — after every verified deploy, daily, and on demand — so legacy-stock sellables reach the inventory ledger without anyone remembering to run a script.

**Architecture:** One new workflow, `.github/workflows/inventory-backfill.yml`. A tiny `targets` job computes the environment matrix (post-deploy → just the environment that deployed; schedule/dispatch → both), then a `backfill` job runs the existing idempotent script with `DATABASE_URL` from the matching secret. No app code changes.

**Tech Stack:** GitHub Actions, `tsx` (devDependency ^4.22.4), the existing `PROD_DATABASE_URL` / `QA_DATABASE_URL` secrets.

---

**Read first:** `docs/moai/specs/2026-08-10-inventory-backfill-automation-design.md` and `.github/workflows/db-backup.yml` (the matrix + secret + canary pattern this mirrors).

**Verified facts this plan relies on** (checked against the repo, not assumed):

- `scripts/backfill-inventory.ts` has **no dotenv preamble** — it reads `DATABASE_URL` from process env only. Its own header comment saying `ENV_FILE=.env.local npx tsx …` is wrong; `ENV_FILE` is ignored. Task 2 fixes that comment.
- `npx tsx scripts/backfill-inventory.ts` resolves the `@/…` path alias correctly and force-exits via `process.exit(0)` — no hang risk on a runner.
- Final output line is exactly `seeded N inventory item(s) across M tenant(s)`; the multi-branch block starts with `NEEDS A STOCK COUNT`.
- The script's logic is already unit-tested in `src/server/inventory/backfill.test.ts`, so this plan verifies **wiring**, not backfill semantics.
- `deploy-watch.yml`'s workflow name is exactly `Deploy Watch` (the `workflow_run` filter must match it verbatim).

## File Map

| File | Action | Responsibility |
|---|---|---|
| `.github/workflows/inventory-backfill.yml` | Create | Triggers, environment matrix, run + summary + canary |
| `docs/moai/specs/2026-08-10-inventory-backfill-automation-design.md` | Modify | Record the zero-tenant canary decision |
| `scripts/backfill-inventory.ts` | Modify (comment only) | Correct the misleading usage line |

---

### Task 1: The workflow

**Files:**
- Create: `.github/workflows/inventory-backfill.yml`
- Modify: `docs/moai/specs/2026-08-10-inventory-backfill-automation-design.md`

- [ ] **Step 1: Create the workflow**

```yaml
# Copies legacy flat-integer stock into the inventory ledger, so a sellable
# reaches the stock screens without waiting to be adopted on its first sale.
# The script is idempotent — an already-linked sellable is skipped — so an idle
# run is a few SELECTs. See docs/moai/specs/2026-08-10-inventory-backfill-automation-design.md
name: inventory-backfill

on:
  # After a deploy is verified live, backfill the environment that deployed.
  # By this point release-migrate has already applied the schema during the
  # Vercel build, so the ledger tables are guaranteed to exist.
  workflow_run:
    workflows: ["Deploy Watch"]
    types: [completed]
  # Catches sellables created via the legacy path between deploys. Offset from
  # db-backup's 03:00 so the two never contend.
  schedule:
    - cron: "0 4 * * *"
  workflow_dispatch:

permissions:
  contents: read

env:
  ELECTRON_SKIP_BINARY_DOWNLOAD: "1"

jobs:
  targets:
    # A failed or skipped Deploy Watch means the deployment is not live; there
    # is nothing to backfill and the schema may not even be current.
    if: github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    outputs:
      matrix: ${{ steps.pick.outputs.matrix }}
    steps:
      - name: Pick the environments to backfill
        id: pick
        env:
          EVENT: ${{ github.event_name }}
          HEAD_BRANCH: ${{ github.event.workflow_run.head_branch }}
        run: |
          set -euo pipefail
          PROD='{"env_name":"prod","url_secret":"PROD_DATABASE_URL"}'
          QA='{"env_name":"qa","url_secret":"QA_DATABASE_URL"}'
          if [ "$EVENT" = "workflow_run" ]; then
            case "$HEAD_BRANCH" in
              main) M="[$PROD]" ;;
              qa)   M="[$QA]" ;;
              # Deploy Watch only runs on main/qa, so this is unreachable — but
              # an empty matrix is safer than defaulting to the wrong database.
              *)    M="[]" ;;
            esac
          else
            M="[$PROD,$QA]"
          fi
          echo "targets: $M"
          echo "matrix=$M" >> "$GITHUB_OUTPUT"

  backfill:
    needs: targets
    if: needs.targets.outputs.matrix != '[]'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    strategy:
      fail-fast: false
      matrix:
        target: ${{ fromJSON(needs.targets.outputs.matrix) }}
    # No cancel-in-progress: a queued run should follow the one in flight, not
    # replace it, so two runs never write the same database at once.
    concurrency:
      group: inventory-backfill-${{ matrix.target.env_name }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - run: npm ci

      - name: Backfill ${{ matrix.target.env_name }}
        env:
          # The script reads DATABASE_URL from process env — it loads no .env file.
          DATABASE_URL: ${{ secrets[matrix.target.url_secret] }}
        run: |
          set -euo pipefail
          if [ -z "${DATABASE_URL:-}" ]; then
            echo "::error::secret ${{ matrix.target.url_secret }} is not set"
            exit 1
          fi
          npx tsx scripts/backfill-inventory.ts 2>&1 | tee backfill.log

      - name: Publish the run summary
        if: always()
        run: |
          {
            echo "### Inventory backfill — ${{ matrix.target.env_name }}"
            echo ""
            echo '```'
            cat backfill.log 2>/dev/null || echo "(the backfill step produced no output)"
            echo '```'
          } >> "$GITHUB_STEP_SUMMARY"
          if grep -qF "NEEDS A STOCK COUNT" backfill.log 2>/dev/null; then
            echo "::warning::${{ matrix.target.env_name }}: a multi-branch tenant was seeded — the opening balance landed on its oldest branch only, so the others need a physical stock count. Tenant list is in the run summary."
          fi

      - name: Zero-tenant canary
        # The same failure db-backup guards against: a role that connects fine
        # but sees no rows would make an empty no-op look like a clean success
        # forever. Both environments always have tenants.
        run: |
          set -euo pipefail
          if grep -qF "across 0 tenant(s)" backfill.log; then
            echo "::error::backfill saw 0 tenants in ${{ matrix.target.env_name }} — the role cannot read public.tenants (RLS/grants) or the database is empty. Refusing to report success."
            exit 1
          fi
```

- [ ] **Step 2: Validate the YAML**

Run: `npx --yes js-yaml .github/workflows/inventory-backfill.yml > /dev/null && echo YAML-OK`
Expected: `YAML-OK`

- [ ] **Step 3: Record the canary in the spec**

In `docs/moai/specs/2026-08-10-inventory-backfill-automation-design.md`, under `### Visibility`, add this bullet after the `NEEDS A STOCK COUNT` one:

```markdown
- A **zero-tenant canary** fails the job when the script reports `across 0
  tenant(s)`. Both environments always have tenants, so zero means the role
  cannot read `public.tenants` (RLS/grants) or the database is empty — the
  same silent-success failure `db-backup.yml`'s row-count canary exists to
  catch. Without it, a misconfigured role would report a clean green no-op
  indefinitely.
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/inventory-backfill.yml docs/moai/specs/2026-08-10-inventory-backfill-automation-design.md
git commit -m "ci(inventory): back-fill the stock ledger after deploys and nightly"
```

---

### Task 2: Correct the script's usage comment — SUPERSEDED, do not implement

**Superseded by PR #131** (`fix/backfill-env`), which fixes the same trap the
better way: it adds the standard `ENV_FILE` dotenv preamble so the documented
command works as written, matching every other script in `scripts/`. This
task's comment-only fix was reverted from this branch (commit `eb2f899`) so
the two changes cannot contradict each other — a textual auto-merge would
have left a comment saying "no .env file is loaded" directly above a line
loading one. The workflow is unaffected either way: it passes `DATABASE_URL`
as step env, and dotenv finds no `.env.local` on a runner, so nothing
overrides it.

Kept below for the record only.

**Files:**
- ~~Modify: `scripts/backfill-inventory.ts:27`~~ (no longer part of this branch)

The header says `Run: ENV_FILE=.env.local npx tsx scripts/backfill-inventory.ts`, but this script loads no dotenv file — `ENV_FILE` does nothing and the run dies with "DATABASE_URL is not set". An operator following it exactly gets a confusing failure.

- [ ] **Step 1: Fix the comment**

Replace line 27:

```
 * Run: ENV_FILE=.env.local npx tsx scripts/backfill-inventory.ts
```

with:

```
 * Reads DATABASE_URL from the environment (no .env file is loaded — ENV_FILE
 * has no effect here, unlike the seed scripts):
 *
 *   DATABASE_URL="$(grep -E '^DATABASE_URL=' .env.local | cut -d= -f2-)" \
 *     npx tsx scripts/backfill-inventory.ts
```

- [ ] **Step 2: Verify the script still runs**

```bash
DATABASE_URL="$(grep -E '^DATABASE_URL=' .env.test | cut -d= -f2-)" npx tsx scripts/backfill-inventory.ts
```

Expected: a final line of the form `seeded 0 inventory item(s) across 2 tenant(s)` (counts vary with the local database) and exit code 0. A comment change cannot alter behavior; this just proves the documented command works.

- [ ] **Step 3: Commit**

```bash
git add scripts/backfill-inventory.ts
git commit -m "docs(scripts): backfill reads DATABASE_URL directly, not ENV_FILE"
```

---

### Task 3: Prove it (post-merge, manual)

The `workflow_run` leg cannot fire until both this workflow and Deploy Watch are on `main` — `workflow_run` only triggers from the default branch's copy of a workflow.

- [ ] **Step 1: Dispatch once and read the summary**

```bash
gh workflow run inventory-backfill.yml --repo Ai-NativeLab/ServeOs
gh run list --workflow inventory-backfill.yml --repo Ai-NativeLab/ServeOs --limit 1
```

Expected: both matrix legs green; each run summary shows `### Inventory backfill — prod|qa` with the script's per-tenant lines. If a multi-branch tenant was seeded, a warning annotation names it — schedule the physical stock count.

- [ ] **Step 2: Dispatch again to prove idempotency**

Expected: same green result, with every previously-seeded sellable now reported under "already linked" and `seeded 0 inventory item(s)`.

- [ ] **Step 3: Confirm the automatic legs**

- After the next push to `main`/`qa`: an `inventory-backfill` run appears, triggered by Deploy Watch, targeting only that environment.
- The next morning: a 04:00 UTC scheduled run covering both.

---

## Self-review

**Spec coverage:** triggers (Task 1 Step 1: `workflow_run` + `schedule` + `workflow_dispatch`), matrix/secrets (same step), step summary + stock-count warning (same step), concurrency (same step), no-migrations non-goal (nothing in the workflow touches schema; the spec states it), testing (Task 3). The canary is an addition beyond the approved design and is written back into the spec in Task 1 Step 3.

**No placeholders:** every step has literal content or a literal command with expected output.

**Consistency:** `matrix.target.env_name` / `matrix.target.url_secret` are used identically in the concurrency group, the secret lookup, the summary heading, and both annotations; `backfill.log` is the same filename in all three steps that touch it.
