# ServeOS — Inventory, Recipes & Purchasing Design

**Date:** 2026-07-24
**Status:** Draft — pending review
**Scope:** Specs 8 **and** 9 of the roadmap, designed together because they are one subsystem: you cannot receive against a purchase order until inventory exists, and inventory without a way to replenish it is a half-built ledger. This is the largest single body of work in the sequence. It replaces today's flat integer stock counter with a per-branch, unit-aware, append-only **stock ledger**; teaches `placeOrder` to deduct a dish's ingredients (recipe/BOM) or a retail item's finished-goods stock; and adds suppliers, purchase orders, receiving, and low-stock reorder. It implements locked decisions **D4** (recipe/BOM auto-deduction) and **D5** (PO tracking + receiving + send-to-supplier).

## Context

Stock today is one number. `products.stockQuantity` and `product_variants.stockQuantity` are nullable **integers** (`src/server/catalog/schema.ts:31,48`). `placeOrder` decrements them with a guarded `UPDATE` whose `WHERE` is the concurrency serialization point (`src/server/ordering/service.ts:151-172`), and cancels/refunds add them back (`restockOrderItems`, `service.ts:279-295`). The whole mechanism is gated on the vertical capability `stockTracking`: **on** for retail / pharmacy / timber, **off** for restaurant (`src/server/verticals/registry.ts:7,31,51,71`). `setProductStock` / `setVariantStock` (`src/server/catalog/variants.ts:58-70`) are the only writers besides the order path.

Four facts about that model are the reason this spec is large, and each must be addressed head-on:

1. **Restaurants track no stock at all.** `stockTracking:false`, and dishes are **made-to-order** — a "Margherita" is not a countable thing on a shelf, it is flour + tomato + mozzarella assembled on demand. There is nothing to decrement, which is exactly why the capability is off.
2. **Stock is a single global integer, not per-branch.** `branch_product_availability` carries only `isAvailable` (boolean) and `priceOverride` (`schema.ts:79-90`) — **no quantity**. A tenant with three branches has one number for the whole company. A branch cannot know what is on its own shelf.
3. **There is no unit of measure anywhere.** The integer is dimensionless. You cannot say "500 g of mozzarella" or "buy a 24-can case, sell by the can."
4. **No lots, no ledger, no recipes exist.** There is no cost layer, no expiry, no history of why a number changed, and no concept of a dish being composed of ingredients.

## Problem

D4 requires that selling a dish deducts its ingredient lots FIFO and that retail items deduct finished-goods stock; D5 requires a full purchase-order lifecycle with receiving that increments those lots. A single global integer with no units, no branches, no cost, and no recipe cannot express any of that. Restaurants — the vertical that most needs ingredient-level control — are the one vertical with stock tracking switched off. And the retail path that *does* work today must keep working through the migration without a gap.

## Goal

Build the inventory substrate the rest of the platform assumes: a **per-branch, unit-aware, append-only stock ledger** with cost-carrying lots; recipes that let a made-to-order dish deduct its ingredients; suppliers and purchase orders that replenish lots by receiving; and a scheduled low-stock reorder loop. Turn the `inventory` capability **on for restaurants** without ever blocking a kitchen at the till. Preserve the existing guarded-update concurrency guarantee, the `money(n)` numeric-string convention, and RLS tenancy throughout.

## Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| D4 | Inventory depth | **Recipe/BOM auto-deduction.** Selling a dish deducts its ingredient lots FIFO from the branch kitchen; retail items deduct finished-goods stock from the branch retail location. Requires a stock **ledger**, **unit of measure**, **per-branch storage locations**, and **fractional** quantities. |
| D5 | Suppliers & purchasing | **PO tracking + receiving + send-to-supplier.** Full PO lifecycle, receiving against a PO increments lots (partial receipts supported), PO-vs-received-vs-invoice variance, and the PO can be emailed to the supplier from the system. |
| Capability | Vertical gating | Introduce **`inventory`** (lots + ledger; on for retail / pharmacy / timber **and restaurant**) and **`recipes`** (restaurant only). `stockTracking` stays as a **legacy alias** for `inventory` through the migration window, then is removed. |
| Units | Quantity type | Inventory quantities are **`numeric` (fractional)** carrying a unit of measure. **Sellable order-line quantities stay integer.** All money keeps `money(n)`. |
| Oversell | Kitchen policy | A per-tenant **`allowNegativeStock`** policy. Restaurant kitchens are **never blocked at the till** (deduction is recorded, on-hand goes negative, an alert fires). Retail **blocks** (`OutOfStockError`) as it does today. |
| On-hand | Source of truth | On-hand is **derivable from the ledger** (`Σ signed qty`); `inventory_lots.qtyRemaining` is a **FIFO/expiry cache**, reconcilable to the ledger, never the authority. |

