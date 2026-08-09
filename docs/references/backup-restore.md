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
3. Smoke-test `app.qa.serveos.tech` with a real prod account flow.
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
