# Refunds & Sales History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use mo-ai:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Own **refunds** end to end — money returned *after* a completed, paid sale, full or partial, line-level, with per-line restock and one or more refund tenders (money **OUT**) — and the **sales-history** surfaces that drive them on both the POS and the web dashboard. Three new tenant-scoped, FORCE-RLS tables (`refunds` / `refund_lines` / `refund_payments`) mirror the Spec 1 sale hierarchy (`orders` / `order_items` / `order_payments`) in the return direction; the `payment_status` enum grows two derived values (`refunded`, `partially_refunded`); and `issueRefund` preserves every Spec 1 invariant — `money(n)` numeric strings, RLS via `withTenant`, `clientRefundId` idempotency mirroring `clientPaymentId`, and the `resolveAuthorizer` manager-grant pattern. Implements `docs/ailab/specs/2026-07-24-refunds-and-sales-history-design.md` (Spec 3 of `docs/ROADMAP.md`).

**Architecture:** A refund **never mutates the original order** — the order is the immutable record of what was sold and collected; a refund is a new record of what was returned against it. `issueRefund(ctx, input)` does all of it in **one `withTenant` transaction**: idempotency check on `(orderId, clientRefundId)` → `resolveAuthorizer` for `pos:refund` (byte-for-byte the over-limit-discount flow in `src/server/pos/record-sale.ts:80-87`) → validate against net-paid and per-line remaining qty → insert `refunds` + `refund_lines` + `refund_payments` → restock each `restock=true` line → recompute and flip `payment_status` → emit the `refund.issued` audit event. Two effects the platform assumes are **forward dependencies that degrade gracefully** when their spec is not yet on-branch, exactly as the spec's intro promises: the **Spec 8** `refund_restock` `stock_ledger` movement falls back to a line-scoped `restockOrderItems`-style integer add-back, and the **Spec 4** `recordAuditEvent` call routes through a settable emitter seam that is a no-op until Spec 4 registers it. `pos:refund` already exists in `src/server/rbac/permissions.ts:16` (owner + manager) and has **zero consumers** — this plan is its first.

**Tech Stack:** Next.js (App Router), Drizzle ORM + Postgres (RLS via `withTenant`), Vitest against a remote Supabase Postgres, React (POS renderer in `apps/pos`, dashboard server components). No new runtime dependencies.

## Global Constraints

- **The original order is immutable.** `issueRefund` never touches `orders.items`, `order_payments`, or the order total. It reads them to compute net-paid and writes only the three refund tables plus the derived `orders.paymentStatus`.
- **Money is `money(n)` numeric strings** (`src/server/ordering/service.ts:55`). Every amount inserted or compared goes through `money()` / `Number()`, never a raw float in the DB.
- **`refund_payments` are money OUT**, stored positive (direction implied by the table); `order_payments` stays positive-in and is **never** written by a refund (R6).
- **Net-paid is the ceiling.** Cumulative refund payments can never exceed net-paid. This codebase stores a tender's *applied* amount in `order_payments.amount` and change **separately** in `change_amount` (`tender-schema.ts:23-26`), so gross is already `Σ amount` — do **not** subtract change again. `netPaid = Σ order_payments.amount − Σ prior refund_payments.amount`.
- **Tenant-scoped tables are behind RLS.** `refunds`, `refund_lines`, `refund_payments` are `ENABLE` + `FORCE ROW LEVEL SECURITY` with the house isolation policy (mirror `drizzle/0016_bitter_beast.sql:67-81`). Every read/write goes through `withTenant`. Unlike `pos_order_receipts` (no RLS), the refund idempotency pre-check runs **inside** `withTenant` because `refunds` is tenant-scoped.
- **Idempotent on `(orderId, clientRefundId)`.** A duplicate submit returns the first refund unchanged — a DB unique index is the backstop, a pre-check the fast path. **Forward deps degrade, never block:** absent Spec 8 → integer restock fallback; absent Spec 4 → audit emitter is a no-op; a refund still completes and reconciles either way.
- Run `npx tsc --noEmit && npx eslint <files>` before every commit. Both must be clean.

---

## File Structure

**Database**
- Create: `src/server/pos/refund-schema.ts` — `refunds`, `refund_lines`, `refund_payments`; enums `refund_kind`, `refund_method`.
- Modify: `src/server/ordering/schema.ts` — extend `paymentStatusEnum` with `refunded`, `partially_refunded`.
- Modify: `src/db/schema.ts` — register the refund schema barrel export.
- Create: `drizzle/00XX_*.sql` — generated migration; RLS policies + the four sales-history indexes hand-appended.

**Refund core**
- Create: `src/server/pos/refund.ts` (+ `refund.test.ts`) — `issueRefund`, `RefundInput`, `RefundActor`, net-paid + payment-status helpers.
- Modify: `src/server/pos/errors.ts` — `PosRefundError`.
- Modify: `src/server/ordering/service.ts` — export `restockRefundedLines` (line+qty-scoped restock; Spec 8 forward hook).
- Create: `src/server/pos/refund-audit.ts` — settable `refund.issued` emitter seam (Spec 4 forward hook).

**Sales history**
- Create: `src/server/pos/sales-history.ts` (+ `sales-history.test.ts`) — `listSales`, `getSale`, `reprintReceipt`, `refundPaymentsOut` (money-OUT contract).

**Routes (POS Electron bridge, `requirePosCashier`)**
- Modify: `src/app/api/pos/v1/sales/route.ts` — add `GET` (search → `listSales`); keep the existing `POST` (recordSale).
- Create: `src/app/api/pos/v1/sales/[id]/route.ts` — `GET` detail → `getSale`.
- Create: `src/app/api/pos/v1/sales/[id]/refund/route.ts` — `POST` → `issueRefund`.
- Create: `src/app/api/pos/v1/sales/[id]/reprint/route.ts` — `POST` → `reprintReceipt`.

**Surfaces**
- Create: `apps/pos/src/screens/SalesHistory.tsx` — POS search list + detail + Reprint + Refund composer.
- Modify: `src/app/dashboard/orders/` — sales-history view surfacing refunds; Create `[id]/refund-actions.ts` — the manager Refund server action calling `issueRefund`.

---

## Task 1: Schema — `refunds` + `refund_lines` + `refund_payments`, extend `payment_status`

