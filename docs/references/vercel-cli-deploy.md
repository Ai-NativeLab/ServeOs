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

```bash
npm i -g vercel
vercel link            # choose serve-os      → cat .vercel/project.json
vercel link            # choose serve-os-qa   → cat .vercel/project.json
```

`.vercel/` is gitignored — read the ids, don't commit them.

Add all four under **Settings → Secrets and variables → Actions → Secrets**.

## Cutover

The workflow is **inert until you set one variable**, so merging it is safe:

1. Add the four secrets above.
2. **Settings → Secrets and variables → Actions → Variables** → add `VERCEL_DEPLOY_ENABLED` = `true`.
3. Push a no-op commit to `main` and confirm the `production` job deploys and `serveos.tech` serves it.
4. **Only then** disconnect Vercel's Git integration — Vercel → each project → Settings → Git → Disconnect.
   Skipping this means **both** paths deploy on every push.
5. Flip the repo to private: GitHub → Settings → Danger Zone → Change visibility.
6. Re-run a deploy and confirm it still works now that Vercel can no longer see the repo.

Reverse it by unsetting `VERCEL_DEPLOY_ENABLED` and reconnecting the Git integration — but note step 5 is the one that matters: **once the repo is private, the Git integration cannot work**, so don't go private until CI deploys are proven.

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

- The production build **applies database migrations** before the deploy goes live, so the `production` job must have the real production env. `vercel pull --environment=production` fetches it — do not hand-roll the env vars.
- The QA project treats the **`qa` branch as its production environment**, which is why the `qa` job also deploys with `--prod`, just against a different project id.
- `ELECTRON_SKIP_BINARY_DOWNLOAD=1` is set for the same reason as in `ci.yml`: `apps/pos` carries electron as a devDependency and its postinstall pulls ~100 MB that nothing here needs.
- Preview deploys use the **prod project's** preview environment. If you'd rather previews point at the QA database, swap `VERCEL_PROJECT_ID_PROD` for `VERCEL_PROJECT_ID_QA` in the `preview` job.
