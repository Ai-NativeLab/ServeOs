# QA Environment + Database Backups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a persistent QA environment (own Supabase DB, own Vercel project on the `qa` branch, `*.qa.serveos.com`) and automated daily/weekly `pg_dump` backups of prod + QA to Cloudflare R2.

**Architecture:** Two new GitHub Actions workflows (scheduled backup, manual restore drill) plus two docs (operator setup checklist, restore runbook). All cloud-console work (Supabase/Vercel/Cloudflare/DNS/secrets) is operator-executed from the checklist — agents cannot click consoles. Repo work lands on `main` first because scheduled workflows only fire from the default branch.

**Tech Stack:** GitHub Actions, `pg_dump`/`pg_restore` 17 (PGDG), AWS CLI → R2 S3 API, Supabase session pooler.

**Spec:** `docs/superpowers/specs/2026-07-29-qa-environment-and-backups-design.md`

## Global Constraints

- Running cost must stay ~$0/month: Supabase Free ×2, Vercel Hobby, R2 free tier, GitHub Actions free minutes.
- Backups connect via **session pooler `aws-1-eu-central-1.pooler.supabase.com:5432`** (GitHub runners are IPv4-only; free Supabase has no IPv4 direct connection; transaction pooler 6543 cannot run `pg_dump`).
- Backup/restore run as the Supabase **`postgres` role** (has `BYPASSRLS`; the `app` role would fail under FORCE RLS). App traffic keeps using the `app` role.
- Dumps cover schemas **`public` + `drizzle`** only (all app data + migration journal; Supabase system schemas are not ours to restore).
- Nothing automated ever writes to prod. The restore drill is `workflow_dispatch`-only and hard-coded to restore **into QA**.
- Prod user data never lands in QA except via the deliberate restore drill, which ends with a re-seed.
- R2 bucket `serveos-backups`, layout `{prod|qa}/{daily|weekly}/serveos-{env}-YYYY-MM-DD.dump`; retention via R2 lifecycle rules (daily 14 d, weekly 90 d), never via code.
- No changes to `scripts/release-migrate.ts` or `src/db/release-guard.ts` — the QA Vercel project reuses them as-is because pushes to `qa` are that project's *production* deployments.
- Commits are authored by Mohaned Sayed only (no co-authors).

---

### Task 1: Working branch

**Files:** none (git only)

**Interfaces:**
- Produces: branch `feat/qa-env-backups` off `main`, carrying the spec commit; all later repo tasks commit here.

- [ ] **Step 1: Create the branch off main and bring the spec along**

```bash
git fetch origin
git checkout -b feat/qa-env-backups origin/main
git cherry-pick 7e853dc   # docs(specs): design the QA environment and the prod/QA backup pipeline
```

- [ ] **Step 2: Verify**

Run: `git log --oneline -2 && git status`
Expected: cherry-picked spec commit on top of origin/main, clean tree.

---

### Task 2: Backup workflow

**Files:**
- Create: `.github/workflows/db-backup.yml`

**Interfaces:**
- Consumes: GitHub secrets `PROD_DATABASE_URL`, `QA_DATABASE_URL` (postgres-role, session pooler :5432), `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (created in Task 6).
- Produces: R2 objects `{env}/daily/serveos-{env}-YYYY-MM-DD.dump`, plus `{env}/weekly/...` on Sundays; workflow name `db-backup` used by Task 7's `gh workflow run db-backup.yml`.

- [ ] **Step 1: Write the workflow**

```yaml
# Nightly logical backups of the prod and QA databases to Cloudflare R2.
# Retention is enforced by R2 lifecycle rules (daily 14d, weekly 90d), not here.
name: db-backup

on:
  schedule:
    - cron: "0 3 * * *"
  workflow_dispatch:
    inputs:
      force_weekly:
        description: "Also write this dump under weekly/ (normally Sundays only)"
        type: boolean
        default: false

permissions:
  contents: read

env:
  R2_BUCKET: serveos-backups

