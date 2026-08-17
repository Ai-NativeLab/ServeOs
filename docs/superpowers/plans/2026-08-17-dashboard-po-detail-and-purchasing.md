# Purchasing & Suppliers Dashboard UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the complete dashboard user interface, interactive action dialogs, server actions, and E2E coverage for Purchasing & Suppliers (Spec 9 Task 8 Step 4 / Issue #140).

**Architecture:** Connects the domain services in `src/server/purchasing/` (`service.ts`, `receiving.ts`, `send.ts`, `variance.ts`, `suppliers.ts`, `reorder.ts`) to the Next.js App Router dashboard UI (`src/app/dashboard/purchase-orders` and `src/app/dashboard/suppliers`). Uses Server Components for data fetching, Server Actions for mutations with strict RBAC (`requirePurchasingPermission`), server-derived `branchId` resolution (`resolvePurchasingActor`), and state machine gating (`PO_TRANSITIONS`).

**Tech Stack:** Next.js 15 App Router (Server Components & Server Actions), React 19, Tailwind CSS, Lucide Icons, Shadcn UI primitives, Drizzle ORM + Postgres, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-17-dashboard-po-detail-and-purchasing-design.md`

## Global Constraints

- **Breaking changes in Next.js:** Route params are async (`{ params }: { params: Promise<{ id: string }> }`).
- **BranchId derivation:** `branchId` is NEVER accepted from client form bodies — always derived server-side via `resolvePurchasingActor(ctx)`.
- **Tax rates:** `taxRate` is a fractional decimal (`0.14` for 14% VAT), validated to `[0, 1]`.
- **Amounts:** Unit rates formatted via `formatUnitRate`, currency totals via `money()`.
- **Transitions:** UI buttons strictly driven by `PO_TRANSITIONS` (`src/server/purchasing/status.ts`).
- **Domain errors:** Cleanly caught and returned as user-friendly strings for `ToastForm` and toast alerts (never 500s).
- **Quality check:** Run `npx tsc --noEmit && npx eslint <files>` after every task.

---

### Task 1: PO List Supplier Join & Header Actions

**Files:**
- Modify: `src/server/purchasing/service.ts:183-191`
- Modify: `src/app/dashboard/purchase-orders/page.tsx:1-71`
- Test: `src/server/purchasing/service.test.ts`

**Interfaces:**
- Consumes: `purchaseOrders`, `suppliers` in `src/server/purchasing/schema.ts`
- Produces: `listPurchaseOrders(tenantId, opts)` returning `{ ...po, supplierName: string | null }`

- [ ] **Step 1: Write failing test in `src/server/purchasing/service.test.ts`**

```ts
it("listPurchaseOrders returns supplierName joined from suppliers", async () => {
  const { tenantId, branchId } = await seedInventoryTenant();
  const actor = await seedActor(tenantId, branchId);
  const supplierId = await seedSupplier(tenantId, branchId);
  const itemId = await seedItem(tenantId, { baseUom: "each" });

  await createDraftPo(actor, { supplierId, branchId, lines: [line(itemId)] });
  const [po] = await listPurchaseOrders(tenantId);

  expect(po?.supplierName).toBe("Supplier");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/purchasing/service.test.ts -t "supplierName"`
Expected: FAIL (property `supplierName` does not exist on return type)

- [ ] **Step 3: Update `listPurchaseOrders` in `src/server/purchasing/service.ts`**

```ts
export type PurchaseOrderListItem = PurchaseOrder & { supplierName: string | null };

export async function listPurchaseOrders(tenantId: string, opts: { status?: PoStatus } = {}): Promise<PurchaseOrderListItem[]> {
  return withTenant(tenantId, async (tx) => {
    const where = opts.status ? eq(purchaseOrders.status, opts.status) : undefined;
    const base = tx
      .select({
        po: purchaseOrders,
        supplierName: suppliers.name,
      })
      .from(purchaseOrders)
      .leftJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId));

    const rows = where
      ? await base.where(where).orderBy(sql`${purchaseOrders.createdAt} DESC`)
      : await base.orderBy(sql`${purchaseOrders.createdAt} DESC`);

    return rows.map((r) => ({ ...r.po, supplierName: r.supplierName }));
  });
}
```

- [ ] **Step 4: Update `src/app/dashboard/purchase-orders/page.tsx`**

Add clickable link to `/dashboard/purchase-orders/${po.id}`, Supplier column in table, and `PageHeader` action links for "Draft PO" (`/dashboard/purchase-orders/new`) and "Reorder rules" (`/dashboard/purchase-orders/reorder-rules`).

- [ ] **Step 5: Run tests and verify they pass**

Run: `npx vitest run src/server/purchasing/service.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/purchasing/service.ts src/server/purchasing/service.test.ts src/app/dashboard/purchase-orders/page.tsx
git commit -m "feat(purchasing): join supplier name in PO list and add action header links"
```

---

### Task 2: PO Drafting UI & Server Action (`/dashboard/purchase-orders/new`)

**Files:**
- Create: `src/app/dashboard/purchase-orders/actions.ts`
- Create: `src/app/dashboard/purchase-orders/new/page.tsx`
- Create: `src/app/dashboard/purchase-orders/new/DraftPoForm.tsx`
- Test: `src/app/dashboard/purchase-orders/actions.test.ts`

**Interfaces:**
- Consumes: `createDraftPo`, `listSuppliers`, `listItems`
- Produces: `createDraftPoAction(data: CreatePoFormData): Promise<{ poId: string } | { error: string }>`

- [ ] **Step 1: Write failing test in `src/app/dashboard/purchase-orders/actions.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { createDraftPoAction } from "./actions";

