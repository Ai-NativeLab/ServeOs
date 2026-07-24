# Manual-First Payments Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let ServeOS collect money on both surfaces — store customers paying merchants, and tenants paying ServeOS — via manual "offline payment + proof + confirm" (InstaPay / Vodafone Cash / mobile wallet / bank), with zero payment-gateway compliance and money direct-to-payee, per `docs/superpowers/specs/2026-07-14-manual-payments-design.md`.

**Architecture:** A shared `src/server/payments/offline/` module provides the verification state machine + proof/method types. Surface A (ordering domain) and Surface B (billing/subscription domain) each own their records and confirmer, calling the shared helpers. Automated providers (Paymob for A, Lemon Squeezy for B) are deferred behind a `confirm()` seam the human dashboard action and a future webhook both call.

**Tech Stack:** Next.js 16 App Router (async `headers()`/`params` — follow codebase patterns, NOT training data; see `AGENTS.md`), Drizzle + Supabase Postgres, Vitest (integration tests hit `serveos_test`), Playwright.

## Global Constraints

- Branch: `feat/subscription-billing` (already checked out).
- **RLS boundary (critical):** `orders` and the new `tenant_offline_methods` are tenant data → all access through `withTenant()` (FORCE RLS). `subscriptions`, `plans`, `invoices` are **control tables** → plain `db` with explicit `tenantId` filters (this is the existing pattern — see `src/server/billing/service.ts` comment and `ManualBillingProvider`). Do NOT put invoices/subscriptions behind `withTenant`.
- **Proof is never authoritative:** an order/invoice becomes `paid` only on a human confirmation (or, later, a signature-verified provider webhook) — never on the customer-submitted reference/screenshot alone.
- **Money always server-side:** amounts come from the order total / plan price; the payer never sets what they owe. Use `money()` (`src/server/ordering/service.ts:34`) for numeric-string writes, `formatMoney()` (`src/lib/money.ts`) for display.
- **Capability discipline:** no `vertical === "..."` checks; offline payment applies to all verticals.
- **Bilingual copy:** user-facing labels get en + ar (existing `nameEn`/`nameAr` + `DomainError.messageFor(locale)`).
- **Idempotency:** confirm/reject is a no-op if already resolved; concurrent confirm-vs-reject resolves to exactly one winner via guarded UPDATE (`.where(... eq(status, expected))` + `.returning()`, the pattern in `transitionStatus`/`cancelOrderByToken`).
- **Backward compat:** cash-on-delivery + current order flow byte-identical; a tenant with no offline methods behaves as today; existing manual/trial subscriptions untouched.
- Tests: `npm run test -- <path>` (Vitest; needs `serveos_test` migrated via `npm run db:migrate:test`). Local Postgres on `127.0.0.1:5433`. Commit after each task (conventional commits; body ends `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`).
- Deferred behind seams (do NOT build here): Paymob (Surface A auto-confirm), Lemon Squeezy (Surface B auto-charge). Reserve their columns only.

## File Structure

```
src/server/payments/offline/verification.ts   NEW pure state machine (awaiting→pending→confirmed|rejected)
src/server/payments/offline/types.ts          NEW OfflineMethodType, PaymentProof, statuses
src/server/payments/offline/errors.ts          NEW typed errors
src/server/payments/offline/index.ts           NEW barrel
src/server/payments/offline/methods.ts          NEW tenant_offline_methods CRUD (RLS) + platform config
src/server/payments/offline/methods.schema.ts   NEW tenant_offline_methods table + platform config table
src/server/ordering/schema.ts                   MODIFY orders: paymentStatus +pending_verification; paymentMethod +offline types; proof + provider_ref cols
src/server/ordering/service.ts                  MODIFY placeOrder: offline method + proof → pending_verification; NEW confirmOrderPayment/rejectOrderPayment
src/server/billing/schema.ts                    MODIFY invoices: invoiceStatus +pending_verification; proof + provider_ref cols
src/server/billing/service.ts                   MODIFY: createPlanInvoice, submitInvoiceProof, confirmInvoice, rejectInvoice
src/server/subscription/schema.ts               MODIFY subscriptions: provider ids; plans: lemon_squeezy_variant_id
src/server/subscription/service.ts              MODIFY: activateOnInvoicePaid helper
drizzle/00XX_*.sql                              generated + RLS appended for tenant_offline_methods
src/app/checkout/CheckoutForm.tsx               MODIFY: payment-method selector + pay-to details + proof submission
src/app/api/orders/route.ts                     MODIFY: accept paymentMethod + reference + proofUrl
src/app/dashboard/payments/*                     NEW: awaiting-confirmation queue + confirm/reject actions
src/app/dashboard/settings/payment-methods/*     NEW: Payments settings tab
src/app/dashboard/settings/tabs.ts               MODIFY: add Payments tab
src/app/dashboard/settings/billing/*             MODIFY: real Subscribe/pay/proof flow
src/app/admin/(console)/billing/*                NEW: platform invoice-verification queue
scripts/*                                        (none required)
tests/e2e/*                                      NEW smoke for offline order payment
```

---

## PHASE 1 — Shared Foundation

### Task 1: Offline-payment verification state machine (pure)

**Files:**
- Create: `src/server/payments/offline/types.ts`
- Create: `src/server/payments/offline/verification.ts`
- Create: `src/server/payments/offline/errors.ts`
- Create: `src/server/payments/offline/index.ts`
- Test: `src/server/payments/offline/verification.test.ts`

**Interfaces:**
- Consumes: `DomainError`, `Locale` from `@/shared/errors`.
- Produces: `OfflineMethodType = "instapay" | "vodafone_cash" | "mobile_wallet" | "bank" | "cash"`; `VerificationState = "awaiting_payment" | "pending_verification" | "confirmed" | "rejected"`; `canConfirm(s): boolean`; `canReject(s): boolean`; `PaymentAlreadyResolvedError`; `InvalidProofError`; `PaymentMethodNotEnabledError`.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/payments/offline/verification.test.ts
import { describe, it, expect } from "vitest";
import { canConfirm, canReject, OFFLINE_METHOD_TYPES } from "./verification";
import { PaymentAlreadyResolvedError } from "./errors";

