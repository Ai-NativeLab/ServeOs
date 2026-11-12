# Inventory API Reference (`/api/inventory/*`)

Route handlers in `src/app/api/inventory/`. Services live in `src/server/inventory/` (`service.ts`, `read.ts`, `recipes.ts`) and, for reorder, `src/server/purchasing/reorder.ts`.

## Authentication & permissions

These are **staff** routes. The caller is identified by the self-hosted `serveos_session` cookie (an opaque token in the `sessions` table — there is no NextAuth). Every handler starts with `resolveInventoryContext("<permission>")` (`src/app/dashboard/inventory-permission.ts`), which:

- returns **401** `{ error: "Unauthorized" }` when there is no valid session, and
- returns **403** when the user's roles lack the permission (`authorize` in `src/server/rbac/authorize.ts`).

| Permission | Granted to (see `src/server/rbac/permissions.ts`) | Used for |
| :--- | :--- | :--- |
| `inventory:view` | owner, manager, staff | reads |
| `inventory:count` | owner, manager, staff | opening counts, adding count lines, committing counts |
| `inventory:manage` | owner, manager | items, receipts, adjustments, transfers, recipes, product links |
| `purchasing:manage` | owner, manager | `reorder-rules` and `reorder/check` (these use `resolvePurchasingContext`) |

All writes run inside `withTenant(tenantId, …)`, so RLS scopes them to the caller's tenant. Error responses are `{ error: string }`; `DimensionalUomError` / `InventoryConfigError` map to 400 and `CapabilityNotEnabledError` (e.g. recipes on a non-restaurant vertical) to 409.

## Endpoints

### Items

#### GET /api/inventory/items — `inventory:view`
Query: `kind` (`ingredient` | `finished_good` | `raw_material`), `isActive` (`true`/`false`), `limit`. Returns an array of `inventory_items` rows.

#### POST /api/inventory/items — `inventory:manage`
Body: `{ nameEn, nameAr, kind, baseUom, sku?, stockUom?, stockToBase?, purchaseUom?, purchaseToBase?, recipeUom?, recipeToBase?, isPerishable?, defaultUnitCost? }`. `nameEn`, `nameAr`, `kind`, `baseUom` are required. Units default to `baseUom` and factors to `"1"`; every unit must be a stockable unit and in the same dimension as `baseUom`. **201** with the created row.

#### PATCH /api/inventory/items/[id] — `inventory:manage`
Any of `nameEn`, `nameAr`, `sku`, `kind`, `isPerishable`, `isActive`, `defaultUnitCost`, `stockUom`, `purchaseUom`, `recipeUom`, `stockToBase`, `purchaseToBase`, `recipeToBase`. `baseUom` cannot be changed (400) because ledger rows are stored in it. 404 if the item is not visible to the tenant.

### Stock movements

#### POST /api/inventory/receipts — `inventory:manage`
Goods in without a purchase order. Body: `{ itemId, locationId, uom, qty, unitCost?, lotCode?, expiryAt?, lengthMm?, byPurchaseUnit?, note? }`. `qty` must be positive; `unitCost` must be finite and ≥ 0. Creates an `inventory_lots` row and a `receive` ledger row, and records an `inventory.received` audit event. **201** `{ ok: true, lotId }`.

#### POST /api/inventory/adjustments — `inventory:manage`
Body: `{ itemId, locationId, uom, baseQty: number, type?: "adjustment" | "waste", lotId?, note? }`. **201** `{ ok: true }`.

#### POST /api/inventory/transfers — `inventory:manage`
Body: `{ itemId, fromLocationId, toLocationId, uom, baseQty: number, note? }`. Both legs commit in one transaction; source and destination must differ. **201** `{ ok: true }`.

#### GET /api/inventory/on-hand — `inventory:view`
Query: `itemId?`, `locationId?`. Returns `{ onHand, lots }`; `lots` is only populated when `itemId` is given.

### Stock counts

#### GET /api/inventory/counts — `inventory:view`
Query: `status` (`open` | `committed` | `cancelled`), `limit`.

#### POST /api/inventory/counts — `inventory:count`
Body: `{ branchId, locationId, lines?: { itemId, countedQty }[] }`. Snapshots each line's system quantity at open time. **201** with the count.

#### POST /api/inventory/counts/[id]/lines — `inventory:count`
Body: `{ lines: { itemId, countedQty }[] }` (non-empty). Re-submitting an item corrects it. **201** `{ ok: true, added }`.

#### POST /api/inventory/counts/[id]/commit — `inventory:count`
Writes one `count` ledger row per discrepant line and closes the count; committing twice is rejected. **200** `{ ok: true }`.

### Recipes (restaurant vertical)

#### GET /api/inventory/recipes — `inventory:view`
#### POST /api/inventory/recipes — `inventory:manage`
Body: `{ nameEn, nameAr, yieldQty?, yieldUom?, components? }`. **201** with the recipe.
#### GET /api/inventory/recipes/[id] — `inventory:view`
404 if not found.
#### PATCH /api/inventory/recipes/[id] — `inventory:manage`
Any of `nameEn`, `nameAr`, `yieldQty`, `yieldUom`, `isActive`; and/or `components`, which **replaces** the whole component list. Returns the updated recipe.

### Product links

#### GET /api/inventory/product-links — `inventory:view`
#### POST /api/inventory/product-links — `inventory:manage`
Body: `{ productId, variantId?, linkType: "recipe", recipeId }` or `{ productId, variantId?, linkType: "finished_good", itemId }`. This is the row `placeOrder` resolves to deduct stock; a product with no link sells without touching inventory. **201** with the link.
#### DELETE /api/inventory/product-links — `inventory:manage`
Query: `productId` (required), `variantId?`. **200** `{ ok: true }`.

### Reorder

#### GET /api/inventory/reorder-rules — `purchasing:manage`
Returns `{ rules }`.
#### PUT /api/inventory/reorder-rules — `purchasing:manage`
Body: `{ itemId, locationId, reorderPoint ≥ 0, reorderQty > 0, preferredSupplierId? }`. **201** `{ ok: true }`.
#### POST /api/inventory/reorder/check — `purchasing:manage`
Runs the reorder sweep now (the same function `.github/workflows/reorder-check.yml` runs daily via `scripts/reorder-check.ts`). Returns the run result.