Three new tables plus one additive enum extension. All three tables are tenant-scoped with FORCE RLS. Drizzle's generator does **not** emit RLS policies (no schema file in this repo declares `pgPolicy`), so — exactly as `drizzle/0016_bitter_beast.sql` did for the tender tables — the `ENABLE`/`FORCE`/`CREATE POLICY` block is **hand-appended** to the generated migration, along with the sales-history indexes on the existing `orders` table.

**Files:** Create `src/server/pos/refund-schema.ts`; Modify `src/server/ordering/schema.ts`, `src/db/schema.ts`; Create `drizzle/00XX_*.sql`.

**Interfaces:** Produces tables `refunds`, `refundLines`, `refundPayments`; enums `refundKindEnum` (`full | partial`), `refundMethodEnum` (`cash | card | store_credit | other`); types `Refund`, `RefundLine`, `RefundPayment`. `paymentStatusEnum` gains `refunded`, `partially_refunded`.

- [ ] **Step 1: Write the schema.** Create `src/server/pos/refund-schema.ts`:

```ts
import { pgTable, uuid, text, timestamp, integer, numeric, boolean, pgEnum, uniqueIndex, index } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { users } from "@/server/auth/schema";
import { orders, orderItems } from "@/server/ordering/schema";

export const refundKindEnum = pgEnum("refund_kind", ["full", "partial"]);
export const refundMethodEnum = pgEnum("refund_method", ["cash", "card", "store_credit", "other"]);

/**
 * The header of one return against one completed order. An order may accrue many
 * partial refunds over time. Never mutates the order — it references it. `shiftId`
 * is a bare uuid (no FK) mirroring order_payments.shiftId: Spec 2 (Shifts) owns
 * pos_shifts and is not on-branch yet, so this is nullable and inert until then.
 */
export const refunds = pgTable("refunds", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
  kind: refundKindEnum("kind").notNull(),
  reasonCode: text("reason_code").notNull(),
  reasonText: text("reason_text"),
  totalAmount: numeric("total_amount").notNull(),
  byUserId: uuid("by_user_id").notNull().references(() => users.id),
  authorizedByUserId: uuid("authorized_by_user_id").references(() => users.id),
  shiftId: uuid("shift_id"),
  clientRefundId: text("client_refund_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("refunds_order_client").on(t.orderId, t.clientRefundId),
  index("refunds_order").on(t.orderId),
  index("refunds_tenant_branch_created").on(t.tenantId, t.branchId, t.createdAt),
]);

/** Per-item breakdown of a partial (or itemised full) refund; carries the per-line restock decision. */
export const refundLines = pgTable("refund_lines", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  refundId: uuid("refund_id").notNull().references(() => refunds.id, { onDelete: "cascade" }),
  orderItemId: uuid("order_item_id").notNull().references(() => orderItems.id, { onDelete: "cascade" }),
  quantity: integer("quantity").notNull(),
  amount: numeric("amount").notNull(),
  restock: boolean("restock").notNull().default(false),
}, (t) => [index("refund_lines_refund").on(t.refundId)]);

/** The tenders of a refund — money OUT. Mirror of order_payments, opposite direction. Stored positive. */
export const refundPayments = pgTable("refund_payments", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  refundId: uuid("refund_id").notNull().references(() => refunds.id, { onDelete: "cascade" }),
  method: refundMethodEnum("method").notNull(),
  amount: numeric("amount").notNull(),
  reference: text("reference"),
  takenByUserId: uuid("taken_by_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("refund_payments_refund").on(t.refundId),
  index("refund_payments_tenant_created").on(t.tenantId, t.createdAt),
]);

export type Refund = typeof refunds.$inferSelect;
export type RefundLine = typeof refundLines.$inferSelect;
export type RefundPayment = typeof refundPayments.$inferSelect;
```

- [ ] **Step 2: Extend the payment-status enum.** In `src/server/ordering/schema.ts:10`, grow the enum (values are additive; existing rows are untouched):

```ts
export const paymentStatusEnum = pgEnum("payment_status", ["unpaid", "partially_paid", "paid", "refunded", "partially_refunded"]);
```

- [ ] **Step 3: Register the schema.** Append to `src/db/schema.ts` (after the `pos/tender-schema` line):

```ts
export * from "../server/pos/refund-schema";
```

- [ ] **Step 4: Generate the migration.**

```bash
npm run db:generate
```

Expected: a new `drizzle/00XX_*.sql` with `CREATE TYPE refund_kind`, `CREATE TYPE refund_method`, two `ALTER TYPE "public"."payment_status" ADD VALUE` statements, the three tables, FKs, and indexes. It will **not** contain RLS.

- [ ] **Step 5: Hand-append RLS + the sales-history indexes.** Open the generated file and append (mirror `drizzle/0016_bitter_beast.sql:67-81` for the policy shape):

```sql
--> statement-breakpoint
ALTER TABLE "refunds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "refunds" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY refunds_isolation ON "refunds"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "refund_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "refund_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY refund_lines_isolation ON "refund_lines"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "refund_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "refund_payments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY refund_payments_isolation ON "refund_payments"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE INDEX "orders_tenant_branch_placed" ON "orders" USING btree ("tenant_id","branch_id","placed_at");--> statement-breakpoint
CREATE INDEX "orders_order_number" ON "orders" USING btree ("tenant_id","order_number");--> statement-breakpoint
CREATE INDEX "orders_customer_phone" ON "orders" USING btree ("tenant_id","customer_phone");
```

The two `ALTER TYPE ... ADD VALUE` statements mirror migration `0016`'s `partially_paid` add: the new labels are only referenced by later runtime transactions (`issueRefund`), never within this migration, so the known "cannot use a new enum value in the same transaction" rule is not tripped.

- [ ] **Step 6: Apply and verify the existing suite still passes.**

```bash
npm run db:migrate:test
npm test
```

Expected: migration applies; full suite PASS (nothing references the new tables yet; `truncateAll` in `src/db/test-harness.ts` discovers the new tables automatically).

- [ ] **Step 7: Commit.**

```bash
git add src/server/pos/refund-schema.ts src/server/ordering/schema.ts src/db/schema.ts drizzle/
git commit -m "feat(refunds): refunds/refund_lines/refund_payments schema + FORCE RLS, extend payment_status, sales-history indexes"
```

---

## Task 2: `issueRefund` — full/partial refund inside one transaction

The core mutation. Idempotent on `(orderId, clientRefundId)`, authorized by `pos:refund` through `resolveAuthorizer` (manager grant for a `pos:sell`-only cashier, identical to over-limit discounts), validated against net-paid and per-line remaining qty, and it recomputes `payment_status` from the tender/refund math. This task defers restock (Task 3) and audit (Task 4) — it leaves the two seam calls as no-op hooks so the transaction shape is final here.

