# Testing Strategy & Known Gaps

This document details the test pyramid, execution rules, test harnesses, and the authoritative catalog of known gaps, parked tracks, and technical debt in ServeOS.

## 1. Testing Philosophy & Architecture

ServeOS utilizes a comprehensive testing strategy combining unit tests, database integration tests, Electron specific tests, and end-to-end browser specifications to ensure platform reliability.

### The RLS Testing Imperative
Row-Level Security (RLS) is the foundation of multi-tenancy in ServeOS. It is critical that tests verifying RLS logic do not run under a PostgreSQL superuser account. 

> [!WARNING]
> Why RLS makes superuser testing dangerous: If the testing database user is a superuser, RLS policies are silently bypassed. The `serveos_app` role MUST have `NOSUPERUSER NOBYPASSRLS`. Tests running against RLS logic while authenticated as a superuser are vacuous and provide a false sense of security.

### Serial Execution & Test Isolation
Tests that interact with the database must be carefully isolated. Vitest tests share the migrated `serveos_test` PostgreSQL database.
- Tests run serially (`fileParallelism: false`).
- Database tables are truncated between tests via `src/db/test-setup.ts`.
- This ensures clean state and prevents race conditions between parallel tests interacting with shared RLS and schema states.

### Multi-Tier Test Pyramid

1. **Unit Tests** (`npm run test:unit`, `vitest.unit.config.ts`)
   - **Scope:** Pure functions, order mathematics (`order-totals.ts`), money formatting (`money.ts`), regular expressions, state reducers.
   - **Execution:** Extremely fast, requires no database connection.

2. **Database Integration Tests** (`npm run test`, `vitest.config.ts`)
   - **Scope:** Domain services, RLS isolation, transactions, and mutations.
   - **Execution:** Runs against a real PostgreSQL DB test instance (`serveos_test`).

3. **POS Electron Suite** (`npm run pos:test`, `npm run pos:typecheck`)
   - **Scope:** Electron app renderer & main-process IPC bridge.
   - **Execution:** Verifies the native-feeling Point of Sale behaviors.

4. **Playwright E2E Browser Suite** (`npm run test:e2e`, `tests/e2e/`)
   - **Scope:** 11 end-to-end browser specifications covering admin approvals, dashboard management, customer checkout, offline payments, order tracking, and responsive layouts.
   - **Execution:** Simulates real user browser interactions.

---

## 2. Test Harnesses & Fixtures Reference

To accelerate test authoring and ensure consistency, ServeOS provides several key test harnesses and fixtures.

### POS Fixtures
The POS module includes dedicated helpers for establishing test state:

```typescript
// src/server/pos/test-helpers.ts

/**
 * Authoritative fixture helper for POS tests.
 * Seeds a tenant, branch, and necessary context for POS operations.
 */
export async function seedPosContext(tenantId: string, branchId: string) { ... }

/**
 * Opens a shift for the given context, returning shift details.
 */
export async function openShiftForCtx(ctx: PosContext) { ... }

/**
 * Helper for ringing sales without manual table wiring.
 */
export async function recordSale(...) { ... }
```

### RLS Isolation
Testing tenant data isolation requires simulating queries executed as specific tenants.

```typescript
/**
 * Testing RLS tenant isolation across transactions.
 * Executes the callback within a transaction setting the `tenant.id` local variable.
 */
export async function withTenant(tenantId: string, callback: (tx: any) => Promise<void>) { ... }
```

### Global Setup & Teardown
- `test-global-setup.ts`: Responsible for database migration before the test suite runs.
- `test-setup.ts`: Responsible for per-test truncation of tables to ensure a pristine database state.

---

## 3. CI/CD Quality Gates

Continuous Integration ensures that tests run automatically and code quality is maintained on every Pull Request.
Configuration is located at `.github/workflows/ci.yml`.

> [!IMPORTANT]
> Steps executed on every PR:
> 1. **TypeScript Typechecking:** `tsc --noEmit` verifies strict type correctness.
> 2. **Drizzle Migration Drift Check:** Verifies that the codebase schema definition matches the current `drizzle/` migrations.
> 3. **Vitest Test Suite:** Executes database integration tests on a non-superuser PostgreSQL container to ensure RLS policies are strictly evaluated.
> 4. **Build Verification:** `next build` ensures the application can be compiled successfully.

---

## 4. Authoritative Known Gaps & Technical Debt Catalog

This section formalizes the known gaps and parked tracks extracted from `ROADMAP.md` and codebase analysis.

| Gap ID | Description | Status / Impact |
| :--- | :--- | :--- |
| **Gap 1: Offline POS Queue & Two-Way Sync** | Electron POS offline cache (`apps/pos/electron/_offline/`) is currently parked WIP. The POS currently requires an active connection to `/api/pos/v1/*`. | **Parked**. Critical for unreliable network environments. |
| **Gap 2: Payment Gateway Live Settlement** | Specifications 6 & 7. The `PaymentGateway` interface is drafted with a Paymob-first abstraction, but live processor settlement is PARKED pending merchant business signoff. | **Parked**. Blocks live credit card processing integration. |
| **Gap 3: Dine-In & Table Management** | The POS currently supports walk-in counter sales and pickup only. There are no visual table maps, seat management, or bill splitting capabilities built yet. | **Gap**. Limits usability for full-service restaurants. |
| **Gap 4: Kitchen Display System (KDS) & Printing** | Kitchen orders rely on dashboard live queue polling. Direct hardware ESC/POS thermal printing and station bump-bars are unbuilt. | **Gap**. Essential for high-volume kitchen operations. |
| **Gap 5: Advanced Analytics Entitlement Enforcement** | The `advanced_analytics` plan flag exists in subscription schemas but is not currently enforced on analytics API endpoints. | **Tech Debt**. Revenue leakage risk if left unenforced in production. |
| **Gap 6: Fiscal Compliance Engine** | ETA & ZATCA compliance PRDs are drafted (`PRD-003`, Spec 11) and schema tax codes specified. However, the direct ETA / ZATCA REST API submission worker is pending implementation. | **Gap**. Blocks deployment in compliant regions. |
| **Gap 7: DB Connection Query Serialization Warning** | Analytics services run `Promise.all` over queries sharing a single transaction client (e.g., `src/server/analytics/service.ts`, `pos-reports.ts`), emitting node-postgres deprecation warnings in test logs. | **Tech Debt**. Should be refactored to run queries sequentially or utilize independent connections. |

---

## 5. Future Iterations Roadmap

High-level sequencing for future developments:

1. **Spec 1-5 Finalization:** Harden core inventory, multi-tenant RBAC, and basic POS flows.
2. **Spec 6-7 (Payment Integration):** Unpark Payment Gateway Live Settlement once merchant accounts are provisioned.
3. **POS Backlog: Promotions & Loyalty:** Implement promotions engine, loyalty programs, and gift card support.
4. **POS Backlog: Staff Management:** Add staff time clock and tips tracking to the POS.
5. **POS Backlog: Hardware Integration:** ESC/POS thermal printing and KDS integration (addressing Gap 4).
6. **Spec 11 (Fiscal Compliance):** Implement ETA & ZATCA submission workers (addressing Gap 6).
7. **Delivery Dispatch:** Build out delivery driver dispatch and routing management.
