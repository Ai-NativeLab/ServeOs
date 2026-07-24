# Transaction Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use mo-ai:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer one question with server-computed, immutable evidence: **does what we recorded match what we received?** This plan implements the two reconciliation layers that need **no payment gateway** — **(a) order↔tender integrity** (every order's tenders, net of change, tie to its total; no orphan tenders; no duplicate `clientPaymentId`) and **(b) cash-drawer-per-shift** (Spec 2's counted cash vs the normative expected cash → variance) — and the **daily close** that aggregates every channel (web + POS) for a business day in the **tenant timezone**, writes one immutable `reconciliation_run`, anchors it into the Spec 4 audit chain, and raises a Spec 5 notification on exceptions. Layer **(c) external settlement** is **PARKED pending the gateway decision (ROADMAP D3)** — its tables and matching arrive with the gateway; only a stub task is included here. Implements **Part B** of `docs/ailab/specs/2026-07-24-payments-gateway-and-reconciliation-design.md` (Spec 7, decision **D2**); Part A (Payments) is parked context.

**Architecture:** One namespace, `src/server/reconciliation/`, with three pure-ish layer services and one orchestrator. Every layer is a **read-only computation** that returns a result object; only the daily-close orchestrator (and the per-layer run writers it calls) persists — and it persists **immutably**: a re-run of a day writes a *new* `reconciliation_run` row, never mutates a prior one. All internal money math is in **integer minor units (piastres)** to avoid float drift (`minor.ts`, a pure module shared by every layer and the verifier); only display converts back via `money()` (`src/server/ordering/service.ts:55`). Business-day bucketing reuses the repo's existing tenant-timezone helper `localDateKey(date, tz)` (`src/server/branches/slots.ts:20`) in JS and `(placed_at AT TIME ZONE $tz)::date` in SQL — the same `Africa/Cairo`-correct discipline `placeOrder` already uses for scheduling. Layer (a) reads `orders` + `order_payments` only. Layer (b) reads Spec 2's `pos_shifts` / `cash_counts` plus the `order_payments.shiftId` Spec 2 populates; when those tables are absent it degrades to **"unavailable"**, never a false zero. The daily close emits `recordAuditEvent(ctx, …, tx)` (Spec 4) inside the run's transaction so the close is **tamper-evident**; when Spec 4 has not landed the run still writes and `auditEventId` stays null.

**Tech Stack:** Next.js (App Router), Drizzle ORM + Postgres (RLS via `withTenant` — `src/db/with-tenant.ts`), `Intl.DateTimeFormat` for tenant-tz date keys (no new dependency), Vitest against a remote Supabase Postgres.

## Global Constraints

- **No new runtime dependencies.** Timezone bucketing reuses `Intl.DateTimeFormat` / `localDateKey`; minor-unit math is plain integer arithmetic.
- **Tenant-scoped tables are behind RLS.** `reconciliation_runs` and `reconciliation_exceptions` are `ENABLE` + `FORCE ROW LEVEL SECURITY` with the house isolation policy — `USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)` and the same `WITH CHECK` — mirroring `drizzle/0016_bitter_beast.sql`. Every read/write goes through `withTenant(tenantId, tx => …)`.
- **Runs are immutable snapshots.** No code path ever `UPDATE`s a `reconciliation_run`'s totals or `status` after write. Re-running a day appends a new run. The **only** mutable field anywhere is `reconciliation_exceptions.{resolvedByUserId, resolvedAt, resolutionNote}` — an exception is *acknowledged*, never deleted, never its discrepancy edited.
- **All money math is integer minor units.** Convert at the boundary with `toMinor(numericString)`; compare with a **±1 minor-unit tolerance** (a 1-piastre tie is not an exception; anything larger is). Never sum `Number(amount)` floats across rows.
- **Tips never enter any tie.** `order_payments.tipAmount` is excluded from the order-total tie and from drawer-expected math, consistent with the Sale & Tender rule that tips never enter the order total.
- **`order_payments.amount` is already net of change** in this codebase (`recordSale` writes `amount` = applied, `changeAmount` = `tenderedAmount − amount`; `src/server/pos/record-sale.ts:119`). The spec's "Σ tender.amount − Σ tender.changeAmount" therefore reduces to `Σ amount` for the order-total tie; the plan subtracts change defensively so a row that ever recorded gross still ties.
- **Layers degrade, never lie.** A missing prerequisite (Spec 2 tables absent; Spec 4 audit absent) makes a layer report `unavailable` / `auditEventId: null` and marks the daily close `partial` — never falsely `balanced`.
- **Settlement is PARKED.** No `settlement_batches` / `settlement_lines` tables, no `fetchSettlement`, no `processorTxnId` matching in this plan. The `settlement` run-kind and the settlement exception codes are reserved in the enums (canonical names) so the schema needs no change when the gateway lands.
- Run `npx tsc --noEmit && npx eslint <files>` before every commit. Both must be clean.

---

## File Structure

**Database**
- Create: `src/server/reconciliation/schema.ts` — `reconciliation_runs`, `reconciliation_exceptions`, enums `reconciliation_kind`, `reconciliation_status`, `reconciliation_layer`, `reconciliation_exception_code`.
- Modify: `src/db/schema.ts` — register the new schema barrel export.
- Create: `drizzle/0017_*.sql` — generated migration; RLS policies hand-appended.

**Core (pure + layers + orchestrator)**
- Create: `src/server/reconciliation/minor.ts` — `toMinor`, `fromMinor`, `TIE_TOLERANCE_MINOR`, `withinTolerance`.
- Create: `src/server/reconciliation/minor.test.ts`.
- Create: `src/server/reconciliation/integrity.ts` — `reconcileOrderTenders`, layer (a).
- Create: `src/server/reconciliation/integrity.test.ts`.
- Create: `src/server/reconciliation/cash-drawer.ts` — `reconcileCashDrawer`, layer (b).
- Create: `src/server/reconciliation/cash-drawer.test.ts`.
- Create: `src/server/reconciliation/daily-close.ts` — `runDailyClose`, `channelBreakdown` builder.
- Create: `src/server/reconciliation/daily-close.test.ts`.
- Create: `src/server/reconciliation/settlement.ts` — **[PARKED]** stub only.
- Create: `src/server/reconciliation/audit-anchor.ts` — best-effort Spec 4 anchor + Spec 5 alert seams.