**Files:** Create `src/server/pos/refund.ts`, `src/server/pos/refund.test.ts`; Modify `src/server/pos/errors.ts`.

**Interfaces:** Produces `class PosRefundError extends Error` (in `errors.ts`) and, in `refund.ts`:
- `RefundActor = { tenantId, branchId, actorUserId: string; permissions: Permission[] }` — POS builds it from `PosCashierContext`; the dashboard from `DashboardContext` (`roleKeys` → `ROLE_PERMISSIONS`).
- `RefundLineInput = { orderItemId: string; quantity, amount: number; restock: boolean }`; `RefundPaymentInput = { method: "cash"|"card"|"store_credit"|"other"; amount: number; reference?: string }`.
- `RefundInput = { orderId; kind: "full"|"partial"; lines: RefundLineInput[]; payments: RefundPaymentInput[]; reasonCode: ReasonCode; reasonText?; clientRefundId: string; shiftId?: string|null; grantToken?: string }`.
- `RefundResult = { refundId: string; totalAmount: number; paymentStatus; idempotent: boolean }`; `issueRefund(actor: RefundActor, input: RefundInput): Promise<RefundResult>`.

- [ ] **Step 1: Add the error.** Append to `src/server/pos/errors.ts` (mirror `PosSaleError`):

```ts
/** Thrown when a refund is invalid: over-refund, line over-refund, unpaid/voided order, or amount mismatch. */
export class PosRefundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PosRefundError";
  }
}
```

- [ ] **Step 2: Write the failing tests.** Create `src/server/pos/refund.test.ts`. Reuse `seedPosContext` + `recordSale` to seed a paid 2-qty sale, build the `RefundActor` from `ctx` (`{ tenantId, branchId, actorUserId: ctx.cashierUserId, permissions: ctx.permissions }`), then assert. Compute totals from the fixture pricing exactly as `record-sale.test.ts` does — read it first, never hardcode.

```ts
const actorFrom = (ctx): RefundActor =>
  ({ tenantId: ctx.tenantId, branchId: ctx.branchId, actorUserId: ctx.cashierUserId, permissions: [...ctx.permissions] });

it("full refund of a paid sale flips payment_status paid → refunded", async () => {
  const s = await seedPaidSale("owner");
  const res = await issueRefund(actorFrom(s.ctx), {
    orderId: s.receipt.orderId, kind: "full", lines: [],
    payments: [{ method: "cash", amount: s.receipt.paidAmount }],
    reasonCode: "customer_changed_mind", clientRefundId: "r1",
  });
  expect(res.paymentStatus).toBe("refunded");
  const [o] = await withTenant(s.tenantId, (tx) => tx.select().from(orders).where(eq(orders.id, s.receipt.orderId)));
  expect(o.paymentStatus).toBe("refunded");
});

it("a pos:sell-only cashier WITH a manager grant succeeds and captures authorizedByUserId", async () => {
  const s = await seedPaidSale("staff"); // staff holds pos:sell, not pos:refund
  const token = issueGrant(s.tenantId, "pos:refund", s.managerId);
  const res = await issueRefund(actorFrom(s.ctx), {
    orderId: s.receipt.orderId, kind: "full", lines: [],
    payments: [{ method: "cash", amount: s.receipt.paidAmount }],
    reasonCode: "other", clientRefundId: "r1", grantToken: token,
  });
  const [r] = await withTenant(s.tenantId, (tx) => tx.select().from(refunds).where(eq(refunds.id, res.refundId)));
  expect(r.authorizedByUserId).toBe(s.managerId);
  expect(r.byUserId).toBe(s.ctx.cashierUserId);
});
```

Cover the full matrix (each must fail first — `refund.ts` does not exist):
- **partial refund** of 1 of a 2-qty line → `partially_refunded`, and `Σ refund_lines.amount == Σ refund_payments.amount`.
- **over-refund** (`Σ payments > net-paid`) → `PosRefundError`.
- **line over-refund** (qty > ordered − already-refunded) → `PosRefundError` (refund 2, then try 1 more).
- **unpaid order** and **cancelled/voided order** refund → `PosRefundError`.
- **idempotency** on `(orderId, clientRefundId)`: second submit returns the first `refundId` with `idempotent: true`, and only one `refunds` row exists.
- `pos:sell`-only cashier **without** a grant → `PosForbiddenError`.
- **RLS**: refund in tenant A, `select` from `refunds` in tenant B → empty.

- [ ] **Step 3: Run to verify they fail.**

Run: `npx vitest run src/server/pos/refund.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement.** Create `src/server/pos/refund.ts`. Shape:

```ts
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { money } from "@/server/ordering/service";
import { orders, orderItems } from "@/server/ordering/schema";
import { orderPayments } from "./tender-schema";
import { refunds, refundLines, refundPayments } from "./refund-schema";
import { resolveAuthorizer } from "./grants";
import { REASON_CODES, type ReasonCode } from "./record-sale";
import { restockRefundedLines } from "@/server/ordering/service"; // Task 3 export
import { emitRefundIssued } from "./refund-audit";                // Task 4 seam
import { PosRefundError } from "./errors";
import type { Permission } from "@/server/rbac/permissions";

const round2 = (n: number) => Math.round(n * 100) / 100;

export type RefundActor = { tenantId: string; branchId: string; actorUserId: string; permissions: Permission[] };
// … RefundLineInput / RefundPaymentInput / RefundInput / RefundResult per Interfaces …