jobs:
  dump:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        include:
          - env_name: prod
            url_secret: PROD_DATABASE_URL
          - env_name: qa
            url_secret: QA_DATABASE_URL
    steps:
      - name: Install PostgreSQL 17 client (PGDG)
        run: |
          curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/pgdg.gpg
          echo "deb https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list
          sudo apt-get update -qq
          sudo apt-get install -y -qq postgresql-client-17

      - name: Row-count canary
        # The failure this exists to catch: a role that connects fine but sees no
        # rows (RLS misconfiguration) would otherwise upload green-but-empty dumps.
        env:
          DB_URL: ${{ secrets[matrix.url_secret] }}
        run: |
          set -euo pipefail
          if [ -z "$DB_URL" ]; then echo "::error::secret ${{ matrix.url_secret }} is not set"; exit 1; fi
          USERS=$(/usr/lib/postgresql/17/bin/psql "$DB_URL" -Atc "select count(*) from public.users")
          echo "users rows visible to backup role: $USERS"
          if [ "$USERS" = "0" ]; then
            echo "::error::backup role sees 0 rows in public.users — RLS/grants are wrong, refusing to back up"
            exit 1
          fi

      - name: Dump ${{ matrix.env_name }} (public + drizzle schemas)
        env:
          DB_URL: ${{ secrets[matrix.url_secret] }}
        run: |
          set -euo pipefail
          FILE="serveos-${{ matrix.env_name }}-$(date -u +%F).dump"
          echo "FILE=$FILE" >> "$GITHUB_ENV"
          /usr/lib/postgresql/17/bin/pg_dump "$DB_URL" \
            --format=custom \
            --schema=public --schema=drizzle \
            --file="$FILE"
          ls -lh "$FILE"
          TABLES=$(/usr/lib/postgresql/17/bin/pg_restore --list "$FILE" | grep -c 'TABLE DATA')
          echo "TABLE DATA entries: $TABLES"
          if [ "$TABLES" -lt 5 ]; then
            echo "::error::dump contains only $TABLES tables — refusing to upload"
            exit 1
          fi

      - name: Upload daily to R2
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
          AWS_DEFAULT_REGION: auto
          AWS_ENDPOINT_URL: https://${{ secrets.R2_ACCOUNT_ID }}.r2.cloudflarestorage.com
        run: aws s3 cp "$FILE" "s3://${R2_BUCKET}/${{ matrix.env_name }}/daily/${FILE}"

      - name: Upload weekly copy (Sundays, or forced via dispatch)
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
          AWS_DEFAULT_REGION: auto
          AWS_ENDPOINT_URL: https://${{ secrets.R2_ACCOUNT_ID }}.r2.cloudflarestorage.com
        run: |
          if [ "$(date -u +%u)" = "7" ] || [ "${{ inputs.force_weekly }}" = "true" ]; then
            aws s3 cp "$FILE" "s3://${R2_BUCKET}/${{ matrix.env_name }}/weekly/${FILE}"
          else
            echo "Not Sunday and not forced — skipping weekly copy."
          fi
```

- [ ] **Step 2: Validate YAML syntax**

Run: `npx --yes js-yaml .github/workflows/db-backup.yml > /dev/null && echo OK`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/db-backup.yml
git commit -m "feat(ops): nightly prod+QA pg_dump backups to R2 with weekly retention tier"
```

---

### Task 3: Restore-drill workflow

**Files:**
- Create: `.github/workflows/db-restore-drill.yml`

**Interfaces:**
- Consumes: same secrets as Task 2; R2 `prod/daily/` objects produced by Task 2.
- Produces: workflow name `db-restore-drill` used in Task 8; restores **into QA only**.

- [ ] **Step 1: Write the workflow**