## Non-goals (deferred by explicit decision)

- **Cross-channel inventory & purchasing reporting** (on-hand valuation, consumption, wastage, received-vs-invoiced spend) → **Spec 10**. This spec emits the ledger that report reads; it does not build the dashboards.
- **The email/notification delivery layer itself** → **Spec 5** (see prerequisite note below). This spec *calls* it for send-to-supplier and low-stock alerts.
- **The tamper-evident audit chain** → **Spec 4**. Inventory mutations call `recordAuditEvent(...)`; this spec does not design the chain.
- **Nutritional/allergen data, sub-recipes (a recipe as a component of another recipe), batch production runs** → later. `production` is reserved as a ledger type so batch prep can land without a migration.
- **Serial-number tracking / IMEI** — lots are quantity-bearing, not serialized.
- **Supplier invoice ingestion / AP.** We record an *expected* invoice figure for variance only; accounts payable is out of scope.

## Prerequisite: Notifications & Email (Spec 5)

Send-to-supplier (Part C) and low-stock alerts (Part D) both require an outbound path that does not exist today (roadmap: "no email / SMS / WhatsApp / push infrastructure exists"). **Spec 5 owns** `notifications`, `notification_outbox`, `email_events`, and the `EmailProvider` / `NotificationProvider` interfaces. This spec depends on two Spec-5 surfaces and designs neither:

- `enqueueNotification(ctx, { kind, payload, channels })` — used by the low-stock scheduler.
- `sendEmail(ctx, { to, subject, html, attachments })` — used by send-to-supplier with the rendered PO.

If Spec 5 is not yet merged, Part A/B ship independently; Part C's send step and Part D's alerts are feature-flagged off until it lands. Everything else in Parts C/D (drafting, receiving, reorder-point storage) is unblocked.

---

## Part A — Inventory Core

The foundation: what a stockable thing is, where it lives, the cost-bearing lots it lives in, and the append-only ledger that is the single source of on-hand truth.

### Data model

#### New: `inventory_items`

A stockable thing — an ingredient (mozzarella), a finished good (a can of cola), a raw material (a plank). Distinct from a **sellable** `product`/`variant`, which links to it via `product_inventory_links` (Part B). One ingredient feeds many dishes; one item, one row here.

| Column | Notes |
|---|---|
| `id`, `tenantId` | tenant-scoped, FORCE RLS |
| `nameEn`, `nameAr` | |
| `sku` | text, nullable — internal code |
| `kind` | enum `ingredient \| finished_good \| raw_material` |
| `baseUom` | enum `inventory_uom`: `each \| g \| kg \| ml \| l`. The canonical unit; **all ledger quantities are normalized to this.** |
| `stockUom`, `stockToBase` | how the item is counted/held (e.g. count in `kg`, `stockToBase = 1000` when base is `g`) |
| `purchaseUom`, `purchaseToBase` | how the item is bought (e.g. a `each` case, `purchaseToBase = 24` when base is `each`) |
| `recipeUom`, `recipeToBase` | default unit recipes consume it in; a `recipe_component` may override per line |
| `isPerishable` | boolean — drives expiry capture on lots |
| `defaultUnitCost` | `money`, nullable — fallback when a lot has no cost (opening balances, waste-only items) |
| `isActive` | boolean |
| `createdAt` | |

Conversion factors are validated **dimensionally**: mass↔mass, volume↔volume, count↔count only. `g↔ml` is rejected — density is not modelled.

#### New: `storage_locations`

Fixes the single-global-count gap. Stock lives **at a location, at a branch**. A restaurant branch has a `kitchen`; a retail branch has a `retail` shelf; both may have `back_of_house`.