export async function issueRefund(actor: RefundActor, input: RefundInput): Promise<RefundResult> {
  if (!REASON_CODES.includes(input.reasonCode)) throw new PosRefundError("Unknown reason code");
  if (!input.payments.length) throw new PosRefundError("A refund needs at least one refund payment");
  for (const p of input.payments) if (!(p.amount > 0)) throw new PosRefundError("A refund payment must be positive");

  // Authorize BEFORE the transaction — resolveAuthorizer throws PosForbiddenError
  // when the actor lacks pos:refund and has no valid grant. Structurally compatible
  // with PosCashierContext (it reads only tenantId, permissions, cashierUserId).
  const authorizer = resolveAuthorizer(
    { tenantId: actor.tenantId, permissions: actor.permissions, cashierUserId: actor.actorUserId } as never,
    "pos:refund",
    input.grantToken,
  );
  const authorizedByUserId = authorizer === actor.actorUserId ? null : authorizer;

  return withTenant(actor.tenantId, async (tx) => {
    // 1. Idempotency — inside withTenant because refunds is RLS-scoped.
    const [dup] = await tx.select().from(refunds)
      .where(and(eq(refunds.orderId, input.orderId), eq(refunds.clientRefundId, input.clientRefundId))).limit(1);
    if (dup) {
      const [o] = await tx.select().from(orders).where(eq(orders.id, input.orderId)).limit(1);
      return { refundId: dup.id, totalAmount: Number(dup.totalAmount), paymentStatus: o.paymentStatus as never, idempotent: true };
    }

    // 2. Load order; reject unpaid / cancelled / rejected (R1: those route to void, not refund).
    const [order] = await tx.select().from(orders).where(eq(orders.id, input.orderId)).limit(1);
    if (!order) throw new PosRefundError("Unknown order");
    if (order.status === "cancelled" || order.status === "rejected") throw new PosRefundError("A voided order has no settled money to refund");
    if (order.paymentStatus === "unpaid") throw new PosRefundError("An unpaid order has nothing to refund — void it instead");

    // 3. Net-paid ceiling. order_payments.amount is the APPLIED amount (change is a
    //    separate column) so gross = Σ amount — do NOT subtract change again.
    const tenders = await tx.select().from(orderPayments).where(eq(orderPayments.orderId, input.orderId));
    const prior = await tx.select().from(refundPayments)
      .innerJoin(refunds, eq(refundPayments.refundId, refunds.id)).where(eq(refunds.orderId, input.orderId));
    const netPaid = round2(tenders.reduce((s, t) => s + Number(t.amount), 0) - prior.reduce((s, r) => s + Number(r.refund_payments.amount), 0));
    const thisTotal = round2(input.payments.reduce((s, p) => s + p.amount, 0));
    if (thisTotal > netPaid + 0.001) throw new PosRefundError("Refund exceeds the amount still refundable");

    // 4. Line validation (partial): qty ≤ ordered − already-refunded; Σ line.amount == Σ payments.
    if (input.kind === "partial") {
      if (!input.lines.length) throw new PosRefundError("A partial refund needs at least one line");
      const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, input.orderId));
      const priorLines = await tx.select().from(refundLines)
        .innerJoin(refunds, eq(refundLines.refundId, refunds.id)).where(eq(refunds.orderId, input.orderId));
      for (const l of input.lines) {
        const item = items.find((i) => i.id === l.orderItemId);
        if (!item) throw new PosRefundError("Refund line does not belong to this order");
        const already = priorLines.filter((p) => p.refund_lines.orderItemId === l.orderItemId).reduce((s, p) => s + p.refund_lines.quantity, 0);
        if (l.quantity < 1 || l.quantity > item.quantity - already) throw new PosRefundError("Cannot return more than was sold");
      }
      if (Math.abs(round2(input.lines.reduce((s, l) => s + l.amount, 0)) - thisTotal) > 0.001) throw new PosRefundError("Refund line amounts must equal the refund payments");
    }

    // 5. Insert header → lines → payments.
    const [refund] = await tx.insert(refunds).values({
      tenantId: actor.tenantId, orderId: input.orderId, branchId: actor.branchId, kind: input.kind,
      reasonCode: input.reasonCode, reasonText: input.reasonText ?? null, totalAmount: money(thisTotal),
      byUserId: actor.actorUserId, authorizedByUserId, shiftId: input.shiftId ?? null, clientRefundId: input.clientRefundId,
    }).returning();

    if (input.lines.length) await tx.insert(refundLines).values(input.lines.map((l) => ({
      tenantId: actor.tenantId, refundId: refund.id, orderItemId: l.orderItemId, quantity: l.quantity, amount: money(l.amount), restock: l.restock })));
    await tx.insert(refundPayments).values(input.payments.map((p) => ({
      tenantId: actor.tenantId, refundId: refund.id, method: p.method, amount: money(p.amount), reference: p.reference ?? null, takenByUserId: actor.actorUserId })));

    await restockRefundedLines(tx, actor.tenantId, input.lines);            // 6. Restock (Task 3 seam)

    // 7. Recompute payment_status from the math (never set by hand).
    const paymentStatus = round2(netPaid - thisTotal) <= 0.001 ? "refunded" as const : "partially_refunded" as const;
    await tx.update(orders).set({ paymentStatus, updatedAt: new Date() }).where(eq(orders.id, input.orderId));

    // 8. Audit (Task 4 seam) — no-op until Spec 4 registers the emitter.
    await emitRefundIssued(
      { tenantId: actor.tenantId, branchId: actor.branchId, actorUserId: actor.actorUserId },
      { refundId: refund.id, orderId: input.orderId, kind: input.kind, totalAmount: money(thisTotal), reasonCode: input.reasonCode, paymentStatus, byUserId: actor.actorUserId, authorizedByUserId }, tx);

    return { refundId: refund.id, totalAmount: thisTotal, paymentStatus, idempotent: false };
  });
}
```

For Task 2 in isolation, stub `restockRefundedLines`/`emitRefundIssued` as `async () => {}` locally (they land in Tasks 3/4). `innerJoin` result keys (`.refund_payments`, `.refund_lines`) follow Drizzle's default table-name aliasing.

- [ ] **Step 5: Run to verify they pass.**

Run: `npx vitest run src/server/pos/refund.test.ts && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 6: Commit.**

```bash
git add src/server/pos/refund.ts src/server/pos/refund.test.ts src/server/pos/errors.ts
git commit -m "feat(refunds): issueRefund — full/partial, pos:refund via resolveAuthorizer, clientRefundId idempotency, derived payment_status"
```

---

## Task 3: Restock — `refund_restock` ledger movement with `restockOrderItems` fallback

For each `restock=true` refund line, return those units to stock. Until Spec 8's `stock_ledger` lands (D4; `docs/ailab/specs/2026-07-24-inventory-recipes-and-purchasing-design.md`), this falls back to a **line- and quantity-scoped** integer add-back — the private `restockOrderItems` (`src/server/ordering/service.ts:279-295`) restocks a whole order, which is wrong for a partial refund. `restock=false` (spoiled/damaged goods) returns money without returning stock. For restaurants (`stockTracking` off) this is a no-op, which is correct.

