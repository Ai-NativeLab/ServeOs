# Developer Onboarding

## 1. Set up your machine

Follow **[docs/NEW-LAPTOP-SETUP.md](../NEW-LAPTOP-SETUP.md)**. It is the maintained, step-by-step guide (Node 22.23.1 via nvm, Postgres 16 in Docker on port 5433, the `serveos_app` role that owns both databases, `.env.local` / `.env.test`, migrations, seeds, `/etc/hosts`, test users and troubleshooting). This page does not repeat it, so the two cannot drift apart.

The short version, matching that guide:

```bash
git clone https://github.com/Ai-NativeLab/ServeOs.git && cd ServeOs
nvm install 22.23.1 && nvm use 22.23.1   # the repo has no .nvmrc; name the version
npm ci
docker run -d --name serveos-pg -e POSTGRES_PASSWORD=postgres -p 5433:5432 postgres:16
docker exec -i serveos-pg psql -U postgres <<'SQL'
CREATE ROLE serveos_app WITH LOGIN PASSWORD 'serveos' CREATEDB NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE serveos      OWNER serveos_app;
CREATE DATABASE serveos_test OWNER serveos_app;
SQL
printf 'DATABASE_URL=postgresql://serveos_app:serveos@127.0.0.1:5433/serveos\nROOT_DOMAIN=serveos.localhost\n' > .env.local
printf 'DATABASE_URL=postgresql://serveos_app:serveos@127.0.0.1:5433/serveos_test\nROOT_DOMAIN=serveos.localhost\n' > .env.test
npm run db:migrate && npm run db:migrate:test
npm run db:seed
npm run dev        # http://serveos.localhost:3000
```

**Why the role matters:** the schema uses `FORCE ROW LEVEL SECURITY`, which binds every role except superusers and `BYPASSRLS` roles. If `serveos_app` were a superuser, RLS would be **bypassed** — queries would return every tenant's rows and the isolation tests would pass vacuously.

## 2. Read next

1. [CONTEXT.md](../../CONTEXT.md) — the domain vocabulary.
2. [Architecture overview](../architecture/overview.md) — surfaces, routing (`src/proxy.ts`), modules, tenancy, POS, deployment.
3. [Codebase conventions](./codebase-conventions.md) — where code goes and the patterns to copy.
4. [Functional overview](../requirements/functional.md) and [state machines](../flows/state-machines.md).
5. [API index](../api/README.md) and [tables reference](../database/tables.md) — both generated from source.
6. `AGENTS.md` — this Next.js version has breaking changes; read `node_modules/next/dist/docs/` before using a Next API.

## 3. Running the POS

```bash
npm run pos:dev          # Electron + Vite, next to `npm run dev`
```

Pair the till either with a code from **Dashboard → Settings → POS devices** (8 characters, valid 10 minutes) or by signing in as an owner/manager (slug + email + password). Then a cashier signs in with email + password. To work against the test database instead: `npm run pos:demo:code` seeds the `posdemo` tenant there and prints a pairing code, and `npm run pos:demo:web` serves the web app against the test DB.

## 4. Tests

| Command | What it runs |
|---|---|
| `npm test` | Vitest, DB-backed, against the migrated `serveos_test` DB; files run serially and truncate between tests |
| `npm run test:unit` | the no-DB Vitest subset |
| `npm run pos:test`, `npm run pos:typecheck` | the Electron app's suite |
| `npm run test:e2e` | Playwright (`tests/e2e/`); needs a seeded dev DB and `npx playwright install` once |

POS server tests should start from `seedPosContext()` and `openShiftForCtx()` in `src/server/pos/test-helpers.ts` and ring sales with `recordSale`. See [testing strategy](../testing/testing-strategy-and-gaps.md).

## 5. Changing the schema

Edit the module's schema file, run `npm run db:generate`, add any RLS statements to the generated SQL by hand, then `npm run db:migrate && npm run db:migrate:test`. Regenerate [tables.md](../database/tables.md) afterwards.

## 6. Environments

Production deploys from `main`, QA (`qa.serveos.tech`) from `qa` (`git push origin main:qa` to promote). A production deploy runs pending migrations in the Vercel build. Details: [environments.md](../references/environments.md), [qa-environment-setup.md](../references/qa-environment-setup.md), [backup-restore.md](../references/backup-restore.md).