```yaml
# Restore drill: load the newest prod dump into the QA database.
# Manual-only, confirmation-gated, and structurally unable to touch prod:
# the only connection string used for writes is QA_DATABASE_URL.
# Afterwards QA holds prod data — finish the drill by re-seeding QA
# (see docs/references/backup-restore.md).
name: db-restore-drill

on:
  workflow_dispatch:
    inputs:
      confirm:
        description: 'Type "restore-into-qa" to confirm OVERWRITING the QA database'
        required: true

permissions:
  contents: read

jobs:
  restore:
    runs-on: ubuntu-latest
    steps:
      - name: Check confirmation phrase
        run: |
          if [ "${{ inputs.confirm }}" != "restore-into-qa" ]; then
            echo "::error::confirmation phrase mismatch — nothing was touched"
            exit 1
          fi

      - name: Install PostgreSQL 17 client (PGDG)
        run: |
          curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/pgdg.gpg
          echo "deb https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list
          sudo apt-get update -qq
          sudo apt-get install -y -qq postgresql-client-17

      - name: Download newest prod daily dump
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
          AWS_DEFAULT_REGION: auto
          AWS_ENDPOINT_URL: https://${{ secrets.R2_ACCOUNT_ID }}.r2.cloudflarestorage.com
        run: |
          set -euo pipefail
          KEY=$(aws s3 ls "s3://serveos-backups/prod/daily/" | sort | tail -1 | awk '{print $4}')
          if [ -z "$KEY" ]; then echo "::error::no prod dumps found in R2"; exit 1; fi
          echo "Restoring: $KEY"
          aws s3 cp "s3://serveos-backups/prod/daily/${KEY}" prod.dump

      - name: Restore into QA
        env:
          DB_URL: ${{ secrets.QA_DATABASE_URL }}
        run: |
          set -euo pipefail
          /usr/lib/postgresql/17/bin/pg_restore \
            --clean --if-exists --no-owner --no-privileges \
            --dbname="$DB_URL" prod.dump

      - name: Hand restored objects to the app role
        # pg_restore ran as postgres, so postgres owns everything it created.
        # The app connects as `app` and FORCE RLS policies must apply to it,
        # so ownership and grants have to be put back the way migrations
        # would have left them.
        env:
          DB_URL: ${{ secrets.QA_DATABASE_URL }}
        run: |
          /usr/lib/postgresql/17/bin/psql "$DB_URL" <<'SQL'
          do $$
          declare r record;
          begin
            for r in select schemaname, tablename from pg_tables where schemaname in ('public','drizzle') loop
              execute format('alter table %I.%I owner to app', r.schemaname, r.tablename);
            end loop;
            for r in select schemaname, sequencename from pg_sequences where schemaname = 'public' loop
              execute format('alter sequence %I.%I owner to app', r.schemaname, r.sequencename);
            end loop;
          end $$;
          grant usage on schema public, drizzle to app;
          grant all on all tables in schema public, drizzle to app;
          grant all on all sequences in schema public to app;
          SQL

      - name: Verify restored data
        env:
          DB_URL: ${{ secrets.QA_DATABASE_URL }}
        run: |
          set -euo pipefail
          USERS=$(/usr/lib/postgresql/17/bin/psql "$DB_URL" -Atc "select count(*) from public.users")
          TENANTS=$(/usr/lib/postgresql/17/bin/psql "$DB_URL" -Atc "select count(*) from public.tenants")
          echo "restored users=$USERS tenants=$TENANTS"
          if [ "$USERS" = "0" ]; then
            echo "::error::restore completed but users is empty"
            exit 1
          fi
```

- [ ] **Step 2: Validate YAML syntax**