**Files:** Modify `src/server/ordering/service.ts` (export `restockRefundedLines`); Modify `src/server/pos/refund.ts` (wire it), `src/server/pos/refund.test.ts` (add restock cases).

**Interfaces:** Produces `export async function restockRefundedLines(tx, tenantId, lines: { orderItemId: string; quantity: number; restock: boolean }[]): Promise<void>` in `service.ts`.

- [ ] **Step 1: Write the failing tests.** Add to `src/server/pos/refund.test.ts`. Because `seedPosContext` seeds a **restaurant** tenant (`stockTracking` off), the integer-add-back is a no-op there; to prove the fallback moves stock, seed a stock-tracked product (mirror how the catalog tests set `trackStock`/`stockQuantity`, read one first) OR assert the ledger-forward path is guarded. Cover:
  - `restock=true` on a stock-tracked line **adds the refunded quantity back** to `products.stockQuantity` (integer fallback).
  - `restock=false` leaves `stockQuantity` unchanged while still returning money.
  - a partial refund of 1 of a 2-qty line restocks exactly 1, not 2 (proves line+qty scoping, the bug the whole-order helper would cause).
  - forward-dep marker: a comment test documenting that when Spec 8 is present the same call writes a `refund_restock` `stock_ledger` row reversing the original `sale_deduction`.

- [ ] **Step 2: Run to verify they fail.**

Run: `npx vitest run src/server/pos/refund.test.ts`
Expected: FAIL — restock did not move (or moved the wrong) stock.

- [ ] **Step 3: Implement the fallback.** In `src/server/ordering/service.ts`, add an exported helper next to `restockOrderItems` (reuse its `caps`-resolution + guarded-`UPDATE` shape, but scope to specific items and quantities):

```ts
/**
 * Returns specific order-item quantities to stock for a refund. Line- and
 * quantity-scoped (unlike restockOrderItems, which restocks a whole order).
 * FORWARD DEP (Spec 8): when the stock_ledger exists, replace the integer
 * add-back with a `refund_restock` ledger row reversing the original
 * sale_deduction on the same lot (per the inventory spec's restock-on-refund
 * path). Until then this is the integer fallback; a no-op for verticals with
 * stockTracking off (e.g. restaurant).
 */
export async function restockRefundedLines(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  lines: { orderItemId: string; quantity: number; restock: boolean }[],
): Promise<void> {
  const toRestock = lines.filter((l) => l.restock && l.quantity > 0);
  if (toRestock.length === 0) return;
  const tenant = await getTenantById(tenantId);
  const caps = getCapabilities((tenant?.vertical ?? "restaurant") as VerticalId);
  if (!caps.stockTracking) return;
  for (const l of toRestock) {
    const [item] = await tx.select().from(orderItems).where(eq(orderItems.id, l.orderItemId)).limit(1);
    if (!item) continue;
    if (item.variantId) {
      await tx.update(productVariants)
        .set({ stockQuantity: sql`${productVariants.stockQuantity} + ${l.quantity}` })
        .where(eq(productVariants.id, item.variantId));
    } else {
      await tx.update(products)
        .set({ stockQuantity: sql`${products.stockQuantity} + ${l.quantity}` })
        .where(and(eq(products.id, item.productId), eq(products.trackStock, true)));
    }
  }
}
```

Note: a `full` refund with no `refund_lines` (headerless / goodwill) restocks nothing — restock is a per-line decision and there are no lines. This matches the spec's "goodwill amount not tied to a line … restock left off."

- [ ] **Step 4: Wire it in.** In `src/server/pos/refund.ts`, replace the Task-2 stub call with the real import already sketched (`import { restockRefundedLines } from "@/server/ordering/service"`), passing `input.lines` mapped to `{ orderItemId, quantity, restock }`.

- [ ] **Step 5: Run to verify they pass.**

Run: `npx vitest run src/server/pos/refund.test.ts && npx tsc --noEmit && npx eslint src/server/ordering src/server/pos`
Expected: PASS, clean.

- [ ] **Step 6: Commit.**

```bash
git add src/server/ordering/service.ts src/server/pos/refund.ts src/server/pos/refund.test.ts
git commit -m "feat(refunds): line/qty-scoped restock fallback (Spec 8 refund_restock forward hook), restock=false returns money only"
```

---

## Task 4: Audit `refund.issued` + reconciliation money-OUT contract

Two effects the platform assumes. **Audit** (Spec 4) — `issueRefund` emits `refund.issued` **in the same transaction**. Spec 4 (`docs/ailab/plans/2026-07-24-audit-and-fingerprint-log.md`) is **not on this branch** (`grep -rln recordAuditEvent src` → nothing; no `src/server/audit/`), and its own Self-Review reserves `refund.*` emission for "Specs 3/8/9 … no chain change." So the call routes through a **settable emitter seam** that is a no-op until Spec 4 registers `recordAuditEvent` — the same "degrade gracefully when the surface is absent" contract the spec's intro states. **Reconciliation** (Spec 7, also not on-branch) — prove the money-OUT contract now: `refund_payments` net against gross takings.

**Files:** Create `src/server/pos/refund-audit.ts`; add reconciliation-contract tests to `src/server/pos/refund.test.ts` (or the sales-history test in Task 5).

**Interfaces:** Produces `RefundAuditContext` (`{ tenantId, branchId, actorUserId }`), `RefundIssuedEvent` (`{ refundId, orderId, kind, totalAmount, reasonCode, paymentStatus, byUserId, authorizedByUserId }`), `RefundAuditEmitter = (ctx, event, tx) => Promise<void>`, `setRefundAuditEmitter(fn | null)` (Spec 4 wires this once at startup), and `emitRefundIssued(ctx, event, tx)` (calls the registered emitter, else no-op).

- [ ] **Step 1: Write the failing tests.** Add to `src/server/pos/refund.test.ts`:
  - `setRefundAuditEmitter` registers a spy; after `issueRefund`, the spy was called once with `action`-shaped payload `{ refundId, orderId, paymentStatus }` and **with the same `tx`** (assert the spy ran — since it shares the tx, if the outer tx throws after the emit, no refund row survives). Reset with `setRefundAuditEmitter(null)` in `afterEach`.
  - with **no** emitter registered (default), `issueRefund` completes and writes the refund — the seam is inert, never throws.
  - **reconciliation money-OUT:** a fixture day with one cash sale (gross IN) and one partial cash **refund** (money OUT); assert `Σ order_payments.amount − Σ refund_payments.amount` for the day equals the expected net, and that `refundPaymentsOut` (Task 5 helper, or an inline query here) reports the cash OUT total. This is the Spec 7 contract without Spec 7.

