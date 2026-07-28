# Shifts & Cash Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use mo-ai:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every cash tender a **session** — a cashier's shift at one device/drawer — and make the drawer accountable. Opening a shift records an **opening float**; every cash tender written during it is stamped with the reserved-and-unused `order_payments.shiftId`; cash entering or leaving the drawer outside a sale is an explicit, attributed `cash_movements` row; and closing takes a physical `cash_counts` count, computes **expected** cash by one normative formula, and records the **variance** (over/short). Supports a per-tenant **blind close**. Produces the **Z-report** data at close and a non-resetting **X-report** mid-shift (rendering deferred to Spec 10). Every open, close, movement, and count emits a Spec 4 audit event. Implements `docs/ailab/specs/2026-07-24-shifts-and-cash-drawer-design.md` (Spec 2 of `docs/ROADMAP.md`).

**Architecture:** A shift is the thing *between* the device (`pos_devices`, control-plane) and the tender (`order_payments`, already carrying an unused `shiftId uuid` — `src/server/pos/tender-schema.ts:29`). `openShift` serializes on `pg_advisory_xact_lock(hashtext(deviceId)::bigint)` — the exact lock discipline `placeOrder` uses for order numbers (`src/server/ordering/service.ts:230`) — asserts no open shift, and the DB backs it with a **unique partial index** `(deviceId) WHERE status = 'open'` (belt and suspenders). `recordSale`/`addTender` (`src/server/pos/record-sale.ts`) look up the device's open shift and stamp every tender's `shiftId`; a **cash** tender with no open shift is refused (`NoOpenShiftError`). Close reads the shift's cash tenders and `cash_movements`, runs the single expected-cash formula in a **pure** module (`src/server/pos/shift-math.ts`), and writes a `closing` `cash_counts` row with the variance. All three new tables are tenant-scoped with FORCE RLS reached only through `withTenant` (`src/db/with-tenant.ts`); `pos_devices` stays control-plane. All money stays `numeric` strings via `money(n)` (`src/server/ordering/service.ts:55`).

**Tech Stack:** Next.js (App Router), Drizzle ORM + Postgres (RLS via `withTenant`), Vitest against a remote Supabase Postgres. No new runtime dependencies.

## Global Constraints

- **`money(n)` is the only money formatter.** Every amount is a `numeric` string via `money(n)` (`src/server/ordering/service.ts:55`); no raw JS float is ever written to the DB, and every sum is rounded through it. No arithmetic lives in a route or component.
- **The expected-cash formula has exactly one implementation** — `computeExpectedCash` in `src/server/pos/shift-math.ts` (pure, no DB). The close path, the X-report, and any future consumer call it; there is never a second copy. This mirrors the "one canonical serializer" rule the audit plan enforces.
- **Tenant-scoped tables are behind RLS.** `pos_shifts`, `cash_counts`, `cash_movements` are `ENABLE` + `FORCE ROW LEVEL SECURITY` with the house isolation policy `USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)` and the same `WITH CHECK`. Every read/write goes through `withTenant(tenantId, tx => …)`. `pos_devices` stays control-plane (no RLS), as today.
- **At most one open shift per device is an invariant, not a convention.** It is enforced twice: the `openShift` advisory lock serializes the open, and a **unique partial index** `(deviceId) WHERE status = 'open'` makes a bypassing second `INSERT` fail. A movement `amount`'s sign is likewise enforced by a DB `CHECK`, not just by service code.
- **Cash never lands in an unaccounted drawer.** A cash tender with no open shift is refused before any write (`NoOpenShiftError`). Card/other tenders are allowed and are stamped when a shift is open, null when none.
- **Audit emission shares the mutation's transaction.** Each shift open/close, movement, and count calls `recordAuditEvent(ctx, event, tx)` (Spec 4, `src/server/audit/service.ts`) on the **same** `tx`, so the audit row rolls back with the mutation. This plan assumes Spec 4 is merged into `feat/pos-core-ops` first (it is parallelizable and already specced/planned). If it is not yet merged, the emission block and its assertions are the only lines to omit — the shift math is unaffected (the spec's explicit no-op guarantee).
- **Tips never enter the drawer math.** Cash tenders contribute `amount` (i.e. `tenderedAmount − changeAmount`); `tipAmount` is excluded, consistent with Spec 1.
- Run `npx tsc --noEmit && npx eslint <files>` before every commit. Both must be clean.

---

## File Structure

**Database**
- Create: `src/server/pos/shift-schema.ts` — `pos_shifts`, `cash_counts`, `cash_movements`; enums `pos_shift_status`, `cash_count_kind`, `cash_movement_type`.
- Modify: `src/db/schema.ts` — register the new schema barrel export.
- Create: `drizzle/00XX_*.sql` — generated migration; RLS policies, the partial unique index predicate, and the movement-sign `CHECK` hand-appended.

**Authorization & policy**
- Modify: `src/server/rbac/permissions.ts` — add `reconciliation:manage` (owner + manager).
- Modify: `src/server/pos/cashier.ts` — `posPermissionsFor` surfaces `reconciliation:manage` (not only `pos:*`).
- Modify: `src/app/api/pos/v1/authorize/route.ts` — allow grants for `reconciliation:manage`.
- Modify: `src/server/tenancy/settings.ts` — `ShiftPolicy` + `getShiftPolicy` (blindClose, payoutThreshold, varianceThreshold).

**Core (pure + services)**
- Create: `src/server/pos/shift-math.ts` (+ `.test.ts`) — `computeExpectedCash`, `computeVariance`, `sumDenominations`, `isVarianceFlagged`.
- Create: `src/server/pos/shifts.ts` (+ `.test.ts`) — `openShift`, `findOpenShift`, `closeShift`, `buildXReport`, `buildZReport`.
- Create: `src/server/pos/cash-movements.ts` (+ `.test.ts`) — `recordCashMovement`.
- Modify: `src/server/pos/record-sale.ts` — stamp `order_payments.shiftId`; refuse cash with no open shift.
- Modify: `src/server/pos/errors.ts` — `NoOpenShiftError`, `ShiftAlreadyOpenError`, `ShiftClosedError`, `CashCountMismatchError`, `CashMovementError`.

**API**
- Create: `src/app/api/pos/v1/shifts/open/route.ts`, `close/route.ts`, `current/route.ts`, `movements/route.ts`.
- Modify: `src/app/api/pos/v1/sales/route.ts`, `src/app/api/pos/v1/sales/[id]/payments/route.ts` — map `NoOpenShiftError` → 409.
- Modify: `src/server/pos/test-helpers.ts` — `openShiftForCtx` helper for sale/movement fixtures.