Run: `npx --yes js-yaml .github/workflows/db-restore-drill.yml > /dev/null && echo OK`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/db-restore-drill.yml
git commit -m "feat(ops): confirmation-gated drill that restores the latest prod dump into QA"
```

---

### Task 4: Restore runbook

**Files:**
- Create: `docs/references/backup-restore.md`

**Interfaces:**
- Consumes: workflow names from Tasks 2–3, R2 layout from Global Constraints.
- Produces: the document §8 and §9's verification steps follow.

- [ ] **Step 1: Write the runbook** with exactly this content:

````markdown
# Backup & Restore Runbook

Backups: `.github/workflows/db-backup.yml` dumps prod and QA nightly (03:00 UTC)
to R2 `serveos-backups` — `{env}/daily/` kept 14 days, `{env}/weekly/` (written
Sundays) kept 90 days, expiry enforced by R2 lifecycle rules. Dumps are
`pg_dump --format=custom`, schemas `public` + `drizzle`, taken as the `postgres`
role (`BYPASSRLS`) over the session pooler (port 5432).

**What is NOT in a dump:** files in Supabase Storage (tenant media in the
`media` bucket). A restored database will reference image URLs that only exist
if the storage bucket still does. Media backup is a known gap, accepted for now.

## Restore drill (prod dump → QA) — run quarterly

1. GitHub → Actions → `db-restore-drill` → Run workflow → type `restore-into-qa`.
2. The job downloads the newest `prod/daily/` dump, restores it into QA,
   re-points ownership/grants at the `app` role, and verifies row counts.
3. Smoke-test `app.qa.serveos.com` with a real prod account flow.
4. **Finish by re-seeding QA** so prod user data does not linger there:

    ```bash
    ENV_FILE=.env.qa npm run db:seed
    ENV_FILE=.env.qa npm run admin:check -- --fix
    ```

## Disaster restore (prod dump → prod)

Manual only, deliberately not automated. From a trusted machine with
PostgreSQL 17 client tools:

```bash
# 1. Fetch the dump (Cloudflare dashboard, or aws cli with R2 creds):
aws s3 cp s3://serveos-backups/prod/daily/serveos-prod-YYYY-MM-DD.dump . \
  --endpoint-url https://<ACCOUNT_ID>.r2.cloudflarestorage.com

# 2. STOP writes: Vercel → serveos project → pause deployments/traffic if possible.

# 3. Restore as the postgres role over the session pooler (:5432):
pg_restore --clean --if-exists --no-owner --no-privileges \
  --dbname "$PROD_DATABASE_URL" serveos-prod-YYYY-MM-DD.dump

# 4. Re-point ownership at the app role (same SQL the drill workflow runs —
#    see "Hand restored objects to the app role" in db-restore-drill.yml).

# 5. Verify: row counts, then log in and click through a storefront + dashboard.
```

## If a nightly backup fails

- Read the failed `db-backup` run log first.
- `0 rows visible` canary error → grants/RLS problem: run `GRANT app TO postgres;`
  in the affected project's SQL editor (Supabase console).
- Connection timeout on the **qa** matrix leg → the free-tier QA project likely
  auto-paused (7 idle days). Restore it from the Supabase dashboard.
- Cron not firing at all → GitHub disables schedules after 60 days without repo
  activity; push any commit and re-enable the workflow under Actions.

## Email safety note

The app currently sends no email. When an email provider lands (Resend per the
WhatsApp-ordering spec), the QA Vercel project MUST get a test/sandbox key —
never the production key.
````

- [ ] **Step 2: Verify the file renders** (no broken fences)

Run: `grep -c '```' docs/references/backup-restore.md`
Expected: an even number (all code fences closed).

- [ ] **Step 3: Commit**

```bash
git add docs/references/backup-restore.md
git commit -m "docs(ops): backup layout, restore drill, and disaster-restore runbook"
```

---

### Task 5: Operator setup checklist (console work)

**Files:**
- Create: `docs/references/qa-environment-setup.md`

**Interfaces:**
- Produces: the checklist the operator (Mohaned) executes in Task 6. Secret names here must match Task 2/3 exactly: `PROD_DATABASE_URL`, `QA_DATABASE_URL`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.

- [ ] **Step 1: Write the checklist** with exactly this content:

````markdown
# QA Environment — One-Time Setup Checklist

Console work only a human can do. Do it top to bottom; repo-side automation
(`db-backup` / `db-restore-drill` workflows) assumes every box is ticked.

## 1. Supabase — QA project

- [ ] Create project `serveos-qa`, region **eu-central-1 (Frankfurt)**, Free plan.
      Save the database password in the password manager.
- [ ] SQL editor — create the app role (same shape as prod; generate a strong password):

    ```sql
    create role app login password '<APP_ROLE_PASSWORD>' nobypassrls;
    grant usage, create on schema public to app;
    grant create on database postgres to app;   -- lets migrations create the drizzle schema
    grant app to postgres;                      -- lets postgres dump/restore app-owned tables
    ```

- [ ] Storage → create bucket `media`, **public** (mirrors prod; media-upload
      route writes to it).
- [ ] Note the project ref (`<QA_REF>`) and the service_role key
      (Settings → API).

## 2. Supabase — prod project (one-time SQL)

- [ ] SQL editor, verify the backup role can bypass RLS:

    ```sql
    select rolbypassrls from pg_roles where rolname = 'postgres';  -- must be true
    ```

    If it is **false**, stop — the backup design assumes BYPASSRLS; raise it
    before continuing.
- [ ] Grant the backup role access to app-owned tables:

    ```sql
    grant app to postgres;
    ```

## 3. Vercel — QA project

- [ ] Add New Project → import `Ai-NativeLab/ServeOs` again → name `serveos-qa`.
      The very first deploy may fail (env vars missing) — expected, ignore it.
- [ ] Settings → Environment Variables (environment: **Production**). Do NOT mark
      `DATABASE_URL` as Sensitive — the build-time migration step must read it:

    | Name | Value |
    |---|---|
    | `DATABASE_URL` | `postgresql://app.<QA_REF>:<APP_ROLE_PASSWORD>@aws-1-eu-central-1.pooler.supabase.com:6543/postgres` |
    | `ROOT_DOMAIN` | `qa.serveos.com` |
    | `SUPABASE_URL` | `https://<QA_REF>.supabase.co` |
    | `SUPABASE_SERVICE_ROLE_KEY` | QA project's service_role key |
    | `SERVEOS_PAYTO` | test/sandbox value — never the prod payment target |

    Check the prod project's env list for anything added since this doc was
    written; every extra var gets a QA-safe value here.