**Authorization + read surface**
- Modify: `src/server/rbac/permissions.ts` — add `reconciliation:manage` and `reports:financial`.
- Test: `src/server/rbac/permissions.test.ts`.
- Create: `src/server/reconciliation/read.ts` — `listRuns`, `getRun`, `resolveException`.
- Create: `src/server/reconciliation/read.test.ts`.
- Create: `src/app/dashboard/reconciliation-permission.ts` — `requireReconciliationPermission`, `requireFinancialReportsPermission`.
- Create: `src/app/api/reconciliation/runs/route.ts` (POST + GET), `.../runs/[id]/route.ts`, `.../exceptions/[id]/resolve/route.ts`, `.../daily-close/route.ts`.
- Create: `src/app/dashboard/reconciliation/page.tsx` — read-only reconciliation view.

---

## Task 1: Schema — `reconciliation_runs` + `reconciliation_exceptions`

Two tables. `reconciliation_runs` is the immutable snapshot of one reconciliation (one layer, or a `daily_close` composing them); `reconciliation_exceptions` is the actionable output — everything that didn't tie out. Both tenant-scoped with FORCE RLS. Drizzle's generator does **not** emit RLS policies (no schema file declares `pgPolicy`), so — exactly as `drizzle/0016_bitter_beast.sql` did for the tender tables — the `ENABLE`/`FORCE`/`CREATE POLICY` block is **hand-appended** to the generated migration.

**Files:**
- Create: `src/server/reconciliation/schema.ts`
- Modify: `src/db/schema.ts`
- Create: `drizzle/0017_*.sql` (generated, then edited)

**Interfaces:**
- Produces: tables `reconciliationRuns`, `reconciliationExceptions`; enums `reconciliationKindEnum` (`order_tender | cash_drawer | settlement | daily_close`), `reconciliationStatusEnum` (`balanced | exceptions | partial`), `reconciliationLayerEnum` (`order_tender | cash_drawer | settlement`), `reconciliationExceptionCodeEnum` (`orphan_tender | tender_total_mismatch | duplicate_client_payment_id | cash_variance | unmatched_payout | unsettled_tender | amount_mismatch | fee_gap`); types `ReconciliationRun`, `ReconciliationException`.

- [ ] **Step 1: Write the schema.** Create `src/server/reconciliation/schema.ts`:

```ts
import { pgTable, uuid, text, timestamp, date, jsonb, bigint, pgEnum, index } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { users } from "@/server/auth/schema";
import { orders } from "@/server/ordering/schema";
import { orderPayments } from "@/server/pos/tender-schema";

/** A daily_close composes the other three. `settlement` is reserved (PARKED). */
export const reconciliationKindEnum = pgEnum("reconciliation_kind", [
  "order_tender", "cash_drawer", "settlement", "daily_close",
]);
/** `partial` = a layer was unavailable (e.g. Spec 2 absent); never falsely balanced. */
export const reconciliationStatusEnum = pgEnum("reconciliation_status", [
  "balanced", "exceptions", "partial",
]);
export const reconciliationLayerEnum = pgEnum("reconciliation_layer", [
  "order_tender", "cash_drawer", "settlement",
]);
/** The settlement codes are reserved for the PARKED layer (c). */
export const reconciliationExceptionCodeEnum = pgEnum("reconciliation_exception_code", [
  "orphan_tender", "tender_total_mismatch", "duplicate_client_payment_id", "cash_variance",
  "unmatched_payout", "unsettled_tender", "amount_mismatch", "fee_gap",
]);

/**
 * An immutable snapshot of one reconciliation. Re-running a day writes a NEW row;
 * totals/status are never updated after write. All *_minor columns are integer
 * minor units (piastres). `businessDate` is the close day computed in the tenant
 * timezone (tenants.timezone, e.g. Africa/Cairo).
 */
export const reconciliationRuns = pgTable("reconciliation_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),
  businessDate: date("business_date").notNull(),
  kind: reconciliationKindEnum("kind").notNull(),
  shiftId: uuid("shift_id"), // Spec 2; set for cash_drawer runs. No FK — pos_shifts may not exist yet.
  expectedMinor: bigint("expected_minor", { mode: "number" }).notNull().default(0),
  countedMinor: bigint("counted_minor", { mode: "number" }).notNull().default(0),
  varianceMinor: bigint("variance_minor", { mode: "number" }).notNull().default(0),
  channelBreakdown: jsonb("channel_breakdown").$type<Record<string, unknown>>().notNull().default({}),
  status: reconciliationStatusEnum("status").notNull(),
  auditEventId: uuid("audit_event_id"), // Spec 4 anchor; null until Spec 4 lands.
  runByUserId: uuid("run_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("reconciliation_runs_tenant_date").on(t.tenantId, t.businessDate),
  index("reconciliation_runs_tenant_kind").on(t.tenantId, t.kind, t.businessDate),
]);

/**
 * The actionable output — everything that didn't tie out. Never deleted; the
 * only mutable fields are resolved{ByUserId,At} + resolutionNote (acknowledge).
 */
export const reconciliationExceptions = pgTable("reconciliation_exceptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  runId: uuid("run_id").notNull().references(() => reconciliationRuns.id, { onDelete: "cascade" }),
  layer: reconciliationLayerEnum("layer").notNull(),
  code: reconciliationExceptionCodeEnum("code").notNull(),
  orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
  orderPaymentId: uuid("order_payment_id").references(() => orderPayments.id, { onDelete: "set null" }),
  settlementLineId: uuid("settlement_line_id"), // PARKED; no FK until settlement_lines exists.
  expectedMinor: bigint("expected_minor", { mode: "number" }).notNull().default(0),
  actualMinor: bigint("actual_minor", { mode: "number" }).notNull().default(0),
  deltaMinor: bigint("delta_minor", { mode: "number" }).notNull().default(0),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolutionNote: text("resolution_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("reconciliation_exceptions_run").on(t.runId),
  index("reconciliation_exceptions_tenant_code").on(t.tenantId, t.code),
]);

export type ReconciliationRun = typeof reconciliationRuns.$inferSelect;
export type ReconciliationException = typeof reconciliationExceptions.$inferSelect;
```

