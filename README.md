# ServeOS

Multi-tenant commerce and operations platform: tenancy with Postgres Row-Level
Security, self-hosted auth + RBAC, plans/entitlements, catalog + ordering across
storefront, POS and WhatsApp, inventory and purchasing, an **Electron POS** with
offline sync, manual billing behind a provider interface, onboarding with admin
approval, and per-tenant installable PWA storefronts. Built on Next.js 16 (App
Router) + Drizzle + Postgres.

> **Full documentation:** [docs/README.md](docs/README.md).
> **Spec sequencing:** [docs/ROADMAP.md](docs/ROADMAP.md) is the map of what
> ships in what order (Specs 1–11 + platform tracks). Check it before filing
> new feature work.

## Surfaces

Host-based routing via `src/proxy.ts`, plus one desktop app:

| Surface | URL | Purpose |
|---|---|---|
| Storefront (installable PWA) | `{slug}.serveos.tech` | Customer ordering |
| Merchant dashboard | `app.serveos.tech` (`/register`, `/login`, `/dashboard`) | Catalog, orders, inventory, purchasing, settings |
| Admin console | `admin.serveos.tech` (`/admin`) | Platform administration |
| Marketing site | `serveos.tech` / `www.serveos.tech` | Landing, pricing, enquiries (Arabic default, `/en` for English) |
| QA | `qa.serveos.tech` (+ the same subdomain layout) | The QA environment |
| Desktop POS | **`apps/pos`** (Electron) | Pairing, cashier sign-in, sales, drawer/shifts, X/Z reports, offline sync. Talks to `/api/pos/v1/*` |

Local hosts use `.localhost` (e.g. `roma.serveos.localhost`). Chrome resolves
`*.localhost` itself; for other browsers add entries to `/etc/hosts`
(e.g. `127.0.0.1 roma.serveos.localhost`).

## Setup

The complete, current walkthrough (local Postgres 16 in Docker, env files,
seeds, hosts) lives in **[docs/NEW-LAPTOP-SETUP.md](docs/NEW-LAPTOP-SETUP.md)** —
use it for a fresh machine. Short version:

1. Node 22.23.1 (`nvm install 22.23.1 && nvm use 22.23.1` — there is no `.nvmrc`).
2. Postgres with a `NOSUPERUSER NOBYPASSRLS` role (`serveos_app`) owning two
   databases (`serveos`, `serveos_test`). A superuser bypasses RLS, which makes
   the isolation tests vacuous.
3. `.env.local` and `.env.test` (both gitignored) with `DATABASE_URL` and
   `ROOT_DOMAIN=serveos.localhost`.
4. `npm ci`
5. `npm run db:migrate` (dev DB) and `npm run db:migrate:test` (test DB)
6. `npm run db:seed` — platform admin, demo restaurant `roma`, demo users
7. `npm run dev` — web app on `serveos.localhost:3000`

### Running the POS

```bash
npm run pos:dev        # Electron + Vite dev, in a second terminal next to npm run dev
```

First run pairs the device: sign in as an owner/manager (slug + email +
password) or enter a pairing code minted in the dashboard (**Settings → POS
devices**; 8 characters, valid 10 minutes). Then a cashier signs in on the till
with email + password. Every POS request carries the device's Bearer token, and
cashier actions add an `X-POS-Cashier` header; the server scopes reads/writes to
that device's tenant and branch (`requirePosDevice` / `requirePosCashier`).

`npm run pos:demo:code` seeds a POS demo tenant on the **test** DB and prints
a pairing code; `npm run pos:demo:web` serves the web app against the test DB
to pair against.

## Testing

- `npm test` — unit + integration (Vitest, DB-backed; needs the migrated
  `serveos_test` DB). Files run serially — they share one database and
  truncate between tests; do not parallelise.
- `npm run test:unit` — the no-DB subset.
- `npm run pos:test` / `npm run pos:typecheck` — the Electron app's own suite.
- `npm run test:e2e` — Playwright E2E suite (`tests/e2e/`, 13 specs: admin,
  dashboard, marketing, menu, offline payment, onboarding, ordering, pricing,
  purchasing, responsive, scheduling, shop, storefront-responsive). Needs a
  seeded dev DB (`npm run db:seed`); boots the dev server itself.
