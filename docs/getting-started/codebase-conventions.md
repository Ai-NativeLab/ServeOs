# Codebase Structure & Conventions

This document provides a comprehensive overview of the ServeOS codebase, establishing conventions to answer the fundamental question: "where does X go?" for every developer. 

## 1. Directory Structure Overview

The repository is organized as a monorepo with the following top-level structure:

```text
ServeOs/
├── .agents/                    # AI agent skills & workflows
├── .github/workflows/          # CI/CD (ci.yml, db-backup.yml)
├── apps/
│   └── pos/                    # Electron POS desktop app (Vite + React)
├── docs/                       # Project documentation
│   ├── architecture/           # System architecture docs
│   ├── getting-started/        # Onboarding & conventions
│   ├── database/               # ERD & schema docs
│   ├── api/                    # API reference
│   ├── prds/                   # Product Requirements Documents
│   └── references/             # Operational references
├── drizzle/                    # SQL migration files (46 migrations)
├── public/                     # Static assets, logos, fonts
├── scripts/                    # DB migration, seeds, demo datasets
├── src/
│   ├── app/                    # Next.js App Router
│   ├── components/             # Shared React components
│   ├── db/                     # Database client, RLS, schema barrel
│   ├── lib/                    # Pure utility functions
│   ├── server/                 # Domain service modules (27 modules)
│   └── shared/                 # Cross-cutting types & constants
├── tests/
│   └── e2e/                    # Playwright E2E tests
└── CONTEXT.md                  # Domain glossary
```

## 2. Domain Module Anatomy

Business logic in ServeOS is encapsulated within domain modules located in `src/server/<domain>/`. Every module strictly follows this internal structure:

```text
src/server/<domain>/
├── schema.ts          # Drizzle table definitions
├── service.ts         # Business logic functions
├── errors.ts          # Domain-specific error classes
├── index.ts           # Public barrel export
├── *.test.ts          # Vitest test files
└── [optional files]   # e.g. types.ts, helpers, sub-services
```

> [!WARNING]  
> **Key Rule:** No module may directly import another module's internal files. Always import from the target module's barrel file `index.ts`.

### The 27 Domain Modules

| Module | Responsibility | Module | Responsibility |
|---|---|---|---|
| `auth` | User authentication & sessions | `catalog` | Products, variants, categories |
| `inventory` | Stock levels, locations, transfers | `orders` | Order processing & lifecycle |
| `pos` | Point of sale, shifts, registers | `billing` | SaaS billing, subscriptions, invoices |
| `crm` | Customers, segments, profiles | `staff` | Employee management, roles, permissions |
| `tenants` | Multi-tenant core, settings | `payments` | Payment processing, gateways |
| `shipments` | Fulfillment, shipping rates | `returns` | RMAs, refunds, restocking |
| `loyalty` | Reward points, tiers, referrals | `discounts` | Coupons, promotions, rules |
| `reporting` | Analytics, dashboards, exports | `settings` | Store preferences, localization |
| `webhooks` | Event dispatch, integrations | `checkout` | Cart, checkout flows |
| `marketing` | Campaigns, SEO, banners | `notifications` | Email, SMS, in-app alerts |
| `taxes` | Tax rates, calculations, rules | `suppliers` | Vendor management |
| `purchase-orders`| POs, receiving, supply chain | `audit-logs` | Activity tracking, compliance |
| `files` | Media uploads, assets, S3 | `search` | Global search, indexing |
| `api-keys` | Developer API access | | |

## 3. App Router Structure

Our Next.js App Router structure supports multiple surfaces from a single deployment:

- `src/app/(marketing)/` — Marketing site with bilingual `[lang]/` routes
- `src/app/admin/` — Platform admin console (super-admins only)
- `src/app/dashboard/` — Merchant dashboard (the largest surface area)
- `src/app/checkout/`, `src/app/order/` — Customer-facing shopping flows
- `src/app/api/` — REST API routes and webhooks
- Root `page.tsx` dispatches to the correct storefront based on the `x-surface` header

