# Suppliers & Purchasing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use mo-ai:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revised 2026-08-08** against the **as-built** Spec 8 Part A/B (`src/server/inventory/`) and Spec 5 (`src/server/notifications/`) interfaces — the 2026-07-24 draft predated both and guessed at seams that now exist with different names. Every consumed signature below is copied from code on `feat/inventory-core-and-recipes`, not from a spec.

**Goal:** Give every tenant **replenishment**: the suppliers they buy from, purchase orders with a real lifecycle (`draft → sent → partially_received → received → closed`, plus `cancelled`), receiving that turns a PO into cost-carrying inventory lots and `receive` ledger rows (supporting **partial** receipts), a PO-vs-received-vs-invoice **variance** figure, the ability to **email a rendered PO to the supplier**, and a scheduled **low-stock reorder** loop that raises notifications and optionally pre-fills a draft PO. Implements `docs/ailab/specs/2026-07-24-inventory-recipes-and-purchasing-design.md` **Part C (Suppliers & Purchasing)** and **Part D (Low-Stock Alerts & Reorder)**, decision **D5**.

**Architecture:** Purchasing is a new domain module (`src/server/purchasing/`) sitting *on top of* the inventory substrate. The **state machine is one pure module** (`status.ts`) shared by the service and its tests. Receiving is the only bridge from purchasing into inventory: `postReceipt` runs **inside one `withTenant` transaction** that, per line, converts the received qty to base UoM (`toBase`, factorKind `"purchase"`), calls Spec 8's `receiveStock` (lot + positive `receive` ledger row, `poReceiptLineId` threaded for traceability), bumps `purchase_order_lines.qty_received`, recomputes the PO status from Σ received vs Σ ordered, and emits a Spec 4 `po.received` audit event — all-or-nothing. `poNumber` reuses `placeOrder`'s serialization discipline: `pg_advisory_xact_lock(hashtext(tenantId)::bigint)` then `COALESCE(MAX(po_number),0)+1`. Send-to-supplier renders the PO to HTML (pure), writes the supplier's `notification_outbox` row directly (the supplier is **external** — `notify()`'s targets are user/role only), notifies owner+manager in-app via `notify()`, sets `sentAt`, transitions `draft → sent`, and audits `po.sent` — one tx. The reorder job computes on-hand per rule from `inventory_lots.qty_remaining` (the same projection `getLowStock` ships with) and raises debounced `low_stock` notifications, then groups triggered items by preferred supplier into pre-filled draft POs (never auto-sent).

**Tech Stack:** Next.js App Router (`AGENTS.md`: this is not the Next.js of your training data — read `node_modules/next/dist/docs/` before touching routes), Drizzle ORM + Postgres (RLS via `withTenant`), Vitest against a remote Postgres. Money stays `money(n)` numeric strings; inventory quantities are `numeric` serialized with `qty(n)` (3 dp, `src/server/inventory/uom.ts:40`). No new runtime dependencies — PO HTML is string templating; PDF attachment is deferred.

## Global Constraints

- **Branch base:** Spec 8 Part A/B lives on `feat/inventory-core-and-recipes` (unmerged). Branch Spec 9 **from that branch** (or from `main` after it merges). Tasks 4+ import `src/server/inventory/*`, which does not exist on `main`.
- **⚠️ The shipped analytics stubs pin part of this schema.** `src/server/analytics/service.ts` already contains `tableExists`-guarded queries that have **never executed** and light up the moment these tables exist — the exact mechanism that broke 9 tests when PR #116 shipped `refunds`. They dictate: `purchase_orders.total` + `.po_number` + `.supplier_id` + `.created_at`; `po_receipts.purchase_order_id`; `po_receipt_lines.po_receipt_id` + `.received_qty` + `.unit_cost`; `reorder_rules.item_id` + `.location_id` + `.reorder_point` + `.is_active` (on-hand from `inventory_lots.qty_remaining`). Task 1/7 schemas below match those names. The one deliberate divergence — invoice lives on the PO header (`invoice_total`), not per receipt line — means Task 5 must **rewrite `getReceivedVsInvoiced` in the same PR** (the PR #116 precedent: align the stub to the real schema, with tests).
- **Consumed Spec 8 surface (as built):** `receiveStock(tx, a: ReceiveArgs): Promise<{ lotId: string }>` where `ReceiveArgs = { tenantId; itemId; locationId; baseQty: number; uom: Uom; unitCost?; lotCode?; supplierId?; poReceiptLineId?; expiryAt?; receivedAt?; byUserId?; note?; ledgerType? }` (`src/server/inventory/service.ts:70-86`); `getOrCreateDefaultLocation(tx, tenantId, branchId, kind)` (`service.ts:51`); `toBase(value, fromUom, item, "purchase")`, `assertInventoryUom`, `qty(n)`, `roundQty` (`src/server/inventory/uom.ts`); `onHand(tenantId, itemId, locationId)` (`service.ts:44`). There is **no** `inventory_uom` enum — UoM columns use `unitOfMeasureEnum` from `@/server/catalog/uom` (decision T1); `assertInventoryUom` is the runtime boundary rejecting the sellable-only units (`m`/`m2`/`bf`).
- **Consumed Spec 5 surface (as built, merged):** `notify(ctx, { type, targets, channels, severity, title, body, entityType?, entityId?, branchId?, emailTemplate?, emailPayload? }, tx?)` with `NotifyTarget = { userId } | { role: "owner"|"manager"|"staff" }` (`src/server/notifications/service.ts:14-42`). The `notification_type` enum **already carries** `po_sent`, `po_received`, `low_stock`, `reorder_suggested`. There is **no `NOTIFICATIONS_ENABLED` flag** — Spec 5 is live; the 07-24 draft's flag-gating is obsolete and removed from this plan. The supplier (an external address) is reached by inserting a `notification_outbox` row directly (`toEmail`, `replyTo`, `subject`, `template`, `payload`) on the caller's tx — the same store-and-forward path, drained by the same worker. The worker's `renderTemplate` escapes everything today; its comment reserves the seam: *"Spec 9 hands in fully-rendered PO documents via the payload"* — Task 6 adds the `payload.html` passthrough.
- **Audit coverage guardrail:** the first task that emits a `po.*` event must add its file to `AUDITED_SERVICE_FILES` and **delete** the `"forward:purchase-order.*"` allowlist row (`src/server/audit/coverage.ts:144`) — the same swap PR #116 did for `forward:refund.*`. Audit context from a dashboard actor uses the `emptyFingerprint()` pattern established by `issueRefund` (`src/server/pos/refund.ts`).
- **Tenant-scoped tables are behind RLS.** Every new table is `ENABLE` + `FORCE ROW LEVEL SECURITY` with the house policy `USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)` + matching `WITH CHECK`, hand-appended to the generated migration (Drizzle emits no policies) — `drizzle/0033_curvy_tigra.sql:60-74` is the freshest exemplar. Every read/write goes through `withTenant`.
- **Migration numbering will collide at merge.** This branch and `feat/refund-and-sales-history` both add migrations; whichever merges second runs `mo-ai:fix-drizzle-migrations`. Do not hand-pick an index to avoid it.
- **The status machine is pure and singular.** Legal transitions live only in `src/server/purchasing/status.ts`; a forbidden transition throws `InvalidPoTransitionError`. `cancelled` is unreachable once any receipt exists.
- **Receiving, sending, and reorder pre-fill are transactional** — each does all its writes on **one** `withTenant` tx.
- **Money is `money(n)`; quantities are `qty(n)` numerics.** `total`, `invoice_total`, `unit_cost`, `last_unit_cost` use `money(n)`. `qty_ordered`, `qty_received`, `received_qty`, `reorder_point`, `reorder_qty` use `qty(n)` (3 dp). Sellable order-line quantities stay integer.
- **Purchasing writes require the `inventory` capability + a permission.** Services call `requireCapability(vertical, "inventory")` (`src/server/verticals/registry.ts:104`); routes assert `purchasing:manage` (POs/receiving/invoice/send) or `suppliers:manage` (supplier CRUD).
- Run `npx tsc --noEmit && npx eslint <files>` before every commit. Both must be clean.

---

## File Structure