- [ ] **Step 2: Register it.** Append to `src/db/schema.ts` (after the `pos/tender-schema` line):

```ts
export * from "../server/reconciliation/schema";
```

- [ ] **Step 3: Generate the migration.**

```bash
npm run db:generate
```

Expected: a new `drizzle/0017_*.sql` creating the four enums, both tables, the FKs, and the indexes. It will **not** contain RLS.

- [ ] **Step 4: Hand-append RLS.** Open the generated file and append (mirror `drizzle/0016_bitter_beast.sql:78-89`):

```sql
--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reconciliation_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY reconciliation_runs_isolation ON "reconciliation_runs"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "reconciliation_exceptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reconciliation_exceptions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY reconciliation_exceptions_isolation ON "reconciliation_exceptions"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

- [ ] **Step 5: Apply and verify the existing suite still passes.**

```bash
npm run db:migrate:test
npm test
```

Expected: migration applies; full suite PASS (nothing references the new tables yet).

- [ ] **Step 6: Commit.**

```bash
git add src/server/reconciliation/schema.ts src/db/schema.ts drizzle/
git commit -m "feat(reconciliation): reconciliation_runs + reconciliation_exceptions with FORCE RLS (canonical names)"
```

---

## Task 2: Minor-unit primitive + layer (a) order↔tender integrity

The heart of layer (a): for every order in a window, verify `Σ tenders (net of change) == total` for a `paid` order (`< total` for `partially_paid`), detect orphan tenders, and detect a `clientPaymentId` reused across orders in the window. All arithmetic is integer minor units via a **pure** `minor.ts` shared by every layer.

**Files:**
- Create: `src/server/reconciliation/minor.ts`, `src/server/reconciliation/minor.test.ts`
- Create: `src/server/reconciliation/integrity.ts`, `src/server/reconciliation/integrity.test.ts`

**Interfaces:**
- Produces (`minor.ts`): `toMinor(s: string | number): number` (`Math.round(Number(s) * 100)`), `fromMinor(n: number): string` (`(n / 100).toFixed(2)`), `const TIE_TOLERANCE_MINOR = 1`, `withinTolerance(a: number, b: number): boolean`.
- Produces (`integrity.ts`):
  - `type IntegrityException = { code: "orphan_tender" | "tender_total_mismatch" | "duplicate_client_payment_id"; orderId: string | null; orderPaymentId: string | null; expectedMinor: number; actualMinor: number; deltaMinor: number; detail: Record<string, unknown> }`
  - `type IntegrityResult = { orderCount: number; tenderCount: number; expectedMinor: number; countedMinor: number; varianceMinor: number; exceptions: IntegrityException[] }`
  - `function reconcileOrderTenders(tenantId: string, opts: { businessDate?: string; branchId?: string; orderIds?: string[] }): Promise<IntegrityResult>`

- [ ] **Step 1: Write the failing `minor.ts` tests.** Create `src/server/reconciliation/minor.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { toMinor, fromMinor, withinTolerance, TIE_TOLERANCE_MINOR } from "./minor";

