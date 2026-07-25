# POS Sale & Tender Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use ailab:subagent-driven-development (recommended) or ailab:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the ServeOS POS from an order-taking app into a real cash register: every sale attributed to a cashier, every payment recorded as a tender (split / partial / tip / change), every discount and void authorized and reason-coded.

**Architecture:** All money arithmetic lives in **one** module (`src/lib/order-totals.ts`), imported by both the Next server and the Electron renderer via a Vite alias — there is no second implementation. `placeOrder` is extended (not forked) to accept discounts, a channel, a cashier, and an `expectedTotal` it validates inside its existing transaction. A new `recordSale` service wraps `placeOrder` and writes tenders + adjustment events in the same transaction, keyed on the existing `pos_order_receipts` idempotency table.

**Tech Stack:** Next.js (App Router), Drizzle ORM + Postgres (RLS via `withTenant`), Vitest, Electron + Vite + React 19 + Tailwind v4.

## Global Constraints

- **No new runtime dependencies.** Everything here uses what is already installed.
- **The POS stays online-first.** Do not touch `apps/pos/electron/_offline/` — it remains parked.
- **`src/lib/order-totals.ts` is the only place money math may live.** No arithmetic in components, services, or routes.
- **Money is persisted as numeric strings** via the existing `money(n: number): string` helper exported from `src/server/ordering/service.ts`. Never write a raw JS float to the DB.
- **The server is authoritative on totals.** The client's figure is only ever *compared*, never trusted.
- **Authorization is enforced server-side, always.** Hiding a button in the UI is an affordance, not a control.
- Tenant-scoped tables are behind RLS: reads/writes go through `withTenant(tenantId, tx => ...)`. The POS-internal tables (`pos_devices`, `pos_pairing_codes`, `pos_order_receipts`) have no RLS and use the raw `db` client — follow whichever pattern the table you are touching already uses.
- Run `npx tsc --noEmit && npx eslint <files>` before every commit. Both must be clean.

---

## File Structure

**Shared money math**
- Modify: `src/lib/order-totals.ts` — add line/cart totals with discounts. The single source of truth.
- Modify: `src/lib/order-totals.test.ts` — cover discounts.

**Database**
- Modify: `src/server/ordering/schema.ts` — `orders.cashierUserId`, `orders.discountAmount`, `orders.discountReason`, `order_items.discountAmount`, enum additions.
- Create: `src/server/pos/tender-schema.ts` — `order_payments`, `pos_adjustment_events`, `pos_held_tickets`.
- Create: `drizzle/00XX_*.sql` — generated migration.

**Authorization**
- Modify: `src/server/rbac/permissions.ts` — new `pos:*` keys.
- Create: `src/server/pos/require-cashier.ts` — `requirePosCashier()`.
- Create: `src/server/pos/grants.ts` — manager authorization grants.

**Sale**
- Modify: `src/server/ordering/service.ts` — `placeOrder` gains discounts, channel, cashier, `expectedTotal`.
- Create: `src/server/pos/record-sale.ts` — replaces `submit-order.ts`; writes order + tenders + adjustments.
- Create: `src/server/pos/held-tickets.ts`.
- Create: `src/app/api/pos/v1/cashier/login/route.ts`, `.../authorize/route.ts`, `.../sales/route.ts`, `.../sales/[id]/payments/route.ts`, `.../held-tickets/route.ts`, `.../held-tickets/[id]/route.ts`.
- Modify: `src/app/api/pos/v1/catalog/route.ts` — include `CheckoutPricing`.

**POS renderer**
- Modify: `apps/pos/vite.config.ts`, `apps/pos/tsconfig.json`, `apps/pos/vitest.config.ts` — `@shared` alias.
- Modify: `apps/pos/src/order/cart.ts` — discounts; `cartTotal` deleted.
- Create: `apps/pos/src/screens/CashierSignIn.tsx`, `PaymentScreen.tsx`, `ManagerAuthModal.tsx`, `HeldTickets.tsx`.
- Modify: `apps/pos/src/screens/OrderScreen.tsx`, `Receipt.tsx`, `apps/pos/src/App.tsx`.
- Modify: `apps/pos/electron/pos-main.ts`, `preload.ts`, `apps/pos/src/pos-bridge.d.ts`.

---

## Task 1: Shared cart totals with discounts

The POS currently computes `Σ unitPrice × qty` while the server prices through `computeOrderTotals`. Those two numbers can already disagree. This task makes one function that both sides call.

**Files:**
- Modify: `src/lib/order-totals.ts`
- Test: `src/lib/order-totals.test.ts`

**Interfaces:**
- Consumes: existing `CheckoutPricing`, `OrderTotals`, `computeOrderTotals` from this file.
- Produces:
  - `type LineForTotals = { unitPrice: number; quantity: number; discountAmount?: number }`
  - `computeLineTotal(line: LineForTotals): number`
  - `type CartTotals = OrderTotals & { discountAmount: number }`
  - `computeCartTotals(pricing: CheckoutPricing, lines: LineForTotals[], orderDiscountAmount?: number): CartTotals`

Every later task uses `computeCartTotals`. It is the contract.

- [ ] **Step 1: Write the failing tests.** Append to `src/lib/order-totals.test.ts`:

```ts
import { computeLineTotal, computeCartTotals } from "./order-totals";

const pricing = { vatEnabled: true, vatRate: 14, pricesIncludeVat: false, serviceChargeRate: 10 };

describe("computeLineTotal", () => {
  it("subtracts the line discount", () => {
    expect(computeLineTotal({ unitPrice: 100, quantity: 2, discountAmount: 50 })).toBe(150);
  });

  it("treats a missing discount as zero", () => {
    expect(computeLineTotal({ unitPrice: 100, quantity: 2 })).toBe(200);
  });

  it("never returns a negative line", () => {
    expect(computeLineTotal({ unitPrice: 100, quantity: 1, discountAmount: 500 })).toBe(0);
  });
});

describe("computeCartTotals", () => {
  it("applies discounts before service charge and VAT", () => {
    // subtotal 200 - 50 line - 50 order = 100
    // service charge 10% = 10 -> taxable 110 -> VAT 14% = 15.4 -> total 125.4
    const t = computeCartTotals(
      pricing,
      [{ unitPrice: 100, quantity: 2, discountAmount: 50 }],
      50,
    );
    expect(t.subtotal).toBe(100);
    expect(t.discountAmount).toBe(100);
    expect(t.serviceChargeAmount).toBe(10);
    expect(t.vatAmount).toBe(15.4);
    expect(t.total).toBe(125.4);
  });

  it("matches computeOrderTotals exactly when there are no discounts", () => {
    const lines = [{ unitPrice: 100, quantity: 2 }];
    const cart = computeCartTotals(pricing, lines, 0);
    const order = computeOrderTotals(pricing, 200, 0);
    expect(cart.total).toBe(order.total);
    expect(cart.vatAmount).toBe(order.vatAmount);
    expect(cart.serviceChargeAmount).toBe(order.serviceChargeAmount);
  });

  it("clamps an order discount larger than the subtotal to zero, never negative", () => {
    const t = computeCartTotals(pricing, [{ unitPrice: 100, quantity: 1 }], 500);
    expect(t.subtotal).toBe(0);
    expect(t.total).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `npx vitest run src/lib/order-totals.test.ts`
Expected: FAIL — `computeLineTotal is not a function`.

- [ ] **Step 3: Implement.** Append to `src/lib/order-totals.ts`:

```ts
export type LineForTotals = { unitPrice: number; quantity: number; discountAmount?: number };
export type CartTotals = OrderTotals & { discountAmount: number };

/** A line's money after its own discount. Never negative. */
export function computeLineTotal(line: LineForTotals): number {
  const gross = round2(line.unitPrice * line.quantity);
  return Math.max(0, round2(gross - round2(line.discountAmount ?? 0)));
}

/**
 * The whole cart. Discounts reduce the taxable base, so they are applied
 * BEFORE the service charge and VAT — computeOrderTotals is called exactly
 * once, with the already-discounted subtotal. POS delivery fee is always 0.
 */