---

## Task 1: Schema — `pos_shifts` + `cash_counts` + `cash_movements`

Three tables, canonical roadmap names, all tenant-scoped with FORCE RLS. Drizzle's generator does **not** emit RLS policies, and it does not reliably emit an index `WHERE` predicate or a `CHECK` constraint (no schema file in this repo declares `pgPolicy`), so — exactly as `drizzle/0016_bitter_beast.sql:67-81` did for the tender tables — the RLS block, the partial-index predicate, and the movement-sign `CHECK` are **hand-appended** to the generated migration.

**Files:**
- Create: `src/server/pos/shift-schema.ts`
- Modify: `src/db/schema.ts`
- Create: `drizzle/00XX_*.sql` (generated, then edited)

**Interfaces:**
- Produces: tables `posShifts`, `cashCounts`, `cashMovements`; enums `posShiftStatusEnum` (`open | closed`), `cashCountKindEnum` (`opening | closing | mid_shift`), `cashMovementTypeEnum` (`pay_in | pay_out | safe_drop | no_sale`); types `PosShift`, `CashCount`, `CashMovement`.

- [ ] **Step 1: Write the schema.** Create `src/server/pos/shift-schema.ts`:

```ts
import { pgTable, uuid, text, timestamp, numeric, jsonb, pgEnum, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { users } from "@/server/auth/schema";
import { posDevices } from "./schema";

export const posShiftStatusEnum = pgEnum("pos_shift_status", ["open", "closed"]);
export const cashCountKindEnum = pgEnum("cash_count_kind", ["opening", "closing", "mid_shift"]);
export const cashMovementTypeEnum = pgEnum("cash_movement_type", ["pay_in", "pay_out", "safe_drop", "no_sale"]);

/** A cashier's session at one device/drawer. At most one `open` per device. */
export const posShifts = pgTable("pos_shifts", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
  deviceId: uuid("device_id").notNull().references(() => posDevices.id, { onDelete: "cascade" }),
  openedByUserId: uuid("opened_by_user_id").notNull().references(() => users.id),
  closedByUserId: uuid("closed_by_user_id").references(() => users.id),
  status: posShiftStatusEnum("status").notNull().default("open"),
  openingFloat: numeric("opening_float").notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
}, (t) => [
  // The hard guarantee: one open shift per drawer. Verify the WHERE predicate
  // survives generation (Step 4) — it is what makes this a *partial* unique.
  uniqueIndex("pos_shifts_device_open").on(t.deviceId).where(sql`status = 'open'`),
  index("pos_shifts_tenant_branch_status").on(t.tenantId, t.branchId, t.status),
  index("pos_shifts_device_status").on(t.deviceId, t.status),
]);

/** Cash entering/leaving the drawer outside a sale — the physical-drawer audit trail. */
export const cashMovements = pgTable("cash_movements", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  shiftId: uuid("shift_id").notNull().references(() => posShifts.id, { onDelete: "cascade" }),
  type: cashMovementTypeEnum("type").notNull(),
  // Signed by type: pay_in > 0; pay_out & safe_drop < 0; no_sale = 0. Enforced
  // by the cash_movements_amount_sign CHECK hand-appended in Step 4.
  amount: numeric("amount").notNull(),
  reasonCode: text("reason_code").notNull(),
  reasonText: text("reason_text"),
  byUserId: uuid("by_user_id").notNull().references(() => users.id),
  authorizedByUserId: uuid("authorized_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("cash_movements_shift_type").on(t.shiftId, t.type)]);

/** A physical count of the drawer and the variance it implies. */
export const cashCounts = pgTable("cash_counts", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  shiftId: uuid("shift_id").notNull().references(() => posShifts.id, { onDelete: "cascade" }),
  kind: cashCountKindEnum("kind").notNull(),
  countedTotal: numeric("counted_total").notNull(),
  denominations: jsonb("denominations").$type<Record<string, number>>(),
  expectedTotal: numeric("expected_total").notNull(),
  variance: numeric("variance").notNull(),
  byUserId: uuid("by_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("cash_counts_shift_kind").on(t.shiftId, t.kind)]);

export type PosShift = typeof posShifts.$inferSelect;
export type CashMovement = typeof cashMovements.$inferSelect;
export type CashCount = typeof cashCounts.$inferSelect;
```

- [ ] **Step 2: Register it.** Append to `src/db/schema.ts` (after the `pos/tender-schema` line):

```ts
export * from "../server/pos/shift-schema";
```

- [ ] **Step 3: Generate the migration.**

```bash
npm run db:generate
```

Expected: a new `drizzle/00XX_*.sql` creating the three enums, three tables, FKs, and indexes. It will **not** contain RLS policies.

- [ ] **Step 4: Hand-append RLS, the partial-index predicate, and the sign CHECK.** Open the generated file. First **verify** the `pos_shifts_device_open` index carries `WHERE status = 'open'`; if the generator emitted it as a plain `CREATE UNIQUE INDEX … ("device_id")` without the predicate, replace that line with the partial form below. Then append the RLS block (mirror `drizzle/0016_bitter_beast.sql:67-81`) and the `CHECK`:

```sql
--> statement-breakpoint
-- Ensure the one-open-per-device index is PARTIAL (replace the generated line if needed):
DROP INDEX IF EXISTS "pos_shifts_device_open";--> statement-breakpoint
CREATE UNIQUE INDEX "pos_shifts_device_open" ON "pos_shifts" ("device_id") WHERE status = 'open';--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_amount_sign" CHECK (
  (type = 'pay_in' AND amount > 0) OR
  (type IN ('pay_out','safe_drop') AND amount < 0) OR
  (type = 'no_sale' AND amount = 0)
);--> statement-breakpoint
ALTER TABLE "pos_shifts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pos_shifts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY pos_shifts_isolation ON "pos_shifts"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "cash_movements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cash_movements" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY cash_movements_isolation ON "cash_movements"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "cash_counts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cash_counts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY cash_counts_isolation ON "cash_counts"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

- [ ] **Step 5: Apply and confirm the existing suite still passes.**

```bash
npm run db:migrate:test
npm test
```

Expected: migration applies; full suite PASS (nothing references the new tables yet). `src/db/test-harness.ts`'s `TRUNCATE … RESTART IDENTITY CASCADE` still resets the new tables between tests.

- [ ] **Step 6: Commit.**

```bash
git add src/server/pos/shift-schema.ts src/db/schema.ts drizzle/
git commit -m "feat(pos): pos_shifts + cash_counts + cash_movements with FORCE RLS, one-open-per-device partial index, movement-sign check"
```

---

## Task 2: Authorization & policy groundwork

Two prerequisites the drawer needs before any service is written. First, the `reconciliation:manage` permission (owner + manager, per the roadmap): a cashier is trusted to run their own drawer with `pos:sell`, but closing **another's** shift, approving a flagged variance, and authorizing an over-threshold `pay_out` are manager actions. Because the POS cashier session only carries `pos:*` permissions today (`posPermissionsFor`, `src/server/pos/cashier.ts:32`), this task also surfaces `reconciliation:manage` into the session and lets the `/authorize` route mint grants for it, so `resolveAuthorizer` works exactly as it does for `pos:discount`. Second, the per-tenant policy (`blindClose`, `payoutThreshold`, `varianceThreshold`) lives in the existing `tenant_settings` bag.

**Files:**
- Modify: `src/server/rbac/permissions.ts` (+ `permissions.test.ts`)
- Modify: `src/server/pos/cashier.ts`
- Modify: `src/app/api/pos/v1/authorize/route.ts`
- Modify: `src/server/tenancy/settings.ts` (+ `settings.test.ts`)

**Interfaces:**
- Produces:
  - Permission `reconciliation:manage` — held by `owner` and `manager`, not `staff`.
  - `posPermissionsFor` now includes `reconciliation:manage` when the user's roles grant it.
  - `type ShiftPolicy = { blindClose: boolean; payoutThreshold: number; varianceThreshold: number }`
  - `function getShiftPolicy(tenantId: string): Promise<ShiftPolicy>` — defaults `{ blindClose: false, payoutThreshold: 0, varianceThreshold: 0 }`.

- [ ] **Step 1: Write the failing permission test.** Append to `src/server/rbac/permissions.test.ts`:

```ts
describe("reconciliation:manage", () => {
  it("is held by owner and manager, not staff", () => {
    expect(ROLE_PERMISSIONS.owner).toContain("reconciliation:manage");
    expect(ROLE_PERMISSIONS.manager).toContain("reconciliation:manage");
    expect(ROLE_PERMISSIONS.staff).not.toContain("reconciliation:manage");
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `npx vitest run src/server/rbac/permissions.test.ts` — FAIL.

- [ ] **Step 3: Add the permission.** In `src/server/rbac/permissions.ts` add `"reconciliation:manage",` to the `PERMISSIONS` array, and append it to the `owner` and `manager` arrays in `ROLE_PERMISSIONS`.

- [ ] **Step 4: Surface it in the cashier session.** In `src/server/pos/cashier.ts`, widen `posPermissionsFor`'s filter so managers/owners carry it directly (staff never will, because their role does not grant it):

```ts
    for (const p of ROLE_PERMISSIONS[key] ?? []) {
      if (p.startsWith("pos:") || p === "reconciliation:manage") all.add(p);
    }
```

- [ ] **Step 5: Let `/authorize` mint the grant.** In `src/app/api/pos/v1/authorize/route.ts`, relax the guard that today requires `permission.startsWith("pos:")` so a manager can also authorize `reconciliation:manage`:

```ts
  const grantable = permission.startsWith("pos:") || permission === "reconciliation:manage";
  if (!PERMISSIONS.includes(permission as Permission) || !grantable) {
    return NextResponse.json({ error: "Unknown permission" }, { status: 400 });
  }
```

- [ ] **Step 6: Write the failing policy test.** Append to `src/server/tenancy/settings.test.ts`: seed a tenant, assert `getShiftPolicy` returns the defaults `{ blindClose: false, payoutThreshold: 0, varianceThreshold: 0 }`, then patch `tenant_settings.data.shiftPolicy = { blindClose: true, payoutThreshold: 500, varianceThreshold: 20 }` and assert it round-trips.

- [ ] **Step 7: Implement.** In `src/server/tenancy/settings.ts`, extend `TenantSettingsData` with `shiftPolicy?: ShiftPolicy` and add:

```ts
export type ShiftPolicy = { blindClose: boolean; payoutThreshold: number; varianceThreshold: number };

export async function getShiftPolicy(tenantId: string): Promise<ShiftPolicy> {
  const s = (await getTenantSettings(tenantId)).shiftPolicy;
  return {
    blindClose: s?.blindClose ?? false,
    payoutThreshold: s?.payoutThreshold ?? 0,
    varianceThreshold: s?.varianceThreshold ?? 0,
  };
}
```

- [ ] **Step 8: Run + typecheck + commit.**

```bash
npx vitest run src/server/rbac/permissions.test.ts src/server/tenancy/settings.test.ts && npx tsc --noEmit
git add src/server/rbac/permissions.ts src/server/rbac/permissions.test.ts src/server/pos/cashier.ts src/app/api/pos/v1/authorize/route.ts src/server/tenancy/settings.ts src/server/tenancy/settings.test.ts
git commit -m "feat(pos): reconciliation:manage permission + grantable + per-tenant shift policy (blindClose, thresholds)"
```

---

## Task 3: Shift service — open + current-shift lookup

The drawer's life begins here. `openShift` takes the device advisory lock (`hashtext(deviceId)` — the spec's chosen key, distinct from `placeOrder`'s per-tenant key), asserts no open shift, inserts the `pos_shifts` row (`status: 'open'`) plus an `opening` `cash_counts` row, and emits `shift.open`. `findOpenShift` is the "current shift" read every tender stamp and every movement/close will use — a single indexed lookup on `(deviceId, status)`. **Close is deliberately deferred to Task 6**, because it is inseparable from the expected-cash math built there; building it here would mean building it twice.

**Files:**
- Create: `src/server/pos/shifts.ts`
- Modify: `src/server/pos/errors.ts`
- Test: `src/server/pos/shifts.test.ts`

**Interfaces:**
- Consumes: `withTenant`; `money` (`@/server/ordering/service`); `posShifts`, `cashCounts` (Task 1); `sumDenominations` (Task 6 — imported lazily only in the denomination guard, or inline the trivial sum here and share in Task 6); `recordAuditEvent`, `type AuditContext` (`@/server/audit/service`); `PosCashierContext`.
- Produces:
  - `type OpenShiftInput = { openingFloat: number; denominations?: Record<string, number> }`
  - `function openShift(ctx: PosCashierContext, input: OpenShiftInput): Promise<PosShift>`
  - `function findOpenShift(tenantId: string, deviceId: string): Promise<PosShift | null>`
  - Errors `ShiftAlreadyOpenError`, `NoOpenShiftError`, `ShiftClosedError`, `CashCountMismatchError` (added to `src/server/pos/errors.ts`).

- [ ] **Step 1: Add the errors.** In `src/server/pos/errors.ts` add `ShiftAlreadyOpenError` (device already has an open shift), `NoOpenShiftError` (a cash tender / movement with no open shift), `ShiftClosedError` (acting on a closed shift), and `CashCountMismatchError` (denominations don't sum to the counted total) — each a small `Error` subclass with a stable `name`, matching the existing `PosSaleError` shape.

- [ ] **Step 2: Write the failing tests.** Create `src/server/pos/shifts.test.ts`. Seed with `seedPosContext` and assert:
  - `openShift` returns a shift with `status: 'open'`, `openingFloat` = `money(input)`, `openedByUserId` = `ctx.cashierUserId`, and writes an `opening` `cash_counts` row whose `countedTotal` = `expectedTotal` = the float and `variance` = `"0.00"`.
  - a second `openShift` on the **same device** throws `ShiftAlreadyOpenError` (the advisory lock path), and the DB has exactly one open shift for that device.
  - `findOpenShift(tenantId, deviceId)` returns the open shift, and `null` after there is none.
  - opening with `denominations` that do **not** sum to `openingFloat` throws `CashCountMismatchError`.
  - RLS: `findOpenShift` for tenant B never sees tenant A's shift (seed two contexts).
  - a `shift.open` audit row is appended in the same tx (skip if Spec 4 not merged).

```ts
it("enforces one open shift per device", async () => {
  const { ctx } = await seedPosContext("owner");
  await openShift(ctx, { openingFloat: 100 });
  await expect(openShift(ctx, { openingFloat: 100 })).rejects.toBeInstanceOf(ShiftAlreadyOpenError);
});
```

- [ ] **Step 3: Run to verify they fail.** `npx vitest run src/server/pos/shifts.test.ts` — FAIL (module not found).

- [ ] **Step 4: Implement `openShift` + `findOpenShift`.** Create `src/server/pos/shifts.ts`. `openShift` runs inside `withTenant(ctx.tenantId, async (tx) => { … })`:

```ts
export async function openShift(ctx: PosCashierContext, input: OpenShiftInput): Promise<PosShift> {
  if (input.denominations && sumDenominations(input.denominations) !== round2(input.openingFloat)) {
    throw new CashCountMismatchError();
  }
  return withTenant(ctx.tenantId, async (tx) => {
    // Same lock discipline as placeOrder's order-number step, keyed on the drawer.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ctx.deviceId})::bigint)`);
    const [open] = await tx.select().from(posShifts)
      .where(and(eq(posShifts.deviceId, ctx.deviceId), eq(posShifts.status, "open"))).limit(1);
    if (open) throw new ShiftAlreadyOpenError();

    const [shift] = await tx.insert(posShifts).values({
      tenantId: ctx.tenantId, branchId: ctx.branchId, deviceId: ctx.deviceId,
      openedByUserId: ctx.cashierUserId, status: "open", openingFloat: money(input.openingFloat),
    }).returning();

    const [count] = await tx.insert(cashCounts).values({
      tenantId: ctx.tenantId, shiftId: shift.id, kind: "opening",
      countedTotal: money(input.openingFloat), expectedTotal: money(input.openingFloat),
      variance: money(0), denominations: input.denominations ?? null, byUserId: ctx.cashierUserId,
    }).returning();

    await recordAuditEvent(auditCtx(ctx), {
      action: "shift.open", entityType: "pos_shift", entityId: shift.id,
      summary: `Shift opened on device (float ${money(input.openingFloat)})`,
      metadata: { deviceId: ctx.deviceId, openingFloat: money(input.openingFloat), countId: count.id },
      actorType: "user",
    }, tx);
    return shift;
  });
}
```

`findOpenShift` is a plain `withTenant` select on `(deviceId, status = 'open')`. Define the shared `auditCtx(ctx) = { tenantId: ctx.tenantId, branchId: ctx.branchId, actorUserId: ctx.cashierUserId, fingerprint: ctx.fingerprint }` helper at the top of the file (it is reused by close and movements). `round2`/`sumDenominations` come from Task 6's `shift-math.ts` — if implementing this task first, add `sumDenominations` there now (it is trivial and pure) so both tasks import one copy.

- [ ] **Step 5: Run to verify they pass.** `npx vitest run src/server/pos/shifts.test.ts && npx tsc --noEmit` — PASS, clean. The one-open-per-device test proves the advisory lock; the partial unique index is the backstop.

- [ ] **Step 6: Commit.**

```bash
git add src/server/pos/shifts.ts src/server/pos/shifts.test.ts src/server/pos/errors.ts
git commit -m "feat(pos): openShift (advisory-locked, one-open-per-device) + findOpenShift + shift.open audit"
```

---

## Task 4: Stamp `order_payments.shiftId` on every tender

The reserved-and-unused `shiftId` (`src/server/pos/tender-schema.ts:29`) is finally populated. `recordSale` looks up the device's open shift; a **cash** tender with no open shift is refused with `NoOpenShiftError` **before any write** (so no orphan order is created), and card/other tenders are stamped when a shift is open, null when none. `addTender` (`src/server/pos/record-sale.ts:195`) does the same inside its existing `withTenant` block.

**Files:**
- Modify: `src/server/pos/record-sale.ts`
- Test: `src/server/pos/record-sale.test.ts`

**Interfaces:**
- Consumes: `findOpenShift` (Task 3), `NoOpenShiftError` (Task 3).
- Produces: no signature change — `recordSale`/`addTender` now set `shiftId` on every `orderPayments` row.

- [ ] **Step 1: Write the failing tests.** Append to `src/server/pos/record-sale.test.ts` (open a shift with the Task 3 `openShift` first):
  - a cash sale through `recordSale` stamps `order_payments.shiftId` with the device's open shift on every tender row.
  - a cash sale with **no** open shift throws `NoOpenShiftError` and writes nothing — assert `orders`, `order_payments`, and `pos_order_receipts` are all empty for that `clientOrderId`.
  - a card-only sale with no open shift **succeeds** with `shiftId` null; the same card sale with an open shift is stamped.
  - `addTender` stamps `shiftId` from the device's open shift.

- [ ] **Step 2: Run to verify they fail.** `npx vitest run src/server/pos/record-sale.test.ts` — FAIL.

- [ ] **Step 3: Implement in `recordSale`.** Near the top (after the idempotency short-circuit, before `placeOrder`) resolve the open shift once and refuse early:

```ts
  const openShift = await findOpenShift(ctx.tenantId, ctx.deviceId);
  const hasCash = input.payments.some((p) => p.method === "cash");
  if (hasCash && !openShift) throw new NoOpenShiftError();
```

Then add `shiftId: openShift?.id ?? null` to the object returned by the `input.payments.map(...)` that builds `tenderRows` (the block at `record-sale.ts:119`). No other change — the rows are inserted in the existing `withTenant` tx.

- [ ] **Step 4: Implement in `addTender`.** Inside its `withTenant` block (`record-sale.ts:205`), after loading the order, resolve the shift with a direct `tx` select on `posShifts (deviceId, status='open')`, refuse cash with no open shift (`NoOpenShiftError`), and add `shiftId` to the `tx.insert(orderPayments).values({ … })`.

- [ ] **Step 5: Map the error at the route.** In `src/app/api/pos/v1/sales/route.ts` and `src/app/api/pos/v1/sales/[id]/payments/route.ts`, add to the `catch`:

```ts
    if (e instanceof NoOpenShiftError) {
      return NextResponse.json({ error: "Open a shift before taking cash" }, { status: 409 });
    }
```

- [ ] **Step 6: Run + typecheck + commit.**

```bash
npx vitest run src/server/pos/record-sale.test.ts && npx tsc --noEmit && npx eslint src/server/pos src/app/api/pos/v1/sales
git add src/server/pos/record-sale.ts src/server/pos/record-sale.test.ts src/app/api/pos/v1/sales
git commit -m "feat(pos): stamp order_payments.shiftId on tenders; refuse cash with no open shift"
```

---

## Task 5: `cash_movements` service — pay-in / pay-out / safe-drop / no-sale

Cash moving in or out of the drawer outside a sale, recorded as a signed, attributed row. The service **signs the amount by type** (caller passes a positive magnitude) so the DB `CHECK` and the expected-cash formula agree, and it gates an over-threshold `pay_out` through `resolveAuthorizer(ctx, "reconciliation:manage", grant)` — the same helper Spec 1 uses for a large discount/void — stamping `authorizedByUserId`. Each row emits `cash.movement`.

**Files:**
- Create: `src/server/pos/cash-movements.ts`
- Modify: `src/server/pos/errors.ts` (`CashMovementError`)
- Test: `src/server/pos/cash-movements.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `money`, `getShiftPolicy` (Task 2), `resolveAuthorizer` (`@/server/pos/grants`), `findOpenShift` (Task 3), `cashMovements` (Task 1), `recordAuditEvent`.
- Produces:
  - `type CashMovementInput = { type: CashMovementType; amount: number; reasonCode: string; reasonText?: string; grants?: { permission: Permission; token: string }[] }`
  - `function recordCashMovement(ctx: PosCashierContext, input: CashMovementInput): Promise<CashMovement>`

- [ ] **Step 1: Write the failing tests.** Create `src/server/pos/cash-movements.test.ts`. Open a shift, then assert:
  - `pay_in` of 50 stores `amount = "50.00"`; `pay_out` of 30 stores `"-30.00"`; `safe_drop` of 100 stores `"-100.00"`; `no_sale` stores `"0.00"`.
  - a `pay_out` **over** the tenant `payoutThreshold` with a `pos:sell`-only cashier and **no** grant throws `PosForbiddenError`; **with** a `reconciliation:manage` grant it succeeds and stamps `authorizedByUserId` = the manager's id.
  - a `pay_out` **at or under** threshold with `pos:sell` succeeds, `authorizedByUserId` null (or the cashier — pick one and assert it consistently; plan: null when the cashier authorizes their own routine movement).
  - a movement with no open shift throws `NoOpenShiftError`.
  - a `cash.movement` audit row is appended in the same tx.
  - a negative-magnitude or zero `pay_in` (or non-zero `no_sale`) throws `CashMovementError` before touching the DB.

- [ ] **Step 2: Run to verify they fail.** `npx vitest run src/server/pos/cash-movements.test.ts` — FAIL.

- [ ] **Step 3: Implement.** Create `src/server/pos/cash-movements.ts`:

```ts
export async function recordCashMovement(ctx: PosCashierContext, input: CashMovementInput): Promise<CashMovement> {
  const mag = round2(input.amount);
  if (input.type === "no_sale") {
    if (mag !== 0) throw new CashMovementError("A no_sale records no cash");
  } else if (!(mag > 0)) {
    throw new CashMovementError("A movement amount must be a positive magnitude");
  }
  const signed = input.type === "pay_in" ? mag : input.type === "no_sale" ? 0 : -mag;

  const shift = await findOpenShift(ctx.tenantId, ctx.deviceId);
  if (!shift) throw new NoOpenShiftError();

  // Over-threshold pay_out needs a manager. resolveAuthorizer returns the
  // cashier if they hold reconciliation:manage, else the grant's manager, else
  // throws PosForbiddenError.
  const policy = await getShiftPolicy(ctx.tenantId);
  let authorizedByUserId: string | null = null;
  if (input.type === "pay_out" && policy.payoutThreshold > 0 && mag > policy.payoutThreshold) {
    const grant = input.grants?.find((g) => g.permission === "reconciliation:manage")?.token;
    authorizedByUserId = resolveAuthorizer(ctx, "reconciliation:manage", grant);
  }

  return withTenant(ctx.tenantId, async (tx) => {
    const [row] = await tx.insert(cashMovements).values({
      tenantId: ctx.tenantId, shiftId: shift.id, type: input.type, amount: money(signed),
      reasonCode: input.reasonCode, reasonText: input.reasonText ?? null,
      byUserId: ctx.cashierUserId, authorizedByUserId,
    }).returning();
    await recordAuditEvent(auditCtx(ctx), {
      action: "cash.movement", entityType: "cash_movement", entityId: row.id,
      summary: `${input.type} ${money(signed)}`,
      metadata: { shiftId: shift.id, type: input.type, amount: money(signed), reasonCode: input.reasonCode, authorizedByUserId },
      actorType: "user",
    }, tx);
    return row;
  });
}
```

- [ ] **Step 4: Run + typecheck + commit.**

```bash
npx vitest run src/server/pos/cash-movements.test.ts && npx tsc --noEmit && npx eslint src/server/pos
git add src/server/pos/cash-movements.ts src/server/pos/cash-movements.test.ts src/server/pos/errors.ts
git commit -m "feat(pos): cash_movements service — signed by type, over-threshold pay_out needs reconciliation:manage, cash.movement audit"
```

---

## Task 6: Expected-cash formula + close flow

The heart of accountability. The **pure** `computeExpectedCash` is the single normative formula (spec §Data model); it takes the six terms and returns a rounded number, with no DB and no I/O, so it is tested with fixtures. `closeShift` gathers those terms from the shift's cash tenders and `cash_movements`, computes `expected` and `variance = counted − expected`, writes the `closing` `cash_counts` row (persisting both even under blind close), flips the shift to `closed`, emits `shift.close`, and returns the **Z-report** projection. `buildXReport` reuses the same formula for the live, non-resetting mid-shift view. Blind close and cross-user close are policy layers on top.

**Files:**
- Create: `src/server/pos/shift-math.ts` (+ `.test.ts`)
- Modify: `src/server/pos/shifts.ts` (+ `.test.ts`) — add `closeShift`, `buildXReport`, `buildZReport`
- Test: extend `src/server/pos/shifts.test.ts`

**Interfaces:**
- Produces:
  - `type ExpectedCashTerms = { openingFloat: number; cashTenders: number; cashRefunds: number; payIns: number; payOuts: number; safeDrops: number }`
  - `function computeExpectedCash(t: ExpectedCashTerms): number` — `openingFloat + cashTenders − cashRefunds − payOuts + payIns − safeDrops`.
  - `function computeVariance(counted: number, expected: number): number` — `counted − expected`.
  - `function sumDenominations(d: Record<string, number>): number` — `Σ denom·qty`.
  - `function isVarianceFlagged(variance: number, threshold: number): boolean` — `Math.abs(variance) > threshold`.
  - `type CloseShiftInput = { count: { countedTotal: number; denominations?: Record<string, number> }; grants?: { permission: Permission; token: string }[] }`
  - `function closeShift(ctx: PosCashierContext, shiftId: string, input: CloseShiftInput): Promise<ZReport>`
  - `type ZReport` / `type XReport` — tender-by-method totals, cash `expected`/`counted`/`variance` (blinded per policy), movements, sales count, discounts/voids, refunds (0 until Spec 3), `flagged`, `approvedByUserId`.

- [ ] **Step 1: Write the failing formula tests.** Create `src/server/pos/shift-math.test.ts`:

```ts
describe("computeExpectedCash", () => {
  it("sums the normative formula (tips excluded by the caller)", () => {
    // float 200 + cash 500 - refunds 0 - payouts 50 + payins 30 - drops 100 = 580
    expect(computeExpectedCash({
      openingFloat: 200, cashTenders: 500, cashRefunds: 0, payOuts: 50, payIns: 30, safeDrops: 100,
    })).toBe(580);
  });
});
describe("computeVariance", () => {
  it("is positive for an over and negative for a short", () => {
    expect(computeVariance(585, 580)).toBe(5);   // over
    expect(computeVariance(575, 580)).toBe(-5);  // short
  });
});
describe("sumDenominations", () => {
  it("multiplies denomination by quantity", () => {
    expect(sumDenominations({ "200": 3, "100": 5, "50": 2 })).toBe(1200);
  });
});
```

- [ ] **Step 2: Run to verify they fail, then implement `shift-math.ts`.** Pure functions only; every result rounded via `round2` (`Math.round(n*100)/100`). No DB.

- [ ] **Step 3: Write the failing close tests.** Extend `src/server/pos/shifts.test.ts`. Build a shift with a float, mixed cash + card tenders (via `recordSale`), a `pay_in`, a `pay_out`, and a `safe_drop` (via `recordCashMovement`), then:
  - `closeShift` writes a `closing` `cash_counts` row whose `expectedTotal` equals the formula over those rows and whose `variance` = `counted − expected`; the shift is now `status: 'closed'` with `closedAt` and `closedByUserId` set.
  - a planted **over** and a planted **short** each yield a variance of the correct sign and magnitude.
  - tips on tenders do **not** change `expectedTotal`.
  - **blind close:** with `getShiftPolicy.blindClose = true`, the Z-report from a `pos:sell`-only cashier omits `expected`/`variance`; the same shift's Z-report requested with a `reconciliation:manage` grant reveals them (both persisted regardless).
  - **cross-user close:** closing a shift the caller did **not** open, with only `pos:sell`, throws `PosForbiddenError`; with `reconciliation:manage` it succeeds and `closedByUserId ≠ openedByUserId`.
  - **double close:** a second `closeShift` throws `ShiftClosedError` and writes no second `closing` count.
  - a `shift.close` audit row is appended, its metadata carrying `variance`, `flagged`, and the approver.
  - **X-report is non-resetting:** `buildXReport` read twice returns the same live `expected` and leaves the shift open with no new count.

- [ ] **Step 4: Run to verify they fail.** `npx vitest run src/server/pos/shifts.test.ts` — FAIL.

- [ ] **Step 5: Implement the term-gatherer + `closeShift`.** In `src/server/pos/shifts.ts`, add a private `gatherCashTerms(tx, shift)` that reads, scoped to the shift:
  - `cashTenders` = `Σ order_payments.amount WHERE method = 'cash' AND shift_id = shift.id` (tips excluded — `amount` already nets change and never includes `tipAmount`).
  - `payIns` / `payOuts` / `safeDrops` from `cash_movements` grouped by type (use the stored signs: `payOuts`/`safeDrops` are the absolute values of the negative rows).
  - `cashRefunds` = `0` (Spec 3 term; structurally present, evaluates to zero until refund tenders exist).

Then `closeShift` runs in `withTenant`:

```ts
export async function closeShift(ctx: PosCashierContext, shiftId: string, input: CloseShiftInput): Promise<ZReport> {
  const policy = await getShiftPolicy(ctx.tenantId);
  if (input.count.denominations &&
      sumDenominations(input.count.denominations) !== round2(input.count.countedTotal)) {
    throw new CashCountMismatchError();
  }
  const canManage = ctx.permissions.includes("reconciliation:manage") ||
    Boolean(input.grants?.find((g) => g.permission === "reconciliation:manage"));

  return withTenant(ctx.tenantId, async (tx) => {
    const [shift] = await tx.select().from(posShifts).where(eq(posShifts.id, shiftId)).limit(1);
    if (!shift) throw new NoOpenShiftError();
    if (shift.status === "closed") throw new ShiftClosedError();

    // Cross-user close is a manager action.
    let approvedByUserId: string | null = null;
    if (shift.openedByUserId !== ctx.cashierUserId) {
      const grant = input.grants?.find((g) => g.permission === "reconciliation:manage")?.token;
      resolveAuthorizer(ctx, "reconciliation:manage", grant); // throws PosForbiddenError if unauthorized
    }

    const terms = await gatherCashTerms(tx, shift);
    const expected = computeExpectedCash({ ...terms, openingFloat: Number(shift.openingFloat) });
    const counted = round2(input.count.countedTotal);
    const variance = computeVariance(counted, expected);
    const flagged = isVarianceFlagged(variance, policy.varianceThreshold);

    // A flagged variance is settled by a reconciliation:manage holder (approval
    // recorded in audit metadata; durable reconciliation state is Spec 7).
    if (flagged && canManage) {
      const grant = input.grants?.find((g) => g.permission === "reconciliation:manage")?.token;
      approvedByUserId = resolveAuthorizer(ctx, "reconciliation:manage", grant);
    }

    const [count] = await tx.insert(cashCounts).values({
      tenantId: ctx.tenantId, shiftId, kind: "closing", countedTotal: money(counted),
      expectedTotal: money(expected), variance: money(variance),
      denominations: input.count.denominations ?? null, byUserId: ctx.cashierUserId,
    }).returning();

    await tx.update(posShifts).set({
      status: "closed", closedAt: new Date(), closedByUserId: ctx.cashierUserId,
    }).where(eq(posShifts.id, shiftId));

    await recordAuditEvent(auditCtx(ctx), {
      action: "shift.close", entityType: "pos_shift", entityId: shiftId,
      summary: `Shift closed (variance ${money(variance)})`,
      metadata: { countId: count.id, expected: money(expected), counted: money(counted),
        variance: money(variance), flagged, approvedByUserId, closedByUserId: ctx.cashierUserId },
      actorType: "user",
    }, tx);

    const z = await buildZReport(tx, shift, { expected, counted, variance, flagged, approvedByUserId });
    // Blind close: withhold expected/variance from a caller without reconciliation:manage.
    if (policy.blindClose && !canManage) return { ...z, cash: { ...z.cash, expected: null, variance: null } };
    return z;
  });
}
```

`buildZReport(tx, shift, cash)` and `buildXReport(tx, shift)` assemble the projection from the shift's rows: tenders grouped by method (`Σ amount`, `Σ tipAmount`), the movement list, the sales count (`COUNT(DISTINCT order_id)` over the shift's tenders), and discounts/voids from `pos_adjustment_events` for those orders; refunds are `0` until Spec 3. `buildXReport` computes the **same** `computeExpectedCash` live, records **no** count, and never mutates the shift — reading it twice is identical. The `count` audit action (Task 7) covers an explicit `mid_shift` snapshot; `buildXReport` alone emits nothing.

