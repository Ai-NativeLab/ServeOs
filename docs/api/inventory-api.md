# Inventory API Reference

This document provides a reference for the ServeOS Inventory API, which manages items, stock levels, warehouses, and stock movements.

## Authentication & Authorization

All Inventory API routes authenticate via a dashboard session cookie and require specific RBAC (Role-Based Access Control) permissions.

- **Context Resolver**: `resolveInventoryContext(permission)`
- **Session**: Standard Next.js / NextAuth session cookie.
- **Permissions**: Defined per endpoint (e.g., `inventory.read`, `inventory.write`, `stock.adjust`).

> [!NOTE]
> All endpoints expect standard `application/json` payloads unless otherwise specified.

---

## Items & Catalog

### GET /api/inventory/items

Lists all inventory items with pagination and filtering.

- **Auth**: `inventory.read`
- **Query Params**: `limit`, `offset`, `search`, `categoryId`
- **Response**: 
  ```typescript
  {
    items: InventoryItem[];
    total: number;
  }
  ```

### POST /api/inventory/items

Creates a new inventory item.

- **Auth**: `inventory.write`
- **Request Body**:
  ```typescript
  {
    sku: string;
    name: string;
    categoryId: string;
    unitOfMeasure: string;
    costPrice: number;
  }
  ```
- **Response**: `{ item: InventoryItem }`

### GET /api/inventory/items/[id]

Retrieves details for a specific item.

- **Auth**: `inventory.read`
- **Response**: `{ item: InventoryItem }`

### PUT /api/inventory/items/[id]

Updates an existing item.

- **Auth**: `inventory.write`
- **Request Body**: Partial `<InventoryItem>`
- **Response**: `{ item: InventoryItem }`

### DELETE /api/inventory/items/[id]

Soft deletes an inventory item.

- **Auth**: `inventory.delete`
- **Response**: `{ success: true }`

---

## Categories

### GET /api/inventory/categories

Lists inventory categories.

- **Auth**: `inventory.read`
- **Response**: `{ categories: Category[] }`

### POST /api/inventory/categories

Creates a category.

- **Auth**: `inventory.write`
- **Request Body**: `{ name: string, parentId?: string }`
- **Response**: `{ category: Category }`

---

## Warehouses & Locations

### GET /api/inventory/warehouses

Lists all warehouses or stock locations for the tenant.

- **Auth**: `inventory.read`
- **Response**: `{ warehouses: Warehouse[] }`

### POST /api/inventory/warehouses

Creates a new warehouse.

- **Auth**: `inventory.write`
- **Request Body**: `{ name: string, address?: string, isActive: boolean }`
- **Response**: `{ warehouse: Warehouse }`

---

## Stock & Movements

### GET /api/inventory/stock

Retrieves current stock levels across all locations or filtered by warehouse.

- **Auth**: `inventory.read`
- **Query Params**: `warehouseId`, `itemId`
- **Response**: 
  ```typescript
  {
    stockLevels: Array<{
      itemId: string;
      warehouseId: string;
      quantity: number;
    }>
  }
  ```

### POST /api/inventory/stock/adjustments

Records a manual stock adjustment (shrinkage, damage, audit correction).

- **Auth**: `stock.adjust`
- **Request Body**:
  ```typescript
  {
    itemId: string;
    warehouseId: string;
    quantityDelta: number;
    reason: "damage" | "loss" | "audit" | "other";
    notes?: string;
  }
  ```
- **Response**: `{ adjustment: StockAdjustment }`

### GET /api/inventory/stock/adjustments

Lists historical stock adjustments.

- **Auth**: `inventory.read`
- **Query Params**: `limit`, `offset`, `warehouseId`
- **Response**: `{ adjustments: StockAdjustment[], total: number }`

### POST /api/inventory/stock/transfers

Initiates a stock transfer between two warehouses.

- **Auth**: `stock.transfer`
- **Request Body**:
  ```typescript
  {
    sourceWarehouseId: string;
    targetWarehouseId: string;
    items: Array<{ itemId: string, quantity: number }>;
  }
  ```
- **Response**: `{ transfer: StockTransfer }`

### POST /api/inventory/stock/transfers/[id]/receive

Marks a stock transfer as received at the destination.

- **Auth**: `stock.transfer`
- **Response**: `{ transfer: StockTransfer }`
