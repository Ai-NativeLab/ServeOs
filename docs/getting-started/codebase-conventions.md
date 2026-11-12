# Codebase Structure & Conventions

Where things live, and the patterns the existing code follows.

## 1. Top-level layout

```text
ServeOs/
├── .github/workflows/   # ci, deploy-watch, vercel-deploy, db-backup, db-restore-drill,
│                        # demo-reset, inventory-backfill, reorder-check, pos-release
├── apps/pos/            # Electron POS (Vite + React renderer, electron/ main process, electron/_offline/ SQLite store)
├── docs/                # this documentation, ROADMAP.md, PRDs, references/, per-agent specs
├── drizzle/             # 46 SQL migrations + meta/ (journal and snapshots)
├── public/              # static assets
├── scripts/             # migrate, release-migrate, seeds, db-check/repair, pos demo, reorder-check, backfill
├── src/
│   ├── app/             # Next.js App Router (pages, Server Actions, /api route handlers)
│   ├── components/      # ui/ (shadcn + Radix), dashboard/, admin/, brand/
│   ├── db/              # pg client, withTenant, schema barrel, migration runner, test harness
│   ├── lib/             # client-safe helpers: order-totals, money, datetime, order-status, realtime client…
│   ├── server/          # 27 domain modules (below)
│   ├── shared/          # errors (DomainError), plans
│   ├── proxy.ts         # Next 16 Proxy: host → surface routing
│   ├── middleware-routing.ts, marketing-locale.ts
├── tests/e2e/           # Playwright specs
├── CONTEXT.md           # domain glossary
└── AGENTS.md / CLAUDE.md
```

## 2. Domain modules (`src/server/`)

| Module | What's in it |
|---|---|
| `analytics` | dashboard metrics, cross-channel reports, POS X/Z reports, platform signups/MRR |
| `audit` | hash-chained `audit_events`, chain verification, fingerprints, coverage list |
| `auth` | users, sessions, password hashing (scrypt), dashboard/admin context, staff management, roles |
| `banners` | storefront banners |
| `billing` | subscription invoices behind the `BillingProvider` interface (manual provider) |
| `branches` | branches, delivery areas, opening hours, orderability, scheduling slots |
| `catalog` | categories, products, variants, modifiers, units of measure, dimensional pricing, catalog version |
| `customers` | storefront customer accounts and sessions, trade accounts |
| `demo` | demo-tenant sessions for the marketing page |
| `email` | `EmailProvider` (Resend, fake), sender, webhook parsing |
| `enquiries` | marketing plan enquiries |
| `entitlements` | plan quota/feature checks and usage counters |
| `inventory` | items, locations, lots, ledger, recipes, counts, product links, UoM |
| `notifications` | in-app notifications, email outbox, worker, email events |
| `onboarding` | tenant registration and applications |
| `ordering` | `placeOrder`, order state machine, payments confirmation, cancellation |
| `payments` | offline payment methods (InstaPay, Vodafone Cash, mobile wallet) |
| `platform` | super-admin operations: approvals, suspensions, subscriptions, platform `audit_logs` |
| `pos` | devices, pairing, cashier sessions, grants, sales, tenders, refunds, shifts, held tickets, offline sync ingest |
| `prescriptions` | prescription upload (private bucket) and review |
| `purchasing` | suppliers, purchase orders, receiving, variance, reorder |
| `rbac` | permission list, role → permission map, `authorize` |
| `realtime` | Supabase Realtime publish + tokens |
| `subscription` | plans (seed), subscriptions |
| `tenancy` | tenants, tenant settings, host resolution, PWA manifest |
| `verticals` | vertical descriptors and capabilities |
| `whatsapp` | Cloud API provider, webhook ingest, conversation reducer/runner, handoff, status updates |

### Module anatomy

Most modules have some of `schema.ts`, `service.ts`, `errors.ts`, `index.ts` and co-located `*.test.ts`, but there is no fixed template: larger modules split into several files (e.g. `pos/record-sale.ts`, `pos/shifts.ts`, `pos/refund-schema.ts`, `purchasing/reorder-schema.ts`, `payments/offline/methods.schema.ts`). Fourteen modules have an `index.ts` barrel; importing a module's files directly (`@/server/pos/require-cashier`) is common and not enforced against.

## 3. App Router (`src/app/`)

- `(marketing)/[lang]/` — marketing site (Arabic at `/`, English at `/en`)
- `page.tsx` — tenant storefront (when `x-surface = storefront`); `checkout/`, `order/`, `account/` — storefront flows
- `dashboard/` — merchant dashboard; `login/`, `register/` — staff sign-in and tenant sign-up; `subscribe/` — plan enquiry form
- `admin/` — platform admin console (`admin/login`, `admin/(console)/…`)
- `api/` — route handlers (see [API index](../api/README.md))

## 4. Naming

- Components: `PascalCase.tsx`.
- Server Actions: `<verb>…Action` (e.g. `approveAction`, `createStaffAction`), in `actions.ts` next to the page (one exception: `dashboard/orders/[id]/refund-actions.ts`).
- Route folders: kebab-case (`purchase-orders/[id]`).
- Service functions: camelCase verbs (`placeOrder`, `recordSale`, `listTenants`).
- Tests: co-located `*.test.ts`.

## 5. Patterns

### Next.js 16
Read `node_modules/next/dist/docs/` before using a Next API (see `AGENTS.md`). In this version `params`, `searchParams`, `headers()` and `cookies()` are async and must be awaited, and `middleware.ts` is now `proxy.ts`.

### Server Actions
- Re-check auth inside every action with the module's `require*Permission` helper (or `requireSuperAdmin` in the admin console) — never rely on the page having checked.
- Call `revalidatePath()` after a mutation.

### Admin console pages
From `docs/ailab/specs/admin-frontend-conventions.md`: pages call `requireSuperAdminOrRedirect()` first, read filters from the awaited `searchParams` (filters live in the query string via GET forms), and their actions use bare `requireSuperAdmin()`.

### Dashboard pages
Pages call `requireDashboardUser()` or a `require*Permission()` helper (`src/app/dashboard/*-permission.ts`), then call services that wrap their queries in `withTenant()`.

### Route handlers
Thin: authenticate (`resolveInventoryContext`, `resolvePurchasingContext`, `requirePosCashier`, …), validate the body, call a service, map domain errors to status codes.

## 6. Path aliases
- `@/*` → `./src/*` (root `tsconfig.json`).
- In `apps/pos`, `@shared/*` → `../../src/lib/*` (e.g. `@shared/order-totals`).

## 7. Testing
- `npm test` — Vitest against the migrated `serveos_test` database, files run serially (`fileParallelism: false`), tables truncated before each test (`src/db/test-setup.ts`).
- `npm run test:unit` — the no-DB subset (`vitest.unit.config.ts`).
- POS server tests: start from `seedPosContext()` / `openShiftForCtx()` in `src/server/pos/test-helpers.ts`.
- `npm run pos:test` / `npm run pos:typecheck` — the Electron app's own suite.
- `npm run test:e2e` — Playwright.

## 8. Database
- Drizzle ORM; schemas re-exported through `src/db/schema.ts`.
- `src/db/client.ts` creates the `pg` pool lazily (behind a `Proxy`) so importing it at build time does not need a database.
- Tenant data only through `withTenant(tenantId, tx => …)`, which sets `app.tenant_id` with `set_config(…, true)`.
- Money: `numeric` columns, passed around as strings via `money(n)`. Timestamps: `timestamp with time zone`. Bilingual text: `*_en` / `*_ar` columns. Details in [erd.md](../database/erd.md).