- [ ] **Step 6: Run + typecheck + commit.**

```bash
npx vitest run src/server/pos/shift-math.test.ts src/server/pos/shifts.test.ts && npx tsc --noEmit && npx eslint src/server/pos
git add src/server/pos/shift-math.ts src/server/pos/shift-math.test.ts src/server/pos/shifts.ts src/server/pos/shifts.test.ts
git commit -m "feat(pos): expected-cash formula (pure) + closeShift with variance, blind-close, cross-user close, Z/X reports"
```

---

## Task 7: POS API — `/api/pos/v1/shifts/{open,close,current,movements}`

The device-authenticated surface. **Every route runs `requirePosCashier`** (device Bearer token + `X-POS-Cashier`); there is no web-session variant. `open`/`current`/`movements` and closing your **own** shift need `pos:sell`; closing another's shift, approving a flagged variance, and an over-threshold `pay_out` need `reconciliation:manage` (held or via a grant, resolved in the services already built). An explicit `count` on `current` records a `mid_shift` `cash_counts` row and emits `count`.

**Files:**
- Create: `src/app/api/pos/v1/shifts/open/route.ts`, `close/route.ts`, `current/route.ts`, `movements/route.ts`
- Modify: `src/server/pos/shifts.ts` — add `recordMidShiftCount` (emits `count`)
- Test: `src/server/pos/shifts.test.ts` (the `recordMidShiftCount` unit); route smoke via the service