## 4. Component Organization

Shared UI components are organized by domain and surface:

```text
src/components/
├── ui/           # shadcn/ui + Radix primitives (Button, Card, Dialog, etc.)
├── dashboard/    # Merchant shell (Sidebar, Topbar, PageHeader, StatusBadge)
├── admin/        # Admin console specific components (AdminNav, Pagination)
└── brand/        # Logos, wordmarks, feature icons
```

## 5. Naming Conventions

- **Components:** `PascalCase.tsx` (e.g. `AdminNav.tsx`, `PageHeader.tsx`)
- **Server Actions:** `<verb>Action` (e.g. `approveAction`, `createStaffAction`)
- **Route Folders:** lowercase `kebab-case` (e.g. `purchase-orders/[id]`)
- **Service Functions:** camelCase verbs (e.g. `listTenants`, `recordSale`, `placeOrder`)
- **Schema Files:** Always named `schema.ts` within each domain module
- **Test Files:** Co-located with source as `*.test.ts` (e.g. `service.test.ts`)

## 6. Key Patterns & Conventions

### Next.js 16 Breaking Changes
> [!IMPORTANT]
> In Next.js 16, `searchParams`, `headers()`, and `cookies()` are **Promises** and MUST be `await`ed before access.
> Server Components are the default. Only use `"use client"` directives for interactive islands.

### Server Actions
- Co-locate actions in `actions.ts` files alongside the pages they serve, marked with `"use server"`.
- **Defense-in-Depth:** MUST re-verify authorization and permissions before executing mutations.
- MUST call `revalidatePath()` after mutations to update cached data.

### URL-Driven State
Do not use React client state (`useState`) for filters, search queries, or pagination. Store these in URL query parameters.
- Server-side parsing: Await `searchParams` in the Server Component and pass values down.

### Page Recipes

**Admin Page Recipe:**
1. Server Component page with `await requireSuperAdminOrRedirect()` at the top.
2. Await `searchParams` for filters/pagination.
3. Call platform service functions.
4. Server actions in `actions.ts` use a bare `requireSuperAdmin()` (throws instead of redirecting).

**Dashboard Page Recipe:**
1. Server Component with `await requireDashboardUser()` or a specific permission check.
2. Await `searchParams`.
3. Call domain service functions wrapped via `withTenant()`.
4. Server actions in `actions.ts` re-verify auth/permissions and call `revalidatePath()`.

## 7. Path Aliases

We use path aliases to avoid fragile relative imports (`../../../`).
- `@/*` maps to `./src/*` (configured in `tsconfig.json`).
- Examples: 
  - `import { db } from "@/db/client"`
  - `import { withTenant } from "@/db/with-tenant"`

## 8. Testing Conventions

- **Integration Tests:** Use real PostgreSQL (`serveos_test` DB), execute serially, and truncate tables between tests.
- **Unit Tests:** Pure logic only, no DB setup required (`vitest.unit.config.ts`).
- **E2E Tests:** Playwright tests run against a seeded dev instance.
- **POS Tests:** Use specific fixtures like `seedPosContext` and `openShiftForCtx` from `src/server/pos/test-helpers.ts`.

## 9. Database Conventions

- **ORM:** Drizzle ORM with PostgreSQL.
- **Master Schema:** Re-exported through the barrel `src/db/schema.ts`.
- **Multi-Tenancy:** Row-Level Security (RLS) is enforced via `withTenant(tenantId, tx => ...)`, which internally executes `SET LOCAL app.tenant_id`.
- **Connection:** Lazy connection pooling in `src/db/client.ts` via an ES Proxy for build-time safety.
- **Data Types:**
  - *Monetary Values:* Stored as `numeric` strings via the `money(n)` convention.
  - *Timestamps:* Always use `timestamp with time zone`.
  - *Primary Keys:* UUIDs using `defaultRandom()`.
  - *Bilingual Text:* Use the `name_en` and `name_ar` pattern for localized columns.