describe("purchase orders server actions", () => {
  it("createDraftPoAction rejects unauthenticated calls", async () => {
    const res = await createDraftPoAction({
      supplierId: "00000000-0000-0000-0000-000000000000",
      expectedAt: null,
      lines: [{ itemId: "00000000-0000-0000-0000-000000000000", qtyOrdered: 5, uom: "each", unitCost: 10, taxRate: 0.14 }],
    });
    expect(res).toHaveProperty("error");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/dashboard/purchase-orders/actions.test.ts`
Expected: FAIL (file or action not defined)

- [ ] **Step 3: Implement `src/app/dashboard/purchase-orders/actions.ts`**

Implement `createDraftPoAction` with `requirePurchasingPermission("purchasing:manage")`, `resolvePurchasingActor(ctx)` (derives `branchId`), fractional `taxRate` validation, and error formatting.

- [ ] **Step 4: Implement `src/app/dashboard/purchase-orders/new/page.tsx` and `DraftPoForm.tsx`**

Create server component page fetching active suppliers and inventory items, and client form allowing dynamic line additions, unit cost/tax calculation, live grand total, and submit redirecting to `/dashboard/purchase-orders/${poId}`.

- [ ] **Step 5: Run tests and verify they pass**

Run: `npx vitest run src/app/dashboard/purchase-orders/actions.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/app/dashboard/purchase-orders/actions.ts src/app/dashboard/purchase-orders/actions.test.ts src/app/dashboard/purchase-orders/new/
git commit -m "feat(purchasing): add PO drafting page and createDraftPoAction"
```

---

### Task 3: PO Detail Page & Three-Figure Variance Strip (`/dashboard/purchase-orders/[id]`)

**Files:**
- Create: `src/app/dashboard/purchase-orders/[id]/page.tsx`
- Create: `src/app/dashboard/purchase-orders/[id]/VarianceStrip.tsx`
- Test: `src/app/dashboard/purchase-orders/[id]/page.test.tsx`

**Interfaces:**
- Consumes: `getPurchaseOrder`, `getPoVariance`, `getSupplier`
- Produces: PO Detail view with header, lines table, receipts table, and three-figure variance strip (`ordered / received / invoiced` + deltas)

- [ ] **Step 1: Write test for VarianceStrip calculation and display in `src/app/dashboard/purchase-orders/[id]/page.test.tsx`**

Test that VarianceStrip renders `receivedVsOrdered` and `invoiceVsReceived` with appropriate color badges when `invoiceTotal` is set.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/dashboard/purchase-orders/[id]/page.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement `src/app/dashboard/purchase-orders/[id]/VarianceStrip.tsx` and `page.tsx`**

Render:
- PO Header: PO #, Status badge, Supplier name, Branch, Expected date, Created date
- VarianceStrip (when `po.invoiceTotal` is present or variance exists)
- Lines Table: Item name (`itemNameEn`), SKU, UoM, Qty Ordered, Unit Cost (`formatUnitRate`), Qty Received, Line Subtotal
- Receipts Table: Receipt ID, Delivery Note, Date, Received By, Lines received list

- [ ] **Step 4: Run tests and verify they pass**

Run: `npx vitest run src/app/dashboard/purchase-orders/[id]/page.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/purchase-orders/[id]/page.tsx src/app/dashboard/purchase-orders/[id]/VarianceStrip.tsx src/app/dashboard/purchase-orders/[id]/page.test.tsx
git commit -m "feat(purchasing): implement PO detail page and three-figure variance strip"
```

---

### Task 4: PO Lifecycle Actions & Dialogs (Send, Receive, Invoice, Close, Cancel)

**Files:**
- Create: `src/app/dashboard/purchase-orders/[id]/actions.ts`
- Create: `src/app/dashboard/purchase-orders/[id]/PoActionBar.tsx`
- Create: `src/app/dashboard/purchase-orders/[id]/ReceiveStockDialog.tsx`
- Create: `src/app/dashboard/purchase-orders/[id]/EnterInvoiceDialog.tsx`
- Test: `src/app/dashboard/purchase-orders/[id]/actions.test.ts`

**Interfaces:**
- Consumes: `sendPurchaseOrder`, `postReceipt`, `enterInvoiceTotal`, `closePurchaseOrder`, `cancelPurchaseOrder`, `PO_TRANSITIONS`
- Produces: `sendPoAction`, `cancelPoAction`, `postReceiptAction`, `enterInvoiceAction`, `closePoAction`

- [ ] **Step 1: Write failing test in `src/app/dashboard/purchase-orders/[id]/actions.test.ts`**

Test `postReceiptAction` and `enterInvoiceAction` validation and error handling for transitions.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/dashboard/purchase-orders/[id]/actions.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement Server Actions in `src/app/dashboard/purchase-orders/[id]/actions.ts`**

Wrap domain functions (`sendPurchaseOrder`, `postReceipt`, `enterInvoiceTotal`, `closePurchaseOrder`, `cancelPurchaseOrder`) in `"use server"` actions with permission checks and `revalidatePath`.

- [ ] **Step 4: Implement Dialog Components & Action Bar**

- `ReceiveStockDialog.tsx`: Shows table of lines with `qtyRemaining`, inputs for `receivedQty`, `deliveryNote`, and optional `expiryAt`.
- `EnterInvoiceDialog.tsx`: Input for invoice total amount with live delta preview.
- `PoActionBar.tsx`: Buttons for Send, Receive, Enter Invoice, Close, Cancel rendered conditionally based on `PO_TRANSITIONS[po.status]`.

- [ ] **Step 5: Run tests and verify they pass**

Run: `npx vitest run src/app/dashboard/purchase-orders/[id]/actions.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/app/dashboard/purchase-orders/[id]/actions.ts src/app/dashboard/purchase-orders/[id]/PoActionBar.tsx src/app/dashboard/purchase-orders/[id]/ReceiveStockDialog.tsx src/app/dashboard/purchase-orders/[id]/EnterInvoiceDialog.tsx src/app/dashboard/purchase-orders/[id]/actions.test.ts
git commit -m "feat(purchasing): add PO lifecycle action bar, receive dialog, and invoice entry"
```

---

### Task 5: Supplier Detail & Supplier-Items Management (`/dashboard/suppliers/[id]`)

**Files:**
- Create: `src/app/dashboard/suppliers/[id]/page.tsx`
- Create: `src/app/dashboard/suppliers/[id]/EditSupplierForm.tsx`
- Create: `src/app/dashboard/suppliers/[id]/SupplierItemCatalog.tsx`
- Modify: `src/app/dashboard/suppliers/actions.ts`
- Modify: `src/app/dashboard/suppliers/page.tsx` (link table rows to detail)
- Test: `src/app/dashboard/suppliers/actions.test.ts`

**Interfaces:**
- Consumes: `getSupplier`, `updateSupplier`, `listSupplierItems`, `upsertSupplierItem`
- Produces: `updateSupplierAction`, `upsertSupplierItemAction`

- [ ] **Step 1: Write failing test in `src/app/dashboard/suppliers/actions.test.ts`**

Test `updateSupplierAction` and `upsertSupplierItemAction`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/dashboard/suppliers/actions.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement Actions & Components**

- `updateSupplierAction`: Partial update preserving omitted fields.
- `upsertSupplierItemAction`: Add/update SKU, last unit cost, and pack UoM for a supplier's item.
- `src/app/dashboard/suppliers/[id]/page.tsx`: Shows edit form and supplier-item mapping table.
- Link rows in `/dashboard/suppliers/page.tsx` to `/dashboard/suppliers/[id]`.

- [ ] **Step 4: Run tests and verify they pass**

Run: `npx vitest run src/app/dashboard/suppliers/actions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/suppliers/[id]/ src/app/dashboard/suppliers/actions.ts src/app/dashboard/suppliers/page.tsx src/app/dashboard/suppliers/actions.test.ts
git commit -m "feat(suppliers): add supplier detail editing and supplier-item catalog management"
```

---

### Task 6: Reorder Rules UI & Manual Sweep (`/dashboard/purchase-orders/reorder-rules`)

**Files:**
- Create: `src/app/dashboard/purchase-orders/reorder-rules/page.tsx`
- Create: `src/app/dashboard/purchase-orders/reorder-rules/ReorderRuleForm.tsx`
- Create: `src/app/dashboard/purchase-orders/reorder-rules/actions.ts`
- Test: `src/app/dashboard/purchase-orders/reorder-rules/actions.test.ts`

**Interfaces:**
- Consumes: `listReorderRules`, `upsertReorderRule`, `checkReorder`
- Produces: `upsertReorderRuleAction`, `runReorderCheckAction`

- [ ] **Step 1: Write failing test in `src/app/dashboard/purchase-orders/reorder-rules/actions.test.ts`**

Test `upsertReorderRuleAction` and `runReorderCheckAction`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/dashboard/purchase-orders/reorder-rules/actions.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement Reorder Rules Actions & Page**

- `upsertReorderRuleAction`: Validates `reorderPoint` and `reorderQty`, calls `upsertReorderRule`.
- `runReorderCheckAction`: Calls `checkReorder(actor)` and reports summary count of low stock notifications / draft POs created.
- `page.tsx` & `ReorderRuleForm.tsx`: Table of rules + drawer/form to add or edit a rule.

- [ ] **Step 4: Run tests and verify they pass**

Run: `npx vitest run src/app/dashboard/purchase-orders/reorder-rules/actions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/purchase-orders/reorder-rules/
git commit -m "feat(purchasing): add reorder rules UI and manual check sweep trigger"
```

---

### Task 7: RBAC Nav Guarding & End-to-End Playwright Spec

**Files:**
- Modify: `src/components/dashboard/nav-items.test.ts`
- Create: `tests/e2e/purchasing.spec.ts`

**Interfaces:**
- Consumes: All Purchasing & Suppliers UI routes and server actions
- Produces: Playwright E2E happy-path spec and RBAC nav assertions

- [ ] **Step 1: Extend `src/components/dashboard/nav-items.test.ts`**

Assert that role `staff` has neither `"Purchasing"` nor `"Suppliers"` nav items present in `dashboardNavItems(roleKeys)`.

- [ ] **Step 2: Run nav test to verify**

Run: `npx vitest run src/components/dashboard/nav-items.test.ts`
Expected: PASS

- [ ] **Step 3: Implement Playwright E2E spec `tests/e2e/purchasing.spec.ts`**

Cover complete user journey:
1. Manager logs in, navigates to `/dashboard/purchase-orders`.
2. Creates a draft PO for 10 units of an ingredient at 12.00 EGP.
3. Clicks **Send** on detail page → status changes to `sent`.
4. Clicks **Receive**, enters partial receipt of 4 units → status flips to `partially_received`.
5. Clicks **Receive**, enters remaining 6 units → status flips to `received`.
6. Clicks **Enter invoice**, enters 132.00 EGP → variance strip shows `invoiceVsReceived = +12.00`.
7. Clicks **Close** → status flips to `closed`.

- [ ] **Step 4: Run complete test suite and linters**

Run:
```bash
npx vitest run src/app/dashboard src/components/dashboard src/server/purchasing
npx tsc --noEmit
npx eslint src/app/dashboard src/components/dashboard
```
Expected: All pass with 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/nav-items.test.ts tests/e2e/purchasing.spec.ts
git commit -m "test(purchasing): add Playwright E2E spec and nav RBAC test coverage"
```