**Interfaces:**
- Consumes: `requirePosCashier`, `assertPermission` (`@/server/pos/require-cashier`); `openShift`, `closeShift`, `buildXReport`, `findOpenShift`, `recordMidShiftCount` (Task 3/6); `recordCashMovement` (Task 5); the shift errors.
- Produces: four route handlers; `function recordMidShiftCount(ctx, shiftId, count): Promise<CashCount>` emitting `count`.

- [ ] **Step 1: Add `recordMidShiftCount` (failing test first).** In `src/server/pos/shifts.test.ts` assert it inserts a `mid_shift` `cash_counts` row with the live `expectedTotal`, leaves the shift `open`, and emits exactly one `count` audit row. Implement in `shifts.ts` mirroring the close count write but with `kind: "mid_shift"`, no status change, `action: "count"`.

- [ ] **Step 2: Implement `POST /open`.** `requirePosCashier` → `assertPermission(ctx, "pos:sell")`; body `{ openingFloat, denominations? }`; `openShift(ctx, …)`; return the shift. Map `ShiftAlreadyOpenError` → `409`, `CashCountMismatchError` → `400`, `PosAuthError`/`PosCashierError` → `401`, `PosForbiddenError` → `403` — follow the exact try/catch shape of `src/app/api/pos/v1/sales/route.ts`.