describe("offline verification state machine", () => {
  it("allows confirm/reject only from pending_verification", () => {
    expect(canConfirm("pending_verification")).toBe(true);
    expect(canReject("pending_verification")).toBe(true);
    for (const s of ["awaiting_payment", "confirmed", "rejected"] as const) {
      expect(canConfirm(s), s).toBe(false);
      expect(canReject(s), s).toBe(false);
    }
  });

  it("lists the supported offline method types", () => {
    expect(OFFLINE_METHOD_TYPES).toEqual(["instapay", "vodafone_cash", "mobile_wallet", "bank", "cash"]);
  });

  it("exposes a typed already-resolved error carrying a bilingual message", () => {
    const e = new PaymentAlreadyResolvedError();
    expect(e.code).toBe("payment_already_resolved");
    expect(e.messageFor("ar")).toBeTruthy();
    expect(e.messageFor("en")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/server/payments/offline/verification.test.ts`
Expected: FAIL — cannot resolve `./verification`.

- [ ] **Step 3: Implement**

```ts
// src/server/payments/offline/types.ts
export const OFFLINE_METHOD_TYPES = ["instapay", "vodafone_cash", "mobile_wallet", "bank", "cash"] as const;
export type OfflineMethodType = (typeof OFFLINE_METHOD_TYPES)[number];

export type VerificationState = "awaiting_payment" | "pending_verification" | "confirmed" | "rejected";

/** Payer-submitted evidence — informational only, never authoritative. */
export type PaymentProof = { reference: string | null; screenshotUrl: string | null };
```

```ts
// src/server/payments/offline/verification.ts
import type { VerificationState } from "./types";
export { OFFLINE_METHOD_TYPES } from "./types";
export type { OfflineMethodType, VerificationState, PaymentProof } from "./types";

export function canConfirm(state: VerificationState): boolean {
  return state === "pending_verification";
}
export function canReject(state: VerificationState): boolean {
  return state === "pending_verification";
}
```

```ts
// src/server/payments/offline/errors.ts
import { DomainError, type Locale } from "@/shared/errors";

export class PaymentAlreadyResolvedError extends DomainError {
  readonly code = "payment_already_resolved";
  constructor() { super("Payment already resolved"); this.name = "PaymentAlreadyResolvedError"; }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "تم حسم هذه الدفعة بالفعل" : "This payment has already been resolved";
  }
}

export class InvalidProofError extends DomainError {
  readonly code = "invalid_proof";
  constructor() { super("A payment reference is required"); this.name = "InvalidProofError"; }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "الرجاء إدخال رقم مرجع الدفعة" : "Please enter your payment reference";
  }
}

export class PaymentMethodNotEnabledError extends DomainError {
  readonly code = "payment_method_not_enabled";
  constructor(readonly method: string) { super(`Method not enabled: ${method}`); this.name = "PaymentMethodNotEnabledError"; }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "طريقة الدفع غير متاحة" : "That payment method isn't available";
  }
}
```

```ts
// src/server/payments/offline/index.ts
export { OFFLINE_METHOD_TYPES } from "./types";
export type { OfflineMethodType, VerificationState, PaymentProof } from "./types";
export { canConfirm, canReject } from "./verification";
export { PaymentAlreadyResolvedError, InvalidProofError, PaymentMethodNotEnabledError } from "./errors";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/server/payments/offline/verification.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/payments/offline
git commit -m "feat(payments): offline-payment verification state machine + types + errors"
```

---

### Task 2: Schema migration — order/invoice/subscription columns + tenant_offline_methods (RLS)

**Files:**
- Modify: `src/server/ordering/schema.ts`
- Modify: `src/server/billing/schema.ts`
- Modify: `src/server/subscription/schema.ts`
- Create: `src/server/payments/offline/methods.schema.ts`
- Modify: `src/db/schema.ts` (re-export the new schema)
- Create: `drizzle/00XX_*.sql` (generated, then RLS appended)
- Test: `src/server/payments/offline/methods-rls.test.ts`

**Interfaces:**
- Produces: `orders.paymentStatus` gains `pending_verification`; `orders.paymentMethod` gains `instapay|vodafone_cash|mobile_wallet` (keep `cash`); `orders.paymentReference`, `orders.paymentProofUrl`, `orders.paymentProviderRef` (all nullable); `invoices.status` gains `pending_verification`; `invoices.paymentReference`, `invoices.paymentProofUrl`, `invoices.providerRef` (nullable); `subscriptions.providerSubscriptionId`, `subscriptions.providerCustomerId` (nullable); `plans.lemonSqueezyVariantId` (nullable); new `tenantOfflineMethods` table + `TenantOfflineMethod` type.

- [ ] **Step 1: Edit `orders` schema** — in `src/server/ordering/schema.ts`:
  1. `paymentStatusEnum`: `["unpaid", "paid"]` → `["unpaid", "pending_verification", "paid"]`.
  2. `paymentMethodEnum`: `["cash"]` → `["cash", "instapay", "vodafone_cash", "mobile_wallet"]`.
  3. Inside `orders`, after `paymentMethod`: add
     ```ts
       paymentReference: text("payment_reference"),
       paymentProofUrl: text("payment_proof_url"),
       paymentProviderRef: text("payment_provider_ref"),
     ```

- [ ] **Step 2: Edit `invoices` schema** — in `src/server/billing/schema.ts`:
  1. `invoiceStatus`: `["open", "paid", "void"]` → `["open", "pending_verification", "paid", "void"]`.
  2. Inside `invoices`, after `method`: add
     ```ts
       paymentReference: text("payment_reference"),
       paymentProofUrl: text("payment_proof_url"),
       providerRef: text("provider_ref"),
     ```
     (ensure `text` is imported.)

- [ ] **Step 3: Edit `subscriptions` + `plans` schema** — in `src/server/subscription/schema.ts`:
  1. Inside `subscriptions`, after `provider`: add
     ```ts
       providerSubscriptionId: text("provider_subscription_id"),
       providerCustomerId: text("provider_customer_id"),
     ```
  2. Inside `plans`: add
     ```ts
       lemonSqueezyVariantId: text("lemon_squeezy_variant_id"),
     ```
     (ensure `text` imported in both.)

- [ ] **Step 4: Create the offline-methods table**

```ts
// src/server/payments/offline/methods.schema.ts
import { pgTable, uuid, text, boolean, integer, timestamp } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";

/** Per-tenant configured pay-to channels (Surface A). RLS like other tenant data. */
export const tenantOfflineMethods = pgTable("tenant_offline_methods", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  type: text("type").notNull(),          // OfflineMethodType
  label: text("label").notNull(),        // e.g. "Vodafone Cash"
  payToDetail: text("pay_to_detail"),    // number / InstaPay address / IBAN; null for cash
  enabled: boolean("enabled").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type TenantOfflineMethod = typeof tenantOfflineMethods.$inferSelect;
export type NewTenantOfflineMethod = typeof tenantOfflineMethods.$inferInsert;
```

Add to `src/db/schema.ts`: `export * from "../server/payments/offline/methods.schema";`

- [ ] **Step 5: Generate the migration**

Run: `npm run db:generate`
Expected: a new `drizzle/00XX_*.sql` with the enum `ALTER`s (`ADD VALUE`), the new/modified columns, and `CREATE TABLE "tenant_offline_methods"`.
Note: Postgres enum `ADD VALUE` cannot run inside a transaction with other statements in some setups — if `db:migrate` errors on the enum change, split the generated file so each `ALTER TYPE ... ADD VALUE` is its own statement (Drizzle usually emits `ALTER TYPE ... ADD VALUE 'x';` as separate `--> statement-breakpoint` lines already; verify).

- [ ] **Step 6: Append RLS for the new table** — at the end of the generated migration (exact shape as `drizzle/0007_bitter_mandarin.sql`):

```sql
--> statement-breakpoint
ALTER TABLE "tenant_offline_methods" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_offline_methods" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_offline_methods_isolation ON "tenant_offline_methods"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

(Do NOT add RLS to invoices/subscriptions/plans — they are control tables.)

- [ ] **Step 7: Migrate both databases**

Run: `npm run db:migrate && npm run db:migrate:test`
Expected: both succeed.

- [ ] **Step 8: Write the RLS isolation test**

```ts
// src/server/payments/offline/methods-rls.test.ts
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { tenantOfflineMethods } from "./methods.schema";

async function makeTenant(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG" }).returning();
  return t;
}

describe("tenant_offline_methods RLS", () => {
  it("isolates methods per tenant and fails closed with no app.tenant_id", async () => {
    const a = await makeTenant("om-a");
    const b = await makeTenant("om-b");
    await withTenant(a.id, (tx) =>
      tx.insert(tenantOfflineMethods).values({ tenantId: a.id, type: "vodafone_cash", label: "Vodafone Cash", payToDetail: "0100" }),
    );
    const mine = await withTenant(a.id, (tx) => tx.select().from(tenantOfflineMethods));
    const theirs = await withTenant(b.id, (tx) => tx.select().from(tenantOfflineMethods));
    const bare = await db.select().from(tenantOfflineMethods);
    expect(mine.length).toBe(1);
    expect(theirs.length).toBe(0);
    expect(bare.length).toBe(0);
  });
});
```

- [ ] **Step 9: Run the test + full suite**

Run: `npm run test -- src/server/payments/offline/methods-rls.test.ts && npm run test`
Expected: PASS; all existing tests still pass (new columns nullable/defaulted, new enum values unused by existing rows).

- [ ] **Step 10: Commit**

```bash
git add src/server/ordering/schema.ts src/server/billing/schema.ts src/server/subscription/schema.ts src/server/payments/offline/methods.schema.ts src/db/schema.ts drizzle src/server/payments/offline/methods-rls.test.ts
git commit -m "feat(payments): schema — offline payment cols on orders/invoices, provider seams, tenant_offline_methods (RLS)"
```
---

### Task 3: Offline-methods service (per-tenant config, RLS)

**Files:**
- Create: `src/server/payments/offline/methods.ts`
- Modify: `src/server/payments/offline/index.ts` (barrel)
- Test: `src/server/payments/offline/methods.test.ts`

**Interfaces:**
- Consumes: `withTenant`; `tenantOfflineMethods` (Task 2); `OfflineMethodType` (Task 1).
- Produces: `listOfflineMethods(tenantId): Promise<TenantOfflineMethod[]>`; `listEnabledOfflineMethods(tenantId)`; `upsertOfflineMethod(tenantId, input)`; `deleteOfflineMethod(tenantId, id)`; `isMethodEnabled(tenantId, type): Promise<boolean>`. `OfflineMethodInput = { id?: string; type: OfflineMethodType; label: string; payToDetail?: string | null; enabled?: boolean; sortOrder?: number }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/payments/offline/methods.test.ts
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { listOfflineMethods, listEnabledOfflineMethods, upsertOfflineMethod, deleteOfflineMethod, isMethodEnabled } from "./methods";

async function tenant(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG" }).returning();
  return t;
}

describe("offline methods service", () => {
  it("creates, lists (all + enabled), checks, and deletes methods", async () => {
    const t = await tenant("om-svc1");
    const vc = await upsertOfflineMethod(t.id, { type: "vodafone_cash", label: "Vodafone Cash", payToDetail: "01001234567" });
    await upsertOfflineMethod(t.id, { type: "instapay", label: "InstaPay", payToDetail: "shop@instapay", enabled: false });
    expect((await listOfflineMethods(t.id)).length).toBe(2);
    expect((await listEnabledOfflineMethods(t.id)).map((m) => m.type)).toEqual(["vodafone_cash"]);
    expect(await isMethodEnabled(t.id, "vodafone_cash")).toBe(true);
    expect(await isMethodEnabled(t.id, "instapay")).toBe(false);
    await deleteOfflineMethod(t.id, vc.id);
    expect((await listOfflineMethods(t.id)).length).toBe(1);
  });

  it("updates an existing method by id", async () => {
    const t = await tenant("om-svc2");
    const m = await upsertOfflineMethod(t.id, { type: "instapay", label: "InstaPay", payToDetail: "a@instapay" });
    const updated = await upsertOfflineMethod(t.id, { id: m.id, type: "instapay", label: "InstaPay", payToDetail: "b@instapay", enabled: true });
    expect(updated.payToDetail).toBe("b@instapay");
    expect((await listOfflineMethods(t.id)).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- src/server/payments/offline/methods.test.ts`
Expected: FAIL — cannot resolve `./methods`.

- [ ] **Step 3: Implement**

```ts
// src/server/payments/offline/methods.ts
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { tenantOfflineMethods, type TenantOfflineMethod } from "./methods.schema";
import type { OfflineMethodType } from "./types";

export type OfflineMethodInput = {
  id?: string;
  type: OfflineMethodType;
  label: string;
  payToDetail?: string | null;
  enabled?: boolean;
  sortOrder?: number;
};

export async function listOfflineMethods(tenantId: string): Promise<TenantOfflineMethod[]> {
  return withTenant(tenantId, (tx) =>
    tx.select().from(tenantOfflineMethods).orderBy(tenantOfflineMethods.sortOrder),
  );
}

export async function listEnabledOfflineMethods(tenantId: string): Promise<TenantOfflineMethod[]> {
  return withTenant(tenantId, (tx) =>
    tx.select().from(tenantOfflineMethods).where(eq(tenantOfflineMethods.enabled, true)).orderBy(tenantOfflineMethods.sortOrder),
  );
}

export async function isMethodEnabled(tenantId: string, type: OfflineMethodType): Promise<boolean> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select().from(tenantOfflineMethods).where(and(eq(tenantOfflineMethods.type, type), eq(tenantOfflineMethods.enabled, true))).limit(1),
  );
  return !!row;
}

export async function upsertOfflineMethod(tenantId: string, input: OfflineMethodInput): Promise<TenantOfflineMethod> {
  if (input.id) {
    const [row] = await withTenant(tenantId, (tx) =>
      tx.update(tenantOfflineMethods)
        .set({ type: input.type, label: input.label, payToDetail: input.payToDetail ?? null, enabled: input.enabled ?? true, sortOrder: input.sortOrder ?? 0 })
        .where(eq(tenantOfflineMethods.id, input.id!))
        .returning(),
    );
    if (!row) throw new Error("Offline method not found");
    return row;
  }
  const [row] = await withTenant(tenantId, (tx) =>
    tx.insert(tenantOfflineMethods)
      .values({ tenantId, type: input.type, label: input.label, payToDetail: input.payToDetail ?? null, enabled: input.enabled ?? true, sortOrder: input.sortOrder ?? 0 })
      .returning(),
  );
  return row;
}

export async function deleteOfflineMethod(tenantId: string, id: string): Promise<void> {
  await withTenant(tenantId, (tx) => tx.delete(tenantOfflineMethods).where(eq(tenantOfflineMethods.id, id)));
}
```

Add to `src/server/payments/offline/index.ts`:
```ts
export { tenantOfflineMethods, type TenantOfflineMethod, type NewTenantOfflineMethod } from "./methods.schema";
export { listOfflineMethods, listEnabledOfflineMethods, isMethodEnabled, upsertOfflineMethod, deleteOfflineMethod, type OfflineMethodInput } from "./methods";
```

- [ ] **Step 4: Run tests**

Run: `npm run test -- src/server/payments/offline/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/payments/offline
git commit -m "feat(payments): per-tenant offline-methods CRUD service"
```

---

## PHASE 2 — Surface A (store-customer order payments)

### Task 4: placeOrder accepts an offline method + proof → pending_verification

**Files:**
- Modify: `src/server/ordering/service.ts` (`PlaceOrderInput`, `placeOrder`)
- Modify: `src/app/api/orders/route.ts` (allowlist new fields)
- Test: extend `src/server/ordering/place-order.test.ts`

**Interfaces:**
- Consumes: `isMethodEnabled` (Task 3); `PaymentMethodNotEnabledError`, `InvalidProofError` (Task 1); order `paymentStatus`/`paymentMethod` + proof cols (Task 2).
- Produces: `PlaceOrderInput` gains `paymentMethod?: "cash" | "instapay" | "vodafone_cash" | "mobile_wallet"` (default `"cash"`), `paymentReference?: string`, `paymentProofUrl?: string`. Behavior: `cash` → order as today (`paymentStatus="unpaid"`); an offline (non-cash) method → validate it's enabled, require a `paymentReference`, and set `paymentStatus="pending_verification"`, `paymentMethod`, `paymentReference`, `paymentProofUrl`.

- [ ] **Step 1: Write the failing tests** — append to `src/server/ordering/place-order.test.ts` (reuse the file's existing `setup`):

```ts
  it("places an offline (vodafone_cash) order as pending_verification with the proof", async () => {
    const { t, branch, pizza } = await setup("pay-vc");
    const { upsertOfflineMethod } = await import("@/server/payments/offline/methods");
    await upsertOfflineMethod(t.id, { type: "vodafone_cash", label: "Vodafone Cash", payToDetail: "0100" });
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      paymentMethod: "vodafone_cash", paymentReference: "VC-99887",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });
    const { getOrder } = await import("./service");
    const order = await getOrder(t.id, res.orderId);
    expect(order.paymentStatus).toBe("pending_verification");
    expect(order.paymentMethod).toBe("vodafone_cash");
    expect(order.paymentReference).toBe("VC-99887");
  });

  it("rejects an offline method the tenant hasn't enabled", async () => {
    const { t, branch, pizza } = await setup("pay-vc2");
    const { PaymentMethodNotEnabledError } = await import("@/server/payments/offline");
    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      paymentMethod: "instapay", paymentReference: "X",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(PaymentMethodNotEnabledError);
  });

  it("requires a reference for offline methods", async () => {
    const { t, branch, pizza } = await setup("pay-vc3");
    const { upsertOfflineMethod } = await import("@/server/payments/offline/methods");
    const { InvalidProofError } = await import("@/server/payments/offline");
    await upsertOfflineMethod(t.id, { type: "instapay", label: "InstaPay", payToDetail: "a@instapay" });
    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      paymentMethod: "instapay",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(InvalidProofError);
  });

  it("keeps cash orders unpaid exactly as before", async () => {
    const { t, branch, pizza } = await setup("pay-cash");
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });
    const { getOrder } = await import("./service");
    const order = await getOrder(t.id, res.orderId);
    expect(order.paymentStatus).toBe("unpaid");
    expect(order.paymentMethod).toBe("cash");
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- src/server/ordering/place-order.test.ts`
Expected: new tests FAIL.

- [ ] **Step 3: Implement in `placeOrder`** (`src/server/ordering/service.ts`):
  1. Extend `PlaceOrderInput`:
  ```ts
  paymentMethod?: "cash" | "instapay" | "vodafone_cash" | "mobile_wallet";
  paymentReference?: string;
  paymentProofUrl?: string;
  ```
  2. Imports: `import { isMethodEnabled } from "@/server/payments/offline/methods";` and `import { PaymentMethodNotEnabledError, InvalidProofError } from "@/server/payments/offline";`
  3. Near the top of `placeOrder` (after the customer-details guard), resolve payment intent:
  ```ts
    const paymentMethod = input.paymentMethod ?? "cash";
    let paymentStatus: "unpaid" | "pending_verification" = "unpaid";
    let paymentReference: string | null = null;
    let paymentProofUrl: string | null = null;
    if (paymentMethod !== "cash") {
      if (!(await isMethodEnabled(tenantId, paymentMethod))) throw new PaymentMethodNotEnabledError(paymentMethod);
      if (!input.paymentReference?.trim()) throw new InvalidProofError();
      paymentStatus = "pending_verification";
      paymentReference = input.paymentReference.trim();
      paymentProofUrl = input.paymentProofUrl?.trim() || null;
    }
  ```
  4. In the `orders` insert `.values({...})`, add:
  ```ts
      paymentMethod,
      paymentStatus,
      paymentReference,
      paymentProofUrl,
  ```
  (The insert currently relies on the DB defaults `unpaid`/`cash`; set them explicitly now.)

- [ ] **Step 4: Allowlist at the API boundary** — in `src/app/api/orders/route.ts`, add to the `input` object:
  ```ts
    paymentMethod: body.paymentMethod === "instapay" || body.paymentMethod === "vodafone_cash" || body.paymentMethod === "mobile_wallet" ? body.paymentMethod : "cash",
    paymentReference: typeof body.paymentReference === "string" ? body.paymentReference : undefined,
    paymentProofUrl: typeof body.paymentProofUrl === "string" ? body.paymentProofUrl : undefined,
  ```

- [ ] **Step 5: Run the ordering suite**

Run: `npm run test -- src/server/ordering`
Expected: PASS — new + all existing (cash path unchanged; stock decrement still runs since it's independent of payment method).

- [ ] **Step 6: Commit**

```bash
git add src/server/ordering/service.ts src/app/api/orders/route.ts src/server/ordering/place-order.test.ts
git commit -m "feat(ordering): offline payment method + proof at checkout → pending_verification"
```

---

### Task 5: Confirm / reject an offline order payment (merchant)

**Files:**
- Modify: `src/server/ordering/service.ts`
- Test: extend `src/server/ordering/place-order.test.ts` (or a new `order-payment.test.ts`)

**Interfaces:**
- Consumes: `PaymentAlreadyResolvedError` (Task 1); order proof/status cols.
- Produces: `confirmOrderPayment(tenantId, orderId, userId): Promise<Order>` — `pending_verification → paid` (guarded, idempotent); `rejectOrderPayment(tenantId, orderId, userId, reason?): Promise<Order>` — `pending_verification → order cancelled + restock` (reuses the existing cancel path). Both no-op-guard against already-resolved.

- [ ] **Step 1: Write the failing tests**

```ts
  it("confirms an offline order payment → paid, idempotently", async () => {
    const { t, branch, pizza } = await setup("cf1");
    const { upsertOfflineMethod } = await import("@/server/payments/offline/methods");
    await upsertOfflineMethod(t.id, { type: "instapay", label: "InstaPay", payToDetail: "a@instapay" });
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      paymentMethod: "instapay", paymentReference: "IP-1",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });
    const { confirmOrderPayment, getOrder } = await import("./service");
    await confirmOrderPayment(t.id, res.orderId, "00000000-0000-0000-0000-000000000001");
    expect((await getOrder(t.id, res.orderId)).paymentStatus).toBe("paid");
    const { PaymentAlreadyResolvedError } = await import("@/server/payments/offline");
    await expect(confirmOrderPayment(t.id, res.orderId, "00000000-0000-0000-0000-000000000001"))
      .rejects.toThrow(PaymentAlreadyResolvedError);
  });

  it("rejecting an offline order payment cancels + restocks", async () => {
    const { t, branch, pizza } = await setup("cf2");
    const { upsertOfflineMethod } = await import("@/server/payments/offline/methods");
    await upsertOfflineMethod(t.id, { type: "instapay", label: "InstaPay", payToDetail: "a@instapay" });
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      paymentMethod: "instapay", paymentReference: "IP-2",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });
    const { rejectOrderPayment, getOrder } = await import("./service");
    const o = await rejectOrderPayment(t.id, res.orderId, "00000000-0000-0000-0000-000000000001", "no funds received");
    expect(o.status).toBe("cancelled");
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- src/server/ordering/place-order.test.ts`
Expected: FAIL — `confirmOrderPayment`/`rejectOrderPayment` undefined.

- [ ] **Step 3: Implement** in `src/server/ordering/service.ts` (import `PaymentAlreadyResolvedError` from `@/server/payments/offline`):

```ts
/** Merchant confirms an offline payment: pending_verification → paid. Guarded + idempotent. */
export async function confirmOrderPayment(tenantId: string, orderId: string, userId: string): Promise<Order> {
  return withTenant(tenantId, async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new OrderNotFoundError();
    if (order.paymentStatus !== "pending_verification") throw new PaymentAlreadyResolvedError();
    const [updated] = await tx.update(orders)
      .set({ paymentStatus: "paid", updatedAt: new Date() })
      .where(and(eq(orders.id, orderId), eq(orders.paymentStatus, "pending_verification")))
      .returning();
    if (!updated) throw new PaymentAlreadyResolvedError();
    await tx.insert(orderStatusEvents).values({ tenantId, orderId, fromStatus: order.status, toStatus: order.status, changedByUserId: userId, reason: "offline_payment_confirmed" });
    return updated;
  });
}

/** Merchant rejects an offline payment: cancel the order + restock. */
export async function rejectOrderPayment(tenantId: string, orderId: string, userId: string, reason?: string): Promise<Order> {
  const [order] = await withTenant(tenantId, (tx) => tx.select().from(orders).where(eq(orders.id, orderId)).limit(1));
  if (!order) throw new OrderNotFoundError();
  if (order.paymentStatus !== "pending_verification") throw new PaymentAlreadyResolvedError();
  // Reuse the dashboard cancel path (guarded UPDATE + restock) already in transitionStatus.
  return transitionStatus(tenantId, orderId, "cancelled", userId, reason ?? "offline_payment_rejected");
}
```

(Note: `orderStatusEvents.toStatus` is `notNull`; using the unchanged current status is a valid no-status-change audit row. If the event insert's from/to equality is undesirable, drop the audit insert — the guarded UPDATE is the source of truth.)

- [ ] **Step 4: Run the ordering suite**

Run: `npm run test -- src/server/ordering`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/ordering/service.ts src/server/ordering/place-order.test.ts
git commit -m "feat(ordering): merchant confirm/reject offline order payment"
```

---

### Task 6: Checkout UI — offline method selector + pay-to details + proof

**Files:**
- Modify: `src/app/checkout/page.tsx` (load enabled offline methods)
- Modify: `src/app/checkout/CheckoutForm.tsx` (method selector, pay-to display, reference/screenshot, POST body)

**Interfaces:**
- Consumes: `listEnabledOfflineMethods` (Task 3); the API's new `paymentMethod`/`paymentReference`/`paymentProofUrl` (Task 4); existing `ImageInput`/`media-upload` for the optional screenshot.
- Produces: a `methods` prop on `CheckoutForm` (`{ type, label, payToDetail }[]`) and a payment section.

- [ ] **Step 1: Server side** — in `src/app/checkout/page.tsx`, load and pass enabled methods:
  ```ts
  import { listEnabledOfflineMethods } from "@/server/payments/offline/methods";
  // ...
  const methods = await listEnabledOfflineMethods(tenant.id);
  // pass to the form:
  //   methods={methods.map((m) => ({ type: m.type, label: m.label, payToDetail: m.payToDetail }))}
  ```

- [ ] **Step 2: `CheckoutForm` payment section** — add the prop and UI. Read the file first; add near the top:
  ```tsx
  // prop:
  methods: { type: string; label: string; payToDetail: string | null }[];
  // state:
  const [payMethod, setPayMethod] = useState<"cash" | string>("cash");
  const [payRef, setPayRef] = useState("");
  const [payProofUrl, setPayProofUrl] = useState<string | null>(null);
  const selected = methods.find((m) => m.type === payMethod) ?? null;
  ```
  Render a payment block above the submit button:
  ```tsx
  <div className="grid gap-2">
    <Label>Payment</Label>
    <select value={payMethod} onChange={(e) => setPayMethod(e.target.value)} className="rounded-md border border-input px-3 py-2 text-base md:text-sm">
      <option value="cash">Cash on delivery</option>
      {methods.map((m) => <option key={m.type} value={m.type}>{m.label}</option>)}
    </select>
    {selected && (
      <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
        <p>Send payment to <span className="font-semibold">{selected.payToDetail}</span>, then enter your reference below.</p>
        <Input value={payRef} onChange={(e) => setPayRef(e.target.value)} placeholder="Transaction reference" className="mt-2" />
        {/* optional screenshot via existing ImageInput → sets payProofUrl */}
      </div>
    )}
  </div>
  ```
  (If wiring `ImageInput` is non-trivial, ship reference-only in this task and add screenshot upload as a follow-up — the reference alone satisfies the server requirement.)

- [ ] **Step 3: POST body** — in the submit handler, add:
  ```ts
    paymentMethod: payMethod,
    paymentReference: payMethod === "cash" ? undefined : payRef,
    paymentProofUrl: payProofUrl ?? undefined,
  ```
  And block submit when an offline method is chosen with an empty `payRef` (disable button / inline error), mirroring the existing validation style.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npm run test`
Expected: PASS. Then manually: on a tenant with an enabled Vodafone Cash method, checkout shows the selector + pay-to detail; placing with a reference creates a `pending_verification` order; cash still works unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/app/checkout
git commit -m "feat(checkout): offline payment method selector + pay-to details + reference"
```

---

### Task 7: Dashboard "Awaiting payment confirmation" queue

**Files:**
- Create: `src/app/dashboard/payments/page.tsx`
- Create: `src/app/dashboard/payments/actions.ts`
- Modify: `src/components/dashboard/nav-items.ts` (add a Payments link, `orders:manage`)
- Modify: `src/server/ordering/service.ts` (a `listAwaitingPaymentOrders(tenantId)` query)

**Interfaces:**
- Consumes: `confirmOrderPayment`/`rejectOrderPayment` (Task 5); `requireDashboardUser` + `authorize` with `orders:manage`.
- Produces: `listAwaitingPaymentOrders(tenantId): Promise<Order[]>` (orders where `paymentStatus = "pending_verification"`, newest first); a page listing them with Confirm/Reject; server actions `confirmOrderPaymentAction(orderId)` / `rejectOrderPaymentAction(orderId, formData)`.

- [ ] **Step 1: Add the query** in `src/server/ordering/service.ts`:
```ts
export async function listAwaitingPaymentOrders(tenantId: string): Promise<Order[]> {
  return withTenant(tenantId, (tx) =>
    tx.select().from(orders).where(eq(orders.paymentStatus, "pending_verification")).orderBy(desc(orders.placedAt)),
  );
}
```

- [ ] **Step 2: Actions**
```ts
// src/app/dashboard/payments/actions.ts
"use server";
import { revalidatePath } from "next/cache";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { confirmOrderPayment, rejectOrderPayment } from "@/server/ordering/service";

export async function confirmOrderPaymentAction(orderId: string) {
  const { tenantId, user, roleKeys } = await requireDashboardUser();
  authorize(roleKeys, "orders:manage");
  await confirmOrderPayment(tenantId, orderId, user.id);
  revalidatePath("/dashboard/payments");
}

export async function rejectOrderPaymentAction(orderId: string, formData: FormData) {
  const { tenantId, user, roleKeys } = await requireDashboardUser();
  authorize(roleKeys, "orders:manage");
  await rejectOrderPayment(tenantId, orderId, user.id, formData.get("reason") ? String(formData.get("reason")) : undefined);
  revalidatePath("/dashboard/payments");
}
```

- [ ] **Step 3: Page** — a table of awaiting orders (order #, customer, method, reference, proof link, total) with Confirm + Reject(reason). Mirror the markup of `src/app/dashboard/orders` list + `ToastForm`/`SubmitButton`/`ConfirmActionButton`. Read those first; render:
```tsx
// src/app/dashboard/payments/page.tsx
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { listAwaitingPaymentOrders } from "@/server/ordering/service";
import { confirmOrderPaymentAction, rejectOrderPaymentAction } from "./actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export default async function PaymentsQueuePage() {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "orders:manage");
  const orders = await listAwaitingPaymentOrders(ctx.tenantId);
  return (
    <>
      <PageHeader eyebrow="Payments" title="Awaiting payment confirmation" description="Confirm you received the transfer, then the order proceeds." />
      {orders.length === 0 ? (
        <EmptyState title="Nothing awaiting confirmation" />
      ) : (
        <div className="space-y-3 max-w-3xl">
          {orders.map((o) => (
            <Card key={o.id} className="p-4 flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm">
                <div className="font-medium text-ink">#{o.orderNumber} · {o.customerName}</div>
                <div className="text-muted-foreground">{o.paymentMethod} · ref {o.paymentReference ?? "—"} · {Number(o.total).toFixed(2)}</div>
                {o.paymentProofUrl && <a href={o.paymentProofUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">View screenshot</a>}
              </div>
              <div className="flex items-center gap-2">
                <ToastForm action={confirmOrderPaymentAction.bind(null, o.id)} successMessage="Payment confirmed">
                  <SubmitButton size="sm">Confirm</SubmitButton>
                </ToastForm>
                <ToastForm action={rejectOrderPaymentAction.bind(null, o.id)} successMessage="Payment rejected" className="flex items-center gap-1.5">
                  <Input name="reason" placeholder="Reason" className="h-8 w-32" />
                  <SubmitButton size="sm" variant="outline">Reject</SubmitButton>
                </ToastForm>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 4: Nav link** — in `src/components/dashboard/nav-items.ts`, after Orders:
```ts
  if (has("orders:manage")) items.push({ label: "Payments", href: "/dashboard/payments", icon: "receipt" });
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npm run test`
Expected: PASS. Manually: place an offline order → it appears in the queue → Confirm moves it to paid and out of the queue; Reject cancels + restocks.

- [ ] **Step 6: Commit**

```bash
git add src/app/dashboard/payments src/components/dashboard/nav-items.ts src/server/ordering/service.ts
git commit -m "feat(dashboard): awaiting-payment-confirmation queue with confirm/reject"
```

---

### Task 8: Payments settings tab (configure offline methods)

**Files:**
- Modify: `src/app/dashboard/settings/tabs.ts` (add tab)
- Create: `src/app/dashboard/settings/payment-methods/page.tsx`
- Create: `src/app/dashboard/settings/payment-methods/actions.ts`

**Interfaces:**
- Consumes: `listOfflineMethods`, `upsertOfflineMethod`, `deleteOfflineMethod` (Task 3); `OFFLINE_METHOD_TYPES` (Task 1); permission `fulfillment:manage`.

- [ ] **Step 1: Register the tab** — in `SETTINGS_TABS` after "Taxes":
```ts
  { label: "Payments", href: "/dashboard/settings/payment-methods", permission: "fulfillment:manage" },
```

- [ ] **Step 2: Actions**
```ts
// src/app/dashboard/settings/payment-methods/actions.ts
"use server";
import { revalidatePath } from "next/cache";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { upsertOfflineMethod, deleteOfflineMethod } from "@/server/payments/offline/methods";
import { OFFLINE_METHOD_TYPES, type OfflineMethodType } from "@/server/payments/offline";

export async function saveOfflineMethodAction(formData: FormData) {
  const { tenantId, roleKeys } = await requireDashboardUser();
  authorize(roleKeys, "fulfillment:manage");
  const type = String(formData.get("type"));
  if (!(OFFLINE_METHOD_TYPES as readonly string[]).includes(type)) throw new Error("bad type");
  await upsertOfflineMethod(tenantId, {
    id: formData.get("id") ? String(formData.get("id")) : undefined,
    type: type as OfflineMethodType,
    label: String(formData.get("label")),
    payToDetail: formData.get("payToDetail") ? String(formData.get("payToDetail")) : null,
    enabled: formData.get("enabled") === "true",
  });
  revalidatePath("/dashboard/settings/payment-methods");
}

export async function deleteOfflineMethodAction(id: string) {
  const { tenantId, roleKeys } = await requireDashboardUser();
  authorize(roleKeys, "fulfillment:manage");
  await deleteOfflineMethod(tenantId, id);
  revalidatePath("/dashboard/settings/payment-methods");
}
```

- [ ] **Step 3: Page** — list existing methods (label/type/payTo/enabled + delete) and an add form (type select from `OFFLINE_METHOD_TYPES` minus `cash` optional, label, payToDetail, enabled). Mirror the Taxes settings page structure (`PageHeader`, `Card`, `ToastForm`, `SubmitButton`, `Input`, `Label`). Reference-only page; keep it simple and consistent with the existing settings pages.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit`
Expected: clean. Manually: add a Vodafone Cash method → it appears at checkout; toggle enabled off → it disappears from checkout.

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/settings
git commit -m "feat(settings): payment-methods tab to configure offline pay-to channels"
```
---

## PHASE 3 — Surface B (ServeOS subscription billing)

### Task 9: Manual subscription-invoice service (create → proof → confirm → activate)

**Files:**
- Modify: `src/server/billing/service.ts`
- Modify: `src/server/subscription/service.ts` (activation helper)
- Modify: `src/server/billing/index.ts` (barrel, if present) / `src/server/subscription/index.ts`
- Test: `src/server/billing/manual-subscription.test.ts`

**Interfaces:**
- Consumes: `invoices` (Task 2 cols), `subscriptions`/`plans` (control tables, plain `db`), `PaymentAlreadyResolvedError` (Task 1).
- Produces: `createPlanInvoice(tenantId, planId): Promise<Invoice>` (an `open` invoice for the plan's monthly price); `submitInvoiceProof(tenantId, invoiceId, proof): Promise<Invoice>` (`open → pending_verification`, stores reference/screenshot); `confirmInvoice(tenantId, invoiceId, adminUserId): Promise<Invoice>` (`pending_verification → paid`, then activates subscription for a 1-month period); `rejectInvoice(tenantId, invoiceId): Promise<Invoice>` (`→ void`); `activateSubscriptionForPlan(tenantId, planId): Promise<void>` in subscription service.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/billing/manual-subscription.test.ts
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { eq } from "drizzle-orm";
import { tenants } from "@/server/tenancy/schema";
import { plans, subscriptions } from "@/server/subscription/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { createPlanInvoice, submitInvoiceProof, confirmInvoice } from "./service";

async function setup(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG" }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "basic");
  const [pro] = await db.select().from(plans).where(eq(plans.key, "pro")).limit(1);
  return { t, pro };
}

describe("manual subscription billing", () => {
  it("create invoice → submit proof → confirm → subscription active on the plan", async () => {
    const { t, pro } = await setup("msub1");
    const inv = await createPlanInvoice(t.id, pro.id);
    expect(inv.status).toBe("open");
    expect(inv.amount).toBe(Number(pro.priceMonthly).toFixed(2));
    const pending = await submitInvoiceProof(t.id, inv.id, { reference: "INSTA-777", screenshotUrl: null });
    expect(pending.status).toBe("pending_verification");
    const paid = await confirmInvoice(t.id, inv.id, "00000000-0000-0000-0000-000000000009");
    expect(paid.status).toBe("paid");
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.tenantId, t.id)).limit(1);
    expect(sub.status).toBe("active");
    expect(sub.planId).toBe(pro.id);
    expect(sub.currentPeriodEnd).toBeTruthy();
  });

  it("double-confirm is rejected", async () => {
    const { t, pro } = await setup("msub2");
    const inv = await createPlanInvoice(t.id, pro.id);
    await submitInvoiceProof(t.id, inv.id, { reference: "X", screenshotUrl: null });
    await confirmInvoice(t.id, inv.id, "00000000-0000-0000-0000-000000000009");
    const { PaymentAlreadyResolvedError } = await import("@/server/payments/offline");
    await expect(confirmInvoice(t.id, inv.id, "00000000-0000-0000-0000-000000000009"))
      .rejects.toThrow(PaymentAlreadyResolvedError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- src/server/billing/manual-subscription.test.ts`
Expected: FAIL — functions undefined.

- [ ] **Step 3: Activation helper** in `src/server/subscription/service.ts`:
```ts
/** Set the tenant's subscription active on a plan for a 1-month period (manual confirm). */
export async function activateSubscriptionForPlan(tenantId: string, planId: string): Promise<void> {
  const now = new Date();
  const end = new Date(now); end.setMonth(end.getMonth() + 1);
  await db.update(subscriptions)
    .set({ planId, status: "active", currentPeriodStart: now, currentPeriodEnd: end })
    .where(eq(subscriptions.tenantId, tenantId));
}
```

- [ ] **Step 4: Billing service** in `src/server/billing/service.ts` (imports: `and`, `eq` from drizzle; `invoices`; `db`; `plans`, `subscriptions` from subscription schema; `activateSubscriptionForPlan`; `PaymentAlreadyResolvedError` from `@/server/payments/offline`):
```ts
export async function createPlanInvoice(tenantId: string, planId: string): Promise<Invoice> {
  const [plan] = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
  if (!plan) throw new Error("Unknown plan");
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.tenantId, tenantId)).limit(1);
  if (!sub) throw new Error("No subscription");
  const [inv] = await db.insert(invoices).values({
    tenantId, subscriptionId: sub.id,
    amount: (Math.round(Number(plan.priceMonthly) * 100) / 100).toFixed(2),
    currency: plan.currency, status: "open", method: null,
  }).returning();
  return inv;
}

export async function submitInvoiceProof(tenantId: string, invoiceId: string, proof: { reference: string | null; screenshotUrl: string | null }): Promise<Invoice> {
  const [inv] = await db.update(invoices)
    .set({ status: "pending_verification", paymentReference: proof.reference, paymentProofUrl: proof.screenshotUrl })
    .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId), eq(invoices.status, "open")))
    .returning();
  if (!inv) throw new PaymentAlreadyResolvedError();
  return inv;
}

export async function confirmInvoice(tenantId: string, invoiceId: string, adminUserId: string): Promise<Invoice> {
  const [inv] = await db.update(invoices)
    .set({ status: "paid", method: "manual", markedBy: adminUserId, paidAt: new Date() })
    .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId), eq(invoices.status, "pending_verification")))
    .returning();
  if (!inv) throw new PaymentAlreadyResolvedError();
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, inv.subscriptionId)).limit(1);
  if (sub) await activateSubscriptionForPlan(tenantId, sub.planId);
  return inv;
}

export async function rejectInvoice(tenantId: string, invoiceId: string): Promise<Invoice> {
  const [inv] = await db.update(invoices)
    .set({ status: "void" })
    .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId), eq(invoices.status, "pending_verification")))
    .returning();
  if (!inv) throw new PaymentAlreadyResolvedError();
  return inv;
}
```

Note: `createPlanInvoice` sets the invoice's `subscriptionId` from the existing subscription row; the confirm step activates that subscription onto the invoice's plan. The tenant's `subscriptions` row is created at registration (`startTrial`), so it always exists.

- [ ] **Step 5: Run the billing suite**

Run: `npm run test -- src/server/billing src/server/subscription`
Expected: PASS — new + existing (`ManualBillingProvider` untouched).

- [ ] **Step 6: Commit**

```bash
git add src/server/billing src/server/subscription
git commit -m "feat(billing): manual subscription invoices — create/proof/confirm/reject + activation"
```

---

### Task 10: Billing settings — real Subscribe / pay / proof flow

**Files:**
- Modify: `src/app/dashboard/settings/billing/page.tsx`
- Modify: `src/app/dashboard/settings/billing/actions.ts`
- Platform pay-to details: a small constant/config `src/server/payments/offline/platform-config.ts` (ServeOS InstaPay/wallet numbers) — env-backed, read-only.

**Interfaces:**
- Consumes: `createPlanInvoice`, `submitInvoiceProof` (Task 9); `listPlans` (existing); the platform pay-to config.
- Produces: a working "Subscribe / Change plan" action that creates the plan invoice and shows ServeOS's pay-to details + a reference-submission form. Replaces today's note-only `requestUpgradeAction` for paid plans.

- [ ] **Step 1: Platform pay-to config**
```ts
// src/server/payments/offline/platform-config.ts
/** ServeOS's own pay-to details for subscription collection (Surface B). Env-backed. */
export function platformPayTo(): { label: string; detail: string }[] {
  const raw = process.env.SERVEOS_PAYTO ?? ""; // "InstaPay:serveos@instapay,Vodafone Cash:0100..."
  return raw.split(",").map((s) => s.trim()).filter(Boolean).map((pair) => {
    const [label, detail] = pair.split(":");
    return { label: (label ?? "").trim(), detail: (detail ?? "").trim() };
  });
}
```

- [ ] **Step 2: Actions** — in `src/app/dashboard/settings/billing/actions.ts` add:
```ts
import { createPlanInvoice, submitInvoiceProof } from "@/server/billing/service";
// existing requireBillingPermission import stays

export async function subscribeToPlanAction(planId: string) {
  const { tenantId } = await requireBillingPermission();
  await createPlanInvoice(tenantId, planId);
  revalidatePath("/dashboard/settings/billing");
}

export async function submitInvoiceProofAction(invoiceId: string, formData: FormData) {
  const { tenantId } = await requireBillingPermission();
  await submitInvoiceProof(tenantId, invoiceId, {
    reference: formData.get("reference") ? String(formData.get("reference")) : null,
    screenshotUrl: formData.get("screenshotUrl") ? String(formData.get("screenshotUrl")) : null,
  });
  revalidatePath("/dashboard/settings/billing");
}
```
(Import `revalidatePath` if not already; keep the existing `requestUpgradeAction` for the free tier or remove its use for paid plans.)

- [ ] **Step 3: Page** — on `src/app/dashboard/settings/billing/page.tsx`, replace the plan-upgrade "request" buttons with **Subscribe** buttons calling `subscribeToPlanAction(plan.id)`; when the tenant has an `open`/`pending_verification` invoice, show ServeOS's `platformPayTo()` details + a reference form calling `submitInvoiceProofAction(invoice.id)`. The invoice history table already present now shows real statuses.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npm run test`
Expected: PASS. Manually: pick Pro → invoice created + pay-to shown → submit reference → invoice `pending_verification` in history.

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/settings/billing src/server/payments/offline/platform-config.ts
git commit -m "feat(billing): real subscribe→pay→proof flow on billing settings"
```

---

### Task 11: Platform admin — subscription invoice verification queue

**Files:**
- Create: `src/app/admin/(console)/billing/page.tsx`
- Create: `src/app/admin/(console)/billing/actions.ts`
- Modify: the admin console nav/layout to add a Billing link (read `src/app/admin/(console)/layout.tsx` and mirror how Approvals/Audit are linked)
- Modify: `src/server/billing/service.ts` (a `listInvoicesPendingVerification()` control-table query)

**Interfaces:**
- Consumes: `confirmInvoice`, `rejectInvoice` (Task 9); `requireSuperAdmin` (`@/server/auth/admin-context`).
- Produces: `listInvoicesPendingVerification(): Promise<(Invoice & { tenantName: string })[]>`; an admin page with Confirm/Reject per pending invoice; actions gated by `requireSuperAdmin`.

- [ ] **Step 1: Query** in `src/server/billing/service.ts` (join tenants for display; control table → plain `db`):
```ts
export async function listInvoicesPendingVerification() {
  return db.select({
    id: invoices.id, tenantId: invoices.tenantId, amount: invoices.amount, currency: invoices.currency,
    reference: invoices.paymentReference, proofUrl: invoices.paymentProofUrl, createdAt: invoices.createdAt,
    tenantName: tenants.name,
  }).from(invoices).innerJoin(tenants, eq(tenants.id, invoices.tenantId))
    .where(eq(invoices.status, "pending_verification")).orderBy(desc(invoices.createdAt));
}
```
(Import `tenants` from `@/server/tenancy/schema`.)

- [ ] **Step 2: Actions** — `confirmInvoiceAction(invoiceId, tenantId)` / `rejectInvoiceAction(invoiceId, tenantId)` guarded by `requireSuperAdmin()`, calling `confirmInvoice`/`rejectInvoice`, then `revalidatePath("/admin/billing")`.

- [ ] **Step 3: Page** — table (tenant, amount, reference, proof link, actions), mirroring the merged admin `(console)/approvals/page.tsx` table style (Card + Table + SubmitButton). Read that file and match its structure.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npm run test`
Expected: PASS. Manually (admin console): a tenant's submitted invoice appears; Confirm → tenant's subscription flips to `active`; entitlements reflect the plan.

- [ ] **Step 5: Commit**

```bash
git add "src/app/admin/(console)/billing" src/server/billing/service.ts
git commit -m "feat(admin): subscription invoice verification queue (confirm/reject → activate)"
```

---

### Task 12: Seam proof + e2e smoke + full verification

**Files:**
- Test: `src/server/payments/offline/seam.test.ts`
- Test: `tests/e2e/offline-payment.spec.ts`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Seam test** — prove the confirm path is provider-agnostic (a fake "provider" calling `confirmOrderPayment` reaches `paid` identically to the human action), documenting the later Paymob/LS drop-in:
```ts
// src/server/payments/offline/seam.test.ts
import { describe, it, expect } from "vitest";
// reuse the ordering setup to place an offline order, then call confirmOrderPayment
// from a "provider" wrapper and assert paymentStatus === "paid" — identical to the human path.
```
(Fill using the same setup as Task 5's tests; the point is one assertion that the confirm seam has a single implementation.)

- [ ] **Step 2: E2E smoke** — offline order payment end-to-end against a seeded tenant with an enabled method (host-header pattern like `tests/e2e/menu.spec.ts`): storefront checkout shows the method + pay-to; POST places a `pending_verification` order; it appears in `/dashboard/payments`. Keep assertions concrete; do not weaken.

- [ ] **Step 3: Full verification sweep**

Run: `npx tsc --noEmit && npm run lint && npm run test && npm run test:e2e -- tests/e2e/offline-payment.spec.ts tests/e2e/ordering.spec.ts`
Expected: green (baseline lint unchanged; `ordering.spec.ts` proves cash-path regression intact).

- [ ] **Step 4: Commit**

```bash
git add src/server/payments/offline/seam.test.ts tests/e2e/offline-payment.spec.ts
git commit -m "test(payments): confirm-seam provider-agnosticism + offline-payment e2e smoke"
```

---

## Spec Coverage Map

| Spec section | Tasks |
|---|---|
| §3 shared foundation (state machine, proof, confirm seam) | 1, (seam) 12 |
| §4 pay-to config (per-tenant + platform) | 3 (tenant), 10 (platform) |
| §5 data model | 2 |
| §6 Surface A flow (checkout → pending → confirm/reject) | 4, 5, 6, 7 |
| §7 Surface B flow (invoice → proof → admin confirm → activate) | 9, 10, 11 |
| §8 UI (checkout, dashboard queue, settings, billing, admin) | 6, 7, 8, 10, 11 |
| §9 security (proof non-authoritative, RLS, authz) | 4, 5, 9 (guards), 2 (RLS) |
| §10 errors (typed, idempotent) | 1, 5, 9 |
| §11 testing (unit, integration, regression, seam) | every task; regression 4/12 |
| §12 phasing | Phases 1/2/3 |
| Paymob/LS seams (reserved, not built) | 2 (columns), 12 (seam proof) |

Deviation note: `invoices`/`subscriptions`/`plans` are control tables (plain `db` + explicit `tenantId`), so Surface B queries are not RLS-wrapped — this matches the existing billing code and refines the spec's §9 wording (which grouped invoices with RLS tables).


