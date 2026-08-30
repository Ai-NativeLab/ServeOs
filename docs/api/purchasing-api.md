# Purchasing & Suppliers API Reference

This document covers the APIs used for managing suppliers and purchase orders (POs) in ServeOS.

## Authentication & Authorization

All Purchasing API routes authenticate via a dashboard session cookie and require specific RBAC permissions.

- **Context Resolver**: `resolvePurchasingContext(permission)`
- **Session**: Standard Next.js / NextAuth session cookie.
- **Permissions**: Defined per endpoint (e.g., `purchasing.read`, `purchasing.write`, `suppliers.read`).

> [!IMPORTANT]
> The Purchasing API is closely tied to the Inventory API. When POs are received, stock levels are automatically updated in the Inventory system.

---

## Suppliers

### GET /api/suppliers

Lists all active suppliers.

- **Auth**: `suppliers.read`
- **Query Params**: `limit`, `offset`, `search`
- **Response**: 
  ```typescript
  {
    suppliers: Supplier[];
    total: number;
  }
  ```

### POST /api/suppliers

Creates a new supplier record.

- **Auth**: `suppliers.write`
- **Request Body**:
  ```typescript
  {
    name: string;
    contactName?: string;
    email?: string;
    phone?: string;
    taxId?: string;
    address?: Address;
  }
  ```
- **Response**: `{ supplier: Supplier }`

### GET /api/suppliers/[id]

Gets details for a specific supplier.

- **Auth**: `suppliers.read`
- **Response**: `{ supplier: Supplier }`

### PUT /api/suppliers/[id]

Updates supplier details.

- **Auth**: `suppliers.write`
- **Request Body**: Partial `<Supplier>`
- **Response**: `{ supplier: Supplier }`

### DELETE /api/suppliers/[id]

Deactivates a supplier (soft delete).

- **Auth**: `suppliers.delete`
- **Response**: `{ success: true }`

---

## Purchase Orders

### GET /api/purchase-orders

Lists purchase orders.

- **Auth**: `purchasing.read`
- **Query Params**: `limit`, `offset`, `status`, `supplierId`
- **Response**: 
  ```typescript
  {
    orders: PurchaseOrder[];
    total: number;
  }
  ```

### POST /api/purchase-orders

Creates a new Draft purchase order.

- **Auth**: `purchasing.write`
- **Request Body**:
  ```typescript
  {
    supplierId: string;
    destinationWarehouseId: string;
    expectedDeliveryDate?: string;
    items: Array<{
      itemId: string;
      quantity: number;
      unitCost: number;
    }>;
  }
  ```
- **Response**: `{ order: PurchaseOrder }`

### GET /api/purchase-orders/[id]

Gets detailed information for a specific PO.

- **Auth**: `purchasing.read`
- **Response**: `{ order: PurchaseOrder }`

### POST /api/purchase-orders/[id]/submit

Transitions a Draft PO to Submitted (sent to supplier).

- **Auth**: `purchasing.write`
- **Response**: `{ order: PurchaseOrder }`

### POST /api/purchase-orders/[id]/receive

Records receipt of goods against a PO, updating inventory. Supports partial receiving.

- **Auth**: `purchasing.receive`
- **Request Body**:
  ```typescript
  {
    itemsReceived: Array<{
      itemId: string;
      quantityReceived: number;
    }>;
    notes?: string;
  }
  ```
- **Response**: `{ order: PurchaseOrder, receipt: GoodsReceipt }`

### POST /api/purchase-orders/[id]/cancel

Cancels an open PO.

- **Auth**: `purchasing.write`
- **Request Body**: `{ reason: string }`
- **Response**: `{ order: PurchaseOrder }`