- [ ] **Step 3: Implement `POST /close`.** `assertPermission(ctx, "pos:sell")` (cross-user/variance authz is enforced inside `closeShift` via `resolveAuthorizer`); body `{ shiftId?, count: { countedTotal, denominations? }, grants? }` — default `shiftId` to the device's open shift (`findOpenShift`) when omitted; return the (blinded) Z-report. Map `ShiftClosedError` → `409`, `CashCountMismatchError` → `400`, `PosForbiddenError` → `403`.

- [ ] **Step 4: Implement `GET /current`.** `assertPermission(ctx, "pos:sell")`; `findOpenShift`; if none, `204`/`{ shift: null }`; else return `buildXReport`. A `POST /current` (or `?count=` body) that carries a count body calls `recordMidShiftCount` and returns the snapshot without closing.

- [ ] **Step 5: Implement `POST /movements`.** `assertPermission(ctx, "pos:sell")`; body `{ type, amount, reasonCode, reasonText?, grants? }`; `recordCashMovement(ctx, …)`. Map `NoOpenShiftError` → `409`, `CashMovementError` → `400`, `PosForbiddenError` → `403` (the over-threshold pay_out without a manager grant lands here).

- [ ] **Step 6: Run the POS suite + typecheck + lint + commit.**

```bash
npx vitest run src/server/pos && npx tsc --noEmit && npx eslint src/server/pos src/app/api/pos/v1/shifts
git add src/server/pos/shifts.ts src/server/pos/shifts.test.ts src/app/api/pos/v1/shifts
git commit -m "feat(pos): /api/pos/v1/shifts routes (open/close/current/movements) — requirePosCashier, authz, mid-shift count + audit"
```

