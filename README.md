# ServeOS

Multi-tenant restaurant/commerce platform: tenancy with Postgres Row-Level
Security, self-hosted auth + RBAC, plans/entitlements, ordering + catalog,
an **Electron POS**, manual billing behind a provider interface, onboarding
with admin approval, and per-tenant installable PWA storefronts. Built on
Next.js (App Router) + Drizzle + Postgres.

> **Spec sequencing:** [docs/ROADMAP.md](docs/ROADMAP.md) is the map of what
> ships in what order (Specs 1–11 + platform tracks). Check it before filing
> new feature work.

## Surfaces

Host-based routing via `src/proxy.ts`, plus one desktop app:

- `{slug}.serveos.com` — tenant storefront (installable PWA)
- `app.serveos.com` — restaurant dashboard (`/register`, `/login`)
- `admin.serveos.com` — platform admin console (`/admin`)
- bare root — marketing site
- **`apps/pos`** — Electron POS for the till: pairing, cashier sign-in, sales,
  drawer/shifts, X/Z reports. Talks to `/api/pos/v1/*` on the web app.

Local hosts use `.localhost` (e.g. `roma.serveos.localhost`). For browser
testing of subdomains locally, add entries to `/etc/hosts`
(e.g. `127.0.0.1 roma.serveos.localhost`).

## Setup

The complete, current walkthrough (local Postgres in Docker, env files, seeds,
hosts) lives in **[docs/NEW-LAPTOP-SETUP.md](docs/NEW-LAPTOP-SETUP.md)** — use
it for a fresh machine. Short version:

1. Postgres with a `NOBYPASSRLS` role and two databases (`serveos`,
   `serveos_test`) — RLS isolation tests are vacuous under a superuser.
2. `.env.local` and `.env.test` (both gitignored) with `DATABASE_URL` and
   `ROOT_DOMAIN=serveos.localhost`.
3. `npm ci`
4. `npm run db:migrate` (dev DB) and `npm run db:migrate:test` (test DB)
5. `npm run db:seed` — platform admin, demo restaurant `roma`, demo users
6. `npm run dev` — web app on `serveos.localhost:3000`

### Running the POS

```bash
npm run pos:dev        # Electron + Vite dev, in a second terminal next to npm run dev
```

First run pairs the device: sign in as an owner/manager (slug + email +
password) or enter a pairing code minted from the dashboard, then a cashier
signs in on the till. Every POS request carries the device's Bearer token plus
an `X-POS-Cashier` header; the server scopes reads/writes to that device and
branch (`requirePosCashier`).

`npm run pos:demo:code` seeds a POS demo tenant on the **test** DB and prints
a pairing code; `npm run pos:demo:web` serves the web app against the test DB
to pair against.

## Testing

- `npm run test` — unit + integration (Vitest, DB-backed; needs the migrated
  `serveos_test` DB). Files run serially — they share one database and
  truncate between tests; do not parallelise.
- `npm run pos:test` / `npm run pos:typecheck` — the Electron app's own suite.
- `npm run test:e2e` — Playwright smoke test (storefront PWA manifest + branding).
- POS server tests seed through `seedPosContext` + `openShiftForCtx`
  (`src/server/pos/test-helpers.ts`) and ring sales with `recordSale` — start
  from those fixtures rather than hand-building devices and cashiers.
- CI (`.github/workflows/ci.yml`) runs typecheck, migration-drift check and the
  full suite on every PR, as a non-superuser role so RLS is actually exercised.

## Architecture

Business logic lives in framework-agnostic modules under `src/server/<domain>/`
(tenancy, auth, rbac, subscription, entitlements, billing, onboarding, platform,
branches, catalog, ordering, **pos**, analytics, audit), each exposing a service
via its `index.ts` barrel. Tenant data is isolated by a `tenant_id` column plus
FORCE Row-Level Security, enforced through the `withTenant()` transaction
wrapper. Plan limits are enforced through the single `entitlements` gate.
Subscription billing is abstracted behind `BillingProvider` (manual now;
payment gateways later).

The POS desktop app (`apps/pos`) keeps no business logic: the Electron main
process (`apps/pos/electron/pos-main.ts`) holds device/cashier tokens and
proxies typed calls to `/api/pos/v1/*`; the renderer talks to it over a
context-bridge (`window.pos`). Money math lives in `src/lib/order-totals.ts`
and drawer arithmetic in `src/server/pos/shift-math.ts` — one implementation
each, shared by every consumer.

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