**Database**
- Create: `src/server/purchasing/schema.ts` — `suppliers`, `supplier_items`, `purchase_orders`, `purchase_order_lines`, `po_receipts`, `po_receipt_lines`; enum `po_status`.
- Create: `src/server/purchasing/reorder-schema.ts` — `reorder_rules` (Part D).
- Modify: `src/db/schema.ts` — register both barrels.
- Create: `drizzle/00XX_*.sql` — generated, then RLS hand-appended.

**Core (pure + services)**
- Create: `src/server/purchasing/status.ts` (+ `status.test.ts`) — the pure PO state machine.
- Create: `src/server/purchasing/errors.ts` — `InvalidPoTransitionError`, `SupplierEmailMissingError`, `PoNotFoundError`.
- Create: `src/server/purchasing/suppliers.ts` (+ `suppliers.test.ts`) — supplier + supplier-item CRUD.
- Create: `src/server/purchasing/service.ts` (+ `service.test.ts`) — PO create/edit draft, `poNumber`, cancel.
- Create: `src/server/purchasing/receiving.ts` (+ `receiving.test.ts`) — `postReceipt` → lots + ledger + status.
- Create: `src/server/purchasing/variance.ts` (+ `variance.test.ts`) — three-way variance + invoice entry + close.
- Create: `src/server/purchasing/render.ts` (+ `render.test.ts`) — pure PO → HTML.
- Create: `src/server/purchasing/send.ts` (+ `send.test.ts`) — send-to-supplier.
- Create: `src/server/purchasing/reorder.ts` (+ `reorder.test.ts`) — reorder rules + scheduled check.
- Modify: `src/server/analytics/service.ts` — align `getReceivedVsInvoiced` (+ verify `getSpendBySupplier`, `getLowStock`).
- Modify: `src/server/notifications/worker.ts` — `payload.html` passthrough in `renderTemplate`.
- Modify: `src/server/audit/coverage.ts` — register purchasing files; drop `forward:purchase-order.*`.

**Authorization + routes + job**
- Modify: `src/server/rbac/permissions.ts` (+ `permissions.test.ts`) — `purchasing:manage`, `suppliers:manage`.
- Create: `src/app/dashboard/purchasing-permission.ts`.
- Create: `src/app/api/suppliers/route.ts`, `.../suppliers/[id]/route.ts`, `.../suppliers/[id]/items/route.ts`.
- Create: `src/app/api/purchase-orders/route.ts`, `.../[id]/route.ts`, `.../[id]/send/route.ts`, `.../[id]/cancel/route.ts`, `.../[id]/receipts/route.ts`, `.../[id]/invoice/route.ts`, `.../[id]/variance/route.ts`.
- Create: `src/app/api/inventory/reorder-rules/route.ts`, `.../inventory/reorder/check/route.ts`.
- Create: `src/app/dashboard/suppliers/page.tsx`, `src/app/dashboard/purchase-orders/page.tsx` (minimal read views).
- Create: `scripts/reorder-check.ts` — scheduled entry point iterating active tenants.

---

## Task 1: Schema — suppliers, purchase orders, lines, receipts

Six tables and one enum. `purchase_orders` is the aggregate root; `purchase_order_lines` its lines; `po_receipts`/`po_receipt_lines` the (possibly many) partial receipts; `suppliers`/`supplier_items` the catalog that seeds line defaults. All tenant-scoped, FORCE RLS. Column names the analytics stubs pin (see Global Constraints) are marked `— stub-pinned`.

**Files:**
- Create: `src/server/purchasing/schema.ts`
- Modify: `src/db/schema.ts`
- Create: `drizzle/00XX_*.sql` (generated, then edited)

**Interfaces:**
- Produces: tables `suppliers`, `supplierItems`, `purchaseOrders`, `purchaseOrderLines`, `poReceipts`, `poReceiptLines`; enum `poStatusEnum` (`draft | sent | partially_received | received | closed | cancelled`); types `Supplier`, `SupplierItem`, `PurchaseOrder`, `PurchaseOrderLine`, `PoReceipt`, `PoReceiptLine`.
- Consumes: `tenants`, `branches`, `users`; Spec 8 `inventoryItems`; `unitOfMeasureEnum` (`@/server/catalog/uom`).

- [ ] **Step 1: Write the schema.** Create `src/server/purchasing/schema.ts`:

```ts
import { pgTable, uuid, text, timestamp, numeric, integer, boolean, pgEnum, uniqueIndex, index } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { users } from "@/server/auth/schema";
import { unitOfMeasureEnum } from "@/server/catalog/uom"; // T1: the ONE platform UoM enum
import { inventoryItems } from "@/server/inventory/schema";

export const poStatusEnum = pgEnum("po_status", [
  "draft", "sent", "partially_received", "received", "closed", "cancelled",
]);

export const suppliers = pgTable("suppliers", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  contactName: text("contact_name"),
  email: text("email"),          // required for send-to-supplier (checked at send time, not NOT NULL)
  phone: text("phone"),
  paymentTerms: text("payment_terms"),   // "Net 30", "COD"
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("suppliers_tenant").on(t.tenantId)]);

/** Items a supplier stocks — seeds PO-line defaults + reorder supplier selection. */
export const supplierItems = pgTable("supplier_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  supplierId: uuid("supplier_id").notNull().references(() => suppliers.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => inventoryItems.id, { onDelete: "cascade" }),
  supplierSku: text("supplier_sku"),
  lastUnitCost: numeric("last_unit_cost"),      // money(n)
  packUom: unitOfMeasureEnum("pack_uom"),       // assertInventoryUom at the service boundary
}, (t) => [uniqueIndex("supplier_items_supplier_item").on(t.supplierId, t.itemId)]);

export const purchaseOrders = pgTable("purchase_orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
  supplierId: uuid("supplier_id").notNull().references(() => suppliers.id),   // stub-pinned name
  poNumber: integer("po_number").notNull(),     // stub-pinned; per-tenant sequence
  status: poStatusEnum("status").notNull().default("draft"),
  total: numeric("total").notNull().default("0"),   // stub-pinned (NOT expected_total): Σ lines, money(n)
  invoiceTotal: numeric("invoice_total"),           // supplier's actual invoice (header-level; see Task 5)
  currency: text("currency").notNull().default("EGP"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  expectedAt: timestamp("expected_at", { withTimezone: true }),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),  // stub-pinned
}, (t) => [
  uniqueIndex("purchase_orders_tenant_number").on(t.tenantId, t.poNumber),
  index("purchase_orders_tenant_status").on(t.tenantId, t.status),
]);

export const purchaseOrderLines = pgTable("purchase_order_lines", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  poId: uuid("po_id").notNull().references(() => purchaseOrders.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => inventoryItems.id),
  qtyOrdered: numeric("qty_ordered").notNull(),    // qty(n), in `uom`
  uom: unitOfMeasureEnum("uom").notNull(),
  unitCost: numeric("unit_cost").notNull(),        // money(n) per ordered UoM
  taxRate: numeric("tax_rate"),
  qtyReceived: numeric("qty_received").notNull().default("0"),  // running total across receipts, in `uom`
}, (t) => [index("purchase_order_lines_po").on(t.poId)]);

export const poReceipts = pgTable("po_receipts", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  purchaseOrderId: uuid("purchase_order_id").notNull()                       // stub-pinned name
    .references(() => purchaseOrders.id, { onDelete: "cascade" }),
  receivedByUserId: uuid("received_by_user_id").references(() => users.id),
  supplierDeliveryNote: text("supplier_delivery_note"),
  note: text("note"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("po_receipts_po").on(t.purchaseOrderId)]);

export const poReceiptLines = pgTable("po_receipt_lines", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  poReceiptId: uuid("po_receipt_id").notNull()                               // stub-pinned name
    .references(() => poReceipts.id, { onDelete: "cascade" }),
  poLineId: uuid("po_line_id").notNull().references(() => purchaseOrderLines.id),
  itemId: uuid("item_id").notNull().references(() => inventoryItems.id),
  receivedQty: numeric("received_qty").notNull(),  // stub-pinned name; this receipt, in receipt UoM
  uom: unitOfMeasureEnum("uom").notNull(),
  unitCost: numeric("unit_cost").notNull(),        // stub-pinned name
  lotCode: text("lot_code"),
  expiryAt: timestamp("expiry_at", { withTimezone: true }),
}, (t) => [index("po_receipt_lines_receipt").on(t.poReceiptId)]);

export type Supplier = typeof suppliers.$inferSelect;
export type SupplierItem = typeof supplierItems.$inferSelect;
export type PurchaseOrder = typeof purchaseOrders.$inferSelect;
export type PurchaseOrderLine = typeof purchaseOrderLines.$inferSelect;
export type PoReceipt = typeof poReceipts.$inferSelect;
export type PoReceiptLine = typeof poReceiptLines.$inferSelect;
```