---

## Task 8: Full-suite verification and manual acceptance

**Files:** none — this task changes nothing. It proves the spec.

- [ ] **Step 1: Run everything.**

```bash
npm test
npx tsc --noEmit
npx eslint src
```

Expected: all PASS, all clean. Fix anything that is not before continuing.

- [ ] **Step 2: Walk the spec's acceptance path.** With `npm run dev` and `npm run pos:dev` up, on a tenant paired to a POS device:

- [ ] `POST /shifts/open` with a float → a `pos_shifts` row `status = 'open'` and an `opening` `cash_counts` row appear; a second open on the same device returns **409**.
- [ ] Ring a **cash** sale → the `order_payments` row's `shift_id` is the open shift; a cash sale with the shift **closed** → **409** with no order/tender/receipt written.
- [ ] `POST /shifts/movements` a `pay_in`/`pay_out`/`safe_drop`/`no_sale` → signed `+`/`−`/`−`/`0`; a `pay_out` over threshold → **403** without a manager grant, else the row carries `authorized_by_user_id`.
- [ ] `GET /shifts/current` twice → identical X-report `expected` (non-resetting), correct tender-by-method totals, movements, sales count.
- [ ] `POST /shifts/close` → a `closing` `cash_counts` row with `expected = float + Σcash − payouts + payins − drops` and `variance = counted − expected`; under `blindClose`, a `pos:sell` cashier's response omits both, a `reconciliation:manage` holder's reveals them.
- [ ] Close another cashier's shift with only `pos:sell` → **403**; with `reconciliation:manage` → succeeds (`closed_by_user_id ≠ opened_by_user_id`); a second close → **409**.
- [ ] Confirm each open/close/movement/count wrote exactly one `audit_events` row, and a flagged `shift.close` carries the approver + variance in its metadata.