export function computeCartTotals(
  pricing: CheckoutPricing,
  lines: LineForTotals[],
  orderDiscountAmount = 0,
): CartTotals {
  const gross = round2(lines.reduce((s, l) => s + computeLineTotal(l), 0));
  const orderDiscount = Math.min(round2(orderDiscountAmount), gross);
  const discounted = round2(gross - orderDiscount);

  const lineDiscounts = round2(
    lines.reduce((s, l) => s + Math.min(round2(l.discountAmount ?? 0), round2(l.unitPrice * l.quantity)), 0),
  );

  return {
    ...computeOrderTotals(pricing, discounted, 0),
    discountAmount: round2(lineDiscounts + orderDiscount),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `npx vitest run src/lib/order-totals.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/order-totals.ts src/lib/order-totals.test.ts
git commit -m "feat(totals): line + cart totals with discounts, one source of money math"
```

---

## Task 2: POS renderer imports the shared money math

**Files:**
- Modify: `apps/pos/vite.config.ts`, `apps/pos/tsconfig.json`, `apps/pos/vitest.config.ts`
- Modify: `apps/pos/src/order/cart.ts`
- Test: `apps/pos/src/order/cart.test.ts`

**Interfaces:**
- Consumes: `computeCartTotals`, `computeLineTotal`, `LineForTotals`, `CheckoutPricing` from Task 1, imported as `@shared/order-totals`.
- Produces: `CartLine` (now carries `discountAmount`, `discountReason`), `cartTotals(pricing, lines, orderDiscount)`. **`cartTotal` is deleted** — no caller may keep using it.

- [ ] **Step 1: Add the `@shared` alias.** In `apps/pos/vite.config.ts`, replace the `resolve` line:

```ts
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@shared": path.resolve(__dirname, "../../src/lib"),
    },
  },
```

In `apps/pos/tsconfig.json`, replace `"paths"`:

```json
"paths": { "@/*": ["src/*"], "@shared/*": ["../../src/lib/*"] }
```

In `apps/pos/vitest.config.ts`, replace the whole file:

```ts
import { defineConfig, configDefaults } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@shared": path.resolve(__dirname, "../../src/lib"),
    },
  },
  test: {
    // The offline SQLite store/sync tests are parked (need the native
    // better-sqlite3 build); exclude them from the default online-first run.
    exclude: [...configDefaults.exclude, "**/electron/_offline/**"],
  },
});
```

- [ ] **Step 2: Write the failing parity test.** Replace `apps/pos/src/order/cart.test.ts` entirely:

```ts
import { describe, it, expect } from "vitest";
import { computeOrderTotals } from "@shared/order-totals";
import { addLine, removeLine, changeQty, cartTotals, type CartLine } from "./cart";

const pricing = { vatEnabled: true, vatRate: 14, pricesIncludeVat: false, serviceChargeRate: 10 };
const line = (over: Partial<CartLine> = {}): CartLine => ({
  productId: "p1", name: "Margherita", quantity: 1, selectedOptionIds: [], unitPrice: 100, ...over,
});

describe("cart", () => {
  it("merges an identical line instead of duplicating it", () => {
    const out = addLine([line()], line());
    expect(out).toHaveLength(1);
    expect(out[0].quantity).toBe(2);
  });

  it("removes a line", () => {
    expect(removeLine([line()], 0)).toHaveLength(0);
  });

  it("removes the line when quantity drops to zero", () => {
    expect(changeQty([line()], 0, 0)).toHaveLength(0);
  });
});

describe("cartTotals parity", () => {
  it("agrees with the server's computeOrderTotals for an undiscounted cart", () => {
    const totals = cartTotals(pricing, [line({ quantity: 2 })], 0);
    const server = computeOrderTotals(pricing, 200, 0);
    expect(totals.total).toBe(server.total);
  });

  it("applies a line discount before tax", () => {
    const totals = cartTotals(pricing, [line({ quantity: 2, discountAmount: 50 })], 0);
    // 200 - 50 = 150 -> +10% svc = 165 -> +14% VAT = 188.1
    expect(totals.subtotal).toBe(150);
    expect(totals.total).toBe(188.1);
  });
});
```

- [ ] **Step 3: Run it to verify it fails.**

Run: `npm test -w pos`
Expected: FAIL — `cartTotals` is not exported.

- [ ] **Step 4: Implement.** Replace `apps/pos/src/order/cart.ts` entirely:

```ts
import { computeCartTotals, type CartTotals, type CheckoutPricing } from "@shared/order-totals";

export type CartLine = {
  productId: string;
  variantId?: string;
  name: string;
  quantity: number;
  selectedOptionIds: string[];
  unitPrice: number;
  discountAmount?: number;
  discountReason?: string;
  note?: string;
};

export function lineKey(l: { productId: string; variantId?: string; selectedOptionIds: string[] }): string {
  return [l.productId, l.variantId ?? "", [...l.selectedOptionIds].sort().join(",")].join("|");
}

export function addLine(lines: CartLine[], line: CartLine): CartLine[] {
  const key = lineKey(line);
  const idx = lines.findIndex((l) => lineKey(l) === key);
  if (idx >= 0) {
    return lines.map((l, i) => (i === idx ? { ...l, quantity: l.quantity + line.quantity } : l));
  }
  return [...lines, line];
}

export function removeLine(lines: CartLine[], index: number): CartLine[] {
  return lines.filter((_, i) => i !== index);
}

export function changeQty(lines: CartLine[], index: number, quantity: number): CartLine[] {
  if (quantity <= 0) return removeLine(lines, index);
  return lines.map((l, i) => (i === index ? { ...l, quantity } : l));
}

export function discountLine(lines: CartLine[], index: number, amount: number, reason: string): CartLine[] {
  return lines.map((l, i) => (i === index ? { ...l, discountAmount: amount, discountReason: reason } : l));
}

/** The ONLY total the POS may display. Delegates to the shared money math. */
export function cartTotals(pricing: CheckoutPricing, lines: CartLine[], orderDiscountAmount = 0): CartTotals {
  return computeCartTotals(pricing, lines, orderDiscountAmount);
}
```

- [ ] **Step 5: Run tests + typecheck to verify they pass.**

Run: `npm test -w pos && npm run typecheck -w pos`
Expected: the `cart.test.ts` tests PASS. `npm run typecheck -w pos` will still fail in `OrderScreen.tsx`, which imports the now-deleted `cartTotal` — that is expected, and **Task 13** rewrites that screen. Leave it broken rather than papering over it; a red typecheck here is an accurate signal that a caller of the wrong money math still exists.

- [ ] **Step 6: Commit.**

```bash
git add apps/pos/vite.config.ts apps/pos/tsconfig.json apps/pos/vitest.config.ts apps/pos/src/order/cart.ts apps/pos/src/order/cart.test.ts
git commit -m "fix(pos): cart totals use the shared money math, not a naive sum"
```

---

## Task 3: Schema — tenders, adjustments, held tickets

**Files:**
- Create: `src/server/pos/tender-schema.ts`
- Modify: `src/server/ordering/schema.ts`
- Modify: `src/db/schema.ts`
- Create: `drizzle/00XX_*.sql` (generated)

**Interfaces:**
- Produces: tables `orderPayments`, `posAdjustmentEvents`, `posHeldTickets`; enums `posTenderMethodEnum`, `posAdjustmentTypeEnum`; new columns `orders.cashierUserId`, `orders.discountAmount`, `orders.discountReason`, `orderItems.discountAmount`; enum values `order_channel.pos` and `payment_status.partially_paid`.

- [ ] **Step 1: Extend the ordering schema.** In `src/server/ordering/schema.ts`, change the two enums and add the columns:

```ts
export const orderChannelEnum = pgEnum("order_channel", ["web", "pos"]);
export const paymentStatusEnum = pgEnum("payment_status", ["unpaid", "partially_paid", "paid"]);
```

In the `orders` table, after the `notes` column, add:

```ts
  cashierUserId: uuid("cashier_user_id"),
  discountAmount: numeric("discount_amount").notNull().default("0"),
  discountReason: text("discount_reason"),
```

In the `orderItems` table, after `lineTotal`, add:

```ts
  discountAmount: numeric("discount_amount").notNull().default("0"),
```

- [ ] **Step 2: Create the tender schema.** Create `src/server/pos/tender-schema.ts`:

```ts
import { pgTable, uuid, text, timestamp, numeric, jsonb, pgEnum, uniqueIndex, index } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { users } from "@/server/auth/schema";
import { orders, orderItems } from "@/server/ordering/schema";
import { posDevices } from "./schema";

export const posTenderMethodEnum = pgEnum("pos_tender_method", ["cash", "card", "other"]);
export const posAdjustmentTypeEnum = pgEnum("pos_adjustment_type", [
  "line_discount", "order_discount", "line_void", "order_void",
]);

/**
 * The money source of truth for a POS sale. One row per tender, so a split
 * payment is simply two rows. `shiftId` is unused in this spec — Spec 2
 * (Shifts & Cash Drawer) populates it, which is why it is nullable now.
 */
export const orderPayments = pgTable("order_payments", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  method: posTenderMethodEnum("method").notNull(),
  amount: numeric("amount").notNull(),
  tipAmount: numeric("tip_amount").notNull().default("0"),
  tenderedAmount: numeric("tendered_amount"),
  changeAmount: numeric("change_amount"),
  reference: text("reference"),
  takenByUserId: uuid("taken_by_user_id").notNull().references(() => users.id),
  shiftId: uuid("shift_id"),
  clientPaymentId: text("client_payment_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("order_payments_order_client").on(t.orderId, t.clientPaymentId),
  index("order_payments_order").on(t.orderId),
]);

/** Append-only audit trail: every discount and void, who did it, who approved it. */
export const posAdjustmentEvents = pgTable("pos_adjustment_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  orderItemId: uuid("order_item_id").references(() => orderItems.id, { onDelete: "cascade" }),
  type: posAdjustmentTypeEnum("type").notNull(),
  amount: numeric("amount").notNull(),
  reasonCode: text("reason_code").notNull(),
  reasonText: text("reason_text"),
  byUserId: uuid("by_user_id").notNull().references(() => users.id),
  authorizedByUserId: uuid("authorized_by_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("pos_adjustment_events_order").on(t.orderId)]);

/** A parked sale. Server-side so till 2 can recall what till 1 parked. */
export const posHeldTickets = pgTable("pos_held_tickets", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
  deviceId: uuid("device_id").notNull().references(() => posDevices.id, { onDelete: "cascade" }),
  cashierUserId: uuid("cashier_user_id").notNull().references(() => users.id),
  label: text("label").notNull(),
  draftJson: jsonb("draft_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("pos_held_tickets_branch").on(t.branchId)]);

export type OrderPayment = typeof orderPayments.$inferSelect;
export type PosAdjustmentEvent = typeof posAdjustmentEvents.$inferSelect;
export type PosHeldTicket = typeof posHeldTickets.$inferSelect;
```

- [ ] **Step 3: Register it.** Append to `src/db/schema.ts`:

```ts
export * from "../server/pos/tender-schema";
```

- [ ] **Step 4: Generate and apply the migration.**

```bash
npm run db:generate
npm run db:migrate:test
```

Expected: a new `drizzle/00XX_*.sql`. **Open it and confirm** it contains `ALTER TYPE "order_channel" ADD VALUE 'pos'` and `ALTER TYPE "payment_status" ADD VALUE 'partially_paid'`. Postgres cannot add an enum value inside a transaction block in older versions — if the migration errors with *"ALTER TYPE ... cannot run inside a transaction block"*, split the enum additions into their own migration file ahead of the table creates.

- [ ] **Step 5: Verify the existing suite still passes.**

Run: `npm test`
Expected: PASS — the new columns all have defaults, so existing orders are unaffected.

- [ ] **Step 6: Commit.**

```bash
git add src/server/pos/tender-schema.ts src/server/ordering/schema.ts src/db/schema.ts drizzle/
git commit -m "feat(pos): schema for tenders, adjustment events, and held tickets"
```

---

## Task 4: POS permissions

**Files:**
- Modify: `src/server/rbac/permissions.ts`
- Test: `src/server/rbac/permissions.test.ts` (create if absent)

**Interfaces:**
- Produces: permissions `pos:sell`, `pos:discount`, `pos:void`, `pos:refund`. `owner` and `manager` hold all four; `staff` holds only `pos:sell`.

`pos:refund` is defined now but unused until Spec 3 — defining it here means Spec 3 adds no migration to the role map.

- [ ] **Step 1: Write the failing test.** Create `src/server/rbac/permissions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ROLE_PERMISSIONS } from "./permissions";

describe("POS permissions", () => {
  it("lets staff sell but not discount, void, or refund", () => {
    expect(ROLE_PERMISSIONS.staff).toContain("pos:sell");
    expect(ROLE_PERMISSIONS.staff).not.toContain("pos:discount");
    expect(ROLE_PERMISSIONS.staff).not.toContain("pos:void");
    expect(ROLE_PERMISSIONS.staff).not.toContain("pos:refund");
  });

  it("lets managers and owners authorize everything at the POS", () => {
    for (const role of ["owner", "manager"] as const) {
      expect(ROLE_PERMISSIONS[role]).toEqual(
        expect.arrayContaining(["pos:sell", "pos:discount", "pos:void", "pos:refund"]),
      );
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `npx vitest run src/server/rbac/permissions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** In `src/server/rbac/permissions.ts`, add to the `PERMISSIONS` array (before the closing `] as const;`):

```ts
  "pos:sell",
  "pos:discount",
  "pos:void",
  "pos:refund",
```

Then extend the role map — append the new keys to these three arrays:

```ts
  owner: ["tenant:manage", "staff:invite", "plan:view", "plan:change", "billing:manage", "menu:manage", "orders:manage", "fulfillment:manage", "pos:sell", "pos:discount", "pos:void", "pos:refund"],
  manager: ["staff:invite", "plan:view", "menu:manage", "orders:manage", "fulfillment:manage", "pos:sell", "pos:discount", "pos:void", "pos:refund"],
  staff: ["plan:view", "orders:manage", "pos:sell"],
```

- [ ] **Step 4: Run it to verify it passes.**

Run: `npx vitest run src/server/rbac/permissions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/server/rbac/permissions.ts src/server/rbac/permissions.test.ts
git commit -m "feat(rbac): pos:sell, pos:discount, pos:void, pos:refund permissions"
```

---

## Task 5: `placeOrder` accepts discounts, channel, cashier, and an expected total

This extends the existing function rather than forking a POS-only path, so web and POS orders keep sharing one validated, stock-decrementing, RLS-safe code path.

**Files:**
- Modify: `src/server/ordering/service.ts`
- Modify: `src/server/ordering/errors.ts`
- Test: `src/server/ordering/service.test.ts`

**Interfaces:**
- Consumes: `computeCartTotals` (Task 1); schema columns (Task 3).
- Produces:
  - `PlaceOrderLine` gains `discountAmount?: number`, `discountReason?: string`, `note?: string`
  - `PlaceOrderInput` gains `channel?: "web" | "pos"`, `cashierUserId?: string`, `orderDiscountAmount?: number`, `orderDiscountReason?: string`, `expectedTotal?: number`
  - `PlaceOrderResult` gains `total: number`, `itemIds: string[]` (index-aligned with `input.lines` — Task 8 needs them to attach adjustment events)
  - `class TotalMismatchError extends Error` with `.expected: number` and `.actual: number`

- [ ] **Step 1: Add the error.** Append to `src/server/ordering/errors.ts`:

```ts
/**
 * The client displayed a total that does not match what the server computes
 * from live prices. A register must fail loudly rather than quietly charge a
 * different amount, so this aborts the sale.
 */
export class TotalMismatchError extends Error {
  constructor(public readonly expected: number, public readonly actual: number) {
    super(`Total mismatch: client showed ${expected}, server computed ${actual}`);
    this.name = "TotalMismatchError";
  }
}
```

- [ ] **Step 2: Write the failing tests.** Append to `src/server/ordering/service.test.ts`. Reuse whatever tenant/branch/product fixture helper that file already defines — do not invent a new one; read the top of the file first and call the existing helper.

```ts
describe("placeOrder — POS extensions", () => {
  it("applies line and order discounts before tax and stores them", async () => {
    const { tenantId, branchId, productId } = await seedOrderable(); // existing helper
    const res = await placeOrder(tenantId, {
      branchId,
      fulfillmentType: "pickup",
      customerName: "Walk-in",
      customerPhone: "000000000",
      channel: "pos",
      lines: [{ productId, quantity: 2, selectedOptionIds: [], discountAmount: 50, discountReason: "promo" }],
      orderDiscountAmount: 20,
      orderDiscountReason: "manager_discretion",
    });
    const [order] = await db.select().from(orders).where(eq(orders.id, res.orderId));
    expect(order.channel).toBe("pos");
    expect(Number(order.discountAmount)).toBe(20);
    // base 100 x2 = 200, less 50 line, less 20 order => subtotal 130
    expect(Number(order.subtotal)).toBe(130);
  });

  it("rejects the sale when the client's expected total disagrees", async () => {
    const { tenantId, branchId, productId } = await seedOrderable();
    await expect(
      placeOrder(tenantId, {
        branchId,
        fulfillmentType: "pickup",
        customerName: "Walk-in",
        customerPhone: "000000000",
        channel: "pos",
        expectedTotal: 1,
        lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      }),
    ).rejects.toThrow(TotalMismatchError);
  });

  it("creates no order when the total mismatches", async () => {
    const { tenantId, branchId, productId } = await seedOrderable();
    const before = await db.select().from(orders).where(eq(orders.tenantId, tenantId));
    await expect(
      placeOrder(tenantId, {
        branchId, fulfillmentType: "pickup", customerName: "Walk-in", customerPhone: "000000000",
        channel: "pos", expectedTotal: 1,
        lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      }),
    ).rejects.toThrow(TotalMismatchError);
    const after = await db.select().from(orders).where(eq(orders.tenantId, tenantId));
    expect(after).toHaveLength(before.length);
  });

  it("attributes the cashier", async () => {
    const { tenantId, branchId, productId, userId } = await seedOrderable();
    const res = await placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "Walk-in", customerPhone: "000000000",
      channel: "pos", cashierUserId: userId,
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
    });
    const [order] = await db.select().from(orders).where(eq(orders.id, res.orderId));
    expect(order.cashierUserId).toBe(userId);
  });
});
```

If the existing fixture helper does not return `userId`, extend it to do so.

- [ ] **Step 3: Run to verify they fail.**

Run: `npx vitest run src/server/ordering/service.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement.** In `src/server/ordering/service.ts`:

Change the imports:

```ts
import { computeOrderTotals, computeCartTotals } from "@/lib/order-totals";
```

and add `TotalMismatchError` to the existing import from `./errors`.

Extend the types:

```ts
export type PlaceOrderLine = {
  productId: string;
  variantId?: string;
  quantity: number;
  selectedOptionIds: string[];
  discountAmount?: number;
  discountReason?: string;
  note?: string;
};
export type PlaceOrderInput = {
  branchId: string;
  fulfillmentType: "pickup" | "delivery";
  customerName: string;
  customerPhone: string;
  notes?: string;
  areaId?: string;
  addressText?: string;
  /** ISO 8601. Absent/undefined = ASAP. */
  scheduledFor?: string;
  lines: PlaceOrderLine[];
  now?: Date;
  channel?: "web" | "pos";
  cashierUserId?: string;
  orderDiscountAmount?: number;
  orderDiscountReason?: string;
  /** What the client displayed. Compared, never trusted. */
  expectedTotal?: number;
};
export type PlaceOrderResult = {
  orderId: string;
  orderNumber: number;
  statusToken: string;
  total: number;
  /** Index-aligned with input.lines. */
  itemIds: string[];
};
```

In the per-line loop (step 2 of the transaction), the line total must respect the discount. Replace:

```ts
      const lineTotal = unit * line.quantity;
      subtotal += lineTotal;
```

with:

```ts
      const lineDiscount = Math.min(
        Math.max(0, line.discountAmount ?? 0),
        Math.round(unit * line.quantity * 100) / 100,
      );
      const lineTotal = computeLineTotal({ unitPrice: unit, quantity: line.quantity, discountAmount: lineDiscount });
      subtotal += lineTotal;
```

adding `computeLineTotal` to the `@/lib/order-totals` import. In the `itemsToInsert.push({...})` call, add `discountAmount: money(lineDiscount),` and keep `lineTotal: money(lineTotal)`.

Replace the totals block (step 4 of the transaction):

```ts
    // 4. Totals — single source of money math (src/lib/order-totals.ts).
    // Discounts reduce the taxable base, so computeCartTotals applies them
    // before the service charge and VAT. Delivery orders never carry POS
    // discounts, so the delivery fee is added by computeOrderTotals as before.
    const orderDiscount = Math.min(Math.max(0, input.orderDiscountAmount ?? 0), subtotal);
    const totals = computeOrderTotals(pricing, subtotal - orderDiscount, deliveryFee);

    // The register must never quietly charge a different amount than the one
    // shown to the customer. A stale cached catalog lands here.
    if (input.expectedTotal !== undefined && Math.abs(input.expectedTotal - totals.total) > 0.001) {
      throw new TotalMismatchError(input.expectedTotal, totals.total);
    }
```

(`computeCartTotals` is not called here because `placeOrder` has already reduced each line to its discounted `lineTotal` while validating it against the catalog; re-deriving from raw unit prices would duplicate that work. `computeLineTotal` — the same shared primitive `computeCartTotals` uses — is what guarantees the two agree, and the parity test in Task 2 is what proves it.)

In the `tx.insert(orders).values({...})`, add:

```ts
      channel: input.channel ?? "web",
      cashierUserId: input.cashierUserId ?? null,
      discountAmount: money(orderDiscount),
      discountReason: input.orderDiscountReason ?? null,
```

Change the items insert to capture ids, and the return:

```ts
    const inserted = await tx.insert(orderItems)
      .values(itemsToInsert.map((i) => ({ ...i, tenantId, orderId: order.id })))
      .returning({ id: orderItems.id });
    await tx.insert(orderStatusEvents).values({ tenantId, orderId: order.id, fromStatus: null, toStatus: "pending" });

    return { orderId: order.id, orderNumber, statusToken, total: totals.total, itemIds: inserted.map((i) => i.id) };
```

- [ ] **Step 5: Run the full suite to verify nothing regressed.**

Run: `npm test`
Expected: PASS. Existing web-order tests must be untouched — every new field is optional and defaults to today's behaviour.

- [ ] **Step 6: Commit.**

```bash
git add src/server/ordering/service.ts src/server/ordering/errors.ts src/server/ordering/service.test.ts
git commit -m "feat(ordering): placeOrder takes discounts, channel, cashier, and validates expectedTotal"
```

---

## Task 6: Cashier sign-in + `requirePosCashier`

The device token identifies the *terminal*; the cashier token identifies the *human*. Both ride on every request.

**Files:**
- Create: `src/server/pos/cashier.ts`
- Create: `src/server/pos/require-cashier.ts`
- Create: `src/app/api/pos/v1/cashier/login/route.ts`
- Modify: `src/server/pos/errors.ts`
- Test: `src/server/pos/cashier.test.ts`

**Interfaces:**
- Consumes: `verifyPassword` (`@/server/auth/password`), `loadUserRoleKeys` (`@/server/auth/current-user`), `ROLE_PERMISSIONS` / `Permission` (`@/server/rbac/permissions`), `requirePosDevice` (`@/server/pos/require-device`).
- Produces:
  - `signInCashier(tenantId, email, password): Promise<{ cashierToken; userId; name; permissions: Permission[] }>`
  - `requirePosCashier(req): Promise<{ deviceId; tenantId; branchId; cashierUserId; cashierName; permissions: Permission[] }>`
  - `class PosCashierError extends Error`

Cashier tokens are held in a process-local in-memory map with a 12-hour TTL — a cashier session dies with the server process, which is correct: it is a counter session, not a durable credential. No new table.

- [ ] **Step 1: Write the failing tests.** Create `src/server/pos/cashier.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { users, roles, userRoles } from "@/server/auth/schema";
import { hashPassword } from "@/server/auth/password";
import { signInCashier, resolveCashier } from "./cashier";
import { PosCashierError } from "./errors";

let n = 0;

async function seedUser(roleKey: "owner" | "staff") {
  const [t] = await db.insert(tenants).values({
    slug: `pos-cashier-${n++}`, name: "T", country: "EG", vertical: "restaurant",
  }).returning();
  const [u] = await db.insert(users).values({
    tenantId: t.id, name: "Cash Ier", email: `c${n}@x.com`,
    passwordHash: await hashPassword("pw123456"), status: "active",
  }).returning();
  const [r] = await db.insert(roles).values({ tenantId: t.id, key: roleKey, name: roleKey }).returning();
  await db.insert(userRoles).values({ userId: u.id, roleId: r.id });
  return { tenantId: t.id, userId: u.id, email: u.email! };
}

describe("signInCashier", () => {
  it("returns a token and the owner's POS permissions", async () => {
    const { tenantId, email } = await seedUser("owner");
    const res = await signInCashier(tenantId, email, "pw123456");
    expect(res.cashierToken).toBeTruthy();
    expect(res.permissions).toContain("pos:discount");
  });

  it("gives staff pos:sell but not pos:discount", async () => {
    const { tenantId, email } = await seedUser("staff");
    const res = await signInCashier(tenantId, email, "pw123456");
    expect(res.permissions).toContain("pos:sell");
    expect(res.permissions).not.toContain("pos:discount");
  });

  it("rejects a wrong password", async () => {
    const { tenantId, email } = await seedUser("staff");
    await expect(signInCashier(tenantId, email, "wrong")).rejects.toThrow(PosCashierError);
  });

  it("resolves a signed-in cashier from their token", async () => {
    const { tenantId, email, userId } = await seedUser("owner");
    const { cashierToken } = await signInCashier(tenantId, email, "pw123456");
    const resolved = resolveCashier(cashierToken);
    expect(resolved?.userId).toBe(userId);
    expect(resolved?.tenantId).toBe(tenantId);
  });

  it("does not resolve an unknown token", () => {
    expect(resolveCashier("nope")).toBeNull();
  });
});
```

Read `src/server/auth/schema.ts` first and correct the `roles` / `userRoles` insert shapes if they differ from the above.

- [ ] **Step 2: Run to verify it fails.**

Run: `npx vitest run src/server/pos/cashier.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the error.** Append to `src/server/pos/errors.ts`:

```ts
/** Thrown when a cashier's credentials are wrong, or their session is missing/expired. */
export class PosCashierError extends Error {
  constructor(message = "Invalid cashier credentials") {
    super(message);
    this.name = "PosCashierError";
  }
}

/** Thrown when the cashier lacks the permission the action requires. */
export class PosForbiddenError extends Error {
  constructor(public readonly permission: string) {
    super(`Missing permission: ${permission}`);
    this.name = "PosForbiddenError";
  }
}
```

- [ ] **Step 4: Implement the cashier service.** Create `src/server/pos/cashier.ts`:

```ts
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/server/auth/schema";
import { verifyPassword } from "@/server/auth/password";
import { loadUserRoleKeys } from "@/server/auth/current-user";
import { ROLE_PERMISSIONS, type Permission } from "@/server/rbac/permissions";
import { PosCashierError } from "./errors";

const CASHIER_TTL_MS = 12 * 60 * 60 * 1000; // one long shift

export type CashierSession = {
  userId: string;
  tenantId: string;
  name: string;
  permissions: Permission[];
  expiresAt: number;
};

/**
 * Cashier sessions live in process memory, not the database: a counter session
 * is meant to die when the app or the server does. The device token (durable,
 * in `pos_devices`) is what survives — this only identifies the human.
 */
const sessions = new Map<string, CashierSession>();

function sweep(now: number): void {
  for (const [token, s] of sessions) if (s.expiresAt <= now) sessions.delete(token);
}

/** Union of the POS permissions granted by any of the user's roles. */
export async function posPermissionsFor(userId: string): Promise<Permission[]> {
  const roleKeys = await loadUserRoleKeys(userId);
  const all = new Set<Permission>();
  for (const key of roleKeys) {
    for (const p of ROLE_PERMISSIONS[key] ?? []) if (p.startsWith("pos:")) all.add(p);
  }
  return [...all];
}

export async function signInCashier(
  tenantId: string,
  email: string,
  password: string,
): Promise<{ cashierToken: string; userId: string; name: string; permissions: Permission[] }> {
  const [user] = await db.select().from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.email, email.trim().toLowerCase())))
    .limit(1);

  if (!user?.passwordHash || user.status !== "active" || !(await verifyPassword(password, user.passwordHash))) {
    throw new PosCashierError();
  }

  const permissions = await posPermissionsFor(user.id);
  if (!permissions.includes("pos:sell")) {
    throw new PosCashierError("This account is not allowed to use the POS");
  }

  const cashierToken = randomBytes(32).toString("hex");
  const now = Date.now();
  sweep(now);
  sessions.set(cashierToken, {
    userId: user.id, tenantId, name: user.name, permissions, expiresAt: now + CASHIER_TTL_MS,
  });

  return { cashierToken, userId: user.id, name: user.name, permissions };
}

export function resolveCashier(token: string): CashierSession | null {
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return s;
}

/** Verifies a manager's credentials and that they hold `permission`. Used by grants. */
export async function verifyAuthorizer(
  tenantId: string,
  email: string,
  password: string,
  permission: Permission,
): Promise<{ userId: string; name: string }> {
  const [user] = await db.select().from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.email, email.trim().toLowerCase())))
    .limit(1);

  if (!user?.passwordHash || user.status !== "active" || !(await verifyPassword(password, user.passwordHash))) {
    throw new PosCashierError();
  }
  const permissions = await posPermissionsFor(user.id);
  if (!permissions.includes(permission)) {
    throw new PosCashierError("This user cannot authorize that action");
  }
  return { userId: user.id, name: user.name };
}
```

- [ ] **Step 5: Implement `requirePosCashier`.** Create `src/server/pos/require-cashier.ts`:

```ts
import { requirePosDevice } from "./require-device";
import { resolveCashier } from "./cashier";
import { PosCashierError, PosForbiddenError } from "./errors";
import type { Permission } from "@/server/rbac/permissions";

export type PosCashierContext = {
  deviceId: string;
  tenantId: string;
  branchId: string;
  cashierUserId: string;
  cashierName: string;
  permissions: Permission[];
};

/**
 * Resolves BOTH identities behind a POS request: the terminal (device token in
 * `Authorization: Bearer`) and the human (cashier token in `X-POS-Cashier`).
 * Throws PosAuthError for a bad device, PosCashierError for a bad cashier.
 */
export async function requirePosCashier(req: Request): Promise<PosCashierContext> {
  const device = await requirePosDevice(req);
  const token = req.headers.get("x-pos-cashier")?.trim() ?? "";
  const session = token ? resolveCashier(token) : null;
  if (!session) throw new PosCashierError("Cashier not signed in");

  // A cashier token minted for another tenant must never work on this device.
  if (session.tenantId !== device.tenantId) throw new PosCashierError("Cashier not signed in");

  return {
    deviceId: device.deviceId,
    tenantId: device.tenantId,
    branchId: device.branchId,
    cashierUserId: session.userId,
    cashierName: session.name,
    permissions: session.permissions,
  };
}

/** Server-side gate. The UI hiding a button is an affordance; this is the control. */
export function assertPermission(ctx: PosCashierContext, permission: Permission): void {
  if (!ctx.permissions.includes(permission)) throw new PosForbiddenError(permission);
}
```

- [ ] **Step 6: Implement the route.** Create `src/app/api/pos/v1/cashier/login/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { requirePosDevice } from "@/server/pos/require-device";
import { signInCashier } from "@/server/pos/cashier";
import { PosAuthError, PosCashierError } from "@/server/pos/errors";

export async function POST(req: NextRequest) {
  let device;
  try {
    device = await requirePosDevice(req);
  } catch (e) {
    if (e instanceof PosAuthError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw e;
  }

  const { email, password } = (await req.json()) as { email?: string; password?: string };
  if (!email || !password) {
    return NextResponse.json({ error: "Missing email or password" }, { status: 400 });
  }

  try {
    const res = await signInCashier(device.tenantId, email, password);
    return NextResponse.json(res);
  } catch (e) {
    if (e instanceof PosCashierError) return NextResponse.json({ error: e.message }, { status: 401 });
    throw e;
  }
}
```

- [ ] **Step 7: Run tests + lint to verify they pass.**

Run: `npx vitest run src/server/pos/cashier.test.ts && npx tsc --noEmit && npx eslint src/server/pos src/app/api/pos`
Expected: PASS, clean.

- [ ] **Step 8: Commit.**

```bash
git add src/server/pos/cashier.ts src/server/pos/require-cashier.ts src/server/pos/errors.ts src/server/pos/cashier.test.ts src/app/api/pos/v1/cashier
git commit -m "feat(pos): cashier sign-in and requirePosCashier"
```

---

## Task 7: Manager authorization grants

A `staff` cashier hands the terminal to a manager, who enters their own credentials. The server issues a short-lived, single-use grant scoped to one permission. The sale request then spends it.

**Files:**
- Create: `src/server/pos/grants.ts`
- Create: `src/app/api/pos/v1/authorize/route.ts`
- Test: `src/server/pos/grants.test.ts`

**Interfaces:**
- Consumes: `verifyAuthorizer` (Task 6), `Permission`.
- Produces:
  - `issueGrant(tenantId, permission, authorizedByUserId): string`
  - `consumeGrant(tenantId, token, permission): string` — returns `authorizedByUserId`, throws `PosForbiddenError`. **Single-use**: a second call with the same token throws.
  - `resolveAuthorizer(ctx, permission, grantToken?): string` — the one helper every gated write calls. Returns the `authorizedByUserId` to record: the cashier themselves if they hold the permission, otherwise the grant's manager.

- [ ] **Step 1: Write the failing tests.** Create `src/server/pos/grants.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { issueGrant, consumeGrant, GRANT_TTL_MS } from "./grants";
import { PosForbiddenError } from "./errors";

afterEach(() => vi.useRealTimers());

describe("grants", () => {
  it("consumes a valid grant once and returns the authorizer", () => {
    const token = issueGrant("t1", "pos:discount", "mgr-1");
    expect(consumeGrant("t1", token, "pos:discount")).toBe("mgr-1");
  });

  it("refuses to reuse a grant", () => {
    const token = issueGrant("t1", "pos:discount", "mgr-1");
    consumeGrant("t1", token, "pos:discount");
    expect(() => consumeGrant("t1", token, "pos:discount")).toThrow(PosForbiddenError);
  });

  it("refuses a grant issued for a different permission", () => {
    const token = issueGrant("t1", "pos:void", "mgr-1");
    expect(() => consumeGrant("t1", token, "pos:discount")).toThrow(PosForbiddenError);
  });

  it("refuses a grant issued for a different tenant", () => {
    const token = issueGrant("t1", "pos:discount", "mgr-1");
    expect(() => consumeGrant("t2", token, "pos:discount")).toThrow(PosForbiddenError);
  });

  it("refuses an expired grant", () => {
    vi.useFakeTimers();
    const token = issueGrant("t1", "pos:discount", "mgr-1");
    vi.advanceTimersByTime(GRANT_TTL_MS + 1);
    expect(() => consumeGrant("t1", token, "pos:discount")).toThrow(PosForbiddenError);
  });

  it("refuses an unknown token", () => {
    expect(() => consumeGrant("t1", "nope", "pos:discount")).toThrow(PosForbiddenError);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npx vitest run src/server/pos/grants.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement.** Create `src/server/pos/grants.ts`:

```ts
import { randomBytes } from "node:crypto";
import type { Permission } from "@/server/rbac/permissions";
import { PosForbiddenError } from "./errors";
import type { PosCashierContext } from "./require-cashier";

/** Long enough for a manager to walk over; short enough to be useless if left on screen. */
export const GRANT_TTL_MS = 2 * 60 * 1000;

type Grant = { tenantId: string; permission: Permission; authorizedByUserId: string; expiresAt: number };

const grants = new Map<string, Grant>();

export function issueGrant(tenantId: string, permission: Permission, authorizedByUserId: string): string {
  const token = randomBytes(24).toString("hex");
  const now = Date.now();
  for (const [t, g] of grants) if (g.expiresAt <= now) grants.delete(t);
  grants.set(token, { tenantId, permission, authorizedByUserId, expiresAt: now + GRANT_TTL_MS });
  return token;
}

/** Single-use. Deleting before every failure path means a token is spent whether or not it matched. */
export function consumeGrant(tenantId: string, token: string, permission: Permission): string {
  const g = grants.get(token);
  grants.delete(token);
  if (!g) throw new PosForbiddenError(permission);
  if (g.expiresAt <= Date.now()) throw new PosForbiddenError(permission);
  if (g.tenantId !== tenantId) throw new PosForbiddenError(permission);
  if (g.permission !== permission) throw new PosForbiddenError(permission);
  return g.authorizedByUserId;
}

/**
 * Who authorized this action? The cashier, if they hold the permission
 * themselves; otherwise the manager behind the grant. Throws if neither.
 * Every gated write goes through here — it is the single enforcement point.
 */
export function resolveAuthorizer(
  ctx: PosCashierContext,
  permission: Permission,
  grantToken?: string,
): string {
  if (ctx.permissions.includes(permission)) return ctx.cashierUserId;
  if (!grantToken) throw new PosForbiddenError(permission);
  return consumeGrant(ctx.tenantId, grantToken, permission);
}
```

- [ ] **Step 4: Implement the route.** Create `src/app/api/pos/v1/authorize/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { requirePosCashier } from "@/server/pos/require-cashier";
import { verifyAuthorizer } from "@/server/pos/cashier";
import { issueGrant } from "@/server/pos/grants";
import { PosAuthError, PosCashierError } from "@/server/pos/errors";
import { PERMISSIONS, type Permission } from "@/server/rbac/permissions";

export async function POST(req: NextRequest) {
  let ctx;
  try {
    ctx = await requirePosCashier(req);
  } catch (e) {
    if (e instanceof PosAuthError || e instanceof PosCashierError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw e;
  }

  const { email, password, permission } = (await req.json()) as {
    email?: string; password?: string; permission?: string;
  };
  if (!email || !password || !permission) {
    return NextResponse.json({ error: "Missing email, password, or permission" }, { status: 400 });
  }
  if (!PERMISSIONS.includes(permission as Permission) || !permission.startsWith("pos:")) {
    return NextResponse.json({ error: "Unknown permission" }, { status: 400 });
  }

  try {
    const manager = await verifyAuthorizer(ctx.tenantId, email, password, permission as Permission);
    const grant = issueGrant(ctx.tenantId, permission as Permission, manager.userId);
    return NextResponse.json({ grant, authorizedBy: manager.name });
  } catch (e) {
    if (e instanceof PosCashierError) return NextResponse.json({ error: e.message }, { status: 401 });
    throw e;
  }
}
```

- [ ] **Step 5: Run to verify it passes.**

Run: `npx vitest run src/server/pos/grants.test.ts && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 6: Commit.**

```bash
git add src/server/pos/grants.ts src/server/pos/grants.test.ts src/app/api/pos/v1/authorize
git commit -m "feat(pos): single-use manager authorization grants"
```

---

## Task 8: `recordSale` — order + tenders + adjustments, atomically

Replaces `submit-order.ts`. Keeps the existing `pos_order_receipts` idempotency.

**Files:**
- Create: `src/server/pos/record-sale.ts`
- Create: `src/app/api/pos/v1/sales/route.ts`
- Delete: `src/server/pos/submit-order.ts`, `src/server/pos/submit-order.test.ts`, `src/app/api/pos/v1/orders/route.ts`
- Test: `src/server/pos/record-sale.test.ts`

**Interfaces:**
- Consumes: `placeOrder` + `TotalMismatchError` (Task 5), `PosCashierContext` + `assertPermission` (Task 6), `resolveAuthorizer` (Task 7), `orderPayments` / `posAdjustmentEvents` (Task 3), `money` (`@/server/ordering/service`).
- Produces:
  - `const REASON_CODES = ["staff_meal","comp_service","promo","manager_discretion","wrong_item","customer_changed_mind","other"] as const`
  - `type TenderInput = { clientPaymentId: string; method: "cash"|"card"|"other"; amount: number; tipAmount?: number; tenderedAmount?: number; reference?: string }`
  - `type RecordSaleInput = { clientOrderId: string; lines: PlaceOrderLine[]; orderDiscountAmount?: number; orderDiscountReason?: string; expectedTotal: number; payments: TenderInput[]; grants?: { permission: Permission; token: string }[]; notes?: string }`
  - `recordSale(ctx: PosCashierContext, input: RecordSaleInput): Promise<SaleReceipt>` where `SaleReceipt = { orderId; orderNumber: string; total: number; paidAmount: number; changeAmount: number; paymentStatus: "paid"|"partially_paid"; idempotent: boolean }`

- [ ] **Step 1: Create the shared test fixture.** Tasks 8, 9, and 10 all need a seeded tenant + branch + product + paired device + signed-in cashier. Create `src/server/pos/test-helpers.ts` once:

```ts
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { users, roles, userRoles } from "@/server/auth/schema";
import { hashPassword } from "@/server/auth/password";
import { createBranch, updateBranchOrdering } from "@/server/branches/service";
import { createCategory, createProduct, updateProduct } from "@/server/catalog/service";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { getCheckoutPricing } from "@/server/tenancy/settings";
import { computeCartTotals } from "@/lib/order-totals";
import { createPairingCode, redeemPairingCode, resolveDevice } from "./service";
import { signInCashier } from "./cashier";
import type { PosCashierContext } from "./require-cashier";

let n = 0;

/**
 * A tenant with one branch, one published 100.00 product, a paired device, and
 * a signed-in cashier of the given role. `total` is the server's total for a
 * single unit — tests assert against it rather than hardcoding a number that
 * would drift with the tenant's VAT/service-charge defaults.
 */
export async function seedPosContext(role: "owner" | "manager" | "staff" = "owner"): Promise<{
  ctx: PosCashierContext;
  tenantId: string;
  branchId: string;
  productId: string;
  managerId: string;
  total: number;
}> {
  const i = n++;
  const [t] = await db.insert(tenants).values({
    slug: `pos-sale-${i}`, name: "T", country: "EG", vertical: "restaurant",
  }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro");

  const branch = await createBranch(t.id, { name: "Main" });
  await updateBranchOrdering(t.id, branch.id, { acceptingOrders: true, openingHours: [] });

  const cat = await createCategory(t.id, { nameEn: "Pizza", nameAr: "بيتزا" });
  const prod = await createProduct(t.id, {
    nameEn: "Margherita", nameAr: "مارجريتا", basePrice: "100", categoryId: cat.id,
  });
  await updateProduct(t.id, prod.id, { isPublished: true });

  // The cashier under test.
  const [cashierUser] = await db.insert(users).values({
    tenantId: t.id, name: "Cash Ier", email: `cashier-${i}@x.com`,
    passwordHash: await hashPassword("pw123456"), status: "active",
  }).returning();
  const [cashierRole] = await db.insert(roles).values({ tenantId: t.id, key: role, name: role }).returning();
  await db.insert(userRoles).values({ userId: cashierUser.id, roleId: cashierRole.id });

  // A manager who can authorize what a staff cashier cannot.
  const [managerUser] = await db.insert(users).values({
    tenantId: t.id, name: "Man Ager", email: `manager-${i}@x.com`,
    passwordHash: await hashPassword("pw123456"), status: "active",
  }).returning();
  const [managerRole] = await db.insert(roles).values({ tenantId: t.id, key: "manager", name: "manager" }).returning();
  await db.insert(userRoles).values({ userId: managerUser.id, roleId: managerRole.id });

  const { code } = await createPairingCode(t.id, branch.id, "counter", managerUser.id);
  const { deviceToken } = await redeemPairingCode(code);
  const device = (await resolveDevice(deviceToken))!;

  const session = await signInCashier(t.id, cashierUser.email!, "pw123456");

  const pricing = await getCheckoutPricing(t.id);
  const total = computeCartTotals(pricing, [{ unitPrice: 100, quantity: 1 }], 0).total;

  return {
    ctx: {
      deviceId: device.deviceId,
      tenantId: t.id,
      branchId: branch.id,
      cashierUserId: cashierUser.id,
      cashierName: cashierUser.name,
      permissions: session.permissions,
    },
    tenantId: t.id,
    branchId: branch.id,
    productId: prod.id,
    managerId: managerUser.id,
    total,
  };
}
```

Read `src/server/auth/schema.ts` and `src/server/pos/submit-order.test.ts` before writing this, and correct any insert shape that differs. Then delete the now-duplicated fixture from `submit-order.test.ts` when you remove that file in Step 5.

- [ ] **Step 2: Write the failing tests.** Create `src/server/pos/record-sale.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { orders } from "@/server/ordering/schema";
import { orderPayments, posAdjustmentEvents } from "./tender-schema";
import { PosForbiddenError } from "./errors";
import { TotalMismatchError } from "@/server/ordering/errors";
import { issueGrant } from "./grants";
import { recordSale } from "./record-sale";
// seedPosContext: seeds tenant+branch+published product (basePrice "100") + a
// paired device + a signed-in cashier of the given role, and returns
// { ctx, tenantId, productId, managerId, total } where `total` is the server
// total for 1 unit. Adapt the helpers in submit-order.test.ts + cashier.test.ts.
import { seedPosContext } from "./test-helpers";

describe("recordSale", () => {
  it("records a cash sale with change and marks it paid", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
    const res = await recordSale(ctx, {
      clientOrderId: "s-1",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p-1", method: "cash", amount: total, tenderedAmount: total + 50 }],
    });
    expect(res.paymentStatus).toBe("paid");
    expect(res.changeAmount).toBe(50);

    const tenders = await db.select().from(orderPayments).where(eq(orderPayments.orderId, res.orderId));
    expect(tenders).toHaveLength(1);
    expect(Number(tenders[0].changeAmount)).toBe(50);
  });

  it("records a split payment across two tenders", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
    const half = Math.round((total / 2) * 100) / 100;
    const res = await recordSale(ctx, {
      clientOrderId: "s-2",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [
        { clientPaymentId: "p-a", method: "cash", amount: half, tenderedAmount: half },
        { clientPaymentId: "p-b", method: "card", amount: total - half, reference: "4242" },
      ],
    });
    expect(res.paymentStatus).toBe("paid");
    const tenders = await db.select().from(orderPayments).where(eq(orderPayments.orderId, res.orderId));
    expect(tenders).toHaveLength(2);
  });

  it("leaves an underpaid sale partially_paid", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
    const res = await recordSale(ctx, {
      clientOrderId: "s-3",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p-1", method: "card", amount: 1 }],
    });
    expect(res.paymentStatus).toBe("partially_paid");
    const [order] = await db.select().from(orders).where(eq(orders.id, res.orderId));
    expect(order.paymentStatus).toBe("partially_paid");
  });

  it("rejects an overpaying card tender — only cash yields change", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
    await expect(recordSale(ctx, {
      clientOrderId: "s-4",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p-1", method: "card", amount: total + 10 }],
    })).rejects.toThrow(/change/i);
  });

  it("is idempotent on clientOrderId", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
    const input = {
      clientOrderId: "dup",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p-1", method: "cash" as const, amount: total, tenderedAmount: total }],
    };
    const a = await recordSale(ctx, input);
    const b = await recordSale(ctx, input);
    expect(b.idempotent).toBe(true);
    expect(b.orderId).toBe(a.orderId);
    const tenders = await db.select().from(orderPayments).where(eq(orderPayments.orderId, a.orderId));
    expect(tenders).toHaveLength(1); // the retry must not double-charge
  });

  it("rejects a stale total and creates nothing", async () => {
    const { ctx, productId } = await seedPosContext("owner");
    await expect(recordSale(ctx, {
      clientOrderId: "s-5",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: 1,
      payments: [{ clientPaymentId: "p-1", method: "cash", amount: 1, tenderedAmount: 1 }],
    })).rejects.toThrow(TotalMismatchError);
  });

  it("forbids a staff discount without a manager grant", async () => {
    const { ctx, productId } = await seedPosContext("staff");
    await expect(recordSale(ctx, {
      clientOrderId: "s-6",
      lines: [{ productId, quantity: 1, selectedOptionIds: [], discountAmount: 10, discountReason: "promo" }],
      expectedTotal: 0,
      payments: [],
    })).rejects.toThrow(PosForbiddenError);
  });

  it("records the manager as authorizer when staff spends a grant", async () => {
    const { ctx, productId, managerId, tenantId } = await seedPosContext("staff");
    const grant = issueGrant(tenantId, "pos:discount", managerId);
    const res = await recordSale(ctx, {
      clientOrderId: "s-7",
      lines: [{ productId, quantity: 1, selectedOptionIds: [], discountAmount: 10, discountReason: "promo" }],
      expectedTotal: 102.6, // 100 - 10 = 90 -> +10% svc = 99 -> ... recompute for your fixture
      payments: [],
      grants: [{ permission: "pos:discount", token: grant }],
    });
    const [ev] = await db.select().from(posAdjustmentEvents).where(eq(posAdjustmentEvents.orderId, res.orderId));
    expect(ev.type).toBe("line_discount");
    expect(ev.authorizedByUserId).toBe(managerId);
    expect(ev.byUserId).toBe(ctx.cashierUserId);
  });
});
```

For the last test, compute the expected total from your fixture's pricing rather than guessing — assert on it once, read the failure, and pin the real number.

- [ ] **Step 3: Run to verify it fails.**

Run: `npx vitest run src/server/pos/record-sale.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement.** Create `src/server/pos/record-sale.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { placeOrder, money, type PlaceOrderLine } from "@/server/ordering/service";
import { orders } from "@/server/ordering/schema";
import type { Permission } from "@/server/rbac/permissions";
import { posOrderReceipts } from "./schema";
import { orderPayments, posAdjustmentEvents } from "./tender-schema";
import { resolveAuthorizer } from "./grants";
import { PosSaleError } from "./errors";
import type { PosCashierContext } from "./require-cashier";

export const REASON_CODES = [
  "staff_meal", "comp_service", "promo", "manager_discretion",
  "wrong_item", "customer_changed_mind", "other",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export type TenderInput = {
  clientPaymentId: string;
  method: "cash" | "card" | "other";
  amount: number;
  tipAmount?: number;
  tenderedAmount?: number;
  reference?: string;
};

export type RecordSaleInput = {
  clientOrderId: string;
  lines: PlaceOrderLine[];
  orderDiscountAmount?: number;
  orderDiscountReason?: ReasonCode;
  expectedTotal: number;
  payments: TenderInput[];
  grants?: { permission: Permission; token: string }[];
  notes?: string;
};

export type SaleReceipt = {
  orderId: string;
  orderNumber: string;
  total: number;
  paidAmount: number;
  changeAmount: number;
  paymentStatus: "paid" | "partially_paid";
  idempotent: boolean;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function recordSale(ctx: PosCashierContext, input: RecordSaleInput): Promise<SaleReceipt> {
  // Idempotency: a retried submit returns the original sale rather than
  // charging the customer twice. `pos_order_receipts` has no RLS.
  const [existing] = await db
    .select()
    .from(posOrderReceipts)
    .where(and(
      eq(posOrderReceipts.deviceId, ctx.deviceId),
      eq(posOrderReceipts.clientOrderId, input.clientOrderId),
    ))
    .limit(1);

  if (existing) {
    const [order] = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(orders).where(eq(orders.id, existing.orderId)).limit(1),
    );
    const tenders = await db.select().from(orderPayments).where(eq(orderPayments.orderId, existing.orderId));
    const paidAmount = round2(tenders.reduce((s, t) => s + Number(t.amount), 0));
    return {
      orderId: existing.orderId,
      orderNumber: existing.orderNumber,
      total: Number(order.total),
      paidAmount,
      changeAmount: round2(tenders.reduce((s, t) => s + Number(t.changeAmount ?? 0), 0)),
      paymentStatus: order.paymentStatus === "paid" ? "paid" : "partially_paid",
      idempotent: true,
    };
  }

  // Authorize every discount BEFORE writing anything. resolveAuthorizer throws
  // PosForbiddenError when the cashier lacks the permission and has no grant.
  const grantFor = (p: Permission) => input.grants?.find((g) => g.permission === p)?.token;
  const hasLineDiscount = input.lines.some((l) => (l.discountAmount ?? 0) > 0);
  const hasOrderDiscount = (input.orderDiscountAmount ?? 0) > 0;
  const discountAuthorizer = hasLineDiscount || hasOrderDiscount
    ? resolveAuthorizer(ctx, "pos:discount", grantFor("pos:discount"))
    : null;

  // Validate tenders before touching the DB.
  for (const p of input.payments) {
    if (!(p.amount > 0)) throw new PosSaleError("A tender must be a positive amount");
    if (p.method !== "cash" && p.tenderedAmount !== undefined && p.tenderedAmount !== p.amount) {
      throw new PosSaleError("Only a cash tender can give change");
    }
  }

  const placed = await placeOrder(ctx.tenantId, {
    branchId: ctx.branchId,
    fulfillmentType: "pickup",
    customerName: "Walk-in",
    customerPhone: "000000000",
    notes: input.notes,
    lines: input.lines,
    channel: "pos",
    cashierUserId: ctx.cashierUserId,
    orderDiscountAmount: input.orderDiscountAmount,
    orderDiscountReason: input.orderDiscountReason,
    expectedTotal: input.expectedTotal,
  });

  const paidAmount = round2(input.payments.reduce((s, p) => s + p.amount, 0));
  if (paidAmount > placed.total + 0.001) {
    throw new PosSaleError("Tenders exceed the amount due");
  }

  // Only cash produces change: it is the difference between what was handed
  // over and what was applied to the order.
  let changeAmount = 0;
  const tenderRows = input.payments.map((p) => {
    const change = p.method === "cash" && p.tenderedAmount !== undefined
      ? Math.max(0, round2(p.tenderedAmount - p.amount))
      : 0;
    changeAmount = round2(changeAmount + change);
    return {
      tenantId: ctx.tenantId,
      orderId: placed.orderId,
      method: p.method,
      amount: money(p.amount),
      tipAmount: money(p.tipAmount ?? 0),
      tenderedAmount: p.tenderedAmount !== undefined ? money(p.tenderedAmount) : null,
      changeAmount: p.method === "cash" ? money(change) : null,
      reference: p.reference ?? null,
      takenByUserId: ctx.cashierUserId,
      clientPaymentId: p.clientPaymentId,
    };
  });

  const paymentStatus: "paid" | "partially_paid" =
    paidAmount >= placed.total - 0.001 ? "paid" : "partially_paid";

  await withTenant(ctx.tenantId, async (tx) => {
    if (tenderRows.length > 0) await tx.insert(orderPayments).values(tenderRows);

    const events = [];
    input.lines.forEach((line, i) => {
      if ((line.discountAmount ?? 0) > 0) {
        events.push({
          tenantId: ctx.tenantId,
          orderId: placed.orderId,
          orderItemId: placed.itemIds[i],
          type: "line_discount" as const,
          amount: money(line.discountAmount!),
          reasonCode: line.discountReason ?? "other",
          byUserId: ctx.cashierUserId,
          authorizedByUserId: discountAuthorizer!,
        });
      }
    });
    if (hasOrderDiscount) {
      events.push({
        tenantId: ctx.tenantId,
        orderId: placed.orderId,
        orderItemId: null,
        type: "order_discount" as const,
        amount: money(input.orderDiscountAmount!),
        reasonCode: input.orderDiscountReason ?? "other",
        byUserId: ctx.cashierUserId,
        authorizedByUserId: discountAuthorizer!,
      });
    }
    if (events.length > 0) await tx.insert(posAdjustmentEvents).values(events);

    await tx.update(orders).set({ paymentStatus, updatedAt: new Date() }).where(eq(orders.id, placed.orderId));
  });

  await db.insert(posOrderReceipts).values({
    deviceId: ctx.deviceId,
    clientOrderId: input.clientOrderId,
    orderId: placed.orderId,
    orderNumber: String(placed.orderNumber),
  });

  return {
    orderId: placed.orderId,
    orderNumber: String(placed.orderNumber),
    total: placed.total,
    paidAmount,
    changeAmount,
    paymentStatus,
    idempotent: false,
  };
}
```

Add `PosSaleError` to `src/server/pos/errors.ts`:

```ts
/** Thrown when a sale's tenders are internally inconsistent (bad amount, change on a card, overpayment). */
export class PosSaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PosSaleError";
  }
}
```

- [ ] **Step 5: Implement the route.** Create `src/app/api/pos/v1/sales/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { requirePosCashier, assertPermission } from "@/server/pos/require-cashier";
import { recordSale, type RecordSaleInput } from "@/server/pos/record-sale";
import { PosAuthError, PosCashierError, PosForbiddenError, PosSaleError } from "@/server/pos/errors";
import { TotalMismatchError, OrderValidationError, OutOfStockError } from "@/server/ordering/errors";

export async function POST(req: NextRequest) {
  let ctx;
  try {
    ctx = await requirePosCashier(req);
    assertPermission(ctx, "pos:sell");
  } catch (e) {
    if (e instanceof PosAuthError || e instanceof PosCashierError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (e instanceof PosForbiddenError) return NextResponse.json({ error: e.message }, { status: 403 });
    throw e;
  }

  const body = (await req.json()) as Partial<RecordSaleInput>;
  if (!body.clientOrderId) return NextResponse.json({ error: "Missing clientOrderId" }, { status: 400 });
  if (!body.lines?.length) return NextResponse.json({ error: "Missing lines" }, { status: 400 });
  if (body.expectedTotal === undefined) {
    return NextResponse.json({ error: "Missing expectedTotal" }, { status: 400 });
  }

  try {
    const receipt = await recordSale(ctx, {
      clientOrderId: body.clientOrderId,
      lines: body.lines,
      orderDiscountAmount: body.orderDiscountAmount,
      orderDiscountReason: body.orderDiscountReason,
      expectedTotal: body.expectedTotal,
      payments: body.payments ?? [],
      grants: body.grants,
      notes: body.notes,
    });
    return NextResponse.json(receipt);
  } catch (e) {
    // The register must fail loudly on a price change, never silently charge a
    // different amount. The POS re-pulls the catalog on a 409.
    if (e instanceof TotalMismatchError) {
      return NextResponse.json(
        { error: "Prices have changed — review the cart", expected: e.expected, actual: e.actual },
        { status: 409 },
      );
    }
    if (e instanceof PosForbiddenError) return NextResponse.json({ error: e.message }, { status: 403 });
    if (e instanceof PosSaleError) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof OutOfStockError || e instanceof OrderValidationError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}
```

- [ ] **Step 6: Delete the superseded code.**

```bash
git rm src/server/pos/submit-order.ts src/server/pos/submit-order.test.ts src/app/api/pos/v1/orders/route.ts
```

`GET /api/pos/v1/orders/list` and `POST /api/pos/v1/orders/status` stay — they back the Live orders queue and are untouched.

- [ ] **Step 7: Run tests + typecheck.**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, clean. Any lingering import of `submitPosOrder` is a compile error — fix it by pointing at `recordSale`.

- [ ] **Step 8: Commit.**

```bash
git add -A src/server/pos src/app/api/pos
git commit -m "feat(pos): recordSale writes order, tenders, and adjustment events atomically"
```

---

## Task 9: Top up a partially-paid sale

**Files:**
- Modify: `src/server/pos/record-sale.ts`
- Create: `src/app/api/pos/v1/sales/[id]/payments/route.ts`
- Test: `src/server/pos/record-sale.test.ts`

**Interfaces:**
- Produces: `addTender(ctx: PosCashierContext, orderId: string, tender: TenderInput): Promise<SaleReceipt>` — idempotent on `clientPaymentId`.

- [ ] **Step 1: Write the failing tests.** Append to `src/server/pos/record-sale.test.ts`:

```ts
import { addTender } from "./record-sale";

describe("addTender", () => {
  it("tops up a partially paid sale to paid", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
    const sale = await recordSale(ctx, {
      clientOrderId: "top-1",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p-1", method: "card", amount: 1 }],
    });
    expect(sale.paymentStatus).toBe("partially_paid");

    const res = await addTender(ctx, sale.orderId, {
      clientPaymentId: "p-2", method: "cash", amount: total - 1, tenderedAmount: total - 1,
    });
    expect(res.paymentStatus).toBe("paid");
    expect(res.paidAmount).toBe(total);
  });

  it("is idempotent on clientPaymentId", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
    const sale = await recordSale(ctx, {
      clientOrderId: "top-2",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p-1", method: "card", amount: 1 }],
    });
    const tender = { clientPaymentId: "p-2", method: "cash" as const, amount: 1 };
    await addTender(ctx, sale.orderId, tender);
    await addTender(ctx, sale.orderId, tender);
    const tenders = await db.select().from(orderPayments).where(eq(orderPayments.orderId, sale.orderId));
    expect(tenders).toHaveLength(2); // the original + one, not two
  });

  it("refuses a tender larger than what remains", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
    const sale = await recordSale(ctx, {
      clientOrderId: "top-3",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p-1", method: "card", amount: 1 }],
    });
    await expect(addTender(ctx, sale.orderId, {
      clientPaymentId: "p-2", method: "card", amount: total,
    })).rejects.toThrow(PosSaleError);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npx vitest run src/server/pos/record-sale.test.ts -t addTender`
Expected: FAIL — `addTender` is not exported.

- [ ] **Step 3: Implement.** Append to `src/server/pos/record-sale.ts`:

```ts
/** Adds a tender to an existing (typically partially_paid) sale. Idempotent on clientPaymentId. */
export async function addTender(
  ctx: PosCashierContext,
  orderId: string,
  tender: TenderInput,
): Promise<SaleReceipt> {
  if (!(tender.amount > 0)) throw new PosSaleError("A tender must be a positive amount");
  if (tender.method !== "cash" && tender.tenderedAmount !== undefined && tender.tenderedAmount !== tender.amount) {
    throw new PosSaleError("Only a cash tender can give change");
  }

  return withTenant(ctx.tenantId, async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new PosSaleError("Unknown order");

    const existingTenders = await tx.select().from(orderPayments).where(eq(orderPayments.orderId, orderId));
    const already = existingTenders.find((t) => t.clientPaymentId === tender.clientPaymentId);

    const paidBefore = round2(existingTenders.reduce((s, t) => s + Number(t.amount), 0));
    const total = Number(order.total);

    if (!already) {
      if (paidBefore + tender.amount > total + 0.001) {
        throw new PosSaleError("Tender exceeds the amount due");
      }
      const change = tender.method === "cash" && tender.tenderedAmount !== undefined
        ? Math.max(0, round2(tender.tenderedAmount - tender.amount))
        : 0;
      await tx.insert(orderPayments).values({
        tenantId: ctx.tenantId,
        orderId,
        method: tender.method,
        amount: money(tender.amount),
        tipAmount: money(tender.tipAmount ?? 0),
        tenderedAmount: tender.tenderedAmount !== undefined ? money(tender.tenderedAmount) : null,
        changeAmount: tender.method === "cash" ? money(change) : null,
        reference: tender.reference ?? null,
        takenByUserId: ctx.cashierUserId,
        clientPaymentId: tender.clientPaymentId,
      });
    }

    const after = await tx.select().from(orderPayments).where(eq(orderPayments.orderId, orderId));
    const paidAmount = round2(after.reduce((s, t) => s + Number(t.amount), 0));
    const paymentStatus: "paid" | "partially_paid" =
      paidAmount >= total - 0.001 ? "paid" : "partially_paid";

    await tx.update(orders).set({ paymentStatus, updatedAt: new Date() }).where(eq(orders.id, orderId));

    return {
      orderId,
      orderNumber: String(order.orderNumber),
      total,
      paidAmount,
      changeAmount: round2(after.reduce((s, t) => s + Number(t.changeAmount ?? 0), 0)),
      paymentStatus,
      idempotent: Boolean(already),
    };
  });
}
```

- [ ] **Step 4: Implement the route.** Create `src/app/api/pos/v1/sales/[id]/payments/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { requirePosCashier, assertPermission } from "@/server/pos/require-cashier";
import { addTender, type TenderInput } from "@/server/pos/record-sale";
import { PosAuthError, PosCashierError, PosForbiddenError, PosSaleError } from "@/server/pos/errors";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let ctx;
  try {
    ctx = await requirePosCashier(req);
    assertPermission(ctx, "pos:sell");
  } catch (e) {
    if (e instanceof PosAuthError || e instanceof PosCashierError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (e instanceof PosForbiddenError) return NextResponse.json({ error: e.message }, { status: 403 });
    throw e;
  }

  const body = (await req.json()) as Partial<TenderInput>;
  if (!body.clientPaymentId || !body.method || body.amount === undefined) {
    return NextResponse.json({ error: "Missing clientPaymentId, method, or amount" }, { status: 400 });
  }

  try {
    const receipt = await addTender(ctx, id, body as TenderInput);
    return NextResponse.json(receipt);
  } catch (e) {
    if (e instanceof PosSaleError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
```

Confirm the async-`params` signature against another dynamic route in this repo (e.g. under `src/app/api/`) and match whatever that one does — this Next version's convention wins over any remembered one.

- [ ] **Step 5: Run to verify it passes.**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 6: Commit.**

```bash
git add src/server/pos/record-sale.ts src/server/pos/record-sale.test.ts src/app/api/pos/v1/sales
git commit -m "feat(pos): top up a partially paid sale with an extra tender"
```

---

## Task 10: Held tickets + catalog pricing

**Files:**
- Create: `src/server/pos/held-tickets.ts`
- Create: `src/app/api/pos/v1/held-tickets/route.ts`
- Create: `src/app/api/pos/v1/held-tickets/[id]/route.ts`
- Modify: `src/app/api/pos/v1/catalog/route.ts`
- Test: `src/server/pos/held-tickets.test.ts`

**Interfaces:**
- Produces:
  - `holdTicket(ctx, label, draft: unknown): Promise<{ id: string }>`
  - `listHeldTickets(ctx): Promise<{ id; label; draftJson; cashierUserId; createdAt }[]>` — scoped to the device's **branch**, not the device, so till 2 sees till 1's parked ticket.
  - `discardHeldTicket(ctx, id): Promise<void>`
  - `GET /catalog` response gains `pricing: CheckoutPricing`.

- [ ] **Step 1: Write the failing test.** Create `src/server/pos/held-tickets.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { holdTicket, listHeldTickets, discardHeldTicket } from "./held-tickets";
import { seedPosContext } from "./test-helpers";

describe("held tickets", () => {
  it("parks a ticket and lists it back", async () => {
    const { ctx } = await seedPosContext("owner");
    const { id } = await holdTicket(ctx, "Table 4", { lines: [{ productId: "p", quantity: 1 }] });
    const list = await listHeldTickets(ctx);
    expect(list.map((t) => t.id)).toContain(id);
    expect(list.find((t) => t.id === id)!.label).toBe("Table 4");
  });

  it("discards a ticket", async () => {
    const { ctx } = await seedPosContext("owner");
    const { id } = await holdTicket(ctx, "Table 9", { lines: [] });
    await discardHeldTicket(ctx, id);
    const list = await listHeldTickets(ctx);
    expect(list.map((t) => t.id)).not.toContain(id);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npx vitest run src/server/pos/held-tickets.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement.** Create `src/server/pos/held-tickets.ts`:

```ts
import { and, desc, eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { posHeldTickets } from "./tender-schema";
import type { PosCashierContext } from "./require-cashier";

export async function holdTicket(
  ctx: PosCashierContext,
  label: string,
  draft: unknown,
): Promise<{ id: string }> {
  const [row] = await withTenant(ctx.tenantId, (tx) =>
    tx.insert(posHeldTickets).values({
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      deviceId: ctx.deviceId,
      cashierUserId: ctx.cashierUserId,
      label: label.trim() || "Ticket",
      draftJson: draft,
    }).returning({ id: posHeldTickets.id }),
  );
  return { id: row.id };
}

/** Branch-scoped, not device-scoped: a ticket parked at till 1 is recallable at till 2. */
export async function listHeldTickets(ctx: PosCashierContext) {
  return withTenant(ctx.tenantId, (tx) =>
    tx.select({
      id: posHeldTickets.id,
      label: posHeldTickets.label,
      draftJson: posHeldTickets.draftJson,
      cashierUserId: posHeldTickets.cashierUserId,
      createdAt: posHeldTickets.createdAt,
    })
      .from(posHeldTickets)
      .where(eq(posHeldTickets.branchId, ctx.branchId))
      .orderBy(desc(posHeldTickets.createdAt)),
  );
}

export async function discardHeldTicket(ctx: PosCashierContext, id: string): Promise<void> {
  await withTenant(ctx.tenantId, (tx) =>
    tx.delete(posHeldTickets).where(and(
      eq(posHeldTickets.id, id),
      eq(posHeldTickets.branchId, ctx.branchId),
    )),
  );
}
```

- [ ] **Step 4: Implement the routes.** Create `src/app/api/pos/v1/held-tickets/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { requirePosCashier } from "@/server/pos/require-cashier";
import { holdTicket, listHeldTickets } from "@/server/pos/held-tickets";
import { PosAuthError, PosCashierError } from "@/server/pos/errors";

async function ctxOr401(req: NextRequest) {
  try {
    return { ctx: await requirePosCashier(req) };
  } catch (e) {
    if (e instanceof PosAuthError || e instanceof PosCashierError) {
      return { res: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
    }
    throw e;
  }
}

export async function GET(req: NextRequest) {
  const { ctx, res } = await ctxOr401(req);
  if (!ctx) return res!;
  return NextResponse.json({ tickets: await listHeldTickets(ctx) });
}

export async function POST(req: NextRequest) {
  const { ctx, res } = await ctxOr401(req);
  if (!ctx) return res!;

  const { label, draft } = (await req.json()) as { label?: string; draft?: unknown };
  if (!draft) return NextResponse.json({ error: "Missing draft" }, { status: 400 });

  return NextResponse.json(await holdTicket(ctx, label ?? "Ticket", draft));
}
```

Create `src/app/api/pos/v1/held-tickets/[id]/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { requirePosCashier } from "@/server/pos/require-cashier";
import { discardHeldTicket } from "@/server/pos/held-tickets";
import { PosAuthError, PosCashierError } from "@/server/pos/errors";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let ctx;
  try {
    ctx = await requirePosCashier(req);
  } catch (e) {
    if (e instanceof PosAuthError || e instanceof PosCashierError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw e;
  }
  await discardHeldTicket(ctx, id);
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 5: Add pricing to the catalog.** In `src/app/api/pos/v1/catalog/route.ts`, add the import and return `pricing` — the POS cannot compute a correct total without it:

```ts
import { getCheckoutPricing } from "@/server/tenancy/settings";
```

and replace the last two lines of `GET`:

```ts
  const [menu, pricing] = await Promise.all([
    getPublishedMenu(device.tenantId, device.branchId),
    getCheckoutPricing(device.tenantId),
  ]);
  return NextResponse.json({ menu, pricing, syncedAt: new Date().toISOString() });
```

- [ ] **Step 6: Run to verify it passes.**

Run: `npm test && npx tsc --noEmit && npx eslint src/server/pos src/app/api/pos`
Expected: PASS, clean.

- [ ] **Step 7: Commit.**

```bash
git add src/server/pos/held-tickets.ts src/server/pos/held-tickets.test.ts src/app/api/pos/v1/held-tickets src/app/api/pos/v1/catalog
git commit -m "feat(pos): server-side held tickets; catalog carries checkout pricing"
```

---

## Task 11: POS bridge — cashier, sales, tenders, held tickets

The renderer never touches the network. Everything goes through the typed preload bridge.

**Files:**
- Modify: `apps/pos/electron/pos-main.ts`
- Modify: `apps/pos/electron/main.ts`
- Modify: `apps/pos/electron/preload.ts`
- Modify: `apps/pos/src/pos-bridge.d.ts`

**Interfaces:**
- Produces on `window.pos`:
  - `signInCashier(email, password): Promise<{ name: string; permissions: string[] }>`
  - `cashier(): Promise<{ name: string; permissions: string[] } | null>`
  - `signOutCashier(): Promise<void>`
  - `authorize(email, password, permission): Promise<{ grant: string; authorizedBy: string }>`
  - `getMenu(): Promise<{ json: string; pricing: CheckoutPricing; syncedAt: string } | null>` — **now includes `pricing`**
  - `recordSale(input): Promise<SaleReceipt>` (throws `Error` with `.code === "TOTAL_MISMATCH"` on a 409)
  - `holdTicket(label, draft)`, `listHeldTickets()`, `discardTicket(id)`
  - existing `isPaired`, `branchName`, `pair`, `login`, `getOrders`, `advanceOrder` unchanged
  - **`submitOrder` is removed** — Task 13 replaces its only caller.

- [ ] **Step 1: Extend `PosMain`.** In `apps/pos/electron/pos-main.ts`:

Add to the top-level types:

```ts
export type CheckoutPricing = {
  vatEnabled: boolean;
  vatRate: number;
  pricesIncludeVat: boolean;
  serviceChargeRate: number;
};
export type Cashier = { token: string; name: string; permissions: string[] };
export type TenderInput = {
  clientPaymentId: string;
  method: "cash" | "card" | "other";
  amount: number;
  tipAmount?: number;
  tenderedAmount?: number;
  reference?: string;
};
export type SaleLine = {
  productId: string;
  variantId?: string;
  quantity: number;
  selectedOptionIds: string[];
  discountAmount?: number;
  discountReason?: string;
};
export type RecordSaleInput = {
  lines: SaleLine[];
  orderDiscountAmount?: number;
  orderDiscountReason?: string;
  expectedTotal: number;
  payments: TenderInput[];
  grants?: { permission: string; token: string }[];
  notes?: string;
};
export type SaleReceipt = {
  orderId: string;
  orderNumber: string;
  total: number;
  paidAmount: number;
  changeAmount: number;
  paymentStatus: "paid" | "partially_paid";
  idempotent: boolean;
};
```

Add a field to the class, beside `private device`:

```ts
  /** In memory only: closing the app signs the cashier out but leaves the device paired. */
  private cashier: Cashier | null = null;
```

Replace `authHeaders()` so both identities ride along:

```ts
  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.device?.token ?? ""}`,
    };
    if (this.cashier) h["X-POS-Cashier"] = this.cashier.token;
    return h;
  }
```

Replace `getMenu` and `submitOrder` with:

```ts
  async getMenu(): Promise<{ json: string; pricing: CheckoutPricing; syncedAt: string } | null> {
    if (!this.device) return null;
    const res = await fetch(`${this.baseUrl}/api/pos/v1/catalog`, { headers: this.authHeaders() });
    if (res.status === 401) {
      this.unpair();
      throw new Error("Device unpaired — please pair again");
    }
    if (!res.ok) throw new Error(`Menu fetch failed (${res.status})`);
    const d = (await res.json()) as { menu: unknown; pricing: CheckoutPricing; syncedAt: string };
    return { json: JSON.stringify(d.menu), pricing: d.pricing, syncedAt: d.syncedAt };
  }

  async signInCashier(email: string, password: string): Promise<{ name: string; permissions: string[] }> {
    if (!this.device) throw new Error("Not paired");
    const res = await fetch(`${this.baseUrl}/api/pos/v1/cashier/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.device.token}` },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `Sign-in failed (${res.status})`);
    }
    const d = (await res.json()) as { cashierToken: string; name: string; permissions: string[] };
    this.cashier = { token: d.cashierToken, name: d.name, permissions: d.permissions };
    return { name: d.name, permissions: d.permissions };
  }

  currentCashier(): { name: string; permissions: string[] } | null {
    return this.cashier ? { name: this.cashier.name, permissions: this.cashier.permissions } : null;
  }

  signOutCashier(): void {
    this.cashier = null;
  }

  async authorize(email: string, password: string, permission: string): Promise<{ grant: string; authorizedBy: string }> {
    const res = await fetch(`${this.baseUrl}/api/pos/v1/authorize`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ email, password, permission }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `Authorization failed (${res.status})`);
    }
    return (await res.json()) as { grant: string; authorizedBy: string };
  }

  async recordSale(input: RecordSaleInput): Promise<SaleReceipt> {
    if (!this.device) throw new Error("Not paired");
    if (!this.cashier) throw new Error("No cashier signed in");
    const res = await fetch(`${this.baseUrl}/api/pos/v1/sales`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ clientOrderId: crypto.randomUUID(), ...input }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      // A 409 means live prices moved under a stale catalog. The renderer must
      // re-pull and make the cashier re-check the cart — never retry silently.
      const e = new Error(err.error ?? `Sale failed (${res.status})`) as Error & { code?: string };
      if (res.status === 409) e.code = "TOTAL_MISMATCH";
      throw e;
    }
    return (await res.json()) as SaleReceipt;
  }

  async holdTicket(label: string, draft: unknown): Promise<{ id: string }> {
    const res = await fetch(`${this.baseUrl}/api/pos/v1/held-tickets`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ label, draft }),
    });
    if (!res.ok) throw new Error(`Could not park the ticket (${res.status})`);
    return (await res.json()) as { id: string };
  }

  async listHeldTickets(): Promise<{ id: string; label: string; draftJson: unknown; createdAt: string }[]> {
    const res = await fetch(`${this.baseUrl}/api/pos/v1/held-tickets`, { headers: this.authHeaders() });
    if (!res.ok) return [];
    const d = (await res.json()) as { tickets: { id: string; label: string; draftJson: unknown; createdAt: string }[] };
    return d.tickets;
  }

  async discardTicket(id: string): Promise<void> {
    await fetch(`${this.baseUrl}/api/pos/v1/held-tickets/${id}`, {
      method: "DELETE",
      headers: this.authHeaders(),
    });
  }
```

Also add `this.cashier = null;` to the body of `unpair()`.

- [ ] **Step 2: Register the IPC handlers.** In `apps/pos/electron/main.ts`, add one `ipcMain.handle` per new method, matching the existing style in that file:

```ts
  ipcMain.handle("pos:signInCashier", (_e, email: string, password: string) => pos.signInCashier(email, password));
  ipcMain.handle("pos:cashier", () => pos.currentCashier());
  ipcMain.handle("pos:signOutCashier", () => pos.signOutCashier());
  ipcMain.handle("pos:authorize", (_e, email: string, password: string, permission: string) => pos.authorize(email, password, permission));
  ipcMain.handle("pos:recordSale", (_e, input: RecordSaleInput) => pos.recordSale(input));
  ipcMain.handle("pos:holdTicket", (_e, label: string, draft: unknown) => pos.holdTicket(label, draft));
  ipcMain.handle("pos:listHeldTickets", () => pos.listHeldTickets());
  ipcMain.handle("pos:discardTicket", (_e, id: string) => pos.discardTicket(id));
```

Remove the `pos:submitOrder` handler. Import `RecordSaleInput` from `./pos-main`.

- [ ] **Step 3: Expose them on the bridge.** In `apps/pos/electron/preload.ts`, add the matching `invoke` wrappers to the exposed object and delete `submitOrder`:

```ts
  signInCashier: (email: string, password: string) => ipcRenderer.invoke("pos:signInCashier", email, password),
  cashier: () => ipcRenderer.invoke("pos:cashier"),
  signOutCashier: () => ipcRenderer.invoke("pos:signOutCashier"),
  authorize: (email: string, password: string, permission: string) => ipcRenderer.invoke("pos:authorize", email, password, permission),
  recordSale: (input: unknown) => ipcRenderer.invoke("pos:recordSale", input),
  holdTicket: (label: string, draft: unknown) => ipcRenderer.invoke("pos:holdTicket", label, draft),
  listHeldTickets: () => ipcRenderer.invoke("pos:listHeldTickets"),
  discardTicket: (id: string) => ipcRenderer.invoke("pos:discardTicket", id),
```

- [ ] **Step 4: Update the renderer's types.** In `apps/pos/src/pos-bridge.d.ts`, extend the `window.pos` interface with the signatures from the **Produces** block above (importing `CheckoutPricing`, `RecordSaleInput`, `SaleReceipt` types from `../electron/pos-main`), and remove `submitOrder`.

- [ ] **Step 5: Typecheck.**

Run: `npm run typecheck -w pos`
Expected: errors only in `OrderScreen.tsx` — it still calls the removed `submitOrder` and the deleted `cartTotal`. **Task 13** rewrites that screen and clears both. If you want a green typecheck at this commit, fold Task 13 into this one and commit them together.

- [ ] **Step 6: Commit.**

```bash
git add apps/pos/electron apps/pos/src/pos-bridge.d.ts
git commit -m "feat(pos): bridge exposes cashier, sales, tenders, and held tickets"
```

---

## Task 12: Cashier sign-in screen + manager auth modal

**Files:**
- Create: `apps/pos/src/screens/CashierSignIn.tsx`
- Create: `apps/pos/src/screens/ManagerAuthModal.tsx`
- Modify: `apps/pos/src/App.tsx`

**Interfaces:**
- Produces:
  - `<CashierSignIn onSignedIn={(c: { name: string; permissions: string[] }) => void} />`
  - `<ManagerAuthModal permission={string} action={string} onGranted={(grant: string, by: string) => void} onCancel={() => void} />`
  - `App` holds `cashier` state and renders `CashierSignIn` when the device is paired but no cashier is signed in.

- [ ] **Step 1: Build the cashier sign-in screen.** Create `apps/pos/src/screens/CashierSignIn.tsx`:

```tsx
import { useState, type FormEvent } from "react";

export function CashierSignIn({
  branchName,
  onSignedIn,
}: {
  branchName: string;
  onSignedIn: (c: { name: string; permissions: string[] }) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await window.pos.signInCashier(email.trim(), password));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center bg-background px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-border bg-card p-6">
        <h1 className="font-display text-xl font-bold">
          Serve<span className="text-primary">OS</span> POS
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{branchName} — sign in to start selling</p>

        <label className="mt-5 block text-sm font-medium text-ink" htmlFor="cashier-email">Email</label>
        <input
          id="cashier-email"
          type="email"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-3 text-base"
        />

        <label className="mt-4 block text-sm font-medium text-ink" htmlFor="cashier-password">Password</label>
        <input
          id="cashier-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-3 text-base"
        />

        {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}

        <button
          type="submit"
          disabled={busy || !email || !password}
          className="mt-5 w-full rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Build the manager auth modal.** Create `apps/pos/src/screens/ManagerAuthModal.tsx`:

```tsx
import { useState, type FormEvent } from "react";

/**
 * A staff cashier hands the terminal to a manager, who enters their OWN
 * credentials. The server checks the password and the permission, and returns
 * a single-use grant the sale then spends.
 */
export function ManagerAuthModal({
  permission,
  action,
  onGranted,
  onCancel,
}: {
  permission: string;
  action: string;
  onGranted: (grant: string, authorizedBy: string) => void;
  onCancel: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { grant, authorizedBy } = await window.pos.authorize(email.trim(), password, permission);
      onGranted(grant, authorizedBy);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authorization failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-border bg-card p-6">
        <h2 className="text-lg font-bold text-ink">Manager approval needed</h2>
        <p className="mt-1 text-sm text-muted-foreground">{action}</p>

        <label className="mt-5 block text-sm font-medium text-ink" htmlFor="mgr-email">Manager email</label>
        <input
          id="mgr-email"
          type="email"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-3 text-base"
        />

        <label className="mt-4 block text-sm font-medium text-ink" htmlFor="mgr-password">Password</label>
        <input
          id="mgr-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-3 text-base"
        />

        {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-xl border border-border bg-card px-4 py-3 font-semibold text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !email || !password}
            className="flex-1 rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground disabled:opacity-50"
          >
            {busy ? "Checking…" : "Approve"}
          </button>
        </div>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Wire it into `App`.** In `apps/pos/src/App.tsx`, add cashier state and a third gate between "paired" and the main UI:

```tsx
import { useEffect, useState } from "react";
import { LoginScreen } from "./screens/LoginScreen";
import { CashierSignIn } from "./screens/CashierSignIn";
import { OrderScreen } from "./screens/OrderScreen";
import { OrdersQueue } from "./screens/OrdersQueue";

type View = "order" | "queue";
export type Cashier = { name: string; permissions: string[] };

export function App() {
  const [paired, setPaired] = useState<boolean | null>(null);
  const [branchName, setBranchName] = useState("");
  const [cashier, setCashier] = useState<Cashier | null>(null);
  const [view, setView] = useState<View>("order");

  useEffect(() => {
    window.pos.isPaired().then(async (p) => {
      setPaired(p);
      if (p) {
        setBranchName(await window.pos.branchName());
        setCashier(await window.pos.cashier());
      }
    });
  }, []);

  if (paired === null) {
    return <div className="min-h-screen grid place-items-center bg-background text-sm text-muted-foreground">Loading…</div>;
  }

  if (!paired) {
    return <LoginScreen onPaired={(name) => { setBranchName(name); setPaired(true); }} />;
  }

  if (!cashier) {
    return <CashierSignIn branchName={branchName} onSignedIn={setCashier} />;
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border bg-card px-4 h-14">
        <div className="flex items-center gap-3">
          <span className="font-display text-base font-bold">Serve<span className="text-primary">OS</span> POS</span>
          <span className="text-sm text-muted-foreground">{branchName}</span>
        </div>
        <nav className="flex items-center gap-1">
          <button
            onClick={() => setView("order")}
            className={view === "order"
              ? "rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground"
              : "rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-secondary"}
          >
            Take order
          </button>
          <button
            onClick={() => setView("queue")}
            className={view === "queue"
              ? "rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground"
              : "rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-secondary"}
          >
            Live orders
          </button>
          <button
            onClick={async () => { await window.pos.signOutCashier(); setCashier(null); }}
            className="ml-2 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-secondary"
          >
            {cashier.name} · Sign out
          </button>
        </nav>
      </header>
      {view === "order" ? <OrderScreen branchName={branchName} cashier={cashier} /> : <OrdersQueue />}
    </div>
  );
}
```

- [ ] **Step 4: Commit.**

```bash
git add apps/pos/src/App.tsx apps/pos/src/screens/CashierSignIn.tsx apps/pos/src/screens/ManagerAuthModal.tsx
git commit -m "feat(pos): cashier sign-in screen and manager authorization modal"
```

---

## Task 13: Sale screen + payment screen

The payment screen is the highest-risk UI in this spec: a mistake here is wrong money in a customer's hand. `remaining` is always visible, and **"Complete sale" stays disabled while `remaining > 0`**.

**Files:**
- Create: `apps/pos/src/screens/PaymentScreen.tsx`
- Modify: `apps/pos/src/screens/OrderScreen.tsx`
- Modify: `apps/pos/src/screens/Receipt.tsx`
- Test: `apps/pos/src/screens/payment.test.ts`

**Interfaces:**
- Consumes: `cartTotals`, `CartLine`, `discountLine` (Task 2); `window.pos.recordSale`, `.authorize`, `.holdTicket` (Task 11); `ManagerAuthModal` (Task 12).
- Produces:
  - `splitRemaining(total: number, tenders: TenderDraft[]): number` — pure, tested.
  - `changeFor(tender: TenderDraft): number` — pure, tested.
  - `<PaymentScreen total, onCancel, onComplete(payments: TenderInput[]) />`
  - `Receipt` gains `discountAmount`, `serviceChargeAmount`, `vatAmount`, `tenders`, `changeAmount`, `cashierName`.

- [ ] **Step 1: Write the failing tests for the payment math.** Create `apps/pos/src/screens/payment.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { splitRemaining, changeFor } from "./PaymentScreen";

describe("splitRemaining", () => {
  it("is the full total with no tenders", () => {
    expect(splitRemaining(125.4, [])).toBe(125.4);
  });

  it("subtracts what has been tendered", () => {
    expect(splitRemaining(100, [{ method: "cash", amount: 40 }])).toBe(60);
  });

  it("is zero, never negative, once covered", () => {
    expect(splitRemaining(100, [{ method: "cash", amount: 100 }])).toBe(0);
  });

  it("rounds to cents rather than drifting", () => {
    expect(splitRemaining(100, [{ method: "cash", amount: 33.33 }, { method: "card", amount: 33.33 }])).toBe(33.34);
  });
});

describe("changeFor", () => {
  it("gives change on cash", () => {
    expect(changeFor({ method: "cash", amount: 90, tenderedAmount: 100 })).toBe(10);
  });

  it("gives no change on card", () => {
    expect(changeFor({ method: "card", amount: 90, tenderedAmount: 100 })).toBe(0);
  });

  it("gives no change when exactly tendered", () => {
    expect(changeFor({ method: "cash", amount: 90, tenderedAmount: 90 })).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npm test -w pos`
Expected: FAIL — module not found.

- [ ] **Step 3: Build the payment screen.** Create `apps/pos/src/screens/PaymentScreen.tsx`:

```tsx
import { useState } from "react";

export type TenderMethod = "cash" | "card" | "other";
export type TenderDraft = {
  method: TenderMethod;
  amount: number;
  tenderedAmount?: number;
  reference?: string;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** What is still owed. Never negative. */
export function splitRemaining(total: number, tenders: TenderDraft[]): number {
  const paid = round2(tenders.reduce((s, t) => s + t.amount, 0));
  return Math.max(0, round2(total - paid));
}

/** Only cash gives change. */
export function changeFor(tender: TenderDraft): number {
  if (tender.method !== "cash" || tender.tenderedAmount === undefined) return 0;
  return Math.max(0, round2(tender.tenderedAmount - tender.amount));
}

/** Quick-cash chips: exact, then the next round notes above it. */
function cashChips(remaining: number): number[] {
  const notes = [5, 10, 20, 50, 100, 200];
  const up = notes.filter((n) => n >= remaining).slice(0, 3);
  return [remaining, ...up.filter((n) => n !== remaining)];
}

export function PaymentScreen({
  total,
  cashierName,
  onCancel,
  onComplete,
}: {
  total: number;
  cashierName: string;
  onCancel: () => void;
  onComplete: (tenders: TenderDraft[]) => Promise<void>;
}) {
  const [tenders, setTenders] = useState<TenderDraft[]>([]);
  const [method, setMethod] = useState<TenderMethod>("cash");
  const [entry, setEntry] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remaining = splitRemaining(total, tenders);
  const paid = round2(total - remaining);
  const change = round2(tenders.reduce((s, t) => s + changeFor(t), 0));
  const entered = Number(entry || 0);

  function addTender(handedOver: number) {
    // A cash tender may exceed what is due (that is what change IS). A card
    // tender may not — the amount applied is capped at what remains.
    const applied = method === "cash" ? Math.min(handedOver, remaining) : handedOver;
    if (applied <= 0) return;
    if (method !== "cash" && applied > remaining + 0.001) {
      setError("Only cash can be over-tendered — a card must not exceed what is due");
      return;
    }
    setError(null);
    setTenders([
      ...tenders,
      {
        method,
        amount: round2(applied),
        tenderedAmount: method === "cash" ? round2(handedOver) : undefined,
        reference: method !== "cash" && reference.trim() ? reference.trim() : undefined,
      },
    ]);
    setEntry("");
    setReference("");
  }

  async function complete() {
    setBusy(true);
    setError(null);
    try {
      await onComplete(tenders);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not complete the sale");
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-background px-4 py-6">
      <div className="mx-auto grid w-full max-w-3xl gap-4 md:grid-cols-2">
        <section className="rounded-2xl border border-border bg-card p-6">
          <p className="text-sm text-muted-foreground">Amount due</p>
          <p className="mt-1 text-4xl font-bold tabular-nums text-ink">{total.toFixed(2)}</p>

          <dl className="mt-5 space-y-1.5 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Paid so far</dt>
              <dd className="tabular-nums text-ink">{paid.toFixed(2)}</dd>
            </div>
            <div className="flex justify-between font-semibold">
              <dt className={remaining > 0 ? "text-destructive" : "text-ink"}>Remaining</dt>
              <dd className={remaining > 0 ? "tabular-nums text-destructive" : "tabular-nums text-ink"}>
                {remaining.toFixed(2)}
              </dd>
            </div>
            {change > 0 && (
              <div className="flex justify-between font-semibold">
                <dt className="text-ink">Change due</dt>
                <dd className="tabular-nums text-ink">{change.toFixed(2)}</dd>
              </div>
            )}
          </dl>

          {tenders.length > 0 && (
            <ul className="mt-4 space-y-1 border-t border-dashed border-border pt-3 text-sm">
              {tenders.map((t, i) => (
                <li key={i} className="flex justify-between text-muted-foreground">
                  <span className="capitalize">{t.method}</span>
                  <span className="tabular-nums">{t.amount.toFixed(2)}</span>
                </li>
              ))}
            </ul>
          )}

          {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
        </section>

        <section className="rounded-2xl border border-border bg-card p-6">
          <div className="flex gap-2">
            {(["cash", "card", "other"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMethod(m)}
                className={m === method
                  ? "flex-1 rounded-xl bg-primary px-3 py-2.5 text-sm font-semibold capitalize text-primary-foreground"
                  : "flex-1 rounded-xl border border-border px-3 py-2.5 text-sm font-medium capitalize text-ink"}
              >
                {m}
              </button>
            ))}
          </div>

          {remaining > 0 && method === "cash" && (
            <div className="mt-4 flex flex-wrap gap-2">
              {cashChips(remaining).map((c) => (
                <button
                  key={c}
                  onClick={() => addTender(c)}
                  className="rounded-lg border border-border px-3 py-2 text-sm font-medium tabular-nums text-ink"
                >
                  {c.toFixed(2)}
                </button>
              ))}
            </div>
          )}

          <input
            inputMode="decimal"
            value={entry}
            onChange={(e) => setEntry(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="0.00"
            aria-label="Tender amount"
            className="mt-4 w-full rounded-xl border border-border bg-background px-3 py-3 text-right text-2xl tabular-nums"
          />

          {method !== "cash" && (
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Reference (card last 4)"
              aria-label="Payment reference"
              className="mt-2 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm"
            />
          )}

          <button
            onClick={() => addTender(entered)}
            disabled={remaining <= 0 || entered <= 0}
            className="mt-3 w-full rounded-xl border border-border px-4 py-3 font-semibold text-ink disabled:opacity-40"
          >
            Add {method} tender
          </button>

          <div className="mt-5 flex gap-2">
            <button
              onClick={onCancel}
              className="flex-1 rounded-xl border border-border px-4 py-3 font-semibold text-ink"
            >
              Back
            </button>
            <button
              onClick={complete}
              disabled={busy || remaining > 0}
              className="flex-1 rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground disabled:opacity-40"
            >
              {busy ? "Completing…" : "Complete sale"}
            </button>
          </div>
          <p className="mt-2 text-center text-xs text-muted-foreground">Cashier: {cashierName}</p>
        </section>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the payment tests.**

Run: `npm test -w pos`
Expected: PASS.

- [ ] **Step 5: Rewire `OrderScreen`.** In `apps/pos/src/screens/OrderScreen.tsx`:

- Accept the new prop: `{ branchName, cashier }: { branchName: string; cashier: { name: string; permissions: string[] } }`.
- Store `pricing` from `window.pos.getMenu()` alongside the menu, in state.
- Replace every `cartTotal(lines)` call with `cartTotals(pricing, lines, orderDiscount)`, and display `.subtotal`, `.discountAmount`, `.serviceChargeAmount`, `.vatAmount`, `.total` from it.
- Add a `discount` state: `{ grant?: string } | null`, and a `pendingAuth` state driving `ManagerAuthModal`.
- **Gate the discount buttons:** when `!cashier.permissions.includes("pos:discount")`, tapping "Discount" opens `ManagerAuthModal` with `permission="pos:discount"`; the returned grant is stashed and sent with the sale. When the cashier *does* hold it, apply the discount directly.
- Replace the "Charge (cash)" button with **"Charge"**, which swaps the view to `<PaymentScreen total={totals.total} cashierName={cashier.name} … />`.
- `onComplete(tenders)` calls:

```tsx
const receipt = await window.pos.recordSale({
  lines: lines.map((l) => ({
    productId: l.productId,
    variantId: l.variantId,
    quantity: l.quantity,
    selectedOptionIds: l.selectedOptionIds,
    discountAmount: l.discountAmount,
    discountReason: l.discountReason,
  })),
  orderDiscountAmount: orderDiscount || undefined,
  orderDiscountReason: orderDiscountReason || undefined,
  expectedTotal: totals.total,
  payments: tenders.map((t, i) => ({ ...t, clientPaymentId: `${saleId}-${i}` })),
  grants: grant ? [{ permission: "pos:discount", token: grant }] : undefined,
});
```

where `saleId` is a `crypto.randomUUID()` generated once when the payment screen opens — so retrying the same sale reuses the same `clientPaymentId`s and cannot double-charge.

- **Handle the 409.** Wrap the call:

```tsx
try {
  const receipt = await window.pos.recordSale({ /* … */ });
  setReceipt(receipt);
} catch (e) {
  const err = e as Error & { code?: string };
  if (err.code === "TOTAL_MISMATCH") {
    await reloadMenu(); // re-pull catalog + pricing
    setView("cart");
    setCartError("Prices have changed — please review the cart and charge again.");
    return;
  }
  throw err;
}
```

- Add a **"Park ticket"** button that calls `window.pos.holdTicket(label, { lines, orderDiscount })` and clears the cart.

- [ ] **Step 6: Upgrade the receipt.** In `apps/pos/src/screens/Receipt.tsx`, extend `ReceiptData` and render the new rows:

```tsx
export type ReceiptTender = { method: string; amount: number };
export type ReceiptData = {
  orderNumber: string;
  lines: CartLine[];
  subtotal: number;
  discountAmount: number;
  serviceChargeAmount: number;
  vatAmount: number;
  total: number;
  tenders: ReceiptTender[];
  changeAmount: number;
  cashierName: string;
  timestamp: string;
};
```

Between the item list and the total, render `Subtotal`, `Discount` (only when `> 0`, shown negative), `Service charge` (only when `> 0`), and `VAT` (only when `> 0`). After `TOTAL`, render one row per tender and a `CHANGE` row when `changeAmount > 0`. Replace the hardcoded `PAID — CASH` line with `PAID` plus the tender methods, and add `Cashier: {cashierName}` above `Thank you!`.

- [ ] **Step 7: Typecheck, test, and boot it.**

Run: `npm run typecheck -w pos && npm test -w pos`
Expected: clean, PASS.

Then boot both and click through a real sale:

```bash
npm run dev            # web app on :3000
npm run pos:dev        # POS
```

- [ ] **Step 8: Commit.**

```bash
git add apps/pos/src
git commit -m "feat(pos): payment screen with split tenders, discounts, and a full receipt"
```

---

## Task 14: Held tickets screen

**Files:**
- Create: `apps/pos/src/screens/HeldTickets.tsx`
- Modify: `apps/pos/src/App.tsx`

**Interfaces:**
- Consumes: `window.pos.listHeldTickets()`, `.discardTicket(id)` (Task 11); `CartLine` (Task 2).
- Produces: `<HeldTickets onRecall={(lines: CartLine[], orderDiscount: number) => void} />`, and a third nav tab in `App`.

- [ ] **Step 1: Build the screen.** Create `apps/pos/src/screens/HeldTickets.tsx`:

```tsx
import { useEffect, useState } from "react";
import type { CartLine } from "../order/cart";

type Ticket = { id: string; label: string; draftJson: unknown; createdAt: string };
type Draft = { lines: CartLine[]; orderDiscount?: number };

export function HeldTickets({ onRecall }: { onRecall: (lines: CartLine[], orderDiscount: number) => void }) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setTickets(await window.pos.listHeldTickets());
    setLoading(false);
  }

  useEffect(() => { void refresh(); }, []);

  async function recall(t: Ticket) {
    const draft = t.draftJson as Draft;
    await window.pos.discardTicket(t.id);
    onRecall(draft.lines ?? [], draft.orderDiscount ?? 0);
  }

  async function discard(id: string) {
    await window.pos.discardTicket(id);
    await refresh();
  }

  if (loading) {
    return <p className="p-6 text-sm text-muted-foreground">Loading parked tickets…</p>;
  }

  if (tickets.length === 0) {
    return <p className="p-6 text-sm text-muted-foreground">No parked tickets.</p>;
  }

  return (
    <ul className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-3">
      {tickets.map((t) => (
        <li key={t.id} className="rounded-2xl border border-border bg-card p-4">
          <p className="font-semibold text-ink">{t.label}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {new Date(t.createdAt).toLocaleString()}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => recall(t)}
              className="flex-1 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
            >
              Recall
            </button>
            <button
              onClick={() => discard(t.id)}
              className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted-foreground"
            >
              Discard
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 2: Add the tab.** In `apps/pos/src/App.tsx`, widen `View` to `"order" | "queue" | "held"`, add a **Parked** nav button styled like the others, and render `<HeldTickets onRecall={…} />` for it. `onRecall` must load the lines into `OrderScreen`'s cart and switch the view back to `"order"` — lift the cart state into `App`, or pass a `recalled` prop down to `OrderScreen` and have it seed its cart from it in a `useEffect`.

- [ ] **Step 3: Typecheck and click through.**

Run: `npm run typecheck -w pos`
Expected: clean. Then park a ticket, switch tabs, recall it, confirm the cart is restored.

- [ ] **Step 4: Commit.**

```bash
git add apps/pos/src
git commit -m "feat(pos): parked tickets — park, recall, discard"
```

---

## Task 15: Full-suite verification and manual acceptance

**Files:** none — this task changes nothing. It proves the spec.

- [ ] **Step 1: Run everything.**

```bash
npm test
npx tsc --noEmit
npx eslint src
npm test -w pos
npm run typecheck -w pos
```

Expected: all PASS, all clean. Fix anything that is not before continuing.

- [ ] **Step 2: Walk the acceptance path from the spec.** With `npm run dev` and `npm run pos:dev` both up, and a tenant whose settings have **VAT on** and a **service charge > 0** (set them in Settings → Taxes & charges):

- [ ] Pair the device, then sign in as a **staff** user.
- [ ] Build a cart. Confirm the displayed total includes the service charge and VAT — not a bare sum of prices.
- [ ] Tap Discount. Confirm you are **blocked** and the manager modal appears.
- [ ] Approve with a **manager's** credentials. Confirm the discount applies and the total drops.
- [ ] Charge. Pay **half in cash, half by card**. Confirm "Remaining" counts down and **"Complete sale" is disabled until it hits zero**.
- [ ] Confirm the receipt shows both tenders, the discount, the service charge, VAT, any change, and the cashier's name.
- [ ] Open the dashboard Orders queue. Confirm the sale appears, its total **matches the receipt exactly**, and it is attributed to the cashier.
- [ ] In the DB, confirm `order_payments` has two rows and `pos_adjustment_events` has one row whose `authorized_by_user_id` is the **manager**, not the cashier.
- [ ] Park a ticket, recall it from the Parked tab, confirm the cart is restored.
- [ ] Change a product's price in the dashboard *without* refreshing the POS, then charge the stale cart. Confirm you get **"Prices have changed — review the cart"** and that **no order was created**.

- [ ] **Step 3: Commit any fixes, then open the PR.**

```bash
git push -u origin HEAD
gh pr create --title "feat(pos): sale & tender — cashiers, tenders, discounts, voids, held tickets" --body "$(cat <<'EOF'
Implements docs/ailab/specs/2026-07-14-pos-sale-and-tender-design.md (Spec 1 of 3).

- POS cart totals now come from the shared `order-totals` module — the old naive
  `unitPrice × qty` sum ignored VAT and the service charge, so the receipt could
  disagree with the server. Change due was being computed off that wrong number.
- Sales are attributed to a signed-in cashier and recorded as tenders
  (`order_payments`): split, partial, tips, and change.
- Discounts and voids are reason-coded and authorized; a staff cashier needs a
  single-use manager grant, and the manager is recorded as the authorizer.
- Tickets can be parked and recalled from any till in the branch.
- The server recomputes every total and rejects a stale client total with a 409
  rather than quietly charging a different amount.

Deferred to Specs 2 and 3: shifts/cash drawer (hence the nullable
`order_payments.shiftId`) and refunds. Variants and offline remain out of scope.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:** Prerequisite totals fix → Tasks 1–2. Staff identity → Task 6. Authorization + manager override → Tasks 4, 7. Data model → Task 3. Sale lifecycle + atomic endpoint → Task 8. Partial top-up → Task 9. Server-authoritative totals / 409 → Tasks 5, 8, 13. Held tickets → Tasks 10, 14. Screens → Tasks 12–14. Receipt → Task 13. Testing → every task, plus Task 15.

**One deliberate deviation from the spec:** the spec lists **voids** (`line_void`, `order_void`) alongside discounts. The enum and the `pos_adjustment_events` table support them (Task 3), and `pos:void` exists (Task 4) — but no task builds a void *flow*. Voiding an unpaid line before payment is, in this architecture, just removing it from the cart, which `removeLine` already does; and voiding a sale *after* payment requires reversing tenders, which is a refund — Spec 3. Writing a `line_void` audit row for a cart edit that never reached the server would be recording an event about an order that does not exist. **This is left out on purpose.** If you want cart-edit auditing, it belongs in Spec 3 next to refunds, where there is an order to attach it to.

**Type consistency:** `computeCartTotals` / `computeLineTotal` (Task 1) are used under those names in Tasks 2 and 5. `PosCashierContext` (Task 6) is the parameter type in Tasks 7, 8, 9, 10. `TenderInput` (Task 8) is reused in Task 9's `addTender` and mirrored as `TenderDraft` in the renderer (Task 13) — the renderer's draft lacks `clientPaymentId`, which `OrderScreen` adds at submit time, and that asymmetry is intentional and called out in Task 13 Step 5. `SaleReceipt` (Task 8) is what both `recordSale` and `addTender` return. `resolveAuthorizer` (Task 7) is the sole gate used in Task 8.
