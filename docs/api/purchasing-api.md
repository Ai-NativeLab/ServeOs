# Purchasing & Supplier API Reference

Route handlers in `src/app/api/purchase-orders/` and `src/app/api/suppliers/`; services in `src/server/purchasing/`. The dashboard uses the equivalent Server Actions (`src/app/dashboard/purchase-orders/**/actions.ts`, `src/app/dashboard/suppliers/actions.ts`); these routes expose the same operations as JSON.

## Authentication & permissions

Staff routes: `serveos_session` cookie, resolved by `resolvePurchasingContext("<permission>")` (`src/app/dashboard/purchasing-permission.ts`) — **401** without a session, **403** without the permission.

| Routes | Permission | Roles holding it |
| :--- | :--- | :--- |
| `/api/purchase-orders/**` | `purchasing:manage` | owner, manager |
| `/api/suppliers/**` | `suppliers:manage` | owner, manager |

Mutations also resolve a **purchasing actor** (`resolvePurchasingActor`): the user plus a branch. A user with no branch gets **409** (`NoBranchError`).

Common errors (`src/app/api/purchasing-errors.ts` and the inline mappings): 404 `PoNotFoundError`, 409 `InvalidPoTransitionError`, 422 `SupplierEmailMissingError`, 400 `InvalidPoInputError` / `ReceiptUomMismatchError`, 400 `{ error: "Invalid JSON" }`.

PO statuses and allowed transitions are in [state-machines.md §4](../flows/state-machines.md#4-purchase-order-lifecycle-po_status).

## Suppliers — `suppliers:manage`

| Method & path | Body | Success |
| :--- | :--- | :--- |
| `GET /api/suppliers` | — | `{ suppliers }` |
| `POST /api/suppliers` | `{ name, contactName?, email?, phone?, paymentTerms?, notes? }` | **201** `{ id }` |
| `PATCH /api/suppliers/[id]` | any of `name` (non-empty), `contactName`, `email`, `phone`, `paymentTerms`, `notes` (string or `null`), `isActive` (boolean) | `{ supplier }`; 404 if not found; 400 if nothing to update |
| `GET /api/suppliers/[id]/items` | — | `{ items }` |
| `POST /api/suppliers/[id]/items` | `{ itemId, supplierSku?, lastUnitCost? (finite, ≥ 0), packUom? (a stockable unit) }` | **201** `{ ok: true }` (upsert) |

## Purchase orders — `purchasing:manage`

### GET /api/purchase-orders
Query: `status?`. Returns `{ purchaseOrders }`.

### POST /api/purchase-orders
Creates a **draft**.
```ts
{
  supplierId: string;
  branchId: string;
  expectedAt?: string;            // ISO date
  lines: {
    itemId: string;
    qtyOrdered: number;           // > 0
    unitCost: number;             // ≥ 0
    uom: string;
    taxRate?: number;             // a fraction (0.14), not a percentage
  }[];                            // non-empty
}
```
**201** `{ poId, poNumber }`.

### GET /api/purchase-orders/[id]
`{ purchaseOrder }`; 404 `{ error: "Purchase order not found" }`.

### PATCH /api/purchase-orders/[id]
Replaces a draft's `supplierId`, `branchId`, `expectedAt` and `lines` (same shape as create). 409 if the PO is no longer a draft. **200** `{ ok: true }`.

### POST /api/purchase-orders/[id]/send
Renders the PO as HTML and queues it to the supplier's email through the notification outbox, sets status `sent` and notifies owners/managers in-app. Re-sending a `sent` PO is allowed. **422** if the supplier has no email. **200** `{ ok: true }`.

### POST /api/purchase-orders/[id]/receipts
Posts a goods receipt.
```ts
{
  supplierDeliveryNote?: string;
  note?: string;
  lines: { poLineId: string; receivedQty: number /* > 0 */; uom: string; lotCode?: string; expiryAt?: string }[];
}
```
`unitCost` is **rejected** (400): the lot is valued from the ordered PO line. Creates `po_receipts` / `po_receipt_lines`, inventory lots and `receive` ledger rows, and moves the PO to `partially_received` or `received`. **201** `{ receiptId, status }`.

### PATCH /api/purchase-orders/[id]/invoice
Body: `{ invoiceTotal: number }` (finite, ≥ 0). Records the supplier invoice total for variance. **200** `{ ok: true }`. Only a `sent`, `partially_received` or `received` PO accepts an invoice; on any other status the service throws `InvalidPoTransitionError`, which this route does not map, so the caller currently gets a 500.

### GET /api/purchase-orders/[id]/variance
`{ variance }` — ordered vs received vs invoiced (`getPoVariance`).

### POST /api/purchase-orders/[id]/close
Closes a `received` PO. **200** `{ ok: true }`.

### POST /api/purchase-orders/[id]/cancel
Cancels a `draft` or `sent` PO. **200** `{ ok: true }`.