- [ ] **Step 3: Open the PR.**

```bash
git push -u origin HEAD
gh pr create --title "feat(pos): shifts & cash drawer — sessions, drawer movements, counted close, variance" --body "$(cat <<'EOF'
Implements docs/ailab/specs/2026-07-24-shifts-and-cash-drawer-design.md (Spec 2).

- pos_shifts, cash_counts, cash_movements (tenant-scoped, FORCE RLS). One open
  shift per device, enforced by an advisory lock (hashtext(deviceId)) on open and
  a unique partial index (device_id) WHERE status='open'. Movement amount sign is
  enforced by a CHECK.
- The reserved order_payments.shiftId is now stamped by recordSale/addTender; a
  cash tender with no open shift is refused (NoOpenShiftError) before any write.
- One normative expected-cash formula (pure module): opening float + Σ cash tenders
  − refunds (0 until Spec 3) − payouts + payins − drops; variance = counted − expected.
- cash_movements service signs by type and gates over-threshold pay_out through
  resolveAuthorizer(reconciliation:manage). Close computes variance, supports
  per-tenant blind close, and cross-user close needs reconciliation:manage.
- Z-report assembled at close, non-resetting X-report mid-shift (rendering deferred
  to Spec 10). Every open/close/movement/count emits a Spec 4 audit event inside the
  mutation's transaction.

Unblocks Spec 7 (Reconciliation) layer (b): pos_shifts, openingFloat, the expected-cash
formula, blind-close cash_counts, and the populated order_payments.shiftId.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- *Data model* — `pos_shifts` (openedBy/closedBy, openingFloat, status, one-open partial index), `cash_movements` (signed amount + CHECK, authorizedBy), `cash_counts` (opening/closing/mid, counted/expected/variance, denominations jsonb); all FORCE RLS → **Task 1**.
- *Authorization* — `reconciliation:manage` (owner+manager), surfaced into the cashier session, grantable via `/authorize`; `pos:sell` for own drawer → **Task 2** (+ enforced in Tasks 5–7).
- *Concurrency guard* — advisory lock on `hashtext(deviceId)` + unique partial index, one-open-per-device → **Task 3**.
- *Tender stamping* — `order_payments.shiftId` populated for cash/card/other; cash with no open shift refused before any write → **Task 4**.
- *Cash movements* — pay_in/out/safe_drop/no_sale, signed, over-threshold pay_out via `resolveAuthorizer` → **Task 5**.
- *Expected cash + close* — one normative pure formula, `variance = counted − expected`, blind close, cross-user close, denomination-sum guard, double-close rejection, Z/X projections → **Task 6**.
- *API* — `/shifts/open|close|current|movements`, all `requirePosCashier`, correct status codes, mid-shift count → **Task 7**.
- *Audit* — `shift.open`, `shift.close`, `cash.movement`, `count` each append one `audit_events` row inside the mutation's tx → **Tasks 3/5/6/7**.
- *Testing* (schema/RLS, stamping, formula unit, blind close, authorization, audit, reports) — distributed across every task, proven end-to-end in **Task 8**.

**Type consistency:** `PosShift`/`CashCount`/`CashMovement` (Task 1) are the row types every service returns. `ExpectedCashTerms` + `computeExpectedCash` (Task 6) are the one formula the close path and `buildXReport` share — no second implementation, mirroring the audit plan's single-canonical-serializer rule. `ShiftPolicy`/`getShiftPolicy` (Task 2) is read identically by `recordCashMovement` (threshold) and `closeShift` (blind close + variance threshold). `auditCtx(ctx)` builds one `AuditContext` from `PosCashierContext.fingerprint` (added by Spec 4) for all four emission points.

**Deliberate scope decisions:** (1) **No `flagged`/`reconciled` column** — the spec's data model lists only `status: open|closed`. "Flagged" is computed at close (`isVarianceFlagged`) and surfaced in the Z-report + `shift.close` audit metadata; durable reconciliation state is Spec 7's `reconciliation_runs`, which reads the `closing` `cash_counts` this spec writes. (2) **`Σ cash refunds` is structurally present but zero** — the formula reserves the term; refund tenders flow in with no change when Spec 3 lands. (3) **Close always closes the shift** even when flagged; the flag governs settlement, not whether the drawer can close. (4) **Report *rendering* is Spec 10** — Task 6 assembles the X/Z *data* only. (5) **Audit emission assumes Spec 4 is merged first**; if not, the emission blocks and their assertions are the only lines to omit — the shift math is unaffected (the spec's no-op guarantee).