- [ ] **Step 2: Run to verify they fail.**

Run: `npx vitest run src/server/pos/refund.test.ts`
Expected: FAIL — `refund-audit` module not found / emitter never called.

- [ ] **Step 3: Implement the seam.** Create `src/server/pos/refund-audit.ts`:

```ts
export type RefundAuditContext = { tenantId: string; branchId: string; actorUserId: string };
export type RefundIssuedEvent = {
  refundId: string; orderId: string; kind: string; totalAmount: string;
  reasonCode: string; paymentStatus: string; byUserId: string; authorizedByUserId: string | null;
};
export type RefundAuditEmitter = (ctx: RefundAuditContext, event: RefundIssuedEvent, tx: unknown) => Promise<void>;

/**
 * FORWARD DEP (Spec 4): the audit chain is not on this branch. Spec 4 calls
 * setRefundAuditEmitter(...) once at wiring time to bind recordAuditEvent
 * ({ action: 'refund.issued', entityType: 'refund', entityId: refundId, metadata })
 * ON THE CALLER'S TX. Until then the seam is inert — a refund still completes.
 * The emitter shares issueRefund's transaction, so the audit row is atomic with
 * the refund exactly as the spec requires.
 */
let emitter: RefundAuditEmitter | null = null;
export function setRefundAuditEmitter(fn: RefundAuditEmitter | null): void { emitter = fn; }
export async function emitRefundIssued(ctx: RefundAuditContext, event: RefundIssuedEvent, tx: unknown): Promise<void> {
  if (emitter) await emitter(ctx, event, tx);
}
```

- [ ] **Step 4: Confirm `issueRefund` already calls it** (wired in Task 2, Step 4 §8). No refund change needed — this task supplies the module the seam imports.

- [ ] **Step 5: Run to verify they pass.**

Run: `npx vitest run src/server/pos/refund.test.ts && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 6: Commit.**

```bash
git add src/server/pos/refund-audit.ts src/server/pos/refund.test.ts
git commit -m "feat(refunds): refund.issued audit seam (Spec 4 forward hook, in-tx) + refund_payments money-OUT reconciliation contract"
```

---

## Task 5: Sales-history service + POS routes

The read surface that drives refunds and the four POS endpoints. `listSales`/`getSale`/`reprintReceipt` are `withTenant`-scoped; the routes reuse the existing `requirePosCashier` + `assertPermission` + typed-error mapping from `src/app/api/pos/v1/sales/route.ts`. **Reprint and search/detail need only `pos:sell`**; returning money is the privileged step (`pos:refund`, resolved inside `issueRefund`).

**Files:** Create `src/server/pos/sales-history.ts`, `src/server/pos/sales-history.test.ts`; Modify `src/app/api/pos/v1/sales/route.ts`; Create `src/app/api/pos/v1/sales/[id]/route.ts`, `.../[id]/refund/route.ts`, `.../[id]/reprint/route.ts`.

**Interfaces:**
- `SalesFilters = { dateFrom?, dateTo?: Date; cashierUserId?, customerPhone?: string; orderNumber?, amount?: number; branchId?: string; page?: number }`
- `listSales(tenantId, filters): Promise<Order[]>` — **finalized only**: `paymentStatus IN (paid, partially_paid, refunded, partially_refunded)`, `status NOT IN (cancelled, rejected)`.
- `getSale(tenantId, orderId): Promise<SaleDetail>` — order + items + `order_payments` + `pos_adjustment_events` + `refunds` (each nesting `refund_lines` + `refund_payments`).
- `reprintReceipt(tenantId, orderId): Promise<ReceiptDto>` — the original sale shaped for re-render + a refund slip when refunds exist.
- `refundPaymentsOut(tenantId, { from?, to?, branchId? }): Promise<{ method; amount }[]>` — the Spec 7 money-OUT rollup.

- [ ] **Step 1: Write the failing tests.** Create `src/server/pos/sales-history.test.ts`. Reuse `seedPosContext` + `recordSale`. Cover:
  - `listSales` filters by **date range** (`placedAt`), **cashierUserId**, **orderNumber**, **customerPhone**, and **amount** (`total`), each independently; and returns only finalized sales (an unpaid placed order and a cancelled order are excluded).
  - `listSales` is `withTenant`-scoped: tenant A never sees tenant B's sales.
  - `getSale` aggregates tenders, `pos_adjustment_events`, and `refunds` (with lines + refund tenders) for one order — refund one line, assert the refund appears nested.
  - `reprintReceipt` returns the sale's lines + tenders; for a refunded order it appends the refund slip (returned lines + `refund_payments`).

- [ ] **Step 2: Run to verify they fail.**

Run: `npx vitest run src/server/pos/sales-history.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service.** Create `src/server/pos/sales-history.ts`, following `listOrders` (`src/server/ordering/service.ts:340-349`) for the conditional-`where` + `withTenant` shape:

```ts
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { orders, orderItems, type Order } from "@/server/ordering/schema";
import { orderPayments, posAdjustmentEvents } from "./tender-schema";
import { refunds, refundLines, refundPayments } from "./refund-schema";

const FINALIZED = ["paid", "partially_paid", "refunded", "partially_refunded"] as const;

export async function listSales(tenantId: string, filters: SalesFilters): Promise<Order[]> {
  return withTenant(tenantId, (tx) => {
    const conds = [inArray(orders.paymentStatus, FINALIZED as unknown as string[])];
    if (filters.branchId) conds.push(eq(orders.branchId, filters.branchId));
    if (filters.dateFrom) conds.push(gte(orders.placedAt, filters.dateFrom));
    if (filters.dateTo) conds.push(lte(orders.placedAt, filters.dateTo));
    if (filters.cashierUserId) conds.push(eq(orders.cashierUserId, filters.cashierUserId));
    if (filters.orderNumber !== undefined) conds.push(eq(orders.orderNumber, filters.orderNumber));
    if (filters.customerPhone) conds.push(eq(orders.customerPhone, filters.customerPhone));
    if (filters.amount !== undefined) conds.push(eq(orders.total, money(filters.amount)));
    return tx.select().from(orders).where(and(...conds))
      .orderBy(desc(orders.placedAt)).limit(50).offset(((filters.page ?? 1) - 1) * 50);
  });
}
// getSale: order (throw OrderNotFoundError if none) + items + order_payments +
//   pos_adjustment_events + refunds, each nesting its refund_lines + refund_payments → SaleDetail.
// reprintReceipt: getSale, shaped into ReceiptDto { sale, refundSlips[] }.
// refundPaymentsOut: select method, sum(amount) from refund_payments joined to refunds
//   (branch/date filters), grouped by method. Import money + OrderNotFoundError from the ordering module.
```

