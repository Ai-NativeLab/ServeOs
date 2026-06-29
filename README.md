# ServeOS — Tenant & Subscription Core

Multi-tenant SaaS foundation for ServeOS: tenancy with Postgres Row-Level Security,
self-hosted auth + RBAC, plans/entitlements, manual billing behind a provider
interface, restaurant onboarding with admin approval, and per-tenant installable
PWA storefronts. Built on Next.js (App Router) + Drizzle + Supabase Postgres.

## Surfaces (host-based routing via `src/proxy.ts`)
- `{slug}.serveos.com` — tenant storefront (installable PWA)
- `app.serveos.com` — restaurant dashboard (`/register`, `/login`)
- `admin.serveos.com` — platform admin approval queue (`/admin`)
- bare root — marketing placeholder

Local hosts use `.localhost` (e.g. `roma.serveos.localhost`). For browser testing of
subdomains locally, add entries to `/etc/hosts` (e.g. `127.0.0.1 roma.serveos.localhost`).

## Setup
1. Create a Supabase project. Copy the **direct/session** connection string.
   Create the test database once (connect to the `postgres` db and run `CREATE DATABASE serveos_test;`).
2. Create `.env.local` (db `postgres`) and `.env.test` (db `serveos_test`), each with:
   ```
   DATABASE_URL=postgresql://<user>:<password>@<host>:5432/<db>
   ROOT_DOMAIN=serveos.localhost
   ```
   Both files are gitignored — never commit them. RLS isolation requires the DB role to be `NOBYPASSRLS`.
3. `npm install`
4. `npm run db:migrate` (dev DB) and `npm run db:migrate:test` (test DB)
5. `npm run db:seed` — creates platform admin `admin@serveos.com` / `admin1234`, demo restaurant owner `owner@roma.com` / `owner1234`, and a live `roma` storefront.
6. `npm run dev`

## Testing
- `npm run test` — unit + integration (Vitest; needs the `serveos_test` Supabase DB)
- `npm run test:e2e` — Playwright smoke test (storefront PWA manifest + branding)

## Architecture
Business logic lives in framework-agnostic modules under `src/server/<domain>/`
(tenancy, auth, rbac, subscription, entitlements, billing, onboarding, platform),
each exposing a service via its `index.ts` barrel. Tenant data is isolated by a
`tenant_id` column plus FORCE Row-Level Security, enforced through the
`withTenant()` transaction wrapper. Plan limits are enforced through the single
`entitlements` gate. Subscription billing is abstracted behind `BillingProvider`
(manual now; payment gateways later).

## Out of scope (later sub-projects)
Menu/catalog, ordering/checkout, payment gateways, WhatsApp commerce, reservations,
customer accounts, analytics. Cross-channel orders (web + WhatsApp) will surface in a
single unified dashboard order list — see the design spec.

Platform (super admin)

URL	Credentials
localhost:3000/admin/login	admin@serveos.com / admin1234
Redirects to /admin (pending restaurant queue) after sign-in.

Pizza Roma (restaurant users)

Role	Email	Password	URL
Owner	owner@roma.com	owner1234	localhost:3000/login (slug: roma)
Manager	manager@roma.com	manager1234	same
Staff	staff@roma.com	staff1234	same
The dev server is already running — open localhost:3000/admin/login to test the admin path, and localhost:3000/login for restaurant users.