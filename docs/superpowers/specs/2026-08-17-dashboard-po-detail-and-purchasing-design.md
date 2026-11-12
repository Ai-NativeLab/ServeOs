# Dashboard UI: Purchase Orders Detail, Drafting, Suppliers, and Reorder Rules Design

**Issue Reference:** [Ai-NativeLab/ServeOs#140](https://github.com/Ai-NativeLab/ServeOs/issues/140)  
**Parent Epic:** #117 (Spec 9 — Suppliers & Purchasing)  
**Date:** 2026-08-17  

---

## 1. Goal & Overview

Deliver the complete dashboard user interface and mutation surface for **Purchasing & Suppliers** (Spec 9 Task 8 Step 4). This connects the backend domain services (`src/server/purchasing/`) with the Next.js App Router dashboard UI, enabling managers to draft, send, receive, invoice, and close purchase orders, manage suppliers and item catalogs, and configure automatic low-stock reorder rules.

---

## 2. User Journey & State Transitions

1. **PO List & Navigation:**
   - Manager opens `/dashboard/purchase-orders`. The table displays PO number, supplier name (joined), status badge, total, expected date, and creation date.
   - Header provides buttons for **"Draft PO"** (`/dashboard/purchase-orders/new`) and **"Reorder rules"** (`/dashboard/purchase-orders/reorder-rules`).
2. **PO Drafting (`/dashboard/purchase-orders/new`):**
   - Manager selects an active supplier, sets an expected delivery date and optional notes.
   - Line items can be added dynamically (selecting inventory item, quantity, UoM, unit cost, and optional tax rate). The client displays real-time line subtotals and grand total.
   - On submit, `createDraftPoAction` derives `branchId` server-side via `resolvePurchasingActor(ctx)` (never trusted from client) and saves the draft PO, redirecting to `/dashboard/purchase-orders/[id]`.
3. **PO Detail & Lifecycle Actions (`/dashboard/purchase-orders/[id]`):**
   - Displays header meta (PO #, Status, Supplier, Branch, Expected Date, Created Date).
   - Shows line items table (Item name, SKU, UoM, Qty Ordered, Unit Cost, Qty Received, Line Total).
   - Shows posted receipts history table (Receipt #, Delivery Note, Date, Received By, Lines received).
   - **Variance Strip:** Displays when `invoiceTotal` is present, highlighting:
     - Ordered Total vs Received Total (`receivedVsOrdered` delta)
     - Received Total vs Invoiced Total (`invoiceVsReceived` delta)
   - **Action Bar:** Gated by `PO_TRANSITIONS` and `purchasing:manage`:
     - `draft` → **Send** (triggers send action + email outbox) | **Cancel** | **Edit Draft**
     - `sent` / `partially_received` → **Receive Stock** (opens modal) | **Cancel** (if no receipts exist)
     - `partially_received` / `received` → **Enter Invoice** (opens modal) | **Close** (if invoiced)
4. **Receiving Flow (`ReceiveStockDialog`):**
   - Modal displays all lines with remaining quantities to receive (`qtyOrdered - qtyReceived`).
   - Manager enters received quantities per line, delivery note number, and optional lot expiry date.
   - Submits `postReceiptAction` → converts to base UoM, invokes `receiveStock` (generating lots + ledger rows), updates PO status to `partially_received` or `received`.
5. **Invoice Entry & Closing (`EnterInvoiceDialog`):**
   - Manager enters final supplier invoice total amount.
   - Live preview shows variance against received value.
   - Once invoiced, manager can click **Close** to finalize the PO.
6. **Supplier & Catalog Management (`/dashboard/suppliers/[id]`):**
   - Edit supplier details (Name, Contact, Email, Phone, Payment Terms, Notes, Active toggle).
   - Manage supplier-specific item catalog (Item link, Supplier SKU, Last Unit Cost, Pack UoM).
7. **Reorder Rules Management (`/dashboard/purchase-orders/reorder-rules`):**
   - Lists configured reorder rules per item and location with reorder point, reorder quantity, and preferred supplier.
   - Create/edit rule modal/form (`ReorderRuleForm`).
   - Manual **"Run check now"** button to execute the replenishment check sweep immediately.

---

## 3. UI Component & Route Structure

```
src/app/dashboard/
├── purchase-orders/
│   ├── page.tsx                           # PO List (with supplier join & action buttons)
│   ├── actions.ts                         # PO creation & draft update actions
│   ├── new/
│   │   ├── page.tsx                       # Dedicated PO Draft Creator
│   │   └── DraftPoForm.tsx                # Dynamic line-items form component
│   ├── [id]/
│   │   ├── page.tsx                       # PO Detail page (header, lines, receipts, variance)
│   │   ├── actions.ts                     # Lifecycle actions (send, cancel, close, receive, invoice)
│   │   ├── PoActionBar.tsx                # Action button bar driven by PO_TRANSITIONS
│   │   ├── VarianceStrip.tsx              # Three-figure variance comparison card
│   │   ├── ReceiveStockDialog.tsx         # Modal for posting stock receipts
│   │   └── EnterInvoiceDialog.tsx         # Modal for recording supplier invoice total
│   └── reorder-rules/
│       ├── page.tsx                       # Reorder rules list & manual sweep trigger
│       ├── actions.ts                     # Reorder rule CRUD & run check actions
│       └── ReorderRuleForm.tsx            # Form to add/edit reorder rules
└── suppliers/
    ├── page.tsx                           # Suppliers list & quick-add form
    ├── actions.ts                         # Base supplier creation
    └── [id]/
        ├── page.tsx                       # Supplier edit & supplier-items catalog
        ├── actions.ts                     # Supplier update & upsert supplier item actions
        ├── EditSupplierForm.tsx           # Supplier info edit form
        └── SupplierItemCatalog.tsx        # Supplier item mapping table & add modal
```

---

## 4. Server Actions & Backend Seams

All server actions follow the established codebase pattern:
1. Call `requirePurchasingPermission("purchasing:manage")` (or `"suppliers:manage"`).
2. Call `resolvePurchasingActor(ctx)` to securely extract `tenantId`, `userId`, and `branchId`.
3. Invoke pure domain services in `src/server/purchasing/`:
   - `createDraftPo` / `updateDraftPo` / `cancelPurchaseOrder` (`service.ts`)
   - `sendPurchaseOrder` (`send.ts`)
   - `postReceipt` (`receiving.ts`)
   - `enterInvoiceTotal` / `closePurchaseOrder` (`variance.ts`)
   - `updateSupplier` / `upsertSupplierItem` (`suppliers.ts`)
   - `upsertReorderRule` / `checkReorder` (`reorder.ts`)
4. Catch domain errors and return `{ error: string }` formatted for toast display.
5. Call `revalidatePath(...)` to refresh Server Component data.

---

## 5. Security, Validation & Display Rules

- **Branch ID derivation:** `branchId` is NEVER passed from the client; it is always derived server-side via `resolvePurchasingActor(ctx)`.
- **Tax Rate validation:** `taxRate` is validated as a decimal fraction between `0` and `1` (e.g. `0.14` for 14% VAT).
- **Amounts formatting:** Per-unit costs use exact rate display via `formatUnitRate`; currency totals formatted via `money()`.
- **Transitions:** UI buttons render only if the state transition exists in `PO_TRANSITIONS` (`src/server/purchasing/status.ts`).
- **RBAC:** `staff` role has no `purchasing:manage` or `suppliers:manage` permissions; nav entries are hidden and all action attempts return unauthorized errors.

---

## 6. Testing & Verification Plan

1. **Nav RBAC Tests:** Extend `src/components/dashboard/nav-items.test.ts` to assert that `staff` users do not see Purchasing or Suppliers nav links.
2. **Server Action & Route Tests:** Vitest unit tests verifying permission gating, error mapping, and proper service delegation.
3. **Playwright E2E Spec (`tests/e2e/purchasing.spec.ts`):**
   - Step 1: Owner logs in and navigates to Purchasing.
   - Step 2: Creates a new supplier and adds a supplier item.
   - Step 3: Drafts a new PO for 10 units at 12.00 EGP.
   - Step 4: Sends the PO to the supplier (status → `sent`).
   - Step 5: Posts a partial receipt of 4 units (status → `partially_received`, checks inventory lot created).
   - Step 6: Posts remaining 6 units receipt (status → `received`).
   - Step 7: Enters invoice total of 132.00 EGP and verifies variance calculation (`+12.00` delta).
   - Step 8: Closes the PO (status → `closed`).