The finalized `paymentStatus` filter already excludes `cancelled`/`rejected` (a cancelled order is never `paid`); add an explicit `status NOT IN (...)` guard only if a paid-then-cancelled path exists.

- [ ] **Step 4: Add `GET` to the existing sales route.** In `src/app/api/pos/v1/sales/route.ts`, **keep** the current `POST` (recordSale) and add a `GET` export gated on `pos:sell`, mapping query params to `SalesFilters` (`from`/`to` → `new Date(...)`, `orderNumber`/`amount` → `Number(...)`, `cashier`, `phone`, `page`). Reuse the file's existing `requirePosCashier` + try/catch 401/403 block.

- [ ] **Step 5: Create the detail route.** `src/app/api/pos/v1/sales/[id]/route.ts` — `GET`, `pos:sell`, `getSale(ctx.tenantId, id)`; map `OrderNotFoundError` → 404. Use `{ params }: { params: Promise<{ id: string }> }` and `await params`, exactly as `.../[id]/payments/route.ts`.

- [ ] **Step 6: Create the refund route.** `src/app/api/pos/v1/sales/[id]/refund/route.ts` — `POST`. Assert `pos:sell` to reach the endpoint (any cashier may *attempt* a refund, mirroring how the recordSale route asserts `pos:sell` and the service resolves `pos:discount`). Build the `RefundActor` from `ctx` and call `issueRefund(actor, { ...body, orderId: id })`, threading `body.grantToken`. Map: `PosForbiddenError` → 403 (missing `pos:refund` and no grant), `PosRefundError` → 400, `OrderNotFoundError` → 404.

- [ ] **Step 7: Create the reprint route.** `src/app/api/pos/v1/sales/[id]/reprint/route.ts` — `POST`, `pos:sell`, `reprintReceipt(ctx.tenantId, id)`.