- [ ] **Step 2: Register it.** Append to `src/db/schema.ts` after the `../server/inventory/schema` line:

```ts
export * from "../server/purchasing/schema";
```

- [ ] **Step 3: Generate the migration.**

```bash
npm run db:generate
```

Expected: a new `drizzle/00XX_*.sql` creating enum `po_status`, the six tables, FKs, and indexes. It will **not** contain RLS.

- [ ] **Step 4: Hand-append RLS.** Append one block per table, mirroring `drizzle/0033_curvy_tigra.sql:60-74`:

```sql
--> statement-breakpoint
ALTER TABLE "suppliers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "suppliers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY suppliers_isolation ON "suppliers"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- …repeat verbatim for supplier_items, purchase_orders, purchase_order_lines, po_receipts, po_receipt_lines
```

- [ ] **Step 5: Apply and run the FULL suite — this is the stub-light-up checkpoint.**

```bash
npm run db:migrate:test && npm test
```

Expected: migration applies. **`getSpendBySupplier`'s `tableExists("purchase_orders")` guard now passes** — its query must run green against the empty tables (it does if Step 1's stub-pinned names are exact). `getReceivedVsInvoiced` still returns `[]` (guarded on `po_receipts`, whose query joins nothing yet — but its `SUM(prl.invoiced_amount)` references a column this schema deliberately does not have; that query is rewritten in Task 5 **before** any receipt rows can exist, so it cannot break in between: it returns `[]` on zero joined rows). If anything fails here, fix the schema, not the report.

- [ ] **Step 6: Commit.**

```bash
git add src/server/purchasing/schema.ts src/db/schema.ts drizzle/
git commit -m "feat(purchasing): suppliers, purchase_orders, lines, receipts schema + FORCE RLS"
```

---

## Task 2: Permissions — `purchasing:manage` + `suppliers:manage`

Per the roadmap's canonical mapping: **owner + manager** hold both; **staff** neither.

**Files:**
- Modify: `src/server/rbac/permissions.ts`
- Test: `src/server/rbac/permissions.test.ts`

- [ ] **Step 1: Write the failing test.** Append to `src/server/rbac/permissions.test.ts`:

```ts
describe("purchasing permissions", () => {
  it("purchasing:manage + suppliers:manage held by owner and manager", () => {
    for (const p of ["purchasing:manage", "suppliers:manage"] as const) {
      expect(ROLE_PERMISSIONS.owner).toContain(p);
      expect(ROLE_PERMISSIONS.manager).toContain(p);
    }
  });
  it("staff holds neither", () => {
    expect(ROLE_PERMISSIONS.staff).not.toContain("purchasing:manage");
    expect(ROLE_PERMISSIONS.staff).not.toContain("suppliers:manage");
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `npx vitest run src/server/rbac/permissions.test.ts` → FAIL.

- [ ] **Step 3: Implement.** Add `"purchasing:manage"` and `"suppliers:manage"` to the `PERMISSIONS` array and to `owner` + `manager` in `ROLE_PERMISSIONS`. Leave `staff` unchanged.

- [ ] **Step 4: Run to verify it passes.** `npx vitest run src/server/rbac/permissions.test.ts && npx tsc --noEmit` → PASS, clean.

- [ ] **Step 5: Commit.**

```bash
git add src/server/rbac/permissions.ts src/server/rbac/permissions.test.ts
git commit -m "feat(purchasing): purchasing:manage + suppliers:manage permissions (owner + manager)"
```

---

## Task 3: PO state machine + supplier/PO drafting service

The pure state machine first, then the services that use it. `poNumber` reuses `placeOrder`'s per-tenant advisory lock. Drafting is edit-in-place while `status='draft'`; once `sent`, lines are frozen (only receiving and invoice mutate a sent PO). This task emits the first `po.*` audit events, so it also swaps the audit guardrail's forward reference for real coverage.

**Files:**
- Create: `src/server/purchasing/status.ts` (+ `status.test.ts`), `src/server/purchasing/errors.ts`
- Create: `src/server/purchasing/suppliers.ts` (+ `suppliers.test.ts`)
- Create: `src/server/purchasing/service.ts` (+ `service.test.ts`)
- Modify: `src/server/audit/coverage.ts`

**Interfaces:**
- Produces:
  - `type PoStatus = "draft" | "sent" | "partially_received" | "received" | "closed" | "cancelled"`
  - `PO_TRANSITIONS: Record<PoStatus, PoStatus[]>`; `canTransition(from, to): boolean`; `assertTransition(from, to): void`; `receiptStatus(lines): "sent" | "partially_received" | "received"`.
  - `errors.ts`: `InvalidPoTransitionError`, `SupplierEmailMissingError`, `PoNotFoundError`.
  - `type PurchasingActor = { tenantId: string; branchId: string; actorUserId: string; vertical: VerticalId }` — the ctx every service takes (audit via `emptyFingerprint()`, the `issueRefund` pattern).
  - `createSupplier`, `updateSupplier`, `upsertSupplierItem`, `listSuppliers`.
  - `createDraftPo(actor, input): Promise<{ poId: string; poNumber: number }>` with `input = { supplierId; branchId; expectedAt?; lines: { itemId; qtyOrdered: number; uom: Uom; unitCost: number; taxRate?: number }[] }`; `updateDraftPo(actor, poId, input)`; `getPurchaseOrder(tenantId, poId)`; `cancelPurchaseOrder(actor, poId)`.
- Consumes: `withTenant`, `money` (`@/server/ordering/service`), `qty` + `assertInventoryUom` (`@/server/inventory/uom`), `requireCapability` (`@/server/verticals/registry`), `recordAuditEvent` + `emptyFingerprint` (`@/server/audit/*`).

- [ ] **Step 1: Write the failing state-machine test.** Create `src/server/purchasing/status.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { canTransition, assertTransition, receiptStatus } from "./status";
import { InvalidPoTransitionError } from "./errors";

describe("PO state machine", () => {
  it("allows the happy path", () => {
    expect(canTransition("draft", "sent")).toBe(true);
    expect(canTransition("sent", "partially_received")).toBe(true);
    expect(canTransition("sent", "received")).toBe(true);
    expect(canTransition("partially_received", "received")).toBe(true);
    expect(canTransition("received", "closed")).toBe(true);
  });
  it("allows cancel only from draft/sent", () => {
    expect(canTransition("draft", "cancelled")).toBe(true);
    expect(canTransition("sent", "cancelled")).toBe(true);
    expect(canTransition("partially_received", "cancelled")).toBe(false);
    expect(canTransition("received", "cancelled")).toBe(false);
  });
  it("forbids illegal jumps and re-opening terminals", () => {
    expect(canTransition("draft", "received")).toBe(false);
    expect(canTransition("received", "draft")).toBe(false);
    expect(canTransition("cancelled", "sent")).toBe(false);
    expect(canTransition("closed", "received")).toBe(false);
  });
  it("assertTransition throws on an illegal move", () => {
    expect(() => assertTransition("received", "cancelled")).toThrow(InvalidPoTransitionError);
  });
  it("receiptStatus derives from ordered vs received", () => {
    expect(receiptStatus([{ qtyOrdered: "10", qtyReceived: "0" }])).toBe("sent");
    expect(receiptStatus([{ qtyOrdered: "10", qtyReceived: "4" }])).toBe("partially_received");
    expect(receiptStatus([{ qtyOrdered: "10", qtyReceived: "10" }])).toBe("received");
    expect(receiptStatus([{ qtyOrdered: "10", qtyReceived: "12" }])).toBe("received"); // over-receipt
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `npx vitest run src/server/purchasing/status.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement.** Create `src/server/purchasing/errors.ts`:

```ts
import type { PoStatus } from "./status";

export class InvalidPoTransitionError extends Error {
  constructor(public from: PoStatus, public to: PoStatus) {
    super(`Illegal PO transition ${from} → ${to}`);
    this.name = "InvalidPoTransitionError";
  }
}
export class SupplierEmailMissingError extends Error {
  constructor(supplierId: string) {
    super(`Supplier ${supplierId} has no email — add one before sending`);
    this.name = "SupplierEmailMissingError";
  }
}
export class PoNotFoundError extends Error {
  constructor() { super("Purchase order not found"); this.name = "PoNotFoundError"; }
}
```

Create `src/server/purchasing/status.ts`:

```ts
import { InvalidPoTransitionError } from "./errors";

export type PoStatus = "draft" | "sent" | "partially_received" | "received" | "closed" | "cancelled";

/** The ONLY definition of legal PO transitions. `cancelled` is unreachable once
 *  any receipt exists (receiving only ever advances toward received). Terminals
 *  (closed, cancelled) have no outgoing edges. */
