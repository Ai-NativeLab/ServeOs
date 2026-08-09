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

    > ⚠️ **QA is on the `aws-0` pooler; prod is on `aws-1`.** Supabase assigns the
    > pooler per project, and the two differ by one character. Pointing QA at
    > `aws-1` fails with **"Tenant or user not found"**, which reads like a paused
    > project or bad password — it is neither. Copy the host from the project's own
    > Connect dialog rather than from another environment.

    | Name | Value |
    |---|---|
    | `DATABASE_URL` | `postgresql://app.<QA_REF>:<APP_ROLE_PASSWORD>@aws-0-eu-central-1.pooler.supabase.com:6543/postgres` |
    | `ROOT_DOMAIN` | `qa.serveos.tech` |
    | `SUPABASE_URL` | `https://<QA_REF>.supabase.co` |
    | `SUPABASE_SERVICE_ROLE_KEY` | QA project's service_role key |
    | `SERVEOS_PAYTO` | test/sandbox value — never the prod payment target |

    Check the prod project's env list for anything added since this doc was
    written; every extra var gets a QA-safe value here.
- [ ] Settings → Git → Production Branch: `qa`.
- [ ] Settings → Domains → add `qa.serveos.tech` and `*.qa.serveos.tech`
      (serveos.tech is already on Vercel nameservers for the prod wildcard, so
      both should verify automatically; fix DNS in Vercel's dashboard if not).
      `serveos.com` only 302-redirects to `serveos.tech` — it is not the app domain.

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
gh secret set QA_DATABASE_URL   --body 'postgresql://postgres.<QA_REF>:<QA_DB_PASSWORD>@aws-0-eu-central-1.pooler.supabase.com:5432/postgres'
gh secret set R2_ACCOUNT_ID     --body '<CLOUDFLARE_ACCOUNT_ID>'
gh secret set R2_ACCESS_KEY_ID  --body '<R2_ACCESS_KEY_ID>'
gh secret set R2_SECRET_ACCESS_KEY --body '<R2_SECRET_ACCESS_KEY>'
```

## 6. Local — .env.qa (gitignored by the existing `.env*` rule)

```bash
cat > .env.qa <<'EOF'
DATABASE_URL=postgresql://app.<QA_REF>:<APP_ROLE_PASSWORD>@aws-0-eu-central-1.pooler.supabase.com:6543/postgres
ROOT_DOMAIN=qa.serveos.tech
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