- [ ] Settings → Git → Production Branch: `qa`.
- [ ] Settings → Domains → add `qa.serveos.com` and `*.qa.serveos.com`
      (serveos.com is already on Vercel nameservers for the prod wildcard, so
      both should verify automatically; fix DNS in Vercel's dashboard if not).

## 4. Cloudflare — R2

- [ ] Create bucket `serveos-backups` (location hint: EU).
- [ ] Object lifecycle rules (bucket → Settings):

    | Prefix | Delete after |
    |---|---|
    | `prod/daily/` | 14 days |
    | `qa/daily/` | 14 days |
    | `prod/weekly/` | 90 days |
    | `qa/weekly/` | 90 days |

- [ ] R2 API token: **Object Read & Write**, scoped to `serveos-backups` only.
      Record Account ID, Access Key ID, Secret Access Key.

## 5. GitHub — repo secrets

Both database secrets use the **postgres** role and the **session pooler,
port 5432** (not 6543 — pg_dump needs session mode; not the direct host —
Actions runners have no IPv6):

```bash
gh secret set PROD_DATABASE_URL --body 'postgresql://postgres.<PROD_REF>:<PROD_DB_PASSWORD>@aws-1-eu-central-1.pooler.supabase.com:5432/postgres'
gh secret set QA_DATABASE_URL   --body 'postgresql://postgres.<QA_REF>:<QA_DB_PASSWORD>@aws-1-eu-central-1.pooler.supabase.com:5432/postgres'
gh secret set R2_ACCOUNT_ID     --body '<CLOUDFLARE_ACCOUNT_ID>'
gh secret set R2_ACCESS_KEY_ID  --body '<R2_ACCESS_KEY_ID>'
gh secret set R2_SECRET_ACCESS_KEY --body '<R2_SECRET_ACCESS_KEY>'
```

## 6. Local — .env.qa (gitignored by the existing `.env*` rule)

```bash
cat > .env.qa <<'EOF'
DATABASE_URL=postgresql://app.<QA_REF>:<APP_ROLE_PASSWORD>@aws-1-eu-central-1.pooler.supabase.com:6543/postgres
ROOT_DOMAIN=qa.serveos.com
EOF
```

## 7. First QA deploy + seed (after 1–6)

```bash
git checkout main && git pull
git branch qa && git push -u origin qa      # Vercel deploys + migrates QA
ENV_FILE=.env.qa npm run db:check           # schema is complete
ENV_FILE=.env.qa npm run db:seed            # synthetic data only
ENV_FILE=.env.qa npm run admin:check -- --fix
```

Optional showcase tenants: `ENV_FILE=.env.qa npx tsx scripts/seed-showcase.ts`
````

- [ ] **Step 2: Verify fences balanced**

Run: `grep -c '```' docs/references/qa-environment-setup.md`
Expected: an even number.

- [ ] **Step 3: Commit**

```bash
git add docs/references/qa-environment-setup.md
git commit -m "docs(ops): console checklist for standing up the QA environment"
```

---

### Task 6: OPERATOR GATE — console setup + merge to main

**Files:** none (human + GitHub)

**Interfaces:**
- Consumes: Task 5's checklist.
- Produces: live QA Supabase/Vercel projects, R2 bucket + lifecycle, all 5 GitHub secrets, workflows on `main`, `qa` branch deployed and seeded.

- [ ] **Step 1: Open a PR for `feat/qa-env-backups` → `main` and merge it.** Scheduled workflows only run from the default branch — nothing fires until this lands.
- [ ] **Step 2 (operator):** Work through `docs/references/qa-environment-setup.md` sections 1–6.
- [ ] **Step 3 (operator):** Section 7 — create/push `qa`, then verify the Vercel build log shows `release-migrate` applying migrations, then seed.
- [ ] **Step 4: QA smoke test:** on `app.qa.serveos.com` log in as the seeded owner, open the seeded storefront at `<slug>.qa.serveos.com`, upload an image in the dashboard (proves the QA `media` bucket + service key). Confirm prod (`serveos.com`) is untouched.

---

### Task 7: First backup run verification

**Files:** none (gh CLI + R2)

**Interfaces:**
- Consumes: merged `db-backup` workflow, Task 6's secrets.
- Produces: trusted backups — spec acceptance criterion "a dump is spot-checked for actual row counts before the job is trusted".

- [ ] **Step 1: Dispatch with the weekly tier forced**

```bash
gh workflow run db-backup.yml -f force_weekly=true
gh run watch $(gh run list --workflow=db-backup.yml --limit 1 --json databaseId -q '.[0].databaseId')
```

Expected: both matrix legs (prod, qa) green; logs show non-zero `users rows visible` and `TABLE DATA entries` ≥ 5 for each.

- [ ] **Step 2: Spot-check a dump locally** (operator has R2 creds; requires pg_restore ≥ server major — use the same PGDG 17 client or Cloudflare dashboard download):

```bash
aws s3 cp s3://serveos-backups/prod/daily/serveos-prod-$(date -u +%F).dump /tmp/spot.dump \
  --endpoint-url https://<ACCOUNT_ID>.r2.cloudflarestorage.com
pg_restore --list /tmp/spot.dump | grep -c 'TABLE DATA'   # expect: dozens
```

- [ ] **Step 3: Confirm all four R2 prefixes exist** (`prod/daily`, `prod/weekly`, `qa/daily`, `qa/weekly`) and lifecycle rules show against them in the Cloudflare dashboard.
- [ ] **Step 4: Next morning, confirm the 03:00 UTC scheduled run succeeded on its own.**

---

### Task 8: Restore drill

**Files:** none (gh CLI)

**Interfaces:**
- Consumes: `db-restore-drill` workflow, a prod dump in R2 (Task 7).
- Produces: spec success criterion 4 — a prod dump restored into QA at least once.

- [ ] **Step 1: Run the drill**

```bash
gh workflow run db-restore-drill.yml -f confirm=restore-into-qa
gh run watch $(gh run list --workflow=db-restore-drill.yml --limit 1 --json databaseId -q '.[0].databaseId')
```

Expected: green; log shows `restored users=N tenants=M` with N, M > 0.

- [ ] **Step 2: Verify QA serves the restored data** — a known prod tenant's storefront renders at `<prod-slug>.qa.serveos.com`.

- [ ] **Step 3: Re-seed QA immediately** (prod data must not linger):

```bash
ENV_FILE=.env.qa npm run db:seed
ENV_FILE=.env.qa npm run admin:check -- --fix
```

- [ ] **Step 4: Mark the spec's success criteria** — walk `docs/superpowers/specs/2026-07-29-qa-environment-and-backups-design.md` §Success criteria 1–5 and confirm each holds.