export const PO_TRANSITIONS: Record<PoStatus, PoStatus[]> = {
  draft: ["sent", "cancelled"],
  sent: ["partially_received", "received", "cancelled"],
  partially_received: ["partially_received", "received"],
  received: ["closed"],
  closed: [],
  cancelled: [],
};

export function canTransition(from: PoStatus, to: PoStatus): boolean {
  return PO_TRANSITIONS[from].includes(to);
}
export function assertTransition(from: PoStatus, to: PoStatus): void {
  if (!canTransition(from, to)) throw new InvalidPoTransitionError(from, to);
}

/** Derive the received-state from ordered vs received totals across all lines. */
export function receiptStatus(lines: { qtyOrdered: string; qtyReceived: string }[]): "sent" | "partially_received" | "received" {
  const anyReceived = lines.some((l) => Number(l.qtyReceived) > 0);
  const allMet = lines.every((l) => Number(l.qtyReceived) >= Number(l.qtyOrdered));
  if (allMet) return "received";
  return anyReceived ? "partially_received" : "sent";
}
```

- [ ] **Step 4: Write the failing supplier + drafting tests.** Create `src/server/purchasing/suppliers.test.ts` and `src/server/purchasing/service.test.ts`. Seed via Spec 8's `src/server/inventory/test-helpers.ts` (tenant + branch + inventory items). Assert:
  - `createSupplier` persists; `upsertSupplierItem` is unique per `(supplierId, itemId)` (second upsert updates `lastUnitCost`, no duplicate row); tenant B never sees tenant A's suppliers (RLS).
  - `createDraftPo` assigns `poNumber` 1 then 2 for the same tenant, sets `status='draft'`, computes `total = money(Σ qtyOrdered × unitCost)`, persists lines with `qtyReceived='0'`, and rejects a non-inventory UoM (`assertInventoryUom` throws on e.g. `"m"`).
  - `updateDraftPo` replaces lines and recomputes `total` while `draft`; editing a `sent` PO throws `InvalidPoTransitionError`.
  - `cancelPurchaseOrder` moves `draft`/`sent` → `cancelled` and writes a `po.cancelled` audit event; cancelling a `partially_received` PO throws.
  - Two concurrent `createDraftPo` calls yield `poNumber` 1 and 2, never a duplicate (the advisory-lock test — mirror the order-number test in `src/server/ordering/place-order.test.ts`).
  - A `po.created` audit event exists after `createDraftPo`, and `verifyChain(tenantId)` stays ok.

- [ ] **Step 5: Run to verify they fail.** `npx vitest run src/server/purchasing/suppliers.test.ts src/server/purchasing/service.test.ts` → FAIL.

- [ ] **Step 6: Implement the services.** `src/server/purchasing/suppliers.ts`: thin `withTenant` CRUD; `upsertSupplierItem` uses `.onConflictDoUpdate` targeting the `(supplierId, itemId)` unique index. `src/server/purchasing/service.ts`:

```ts
// createDraftPo(actor, input): withTenant(actor.tenantId, async (tx) => {
//   requireCapability(actor.vertical, "inventory");
//   for (const l of input.lines) assertInventoryUom(l.uom);
//   await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${actor.tenantId})::bigint)`);
//   const [{ max }] = await tx.select({ max: sql<number>`COALESCE(MAX(${purchaseOrders.poNumber}), 0)` })
//     .from(purchaseOrders);                       // RLS scopes to tenant
//   const total = money(input.lines.reduce((s, l) => s + l.qtyOrdered * l.unitCost, 0));
//   insert purchase_orders { poNumber: max + 1, status: "draft", total, ... } + lines (qty(n) strings);
//   await recordAuditEvent(
//     { tenantId: actor.tenantId, branchId: actor.branchId, actorUserId: actor.actorUserId, fingerprint: emptyFingerprint() },
//     { action: "po.created", entityType: "purchase_order", entityId: poId,
//       summary: `PO #${poNumber} drafted`, metadata: { supplierId: input.supplierId, total, lineCount: input.lines.length } },
//     tx);
//   return { poId, poNumber };
// })
// updateDraftPo: load PO; if (po.status !== "draft") throw new InvalidPoTransitionError(po.status, "draft");
//   delete + reinsert lines; recompute total; audit "po.updated".
// cancelPurchaseOrder: load PO; assertTransition(po.status, "cancelled");
//   update status='cancelled'; audit "po.cancelled".
```

- [ ] **Step 7: Register audit coverage.** In `src/server/audit/coverage.ts`: add `"src/server/purchasing/service.ts"` (and, pre-emptively for Tasks 4–6, `"src/server/purchasing/receiving.ts"`, `"src/server/purchasing/variance.ts"`, `"src/server/purchasing/send.ts"`) to `AUDITED_SERVICE_FILES`; **delete** the `"forward:purchase-order.*"` row from `AUDIT_ALLOWLIST`; allowlist the intentionally-silent helpers (`"suppliers.createSupplier"`-style rows) only if the guardrail flags them — supplier CRUD emits `supplier.created` / `supplier.updated`, so it should not need one.

- [ ] **Step 8: Run to verify everything passes.** `npx vitest run src/server/purchasing src/server/audit && npx tsc --noEmit` → PASS (guardrail included).

- [ ] **Step 9: Commit.**

```bash
git add src/server/purchasing src/server/audit/coverage.ts
git commit -m "feat(purchasing): pure PO state machine + supplier CRUD + draft PO create/edit/cancel, audit-covered"
```

---

## Task 4: Receiving — post a receipt → lots + `receive` ledger rows

The bridge into inventory. `postReceipt` records one (partial) receipt: per line it converts the received qty to base UoM, calls Spec 8's `receiveStock` (lot + positive `receive` ledger row) at the branch's receiving location, bumps `purchase_order_lines.qty_received`, then recomputes and advances the PO status. Over-receipt beyond ordered qty is **allowed** (flagged in variance). All in one tx; emits `po.received`.

**Files:**
- Create: `src/server/purchasing/receiving.ts`
- Test: `src/server/purchasing/receiving.test.ts`

**Interfaces:**
- Produces: `postReceipt(actor, poId, input): Promise<{ receiptId: string; status: PoStatus }>` with `input = { supplierDeliveryNote?; note?; lines: { poLineId: string; receivedQty: number; uom: Uom; unitCost: number; lotCode?: string; expiryAt?: Date }[] }`.
- Consumes — **exact as-built Spec 8 signatures**:
  - `receiveStock(tx, { tenantId, itemId, locationId, baseQty, uom, unitCost, lotCode, supplierId, poReceiptLineId, expiryAt, receivedAt, byUserId })` (`src/server/inventory/service.ts:86`) — creates lot + ledger row; **emits no audit event of its own** (its doc comment assigns that to this caller).
  - `getOrCreateDefaultLocation(tx, tenantId, branchId, "back_of_house")` (`service.ts:51`) — the receiving location, lazily provisioned.
  - `toBase(l.receivedQty, l.uom, item, "purchase")` (`uom.ts:54`) — the item's own `purchaseToBase` factor wins ("24-can case").
  - `receiptStatus`, `assertTransition` (Task 3); `recordAuditEvent` (Spec 4).

- [ ] **Step 1: Write the failing tests.** Create `src/server/purchasing/receiving.test.ts`. Seed a `sent` PO with one line, `qtyOrdered=10`, on an item whose `purchaseToBase` is 1. Assert:
  - **Partial receipt** of 4 creates one `inventory_lots` row (`qtyRemaining` 4.000 base) + one `receive` `stock_ledger` row (positive, `lot.poReceiptLineId` = the new receipt line's id), bumps the line's `qtyReceived` to 4, and moves the PO to `partially_received`.
  - A **second receipt** of 6 brings the line to 10 and the PO to `received`; two lots exist.
  - **UoM conversion**: an item with `purchaseToBase = 24` (case → each) receiving 2 cases creates a lot of 48 base units.
  - **Over-receipt** (receive 12 of 10) is accepted; PO reaches `received`.
  - Receiving against a `draft` or `cancelled` PO throws `InvalidPoTransitionError`; unknown `poLineId` throws.
  - **Atomicity**: force the second line's `receiveStock` to fail (e.g. an invalid sellable-only UoM on line 2 → `assertInventoryUom` throws) and assert no lot, no receipt row, and no `qtyReceived` bump from line 1 survive.
  - One `po.received` audit event per receipt, `verifyChain` ok.

- [ ] **Step 2: Run to verify they fail.** `npx vitest run src/server/purchasing/receiving.test.ts` → FAIL.

- [ ] **Step 3: Implement.** Create `src/server/purchasing/receiving.ts`:

```ts
// postReceipt(actor, poId, input): withTenant(actor.tenantId, async (tx) => {
//   requireCapability(actor.vertical, "inventory");
//   const po = load purchase_orders by id; if (!po) throw new PoNotFoundError();
//   if (po.status !== "sent" && po.status !== "partially_received")
//     throw new InvalidPoTransitionError(po.status, "partially_received");
//   const location = await getOrCreateDefaultLocation(tx, actor.tenantId, po.branchId, "back_of_house");
//   const [receipt] = await tx.insert(poReceipts).values({
//     tenantId, purchaseOrderId: poId, receivedByUserId: actor.actorUserId,
//     supplierDeliveryNote, note }).returning();
//   const poLines = await tx.select()...where(eq(purchaseOrderLines.poId, poId));
//   for (const l of input.lines) {
//     const poLine = poLines.find((x) => x.id === l.poLineId); if (!poLine) throw PoNotFoundError;
//     const item = await tx.select()...from(inventoryItems).where(eq(inventoryItems.id, poLine.itemId));
//     const [receiptLine] = await tx.insert(poReceiptLines).values({
//       tenantId, poReceiptId: receipt.id, poLineId: l.poLineId, itemId: poLine.itemId,
//       receivedQty: qty(l.receivedQty), uom: l.uom, unitCost: money(l.unitCost),
//       lotCode: l.lotCode ?? null, expiryAt: l.expiryAt ?? null }).returning();
//     const baseQty = toBase(l.receivedQty, assertInventoryUom(l.uom), item, "purchase");
//     await receiveStock(tx, {
//       tenantId: actor.tenantId, itemId: poLine.itemId, locationId: location.id,
//       baseQty, uom: item.baseUom, unitCost: money(l.unitCost),
//       lotCode: l.lotCode ?? null, supplierId: po.supplierId, poReceiptLineId: receiptLine.id,
//       expiryAt: l.expiryAt ?? null, receivedAt: receipt.receivedAt, byUserId: actor.actorUserId });
//     await tx.update(purchaseOrderLines)
//       .set({ qtyReceived: qty(Number(poLine.qtyReceived) + l.receivedQty) })
//       .where(eq(purchaseOrderLines.id, l.poLineId));
//   }
//   const fresh = re-select lines; const next = receiptStatus(fresh);
//   if (next !== po.status) { assertTransition(po.status, next);
//     await tx.update(purchaseOrders).set({ status: next }).where(eq(purchaseOrders.id, poId)); }
//   await recordAuditEvent({ ...actor ctx, fingerprint: emptyFingerprint() },
//     { action: "po.received", entityType: "purchase_order", entityId: poId,
//       summary: `Receipt on PO #${po.poNumber}`,
//       metadata: { receiptId: receipt.id, lineCount: input.lines.length, status: next } }, tx);
//   return { receiptId: receipt.id, status: next };
// })
```

- [ ] **Step 4: Run to verify they pass.** `npx vitest run src/server/purchasing/receiving.test.ts && npx tsc --noEmit` → PASS. The atomicity test proves the single-tx guarantee; the case-conversion test proves the `"purchase"` factor path.

- [ ] **Step 5: Commit.**

```bash
git add src/server/purchasing/receiving.ts src/server/purchasing/receiving.test.ts
git commit -m "feat(purchasing): receiving — lots + receive ledger rows via Spec 8 writer, partial receipts, status advance"
```

---

## Task 5: Variance — PO vs received vs invoice, and the analytics stub alignment

Three money figures per PO and their pairwise deltas: `total` (ordered), `receivedTotal` (Σ receipt-line `received_qty × unit_cost`), `invoiceTotal` (billed, header-level). `enterInvoiceTotal` records the supplier's figure; `closePurchaseOrder` moves a `received` PO to `closed`. **This task also rewrites `getReceivedVsInvoiced`** — the shipped stub sums a per-line `invoiced_amount` column this schema deliberately does not have (invoice entry is one header figure, matching the design's "enter the supplier's invoice total"). Same-PR alignment is the PR #116 precedent.

**Files:**
- Create: `src/server/purchasing/variance.ts` (+ `variance.test.ts`)
- Modify: `src/server/analytics/service.ts` (`getReceivedVsInvoiced`)
- Modify: `src/server/analytics/reports.test.ts`

**Interfaces:**
- Produces:
  - `type PoVariance = { total: string; receivedTotal: string; invoiceTotal: string | null; receivedVsOrdered: string; invoiceVsReceived: string | null; overReceived: boolean }`
  - `getPoVariance(tenantId, poId): Promise<PoVariance>`
  - `enterInvoiceTotal(actor, poId, invoiceTotal: number): Promise<void>` — audits `po.invoiced`.
  - `closePurchaseOrder(actor, poId): Promise<void>` — `assertTransition(status, "closed")`, audits `po.closed`.

- [ ] **Step 1: Write the failing variance tests.** Create `src/server/purchasing/variance.test.ts`. On a PO ordered at 100.00, received worth 90.00, invoiced 95.00: `receivedVsOrdered = "-10.00"`, `invoiceVsReceived = "5.00"`. Over-receipt (received 110.00): `overReceived === true`, `receivedVsOrdered = "10.00"`. `invoiceTotal` null before entry → `invoiceVsReceived` null. `closePurchaseOrder` on a `received` PO → `closed`; on a `sent` PO → throws.

- [ ] **Step 2: Run to verify they fail.** `npx vitest run src/server/purchasing/variance.test.ts` → FAIL.

- [ ] **Step 3: Implement `variance.ts`.** Sum receipt lines in `Number`, re-serialize with `money()`. `receivedTotal = Σ received_qty × unit_cost` across the PO's receipt lines; `overReceived = any line with qtyReceived > qtyOrdered`.

- [ ] **Step 4: Align the analytics stub.** In `src/server/analytics/service.ts`, rewrite `getReceivedVsInvoiced`'s SQL to the real schema:

```sql
SELECT po.id AS po_id, po.po_number,
       COALESCE(po.total, 0) AS ordered,
       COALESCE(SUM(prl.received_qty * prl.unit_cost), 0) AS received,
       COALESCE(po.invoice_total, 0) AS invoiced