- [ ] **Step 8: Route authorization tests.** In `sales-history.test.ts` (or a route test alongside), assert the permission contract at the service/guard boundary: reprint + search + detail require only `pos:sell`; a `pos:sell`-only actor calling `issueRefund` without a grant throws `PosForbiddenError` (the assertion the refund route maps to 403). A full HTTP test needs a device+cashier token; asserting the guard is the load-bearing check (same approach as the audit plan's route test).

- [ ] **Step 9: Run tests + typecheck + lint.**

Run: `npx vitest run src/server/pos/sales-history.test.ts && npx tsc --noEmit && npx eslint src/server/pos src/app/api/pos/v1/sales`
Expected: PASS, clean.

- [ ] **Step 10: Commit.**

```bash
git add src/server/pos/sales-history.ts src/server/pos/sales-history.test.ts src/app/api/pos/v1/sales
git commit -m "feat(sales-history): listSales/getSale/reprintReceipt + POS search/detail/refund/reprint routes (reprint = pos:sell)"
```

---

## Task 6: POS `SalesHistory.tsx` screen + dashboard sales view

The surfaces that turn the service into an operator workflow. A refund is almost always started *from* a lookup, so sales history is the entry point. This task is UI wiring over the Task-5 endpoints and `issueRefund`; it follows the audit plan's Task 7 (build the view against the read API, no failing-test-first for the React screen), and the POS screen mirrors the existing `apps/pos/src/screens/OrdersQueue.tsx` fetch/render pattern.

**Files:** Create `apps/pos/src/screens/SalesHistory.tsx`; Modify `src/app/dashboard/orders/` (list/detail); Create `src/app/dashboard/orders/[id]/refund-actions.ts`.

- [ ] **Step 1: POS `SalesHistory.tsx`.** Create the screen alongside `OrdersQueue.tsx`; read that file first for the bridge-fetch + auth-header conventions (device Bearer + `X-POS-Cashier`). Build: a **search list** (date / cashier / order # / phone / amount → `GET /api/pos/v1/sales?…`; rows show a `paymentStatus` badge incl. `refunded`/`partially_refunded`); a **detail pane** (`GET /sales/:id` → items, tenders, adjustments, existing refunds) with a **Reprint** button (`POST /sales/:id/reprint`, `pos:sell`); and a **Refund composer** (pick lines or full, per-line restock toggle, refund tenders, reason code from `REASON_CODES`, optional `reasonText` → `POST /sales/:id/refund`). On a 403 (missing `pos:refund`), open the existing `ManagerAuthModal.tsx` to capture a grant token and resubmit with `grantToken` — identical to the `pos:discount` over-limit flow.

- [ ] **Step 2: Dashboard sales view.** Extend `src/app/dashboard/orders/` with a Sales History view (same filters), a detail view surfacing `refunds` (lines + refund tenders), and a manager **Refund** action. Follow the styling/data-loading of `OrdersTable.tsx` + `[id]/page.tsx`.

- [ ] **Step 3: Dashboard refund server action.** Create `src/app/dashboard/orders/[id]/refund-actions.ts` (mirror `[id]/actions.ts`):

```ts
"use server";
import { revalidatePath } from "next/cache";
import { requireOrdersPermission } from "../../orders-permission";
import { authorize } from "@/server/rbac/authorize";
import { ROLE_PERMISSIONS } from "@/server/rbac/permissions";
import { issueRefund, type RefundInput } from "@/server/pos/refund";

export async function issueRefundAction(input: RefundInput & { branchId: string }) {
  const { tenantId, user, roleKeys } = await requireOrdersPermission();
  authorize(roleKeys, "pos:refund"); // owner + manager hold it; dashboard needs no grant token
  const permissions = roleKeys.flatMap((rk) => ROLE_PERMISSIONS[rk] ?? []);
  await issueRefund({ tenantId, branchId: input.branchId, actorUserId: user.id, permissions }, input);
  revalidatePath(`/dashboard/orders/${input.orderId}`);
}
```

The dashboard manager holds `pos:refund` directly, so `resolveAuthorizer` inside `issueRefund` returns `actorUserId` and `authorizedByUserId` is null — no manager grant is needed on the web surface, only at the till.

- [ ] **Step 4: Typecheck + lint both apps.**

Run: `npx tsc --noEmit && npx eslint src/app/dashboard/orders && (cd apps/pos && npx tsc --noEmit)`
Expected: clean.

- [ ] **Step 5: Commit.**

```bash
git add apps/pos/src/screens/SalesHistory.tsx src/app/dashboard/orders
git commit -m "feat(sales-history): POS SalesHistory screen (search/reprint/refund composer) + dashboard sales view & manager refund action"
```

---

## Task 7: Full-suite verification and manual acceptance

**Files:** none — this task changes nothing. It proves the spec.

- [ ] **Step 1: Run everything.**

```bash
npm test
npx tsc --noEmit
npx eslint src
(cd apps/pos && npx tsc --noEmit && npm test)
```

Expected: all PASS, all clean. Fix anything that is not before continuing.

- [ ] **Step 2: Walk the spec's acceptance path.** With `npm run dev` and `npm run pos:dev` up, on a tenant paired to a POS device:

- [ ] Ring a POS sale → **Sales History** → find by order number → **Reprint** re-renders (as a `pos:sell` cashier).
- [ ] As a `pos:sell`-only cashier, start a **full refund** → manager-auth modal appears; a grant completes it and the sale flips to **refunded**. DB: `refunds.authorizedByUserId` = manager, `byUserId` = cashier.
- [ ] **Partial refund** of one line, **restock on** (stock-tracked product) → `partially_refunded` and stock rises by exactly the returned qty; **restock off** on another → money back, stock unchanged.
- [ ] Over-net-paid refund, return-more-than-sold, **unpaid** order, and **cancelled** order → all rejected before any insert (UI routes unpaid to a void).
- [ ] Re-submit the same `(orderId, clientRefundId)` → the first refund is returned, no second row.
- [ ] Fixture day of one cash sale + one cash refund nets to `Σ order_payments.amount − Σ refund_payments.amount`.

- [ ] **Step 3: Open the PR.**

```bash
git push -u origin HEAD
gh pr create --title "feat(refunds): refunds & sales history — full/partial refunds, restock, reprint, dual-surface" --body "$(cat <<'EOF'
Implements docs/ailab/specs/2026-07-24-refunds-and-sales-history-design.md (Spec 3).

- refunds / refund_lines / refund_payments (FORCE RLS); payment_status extended with refunded/partially_refunded; sales-history indexes on orders.
- issueRefund in one withTenant tx: (orderId, clientRefundId) idempotency, pos:refund via resolveAuthorizer (manager grant for pos:sell cashiers), net-paid + per-line remaining-qty validation, derived payment_status.
- Per-line restock (integer fallback now, Spec 8 refund_restock ledger forward hook); refund.issued audit seam (Spec 4 forward hook, in-tx); refund_payments proven as money-OUT for Spec 7.
- listSales / getSale / reprintReceipt + POS routes; POS SalesHistory screen + dashboard sales view & manager refund action.

pos:refund existed since Spec 1 with zero consumers — this is its first. The original order is never mutated; voids (Spec 1) are not re-modelled.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- *Data model* — `refunds` + `refund_lines` + `refund_payments`, FORCE RLS, unique `(orderId, clientRefundId)`, `payment_status` grows `refunded`/`partially_refunded`, sales-history indexes → **Task 1**.
- *Refund core* — `issueRefund` full/partial in one `withTenant` tx; `pos:refund` via `resolveAuthorizer` (manager grant for `pos:sell` cashiers, captured as `authorizedByUserId`); `clientRefundId` idempotency; over-refund, line over-refund, unpaid-order and voided-order rejection; derived `payment_status` → **Task 2**.
- *Restock* — per-line `restock`; integer add-back fallback, line+qty-scoped (not whole-order); `restock=false` returns money only; Spec 8 `refund_restock` ledger as the forward path → **Task 3**.
- *Audit + reconciliation* — `refund.issued` emitted in-tx via a seam (Spec 4 forward hook); `refund_payments` net as money-OUT against gross takings (Spec 7 contract) → **Task 4**.
- *Sales history + API* — `listSales` (date / cashier / order # / phone / amount, finalized-only, `withTenant`), `getSale` (tenders + adjustments + nested refunds), `reprintReceipt`; POS routes `GET /sales`, `GET /sales/:id`, `POST /sales/:id/refund`, `POST /sales/:id/reprint` (reprint = `pos:sell`) → **Task 5**.
- *Surfaces* — POS `SalesHistory.tsx` (search / detail / reprint / refund composer with per-line restock + manager grant) + dashboard sales view & manager refund action → **Task 6**.
- *Testing* (server / route-auth / RLS / reconciliation / manual acceptance) — every task, plus **Task 7**.

**Two deliberate forward-dependency seams** (faithful to the spec's "degrade gracefully when the surface is absent"):
1. **Spec 8 (stock ledger) not on-branch** → `restock=true` uses a line/qty-scoped integer add-back, not a `refund_restock` movement. `restockRefundedLines` is the single point Spec 8 rewires — no `issueRefund` change. Restaurants (`stockTracking` off) restock as a correct no-op today.
2. **Spec 4 (audit chain) not on-branch** (`recordAuditEvent` has zero references) → `refund.issued` routes through a settable emitter seam, inert until Spec 4 calls `setRefundAuditEmitter`. The seam receives `issueRefund`'s `tx`, so once bound the audit row is atomic with the refund — mirroring the audit plan's own reservation of `refund.*` emission for this spec.

**Change-semantics guard (load-bearing):** `order_payments.amount` is the *applied* amount, change lives in a separate `change_amount` column, so gross is already `Σ amount`. `netPaid = Σ order_payments.amount − Σ prior refund_payments.amount` — the plan does **not** subtract change again, avoiding a silent over-ceiling bug the spec's shorthand "`Σ order_payments − change`" could invite.

**Type consistency:** `RefundActor` (Task 2) is built identically on both surfaces (POS from `PosCashierContext`, dashboard from `DashboardContext` via `ROLE_PERMISSIONS`) and is the sole authz input to `issueRefund`; `resolveAuthorizer` is reused unchanged. `restockRefundedLines` (Task 3) and `emitRefundIssued` (Task 4) are the two seam calls fixed in Task 2's transaction body, so Tasks 3/4 fill them in without reshaping `issueRefund`. `RefundInput`/`RefundResult` are consumed by the refund route (Task 5) and dashboard action (Task 6); `SalesFilters`/`SaleDetail` (Task 5) drive both the POS screen and dashboard view (Task 6).