describe("minor units", () => {
  it("toMinor rounds a numeric string to integer piastres", () => {
    expect(toMinor("125.40")).toBe(12540);
    expect(toMinor("0.1")).toBe(10);
    expect(toMinor("99.995")).toBe(10000); // banker-free round
  });
  it("fromMinor is the money() inverse", () => {
    expect(fromMinor(12540)).toBe("125.40");
    expect(fromMinor(0)).toBe("0.00");
  });
  it("withinTolerance allows a 1-piastre tie, not more", () => {
    expect(TIE_TOLERANCE_MINOR).toBe(1);
    expect(withinTolerance(12540, 12541)).toBe(true);
    expect(withinTolerance(12540, 12542)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail.** `npx vitest run src/server/reconciliation/minor.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `minor.ts`.** Small pure module; `fromMinor` mirrors `money()`'s `.toFixed(2)`.

- [ ] **Step 4: Write the failing integrity tests.** Create `src/server/reconciliation/integrity.test.ts`. Seed a tenant + branch + product, ring sales through `recordSale` (`seedPosContext` from `src/server/pos/test-helpers.ts`), then craft each fault directly against `order_payments` / `orders` under `withTenant`:

```ts
import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { orders } from "@/server/ordering/schema";
import { orderPayments } from "@/server/pos/tender-schema";
import { seedPosContext } from "@/server/pos/test-helpers";
import { recordSale } from "@/server/pos/record-sale";
import { reconcileOrderTenders } from "./integrity";
import { toMinor } from "./minor";

describe("reconcileOrderTenders (layer a)", () => {
  it("a balanced paid sale ties: no exceptions, variance 0", async () => {
    const { ctx, tenantId, productId, total } = await seedPosContext("owner");
    await recordSale(ctx, { clientOrderId: "c1", lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total, payments: [{ clientPaymentId: "p1", method: "cash", amount: total, tenderedAmount: total }] });
    const res = await reconcileOrderTenders(tenantId, {});
    expect(res.exceptions).toHaveLength(0);
    expect(res.varianceMinor).toBe(0);
  });

  it("tips are excluded from the tie", async () => {
    const { ctx, tenantId, productId, total } = await seedPosContext("owner");
    await recordSale(ctx, { clientOrderId: "c1", lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total, payments: [{ clientPaymentId: "p1", method: "cash", amount: total, tipAmount: 5, tenderedAmount: total + 5 }] });
    expect((await reconcileOrderTenders(tenantId, {})).exceptions).toHaveLength(0);
  });

  it("raises tender_total_mismatch when a tender is short", async () => {
    const { ctx, tenantId, productId, total } = await seedPosContext("owner");
    const r = await recordSale(ctx, { clientOrderId: "c1", lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total, payments: [{ clientPaymentId: "p1", method: "cash", amount: total, tenderedAmount: total }] });
    // Corrupt the tender amount to simulate a recording error.
    await withTenant(tenantId, (tx) => tx.update(orderPayments).set({ amount: "1.00" }).where(eq(orderPayments.orderId, r.orderId)));
    const res = await reconcileOrderTenders(tenantId, {});
    const ex = res.exceptions.find((e) => e.code === "tender_total_mismatch");
    expect(ex).toBeDefined();
    expect(ex!.expectedMinor).toBe(toMinor(String(total)));
    expect(ex!.actualMinor).toBe(100);
  });

  it("raises orphan_tender for a tender whose order is cancelled/voided", async () => {
    const { ctx, tenantId, productId, total } = await seedPosContext("owner");
    const r = await recordSale(ctx, { clientOrderId: "c1", lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total, payments: [{ clientPaymentId: "p1", method: "cash", amount: total, tenderedAmount: total }] });
    await withTenant(tenantId, (tx) => tx.update(orders).set({ status: "cancelled" }).where(eq(orders.id, r.orderId)));
    expect((await reconcileOrderTenders(tenantId, {})).exceptions.some((e) => e.code === "orphan_tender")).toBe(true);
  });

  it("raises duplicate_client_payment_id when one key lands on two orders", async () => {
    const { ctx, tenantId, productId, total } = await seedPosContext("owner");
    const a = await recordSale(ctx, { clientOrderId: "c1", lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total, payments: [{ clientPaymentId: "dupe", method: "cash", amount: total, tenderedAmount: total }] });
    const b = await recordSale(ctx, { clientOrderId: "c2", lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total, payments: [{ clientPaymentId: "dupe", method: "cash", amount: total, tenderedAmount: total }] });
    expect(a.orderId).not.toBe(b.orderId);
    expect((await reconcileOrderTenders(tenantId, {})).exceptions.some((e) => e.code === "duplicate_client_payment_id")).toBe(true);
  });
});
```

Note: the per-order `(orderId, clientPaymentId)` uniqueness is DB-enforced by `order_payments_order_client` and cannot be inserted twice; the run therefore *verifies* the cross-order case — the same idempotency key replayed into two distinct orders, a real client-replay signal. Call this out in a code comment.

- [ ] **Step 5: Run to verify they fail.** `npx vitest run src/server/reconciliation/integrity.test.ts` → FAIL (module not found).

- [ ] **Step 6: Implement `integrity.ts`.** Read all orders in scope (filter by `(placed_at AT TIME ZONE $tz)::date = businessDate` when `businessDate` given — get `tz` via `getTenantById`; else by `orderIds` / `branchId`) plus their `order_payments` under one `withTenant`. Per order: `countedMinor = Σ toMinor(amount) − Σ toMinor(changeAmount ?? 0)` (tips excluded); compare to `toMinor(total)` with `withinTolerance` — `paid` must tie, `partially_paid` must be `<` total. Anti-join tenders whose `orderId` has no live order (status ∉ live set, i.e. `cancelled`/`rejected`, or missing) → `orphan_tender`. Group tenders by `clientPaymentId` across the window; any key on >1 tender → `duplicate_client_payment_id`. Aggregate `expectedMinor`/`countedMinor`/`varianceMinor` for the result headline. Pure of any writes.

- [ ] **Step 7: Run to verify they pass + typecheck.**

```bash
npx vitest run src/server/reconciliation/minor.test.ts src/server/reconciliation/integrity.test.ts && npx tsc --noEmit
```

Expected: PASS, clean.

- [ ] **Step 8: Commit.**

```bash
git add src/server/reconciliation/minor.ts src/server/reconciliation/minor.test.ts src/server/reconciliation/integrity.ts src/server/reconciliation/integrity.test.ts
git commit -m "feat(reconciliation): minor-unit primitive + layer (a) order↔tender integrity (orphan, mismatch, duplicate clientPaymentId)"
```

---

## Task 3: Layer (b) cash-drawer reconciliation (Spec 2 `cash_counts`)

Expected drawer cash from the normative Spec 2 formula, counted from the shift's blind close, `variance = counted − expected` → a `cash_variance` exception when non-zero beyond tolerance. **Depends on Spec 2.** When `pos_shifts` / `cash_counts` are absent (Spec 2 not landed) the layer returns `{ available: false }` and the daily close marks itself `partial` — never a false zero.

**Files:**
- Create: `src/server/reconciliation/cash-drawer.ts`, `src/server/reconciliation/cash-drawer.test.ts`

**Interfaces:**
- Produces:
  - `type CashDrawerResult = { available: false } | { available: true; shiftId: string; expectedMinor: number; countedMinor: number; varianceMinor: number; exceptions: IntegrityException[] }`
  - `function tablesExist(tx, names: string[]): Promise<boolean>` (probe `information_schema.tables`) — the Spec 2 feature detector.
  - `function reconcileCashDrawer(tenantId: string, shiftId: string): Promise<CashDrawerResult>`

- [ ] **Step 1: Write the failing tests.** Create `src/server/reconciliation/cash-drawer.test.ts`. Because Spec 2's tables may not exist in this branch yet, the test is written to **probe** first: if `pos_shifts`/`cash_counts` are absent, assert `reconcileCashDrawer` returns `{ available: false }`; if present (Spec 2 landed), seed a fixture shift — `openingFloat`, cash tenders stamped with `shiftId`, a `pay_out`, a planted over/short `closing` `cash_counts` — and assert `varianceMinor` matches the planted delta with the correct sign, and that a non-zero variance yields exactly one `cash_variance` exception. Gate the second half behind the probe so the suite is green regardless of Spec 2's state:

```ts
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { reconcileCashDrawer } from "./cash-drawer";

describe("reconcileCashDrawer (layer b)", () => {
  it("degrades to { available: false } when Spec 2 tables are absent", async () => {
    // Fresh tenant, no shift. When pos_shifts/cash_counts don't exist the layer
    // must report unavailable, not throw and not fabricate a zero variance.
    const [t] = await db.insert(tenants).values({ slug: `cash-${Date.now()}`, name: "T", country: "EG", vertical: "restaurant" }).returning();
    const res = await reconcileCashDrawer(t.id, "00000000-0000-0000-0000-000000000000");
    // Either Spec 2 is absent (unavailable) or present with an unknown shift (unavailable).
    expect(res.available).toBe(false);
  });

  // it("computes variance = counted − expected for a planted short", async () => { … })
  //   ↑ enable once Spec 2 lands: seed pos_shifts + cash tenders + closing cash_counts,
  //     assert varianceMinor sign/magnitude and one cash_variance exception.
});
```

- [ ] **Step 2: Run to verify it fails.** `npx vitest run src/server/reconciliation/cash-drawer.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `cash-drawer.ts`.** `tablesExist` probes `information_schema.tables` for `pos_shifts` + `cash_counts`; if missing, return `{ available: false }`. Otherwise, under `withTenant`: load the shift (return `available: false` if not found), load its `openingFloat`, sum cash tenders on `order_payments WHERE shiftId = $ AND method = 'cash'` as `Σ (toMinor(amount) − toMinor(changeAmount ?? 0))`, subtract `Σ pay_outs` / `Σ safe_drops` and add `Σ pay_ins` from `cash_movements` (signed), subtract `Σ cash refunds` (Spec 3; 0 until landed — probe `refund_payments`). `expectedMinor` = that sum; `countedMinor` = the `closing` `cash_counts.countedTotal`; `varianceMinor = counted − expected`; if `!withinTolerance` emit one `cash_variance` exception (`expectedMinor`, `actualMinor = countedMinor`, `deltaMinor = variance`, sign = over/short). Reference the normative formula in a doc-comment pointing at the Shifts spec.

- [ ] **Step 4: Run to verify + typecheck.** `npx vitest run src/server/reconciliation/cash-drawer.test.ts && npx tsc --noEmit` → PASS, clean.

- [ ] **Step 5: Commit.**

```bash
git add src/server/reconciliation/cash-drawer.ts src/server/reconciliation/cash-drawer.test.ts
git commit -m "feat(reconciliation): layer (b) cash-drawer variance from Spec 2 cash_counts, degrades when Spec 2 absent"
```

---

## Task 4: Daily close — aggregate all channels, write the run, anchor + notify

The capstone. For a `businessDate` bucketed in the **tenant timezone**, aggregate `web` + `pos` orders, run layer (a) over every order and layer (b) over each shift, net refunds into a `channelBreakdown`, write **one** immutable `reconciliation_run` (`kind: daily_close`) plus its `reconciliation_exceptions`, **emit a Spec 4 audit event inside the same transaction** (tamper-evident anchor → `auditEventId`), and **raise a Spec 5 notification** when exceptions exist. Layer (c) settlement is skipped (PARKED); its absence marks nothing partial (it is deferred, not unavailable).

**Files:**
- Create: `src/server/reconciliation/audit-anchor.ts`
- Create: `src/server/reconciliation/daily-close.ts`, `src/server/reconciliation/daily-close.test.ts`

**Interfaces:**
- Consumes: `reconcileOrderTenders` (Task 2), `reconcileCashDrawer` (Task 3), `getTenantById`, `localDateKey` (`src/server/branches/slots.ts`), `withTenant`.
- Produces:
  - `audit-anchor.ts`: `anchorRun(tx, ctx, run): Promise<string | null>` — best-effort `recordAuditEvent` (Spec 4), returns the event id or null when Spec 4 absent; `alertOnExceptions(tenantId, run, exceptions): Promise<void>` — best-effort Spec 5 seam, no-op when notifications absent.
  - `daily-close.ts`: `type DailyCloseInput = { tenantId: string; businessDate: string; branchId?: string; runByUserId?: string | null; audit?: { fingerprint: unknown } }`; `function runDailyClose(input: DailyCloseInput): Promise<{ run: ReconciliationRun; exceptions: ReconciliationException[] }>`.

- [ ] **Step 1: Write the failing tests.** Create `src/server/reconciliation/daily-close.test.ts`. Seed a fixture business day (via `seedPosContext` + `recordSale`; set `orders.placedAt` to a known instant near a Cairo midnight boundary to prove bucketing), then assert:
  - a mixed cash sale day with everything tying reconciles to `status: "balanced"` and writes **exactly one** `daily_close` run;
  - a planted mismatch produces `status: "exceptions"` and the matching `reconciliation_exceptions` rows persisted with `runId`;
  - a `23:30 Africa/Cairo` order lands in the correct `businessDate` (its UTC instant is the previous day) — `localDateKey(placedAt, "Africa/Cairo")` equals the queried date;
  - **immutability:** calling `runDailyClose` twice for the same day appends a second run and never mutates the first (`prior.id` row unchanged, two rows now exist);
  - **anchor:** when `audit_events` exists (Spec 4 landed) the run's `auditEventId` is set and the event chains onto the head; when absent, `auditEventId` is null and the close still completes (assert via the probe, mirroring Task 3's degrade gate).

```ts
import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { orders } from "@/server/ordering/schema";
import { reconciliationRuns } from "./schema";
import { seedPosContext } from "@/server/pos/test-helpers";
import { recordSale } from "@/server/pos/record-sale";
import { runDailyClose } from "./daily-close";
import { localDateKey } from "@/server/branches/slots";

describe("runDailyClose", () => {
  it("a balanced day writes exactly one daily_close run, status balanced", async () => {
    const { ctx, tenantId, productId, total } = await seedPosContext("owner");
    const r = await recordSale(ctx, { clientOrderId: "c1", lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total, payments: [{ clientPaymentId: "p1", method: "cash", amount: total, tenderedAmount: total }] });
    const [row] = await withTenant(tenantId, (tx) => tx.select().from(orders).where(eq(orders.id, r.orderId)));
    const businessDate = localDateKey(row.placedAt, "Africa/Cairo");
    const { run } = await runDailyClose({ tenantId, businessDate, runByUserId: ctx.cashierUserId });
    expect(run.kind).toBe("daily_close");
    expect(run.status).toBe("balanced");
    const all = await withTenant(tenantId, (tx) => tx.select().from(reconciliationRuns));
    expect(all.filter((x) => x.kind === "daily_close")).toHaveLength(1);
  });

  it("re-running the same day appends a new run and never mutates the prior", async () => {
    const { ctx, tenantId, productId, total } = await seedPosContext("owner");
    const r = await recordSale(ctx, { clientOrderId: "c1", lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total, payments: [{ clientPaymentId: "p1", method: "cash", amount: total, tenderedAmount: total }] });
    const [row] = await withTenant(tenantId, (tx) => tx.select().from(orders).where(eq(orders.id, r.orderId)));
    const businessDate = localDateKey(row.placedAt, "Africa/Cairo");
    const first = await runDailyClose({ tenantId, businessDate });
    const second = await runDailyClose({ tenantId, businessDate });
    expect(second.run.id).not.toBe(first.run.id);
    const [reread] = await withTenant(tenantId, (tx) => tx.select().from(reconciliationRuns).where(eq(reconciliationRuns.id, first.run.id)));
    expect(reread.createdAt.getTime()).toBe(first.run.createdAt.getTime()); // untouched
  });
});
```

- [ ] **Step 2: Run to verify they fail.** `npx vitest run src/server/reconciliation/daily-close.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `audit-anchor.ts`.** `anchorRun` feature-detects the audit module: probe that `audit_events` exists, then `await recordAuditEvent({ tenantId, branchId, actorUserId: runByUserId, fingerprint }, { action: "reconciliation.daily_close", entityType: "reconciliation_run", entityId: run.id, summary: …, metadata: { businessDate, status, expectedMinor, countedMinor, varianceMinor } }, tx)` and read back the tenant's latest `audit_events` row id (max seq) as the anchor; on any absence/failure return `null` (the close must never fail because Spec 4 is missing). `alertOnExceptions` probes for the Spec 5 `notifications` table and inserts one alert row when `exceptions.length > 0`; no-op otherwise. Keep both seams tiny and dependency-free — dynamic `import()` guarded by the table probe, exactly as the specs' degrade paths require.

- [ ] **Step 4: Implement `daily-close.ts`.** Resolve `tz` via `getTenantById`. In one `withTenant` transaction: select orders for the day with `WHERE (placed_at AT TIME ZONE ${tz})::date = ${businessDate}` (+ optional `branchId`); run `reconcileOrderTenders` over their ids; find each `open`/`closed` shift touching the day (if Spec 2 present) and run `reconcileCashDrawer`; build `channelBreakdown` = per-channel (`web`/`pos`) × per-method (`cash`/`card`/`wallet`/`online`/`refund`) minor totals, netting `refund_payments` (Spec 3; 0 until landed); compute the headline `expectedMinor` (Σ paid-order totals) / `countedMinor` (net takings) / `varianceMinor`; set `status` = `partial` if the cash layer was `available: false`, else `exceptions` if any exception exists, else `balanced`; insert the `reconciliation_run` and all `reconciliation_exceptions`; `anchorRun(tx, …)` → update the run's `auditEventId` **in the same tx** (the one permitted write to a run, immediately at creation, before it is ever observed). After commit, `alertOnExceptions`. Layer (c) is not called — leave a one-line `// PARKED: settlement layer runs here when the gateway lands (Task 5).`

- [ ] **Step 5: Run to verify + typecheck.** `npx vitest run src/server/reconciliation/daily-close.test.ts && npx tsc --noEmit` → PASS, clean.

- [ ] **Step 6: Commit.**

```bash
git add src/server/reconciliation/audit-anchor.ts src/server/reconciliation/daily-close.ts src/server/reconciliation/daily-close.test.ts
git commit -m "feat(reconciliation): daily close — tenant-tz cross-channel aggregate, immutable run, Spec 4 anchor, Spec 5 alert"
```

---

## Task 5: [PARKED — pending gateway choice (ROADMAP D3)] External settlement layer (c)

**Do not implement in this plan.** Layer (c) matches a gateway's payout/settlement lines to recorded tenders by `processorTxnId`; it cannot exist until a payment gateway (Paymob, per D3) is signed off and Part A of the spec lands. Roadmap D3 and open question #1 hold this parked as of 2026-07-24.

- [ ] **Stub only.** Create `src/server/reconciliation/settlement.ts` containing a single documented placeholder that throws `SettlementLayerParkedError`, plus a comment noting what arrives when the gateway lands: the `settlement_batches` / `settlement_lines` tables (canonical roadmap names, Payments namespace), `fetchSettlement(dateRange)` import into those tables, `processorTxnId` matching against `order_payments.processorTxnId`, and the `matched | unmatched | fee_only` / `net = gross − fee` reconciliation that raises `unmatched_payout`, `unsettled_tender`, `amount_mismatch`, and `fee_gap` exceptions (codes already reserved in Task 1's enum; the `settlement` run-kind already reserved). The daily close's `// PARKED` seam (Task 4) is where it plugs in — **no schema or orchestrator change** will be needed then. No further steps; no test; do not expand.

---

## Task 6: Permissions + dashboard reconciliation view & routes

Add the two new permissions, then the read surface and the dashboard view, gated by `reconciliation:manage` (run/resolve) and `reports:financial` (view money-bearing runs). **No HTTP endpoint mutates a run's totals** — the only write route is exception *resolution*; runs are produced only by the daily-close service under the same guard.

**Files:**
- Modify: `src/server/rbac/permissions.ts`, test `src/server/rbac/permissions.test.ts`
- Create: `src/server/reconciliation/read.ts`, `src/server/reconciliation/read.test.ts`
- Create: `src/app/dashboard/reconciliation-permission.ts`
- Create: `src/app/api/reconciliation/runs/route.ts`, `src/app/api/reconciliation/runs/[id]/route.ts`, `src/app/api/reconciliation/exceptions/[id]/resolve/route.ts`, `src/app/api/reconciliation/daily-close/route.ts`
- Create: `src/app/dashboard/reconciliation/page.tsx`

**Interfaces:**
- Produces: permissions `reconciliation:manage` (owner + manager) and `reports:financial` (owner + manager); `listRuns`, `getRun` (run + exceptions + breakdown), `resolveException(ctx, exceptionId, { note })`; `requireReconciliationPermission()`, `requireFinancialReportsPermission()`.

- [ ] **Step 1: Write the failing permission test.** Append to `src/server/rbac/permissions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ROLE_PERMISSIONS } from "./permissions";

describe("reconciliation permissions", () => {
  it("reconciliation:manage is owner + manager, not staff", () => {
    expect(ROLE_PERMISSIONS.owner).toContain("reconciliation:manage");
    expect(ROLE_PERMISSIONS.manager).toContain("reconciliation:manage");
    expect(ROLE_PERMISSIONS.staff).not.toContain("reconciliation:manage");
  });
  it("reports:financial is owner + manager, not staff", () => {
    expect(ROLE_PERMISSIONS.owner).toContain("reports:financial");
    expect(ROLE_PERMISSIONS.manager).toContain("reports:financial");
    expect(ROLE_PERMISSIONS.staff).not.toContain("reports:financial");
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `npx vitest run src/server/rbac/permissions.test.ts` → FAIL.

- [ ] **Step 3: Implement the permissions.** In `src/server/rbac/permissions.ts` add `"reconciliation:manage"` and `"reports:financial"` to the `PERMISSIONS` array, then append both to the `owner` and `manager` arrays in `ROLE_PERMISSIONS` (not `staff`). Per the roadmap, `reports:financial` is deliberately owner **+ manager** so a branch manager can close their own day.

- [ ] **Step 4: Write the failing read tests.** Create `src/server/reconciliation/read.test.ts` — seed runs via `runDailyClose`, then assert: `listRuns(tenantId, { businessDate })` returns the day's runs newest-first; `getRun` returns one run with its `exceptions` array; `resolveException` sets `resolvedByUserId`/`resolvedAt`/`resolutionNote` and is idempotent (re-resolving overwrites the note, never duplicates); RLS: `listRuns(tenantA)` never returns tenant B's runs.

- [ ] **Step 5: Run to verify it fails.** `npx vitest run src/server/reconciliation/read.test.ts` → FAIL (module not found).

- [ ] **Step 6: Implement `read.ts`.** `listRuns` / `getRun` query through `withTenant`, ordered by `createdAt desc`; `getRun` joins `reconciliation_exceptions` by `runId`. `resolveException` updates only the three resolution fields (the sole permitted mutation on the exception table) inside `withTenant`.

- [ ] **Step 7: Implement the permission guards + routes.** Create `src/app/dashboard/reconciliation-permission.ts` mirroring `src/app/dashboard/orders-permission.ts` — `requireReconciliationPermission` asserts `reconciliation:manage`; `requireFinancialReportsPermission` asserts `reports:financial`. Then the routes, each resolving the tenant from the web session and mapping `UnauthorizedError` → `403`:
  - `POST /api/reconciliation/daily-close` — body `{ businessDate, branchId? }`, guard `reports:financial`, calls `runDailyClose`.
  - `POST /api/reconciliation/runs` — body `{ kind, businessDate, branchId?, shiftId? }`, guard `reconciliation:manage`, runs the layer(s) and returns run + exceptions.
  - `GET /api/reconciliation/runs?businessDate=…` and `GET /api/reconciliation/runs/[id]` — guard `reports:financial`, call `listRuns` / `getRun`.
  - `POST /api/reconciliation/exceptions/[id]/resolve` — body `{ note }`, guard `reconciliation:manage`, calls `resolveException`.

- [ ] **Step 8: Build the view.** Create `src/app/dashboard/reconciliation/page.tsx` — a server component calling `requireFinancialReportsPermission()` then `listRuns` for the selected day. Render a **status banner** per run (green `balanced` / amber `partial` / red `exceptions`), the headline expected/counted/variance via `fromMinor`, the `channelBreakdown` table (channel × method), and an exceptions list with a **Resolve** action (posting to the resolve route, `reconciliation:manage` only). Follow the styling of an existing dashboard list page (e.g. `src/app/dashboard/orders`).

- [ ] **Step 9: Run tests + typecheck + lint.**

```bash
npx vitest run src/server/rbac/permissions.test.ts src/server/reconciliation/read.test.ts && npx tsc --noEmit && npx eslint src/server/reconciliation src/server/rbac src/app/api/reconciliation src/app/dashboard/reconciliation
```

Expected: PASS, clean.

- [ ] **Step 10: Commit.**

```bash
git add src/server/rbac/permissions.ts src/server/rbac/permissions.test.ts src/server/reconciliation/read.ts src/server/reconciliation/read.test.ts src/app/dashboard/reconciliation-permission.ts src/app/api/reconciliation src/app/dashboard/reconciliation
git commit -m "feat(reconciliation): reconciliation:manage + reports:financial, read API, resolve, dashboard view"
```

---

## Task 7: Full-suite verification and manual acceptance

**Files:** none — this task changes nothing. It proves the spec.

- [ ] **Step 1: Run everything.**

```bash
npm test
npx tsc --noEmit
npx eslint src
```

Expected: all PASS, all clean. Fix anything that is not before continuing.

- [ ] **Step 2: Walk the spec's acceptance path.** With `npm run dev` up, on a tenant with a day of mixed `web` + `pos` cash sales:

- [ ] Ring/seed a balanced day, `POST /api/reconciliation/daily-close`, open `/dashboard/reconciliation` → banner reads **balanced**, breakdown sums match the sales.
- [ ] Corrupt one tender amount in `psql`, re-run the close → a **new** run appears (the prior untouched), status **exceptions**, one `tender_total_mismatch` listed; resolve it with a note as owner; a `staff` user gets **403** on the resolve route.
- [ ] Confirm a `23:30 Africa/Cairo` order buckets into that Cairo day (not the UTC-next day).
- [ ] If Spec 2 is present: seed a shift with a planted short → `cash_variance` of the right sign; if absent → the close is **partial** and the cash layer reads unavailable.
- [ ] If Spec 4 is present: the `daily_close` run has a non-null `auditEventId` and that `audit_events` row chains onto the head; if absent → `auditEventId` null and the close still completed.

- [ ] **Step 3: Open the PR.**

```bash
git push -u origin HEAD
gh pr create --title "feat(reconciliation): order↔tender integrity + cash-drawer + daily close (settlement parked)" --body "$(cat <<'EOF'
Implements Part B of docs/ailab/specs/2026-07-24-payments-gateway-and-reconciliation-design.md (Spec 7, decision D2) — the reconciliation layers that need no payment gateway.

- reconciliation_runs (immutable snapshots) + reconciliation_exceptions (FORCE RLS,
  canonical names). All money in integer minor units; ±1-piastre tie tolerance.
- Layer (a) order↔tender integrity: Σ tenders (net of change) == total, orphan
  tenders, duplicate clientPaymentId. Layer (b) cash-drawer variance from Spec 2
  cash_counts, degrading to "unavailable" when Spec 2 is absent.
- Daily close: aggregates web + pos for a business day in the tenant timezone,
  writes one daily_close run, anchors it into the Spec 4 audit chain (auditEventId,
  null when Spec 4 absent), and raises a Spec 5 alert on exceptions.
- reconciliation:manage + reports:financial (owner + manager); read API + resolve +
  dashboard view.

PARKED: layer (c) external settlement (settlement_batches / settlement_lines +
processorTxnId matching) is held pending the gateway choice (ROADMAP D3, open
question #1). The settlement run-kind and exception codes are reserved so nothing
schema-level changes when the gateway lands.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage (Part B):**
- *Data model* — `reconciliation_runs` (businessDate in tenant tz, branch/shift scope, totals-by-method in `channelBreakdown`, status, `auditEventId`) + `reconciliation_exceptions` (orphan/mismatch/duplicate/cash-variance codes + reserved settlement codes), FORCE RLS, immutable → **Task 1**.
- *Layer (a) order↔tender integrity* — Σ tenders net of change == total, tips excluded, orphan tenders, duplicate `clientPaymentId`, integer minor units → **Task 2**.
- *Layer (b) cash drawer* — Spec 2 `cash_counts` expected-vs-counted variance, degrades cleanly when Spec 2 absent → **Task 3**.
- *Daily close* — cross-channel (web + pos) aggregate in tenant timezone, one immutable `daily_close` run, hash-anchored Spec 4 audit event, Spec 5 notification on exceptions → **Task 4**.
- *Layer (c) external settlement* — **PARKED** (ROADMAP D3); stub + reserved enum values only → **Task 5**.
- *Authorization + read surface* — `reconciliation:manage` / `reports:financial`, read API, resolve, dashboard view → **Task 6**.
- *Testing* (unit / server / manual acceptance) — every task, plus **Task 7**.

**Deliberate deferrals:** (1) Layer (c) is parked per D3/open-question-#1 — settlement tables, `fetchSettlement`, and `processorTxnId` matching land with the gateway; the enum reservations mean zero schema churn then. (2) The Spec 4 anchor and Spec 5 alert are **best-effort feature-detected seams** (`audit-anchor.ts`): the close never fails because a prerequisite hasn't landed — `auditEventId` stays null (Spec 4) / the alert is a no-op (Spec 5), exactly as the spec's degrade path prescribes. (3) The cash layer (b) is gated on Spec 2's `pos_shifts`/`cash_counts`; absent them it reports `unavailable` and the day is `partial`, never falsely `balanced`.

**Type + math consistency:** `toMinor`/`fromMinor`/`withinTolerance` (Task 2, `minor.ts`) are the single money vocabulary used by layer (a), layer (b), and the daily-close headline/breakdown — no float sums cross a row boundary. `IntegrityException` (Task 2) is the exception shape layer (b) reuses and the daily close persists into `reconciliation_exceptions`. `localDateKey(date, tz)` (`src/server/branches/slots.ts`) and the `(placed_at AT TIME ZONE $tz)::date` SQL are the one business-day bucketing rule, applied identically on read and write so a Cairo day is never split by the UTC boundary. Immutability is a structural invariant: `reconciliation_runs` totals/status are written once; the only post-write mutation anywhere is `auditEventId` (set in-tx at creation) and the three exception-resolution fields.