FROM purchase_orders po
JOIN po_receipts pr ON pr.purchase_order_id = po.id
JOIN po_receipt_lines prl ON prl.po_receipt_id = pr.id
WHERE po.created_at >= ${since}
GROUP BY po.id, po.po_number, po.invoice_total
ORDER BY MAX(po.created_at) DESC
```

Also update `getSpendBySupplier` to exclude dead POs — append `WHERE po.created_at >= ${since} AND po.status != 'cancelled'` — and extend `src/server/analytics/reports.test.ts`: seed one received+invoiced PO through the real Task 3/4/5 services and assert `getSpendBySupplier`, `getReceivedVsInvoiced`, and (still-empty) `getLowStock` return correct rows — these queries have **never run against real tables** until now.

- [ ] **Step 5: Run to verify everything passes.** `npx vitest run src/server/purchasing/variance.test.ts src/server/analytics/reports.test.ts && npx tsc --noEmit` → PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/server/purchasing/variance.ts src/server/purchasing/variance.test.ts src/server/analytics/service.ts src/server/analytics/reports.test.ts
git commit -m "feat(purchasing): three-way PO variance + invoice entry + close; align the guarded analytics stubs to the real schema"
```

---

## Task 6: Send-to-supplier — render, email, audit, `sentAt`