| Column | Notes |
|---|---|
| `id`, `tenantId`, `branchId` | `branchId` → `branches.id`. Per-branch stock arrives here. |
| `name` | free text ("Main Kitchen", "Front Shelf") |
| `kind` | enum `kitchen \| retail \| back_of_house \| transit`. `placeOrder` resolves recipe deductions to the branch's `kitchen`, finished-goods to `retail`. |
| `isDefault` | boolean — one default per (branch, kind), used when a caller does not name a location |
| `isActive`, `createdAt` | |

#### New: `inventory_lots`

A receipt-dated, cost-bearing quantity of one item at one location. FIFO and expiry both order by lot. `qtyRemaining` is a **cache**; the ledger is authoritative.

| Column | Notes |
|---|---|
| `id`, `tenantId` | |
| `itemId` | → `inventory_items.id` |
| `locationId` | → `storage_locations.id` |
| `lotCode` | text, nullable — supplier batch code |
| `qtyReceived`, `qtyRemaining` | `numeric` in the item's **base UoM**. `qtyRemaining` decremented as lots are consumed FIFO. |
| `unitCost` | `money` — cost per base unit; drives on-hand valuation (Spec 10) |
| `supplierId` | → `suppliers.id`, nullable (opening balances have none) |
| `receivedAt` | timestamptz — **FIFO order key** |
| `expiryAt` | timestamptz, nullable — perishables; expiry-first consumption is a per-item toggle |
| `poReceiptLineId` | → `po_receipt_lines.id`, nullable — provenance back to receiving |

Index `(itemId, locationId, receivedAt)` for FIFO scans; partial index `WHERE qtyRemaining > 0`.

#### New: `stock_ledger` — append-only, the source of truth

Every quantity change is a row. On-hand for an (item, location) is `Σ qty` over its rows. Never updated, never deleted (an append-only trigger enforces it, mirroring the Spec 4 pattern).

| Column | Notes |
|---|---|
| `id`, `tenantId` | |
| `itemId`, `locationId` | |
| `lotId` | → `inventory_lots.id`, nullable (a bulk adjustment may not target a lot) |
| `type` | enum `stock_ledger_type`: `receive \| sale_deduction \| adjustment \| count \| transfer \| waste \| refund_restock \| production` |
| `qty` | `numeric`, **signed**, in the item's base UoM. `receive`/`refund_restock`/`production` positive; `sale_deduction`/`waste` negative; `adjustment`/`count`/`transfer` either sign |
| `uom` | the base UoM at write time (defensive — survives a later base-UoM change) |
| `unitCost` | `money`, nullable — cost carried on `receive` rows and consumption rows (for COGS) |
| `refType`, `refId` | polymorphic provenance: `order`/`order_item`, `po_receipt`, `stock_count`, `stock_ledger` (the reversed row), etc. |
| `byUserId` | → `users.id`, nullable for system/scheduled writes |
| `note` | text, nullable |
| `createdAt` | |

A `transfer` between locations is **two rows** (negative at source, positive at destination) sharing a `refType='transfer'` group id in `refId`.

#### New: `stock_counts` / `stock_count_lines`

A physical count session and its per-item results. Committing a count writes `count`-type ledger rows for each variance (`countedQty − systemQty`), reconciling cache to reality.

`stock_counts`: `id`, `tenantId`, `branchId`, `locationId`, `status` (`open \| committed \| cancelled`), `startedByUserId`, `committedByUserId`, `startedAt`, `committedAt`.
`stock_count_lines`: `id`, `tenantId`, `countId`, `itemId`, `systemQty` (snapshot at count start), `countedQty` (`numeric`, entered), `varianceQty` (derived), `note`.

#### New: `product_inventory_links`

The bridge from **sellable** to **stockable**. Maps a `productId` (or `variantId`) to **exactly one of**: a **recipe** (Part B) or a **finished-goods `inventory_item`**. This is the row `placeOrder` resolves.

| Column | Notes |
|---|---|
| `id`, `tenantId` | |
| `productId` | → `products.id` |
| `variantId` | → `product_variants.id`, nullable (null = the base product) |
| `linkType` | enum `recipe \| finished_good` |
| `recipeId` | → `recipes.id`, non-null iff `linkType='recipe'` |
| `itemId` | → `inventory_items.id`, non-null iff `linkType='finished_good'` |

