# Deploying to Vercel from CI (and going private)

Runbook for `.github/workflows/vercel-deploy.yml`.

## Why this exists

Vercel's **Hobby** plan refuses to deploy a **private** repository owned by a **GitHub organisation**. `Ai-NativeLab/ServeOs` is public today, which is the only reason deploys work — flipping it to private breaks **production**, not just previews.

Building in GitHub Actions and uploading a *prebuilt* deployment sidesteps the restriction: Vercel never pulls the source, it just receives an already-built artifact.

**What this does not fix:** Hobby still caps crons at once per day (`vercel.json` runs the notifications worker at `0 3 * * *` for that reason), and Hobby is **not licensed for commercial use**. If either matters, Pro at $20/user/month is the honest answer and makes this workflow unnecessary.

## What you need

| Secret | Where to get it |
|---|---|
| `VERCEL_TOKEN` | Vercel → Account Settings → Tokens → Create. Scope it to the team that owns the projects. |
| `VERCEL_ORG_ID` | `vercel link` in the repo, then read `.vercel/project.json` → `orgId`. Same for both projects. |
| `VERCEL_PROJECT_ID_PROD` | `.vercel/project.json` → `projectId` after linking **serve-os** |
| `VERCEL_PROJECT_ID_QA` | same, after linking **serve-os-qa** |
| `PROD_DATABASE_URL` | The **same** connection string as `DATABASE_URL` in the serve-os project's Production env. The `production` job migrates with it. |
| `QA_DATABASE_URL` | The **same** connection string as `DATABASE_URL` in the serve-os-qa project's Production env. The `qa` job migrates with it. |

```bash
npm i -g vercel@65.5.0
vercel link            # choose serve-os      → cat .vercel/project.json
vercel link            # choose serve-os-qa   → cat .vercel/project.json
```

`.vercel/` is gitignored — read the ids, don't commit them.

Add all six under **Settings → Secrets and variables → Actions → Secrets** (repository secrets, or the `production` / `qa` environment secrets for the two database URLs).

## Cutover

The workflow is **inert until you set one variable**, so merging it is safe:

1. Add the six secrets above.
2. **Settings → Secrets and variables → Actions → Variables** → add `VERCEL_DEPLOY_ENABLED` = `true`.
3. Push a no-op commit to `main` and confirm the `production` job deploys and `serveos.tech` serves it.
4. **Only then** disconnect Vercel's Git integration — Vercel → each project → Settings → Git → Disconnect.
   Skipping this means **both** paths deploy on every push.
5. Flip the repo to private: GitHub → Settings → Danger Zone → Change visibility.
6. Re-run a deploy and confirm it still works now that Vercel can no longer see the repo.

Reverse it by unsetting `VERCEL_DEPLOY_ENABLED` and reconnecting the Git integration — but note step 5 is the one that matters: **once the repo is private, the Git integration cannot work**, so don't go private until CI deploys are proven.

## Migrated but not activated

The `production` and `qa` jobs migrate the database **during the build** (`release-migrate`), then upload and activate the deployment in a separate step. If the build succeeds and the deploy step fails, hits its 10-minute limit, or is cancelled (for example by a newer push to the same branch), the schema is already migrated but the **previous deployment is still live** against it. The job then fails with `schema migrated, deploy not activated` in the log and the run summary.

What to do:

1. Check what Vercel did with the upload: `vercel ls serve-os` (or `serve-os-qa`) and `vercel inspect <deployment-url>`. A deployment stuck in `UNKNOWN` or `QUEUED` never activated.
2. Re-run the failed job. Migrations are already applied, so `release-migrate` is a no-op on the second run; only the deploy repeats.
3. Until the new code is live, the old code runs on the new schema. That is harmless for additive migrations and breaks for anything that drops or renames what the old code reads, which is one more reason to keep migrations additive and drop columns in a later release.

## What changes for reviewers

| | Git integration (now) | Actions + CLI (after) |
|---|---|---|
| Preview per PR | automatic, Vercel comments the URL | this workflow builds and comments the URL |
| Commit status | `Vercel – serve-os` | `vercel-deploy / preview` |
| Production on `main` | automatic | `production` job |
| QA on `qa` | automatic | `qa` job |
| Build minutes | Vercel's | **your GitHub Actions minutes** |

That last row is the real cost. Each preview now runs `npm ci` + a full Next build on an Actions runner. Public repos get unlimited free minutes; **private repos do not** — the free tier is 2,000 minutes/month. Going private is exactly when this workflow starts consuming a quota, so watch it for the first month.

## Notes specific to this repo

- The production build **applies database migrations** before the deploy goes live, so the `production` job must have the real production env. `vercel pull --environment=production` fetches it, and apart from `DATABASE_URL` it is the only source: do not hand-roll env vars in the workflow.
- **`DATABASE_URL` is the one exception.** The `production` and `qa` jobs delete it from the pulled file and build (so migrate) with `PROD_DATABASE_URL` / `QA_DATABASE_URL` instead, because the pulled value reached `release-migrate` with a broken host (`base`). Why that happens is not confirmed; see PR #162. The deployed app still reads `DATABASE_URL` from the Vercel project at runtime, so **migrations and runtime now read two different copies of the same connection string**.
- **Rotate the database password in two places:** the Vercel project's `DATABASE_URL` **and** the matching GitHub secret. Before every build, `.github/scripts/use-secret-database-url.sh` compares the host and username of the two (printing only the hosts) and fails the job if they differ, so a half-done rotation stops the deploy before anything migrates rather than migrating one database and serving another. It cannot see a password-only change: if only the password was rotated in one place, either the migration fails to connect or the app does.
- The QA project treats the **`qa` branch as its production environment**, which is why the `qa` job also deploys with `--prod`, just against a different project id.
- `ELECTRON_SKIP_BINARY_DOWNLOAD=1` is set for the same reason as in `ci.yml`: `apps/pos` carries electron as a devDependency and its postinstall pulls ~100 MB that nothing here needs.
- Preview deploys use the **prod project's** preview environment. If you'd rather previews point at the QA database, swap `VERCEL_PROJECT_ID_PROD` for `VERCEL_PROJECT_ID_QA` in the `preview` job.