Render the PO to HTML (pure, testable), queue it to the supplier, set `sentAt`, transition `draft → sent`, emit `po.sent` — one tx. The supplier is an **external** address: `notify()`'s `NotifyTarget` is `{ userId } | { role }` only (`src/server/notifications/service.ts:14`), so the supplier email is a **direct `notification_outbox` insert** on the same tx (`toEmail`, `subject`, `template: "po_sent"`, `payload: { html }`); owner + manager get a normal `notify()` (`type: "po_sent"`, in-app). The outbox worker's `renderTemplate` currently escapes everything — its own comment reserves this seam ("Spec 9 hands in fully-rendered PO documents via the payload"), so this task adds the `payload.html` passthrough.

**Files:**
- Create: `src/server/purchasing/render.ts` (+ `render.test.ts`)
- Create: `src/server/purchasing/send.ts` (+ `send.test.ts`)
- Modify: `src/server/notifications/worker.ts` (`renderTemplate`)
- Modify: `src/server/notifications/worker.test.ts`

**Interfaces:**
- Produces:
  - `renderPurchaseOrderHtml(po, lines, itemNames, supplier, branch, tenant): string` (pure; `itemNames: Map<string, string>` from `inventory_items.nameEn`).
  - `sendPurchaseOrder(actor, poId): Promise<void>`.
- Consumes: `notify` (Spec 5, tx-threaded); `notificationOutbox` (`@/server/notifications/schema`); branch `replyToEmail` → tenant `contactEmail` fallback (mirror `resolveReplyTo`, `service.ts` bottom); `assertTransition` (Task 3); `recordAuditEvent` (Spec 4).

- [ ] **Step 1: Write the failing render test.** `src/server/purchasing/render.test.ts`: the HTML contains the PO number, supplier name, each line's item name + qty + uom + unit cost, the `total`, and the delivery branch name; interpolated text is HTML-escaped (`<script>` in a supplier name comes out as `&lt;script&gt;`); the output has no external asset URLs.

- [ ] **Step 2: Write the failing worker passthrough test.** Append to `src/server/notifications/worker.test.ts`: an outbox row whose `payload.html` is a full document is sent with exactly that HTML (not the key-value shell); a row without `payload.html` still renders the shell.

- [ ] **Step 3: Write the failing send tests.** `src/server/purchasing/send.test.ts`: `sendPurchaseOrder`
  - throws `SupplierEmailMissingError` when `supplier.email` is null — PO stays `draft`, no outbox row;
  - on success inserts **one** `notification_outbox` row (`toEmail = supplier.email`, `template = "po_sent"`, `subject` containing the PO number, `payload.html` = the rendered document, `replyTo` = branch `replyToEmail` when set);
  - calls `notify` once for `[{ role: "owner" }, { role: "manager" }]`, channels `["in_app"]`, `type: "po_sent"`, `entityType: "purchase_order"`, `entityId: poId`;
  - sets `sentAt` and `status='sent'`; emits one `po.sent` audit event;
  - is **re-sendable** from `sent`: a second call inserts a second outbox row, refreshes `sentAt`, audits a distinct `po.sent`;
  - throws `InvalidPoTransitionError` from `received`/`cancelled`/`closed`.

- [ ] **Step 4: Run to verify they fail.** `npx vitest run src/server/purchasing/render.test.ts src/server/purchasing/send.test.ts src/server/notifications/worker.test.ts` → FAIL.

- [ ] **Step 5: Implement.** `render.ts`: a template literal building the header block + an HTML `<table>` of lines + totals; every interpolation goes through a local `escapeHtml` (copy the four-entity one from `worker.ts:138`). `worker.ts`: at the top of `renderTemplate`, `if (typeof payload.html === "string") return payload.html;`. `send.ts`:

```ts
// sendPurchaseOrder(actor, poId): withTenant(actor.tenantId, async (tx) => {
//   requireCapability(actor.vertical, "inventory");
//   load po + lines + supplier + branch + tenant + item names; if (!po) throw PoNotFoundError;
//   if (!supplier.email) throw new SupplierEmailMissingError(supplier.id);
//   if (po.status !== "sent") assertTransition(po.status, "sent");   // fresh send needs draft→sent; re-send is a no-op transition
//   const html = renderPurchaseOrderHtml(po, lines, itemNames, supplier, branch, tenant);
//   await tx.insert(notificationOutbox).values({
//     tenantId: actor.tenantId, toEmail: supplier.email,
//     replyTo: branch.replyToEmail ?? tenant.contactEmail ?? null,
//     subject: `Purchase Order #${po.poNumber} — ${tenant.name}`,
//     template: "po_sent", payload: { html } });
//   await notify({ tenantId: actor.tenantId }, {
//     type: "po_sent", severity: "info",
//     title: `PO #${po.poNumber} sent to ${supplier.name}`,
//     body: `${lines.length} lines, total ${po.total} ${po.currency}`,
//     targets: [{ role: "owner" }, { role: "manager" }], channels: ["in_app"],
//     entityType: "purchase_order", entityId: poId, branchId: po.branchId }, tx);
//   await tx.update(purchaseOrders).set({ status: "sent", sentAt: new Date() }).where(eq(purchaseOrders.id, poId));
//   await recordAuditEvent({ ...actor ctx, fingerprint: emptyFingerprint() },
//     { action: "po.sent", entityType: "purchase_order", entityId: poId,
//       summary: `PO #${po.poNumber} sent to ${supplier.name}`,
//       metadata: { supplierId: supplier.id, to: supplier.email } }, tx);
// })
```

- [ ] **Step 6: Run to verify they pass.** `npx vitest run src/server/purchasing/render.test.ts src/server/purchasing/send.test.ts src/server/notifications/worker.test.ts && npx tsc --noEmit` → PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/server/purchasing/render.ts src/server/purchasing/render.test.ts src/server/purchasing/send.ts src/server/purchasing/send.test.ts src/server/notifications/worker.ts src/server/notifications/worker.test.ts
git commit -m "feat(purchasing): send-to-supplier — rendered PO via outbox (payload.html passthrough), in-app notify, po.sent audit"
```

---

## Task 7: Low-stock alerts & reorder

`reorder_rules` (per item per location — **the exact table `getLowStock` has been waiting to query**, `src/server/analytics/service.ts:481`) plus the scheduled check: compute on-hand per active rule from `inventory_lots.qty_remaining` (the same projection `getLowStock` uses — ledger-sum and lot-sum agree by construction; lots include expired stock, a known Spec 8 caveat recorded in its follow-up doc), raise a **debounced** `low_stock` notification per triggered item, and pre-fill one `draft` PO per preferred supplier. Never auto-send.

**Files:**
- Create: `src/server/purchasing/reorder-schema.ts` (+ migration)
- Create: `src/server/purchasing/reorder.ts` (+ `reorder.test.ts`)
- Create: `scripts/reorder-check.ts`
- Modify: `src/server/analytics/reports.test.ts` (light up the `getLowStock` assertion)

**Interfaces:**
- Produces:
  - table `reorderRules` — columns `item_id`, `location_id`, `reorder_point`, `reorder_qty`, `preferred_supplier_id?`, `last_alerted_at?`, `is_active` (names `getLowStock` pins); unique `(itemId, locationId)`.
  - `upsertReorderRule(actor, input)`, `listReorderRules(tenantId)`.
  - `checkReorder(actor): Promise<{ triggered: number; draftsCreated: number }>`.
