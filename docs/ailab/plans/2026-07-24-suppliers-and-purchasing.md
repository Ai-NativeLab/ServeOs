# Suppliers & Purchasing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use mo-ai:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every tenant **replenishment**: the suppliers they buy from, purchase orders with a real lifecycle (`draft → sent → partially_received → received → closed`, plus `cancelled`), receiving that turns a PO into cost-carrying inventory lots and `receive` ledger rows (supporting **partial** receipts), a PO-vs-received-vs-invoice **variance** figure, the ability to **email a rendered PO to the supplier**, and a scheduled **low-stock reorder** loop that raises notifications and optionally pre-fills a draft PO. Implements `docs/ailab/specs/2026-07-24-inventory-recipes-and-purchasing-design.md` **Part C (Suppliers & Purchasing)** and **Part D (Low-Stock Alerts & Reorder)**, decision **D5**.

**Architecture:** Purchasing is a new domain module (`src/server/purchasing/`) sitting *on top of* the inventory substrate. The **state machine is one pure module** (`status.ts`) shared by the service and its tests — a PO's legal next states live in exactly one place, so "can I cancel a received PO?" has a single answer. Receiving is the only bridge from purchasing into inventory: `postReceipt` runs **inside one `withTenant` transaction** that, per line, creates the lot + the `receive` `stock_ledger` row (via the Spec 8 inventory writer), bumps `purchase_order_lines.qtyReceived`, recomputes the PO status from `Σ qtyReceived vs Σ qtyOrdered`, and emits a Spec 4 `po.received` audit event — all-or-nothing. `poNumber` reuses `placeOrder`'s exact serialization discipline (`src/server/ordering/service.ts:230`): `pg_advisory_xact_lock(hashtext(tenantId)::bigint)` then `COALESCE(MAX(poNumber),0)+1`. Send-to-supplier renders the PO to HTML (pure), enqueues it through the Spec 5 `notify`/outbox layer, sets `sentAt`, transitions `draft → sent`, and audits `po.sent` — all on one tx. The reorder job computes on-hand per rule from the ledger and calls Spec 5 `notify` with a debounce, then groups triggered items by preferred supplier into pre-filled draft POs (never auto-sent).

**Tech Stack:** Next.js (App Router — see `AGENTS.md`, this is not the Next.js of your training data; read `node_modules/next/dist/docs/` before touching routes), Drizzle ORM + Postgres (RLS via `withTenant`), Vitest against a remote Supabase Postgres. Money stays `money(n)` numeric strings (`src/server/ordering/service.ts:55`); inventory quantities are `numeric` (fractional). No new runtime dependencies — PO HTML is string templating; PDF attachment is deferred.

## Global Constraints