- POS server tests seed through `seedPosContext` + `openShiftForCtx`
  (`src/server/pos/test-helpers.ts`) and ring sales with `recordSale` — start
  from those fixtures rather than hand-building devices and cashiers.
- CI (`.github/workflows/ci.yml`) runs typecheck, the migration check and the
  full suite on every PR as a non-superuser role so RLS is actually exercised,
  and builds + runs the e2e suite.

More: [docs/testing/testing-strategy-and-gaps.md](docs/testing/testing-strategy-and-gaps.md).

## Environments, deploys & backups

Full infrastructure map (domains, Vercel/Supabase projects, secrets, and the
pitfalls that have actually bitten us):
**[docs/references/environments.md](docs/references/environments.md)**.

| Env | URL | Deploys on | Database |
|---|---|---|---|
| Production | `www.serveos.tech` | push to `main` | Supabase prod (aws-1 pooler) |
| QA | `qa.serveos.tech` | push to `qa` | Supabase `ServeOs-qa` (aws-0 pooler) |

Both Vercel projects run migrations during the production build
(`vercel-build` → `scripts/release-migrate.ts`), so a deploy IS a migration.
Promote main to QA with `git push origin main:qa`. A push to `main` also
creates a **Preview** deployment on `serve-os-qa`, which neither serves
`qa.serveos.tech` nor migrates; until `qa` is promoted, QA's schema lags main
(the nightly `demo-reset` workflow migrates QA from `main` before seeding).
QA bring-up checklist:
[docs/references/qa-environment-setup.md](docs/references/qa-environment-setup.md).

Nightly `pg_dump` backups of both databases go to Cloudflare R2 at 03:00 UTC
(`db-backup.yml`); restore procedure and the quarterly drill live in
[docs/references/backup-restore.md](docs/references/backup-restore.md).

## Architecture

Business logic lives in framework-agnostic modules under `src/server/<domain>/`
(27 of them — tenancy, auth, rbac, catalog, ordering, **pos**, inventory,
purchasing, audit, whatsapp, …). Tenant data is isolated by a `tenant_id`
column plus FORCE Row-Level Security, enforced through the `withTenant()`
transaction wrapper. Plan limits go through the `entitlements` gate.
Subscription billing is abstracted behind `BillingProvider` (manual now;
payment gateways later).

The POS desktop app (`apps/pos`): the Electron main process
(`apps/pos/electron/pos-main.ts`) holds device/cashier tokens and makes the
typed calls to `/api/pos/v1/*`; the renderer talks to it over a context-bridge
(`window.pos`). A local SQLite event log (`apps/pos/electron/_offline/`) keeps
the till selling offline and replays to the server on reconnect. Money math
lives in `src/lib/order-totals.ts` and drawer arithmetic in
`src/server/pos/shift-math.ts` — one implementation each.

More: [docs/architecture/overview.md](docs/architecture/overview.md).

## Local test users

Seeded by `npm run db:seed`:

| Surface | URL | Credentials |
|---|---|---|
| Platform admin | `admin.serveos.localhost:3000/admin/login` | `admin@serveos.com` / `admin1234` |
| Roma owner | `app.serveos.localhost:3000/login` (slug `roma`) | `owner@roma.com` / `owner1234` |
| Roma manager | same | `manager@roma.com` / `manager1234` |
| Roma staff | same | `staff@roma.com` / `staff1234` |

Local seed credentials only — production rotation is covered in
[docs/NEW-LAPTOP-SETUP.md](docs/NEW-LAPTOP-SETUP.md) (Part 3b).

## Where the docs live

- [docs/README.md](docs/README.md) — documentation index (glossary, requirements,
  architecture, flows, database, API, testing)
- [CONTEXT.md](CONTEXT.md) — domain glossary
- [docs/ROADMAP.md](docs/ROADMAP.md) — spec sequencing + decisions (D1…)
- [docs/NEW-LAPTOP-SETUP.md](docs/NEW-LAPTOP-SETUP.md) — full machine setup
- [docs/references/](docs/references/) — operational truth: `environments.md`
  (infrastructure map), `qa-environment-setup.md` (QA bring-up checklist),
  `backup-restore.md` (backup layout + restore runbook), provider notes
- [docs/prds/](docs/prds/) — product requirements
- `docs/{ailab,superpowers,moai,adham-ai}/` — per-agent design specs and
  implementation plans, dated; each feature's `*-design.md` is the spec of
  record for how that subsystem works