- Consumes: `notify` (`type: "low_stock"`, already in the enum); `createDraftPo` (Task 3); `supplierItems.lastUnitCost` (Task 1); `getLowStock` (`@/server/analytics/service`) as the read-side twin.

- [ ] **Step 1: Write the reorder-rules schema.** Create `src/server/purchasing/reorder-schema.ts`:

```ts
import { pgTable, uuid, numeric, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";
import { inventoryItems, storageLocations } from "@/server/inventory/schema";
import { suppliers } from "./schema";

export const reorderRules = pgTable("reorder_rules", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => inventoryItems.id, { onDelete: "cascade" }),
  locationId: uuid("location_id").notNull().references(() => storageLocations.id, { onDelete: "cascade" }),
  reorderPoint: numeric("reorder_point").notNull(),   // base UoM, qty(n)
  reorderQty: numeric("reorder_qty").notNull(),       // base UoM, qty(n)
  preferredSupplierId: uuid("preferred_supplier_id").references(() => suppliers.id),
  lastAlertedAt: timestamp("last_alerted_at", { withTimezone: true }),  // debounce clock
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("reorder_rules_item_location").on(t.itemId, t.locationId)]);

export type ReorderRule = typeof reorderRules.$inferSelect;
```

Register in `src/db/schema.ts`; `npm run db:generate`; hand-append the RLS block; `npm run db:migrate:test && npm test` — **`getLowStock`'s guard now passes; its never-executed query must run green.**

- [ ] **Step 2: Write the failing tests.** Create `src/server/purchasing/reorder.test.ts`. Seed items with lots (Spec 8 `receiveStock` via its test-helpers), rules, and a preferred supplier with `supplier_items.lastUnitCost`. Assert `checkReorder`:
  - notifies exactly once (`type: "low_stock"`, targets owner+manager, channels `["in_app","email"]`, severity `"warning"`) per item **at or below** its point; nothing above; an item with a rule and zero lots triggers (on-hand 0).
  - is **debounced**: a second run within 24h of `lastAlertedAt` does not re-notify; after clearing `lastAlertedAt` it does.
  - pre-fills one `draft` PO per preferred supplier grouping that supplier's triggered items at `reorderQty` × `lastUnitCost` (fallback `unitCost: 0` when no supplier item exists); the PO is `draft`, never `sent`; rules without a `preferredSupplierId` notify but join no PO.
  - returns accurate `{ triggered, draftsCreated }`, and `getLowStock(tenantId)` returns the same triggered item set (read/write twins agree).

- [ ] **Step 3: Run to verify they fail.** `npx vitest run src/server/purchasing/reorder.test.ts` → FAIL.

- [ ] **Step 4: Implement.** Create `src/server/purchasing/reorder.ts`:

```ts
// checkReorder(actor): withTenant(actor.tenantId, async (tx) => {
//   const rules = await tx.select().from(reorderRules).where(eq(reorderRules.isActive, true));
//   const triggered: ReorderRule[] = [];
//   for (const r of rules) {
//     const [{ sum }] = await tx.select({ sum: sql<string>`COALESCE(SUM(${inventoryLots.qtyRemaining}), 0)` })
//       .from(inventoryLots)
//       .where(and(eq(inventoryLots.itemId, r.itemId), eq(inventoryLots.locationId, r.locationId)));
//     if (Number(sum) > Number(r.reorderPoint)) continue;
//     triggered.push(r);
//     const debounced = r.lastAlertedAt && Date.now() - r.lastAlertedAt.getTime() < 24 * 3600_000;
//     if (!debounced) {
//       await notify({ tenantId: actor.tenantId }, {
//         type: "low_stock", severity: "warning",
//         title: `Low stock`, body: `on hand ${sum} ≤ reorder point ${r.reorderPoint}`,
//         targets: [{ role: "owner" }, { role: "manager" }], channels: ["in_app", "email"],
//         entityType: "inventory_item", entityId: r.itemId }, tx);
//       await tx.update(reorderRules).set({ lastAlertedAt: new Date() }).where(eq(reorderRules.id, r.id));
//     }
//   }
//   // group triggered by preferredSupplierId (skip null) → one createDraftPo per supplier,
//   // lines at reorderQty (item baseUom) and supplier_items.lastUnitCost ?? 0.
//   return { triggered: triggered.length, draftsCreated };
// })
```

`upsertReorderRule` audits `reorder_rule.updated` (coverage guardrail: add `reorder.ts` to `AUDITED_SERVICE_FILES`; `checkReorder` itself is system-actor read-mostly — allowlist `"reorder.checkReorder"` with the reason "draft POs it creates audit po.created via createDraftPo; alerts are notifications, not mutations of record").

- [ ] **Step 5: Wire the scheduled entry point.** Create `scripts/reorder-check.ts` — iterate active tenants, build a system `PurchasingActor` per tenant, call `checkReorder`, log a one-line summary per tenant. This is the cron body; `POST /api/inventory/reorder/check` (Task 8) is the manual trigger over the same function.

