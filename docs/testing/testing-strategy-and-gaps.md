# Testing Strategy & Known Gaps

## 1. Test tiers

| Tier | Command | Config | Scope |
|---|---|---|---|
| Unit + integration | `npm test` | `vitest.config.ts` (`src/**/*.test.ts`) | services, RLS isolation, route handlers, migrations — against a real Postgres (`serveos_test`) |
| Unit only | `npm run test:unit` | `vitest.unit.config.ts` | the subset that needs no database |
| POS app | `npm run pos:test`, `npm run pos:typecheck` | `apps/pos/vitest.config.ts` | Electron main process, offline store, renderer logic |
| End-to-end | `npm run test:e2e` | `playwright.config.ts` | 13 Playwright specs in `tests/e2e/`: admin, dashboard, marketing, menu, offline payment, onboarding, ordering, pricing, purchasing, responsive, scheduling, shop, storefront-responsive |

### Why the database role matters
`FORCE ROW LEVEL SECURITY` binds every role except superusers and `BYPASSRLS` roles. A superuser **bypasses** RLS and sees all tenants' rows, so tests run as one would pass vacuously. Locally the tests connect as `serveos_app` and in CI as `serveos_ci`, both `NOSUPERUSER NOBYPASSRLS`.

### Serial execution
- `fileParallelism: false` — every file shares one database.
- `src/db/test-global-setup.ts` migrates the test DB once; `src/db/test-setup.ts` calls `truncateAll()` (`src/db/test-harness.ts`) before each test.
- Timeouts are 60 s per test and hook.

## 2. Fixtures

POS (`src/server/pos/test-helpers.ts`):

```ts
// Seeds a tenant (default vertical restaurant), branch and product, a user with the given
// role plus a manager, pairs a device through the real pairing code flow and signs the
// first user in as the cashier. Returns the PosCashierContext and ids.
seedPosContext(
  role?: "owner" | "manager" | "staff",
  opts?: { vertical?: VerticalId; trackStock?: boolean; stockQuantity?: number | null },
): Promise<{ ctx: PosCashierContext; tenantId; branchId; productId; managerId; total }>

// Opens a shift on ctx's device (default float 200).
openShiftForCtx(ctx: PosCashierContext, openingFloat = 200): Promise<PosShift>
```

Ring sales with the real `recordSale` (`src/server/pos/record-sale.ts`) rather than inserting orders by hand. WhatsApp has its own `src/server/whatsapp/test-helpers.ts`; inventory has `src/server/inventory/test-helpers.ts`.

Tenant scoping in tests uses the production helper `withTenant(tenantId, tx => …)` from `src/db/with-tenant.ts` (sets `app.tenant_id` with `set_config(…, true)`).

## 3. CI (`.github/workflows/ci.yml`)

Runs on pull requests and on pushes to `main` and `qa`:

1. **typecheck** — `npx next typegen` then `npx tsc --noEmit`.
2. **test** — Postgres 16 service; `scripts/ci-db-bootstrap.sql` creates the `serveos_ci` role (`NOSUPERUSER NOBYPASSRLS`); `npm run db:migrate:test`; `npm run db:check:test` (fails if a migration on disk was not applied); `npm test`.
3. **e2e** — Postgres 16 service, migrate, seed (roma, nobio, the pharmacy demo tenant), then **`npm run build`** (this is where the production build is verified) and `npm run test:e2e`.

`apps/pos` releases are built by `pos-release.yml`.

## 4. Known gaps

| Gap | Status |
|---|---|
| **Card payment gateway / settlement** (Specs 6–7) | Parked (roadmap D3). No `PaymentGateway` implementation exists; card tenders at the POS are record-only. |
| **Fiscal e-invoicing** (ETA — Spec 11; ZATCA) | Not implemented. Specified only. |
| **Dine-in & table management** | Not built. POS sales are walk-in pickup; held tickets are a partial stand-in. |
| **Kitchen display & peripherals** | Not built. Orders show in the POS order queue and the dashboard; no ESC/POS printing, cash-drawer kick, scanner or scale integration. |
| **Refund restock vs. inventory core** | `restockRefundedLines` still increments the legacy `products.stock_quantity` / `product_variants.stock_quantity` counters instead of writing lots and a `refund_restock` ledger row (flagged in `src/server/pos/refund.ts`). |
| **`pos:void` unused** | The permission exists and is granted to owners/managers, but nothing checks it. |
| **Subscription lifecycle automation** | `past_due` / `suspended` are never set automatically (no trial-expiry or dunning job); `transition()` in `src/server/subscription/service.ts` is only used by tests. |
| **Media backups** | Supabase Storage (`media`, `prescriptions` buckets) is not included in the nightly database backups. |
| **Concurrent queries on one transaction** | `src/server/analytics/service.ts` and `pos-reports.ts` run `Promise.all` over several queries on the same transaction client; node-postgres serializes these, so they run sequentially rather than in parallel. |

Offline POS is **not** a gap any more: the SQLite event log, offline sign-in and batched sync shipped in #138 (`apps/pos/electron/_offline/`, `POST /api/pos/v1/sync/events`).

## 5. Roadmap pointers

Sequencing lives in [docs/ROADMAP.md](../ROADMAP.md) (Specs 1–11 and the POS backlog). Don't duplicate it here.