`CHECK` enforces the xor. Unique on `(productId, variantId)` — a sellable line resolves to at most one link. **No link → no deduction** (the item sells without touching inventory; today's `trackStock=false` behaviour survives for un-linked products).

### Authorization

New permissions in `src/server/rbac/permissions.ts` (per roadmap mapping):

- `inventory:view` — read items, lots, on-hand, ledger.
- `inventory:manage` — create/edit items, locations, links; adjustments; transfers; waste.
- `inventory:count` — open and commit stock counts.

Default roles: **owner** all; **manager** all; **staff** `inventory:view` + `inventory:count` only (staff count shelves, they do not re-cost or reconfigure). `requireCapability(vertical, "inventory")` gates every write; `recipes` additionally gates Part B.

### API

Under the existing dashboard service layer (tenant-session authed, not the POS bridge):

- `GET /inventory/items`, `POST /inventory/items`, `PATCH /inventory/items/:id` — CRUD; enforce dimensional UoM validation.
- `GET /inventory/on-hand?locationId=&itemId=` — computed `Σ qty` from the ledger, with lot breakdown.
- `POST /inventory/adjustments` — signed `adjustment`/`waste` ledger row + audit event. Reason-coded.
- `POST /inventory/transfers` — two-row transfer between locations, atomic.
- `POST /inventory/counts`, `POST /inventory/counts/:id/lines`, `POST /inventory/counts/:id/commit` — count lifecycle; commit is one transaction writing all variance rows.

`setProductStock` / `setVariantStock` (`variants.ts`) are **superseded** by `POST /inventory/adjustments` against the linked finished-goods item; they remain as thin shims during migration, then are removed.

### Architecture — the stock-ledger model

The ledger is the only writer of truth; lots are a FIFO/expiry cache derived from it; on-hand is a projection.

```
                writes (append-only, never UPDATE/DELETE)
                            │
   receive / sale_deduction / adjustment / count /
   transfer / waste / refund_restock / production
                            │
                            ▼
                   ┌──────────────────┐
                   │   stock_ledger   │  signed qty (base UoM), refType/refId, byUserId
                   └────────┬─────────┘
                            │  Σ qty  GROUP BY (item, location)
              ┌─────────────┴──────────────┐
              ▼                             ▼
      on-hand(item, loc)          inventory_lots.qtyRemaining
   (authoritative projection)     (FIFO/expiry CACHE — reconcilable,
                                   decremented alongside ledger writes)

   Invariant checked nightly (Spec 10 rollup or a verifier):
       Σ ledger.qty(item,loc)  ==  Σ lots.qtyRemaining(item,loc)
```

---

## Part B — Recipes & BOM Auto-Deduction

Where the restaurant vertical finally gets stock: a dish is a recipe, and selling it consumes ingredient lots. This is the rewire of `placeOrder`'s stock step.

### Data model

#### New: `recipes`

The bill of materials for one made-to-order sellable. Referenced by a `product_inventory_links` row.

| Column | Notes |
|---|---|
| `id`, `tenantId` | |
| `nameEn`, `nameAr` | usually mirrors the dish |
| `yieldQty`, `yieldUom` | what one batch of the recipe produces (default `1 each` = one sold unit). A sold quantity of `n` scales components by `n / yieldQty`. |
| `isActive`, `createdAt` | |

#### New: `recipe_components`

One ingredient line of a recipe.

| Column | Notes |
|---|---|
| `id`, `tenantId`, `recipeId` | |
| `itemId` | → `inventory_items.id` |
| `qty`, `uom` | `numeric` + `inventory_uom`; converted to the item's base UoM via its factors |
| `wastePct` | `numeric` default `0` — yield loss; effective consumption = `qty × (1 + wastePct/100)` |

Effective base consumption per sold unit = `toBase(qty, uom, item) × (1 + wastePct/100) × (soldQty / recipe.yieldQty)`.

### Rewiring `placeOrder`'s stock step

Today's block (`service.ts:151-172`) decrements a flat integer gated on `caps.stockTracking`. It is replaced by a resolver gated on `caps.inventory`, run **inside the same `withTenant` transaction** so deduction is atomic with order creation:

For each order line (sold `quantity` is still an **integer**):

1. Look up `product_inventory_links` for `(productId, variantId)`. **No link → skip** (un-tracked sellable; preserves today's null-stock passthrough).
2. `linkType = 'finished_good'` → resolve the branch's `retail` `storage_location`, deduct `soldQty` (base UoM) of the linked item FIFO across its lots.
3. `linkType = 'recipe'` → resolve the branch's `kitchen` location; for **each** `recipe_component`, deduct its scaled effective base quantity FIFO across that item's lots.

**FIFO deduction, per (item, location), preserving the guarded-update concurrency semantics:** the existing design makes the `UPDATE ... WHERE qtyRemaining >= needed` the serialization point. We keep that shape at **lot granularity**:

```
  need := scaledBaseQty
  for lot in lots(item, loc) order by receivedAt (or expiryAt if expiry-first), qtyRemaining > 0:
      take := min(need, lot.qtyRemaining)
      UPDATE inventory_lots
         SET qtyRemaining = qtyRemaining - take
       WHERE id = lot.id AND qtyRemaining >= take      -- ← serialization point, as today
      if rowcount = 0: refetch lot, retry            -- a concurrent sale took it first
      INSERT stock_ledger (type='sale_deduction', qty = -take, lotId, unitCost=lot.unitCost,
                           refType='order_item', refId=lineId, byUserId=cashier)
      need -= take
      if need == 0: break
  if need > 0:                                         -- lots exhausted
      if allowNegativeStock(tenant): write one sale_deduction row for -need with lotId=NULL
                                     (on-hand goes negative) + enqueue low-stock alert
      else: throw OutOfStockError(product.nameEn, product.nameAr)
```

The `WHERE qtyRemaining >= take` re-evaluates against the latest committed row under READ COMMITTED, exactly as the current `products.stockQuantity >= quantity` guard does — so two concurrent sales cannot both claim the last unit of a lot.

### The `allowNegativeStock` policy — kitchens are never blocked

A new per-tenant setting (default: **`true` for restaurant`, `false` for retail/pharmacy/timber**). It answers one question: *when a deduction cannot be fully satisfied, do we fail the sale or record the shortfall?*

- **Restaurant (allow):** the cashier is at the till, the customer is holding cash, the kitchen already made the dish. **Failing here is wrong.** The deduction is recorded (`lotId=NULL` for the shortfall), on-hand goes negative, and a low-stock alert fires so the manager reconciles. The sale always completes.
- **Retail (block):** you cannot sell a physical can you do not have. The shortfall raises `OutOfStockError` and the order is not created — identical to today.

This is the single most important behavioural contrast in the spec: turning `inventory` **on** for restaurants must not turn the till into something that can refuse a sale.

### Restock on cancel / refund — reverse the movements

`restockOrderItems` (`service.ts:279-295`) currently adds integers back. Rewired to **reverse the ledger**: for each `sale_deduction` row of the order (or the refunded lines, Spec 3), write a `refund_restock` row with the **negated** qty, restoring the **same lot** (`refType='stock_ledger'`, `refId=` the reversed row) and bumping that lot's `qtyRemaining`. Reversing to the original lot keeps FIFO cost layers honest. If the original lot was since depleted/expired, the restock lands on a system adjustment lot flagged for review.

### Architecture — the placeOrder recipe-deduction path

```
  POST /sales line (productId, variantId?, integer qty)
        │
        ▼
  product_inventory_links (productId, variantId)
        │
   ┌────┴─────────────┐
   │ none             │ recipe                        │ finished_good
   ▼                  ▼                               ▼
 skip (untracked)  recipes → recipe_components     inventory_item
                     │  (scale by qty/yield,          │
                     │   apply wastePct)              │
                     ▼                                ▼
             branch kitchen location          branch retail location
                     │                                │
                     └──────────► FIFO deduct lots ◄──┘
                                  (guarded UPDATE per lot)
                                        │
                          ┌─────────────┴───────────────┐
                     satisfied                        shortfall
                          │                     ┌───────┴────────┐
                          ▼                allowNegativeStock?   no
                 sale_deduction rows        yes │                 │
                 (one per lot touched)          ▼                 ▼
                                        record -shortfall   throw
                                        + low-stock alert  OutOfStockError
```

---

## Part C — Suppliers & Purchasing

Replenishment: who we buy from, the orders we place, receiving that turns an order into lots, and the ability to email the PO to the supplier.

### Data model

#### New: `suppliers`

| Column | Notes |
|---|---|
| `id`, `tenantId` | |
| `name` | |
| `contactName`, `email`, `phone` | `email` required for send-to-supplier |
| `paymentTerms` | text — "Net 30", "COD" |
| `notes`, `isActive`, `createdAt` | |

Items supplied is a join `supplier_items` (`supplierId`, `itemId`, `supplierSku`, `lastUnitCost`, `packUom`) — powers PO line defaults and reorder supplier selection.

#### New: `purchase_orders`

| Column | Notes |
|---|---|
| `id`, `tenantId`, `branchId` | destination branch (receiving location resolves from it) |
| `supplierId` | → `suppliers.id` |
| `poNumber` | per-tenant sequence via `pg_advisory_xact_lock(hashtext(tenantId))` — the same lock `placeOrder` uses for order numbers |
| `status` | enum `po_status`: `draft \| sent \| partially_received \| received \| closed \| cancelled` |
| `expectedTotal` | `money` — Σ lines, for variance |
| `invoiceTotal` | `money`, nullable — the supplier's actual invoice, entered at/after receipt |
| `currency` | default tenant currency (EGP) |
| `sentAt`, `expectedAt`, `createdByUserId`, `createdAt` | `sentAt` set by send-to-supplier |

#### New: `purchase_order_lines`

| Column | Notes |
|---|---|
| `id`, `tenantId`, `poId` | |
| `itemId` | → `inventory_items.id` |
| `qtyOrdered`, `uom` | `numeric` + UoM (usually the item's `purchaseUom`) |
| `unitCost` | `money` per ordered UoM |
| `taxRate` | `numeric`, nullable |
| `qtyReceived` | `numeric` running total across receipts (drives `partially_received` vs `received`) |

#### New: `po_receipts` / `po_receipt_lines`

Receiving is the bridge from PO to inventory, and it supports **partial** receipts (one PO, many receipts).

`po_receipts`: `id`, `tenantId`, `poId`, `receivedByUserId`, `receivedAt`, `supplierDeliveryNote` (text), `note`.
`po_receipt_lines`: `id`, `tenantId`, `receiptId`, `poLineId`, `itemId`, `qtyReceived` (`numeric`, this receipt), `uom`, `unitCost`, `lotCode`, `expiryAt`.

**Committing a receipt, in one transaction:** for each line — create an `inventory_lots` row (`qtyReceived=qtyRemaining=` received qty in base UoM, `unitCost`, `supplierId`, `receivedAt`, `expiryAt`, `poReceiptLineId`) **and** a `stock_ledger` row (`type='receive'`, positive qty, `unitCost`, `refType='po_receipt'`). Then bump `purchase_order_lines.qtyReceived` and recompute PO status: `partially_received` while any line is short, `received` when all lines meet or exceed ordered.

#### Variance: PO vs received vs invoice

Three numbers per PO: `expectedTotal` (ordered), `Σ receipt lines × unitCost` (received), `invoiceTotal` (billed). Their pairwise deltas are the **PO variance report** — surfaced here as an endpoint, fully rendered in Spec 10. Over-receipt beyond ordered qty is allowed but flagged.

### Send-to-supplier

1. Render the PO to **HTML/PDF** from a template (tenant branding, line items, totals, delivery branch address).
2. `sendEmail(ctx, { to: supplier.email, subject, html, attachments: [pdf] })` via the **Spec 5** `EmailProvider` layer.
3. Set `purchase_orders.sentAt`, transition `draft → sent`.
4. Emit a **Spec 4** `recordAuditEvent(ctx, { action: 'po.sent', entity: poId, metadata })` in the same transaction.

Send is idempotent per PO+revision; re-sending logs a distinct audit event and updates `sentAt`.

### Authorization

- `purchasing:manage` — create/edit/send POs, receive against them, enter invoice totals.
- `suppliers:manage` — CRUD suppliers and supplier-item catalog.

Default roles: **owner** and **manager** both; **staff** neither (staff may `inventory:count` but not purchase). Receiving is under `purchasing:manage` — a receiving clerk is granted the permission explicitly if not a manager.

### API

- `GET/POST/PATCH /suppliers`, `/suppliers/:id/items`.
- `GET/POST/PATCH /purchase-orders`, `POST /purchase-orders/:id/send`, `POST /purchase-orders/:id/cancel`.
- `POST /purchase-orders/:id/receipts` — record a (partial) receipt; commits lots + ledger.
- `PATCH /purchase-orders/:id/invoice` — enter `invoiceTotal`.
- `GET /purchase-orders/:id/variance` — the three-way delta.

### Architecture — the PO lifecycle state machine

```
        create                 send (email + audit)
   ●──────────────► draft ───────────────────────► sent
                      │                               │
                      │ cancel                        │ receive (partial)
                      ▼                               ▼
                  cancelled                    partially_received
                                                      │  ▲
                                          receive     │  │ receive (more,
                                          (remainder) │  │  still short)
                                                      ▼  │
                                                  received
                                                      │
                                          all reconciled / invoice matched
                                                      ▼
                                                   closed

   Each `receive` transition writes inventory_lots + stock_ledger('receive') rows
   in one transaction, then recomputes status from Σ line qtyReceived vs qtyOrdered.
   `cancelled` is terminal and only reachable from draft/sent (never after receipt).
```

---

## Part D — Low-Stock Alerts & Reorder

Closes the loop: notice when an item runs low, tell someone, and offer a pre-filled PO to fix it.

### Data model

#### New: `reorder_rules`

Reorder point and quantity, **per item per location** (a busy branch reorders sooner than a quiet one).

| Column | Notes |
|---|---|
| `id`, `tenantId`, `itemId`, `locationId` | unique on `(itemId, locationId)` |
| `reorderPoint` | `numeric`, base UoM — on-hand at/below this triggers an alert |
| `reorderQty` | `numeric`, base UoM — how much the pre-filled PO suggests |
| `preferredSupplierId` | → `suppliers.id`, nullable — the pre-fill target |
| `isActive` | |

### The scheduled check

A scheduled job (per tenant, in tenant timezone) computes on-hand per active `reorder_rule` from the ledger, and for each item at/below its `reorderPoint`:

1. `enqueueNotification(ctx, { kind: 'low_stock', payload: { itemId, locationId, onHand, reorderPoint }, channels: ['email','in_app'] })` — via **Spec 5**.
2. Optionally **pre-fill a draft PO**: group triggered items by `preferredSupplierId`, create one `draft` `purchase_order` per supplier with lines at `reorderQty` and `supplier_items.lastUnitCost`. The manager reviews and sends — we never auto-send.

Alerts are debounced per (item, location) so a lingering low-stock state does not re-notify every run.

### Authorization

Configuring rules is `inventory:manage`; the generated draft PO is governed by `purchasing:manage` at send time.

### API

- `GET/PUT /inventory/reorder-rules` — manage rules.
- `POST /inventory/reorder/check` — manual trigger of the scheduled logic (also the job's entry point).

---

## Error handling / edge cases

- **Un-linked sellable:** no `product_inventory_links` row → no deduction, sale proceeds (today's `trackStock=false` behaviour, preserved).
- **Restaurant oversell:** `allowNegativeStock` records the shortfall, on-hand negative, alert fires; the sale **never** fails. Retail shortfall → `OutOfStockError`, no order.
- **Concurrent last-lot sale:** the per-lot guarded `UPDATE ... WHERE qtyRemaining >= take` serializes; the loser refetches and continues to the next lot (or the shortfall branch).
- **Dimensional UoM mismatch:** `g↔ml` conversion, or a recipe component whose UoM cannot resolve to the item's base, is rejected at write time.
- **Expired lot:** expiry-first items skip receipt-order; an expired lot is excluded from FIFO and surfaced for waste. Waste is an explicit `waste` ledger row, never a silent decrement.
- **Partial receipt then over-receipt:** allowed; PO goes `partially_received` then `received`; qty beyond ordered is flagged in variance.
- **Refund to a depleted lot:** `refund_restock` lands on a system adjustment lot flagged for review rather than resurrecting a consumed cost layer.
- **Cancel a PO after receipt:** blocked — `cancelled` is unreachable once any receipt exists; reverse via adjustment/return instead.
- **Ledger/lot cache drift:** the nightly invariant `Σ ledger.qty == Σ lots.qtyRemaining` per (item, location) flags any drift; the ledger wins, the cache is rebuilt.
- **Spec 5 not merged:** send-to-supplier and low-stock alerts are flagged off; drafting, receiving, and reorder-rule storage still work.

## Testing

- **UoM conversion (unit, pure):** base normalization, `stock/purchase/recipe` factors, dimensional-consistency rejection, `wastePct` and `yieldQty` scaling.
- **Ledger projection (unit):** on-hand = `Σ qty`; lot `qtyRemaining` reconciles to the ledger; transfer is two balanced rows.
- **FIFO deduction (server, Vitest):** oldest lot first; expiry-first ordering; spanning multiple lots; the guarded-`UPDATE` concurrency test — two concurrent sales of the last unit of a lot, exactly one succeeds (the analog of the existing stock-race test).
- **`allowNegativeStock` (server):** restaurant sale past zero completes, writes a negative-on-hand `sale_deduction`, enqueues an alert; retail sale past zero throws `OutOfStockError` and creates no order.
- **Restock (server):** cancel/refund writes `refund_restock` reversing the exact lots; depleted-lot fallback flags for review.
- **Receiving (server):** partial receipt creates lots + `receive` ledger rows, bumps `qtyReceived`, transitions `partially_received` → `received`; variance three-way delta is correct.
- **Send-to-supplier (server):** renders the PO, calls `sendEmail`, sets `sentAt`, emits the audit event; idempotent per revision.
- **Reorder (server):** on-hand at/below point enqueues one debounced notification and pre-fills a grouped draft PO.
- **Migration (server):** an existing retail tenant's `products.stockQuantity` seeds an item + opening-balance ledger row whose on-hand equals the old integer; a sale post-migration deducts identically.
- **RLS/authorization:** staff can `count` but not `manage`/purchase; cross-tenant reads blocked.

## Migration

The flat integer must become a ledger **without a gap in retail continuity**.

1. **Schema:** add all Part A–D tables (FORCE RLS). Add the `inventory` and `recipes` vertical capabilities (`registry.ts`), keeping `stockTracking` as a **legacy alias** that resolves to `inventory` for the migration window.
2. **Storage locations:** for every branch, create a default location — `kitchen` for restaurants, `retail` for retail/pharmacy/timber (plus `back_of_house` where sensible).
3. **Seed items + opening balances:** for every `product`/`product_variant` with a non-null `stockQuantity`, create an `inventory_item` (`kind='finished_good'`, `baseUom='each'`), a `product_inventory_links` row (`linkType='finished_good'`), an opening `inventory_lots` row (`qtyReceived=qtyRemaining=` the old integer, `unitCost=` product cost or `defaultUnitCost`), and an opening-balance `stock_ledger` row (`type='adjustment'`, `note='opening balance'`). On-hand after migration **equals** the old integer, verified by the migration test.
4. **Rewire the order path:** ship the Part B resolver behind the `inventory` capability. Retail keeps deducting — now through lots instead of the integer — with byte-identical outcomes for single-lot items.
5. **Deprecate the old columns:** `products.stockQuantity` / `product_variants.stockQuantity` are first **mirrored** (a trigger or the adjustment path keeps them in sync for any external reader), then, once the storefront `inStock` computation reads on-hand from the ledger, **dropped**. `setProductStock` / `setVariantStock` become shims over `POST /inventory/adjustments`, then are removed.
6. **Restaurants opt in:** turning `inventory` on for a restaurant is inert until recipes and `product_inventory_links` exist — an un-linked dish still sells freely. Onboarding builds recipes incrementally; nothing breaks in the interim.

## Roadmap

- **Spec 5 — Notifications & Outbound Email** (prerequisite): unblocks send-to-supplier and low-stock alerts. Parts A/B ship without it.
- **Spec 4 — Audit & Fingerprint Log** (prerequisite for the audit calls): inventory adjustments, receipts, and PO sends emit `recordAuditEvent`.
- **Spec 10 — Cross-Channel Reporting:** reads this ledger for on-hand valuation, consumption, wastage, count variance, low-stock, and supplier spend / received-vs-invoiced. This spec produces the data; Spec 10 renders it.
- **Later:** sub-recipes (a recipe as a component of another), batch **production** runs (the reserved ledger type), density-based `g↔ml` conversion, serialized lots, supplier-invoice ingestion / AP, and variants in the POS cart consuming recipes at the till.