- [ ] **Step 6: Run to verify everything passes.** `npx vitest run src/server/purchasing/reorder.test.ts src/server/analytics/reports.test.ts && npx tsc --noEmit` → PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/server/purchasing/reorder-schema.ts src/server/purchasing/reorder.ts src/server/purchasing/reorder.test.ts scripts/reorder-check.ts src/db/schema.ts src/server/audit/coverage.ts drizzle/ src/server/analytics/reports.test.ts
git commit -m "feat(purchasing): reorder_rules + scheduled low-stock check — debounced notify, pre-filled draft POs, getLowStock lit up"
```

---

## Task 8: Dashboard routes + minimal views

Reads resolve the tenant from the web session, assert the permission, and query through `withTenant`. Writes go through the Task 3–7 services. **No route writes inventory or audit rows directly.** Per `AGENTS.md`, read `node_modules/next/dist/docs/` route-handler docs first.

**Files:**
- Create: `src/app/dashboard/purchasing-permission.ts`
- Create: the `src/app/api/suppliers/*`, `src/app/api/purchase-orders/*`, `src/app/api/inventory/reorder-rules`, `src/app/api/inventory/reorder/check` routes.
- Create: `src/app/dashboard/suppliers/page.tsx`, `src/app/dashboard/purchase-orders/page.tsx`.
- Modify: `src/components/dashboard/nav-items.ts` (+ `nav-items.test.ts`) — "Purchasing" entry under `purchasing:manage`.
- Test: `src/app/api/purchase-orders/route.test.ts` (guard-level).

**Interfaces:**
- Produces: `requirePurchasingPermission()` / `requireSuppliersPermission()` (mirror `src/app/dashboard/orders-permission.ts`); the routes below.
- Consumes: `authorize` + `UnauthorizedError` (`@/server/rbac`), all Task 3–7 services.

| Route | Method | Permission | Service |
|---|---|---|---|
| `/api/suppliers` | GET/POST | `suppliers:manage` | `listSuppliers` / `createSupplier` |
| `/api/suppliers/[id]` | PATCH | `suppliers:manage` | `updateSupplier` |
| `/api/suppliers/[id]/items` | GET/POST | `suppliers:manage` | supplier-item CRUD |
| `/api/purchase-orders` | GET/POST | `purchasing:manage` | list / `createDraftPo` |
| `/api/purchase-orders/[id]` | GET/PATCH | `purchasing:manage` | `getPurchaseOrder` / `updateDraftPo` |
| `/api/purchase-orders/[id]/send` | POST | `purchasing:manage` | `sendPurchaseOrder` |
| `/api/purchase-orders/[id]/cancel` | POST | `purchasing:manage` | `cancelPurchaseOrder` |
| `/api/purchase-orders/[id]/receipts` | POST | `purchasing:manage` | `postReceipt` |
| `/api/purchase-orders/[id]/invoice` | PATCH | `purchasing:manage` | `enterInvoiceTotal` |
| `/api/purchase-orders/[id]/variance` | GET | `purchasing:manage` | `getPoVariance` |
| `/api/inventory/reorder-rules` | GET/PUT | `inventory:manage` | `listReorderRules` / `upsertReorderRule` |
| `/api/inventory/reorder/check` | POST | `inventory:manage` | `checkReorder` |

Error mapping (one `catch` shape per route): `UnauthorizedError` → 403, `PoNotFoundError` → 404, `InvalidPoTransitionError` → 409, `SupplierEmailMissingError` → 422, body-shape failures → 400 (validate `lines` is a non-empty array and quantities are finite positive numbers **before** calling the service — the PR #116 review's malformed-body lesson: a network-exposed route must 400, not 500).

- [ ] **Step 1: Write the failing guard test.** `src/app/api/purchase-orders/route.test.ts`: `staff` fails `authorize(roleKeys, "purchasing:manage")` with `UnauthorizedError`; `owner`/`manager` pass. Extend `src/components/dashboard/nav-items.test.ts`: owner/manager nav includes "Purchasing" → `/dashboard/purchase-orders`; staff's does not.

- [ ] **Step 2: Run to verify they fail.** `npx vitest run src/app/api/purchase-orders/route.test.ts src/components/dashboard/nav-items.test.ts` → FAIL.

- [ ] **Step 3: Implement the guard, routes, nav.** `purchasing-permission.ts` mirrors `orders-permission.ts`. Each route: guard → parse/validate body → service call → error mapping above. Nav: `if (has("purchasing:manage")) items.push({ label: "Purchasing", href: "/dashboard/purchase-orders", icon: "receipt" });`.

- [ ] **Step 4: Build the minimal views.** `suppliers/page.tsx`: list + create form. `purchase-orders/page.tsx`: list with status badge; detail section showing lines, receipts, and the three-figure variance strip with a Send / Receive / Cancel action row. Follow `src/app/dashboard/orders` styling (`PageHeader`, `Card`, `EmptyState`).

- [ ] **Step 5: Run tests + typecheck + lint.**

```bash
npx vitest run src/app/api/purchase-orders/route.test.ts src/components/dashboard/nav-items.test.ts && npx tsc --noEmit && npx eslint src/server/purchasing src/app/api/suppliers src/app/api/purchase-orders src/app/api/inventory src/app/dashboard/suppliers src/app/dashboard/purchase-orders
```

Expected: PASS, clean.

- [ ] **Step 6: Commit.**

```bash
git add src/app/dashboard/purchasing-permission.ts src/app/api/suppliers src/app/api/purchase-orders src/app/api/inventory src/app/dashboard/suppliers src/app/dashboard/purchase-orders src/components/dashboard/nav-items.ts src/components/dashboard/nav-items.test.ts src/app/api/purchase-orders/route.test.ts
git commit -m "feat(purchasing): permission-gated supplier + PO routes, reorder config, dashboard views + nav"
```

---

## Task 9: Full-suite verification and manual acceptance

**Files:** none — this task proves the spec.

- [ ] **Step 1: Run everything.**

```bash
npm test && npx tsc --noEmit && npx eslint src
```

Expected: all PASS, all clean — including the audit coverage guardrail (purchasing files registered, `forward:purchase-order.*` gone) and the analytics suite (all three formerly-guarded purchasing reports now executing).

- [ ] **Step 2: Walk the acceptance path** (dashboard, a retail or restaurant tenant with inventory items):

- [ ] Create a supplier with an email; create a draft PO with two lines → `poNumber` sequential per tenant, `total = Σ lines`.
- [ ] Send the PO → status `sent`, `sentAt` set, owner/manager in-app `po_sent` notification, an outbox row with the fully-rendered HTML (drain the worker against a real Resend key to see the email), a `po.sent` audit row, `verifyChain` ok.
- [ ] Receive **4 of 10** on one line → a lot + `receive` ledger row exist, on-hand (dashboard inventory view) rises by 4, PO → `partially_received`. Receive the remaining **6** → `received`, two lots.
- [ ] Enter an `invoiceTotal`; `GET .../variance` → three figures + deltas correct; an over-receipt shows `overReceived: true`. Close → `closed`.
- [ ] Cancel a `received` PO → 409; cancel a fresh draft → `cancelled`.
- [ ] Set a reorder rule above current on-hand; `POST /api/inventory/reorder/check` → one `low_stock` notification + one pre-filled draft PO grouped under the preferred supplier; the analytics **Low stock** report shows the same rows; a second check within 24h does not re-notify.
- [ ] As `staff`: every purchasing/supplier write → 403; the Purchasing nav item is absent.

- [ ] **Step 3: Push and open the PR** (identity per `gh-account-for-serveos-writes`: pin `GH_TOKEN` to `mohanedsayed`; commits authored by mohanedsayed, never co-authored by Claude):

```bash
git push -u origin HEAD
GH_TOKEN=$(gh auth token --user mohanedsayed) gh pr create \
  --title "Suppliers & Purchasing: PO lifecycle, receiving into lots, variance, send-to-supplier, reorder loop" \
  --body "Implements Spec 9 (design Part C + D, decision D5). Suppliers + supplier items; draft→sent→partially_received→received→closed POs with a pure state machine; receiving posts lots + receive ledger rows through Spec 8's writer in one tx; three-way variance; send-to-supplier through the Spec 5 outbox (payload.html passthrough); reorder_rules + debounced low-stock loop pre-filling draft POs. Analytics stubs (getSpendBySupplier / getReceivedVsInvoiced / getLowStock) aligned and lit up — the PR #116 lesson, handled in-PR this time."
```

---

## Self-Review

**Spec coverage (Part C + Part D):** data model incl. `reorder_rules` → Tasks 1, 7; permissions → Tasks 2, 8; PO lifecycle machine (cancel only from draft/sent, terminals closed) → Task 3, enforced in Tasks 4–6; per-tenant `poNumber` under the advisory lock → Task 3; partial receipts → lots + ledger via the as-built `receiveStock`, over-receipt allowed → Task 4; three-way variance + invoice + close → Task 5; send-to-supplier (render, outbox, `sentAt`, `po.sent`, re-send) → Task 6; debounced low-stock alerts + grouped draft pre-fill, never auto-sent → Task 7; routes + views + nav → Task 8; full-suite + acceptance → Task 9.

**Deltas from the 2026-07-24 draft, all verified against code:**
1. **No `inventory_uom` enum** — `unitOfMeasureEnum` (`@/server/catalog/uom`) for columns, `assertInventoryUom`/`toBase`/`qty` (`@/server/inventory/uom`) at runtime. The draft's `toBaseQty(item, qty, uom)` does not exist; the real call is `toBase(value, fromUom, item, "purchase")`.
2. **No `resolveReceivingLocation`** — the as-built `getOrCreateDefaultLocation(tx, tenantId, branchId, "back_of_house")` lazily provisions.
3. **`receiveStock` takes `ReceiveArgs`** with `poReceiptLineId` + `supplierId` already threaded — the seam was built for this plan; no wrapper needed. It deliberately emits no audit event; `postReceipt` owns `po.received`.
4. **Spec 5 is merged; there is no `NOTIFICATIONS_ENABLED` flag** — all flag-gating from the draft is dropped. The `po_sent`/`po_received`/`low_stock`/`reorder_suggested` types already exist in the enum. External supplier email = direct outbox insert (the draft's "adapter fallback" is the real design); `renderTemplate` needs the `payload.html` passthrough its comment reserves.
5. **The shipped analytics stubs pin schema names** (`total`, `purchase_order_id`, `po_receipt_id`, `received_qty`, `reorder_rules.*`) and are aligned/lit-up **in-PR** (Tasks 1, 5, 7) — the PR #116 regression, prevented rather than repeated. The one schema/stub conflict (per-line `invoiced_amount`) is resolved in favor of the header `invoice_total` with the stub rewritten in Task 5.
6. **Audit guardrail** — purchasing files registered and `forward:purchase-order.*` removed in Task 3, mirroring PR #116's `forward:refund.*` swap.

**Type consistency:** `PoStatus`/`assertTransition`/`receiptStatus` (Task 3) are the sole status logic, consumed by Tasks 4–6; `PurchasingActor` is the single ctx shape across services; `money()` serializes every monetary field; `qty()` every quantity; `recordAuditEvent` and `notify` both take the caller's `tx` so status flip + audit row + outbox row commit or roll back together.