- **Prerequisite: Spec 8 (Inventory Core + Recipes).** This plan consumes Spec 8's `src/server/inventory/schema.ts` (`inventoryItems`, `inventoryLots`, `stockLedger`, `storageLocations`, enum `inventory_uom`), its UoM converter `toBaseQty(item, qty, uom)`, and its ledger writer `receiveStock(tx, ctx, {...})` (creates a lot + a positive `receive` ledger row). The roadmap sequences **9 after 8**; do not start Task 4 (receiving) until Spec 8 is merged. Tasks 1–3, 8 (schema, permissions, PO drafting, supplier/PO routes) touch only purchasing tables + FKs to `inventory_items` and can land against Spec 8's schema alone.
- **Prerequisite: Spec 5 (Notifications & Outbound Email).** Send-to-supplier (Task 6) and reorder alerts (Task 7) call Spec 5's `notify(ctx, { type, targets, channels, payload }, tx?)` (`src/server/notifications/service.ts`) and depend on the `notification_type` values `po_sent` / `po_received` / `low_stock` / `reorder_suggested` and the outbox worker. **Per the spec's "Spec 5 not merged" edge case**, gate the send + alert steps behind `env.NOTIFICATIONS_ENABLED`; when off, drafting, receiving, variance, and reorder-rule storage all still work — a PO simply cannot be emailed and the reorder job only pre-fills drafts.
- **Tenant-scoped tables are behind RLS.** Every new table is `ENABLE` + `FORCE ROW LEVEL SECURITY` with the house isolation policy `USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)` and the matching `WITH CHECK` — hand-appended to the generated migration exactly as `drizzle/0016_bitter_beast.sql:67-81` did (Drizzle's generator emits no `pgPolicy`). Every read/write goes through `withTenant(tenantId, tx => …)`.
- **The status machine is pure and singular.** Legal transitions live only in `src/server/purchasing/status.ts`. No service re-derives them inline; a transition the table forbids throws `InvalidPoTransitionError`. `cancelled` is unreachable once any receipt exists.
- **Receiving, sending, and reorder pre-fill are transactional.** `postReceipt` and `sendPurchaseOrder` each do all their writes (inventory rows / status flip / `sentAt` / audit / notify enqueue) on **one** `withTenant` tx — a provider being slow never leaves a PO half-sent, and a lot without its ledger row can never exist.
- **Money is `money(n)`; quantities are `numeric`.** `expectedTotal`, `invoiceTotal`, `unitCost`, `lastUnitCost` use `money(n)` numeric strings. `qtyOrdered`, `qtyReceived`, `reorderPoint`, `reorderQty` are `numeric`. Order-line sell quantities are untouched (still integer).
- **Purchasing writes require the `inventory` capability + a permission.** Service writes call `requireCapability(vertical, "inventory")` (`src/server/verticals/registry.ts:103`); routes assert `purchasing:manage` (POs, receiving, invoice, send) or `suppliers:manage` (supplier CRUD).
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
- Create: `src/server/purchasing/suppliers.ts` (+ `suppliers.test.ts`) — supplier + supplier-item CRUD.
- Create: `src/server/purchasing/service.ts` (+ `service.test.ts`) — PO create/edit draft, `poNumber`, transitions.
- Create: `src/server/purchasing/receiving.ts` (+ `receiving.test.ts`) — `postReceipt` → lots + ledger + status.
- Create: `src/server/purchasing/variance.ts` (+ `variance.test.ts`) — three-way variance + invoice entry.
- Create: `src/server/purchasing/render.ts` (+ `render.test.ts`) — pure PO → HTML.
- Create: `src/server/purchasing/send.ts` (+ `send.test.ts`) — send-to-supplier.
- Create: `src/server/purchasing/reorder.ts` (+ `reorder.test.ts`) — reorder rules + scheduled check.

**Authorization + routes + job**
- Modify: `src/server/rbac/permissions.ts` (+ `permissions.test.ts`) — `purchasing:manage`, `suppliers:manage`.
- Create: `src/app/dashboard/purchasing-permission.ts` — `requirePurchasingPermission`, `requireSuppliersPermission`.
- Create: `src/app/api/suppliers/route.ts`, `.../suppliers/[id]/route.ts`, `.../suppliers/[id]/items/route.ts`.
- Create: `src/app/api/purchase-orders/route.ts`, `.../[id]/route.ts`, `.../[id]/send/route.ts`, `.../[id]/cancel/route.ts`, `.../[id]/receipts/route.ts`, `.../[id]/invoice/route.ts`, `.../[id]/variance/route.ts`.
- Create: `src/app/api/inventory/reorder-rules/route.ts`, `.../inventory/reorder/check/route.ts`.
- Create: `src/app/dashboard/suppliers/page.tsx`, `src/app/dashboard/purchase-orders/page.tsx` (minimal read views).
- Create: `scripts/reorder-check.ts` — scheduled entry point iterating active tenants.

---

## Task 1: Schema — suppliers, purchase orders, lines, receipts

Six tables and one enum. `purchase_orders` is the aggregate root; `purchase_order_lines` its lines; `po_receipts`/`po_receipt_lines` the (possibly many) partial receipts against it; `suppliers`/`supplier_items` the catalog that seeds line defaults. All tenant-scoped, FORCE RLS. `itemId` FKs point at Spec 8's `inventory_items`; `uom` reuses Spec 8's `inventory_uom` enum.

**Files:**
- Create: `src/server/purchasing/schema.ts`
- Modify: `src/db/schema.ts`
- Create: `drizzle/00XX_*.sql` (generated, then edited)

**Interfaces:**
- Produces: tables `suppliers`, `supplierItems`, `purchaseOrders`, `purchaseOrderLines`, `poReceipts`, `poReceiptLines`; enum `poStatusEnum` (`draft | sent | partially_received | received | closed | cancelled`); types `Supplier`, `PurchaseOrder`, `PurchaseOrderLine`, `PoReceipt`, `PoReceiptLine`.
- Consumes: `tenants`, `branches`, `users`; Spec 8 `inventoryItems`, `inventoryUomEnum`.

- [ ] **Step 1: Write the schema.** Create `src/server/purchasing/schema.ts`:

```ts
import { pgTable, uuid, text, timestamp, numeric, integer, boolean, pgEnum, uniqueIndex, index } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { users } from "@/server/auth/schema";
import { inventoryItems, inventoryUomEnum } from "@/server/inventory/schema"; // Spec 8

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
  packUom: inventoryUomEnum("pack_uom"),
}, (t) => [uniqueIndex("supplier_items_supplier_item").on(t.supplierId, t.itemId)]);

export const purchaseOrders = pgTable("purchase_orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
  supplierId: uuid("supplier_id").notNull().references(() => suppliers.id),
  poNumber: integer("po_number").notNull(),     // per-tenant sequence
  status: poStatusEnum("status").notNull().default("draft"),
  expectedTotal: numeric("expected_total").notNull().default("0"),  // Σ lines, money(n)
  invoiceTotal: numeric("invoice_total"),                            // supplier's actual invoice
  currency: text("currency").notNull().default("EGP"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  expectedAt: timestamp("expected_at", { withTimezone: true }),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("purchase_orders_tenant_number").on(t.tenantId, t.poNumber),
  index("purchase_orders_tenant_status").on(t.tenantId, t.status),
]);

export const purchaseOrderLines = pgTable("purchase_order_lines", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  poId: uuid("po_id").notNull().references(() => purchaseOrders.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => inventoryItems.id),
  qtyOrdered: numeric("qty_ordered").notNull(),
  uom: inventoryUomEnum("uom").notNull(),
  unitCost: numeric("unit_cost").notNull(),        // money(n) per ordered UoM
  taxRate: numeric("tax_rate"),
  qtyReceived: numeric("qty_received").notNull().default("0"),  // running total across receipts
}, (t) => [index("purchase_order_lines_po").on(t.poId)]);

export const poReceipts = pgTable("po_receipts", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  poId: uuid("po_id").notNull().references(() => purchaseOrders.id, { onDelete: "cascade" }),
  receivedByUserId: uuid("received_by_user_id").references(() => users.id),
  supplierDeliveryNote: text("supplier_delivery_note"),
  note: text("note"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("po_receipts_po").on(t.poId)]);

export const poReceiptLines = pgTable("po_receipt_lines", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  receiptId: uuid("receipt_id").notNull().references(() => poReceipts.id, { onDelete: "cascade" }),
  poLineId: uuid("po_line_id").notNull().references(() => purchaseOrderLines.id),
  itemId: uuid("item_id").notNull().references(() => inventoryItems.id),
  qtyReceived: numeric("qty_received").notNull(),   // this receipt, in receipt UoM
  uom: inventoryUomEnum("uom").notNull(),
  unitCost: numeric("unit_cost").notNull(),
  lotCode: text("lot_code"),
  expiryAt: timestamp("expiry_at", { withTimezone: true }),
}, (t) => [index("po_receipt_lines_receipt").on(t.receiptId)]);

export type Supplier = typeof suppliers.$inferSelect;
export type SupplierItem = typeof supplierItems.$inferSelect;
export type PurchaseOrder = typeof purchaseOrders.$inferSelect;
export type PurchaseOrderLine = typeof purchaseOrderLines.$inferSelect;
export type PoReceipt = typeof poReceipts.$inferSelect;
export type PoReceiptLine = typeof poReceiptLines.$inferSelect;
```

- [ ] **Step 2: Register it.** Append to `src/db/schema.ts` (after the `../server/audit/schema` line, once Spec 4 has added it — else after `pos/tender-schema`):

```ts
export * from "../server/purchasing/schema";
```

- [ ] **Step 3: Generate the migration.**

```bash
npm run db:generate
```

Expected: a new `drizzle/00XX_*.sql` creating enum `po_status`, the six tables, FKs, and indexes. It will **not** contain RLS.

- [ ] **Step 4: Hand-append RLS.** Open the generated file and append one `ENABLE`/`FORCE`/`CREATE POLICY` block per table, mirroring `drizzle/0016_bitter_beast.sql:67-81`:

```sql
--> statement-breakpoint
ALTER TABLE "suppliers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "suppliers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY suppliers_isolation ON "suppliers"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- …repeat verbatim for supplier_items, purchase_orders, purchase_order_lines, po_receipts, po_receipt_lines
```

- [ ] **Step 5: Apply and verify the existing suite still passes.**

```bash
npm run db:migrate:test && npm test
```

Expected: migration applies; full suite PASS (nothing references the new tables yet).

- [ ] **Step 6: Commit.**

```bash
git add src/server/purchasing/schema.ts src/db/schema.ts drizzle/
git commit -m "feat(purchasing): suppliers, purchase_orders, lines, receipts schema + FORCE RLS"
```

---

## Task 2: Permissions — `purchasing:manage` + `suppliers:manage`

Two permissions per the roadmap's canonical mapping: **owner + manager** hold both; **staff** neither (staff may `inventory:count` from Spec 8, but not purchase). Small, pure, TDD.

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

- [ ] **Step 3: Implement.** In `src/server/rbac/permissions.ts`, add `"purchasing:manage",` and `"suppliers:manage",` to the `PERMISSIONS` array, then append both to the `owner` and `manager` arrays in `ROLE_PERMISSIONS`. (Leave `staff` unchanged.)

- [ ] **Step 4: Run to verify it passes.** `npx vitest run src/server/rbac/permissions.test.ts && npx tsc --noEmit` → PASS, clean.

- [ ] **Step 5: Commit.**

```bash
git add src/server/rbac/permissions.ts src/server/rbac/permissions.test.ts
git commit -m "feat(purchasing): purchasing:manage + suppliers:manage permissions (owner + manager)"
```

---

## Task 3: PO state machine + supplier/PO drafting service

The pure state machine first (`status.ts`), then the services that use it. `poNumber` reuses `placeOrder`'s per-tenant advisory lock. Drafting is edit-in-place while `status='draft'`; once `sent`, lines are frozen (only receiving and invoice mutate a sent PO).

**Files:**
- Create: `src/server/purchasing/status.ts` (+ `status.test.ts`)
- Create: `src/server/purchasing/suppliers.ts` (+ `suppliers.test.ts`)
- Create: `src/server/purchasing/service.ts` (+ `service.test.ts`)

**Interfaces:**
- Produces:
  - `type PoStatus = "draft" | "sent" | "partially_received" | "received" | "closed" | "cancelled"`
  - `const PO_TRANSITIONS: Record<PoStatus, PoStatus[]>`; `canTransition(from, to): boolean`; `assertTransition(from, to): void` (throws `InvalidPoTransitionError`).
  - `createSupplier`, `updateSupplier`, `upsertSupplierItem`, `listSuppliers`.
  - `createDraftPo(ctx, input): Promise<{ poId; poNumber }>`; `updateDraftPo`; `getPurchaseOrder`; `cancelPurchaseOrder`.
- Consumes: `withTenant`, `money` (`@/server/ordering/service`), `requireCapability`, `recordAuditEvent` (Spec 4).

- [ ] **Step 1: Write the failing state-machine test.** Create `src/server/purchasing/status.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { canTransition, assertTransition, InvalidPoTransitionError } from "./status";

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
});
```

- [ ] **Step 2: Run to verify it fails.** `npx vitest run src/server/purchasing/status.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement the state machine.** Create `src/server/purchasing/status.ts`:

```ts
export type PoStatus = "draft" | "sent" | "partially_received" | "received" | "closed" | "cancelled";

export class InvalidPoTransitionError extends Error {
  constructor(public from: PoStatus, public to: PoStatus) {
    super(`Illegal PO transition ${from} → ${to}`);
    this.name = "InvalidPoTransitionError";
  }
}

/** The ONLY definition of legal PO transitions. `cancelled` is unreachable once
 *  any receipt exists (enforced by the receiving service, which never cancels).
 *  Terminals (closed, cancelled) have no outgoing edges. */
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

- [ ] **Step 4: Write the failing supplier + drafting tests.** Create `src/server/purchasing/suppliers.test.ts` and `src/server/purchasing/service.test.ts`. Seed a tenant + branch + two `inventory_items` (Spec 8 helper `seedInventoryItem`). Assert:
  - `createSupplier` persists; `upsertSupplierItem` is unique per `(supplierId, itemId)` (second upsert updates `lastUnitCost`, not a duplicate row); RLS hides supplier B's rows from tenant A.
  - `createDraftPo` assigns `poNumber = 1` then `2` for the same tenant, sets `status='draft'`, computes `expectedTotal = Σ qtyOrdered × unitCost` via `money()`, and persists lines with `qtyReceived='0'`.
  - `updateDraftPo` edits lines while `draft`; editing a non-`draft` PO throws.
  - `cancelPurchaseOrder` moves `draft`/`sent` → `cancelled` and writes a `po.cancelled` audit event; cancelling a `partially_received` PO throws `InvalidPoTransitionError`.
  - concurrent `createDraftPo` for one tenant yields `poNumber` `1` and `2` with no duplicate (the advisory-lock test, analog of the order-number test).

- [ ] **Step 5: Run to verify they fail.** `npx vitest run src/server/purchasing/suppliers.test.ts src/server/purchasing/service.test.ts` → FAIL.

- [ ] **Step 6: Implement the services.** Create `src/server/purchasing/suppliers.ts` (thin `withTenant` CRUD; `upsertSupplierItem` uses `.onConflictDoUpdate` on the `(supplierId, itemId)` unique index). Create `src/server/purchasing/service.ts`:

```ts
import { sql, eq, and } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { money } from "@/server/ordering/service";
import { requireCapability } from "@/server/verticals/registry";
import { recordAuditEvent } from "@/server/audit/service";
import { purchaseOrders, purchaseOrderLines } from "./schema";
import { assertTransition, type PoStatus } from "./status";

// createDraftPo: inside withTenant —
//   1. requireCapability(vertical, "inventory")
//   2. SELECT pg_advisory_xact_lock(hashtext(${tenantId})::bigint)          ← same as placeOrder
//   3. poNumber = COALESCE(MAX(po_number),0)+1 for this tenant
//   4. expectedTotal = money(Σ line.qtyOrdered * line.unitCost)
//   5. insert purchase_orders (status 'draft') + purchase_order_lines
//   6. recordAuditEvent(ctx, { action: "po.created", entityType: "purchase_order", entityId: poId, … }, tx)
// updateDraftPo: assert current status === 'draft' (else InvalidPoTransitionError),
//   replace lines, recompute expectedTotal.
// cancelPurchaseOrder: read status; assertTransition(status, "cancelled");
//   update status='cancelled'; recordAuditEvent "po.cancelled".
```

The `poNumber` block is a verbatim copy of `src/server/ordering/service.ts:230-232` with `orders` → `purchaseOrders` and `orderNumber` → `poNumber`.

- [ ] **Step 7: Run to verify they pass.** `npx vitest run src/server/purchasing/status.test.ts src/server/purchasing/suppliers.test.ts src/server/purchasing/service.test.ts && npx tsc --noEmit` → PASS.

- [ ] **Step 8: Commit.**

```bash
git add src/server/purchasing/status.ts src/server/purchasing/status.test.ts src/server/purchasing/suppliers.ts src/server/purchasing/suppliers.test.ts src/server/purchasing/service.ts src/server/purchasing/service.test.ts
git commit -m "feat(purchasing): pure PO state machine + supplier CRUD + draft PO create/edit/cancel"
```

---

## Task 4: Receiving — post a receipt → lots + `receive` ledger rows

The bridge into inventory. `postReceipt` records one (partial) receipt: per line it converts the received qty to base UoM (Spec 8 `toBaseQty`), creates a lot + a positive `receive` `stock_ledger` row (Spec 8 `receiveStock`) at the branch's receiving location, bumps `purchase_order_lines.qtyReceived`, then recomputes and advances the PO status. Over-receipt beyond ordered qty is **allowed** (flagged later in variance). All in one tx; emits `po.received`.

**Prerequisite:** Spec 8 merged (`receiveStock`, `toBaseQty`, `resolveReceivingLocation(tx, branchId)` which returns the branch `back_of_house`/default location).

**Files:**
- Create: `src/server/purchasing/receiving.ts`
- Test: `src/server/purchasing/receiving.test.ts`

**Interfaces:**
- Produces: `postReceipt(ctx, poId, input): Promise<{ receiptId; status: PoStatus }>` where `input = { receivedByUserId?, supplierDeliveryNote?, note?, lines: { poLineId; qtyReceived; uom; unitCost; lotCode?; expiryAt? }[] }`.
- Consumes: Spec 8 `receiveStock`, `toBaseQty`, `resolveReceivingLocation`, `inventoryItems`; `assertTransition`, `receiptStatus` (Task 3); `recordAuditEvent` (Spec 4).

- [ ] **Step 1: Write the failing tests.** Create `src/server/purchasing/receiving.test.ts`. Seed a `sent` PO with one line of `qtyOrdered=10`. Assert:
  - **Partial receipt** of `4` creates one `inventory_lots` row (qty 4 in base UoM) + one `receive` `stock_ledger` row (positive, `refType='po_receipt'`), bumps the line's `qtyReceived` to `4`, and moves the PO to `partially_received`.
  - A **second receipt** of `6` moves the line to `10` and the PO to `received`; two lots now exist.
  - **Over-receipt** (`qtyOrdered=10`, receive `12`) is accepted; PO reaches `received`; the extra 2 is not rejected.
  - Receiving against a `draft` PO throws (must be `sent`/`partially_received`); against a `cancelled` PO throws.
  - The whole receipt is atomic: if `receiveStock` throws on line 2, no lot from line 1 and no `qtyReceived` bump survive (wrap the seeded item to force a failure, assert rollback).
  - A `po.received` audit event is emitted with `{ receiptId, lineCount }`.

- [ ] **Step 2: Run to verify they fail.** `npx vitest run src/server/purchasing/receiving.test.ts` → FAIL.

- [ ] **Step 3: Implement.** Create `src/server/purchasing/receiving.ts`:

```ts
// postReceipt(ctx, poId, input): withTenant(ctx.tenantId, async (tx) => {
//   requireCapability(ctx.vertical, "inventory");
//   const po = read purchase_orders by id; if (!po) throw NotFoundError;
//   if (po.status !== "sent" && po.status !== "partially_received")
//       throw new InvalidPoTransitionError(po.status, "partially_received");
//   const locationId = await resolveReceivingLocation(tx, po.branchId);   // Spec 8
//   const [receipt] = await tx.insert(poReceipts).values({ ... }).returning();
//   for (const line of input.lines) {
//     const item = await readItem(tx, line.itemId ?? poLine.itemId);
//     const qtyBase = toBaseQty(item, line.qtyReceived, line.uom);        // Spec 8
//     await tx.insert(poReceiptLines).values({ receiptId: receipt.id, ... });
//     await receiveStock(tx, ctx, {                                        // Spec 8: lot + receive ledger row
//       itemId: item.id, locationId, qtyBase, unitCost: line.unitCost,
//       supplierId: po.supplierId, receivedAt: receipt.receivedAt,
//       expiryAt: line.expiryAt, lotCode: line.lotCode, poReceiptLineId: newReceiptLineId,
//     });
//     await tx.update(purchaseOrderLines)
//       .set({ qtyReceived: money-free numeric add })                     // qtyReceived + line.qtyReceived
//       .where(eq(purchaseOrderLines.id, line.poLineId));
//   }
//   const lines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, poId));
//   const next = receiptStatus(lines);                                    // Task 3
//   assertTransition(po.status, next === "sent" ? po.status : next);      // no-op when unchanged
//   await tx.update(purchaseOrders).set({ status: next }).where(eq(purchaseOrders.id, poId));
//   await recordAuditEvent(ctx, { action: "po.received", entityType: "purchase_order",
//     entityId: poId, summary: `Receipt on PO #${po.poNumber}`,
//     metadata: { receiptId: receipt.id, lineCount: input.lines.length, status: next } }, tx);
//   return { receiptId: receipt.id, status: next };
// })
```

- [ ] **Step 4: Run to verify they pass.** `npx vitest run src/server/purchasing/receiving.test.ts && npx tsc --noEmit` → PASS. The atomicity test proves the single-tx guarantee; the partial-then-full test proves status advancement.

- [ ] **Step 5: Commit.**

```bash
git add src/server/purchasing/receiving.ts src/server/purchasing/receiving.test.ts
git commit -m "feat(purchasing): receiving — lots + receive ledger rows, partial receipts, status advance, po.received audit"
```

---

## Task 5: Variance — PO vs received vs invoice

Three money figures per PO and their pairwise deltas: `expectedTotal` (ordered), `receivedTotal` (`Σ receipt-line qty × unitCost`), `invoiceTotal` (billed). `enterInvoiceTotal` records the supplier's figure and, when the PO is `received`, may transition it to `closed`.

**Files:**
- Create: `src/server/purchasing/variance.ts`
- Test: `src/server/purchasing/variance.test.ts`

**Interfaces:**
- Produces:
  - `type PoVariance = { expectedTotal: string; receivedTotal: string; invoiceTotal: string | null; receivedVsExpected: string; invoiceVsReceived: string; overReceived: boolean }`
  - `getPoVariance(ctx, poId): Promise<PoVariance>`
  - `enterInvoiceTotal(ctx, poId, invoiceTotal): Promise<void>` (+ optional `closePurchaseOrder`).

- [ ] **Step 1: Write the failing tests.** Create `src/server/purchasing/variance.test.ts`. On a PO ordered at `100.00`, received worth `90.00`, invoiced `95.00`, assert `receivedVsExpected = "-10.00"`, `invoiceVsReceived = "5.00"`. On an over-receipt (received `110.00` vs ordered `100.00`) assert `overReceived === true` and `receivedVsExpected = "10.00"`. `invoiceTotal` null before entry; `enterInvoiceTotal` persists it and, on a `received` PO, `closePurchaseOrder` moves it to `closed` (asserted via the state machine).

- [ ] **Step 2: Run to verify they fail.** `npx vitest run src/server/purchasing/variance.test.ts` → FAIL.

- [ ] **Step 3: Implement.** Create `src/server/purchasing/variance.ts` — sum receipt lines with `money()` arithmetic (numeric-string safe: compute in `Number`, re-serialize with `money()`); `enterInvoiceTotal` updates the column and audits `po.invoiced`; `closePurchaseOrder` calls `assertTransition(status, "closed")`.

- [ ] **Step 4: Run to verify they pass.** `npx vitest run src/server/purchasing/variance.test.ts && npx tsc --noEmit` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/server/purchasing/variance.ts src/server/purchasing/variance.test.ts
git commit -m "feat(purchasing): three-way PO variance (ordered/received/invoiced) + invoice entry + close"
```

---

## Task 6: Send-to-supplier — render, email, audit, `sentAt`

Render the PO to HTML (pure, testable), enqueue it through the Spec 5 outbox to the supplier's email, set `sentAt`, transition `draft → sent`, and emit `po.sent` — all on one tx. **Feature-flagged on Spec 5** (`env.NOTIFICATIONS_ENABLED`): when off, `sendPurchaseOrder` throws `NotificationsDisabledError` and the PO stays `draft`.

**Files:**
- Create: `src/server/purchasing/render.ts` (+ `render.test.ts`)
- Create: `src/server/purchasing/send.ts` (+ `send.test.ts`)

**Interfaces:**
- Produces:
  - `renderPurchaseOrderHtml(po, lines, supplier, branch, tenant): string` (pure).
  - `sendPurchaseOrder(ctx, poId): Promise<void>`.
- Consumes: Spec 5 `notify` (`@/server/notifications/service`) with `type: "po_sent"`; `recordAuditEvent` (Spec 4); `assertTransition` (Task 3).

- [ ] **Step 1: Write the failing render test.** Create `src/server/purchasing/render.test.ts`: assert the HTML contains the PO number, supplier name, each line's item name + qty + unit cost, the `expectedTotal`, and the delivery branch address; assert it is a single self-contained string (no external asset URLs). Then create `src/server/purchasing/send.test.ts` with a **fake `notify`** (Vitest `vi.mock` of `@/server/notifications/service`): assert `sendPurchaseOrder`
  - throws `SupplierEmailMissingError` when `supplier.email` is null;
  - on success calls `notify` once with `{ type: "po_sent", channels: ["in_app","email"], targets: [{ email: supplier.email }, { role: "owner" }] }` and a `payload` containing the rendered `html` + `subject`;
  - sets `sentAt` (non-null) and `status='sent'`;
  - emits one `po.sent` audit event;
  - is **re-sendable** from `sent`: a second call updates `sentAt` and logs a *distinct* `po.sent` event (idempotent per revision — spec);
  - with `NOTIFICATIONS_ENABLED=false` throws `NotificationsDisabledError` and leaves `status='draft'`, `sentAt=null`.

- [ ] **Step 2: Run to verify they fail.** `npx vitest run src/server/purchasing/render.test.ts src/server/purchasing/send.test.ts` → FAIL.

- [ ] **Step 3: Implement.** Create `src/server/purchasing/render.ts` (a template literal building an HTML table of lines; escape interpolated text). Create `src/server/purchasing/send.ts`:

```ts
// sendPurchaseOrder(ctx, poId): withTenant(ctx.tenantId, async (tx) => {
//   if (!env.NOTIFICATIONS_ENABLED) throw new NotificationsDisabledError();   // Spec 5 gate
//   requireCapability(ctx.vertical, "inventory");
//   const { po, lines, supplier, branch, tenant } = await loadForSend(tx, poId);
//   if (!supplier.email) throw new SupplierEmailMissingError(supplier.id);
//   assertTransition(po.status === "sent" ? "draft" : po.status, "sent"); // allow re-send from sent
//   const html = renderPurchaseOrderHtml(po, lines, supplier, branch, tenant);
//   await notify(ctx, {                                                    // Spec 5, on the same tx
//     type: "po_sent",
//     targets: [{ email: supplier.email }, { role: "owner" }, { role: "manager" }],
//     channels: ["in_app", "email"],
//     payload: { poId, poNumber: po.poNumber, subject: `Purchase Order #${po.poNumber}`, html,
//                replyTo: branch.replyToEmail ?? null },
//   }, tx);
//   await tx.update(purchaseOrders).set({ status: "sent", sentAt: new Date() })
//     .where(eq(purchaseOrders.id, poId));
//   await recordAuditEvent(ctx, { action: "po.sent", entityType: "purchase_order", entityId: poId,
//     summary: `PO #${po.poNumber} sent to ${supplier.name}`,
//     metadata: { supplierId: supplier.id, to: supplier.email } }, tx);
// })
```

**Note on the Spec 5 seam (see Self-Review):** `notify`'s `targets` are user/role oriented in Spec 5; send-PO needs an **external** supplier address. This plan passes an explicit `{ email }` target for the `po_sent` type. If Spec 5's `notify` does not yet accept `{ email }`, add a one-line adapter that writes the `notification_outbox` row directly with `toEmail = supplier.email` — still Spec-5-owned infra, drained by the same outbox worker.

- [ ] **Step 4: Run to verify they pass.** `npx vitest run src/server/purchasing/render.test.ts src/server/purchasing/send.test.ts && npx tsc --noEmit` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/server/purchasing/render.ts src/server/purchasing/render.test.ts src/server/purchasing/send.ts src/server/purchasing/send.test.ts
git commit -m "feat(purchasing): send-to-supplier — render PO HTML, enqueue via notify, set sentAt, po.sent audit"
```

---

## Task 7: Low-stock alerts & reorder

`reorder_rules` (per item per location) plus the scheduled check: compute on-hand per active rule from the ledger, raise a **debounced** `low_stock` notification for each item at/below its point, and optionally **pre-fill** one draft PO per preferred supplier with lines at `reorderQty` × `supplier_items.lastUnitCost`. Never auto-send. **Alert step feature-flagged on Spec 5**; rule storage + draft pre-fill work without it.

**Files:**
- Create: `src/server/purchasing/reorder-schema.ts` (+ migration)
- Create: `src/server/purchasing/reorder.ts` (+ `reorder.test.ts`)
- Create: `scripts/reorder-check.ts`

**Interfaces:**
- Produces:
  - table `reorderRules` (`itemId`, `locationId`, `reorderPoint`, `reorderQty`, `preferredSupplierId?`, `isActive`; unique `(itemId, locationId)`).
  - `upsertReorderRule`, `listReorderRules`.
  - `checkReorder(ctx): Promise<{ triggered: number; draftsCreated: number }>` — the job body + manual entry point.
- Consumes: Spec 8 on-hand projection `onHandForRule(tx, itemId, locationId)` (Σ ledger qty); Spec 5 `notify` (`low_stock`); `createDraftPo` (Task 3).

- [ ] **Step 1: Write the reorder-rules schema.** Create `src/server/purchasing/reorder-schema.ts`:

```ts
import { pgTable, uuid, numeric, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";
import { inventoryItems, storageLocations } from "@/server/inventory/schema"; // Spec 8
import { suppliers } from "./schema";

export const reorderRules = pgTable("reorder_rules", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => inventoryItems.id, { onDelete: "cascade" }),
  locationId: uuid("location_id").notNull().references(() => storageLocations.id, { onDelete: "cascade" }),
  reorderPoint: numeric("reorder_point").notNull(),   // base UoM
  reorderQty: numeric("reorder_qty").notNull(),       // base UoM
  preferredSupplierId: uuid("preferred_supplier_id").references(() => suppliers.id),
  lastAlertedAt: timestamp("last_alerted_at", { withTimezone: true }),  // debounce key
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("reorder_rules_item_location").on(t.itemId, t.locationId)]);

export type ReorderRule = typeof reorderRules.$inferSelect;
```

Register in `src/db/schema.ts`; `npm run db:generate`; hand-append the RLS block; `npm run db:migrate:test`.

- [ ] **Step 2: Write the failing tests.** Create `src/server/purchasing/reorder.test.ts`. Seed items with ledger balances (Spec 8), rules, and a preferred supplier with `supplier_items.lastUnitCost`. Assert `checkReorder`:
  - raises exactly one `low_stock` `notify` per item at/below its `reorderPoint`; nothing for items above.
  - is **debounced**: a second run within the window (recent `lastAlertedAt`) does not re-notify.
  - **pre-fills** one `draft` PO per preferred supplier, grouping that supplier's triggered items into lines at `reorderQty` and `lastUnitCost`; the PO is `draft` (never sent).
  - with `NOTIFICATIONS_ENABLED=false`: no `notify` call, but draft pre-fill still runs.
  - returns accurate `{ triggered, draftsCreated }`.

- [ ] **Step 3: Run to verify they fail.** `npx vitest run src/server/purchasing/reorder.test.ts` → FAIL.

- [ ] **Step 4: Implement.** Create `src/server/purchasing/reorder.ts`:

```ts
// checkReorder(ctx): withTenant(ctx.tenantId, async (tx) => {
//   const rules = active reorder_rules;
//   const triggered = [];
//   for (const r of rules) {
//     const onHand = await onHandForRule(tx, r.itemId, r.locationId);      // Spec 8: Σ ledger qty
//     if (Number(onHand) > Number(r.reorderPoint)) continue;
//     const debounced = r.lastAlertedAt && withinWindow(r.lastAlertedAt);  // e.g. 24h
//     if (!debounced && env.NOTIFICATIONS_ENABLED) {
//       await notify(ctx, { type: "low_stock", targets: [{ role: "owner" }, { role: "manager" }],
//         channels: ["in_app","email"], severity: "warning",
//         payload: { itemId: r.itemId, locationId: r.locationId, onHand, reorderPoint: r.reorderPoint } }, tx);
//       await tx.update(reorderRules).set({ lastAlertedAt: new Date() }).where(eq(reorderRules.id, r.id));
//     }
//     triggered.push(r);
//   }
//   // group by preferredSupplierId → createDraftPo per supplier at reorderQty × lastUnitCost
//   const drafts = await prefillDraftPos(ctx, tx, triggered);
//   return { triggered: triggered.length, draftsCreated: drafts.length };
// })
```

- [ ] **Step 5: Wire the scheduled entry point.** Create `scripts/reorder-check.ts` — iterate active tenants (in tenant timezone), call `checkReorder(ctx)` for each; log a per-tenant summary. This is the cron body; `POST /api/inventory/reorder/check` (Task 8) is the manual trigger over the same function.

- [ ] **Step 6: Run to verify they pass.** `npx vitest run src/server/purchasing/reorder.test.ts && npx tsc --noEmit` → PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/server/purchasing/reorder-schema.ts src/server/purchasing/reorder.ts src/server/purchasing/reorder.test.ts scripts/reorder-check.ts src/db/schema.ts drizzle/
git commit -m "feat(purchasing): reorder_rules + scheduled low-stock check → debounced notify + pre-filled draft POs"
```

---

## Task 8: Dashboard routes — suppliers + purchase orders

Reads resolve the tenant from the web session, assert the permission, and query through `withTenant`. Writes go through the Task 3–7 services. **No route ever writes inventory or an audit row directly** — those come only from the services' transactions.

**Files:**
- Create: `src/app/dashboard/purchasing-permission.ts`
- Create: the `src/app/api/suppliers/*` and `src/app/api/purchase-orders/*` routes, plus `src/app/api/inventory/reorder-rules` + `.../reorder/check`.
- Create: `src/app/dashboard/suppliers/page.tsx`, `src/app/dashboard/purchase-orders/page.tsx`.
- Test: `src/app/api/purchase-orders/route.test.ts` (guard-level).

**Interfaces:**
- Produces: `requirePurchasingPermission()` / `requireSuppliersPermission()` (mirror `src/app/dashboard/orders-permission.ts`); the routes below.
- Consumes: `requireDashboardUser` + `DashboardContext`, `authorize` + `UnauthorizedError` (`@/server/rbac`), all Task 3–7 services.

Routes (all `withTenant`, permission-gated; `AGENTS.md`: read the Next docs in `node_modules/next/dist/docs/` before writing route handlers):

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

- [ ] **Step 1: Write the failing guard test.** Create `src/app/api/purchase-orders/route.test.ts`: assert a `staff` role fails `authorize(roleKeys, "purchasing:manage")` with `UnauthorizedError` (the assertion the route maps to a 403), and that `owner`/`manager` pass. (A full HTTP test needs a session cookie; asserting the guard is the load-bearing check, per the audit plan's Task 7 precedent.)

- [ ] **Step 2: Run to verify it fails.** `npx vitest run src/app/api/purchase-orders/route.test.ts` → FAIL.

- [ ] **Step 3: Implement the permission guard + routes.** Create `src/app/dashboard/purchasing-permission.ts` (mirror `orders-permission.ts`: `requireDashboardUser()` then `authorize(ctx.roleKeys, "purchasing:manage")`). Implement each route with the try/`UnauthorizedError`→403 shape from the audit plan's `src/app/api/audit/events/route.ts`. `POST /send` maps `NotificationsDisabledError` → 409, `SupplierEmailMissingError` → 422, `InvalidPoTransitionError` → 409.

- [ ] **Step 4: Build the minimal views.** `src/app/dashboard/suppliers/page.tsx` (list + create) and `src/app/dashboard/purchase-orders/page.tsx` (list with status badge; detail shows lines, receipts, and the variance three-number strip). Follow the styling of `src/app/dashboard/orders`.

- [ ] **Step 5: Run tests + typecheck + lint.**

```bash
npx vitest run src/app/api/purchase-orders/route.test.ts && npx tsc --noEmit && npx eslint src/server/purchasing src/app/api/suppliers src/app/api/purchase-orders src/app/api/inventory src/app/dashboard/suppliers src/app/dashboard/purchase-orders
```

Expected: PASS, clean.

- [ ] **Step 6: Commit.**

```bash
git add src/app/dashboard/purchasing-permission.ts src/app/api/suppliers src/app/api/purchase-orders src/app/api/inventory src/app/dashboard/suppliers src/app/dashboard/purchase-orders src/app/api/purchase-orders/route.test.ts
git commit -m "feat(purchasing): suppliers:manage / purchasing:manage-gated dashboard routes + minimal views"
```

---

## Task 9: Full-suite verification and manual acceptance

**Files:** none — this task changes nothing. It proves the spec.

- [ ] **Step 1: Run everything.**

```bash
npm test && npx tsc --noEmit && npx eslint src
```

Expected: all PASS, all clean. Fix anything that is not before continuing.

- [ ] **Step 2: Walk the spec's acceptance path** (with Spec 8 + Spec 5 merged, `NOTIFICATIONS_ENABLED=true`, a verified `mail.serveos.com`, on a restaurant/retail tenant with at least one `inventory_item`):

- [ ] Create a supplier with an email; create a draft PO with two lines; confirm `poNumber` is per-tenant sequential and `expectedTotal = Σ lines`.
- [ ] Send the PO → PO flips to `sent`, `sentAt` is set, an in-app `po_sent` notification appears, and (worker drained) a real email lands with the rendered PO From the platform domain, Reply-To = the branch address. Confirm a `po.sent` `audit_events` row.
- [ ] Receive **4 of 10** on one line → a lot + a `receive` `stock_ledger` row appear; on-hand rises by 4; PO → `partially_received`. Receive the remaining **6** → PO → `received`; a second lot exists; a `po.received` audit row per receipt.
- [ ] Enter an `invoiceTotal`; open `/api/purchase-orders/:id/variance` → the three figures and pairwise deltas are correct; an over-receipt shows `overReceived: true`. Close the PO → `closed`.
- [ ] Attempt to cancel the received PO → 409 (`InvalidPoTransitionError`); cancel a fresh draft → `cancelled`.
- [ ] Set a `reorder_rule` below current on-hand, deduct stock past the point via a POS sale (Spec 8), run `POST /api/inventory/reorder/check` → one `low_stock` notification + a pre-filled `draft` PO grouped by preferred supplier; a second run does not re-notify (debounced).
- [ ] As a `staff` user, every `/api/purchase-orders/*` and `/api/suppliers/*` write returns **403**.

- [ ] **Step 3: Open the PR.**

```bash
git push -u origin HEAD
gh pr create --title "feat(purchasing): suppliers, purchase orders, receiving, variance, send-to-supplier, reorder" --body "$(cat <<'EOF'
Implements docs/ailab/specs/2026-07-24-inventory-recipes-and-purchasing-design.md Part C (Suppliers & Purchasing) + Part D (Low-Stock Alerts & Reorder), decision D5.

- suppliers / supplier_items / purchase_orders / purchase_order_lines / po_receipts /
  po_receipt_lines + reorder_rules, all FORCE RLS. poNumber via the same per-tenant
  advisory lock placeOrder uses for order numbers.
- Pure PO state machine (draft → sent → partially_received → received → closed, plus
  cancelled) shared by the service and its tests; cancelled unreachable after any receipt.
- Receiving posts a (partial) receipt in one tx → inventory lots + receive ledger rows
  (Spec 8), bumps qtyReceived, advances status, emits po.received; over-receipt allowed
  and flagged in the three-way PO-vs-received-vs-invoice variance.
- Send-to-supplier renders the PO to HTML, enqueues it through the Spec 5 notify/outbox
  layer to the supplier, sets sentAt, transitions to sent, and audits po.sent (Spec 4).
- Scheduled low-stock check raises debounced Spec 5 low_stock notifications and pre-fills
  grouped draft POs; never auto-sends.
- Routes gated by suppliers:manage / purchasing:manage; reorder config by inventory:manage.

Depends on Spec 8 (inventory schema + ledger writer) and Spec 5 (notify + EmailProvider).
Send + alert steps are behind NOTIFICATIONS_ENABLED; drafting, receiving, variance, and
reorder-rule storage work without Spec 5, per the spec's "Spec 5 not merged" edge case.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage (Part C + Part D):**
- *Data model* — `suppliers` (name, contacts, email, phone, terms, notes), `supplier_items` (sku, lastUnitCost, packUom), `purchase_orders` (poNumber, status, expected/invoice totals, currency, sentAt), `purchase_order_lines` (item, qty, uom, unit cost, tax, qtyReceived), `po_receipts` + `po_receipt_lines`, `reorder_rules` — all FORCE RLS → **Tasks 1, 7**.
- *Authorization* — `purchasing:manage` + `suppliers:manage` (owner + manager, not staff); reorder config under `inventory:manage` → **Tasks 2, 8**.
- *PO lifecycle state machine* — one pure module, happy path + cancel-from-draft/sent only + terminals, `cancelled` unreachable after receipt → **Task 3**; enforced by receiving (**Task 4**) and close (**Task 5**).
- *Create/edit draft + poNumber* — per-tenant advisory-locked sequence, `expectedTotal = Σ lines`, draft-only editing → **Task 3**.
- *Receiving + partial receipts + lots + ledger* — one-tx receipt creates lots + `receive` ledger rows (Spec 8), bumps `qtyReceived`, advances `partially_received → received`, over-receipt allowed → **Task 4**.
- *PO-vs-received-vs-invoice variance* — three figures + pairwise deltas + over-received flag + invoice entry → **Task 5**.
- *Send-to-supplier* — render HTML, `notify`/outbox email (Spec 5), `sentAt`, `draft → sent`, `po.sent` audit (Spec 4), re-sendable → **Task 6**.
- *Low-stock alerts + reorder* — per item/location rules, scheduled ledger-based check, debounced `low_stock` notify, grouped pre-filled draft POs, never auto-sent → **Task 7**.
- *API + dashboard* — suppliers + PO + reorder routes, permission-gated, minimal views → **Task 8**.
- *Testing + manual acceptance* — every task is TDD (failing test → implement → pass); acceptance walk → **Task 9**.

**Two deliberate seams called out for the implementer:**
1. **Spec 5's `notify` and the inventory spec's `sendEmail`/`enqueueNotification` names differ.** Spec 5 is the owning spec and exposes `notify(ctx, { type, targets, channels, payload }, tx?)` + an outbox worker; the inventory spec's `sendEmail(ctx, { to, subject, html })` and `enqueueNotification(ctx, {...})` are that spec's shorthand for the same store-and-forward path. This plan targets the real Spec 5 surface (`notify` with `type: "po_sent"` / `"low_stock"`). The one gap is that `notify`'s targets are user/role oriented while send-PO addresses an **external** supplier — handled by an explicit `{ email }` target, with a documented one-line outbox-row adapter fallback if Spec 5 has not added it (Task 6 note). No purchasing code path changes either way.
2. **Ordering vs receiving location.** The spec resolves receiving to the destination branch; Spec 8 owns the `storage_locations` model. This plan consumes `resolveReceivingLocation(tx, branchId)` (Spec 8) rather than hard-coding `back_of_house`, so a tenant with a distinct receiving dock is honoured without a purchasing change.

**Prerequisite ordering (honest about the dependency chain):** Tasks 1–3 and 8 land against Spec 8's schema alone. Task 4 (receiving) requires Spec 8's ledger writer merged. Tasks 6–7 (send, alerts) require Spec 5 merged and are otherwise feature-flagged off — exactly the spec's "Spec 5 not merged: send-to-supplier and low-stock alerts are flagged off; drafting, receiving, and reorder-rule storage still work."

**Type consistency:** `PoStatus` and the `PO_TRANSITIONS`/`assertTransition`/`receiptStatus` helpers (Task 3) are the single source consumed by the drafting service (Task 3), receiving (Task 4), variance/close (Task 5), and send (Task 6) — no status logic is re-derived anywhere. `money()` (`@/server/ordering/service`) serializes every monetary field (`expectedTotal`, `invoiceTotal`, `unitCost`, variance deltas); `numeric` carries every quantity (`qtyOrdered`, `qtyReceived`, `reorderPoint`, `reorderQty`). `recordAuditEvent` (Spec 4) and `notify` (Spec 5) both take the caller's `tx`, so a PO's status flip, its audit row, and its outbox row commit or roll back as one.
