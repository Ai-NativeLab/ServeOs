# Inventory Core & Recipes/BOM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use mo-ai:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat integer stock counter with a **per-branch, unit-aware, append-only stock ledger** and teach `placeOrder` to deduct a sold line's inventory — a dish's **recipe** ingredients FIFO from the branch kitchen, or a retail item's **finished-goods** stock FIFO from the branch retail shelf. On-hand becomes `Σ ledger.qty`; `inventory_lots.qtyRemaining` is a FIFO/expiry cache. Turn the new `inventory` capability **on for restaurants** without ever letting the till refuse a kitchen sale (per-tenant `allowNegativeStock`), while retail keeps blocking (`OutOfStockError`) exactly as today. Implements **Part A (Inventory Core)** and **Part B (Recipes & BOM)** of `docs/ailab/specs/2026-07-24-inventory-recipes-and-purchasing-design.md` (Spec 8, decisions **D4** + **D9**). **Part C/D (suppliers, purchasing, reorder) are a separate plan** — this plan only references their tables (`suppliers`, `po_receipt_lines`) as forward deps.

**Architecture:** One writer of truth — the ledger. `src/server/inventory/service.ts` is the only module that appends `stock_ledger` rows and mutates the `inventory_lots.qtyRemaining` cache alongside them. `placeOrder` (`src/server/ordering/service.ts`) calls `deductForOrderLine(tx, …)` **inside its existing `withTenant` transaction**, so ingredient/finished-goods deduction is atomic with order creation — the same discipline the audit chain uses. The FIFO deduction keeps the current concurrency guarantee: the guarded `UPDATE inventory_lots SET qty_remaining = qty_remaining - take WHERE id = ? AND qty_remaining >= take` is the serialization point, exactly as `products.stockQuantity >= quantity` is today (`service.ts:216-233`). `inventory` is a **leaf of `ordering`**: `ordering/service` imports `deductForOrderLine`; `inventory/service` imports only `ordering/errors` (`OutOfStockError`) — never `ordering/service` — so there is no import cycle. UoM math lives in one pure module (`src/server/inventory/uom.ts`) imported everywhere a quantity is normalized, mirroring the audit plan's single-canonical-serializer rule.

> **Reconciled 2026-08-04** — this plan was written 2026-07-24; four things have landed since, and the tasks below reflect them:
> 1. **The UoM enum already exists.** P4 (timber) shipped one platform-wide `unit_of_measure` pg enum in `src/server/catalog/uom.ts` (decision T1), whose own comment reserves it for this spec: *"Spec 8 imports THIS enum when it lands."* Task 2 therefore **imports** it instead of declaring a second `inventory_uom` — five new enums, not six. Consequence: the enum is a **superset** carrying P4's sellable dimensional units (`m`, `m2`, `bf`), which are *not* valid inventory units, so the subset must be enforced in `uom.ts` (Task 3) since the DB enum cannot express it.
> 2. **Migrations are at `0032`**, not `0016` — the generated file is `drizzle/0033_*.sql`. The `unit_of_measure` type already exists in the DB, so the migration must not re-create it.
> 3. **Spec 5 (Notifications) has merged.** The low-stock alert is no longer a stub: `notify(ctx, event, tx?)` (`src/server/notifications/service.ts:42`) is live and its schema already ships the `low_stock` notification type, pre-provisioned for this spec. Task 4 calls it for real, on the order's tx.
> 4. **`placeOrder` has moved** — the flat-integer stock block is now `service.ts:216-233` (was `151-172`) and `restockOrderItems` is at `service.ts:410`.
>
> Also note `src/server/audit/coverage.ts:127` carries a `forward:inventory.*` guardrail entry ("Spec 8 ledger/lot/count must emit `inventory.*`"): the audit coverage test expects this spec's mutations to emit audit events, so that forward declaration is converted to real emissions as the service lands.

**Tech Stack:** Next.js (App Router — **read `node_modules/next/dist/docs/` before writing any route**, per `AGENTS.md`), Drizzle ORM + Postgres (RLS via `withTenant`), Vitest against a remote Supabase Postgres. No new runtime dependencies.

## Global Constraints

- **The ledger is the only source of on-hand truth.** On-hand for an `(itemId, locationId)` is `Σ stock_ledger.qty`. `inventory_lots.qtyRemaining` is a **cache** decremented alongside each ledger write and reconcilable to it — never the authority.
- **`stock_ledger` is append-only.** No code path ever `UPDATE`s or `DELETE`s a ledger row; a DB trigger enforces it (mirrors `audit_events`, Spec 4). `inventory_lots.qtyRemaining` is the one **mutable** number, and it is only ever moved by the same service call that writes the balancing ledger row. Reversals are **new** `refund_restock` rows, never edits.
- **Quantities are `numeric` (fractional); sellable order-line quantities stay `integer`.** All ledger/lot/recipe quantities carry a unit of measure and are normalized to the item's **base UoM** before storage. There is exactly one quantity formatter — `qty(n)` in `uom.ts`, scale 3 (milligram/ml precision) — the direct analog of `money(n)`. All monetary values (`unitCost`, `defaultUnitCost`) keep the `money(n)` 2-dp numeric-string convention.
- **UoM conversion is dimensionally validated.** mass↔mass, volume↔volume, count↔count only. `g↔ml` is rejected (`DimensionalUomError`) — density is not modelled.
- **Inventory uses a subset of the shared enum.** `unit_of_measure` is platform-wide and includes P4's sellable dimensional units (`m`, `m2`, `bf`). Those are **not** stockable inventory units: `uom.ts` exposes `INVENTORY_UOMS = ["each","g","kg","ml","l"]` and rejects anything else (`DimensionalUomError`) on every write that names a UoM — item base/stock/purchase/recipe units, recipe component units, ledger rows. The DB enum cannot express the subset, so this check is the only thing standing between a `m2` and the ledger; it is tested explicitly.
- **Deduction is atomic with the order.** `deductForOrderLine` runs on the caller's `tx`. If it throws (retail shortfall), the whole order rolls back and no order exists — identical to today's `OutOfStockError` behaviour.
- **The per-lot guarded UPDATE is the serialization point.** `WHERE qty_remaining >= take` re-evaluates against the latest committed row under READ COMMITTED, so two concurrent sales cannot both claim the last unit of a lot. A loser re-reads the next candidate lot and continues (or falls to the shortfall branch).
- **Kitchens are never blocked; retail always blocks.** A per-tenant `allowNegativeStock` policy (default **true** for restaurant, **false** for retail/pharmacy/timber) decides the shortfall branch: record the shortfall (`lotId=NULL`, on-hand goes negative, alert enqueued) vs. throw `OutOfStockError` and create no order.
- **No `product_inventory_links` row → no deduction.** An un-linked sellable sells without touching inventory — today's `trackStock=false` / null-stock passthrough, preserved.
- **Tenant-scoped tables are behind FORCE RLS.** Every new table is `ENABLE` + `FORCE ROW LEVEL SECURITY` with the house isolation policy (`USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)` + the same `WITH CHECK`), hand-appended to the generated migration exactly as `drizzle/0016_bitter_beast.sql:67-81` did.
- Run `npx tsc --noEmit && npx eslint <files>` before every commit. Both must be clean.

---

## File Structure

**Database**
- Create: `src/server/inventory/schema.ts` — 9 tables + 6 enums.
- Modify: `src/db/schema.ts` — register the new schema barrel export.
- Create: `drizzle/0033_*.sql` — generated migration; RLS policies, the append-only ledger trigger, the `product_inventory_links` xor `CHECK`, and its two partial unique indexes hand-appended.

**Capabilities · permissions · policy**
- Modify: `src/server/verticals/types.ts` — `VerticalCapabilities` gains `inventory`, `recipes`.
- Modify: `src/server/verticals/registry.ts` — set `inventory`/`recipes` per vertical; `stockTracking` becomes a legacy alias equal to `inventory`.
- Modify: `src/server/verticals/registry.test.ts` — update the capability equality assertions.
- Modify: `src/server/rbac/permissions.ts` + `permissions.test.ts` — add `inventory:view` / `inventory:manage` / `inventory:count`.
- Modify: `src/server/tenancy/settings.ts` + `settings.test.ts` — `allowNegativeStock` getter/setter, vertical-derived default.

**Core (pure + writer)**
- Create: `src/server/inventory/uom.ts` + `uom.test.ts` — dimensional conversion, `toBase`, `qty`, `scaleForYield`, `withWaste`, and the `INVENTORY_UOMS` subset guard. Imports `UnitOfMeasure` from `@/server/catalog/uom-values` (the drizzle-free module) — never re-declares units.
- Create: `src/server/inventory/errors.ts` — `DimensionalUomError`, `InventoryConfigError` (re-exports `OutOfStockError`).
- Create: `src/server/inventory/service.ts` + `service.test.ts` — `onHand`, `receiveStock`, `adjustStock`, `transferStock`, count lifecycle, `deductForOrderLine`, `reverseOrderDeductions`.
- Create: `src/server/inventory/test-helpers.ts` — `seedFinishedGood`, `seedRecipeProduct`.

**Rewire**
- Modify: `src/server/ordering/service.ts` — `placeOrder` stock step + `restockOrderItems`.
- Modify: `src/server/ordering/place-order.test.ts` — the retail stock / concurrency / restock tests seed lots instead of the integer.

**Migration / backfill**
- Create: `scripts/backfill-inventory.ts` + `src/server/inventory/backfill.test.ts`.
- Modify: `src/server/catalog/variants.ts` — `setProductStock` / `setVariantStock` become adjustment shims that mirror the integer.

**Dashboard**
- Create: `src/server/inventory/read.ts` — `listItems`, `getOnHand`, `listLots`, `listCounts`.
- Create: `src/app/dashboard/inventory-permission.ts` — `requireInventoryPermission(perm)`.
- Create: `src/app/api/inventory/{items,on-hand,adjustments,transfers,counts}/route.ts`, `counts/[id]/commit/route.ts`.
- Create: `src/app/dashboard/inventory/page.tsx` — minimal read-only view.

---

## Task 1: Capabilities, permissions, and the `allowNegativeStock` policy

Three small, pure config additions that everything else gates on. The `inventory` capability replaces the legacy flat `stockTracking` (kept as an alias equal to `inventory` for the migration window); `recipes` is restaurant-only; the three `inventory:*` permissions map per the roadmap (owner/manager all, staff `view`+`count`); and `allowNegativeStock` is a per-tenant setting whose default is derived from the vertical.

**Files:**
- Modify: `src/server/verticals/types.ts`, `registry.ts`, `registry.test.ts`
- Modify: `src/server/rbac/permissions.ts`, `permissions.test.ts`
- Modify: `src/server/tenancy/settings.ts`, `settings.test.ts`

**Interfaces:**
- Produces:
  - `VerticalCapabilities` gains `inventory: boolean; recipes: boolean;` (`stockTracking` retained, invariant `stockTracking === inventory`).
  - Permissions `inventory:view`, `inventory:manage`, `inventory:count`.
  - `getAllowNegativeStock(tenantId: string): Promise<boolean>` and `setAllowNegativeStock(tenantId: string, value: boolean | null): Promise<void>` in `tenancy/settings.ts`; `TenantSettingsData` gains `allowNegativeStock?: boolean`.

- [x] **Step 1: Write the failing capability + permission tests.** Update `src/server/verticals/registry.test.ts` — the two `getCapabilities(...).toEqual({...})` assertions now include `inventory`/`recipes`, plus a new invariant test:

```ts
it("restaurant: inventory + recipes on (kitchen deducts ingredients)", () => {
  expect(getCapabilities("restaurant")).toEqual({
    modifiers: true, variants: false, stockTracking: true, inventory: true, recipes: true, serviceCharge: true,
  });
});
it("retail/pharmacy/timber: inventory on, recipes off", () => {
  for (const key of ["retail", "pharmacy", "timber"] as VerticalId[]) {
    expect(getCapabilities(key), key).toEqual({
      modifiers: false, variants: true, stockTracking: true, inventory: true, recipes: false, serviceCharge: false,
    });
  }
});
it("stockTracking is a strict legacy alias of inventory for every vertical", () => {
  for (const key of VERTICAL_IDS) {
    const c = getCapabilities(key);
    expect(c.stockTracking, key).toBe(c.inventory);
  }
});
```

Append to `src/server/rbac/permissions.test.ts`:

```ts
describe("inventory permissions", () => {
  it("owner and manager hold all three", () => {
    for (const p of ["inventory:view", "inventory:manage", "inventory:count"] as const) {
      expect(ROLE_PERMISSIONS.owner).toContain(p);
      expect(ROLE_PERMISSIONS.manager).toContain(p);
    }
  });
  it("staff may view and count but not manage", () => {
    expect(ROLE_PERMISSIONS.staff).toContain("inventory:view");
    expect(ROLE_PERMISSIONS.staff).toContain("inventory:count");
    expect(ROLE_PERMISSIONS.staff).not.toContain("inventory:manage");
  });
});
```

- [x] **Step 2: Run to verify they fail.** `npx vitest run src/server/verticals/registry.test.ts src/server/rbac/permissions.test.ts` → FAIL (missing keys/permissions).

- [x] **Step 3: Implement the capability keys.** In `src/server/verticals/types.ts` add `inventory: boolean;` and `recipes: boolean;` to `VerticalCapabilities`. In `registry.ts`, set on each descriptor's `capabilities`: restaurant `{ …, stockTracking: true, inventory: true, recipes: true }`; retail/pharmacy/timber `{ …, stockTracking: true, inventory: true, recipes: false }`. Add a one-line comment: `// stockTracking is a legacy alias of inventory for the migration window; drop after Spec 8 lands (see spec Migration §5).`

- [x] **Step 4: Implement the permissions.** In `src/server/rbac/permissions.ts` add `"inventory:view", "inventory:manage", "inventory:count",` to `PERMISSIONS`, then append all three to `owner` and `manager`, and `"inventory:view", "inventory:count"` to `staff`, in `ROLE_PERMISSIONS`.

- [x] **Step 5: Write the failing `allowNegativeStock` test.** In `src/server/tenancy/settings.test.ts` (create if absent — seed a tenant per vertical like the other suites do):

```ts
it("defaults allowNegativeStock true for restaurant, false for retail", async () => {
  const r = await seedTenant("restaurant");
  const s = await seedTenant("retail");
  expect(await getAllowNegativeStock(r)).toBe(true);
  expect(await getAllowNegativeStock(s)).toBe(false);
});
it("an explicit override wins over the vertical default", async () => {
  const s = await seedTenant("retail");
  await setAllowNegativeStock(s, true);
  expect(await getAllowNegativeStock(s)).toBe(true);
});
```

- [x] **Step 6: Implement the policy.** In `src/server/tenancy/settings.ts` add `allowNegativeStock?: boolean;` to `TenantSettingsData`, then:

```ts
export async function getAllowNegativeStock(tenantId: string): Promise<boolean> {
  const settings = await getTenantSettings(tenantId);
  if (typeof settings.allowNegativeStock === "boolean") return settings.allowNegativeStock;
  const [t] = await db.select({ vertical: tenants.vertical }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  // Restaurant kitchens are made-to-order and must never be blocked at the till.
  return (t?.vertical ?? "restaurant") === "restaurant";
}
export async function setAllowNegativeStock(tenantId: string, value: boolean | null): Promise<void> {
  await patchTenantSettings(tenantId, { allowNegativeStock: value ?? undefined });
}
```

- [x] **Step 7: Run + typecheck + lint.** `npx vitest run src/server/verticals src/server/rbac src/server/tenancy && npx tsc --noEmit && npx eslint src/server/verticals src/server/rbac src/server/tenancy`. Expected PASS, clean. (The `registry.test.ts` "complete descriptor" loop still passes — it does not assert capability key count.)

- [x] **Step 8: Commit.**

```bash
git add src/server/verticals src/server/rbac src/server/tenancy/settings.ts src/server/tenancy/settings.test.ts
git commit -m "feat(inventory): add inventory/recipes capabilities (stockTracking alias), inventory:* permissions, allowNegativeStock policy"
```

---

## Task 2: Schema — inventory tables + FORCE RLS + append-only ledger trigger

Nine tables and five new enums (the sixth, `unit_of_measure`, already exists and is imported), all tenant-scoped with FORCE RLS. `stock_ledger` gets the append-only trigger (mirroring `audit_events`); `inventory_lots.qtyRemaining` intentionally stays mutable. `inventory_lots.supplierId` and `poReceiptLineId` are **plain nullable `uuid` columns with no FK** — `suppliers` / `po_receipt_lines` land in Spec 9 (Suppliers & Purchasing), which adds the constraints then. Drizzle emits neither RLS, triggers, `CHECK`s, nor `NULLS NOT DISTINCT` indexes, so those are hand-appended.

**Files:**
- Create: `src/server/inventory/schema.ts`
- Modify: `src/db/schema.ts`
- Create: `drizzle/0033_*.sql` (generated, then edited)

**Interfaces:**
- Produces: tables `inventoryItems`, `storageLocations`, `inventoryLots`, `stockLedger`, `stockCounts`, `stockCountLines`, `productInventoryLinks`, `recipes`, `recipeComponents`; enums `inventoryItemKindEnum`, `storageLocationKindEnum`, `stockLedgerTypeEnum`, `productInventoryLinkTypeEnum`, `stockCountStatusEnum`; row types (`InventoryItem`, `InventoryLot`, `StockLedgerRow`, `Recipe`, `RecipeComponent`, `ProductInventoryLink`, …).
- Consumes: `unitOfMeasureEnum` from `@/server/catalog/uom` — the **existing** platform-wide `unit_of_measure` type (decision T1). Every UoM column below reuses it; no `inventory_uom` enum is created.

- [x] **Step 1: Write the schema.** Create `src/server/inventory/schema.ts`:

```ts
import { pgTable, uuid, text, timestamp, boolean, numeric, pgEnum, index, uniqueIndex } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { users } from "@/server/auth/schema";
import { products, productVariants } from "@/server/catalog/schema";
// ONE platform-wide UoM enum (decision T1) — P4 shipped it and reserved it for
// this spec. Do NOT declare an inventory_uom enum. It is a superset carrying
// P4's sellable dimensional units (m/m2/bf); uom.ts rejects those as inventory
// units, since a pg enum cannot express the subset.
import { unitOfMeasureEnum } from "@/server/catalog/uom";

export const inventoryItemKindEnum = pgEnum("inventory_item_kind", ["ingredient", "finished_good", "raw_material"]);
export const storageLocationKindEnum = pgEnum("storage_location_kind", ["kitchen", "retail", "back_of_house", "transit"]);
export const stockLedgerTypeEnum = pgEnum("stock_ledger_type", [
  "receive", "sale_deduction", "adjustment", "count", "transfer", "waste", "refund_restock", "production",
]);
export const productInventoryLinkTypeEnum = pgEnum("product_inventory_link_type", ["recipe", "finished_good"]);
export const stockCountStatusEnum = pgEnum("stock_count_status", ["open", "committed", "cancelled"]);

/** A stockable thing: an ingredient, a finished good, a raw material. Distinct
 * from a sellable product/variant, which links to it via product_inventory_links.
 * All ledger quantities are normalized to baseUom; stock/purchase/recipe factors
 * convert the unit each context counts/buys/consumes it in. */
export const inventoryItems = pgTable("inventory_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar").notNull(),
  sku: text("sku"),
  kind: inventoryItemKindEnum("kind").notNull(),
  baseUom: unitOfMeasureEnum("base_uom").notNull(),
  stockUom: unitOfMeasureEnum("stock_uom").notNull(),
  stockToBase: numeric("stock_to_base").notNull().default("1"),
  purchaseUom: unitOfMeasureEnum("purchase_uom").notNull(),
  purchaseToBase: numeric("purchase_to_base").notNull().default("1"),
  recipeUom: unitOfMeasureEnum("recipe_uom").notNull(),
  recipeToBase: numeric("recipe_to_base").notNull().default("1"),
  isPerishable: boolean("is_perishable").notNull().default(false),
  defaultUnitCost: numeric("default_unit_cost"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("inventory_items_tenant").on(t.tenantId)]);

/** Stock lives at a location, at a branch — fixes today's single-global-count gap. */
export const storageLocations = pgTable("storage_locations", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: storageLocationKindEnum("kind").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("storage_locations_branch_kind").on(t.branchId, t.kind)]);

/** A receipt-dated, cost-bearing quantity of one item at one location.
 * qtyRemaining is a FIFO/expiry CACHE; the ledger is authoritative.
 * supplierId / poReceiptLineId are forward deps (Spec 9) — plain uuid, no FK yet. */
export const inventoryLots = pgTable("inventory_lots", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => inventoryItems.id, { onDelete: "cascade" }),
  locationId: uuid("location_id").notNull().references(() => storageLocations.id, { onDelete: "restrict" }),
  lotCode: text("lot_code"),
  qtyReceived: numeric("qty_received").notNull(),
  qtyRemaining: numeric("qty_remaining").notNull(),
  unitCost: numeric("unit_cost").notNull().default("0"),
  supplierId: uuid("supplier_id"),          // → suppliers.id (Spec 9)
  poReceiptLineId: uuid("po_receipt_line_id"), // → po_receipt_lines.id (Spec 9)
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  expiryAt: timestamp("expiry_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("inventory_lots_fifo").on(t.itemId, t.locationId, t.receivedAt),
]);
// A partial index `WHERE qty_remaining > 0` is hand-appended (Step 4).

/** Append-only. On-hand(item, location) = Σ qty. Never UPDATE/DELETE (trigger).
 * qty is SIGNED in base UoM; uom is captured defensively at write time. */
export const stockLedger = pgTable("stock_ledger", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => inventoryItems.id, { onDelete: "restrict" }),
  locationId: uuid("location_id").notNull().references(() => storageLocations.id, { onDelete: "restrict" }),
  lotId: uuid("lot_id").references(() => inventoryLots.id, { onDelete: "restrict" }),
  type: stockLedgerTypeEnum("type").notNull(),
  qty: numeric("qty").notNull(),
  uom: unitOfMeasureEnum("uom").notNull(),
  unitCost: numeric("unit_cost"),
  refType: text("ref_type"),
  refId: text("ref_id"),
  byUserId: uuid("by_user_id").references(() => users.id),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("stock_ledger_item_loc").on(t.tenantId, t.itemId, t.locationId),
  index("stock_ledger_ref").on(t.tenantId, t.refType, t.refId),
]);

export const stockCounts = pgTable("stock_counts", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
  locationId: uuid("location_id").notNull().references(() => storageLocations.id, { onDelete: "restrict" }),
  status: stockCountStatusEnum("status").notNull().default("open"),
  startedByUserId: uuid("started_by_user_id").references(() => users.id),
  committedByUserId: uuid("committed_by_user_id").references(() => users.id),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  committedAt: timestamp("committed_at", { withTimezone: true }),
});

export const stockCountLines = pgTable("stock_count_lines", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  countId: uuid("count_id").notNull().references(() => stockCounts.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => inventoryItems.id, { onDelete: "restrict" }),
  systemQty: numeric("system_qty").notNull(),
  countedQty: numeric("counted_qty").notNull(),
  varianceQty: numeric("variance_qty").notNull(),
  note: text("note"),
});

/** The BOM for one made-to-order sellable. yieldQty scales components:
 * a sold qty of n consumes each component × (n / yieldQty). */
export const recipes = pgTable("recipes", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar").notNull(),
  yieldQty: numeric("yield_qty").notNull().default("1"),
  yieldUom: unitOfMeasureEnum("yield_uom").notNull().default("each"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("recipes_tenant").on(t.tenantId)]);

export const recipeComponents = pgTable("recipe_components", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  recipeId: uuid("recipe_id").notNull().references(() => recipes.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => inventoryItems.id, { onDelete: "restrict" }),
  qty: numeric("qty").notNull(),
  uom: unitOfMeasureEnum("uom").notNull(),
  wastePct: numeric("waste_pct").notNull().default("0"),
}, (t) => [index("recipe_components_recipe").on(t.recipeId)]);

/** Bridge from sellable → stockable. XOR: exactly one of (recipeId, itemId).
 * Unique per (productId, variantId) with NULL variant treated as one value. */
export const productInventoryLinks = pgTable("product_inventory_links", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  variantId: uuid("variant_id").references(() => productVariants.id, { onDelete: "cascade" }),
  linkType: productInventoryLinkTypeEnum("link_type").notNull(),
  recipeId: uuid("recipe_id").references(() => recipes.id, { onDelete: "restrict" }),
  itemId: uuid("item_id").references(() => inventoryItems.id, { onDelete: "restrict" }),
}, (t) => [index("product_inventory_links_product").on(t.productId)]);
// The XOR CHECK and the two partial unique indexes are hand-appended (Step 4).

export type InventoryItem = typeof inventoryItems.$inferSelect;
export type InventoryLot = typeof inventoryLots.$inferSelect;
export type StockLedgerRow = typeof stockLedger.$inferSelect;
export type StorageLocation = typeof storageLocations.$inferSelect;
export type Recipe = typeof recipes.$inferSelect;
export type RecipeComponent = typeof recipeComponents.$inferSelect;
export type ProductInventoryLink = typeof productInventoryLinks.$inferSelect;
export type StockCount = typeof stockCounts.$inferSelect;
export type StockCountLine = typeof stockCountLines.$inferSelect;
```

- [x] **Step 2: Register it.** Append to `src/db/schema.ts` (after the `pos/tender-schema` line):

```ts
export * from "../server/inventory/schema";
```

- [x] **Step 3: Generate the migration.** `npm run db:generate`. Expected: `drizzle/0033_*.sql` creating the **five** new enums, nine tables, FKs, and the declared indexes. It must **not** contain `CREATE TYPE ... unit_of_measure` — that type already exists (P4's migration); if drizzle emits one, the shared enum was re-declared rather than imported, so fix the schema instead of editing the SQL. It will **not** contain RLS, the trigger, the `CHECK`, or the partial/nulls-not-distinct indexes.

- [x] **Step 4: Hand-append RLS, the append-only trigger, the XOR CHECK, and the partial indexes.** Open the generated file and append (mirror `drizzle/0016_bitter_beast.sql:67-81` for the policy shape). For **each** of the nine tables:

```sql
--> statement-breakpoint
ALTER TABLE "inventory_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "inventory_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY inventory_items_isolation ON "inventory_items"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
```

(repeat for `storage_locations`, `inventory_lots`, `stock_ledger`, `stock_counts`, `stock_count_lines`, `product_inventory_links`, `recipes`, `recipe_components`). Then the append-only trigger on the ledger only — **not** on lots (the cache is mutable), **not** on counts (status transitions):

```sql
CREATE FUNCTION stock_ledger_no_mutate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'stock_ledger is append-only: % rejected', TG_OP;
END; $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER stock_ledger_append_only
  BEFORE UPDATE OR DELETE ON stock_ledger
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_no_mutate();--> statement-breakpoint
```

The trigger is `BEFORE UPDATE OR DELETE FOR EACH ROW` — it does **not** fire on `TRUNCATE`, so `src/db/test-harness.ts`'s `TRUNCATE … CASCADE` still resets the table between tests (identical to the `audit_events` reasoning). Then the partial lot index and the link constraints:

```sql
CREATE INDEX inventory_lots_available ON "inventory_lots" USING btree ("item_id","location_id","received_at") WHERE qty_remaining > 0;--> statement-breakpoint
ALTER TABLE "product_inventory_links" ADD CONSTRAINT product_inventory_links_xor CHECK (
  (link_type = 'recipe'        AND recipe_id IS NOT NULL AND item_id IS NULL) OR
  (link_type = 'finished_good' AND item_id   IS NOT NULL AND recipe_id IS NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX pil_product_base ON "product_inventory_links" ("product_id") WHERE variant_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX pil_product_variant ON "product_inventory_links" ("product_id","variant_id") WHERE variant_id IS NOT NULL;
```

- [x] **Step 5: Apply and verify the existing suite still passes.** `npm run db:migrate:test && npm test`. Expected: migration applies; full suite PASS (nothing references the new tables yet).

- [x] **Step 6: Commit.**

```bash
git add src/server/inventory/schema.ts src/db/schema.ts drizzle/
git commit -m "feat(inventory): 9 tenant-scoped tables with FORCE RLS, append-only stock_ledger trigger, link XOR + FIFO indexes"
```

---

## Task 3: UoM conversion — the pure quantity module

Every quantity that enters the ledger is first normalized to the item's base UoM, and every conversion is dimensionally checked. This is a **pure** module (no DB, no I/O), tested with fixed vectors, imported by the service (Task 4), the rewire (Task 5), and the dashboard validation (Task 8) — one implementation, so a recipe line, a receipt, and an adjustment all normalize identically.

**Files:**
- Create: `src/server/inventory/uom.ts`, `uom.test.ts`
- Create: `src/server/inventory/errors.ts`

**Interfaces:**
- Consumes: `type UnitOfMeasure` from `@/server/catalog/uom-values` — the drizzle-free values module, so this stays pure and importable anywhere. Units are **never** re-declared here.
- Produces:
  - `const INVENTORY_UOMS = ["each","g","kg","ml","l"] as const` and `type Uom = (typeof INVENTORY_UOMS)[number]` — the stockable **subset** of the platform enum, derived by narrowing `UnitOfMeasure` (a `satisfies readonly UnitOfMeasure[]` assertion makes a future enum rename a compile error rather than a silent drift).
  - `function assertInventoryUom(u: UnitOfMeasure): Uom` — the gate every UoM-bearing write passes through; throws `DimensionalUomError` for `m`/`m2`/`bf`, which are sellable dimensional units (P4) and not stockable.
  - `type Dimension = "mass" | "volume" | "count"`; `function dimensionOf(uom: Uom): Dimension`
  - `const QTY_SCALE = 3`; `function qty(n: number): string` — the fractional-quantity formatter (the `money(n)` analog).
  - `function assertSameDimension(a: Uom, b: Uom): void` — throws `DimensionalUomError` on mismatch.
  - `function toBase(value: number, fromUom: Uom, item: { baseUom: Uom; stockToBase: string; purchaseToBase: string; recipeToBase: string }, factorKind?: "stock" | "purchase" | "recipe"): number` — converts `value fromUom` into the item's base unit, validating dimension.
  - `function withWaste(baseQty: number, wastePct: number): number` — `baseQty × (1 + wastePct/100)`.
  - `function scaleForYield(perBatch: number, soldQty: number, yieldQty: number): number` — `perBatch × (soldQty / yieldQty)`.

- [x] **Step 1: Write the failing tests.** Create `src/server/inventory/uom.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { qty, dimensionOf, assertSameDimension, assertInventoryUom, toBase, withWaste, scaleForYield } from "./uom";
import { DimensionalUomError } from "./errors";

const gramItem = { baseUom: "g" as const, stockToBase: "1000", purchaseToBase: "1000", recipeToBase: "1" };

describe("qty", () => {
  it("formats to fixed scale-3 numeric string (the money(n) analog for quantities)", () => {
    expect(qty(1)).toBe("1.000");
    expect(qty(0.5)).toBe("0.500");
    expect(qty(1 / 3)).toBe("0.333");
  });
});

describe("dimension checks", () => {
  it("classifies each uom", () => {
    expect(dimensionOf("kg")).toBe("mass");
    expect(dimensionOf("l")).toBe("volume");
    expect(dimensionOf("each")).toBe("count");
  });
  it("rejects cross-dimension conversion (g↔ml — density not modelled)", () => {
    expect(() => assertSameDimension("g", "ml")).toThrow(DimensionalUomError);
    expect(() => assertSameDimension("kg", "g")).not.toThrow();
  });
});

describe("assertInventoryUom", () => {
  // The shared unit_of_measure enum is a superset: it also carries P4's sellable
  // dimensional units. The DB cannot express the subset, so this guard is the
  // only thing keeping an m2 out of the ledger.
  it("accepts the five stockable units", () => {
    for (const u of ["each", "g", "kg", "ml", "l"] as const) {
      expect(assertInventoryUom(u)).toBe(u);
    }
  });
  it("rejects P4 sellable dimensional units", () => {
    for (const u of ["m", "m2", "bf"] as const) {
      expect(() => assertInventoryUom(u)).toThrow(DimensionalUomError);
    }
  });
});

describe("toBase", () => {
  it("normalizes kg → g when base is g (250 g)", () => {
    expect(toBase(0.25, "kg", gramItem)).toBe(250);
  });
  it("passes through when already base", () => {
    expect(toBase(120, "g", gramItem)).toBe(120);
  });
  it("throws when the source dimension can't reach the base", () => {
    expect(() => toBase(1, "ml", gramItem)).toThrow(DimensionalUomError);
  });
});

describe("scaling", () => {
  it("applies waste percentage", () => { expect(withWaste(100, 10)).toBe(110); });
  it("scales components by soldQty / yieldQty", () => { expect(scaleForYield(50, 4, 2)).toBe(100); });
});
```

- [x] **Step 2: Run to verify they fail.** `npx vitest run src/server/inventory/uom.test.ts` → FAIL (module not found).

- [x] **Step 3: Implement `errors.ts`.** Create `src/server/inventory/errors.ts` (follow the `DomainError` shape of `ordering/errors.ts`):

```ts
import { DomainError, type Locale } from "@/shared/errors";
export { OutOfStockError } from "@/server/ordering/errors"; // retail shortfall reuses the existing typed error

export class DimensionalUomError extends DomainError {
  readonly code = "dimensional_uom";
  constructor(readonly from: string, readonly to: string) {
    super(`Cannot convert ${from} to ${to}: different dimensions`);
    this.name = "DimensionalUomError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "لا يمكن تحويل وحدات القياس المختلفة" : "These units of measure can't be converted to each other";
  }
}

export class InventoryConfigError extends DomainError {
  readonly code = "inventory_config";
  constructor(readonly detail: string) { super(`Inventory misconfigured: ${detail}`); this.name = "InventoryConfigError"; }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "إعداد المخزون غير مكتمل" : "Inventory isn't fully configured for this item";
  }
}
```

- [x] **Step 4: Implement `uom.ts`.** Base unit per dimension is the smallest (`g`, `ml`, `each`); `kg`/`l` carry the ×1000 factor. `toBase` uses the explicit per-item factor when `factorKind` is given (stock/purchase/recipe columns), and always validates the dimension of `fromUom` against `item.baseUom`:

```ts
import type { UnitOfMeasure } from "@/server/catalog/uom-values";
import { DimensionalUomError } from "./errors";

/** The stockable SUBSET of the platform-wide unit_of_measure enum. The enum also
 * carries P4's sellable dimensional units (m/m2/bf), which are not stockable —
 * a pg enum cannot express a subset, so assertInventoryUom is the boundary.
 * The `satisfies` turns a future enum rename into a compile error, not drift. */
export const INVENTORY_UOMS = ["each", "g", "kg", "ml", "l"] as const satisfies readonly UnitOfMeasure[];
export type Uom = (typeof INVENTORY_UOMS)[number];
export type Dimension = "mass" | "volume" | "count";
export const QTY_SCALE = 3;

export function assertInventoryUom(u: UnitOfMeasure): Uom {
  if (!(INVENTORY_UOMS as readonly string[]).includes(u)) throw new DimensionalUomError(u, "a stockable unit");
  return u as Uom;
}

const DIM: Record<Uom, Dimension> = { each: "count", g: "mass", kg: "mass", ml: "volume", l: "volume" };
/** Factor to convert a value in `uom` into that dimension's canonical smallest unit. */
const TO_CANONICAL: Record<Uom, number> = { each: 1, g: 1, kg: 1000, ml: 1, l: 1000 };

export function dimensionOf(uom: Uom): Dimension { return DIM[uom]; }
export function qty(n: number): string { return (Math.round(n * 1000) / 1000).toFixed(QTY_SCALE); }

export function assertSameDimension(a: Uom, b: Uom): void {
  if (DIM[a] !== DIM[b]) throw new DimensionalUomError(a, b);
}

export function toBase(
  value: number, fromUom: Uom,
  item: { baseUom: Uom; stockToBase: string; purchaseToBase: string; recipeToBase: string },
  factorKind?: "stock" | "purchase" | "recipe",
): number {
  assertSameDimension(fromUom, item.baseUom);
  if (factorKind) {
    // The item declares how many base units one <kind>Uom is worth.
    const f = { stock: item.stockToBase, purchase: item.purchaseToBase, recipe: item.recipeToBase }[factorKind];
    return value * Number(f);
  }
  // Otherwise convert dimensionally: value → canonical → base.
  return (value * TO_CANONICAL[fromUom]) / TO_CANONICAL[item.baseUom];
}

export function withWaste(baseQty: number, wastePct: number): number { return baseQty * (1 + wastePct / 100); }
export function scaleForYield(perBatch: number, soldQty: number, yieldQty: number): number {
  return perBatch * (soldQty / (yieldQty || 1));
}
```

- [x] **Step 5: Run + typecheck.** `npx vitest run src/server/inventory/uom.test.ts && npx tsc --noEmit`. Expected PASS, clean.

- [x] **Step 6: Commit.**

```bash
git add src/server/inventory/uom.ts src/server/inventory/uom.test.ts src/server/inventory/errors.ts
git commit -m "feat(inventory): pure UoM module — dimensional conversion, qty(n) formatter, waste/yield scaling"
```

---

## Task 4: Inventory service — ledger writer, on-hand projection, FIFO deduction

The one module that writes `stock_ledger` and moves the `inventory_lots.qtyRemaining` cache. It provides on-hand as a ledger projection, the receive/adjust/transfer/count movements, and the two functions the order path consumes (`deductForOrderLine`, `reverseOrderDeductions`). Every writer runs on a caller-supplied `tx` so it composes into `placeOrder`'s transaction; the read helpers open their own `withTenant`.

**Files:**
- Create: `src/server/inventory/service.ts`, `service.test.ts`, `test-helpers.ts`

**Interfaces:**
- Consumes: `toBase`, `qty`, `withWaste`, `scaleForYield`, `Uom` (Task 3); the Task 2 tables; `OutOfStockError`, `InventoryConfigError` (Task 3); `withTenant` (`@/db/with-tenant`); `notify` (`@/server/notifications/service` — Spec 5, merged) for the oversell alert; `recordAuditEvent` (`@/server/audit/service` — Spec 4) on the operator-driven movements (`adjustStock`, `transferStock`, `commitCount`), which is what satisfies the `forward:inventory.*` coverage guardrail. `deductForOrderLine` does **not** emit its own audit event — it is part of `placeOrder`, whose event already covers the sale; the ledger rows are the audit trail for the deduction.
- Produces:
  - `type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]`
  - `function onHand(tenantId: string, itemId: string, locationId: string): Promise<number>` — `Σ ledger.qty`.
  - `function getOrCreateDefaultLocation(tx: Tx, tenantId: string, branchId: string, kind: StorageLocationKind): Promise<StorageLocation>`
  - `function receiveStock(tx: Tx, args: ReceiveArgs): Promise<{ lotId: string }>` — creates a lot + a `receive` (or `adjustment` opening-balance) ledger row.
  - `function adjustStock(tx: Tx, args: AdjustArgs): Promise<void>` — signed `adjustment`/`waste` row.
  - `function transferStock(tx: Tx, args: TransferArgs): Promise<void>` — two balanced rows.
  - `function commitCount(tx: Tx, countId: string, byUserId: string): Promise<void>` — one `count` variance row per line.
  - `function deductForOrderLine(tx: Tx, args: DeductArgs): Promise<void>` — the resolver + FIFO (Task 5 wires it).
  - `function reverseOrderDeductions(tx: Tx, args: ReverseArgs): Promise<void>` — `refund_restock` rows (Task 6 wires it).

- [x] **Step 1: Write the failing tests.** Create `src/server/inventory/service.test.ts` — seed a tenant + branch (reuse the tenant-seeding shape from other suites), a location, and items via the service, then assert:

```ts
describe("inventory ledger", () => {
  it("on-hand is the sum of the ledger, not the lot cache", async () => {
    // receiveStock 10 g, then adjustStock -3 g → onHand = 7
  });
  it("receiveStock creates a lot whose qtyRemaining equals the received base qty", async () => { /* … */ });
  it("transferStock writes two balanced rows: -q at source, +q at destination", async () => { /* … */ });
  it("FIFO deducts the oldest lot first, spanning into the next when short", async () => {
    // two lots (older 4 g, newer 10 g); deduct 6 → older→0, newer→8; two sale_deduction rows
  });
  it("expiry-first: a perishable item consumes the soonest-expiring lot before an older-received one", async () => { /* … */ });
  it("the stock_ledger append-only trigger rejects UPDATE and DELETE", async () => {
    await expect(withTenant(tenantId, (tx) =>
      tx.execute(sql`UPDATE stock_ledger SET qty = '0'`))).rejects.toThrow(/append-only/);
  });
  it("hides one tenant's ledger from another (RLS)", async () => { /* … */ });
});
```

- [x] **Step 2: Run to verify they fail.** `npx vitest run src/server/inventory/service.test.ts` → FAIL (module not found).

- [x] **Step 3: Implement the movements + on-hand.** Create `src/server/inventory/service.ts`. On-hand is the projection; each writer inserts a ledger row and (for lot-bearing movements) moves the cache in the same `tx`:

```ts
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { inventoryItems, inventoryLots, storageLocations, stockLedger, stockCounts, stockCountLines,
  productInventoryLinks, recipes, recipeComponents, type StorageLocation } from "./schema";
import { qty, toBase, withWaste, scaleForYield, type Uom } from "./uom";
import { OutOfStockError, InventoryConfigError } from "./errors";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const EPS = 0.0005;

export async function onHand(tenantId: string, itemId: string, locationId: string): Promise<number> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select({ sum: sql<string>`COALESCE(SUM(${stockLedger.qty}), 0)` }).from(stockLedger)
      .where(and(eq(stockLedger.itemId, itemId), eq(stockLedger.locationId, locationId))));
  return Number(row.sum);
}

export async function getOrCreateDefaultLocation(
  tx: Tx, tenantId: string, branchId: string, kind: StorageLocation["kind"],
): Promise<StorageLocation> {
  const [existing] = await tx.select().from(storageLocations)
    .where(and(eq(storageLocations.branchId, branchId), eq(storageLocations.kind, kind), eq(storageLocations.isActive, true)))
    .orderBy(sql`is_default DESC`).limit(1);
  if (existing) return existing;
  // Never block a sale on a missing location — provision the branch default lazily.
  const [created] = await tx.insert(storageLocations)
    .values({ tenantId, branchId, name: kind === "kitchen" ? "Kitchen" : kind === "retail" ? "Front Shelf" : kind, kind, isDefault: true })
    .returning();
  return created;
}
```

`receiveStock` (a lot + a positive ledger row; `ledgerType` defaults to `receive`, migration passes `adjustment` for opening balances):

```ts
export type ReceiveArgs = {
  tenantId: string; itemId: string; locationId: string; baseQty: number; uom: Uom;
  unitCost?: string | null; lotCode?: string | null; supplierId?: string | null; poReceiptLineId?: string | null;
  expiryAt?: Date | null; receivedAt?: Date; byUserId?: string | null; note?: string | null;
  ledgerType?: "receive" | "adjustment";
};
export async function receiveStock(tx: Tx, a: ReceiveArgs): Promise<{ lotId: string }> {
  const [lot] = await tx.insert(inventoryLots).values({
    tenantId: a.tenantId, itemId: a.itemId, locationId: a.locationId, lotCode: a.lotCode ?? null,
    qtyReceived: qty(a.baseQty), qtyRemaining: qty(a.baseQty), unitCost: a.unitCost ?? "0",
    supplierId: a.supplierId ?? null, poReceiptLineId: a.poReceiptLineId ?? null,
    receivedAt: a.receivedAt ?? new Date(), expiryAt: a.expiryAt ?? null,
  }).returning({ id: inventoryLots.id });
  await tx.insert(stockLedger).values({
    tenantId: a.tenantId, itemId: a.itemId, locationId: a.locationId, lotId: lot.id,
    type: a.ledgerType ?? "receive", qty: qty(a.baseQty), uom: a.uom, unitCost: a.unitCost ?? null,
    refType: "inventory_lot", refId: lot.id, byUserId: a.byUserId ?? null, note: a.note ?? null,
  });
  return { lotId: lot.id };
}
```

`adjustStock` (signed, `adjustment` or `waste`; lot-less bulk adjust allowed), `transferStock` (two balanced rows sharing a `refId` group id via `randomUUID()`), and `commitCount` (snapshot `systemQty` at start; on commit write one `count` row per line for `countedQty − systemQty`, set status `committed`). Follow the `receiveStock` shape.

- [x] **Step 4: Implement `deductForOrderLine` + the shared FIFO core.** The resolver reads `product_inventory_links`, then deducts. The FIFO loop keeps the guarded-`UPDATE` serialization point at lot granularity:

```ts
export type DeductArgs = {
  tenantId: string; branchId: string; productId: string; variantId: string | null;
  quantity: number; orderItemId: string; allowNegative: boolean; byUserId: string | null;
  productNameEn: string; productNameAr: string;
};

export async function deductForOrderLine(tx: Tx, a: DeductArgs): Promise<void> {
  const [link] = await tx.select().from(productInventoryLinks).where(and(
    eq(productInventoryLinks.productId, a.productId),
    a.variantId ? eq(productInventoryLinks.variantId, a.variantId) : sql`variant_id IS NULL`,
  )).limit(1);
  if (!link) return; // no link → no deduction (today's untracked passthrough)

  if (link.linkType === "finished_good") {
    const loc = await getOrCreateDefaultLocation(tx, a.tenantId, a.branchId, "retail");
    const [item] = await tx.select().from(inventoryItems).where(eq(inventoryItems.id, link.itemId!)).limit(1);
    if (!item) throw new InventoryConfigError("linked finished-goods item missing");
    await deductFifo(tx, a, item, loc.id, a.quantity); // sold qty is base-UoM for finished goods
    return;
  }

  // recipe: scale each component by soldQty / yieldQty, apply wastePct, deduct FIFO from the kitchen.
  const loc = await getOrCreateDefaultLocation(tx, a.tenantId, a.branchId, "kitchen");
  const [recipe] = await tx.select().from(recipes).where(eq(recipes.id, link.recipeId!)).limit(1);
  if (!recipe) throw new InventoryConfigError("linked recipe missing");
  const comps = await tx.select().from(recipeComponents).where(eq(recipeComponents.recipeId, recipe.id));
  for (const c of comps) {
    const [item] = await tx.select().from(inventoryItems).where(eq(inventoryItems.id, c.itemId)).limit(1);
    if (!item) throw new InventoryConfigError("recipe component item missing");
    const perBatch = withWaste(toBase(Number(c.qty), c.uom, item), Number(c.wastePct));
    const need = scaleForYield(perBatch, a.quantity, Number(recipe.yieldQty));
    await deductFifo(tx, a, item, loc.id, need);
  }
}

/** FIFO across an item's lots at one location. The guarded UPDATE is the
 * serialization point — WHERE qty_remaining >= take re-evaluates under READ
 * COMMITTED, so two concurrent sales can't both take the last unit. */
async function deductFifo(
  tx: Tx, a: DeductArgs, item: typeof inventoryItems.$inferSelect, locationId: string, needBase: number,
): Promise<void> {
  let need = needBase;
  // Perishables consume soonest-expiry first; otherwise oldest-received first.
  const order = item.isPerishable
    ? sql`expiry_at ASC NULLS LAST, received_at ASC`
    : sql`received_at ASC`;
  for (let guard = 0; need > EPS && guard < 10_000; guard++) {
    const [lot] = await tx.select().from(inventoryLots).where(and(
      eq(inventoryLots.itemId, item.id), eq(inventoryLots.locationId, locationId), gt(inventoryLots.qtyRemaining, "0"),
    )).orderBy(order).limit(1);
    if (!lot) break; // lots exhausted → shortfall branch below
    const take = Math.min(need, Number(lot.qtyRemaining));
    const hit = await tx.update(inventoryLots)
      .set({ qtyRemaining: sql`${inventoryLots.qtyRemaining} - ${qty(take)}` })
      .where(and(eq(inventoryLots.id, lot.id), sql`qty_remaining >= ${qty(take)}`))
      .returning({ id: inventoryLots.id });
    if (hit.length === 0) continue; // a concurrent sale took it first — re-read the next candidate
    await tx.insert(stockLedger).values({
      tenantId: a.tenantId, itemId: item.id, locationId, lotId: lot.id, type: "sale_deduction",
      qty: qty(-take), uom: item.baseUom, unitCost: lot.unitCost, refType: "order_item", refId: a.orderItemId,
      byUserId: a.byUserId,
    });
    need -= take;
  }
  if (need > EPS) {
    if (!a.allowNegative) throw new OutOfStockError(a.productNameEn, a.productNameAr);
    // Kitchen policy: record the shortfall, on-hand goes negative, alert fires.
    await tx.insert(stockLedger).values({
      tenantId: a.tenantId, itemId: item.id, locationId, lotId: null, type: "sale_deduction",
      qty: qty(-need), uom: item.baseUom, refType: "order_item", refId: a.orderItemId, byUserId: a.byUserId,
      note: "shortfall — allowNegativeStock",
    });
    // Spec 5 has merged, so this is a real notification, not a stub. notify()
    // runs on OUR tx: the alert commits with the sale or not at all, and it never
    // touches the network (the outbox worker sends). low_stock is already in the
    // notification type enum — Spec 5 pre-provisioned it for this spec.
    await notify({ tenantId: a.tenantId }, {
      type: "low_stock",
      severity: "warning",
      title: `${item.nameEn} oversold`,
      body: `${item.nameEn} went ${qty(need)} ${item.baseUom} below zero at this location — on-hand is negative until a count or receipt reconciles it.`,
      entityType: "inventory_item",
      entityId: item.id,
      targets: [{ role: "owner" }, { role: "manager" }],
      channels: ["in_app", "email"],
      branchId: a.branchId,
    }, tx);
  }
}
```

**Alert debouncing is deliberately *not* added here.** The spec debounces the *scheduled* reorder check (Part D, Spec 9's plan) because that re-evaluates a lingering low state every run. This path is different: it fires only on an actual oversell event, so one notification per oversell is the correct signal, not noise. If a single kitchen oversells the same ingredient across many lines of one order, that is several rows and several alerts — flagged as a known sharp edge for Part D to smooth once the debounce table exists, rather than half-built here.

- [x] **Step 5: Implement `reverseOrderDeductions`** (Task 6 wires it; define it here so the module is complete). Read the order's `sale_deduction` rows and write a `refund_restock` row per row with the negated qty, restoring the **same lot**; if the lot is gone/depleted, land on a system adjustment lot flagged for review. See Task 6, Step 3 for the body.

- [x] **Step 6: Add `test-helpers.ts`.** `seedFinishedGood(tenantId, { branchId, productId, variantId?, onHand, unitCost? })` — creates an `inventory_item` (`finished_good`, base `each`), a default `retail` location, a `finished_good` `product_inventory_links` row, and calls `receiveStock` for `onHand`. `seedRecipeProduct(tenantId, { branchId, productId, components: [{ item, qty, uom, wastePct?, onHand }] })` — creates ingredient items + a `kitchen` location + lots + a `recipe` with components + a `recipe` link. These are what the order-path tests seed with (Task 5) instead of the flat integer.

- [x] **Step 7: Run + typecheck + lint.** `npx vitest run src/server/inventory/service.test.ts && npx tsc --noEmit && npx eslint src/server/inventory`. Expected PASS, clean.

- [x] **Step 8: Commit.**

```bash
git add src/server/inventory/service.ts src/server/inventory/service.test.ts src/server/inventory/test-helpers.ts
git commit -m "feat(inventory): ledger service — on-hand projection, receive/adjust/transfer/count, FIFO deduction with per-lot guarded UPDATE"
```

---

## Task 5: Rewire `placeOrder`'s stock step

Replace the flat guarded-integer block (`service.ts:216-233`, gated on `caps.stockTracking`) with a resolver gated on `caps.inventory`, run **inside the same `withTenant` transaction** so deduction is atomic with order creation. Deduction moves to a pass **after** the order + items are inserted, so each `sale_deduction` row carries `refId = orderItemId` (a retail shortfall still throws and rolls the whole order back — no order is created, identical to today).

**Files:**
- Modify: `src/server/ordering/service.ts`
- Modify: `src/server/ordering/place-order.test.ts`

**Interfaces:**
- Consumes: `deductForOrderLine` (Task 4), `getAllowNegativeStock` (Task 1).
- Produces: no signature change to `placeOrder`; internal behaviour change only. `caps.stockTracking` reads in the order path become `caps.inventory`.

- [x] **Step 1: Write the failing tests.** In `src/server/ordering/place-order.test.ts`, rewrite the `describe("placeOrder retail variants + stock")` suite (the `setupRetail` helper seeds `stockQuantity: 2` on the variant, which no longer drives deduction). Seed lots via the inventory helper instead, and add restaurant recipe + negative-policy cases:

```ts
import { seedFinishedGood, seedRecipeProduct } from "@/server/inventory/test-helpers";
import { onHand } from "@/server/inventory/service";

it("retail: a finished-goods line deducts the linked lot FIFO and blocks past zero", async () => {
  const { t, branch, hinge, v35 } = await setupRetail("rv2"); // stock seeded via seedFinishedGood(onHand: 2)
  await placeOrder(t.id, { /* qty 2 */ });                     // → lot at 0
  await expect(placeOrder(t.id, { /* qty 1 */ })).rejects.toThrow(OutOfStockError);
});

it("retail: exactly one of two concurrent orders for the last unit succeeds", async () => {
  // seedFinishedGood(onHand: 1); Promise.allSettled two attempts → 1 fulfilled, 1 rejected
});

it("restaurant: selling a dish deducts each recipe component FIFO from the kitchen", async () => {
  // seedRecipeProduct: Margherita = 150 g flour + 100 g tomato; sell 2 → flour −300 g, tomato −200 g
  // assert onHand(flour, kitchen) and two sale_deduction rows per component
});

it("restaurant: overselling past zero completes the sale, records a negative-on-hand deduction, never throws", async () => {
  // allowNegativeStock defaults true for restaurant; sell more than on-hand → order created, onHand < 0
});

it("no product_inventory_links → sale proceeds and touches no ledger (untracked passthrough)", async () => {
  // a published product with no link; placeOrder succeeds, stock_ledger has 0 rows for it
});
```

Update `setupRetail` to call `await seedFinishedGood(t.id, { branchId: branch.id, productId: hinge.id, variantId: v35.id, onHand: 2 })` after creating the variant, and drop the `stockQuantity: 2` reliance for deduction assertions.

- [x] **Step 2: Run to verify they fail.** `npx vitest run src/server/ordering/place-order.test.ts` → FAIL (no deduction happens yet; the recipe/negative cases error).

- [x] **Step 3: Resolve `allowNegative` before the transaction.** In `placeOrder`, alongside where `caps`/`tenant`/`pricing` are resolved (before `withTenant`), add:

```ts
import { deductForOrderLine } from "@/server/inventory/service";
import { getAllowNegativeStock } from "@/server/tenancy/settings";
// …
const allowNegative = caps.inventory ? await getAllowNegativeStock(tenantId) : false;
```

- [x] **Step 4: Remove the in-loop integer block.** Delete the `if (caps.stockTracking) { … }` block at `service.ts:216-233` entirely (both the variant and product branches). The loop now only prices lines and builds `itemsToInsert`. Check the `drizzle-orm` import line afterwards — `gte`/`isNull`/`or` may become unused once the guarded integer `UPDATE`s are gone, and `eslint` will fail on them.

- [x] **Step 5: Add the deduction pass after items insert.** Immediately after the `orderStatusEvents` insert (step 6 of `placeOrder`), before the `return`:

```ts
    // Inventory deduction — atomic with the order. Runs on THIS tx: a retail
    // shortfall throws OutOfStockError and rolls the whole order back (no order
    // created), exactly as the flat-integer guard did. No product_inventory_links
    // row → no deduction (untracked passthrough).
    if (caps.inventory) {
      for (let i = 0; i < itemsToInsert.length; i++) {
        await deductForOrderLine(tx, {
          tenantId, branchId: input.branchId,
          productId: itemsToInsert[i].productId, variantId: itemsToInsert[i].variantId,
          quantity: itemsToInsert[i].quantity, orderItemId: inserted[i].id,
          allowNegative, byUserId: input.cashierUserId ?? null,
          productNameEn: itemsToInsert[i].nameEn, productNameAr: itemsToInsert[i].nameAr,
        });
      }
    }
```

(`inserted` is the `orderItems` insert result, index-aligned with `itemsToInsert`.)

- [x] **Step 6: Run the order tests + the FIFO concurrency check.** `npx vitest run src/server/ordering/place-order.test.ts src/server/inventory/service.test.ts`. Expected PASS — the concurrency test proves the per-lot guarded UPDATE serializes (the analog of the old stock-race test); the restaurant negative-policy test proves the till never throws.

- [x] **Step 7: Typecheck + lint + commit.**

```bash
npx tsc --noEmit && npx eslint src/server/ordering src/server/inventory
git add src/server/ordering/service.ts src/server/ordering/place-order.test.ts
git commit -m "feat(inventory): rewire placeOrder to deduct recipe components / finished goods FIFO; kitchens oversell, retail blocks"
```

---

## Task 6: Restock on cancel / refund — reverse the ledger

`restockOrderItems` (`service.ts:279-295`) currently adds integers back. Rewire it to **reverse the ledger**: for each `sale_deduction` row of the order, write a `refund_restock` row with the negated (positive) qty, restore the **same lot** (bump its `qtyRemaining`), and link back via `refType='stock_ledger', refId=<reversed row>`. Reversing to the original lot keeps FIFO cost layers honest; a since-depleted/absent lot lands on a system adjustment lot flagged for review.

**Files:**
- Modify: `src/server/ordering/service.ts`
- Modify: `src/server/inventory/service.ts` (`reverseOrderDeductions` body, stubbed in Task 4)
- Test: `src/server/ordering/place-order.test.ts` (restock case)

**Interfaces:**
- Consumes: `reverseOrderDeductions` (Task 4).
- Produces: `reverseOrderDeductions(tx, { tenantId, orderId, byUserId?, orderItemIds? })` — reverses all `sale_deduction` rows of the order (or only the given item ids, for Spec 3 partial refunds).

- [x] **Step 1: Write the failing restock test.** Rewrite the existing `it("restocks on customer cancel")` in `place-order.test.ts` to assert against the ledger and lot cache:

```ts
it("cancel restocks the exact lot via a refund_restock row and restores on-hand", async () => {
  const { t, branch, hinge, v35, locationId, itemId } = await setupRetail("rv5"); // seedFinishedGood(onHand: 2)
  const res = await placeOrder(t.id, { /* qty 2 */ });                            // onHand → 0
  await cancelOrderByToken(t.id, res.statusToken);
  expect(await onHand(t.id, itemId, locationId)).toBe(2);                          // back to full
  // a refund_restock row exists reversing the sale_deduction; the original lot's qtyRemaining is 2 again
});
```

- [x] **Step 2: Run to verify it fails.** `npx vitest run src/server/ordering/place-order.test.ts -t restocks` → FAIL (still integer-based / no ledger reversal).

- [x] **Step 3: Implement `reverseOrderDeductions`** in `src/server/inventory/service.ts`:

```ts
export type ReverseArgs = { tenantId: string; orderId: string; byUserId?: string | null; orderItemIds?: string[] };

export async function reverseOrderDeductions(tx: Tx, a: ReverseArgs): Promise<void> {
  // The order's own sale_deduction rows are the exact movements to undo.
  const itemIds = a.orderItemIds
    ?? (await tx.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.orderId, a.orderId))).map((r) => r.id);
  if (itemIds.length === 0) return;
  const deductions = await tx.select().from(stockLedger).where(and(
    eq(stockLedger.type, "sale_deduction"), eq(stockLedger.refType, "order_item"), inArray(stockLedger.refId, itemIds),
  ));
  for (const d of deductions) {
    const restoreQty = -Number(d.qty); // sale_deduction.qty is negative → positive restock
    let lotId = d.lotId;
    if (lotId) {
      const hit = await tx.update(inventoryLots)
        .set({ qtyRemaining: sql`${inventoryLots.qtyRemaining} + ${qty(restoreQty)}` })
        .where(eq(inventoryLots.id, lotId)).returning({ id: inventoryLots.id });
      if (hit.length === 0) lotId = null; // original lot gone → fall through to a review lot
    }
    if (!lotId) {
      // Depleted/absent original lot: land on a system adjustment lot flagged for review
      // rather than resurrecting a consumed cost layer.
      const { lotId: reviewLot } = await receiveStock(tx, {
        tenantId: a.tenantId, itemId: d.itemId, locationId: d.locationId, baseQty: restoreQty, uom: d.uom,
        unitCost: d.unitCost, lotCode: "restock-review", ledgerType: "adjustment", byUserId: a.byUserId ?? null,
        note: "refund_restock — original lot unavailable, flagged for review",
      });
      lotId = reviewLot; // the receiveStock above already wrote its own ledger row; skip the refund_restock row
      continue;
    }
    await tx.insert(stockLedger).values({
      tenantId: a.tenantId, itemId: d.itemId, locationId: d.locationId, lotId, type: "refund_restock",
      qty: qty(restoreQty), uom: d.uom, unitCost: d.unitCost, refType: "stock_ledger", refId: d.id,
      byUserId: a.byUserId ?? null,
    });
  }
}
```

(Add `orderItems` and `inArray` to the imports.)

- [x] **Step 4: Rewire `restockOrderItems`** in `src/server/ordering/service.ts`. Replace its body with a gated call, and update both call sites (`cancelOrderByToken`, `transitionStatus` for `cancelled`/`rejected`) to pass `caps.inventory`:

```ts
async function restockOrderItems(tx, orderId: string, caps: { inventory: boolean }): Promise<void> {
  if (!caps.inventory) return;
  await reverseOrderDeductions(tx, { tenantId: <tenantId in scope>, orderId });
}
```

(Import `reverseOrderDeductions`; the `caps` param type changes from `{ stockTracking }` to `{ inventory }` — update the two callers accordingly. The `tenantId` is already in scope in both transactions.)

- [x] **Step 5: Run + typecheck + lint + commit.**

```bash
npx vitest run src/server/ordering/place-order.test.ts && npx tsc --noEmit && npx eslint src/server/ordering src/server/inventory
git add src/server/ordering/service.ts src/server/inventory/service.ts src/server/ordering/place-order.test.ts
git commit -m "feat(inventory): restock cancels/refunds via refund_restock ledger reversal to the original lot"
```

---

## Task 7: Migration — backfill flat stock into items + opening balances; deprecate the shims

The flat integer must become a ledger **without a gap in retail continuity**. A data-migration script seeds every branch a default location and every stocked product/variant an item + finished-goods link + an **opening-balance** lot and ledger row (`type='adjustment'`, `note='opening balance'`), so on-hand after migration **equals** the old integer. `setProductStock` / `setVariantStock` become adjustment shims that keep the legacy integer **mirrored** (the storefront `inStock` computation still reads it — its rewire to on-hand and the column drop are explicitly **deferred**, per spec Migration §5).

**Files:**
- Create: `scripts/backfill-inventory.ts`, `src/server/inventory/backfill.test.ts`
- Modify: `src/server/catalog/variants.ts`

**Interfaces:**
- Produces:
  - `function backfillTenant(tenantId: string): Promise<{ items: number; lots: number }>` — idempotent seed (skips products that already have a link).
  - `setProductStock` / `setVariantStock` retained, now adjustment shims (see Step 4).

- [x] **Step 1: Write the failing migration test.** Create `src/server/inventory/backfill.test.ts` (the spec's named migration test):

```ts
describe("inventory backfill", () => {
  it("seeds an item + finished_good link + opening ledger whose on-hand equals the old integer", async () => {
    // retail tenant, product trackStock=true stockQuantity=7 (+ a variant stockQuantity=3)
    const { t, branch, product, variant } = await seedRetailWithFlatStock(7, 3);
    await backfillTenant(t.id);
    // product link → item; onHand(item, retail location) === 7; variant → 3
    // the opening ledger row is type 'adjustment' note 'opening balance'
  });
  it("is idempotent — a second run creates no duplicate links or lots", async () => { /* … */ });
  it("a sale post-backfill deducts identically to the pre-migration integer path", async () => {
    // after backfill, placeOrder qty 7 → onHand 0; qty 1 more → OutOfStockError (retail blocks)
  });
});
```

- [x] **Step 2: Run to verify they fail.** `npx vitest run src/server/inventory/backfill.test.ts` → FAIL (module not found).

- [x] **Step 3: Implement `backfillTenant`.** Create `scripts/backfill-inventory.ts` (import-safe: export `backfillTenant`, and add a `main()` that iterates all tenants when run via `tsx`, mirroring `scripts/migrate.ts`). Per tenant, in one `withTenant` transaction:
  1. For every branch, `getOrCreateDefaultLocation(tx, tenantId, branchId, kind)` — `kitchen` for restaurant, `retail` otherwise (plus `back_of_house` where sensible).
  2. For every `product` with `trackStock=true` and non-null `stockQuantity` **without** an existing link: create an `inventory_item` (`kind='finished_good'`, `baseUom='each'`, `stock/purchase/recipeUom='each'`, `defaultUnitCost` = product cost if available), a `product_inventory_links` row (`linkType='finished_good'`), and call `receiveStock(tx, { …, baseQty: stockQuantity, uom: 'each', ledgerType: 'adjustment', note: 'opening balance' })` against the branch's retail location.
  3. Same for every `product_variant` with non-null `stockQuantity` (link carries `variantId`).
  On-hand after = the old integer (asserted by the test). Idempotency: skip any `(productId, variantId)` that already has a link.

  > **Per-branch note:** the flat counter was a single global number; the backfill lands it on each branch's **default** location. Multi-branch tenants reconcile real per-branch quantities via a stock count (Task 8) after go-live — the spec accepts this as the migration's one modelling compromise, and the opening-balance ledger row makes it auditable.

- [x] **Step 4: Convert the writer shims.** In `src/server/catalog/variants.ts`, `setProductStock` / `setVariantStock` keep writing the legacy integer (mirror — the storefront still reads it) **and** post a reconciling `adjustment` to the linked finished-goods item's on-hand so the ledger stays the truth. Change the capability gate from `"stockTracking"` to `"inventory"`. Add a header comment: `// Superseded by POST /inventory/adjustments. Mirrors the legacy integer during the migration window; both this shim and products.stockQuantity/product_variants.stockQuantity are dropped once the storefront inStock reads on-hand (Spec 10 / follow-up).`

- [x] **Step 5: Run + typecheck + lint + commit.**

```bash
npx vitest run src/server/inventory/backfill.test.ts src/server/catalog && npx tsc --noEmit && npx eslint scripts src/server/catalog src/server/inventory
git add scripts/backfill-inventory.ts src/server/inventory/backfill.test.ts src/server/catalog/variants.ts
git commit -m "feat(inventory): backfill flat stock into items + opening-balance ledger; setProductStock/Variant become mirroring adjustment shims"
```

---

## Task 8: Dashboard inventory routes (items / on-hand / adjustments / transfers / counts)

The read + write surface under the existing dashboard service layer (tenant-session authed, **not** the POS bridge), gated by the three `inventory:*` permissions. Reads never expose a ledger insert an attacker could forge; writes go through the Task 4 service so the ledger stays the only writer. **Read `node_modules/next/dist/docs/` before writing any route** (per `AGENTS.md`).

**Files:**
- Create: `src/server/inventory/read.ts`, `read.test.ts`
- Create: `src/app/dashboard/inventory-permission.ts`
- Create: `src/app/api/inventory/{items,on-hand,adjustments,transfers,counts}/route.ts`, `counts/[id]/commit/route.ts`
- Create: `src/app/dashboard/inventory/page.tsx`

**Interfaces:**
- Consumes: `requireDashboardUser` + `DashboardContext` (`@/server/auth/dashboard-context`), `authorize` + `UnauthorizedError` (`@/server/rbac/authorize`), `withTenant`, the Task 2 tables, the Task 4 service, `toBase`/`assertSameDimension` (Task 3) for create-item validation.
- Produces:
  - `type ItemFilters = { kind?; isActive?; limit? }`; `listItems`, `getOnHand(tenantId, { itemId?, locationId? })` (with lot breakdown), `listLots`, `listCounts`.
  - `requireInventoryPermission(perm: "inventory:view" | "inventory:manage" | "inventory:count"): Promise<DashboardContext>`.

- [x] **Step 1: Write the failing read + guard tests.** Create `src/server/inventory/read.test.ts` — seed items/lots via the Task 4 service, then assert `listItems` filters + orders, `getOnHand` returns `Σ qty` with a per-lot breakdown, RLS hides another tenant, and a `staff` role fails `authorize(roleKeys, "inventory:manage")` with `UnauthorizedError` (the assertion the route maps to 403) while passing `inventory:view`/`inventory:count`.

- [x] **Step 2: Run to verify they fail.** `npx vitest run src/server/inventory/read.test.ts` → FAIL (module not found).

- [x] **Step 3: Implement the reads + guard.** Create `src/server/inventory/read.ts` (query through `withTenant`, cap `limit`, newest-first) and `src/app/dashboard/inventory-permission.ts` (mirror `src/app/dashboard/orders-permission.ts`):

```ts
export async function requireInventoryPermission(perm: "inventory:view" | "inventory:manage" | "inventory:count"): Promise<DashboardContext> {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, perm);
  return ctx;
}
```

- [x] **Step 4: Implement the routes.** Each route resolves the tenant from the web session via `requireInventoryPermission(...)`, maps `UnauthorizedError → 403` (re-throw otherwise, so `requireDashboardUser`'s redirect stands), and calls the service inside `withTenant`. Follow the `NextRequest`/`NextResponse` shape of `src/app/api/audit/events/route.ts`:
  - `items/route.ts` — `GET` (`inventory:view`) `listItems`; `POST` (`inventory:manage`) create an item, running `assertSameDimension` on every `<kind>Uom` vs `baseUom` (reject `g↔ml` with 422 `DimensionalUomError`).
  - `on-hand/route.ts` — `GET` (`inventory:view`) `getOnHand({ itemId, locationId })` with lot breakdown.
  - `adjustments/route.ts` — `POST` (`inventory:manage`) reason-coded `adjustStock` (`adjustment`/`waste`), inside `withTenant`.
  - `transfers/route.ts` — `POST` (`inventory:manage`) atomic `transferStock`.
  - `counts/route.ts` — `POST` (`inventory:count`) open a count (snapshot `systemQty` per line); `counts/[id]/commit/route.ts` — `POST` (`inventory:count`) `commitCount` in one transaction writing all variance rows.

- [x] **Step 5: Build the minimal view.** Create `src/app/dashboard/inventory/page.tsx` — a server component calling `requireInventoryPermission("inventory:view")`, then `listItems` + `getOnHand`. Render an items table (name, kind, base UoM, on-hand across locations) with a per-item lot breakdown, styled after an existing dashboard list page (e.g. `src/app/dashboard/orders`). Management actions (create item, adjust, count) are wired to the routes above; nav label uses the vertical's `catalogNoun` sibling ("Inventory").

- [x] **Step 6: Run + typecheck + lint.** `npx vitest run src/server/inventory/read.test.ts && npx tsc --noEmit && npx eslint src/server/inventory src/app/api/inventory src/app/dashboard/inventory`. Expected PASS, clean.

- [x] **Step 7: Commit.**

```bash
git add src/server/inventory/read.ts src/server/inventory/read.test.ts src/app/dashboard/inventory-permission.ts src/app/api/inventory src/app/dashboard/inventory
git commit -m "feat(inventory): inventory:*-gated dashboard routes (items/on-hand/adjustments/transfers/counts) + minimal view"
```

---

## Task 9: Full-suite verification and manual acceptance

**Files:** none — this task changes nothing. It proves the spec.

- [x] **Step 1: Run everything.** `npm test && npx tsc --noEmit && npx eslint src`. **Done 2026-08-04:** 132 files / 755 tests pass, `tsc` clean, `eslint` reports 0 errors and 3 warnings that all pre-date this branch (`whatsapp/graph.ts:57`, `components/admin/Pagination.tsx:2`, and one unused binding in an untouched `place-order.test.ts` case). `npx next build` also succeeds with all six `/api/inventory/*` routes and `/dashboard/inventory` registered.

- [ ] **Step 2: Walk the spec's acceptance path.** On a paired POS device with `npm run dev` + `npm run pos:dev`.

  **Status: every behaviour below is covered by an automated test; only the through-the-POS-UI and over-HTTP confirmations are outstanding**, because they need a paired device and a running server. The list is kept unticked deliberately — an automated equivalent is strong evidence, not the same thing as ringing it on a till.

  - [x] **Restaurant recipe deduction** — `ordering/place-order.test.ts` ("selling a dish deducts its recipe ingredients from the branch kitchen") plus `inventory/service.test.ts` for FIFO oldest-lot-first and yield/waste scaling.
  - [x] **Kitchen never blocked** — `place-order.test.ts` ("a kitchen is never blocked at the till"): the sale completes, a `lotId=NULL` row is written, on-hand goes to −300.
  - [x] **Retail blocks** — `place-order.test.ts` ("deducts through the ledger and rejects when insufficient"): `OutOfStockError`, and on-hand is unchanged because the order rolled back.
  - [x] **Concurrency** — `service.test.ts` ("two concurrent sales of a lot's last unit") and `place-order.test.ts`, both driving two genuinely parallel transactions: exactly one succeeds, on-hand lands on 0.
  - [x] **Restock** — `place-order.test.ts` ("restocks on customer cancel by reversing the ledger to the same lot") asserts the `refund_restock` row carries the original `lotId`.
  - [x] **Append-only** — `service.test.ts` asserts the trigger raises on both `UPDATE` and `DELETE`; also verified directly against the DB during Task 2, including that `TRUNCATE` still works so the test harness reset is intact.
  - [x] **Migration continuity** — `inventory/backfill.test.ts`: on-hand equals the old integer, the run is idempotent, and a post-backfill sale deducts identically then blocks past zero.
  - [ ] **Authorization** — the RBAC boundary is asserted in `read.test.ts` (staff pass `inventory:view`/`inventory:count`, fail `inventory:manage` with `UnauthorizedError`, which is what each route maps to 403). **Still to confirm over HTTP:** an actual `403` body from `POST /api/inventory/adjustments` as staff, and a `400` from an item create with a cross-dimension UoM. (This repo has no route-level tests by convention — 3 component tests in `src/app`, none for routes — so the boundary is covered at the service layer, as everywhere else.)

### Follow-up pass — 2026-08-05

A review of this branch against the spec found five gaps; all are now closed.

- [x] **Expired lots were being SOLD FIRST.** `deductFifo` ordered perishables by `expiry_at ASC` but never excluded expired lots, so the most-expired lot went out first — exactly inverted. Expired lots are now excluded (spec error-handling: "an expired lot is excluded from FIFO and surfaced for waste"). Their quantity stays on hand, so on-hand can exceed what is sellable, which is the honest state.
- [x] **The depleted/expired-lot restock fallback** resolves without a second lot, and the branch first written for it was deleted rather than left as dead code: a lot can never be *missing* (`stock_ledger.lot_id` is `ON DELETE RESTRICT`), and an *expired* one is now excluded from FIFO, so restoring to it returns the stock to its own cost layer while keeping it off sale. That is the review outcome the spec wanted.
- [x] **`emission-inventory.test.ts`** added, matching the six existing per-domain emission suites — asserts `inventory.adjust` / `.waste` / `.transfer` / `.count.commit` / `.recipe.*` / `.product_link.*` land with the right entity and metadata, that the hash chain still verifies, and that a sale's deduction emits **no** inventory event (`order.placed` covers it).
- [x] **`PATCH /api/inventory/items/[id]`** and **`POST /api/inventory/counts/[id]/lines`** — the two endpoints the spec listed that were missing. `baseUom` is deliberately not editable (every ledger row is stored normalized to it). Count lines snapshot `systemQty` per line and re-counting an item replaces its line, so a correction is not applied twice.
- [x] **Recipe authoring surface** — `recipes.ts` plus `/api/inventory/recipes`, `/recipes/[id]` and `/product-links`. This was the substantive gap: the deduction engine worked but a BOM could only be created by direct DB writes. The spec never specified these endpoints, so this extends it. Component units are validated against the item's base dimension at authoring time rather than at the till.

- [ ] **Step 3: Open the PR.**

```bash
git push -u origin HEAD
gh pr create --title "feat(inventory): per-branch unit-aware stock ledger + recipe/finished-goods deduction (Spec 8 Part A/B)" --body "$(cat <<'EOF'
Implements docs/ailab/specs/2026-07-24-inventory-recipes-and-purchasing-design.md — Part A (Inventory Core) + Part B (Recipes & BOM), decisions D4 + D9. Suppliers/Purchasing (Part C/D, Spec 9) is a separate plan.

- Replaces the flat integer counter with an append-only stock_ledger (8 movement
  types, signed base-UoM qty); inventory_lots.qtyRemaining is a FIFO/expiry cache;
  on-hand = Σ ledger.qty. Per-branch storage_locations; unit-aware inventory_items.
- placeOrder deducts a recipe's components (scaled by soldQty/yield, wastePct)
  FIFO from the branch kitchen, or a finished good 1:1 from the branch retail shelf.
  The per-lot guarded UPDATE preserves the existing stock-race serialization.
- inventory + recipes vertical capabilities (stockTracking kept as a legacy alias);
  inventory:view/manage/count permissions; per-tenant allowNegativeStock — kitchens
  oversell and never block the till, retail throws OutOfStockError as today.
- Cancels/refunds reverse the exact lots via refund_restock rows. A backfill seeds
  legacy stockQuantity into items + opening-balance ledger with retail continuity.
- Dashboard routes (items/on-hand/adjustments/transfers/counts) behind inventory:*.

An oversell raises a real low_stock notification via Spec 5. Send-to-supplier and
the scheduled reorder sweep stay with Spec 9; the ledger this PR emits is what
Spec 9 (receiving) and Spec 10 (reporting) read.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage (Part A + Part B):**
- *Capabilities / permissions / policy* — `inventory` + `recipes` (with `stockTracking` legacy alias), `inventory:view/manage/count`, `allowNegativeStock` per-tenant with vertical default → **Task 1**.
- *Data model* — `inventory_items` (base + stock/purchase/recipe factors), `storage_locations` (per branchId), `inventory_lots` (qtyRemaining cache, lotCode, expiry, unitCost, FIFO index), `stock_ledger` (append-only, 8 types, signed base-UoM qty), `stock_counts` + `stock_count_lines`, `product_inventory_links` (XOR recipe|finished_good), `recipes` + `recipe_components` (yield/wastePct) — FORCE RLS + append-only trigger + XOR CHECK + partial indexes → **Task 2**.
- *UoM* — dimensional conversion (mass/volume/count only; `g↔ml` rejected), the `INVENTORY_UOMS` subset guard rejecting P4's `m`/`m2`/`bf` from the shared enum, `qty(n)` scale-3 formatter, waste/yield scaling, one implementation → **Task 3**.
- *Inventory service* — on-hand as `Σ ledger.qty`, receive/adjust/transfer/count movements, FIFO lot selection with the per-lot guarded UPDATE → **Task 4**.
- *Rewire `placeOrder`* — link resolver → recipe (kitchen, scaled) or finished-goods (retail, 1:1) FIFO deduction, atomic in the order tx, `allowNegativeStock` (restaurant never blocked / retail `OutOfStockError`), concurrency + negative-policy + untracked-passthrough tests → **Task 5**.
- *Restock on cancel/refund* — `reverseOrderDeductions` writing `refund_restock` rows to the original lot, depleted-lot review fallback → **Task 6**.
- *Migration* — backfill seeds items + finished-goods links + opening-balance ledger (on-hand == old integer), idempotent, retail continuity; `setProductStock/Variant` become mirroring adjustment shims; column drop + storefront-`inStock` rewire explicitly deferred → **Task 7**.
- *API / authorization* — `inventory:*`-gated dashboard routes (items/on-hand/adjustments/transfers/counts) + minimal view; writes never exposed as raw ledger inserts → **Task 8**.
- *Testing* (UoM unit, ledger projection, FIFO + concurrency, `allowNegativeStock`, restock, migration, RLS/authorization) — every task, plus manual acceptance in **Task 9**.

**Type consistency:** `qty(n)`/`toBase`/`Uom` (Task 3) are the single quantity vocabulary used by the service (Task 4), the rewire (Task 5), and route validation (Task 8). `deductForOrderLine`/`reverseOrderDeductions` (Task 4) are consumed unchanged by `placeOrder`/`restockOrderItems` (Tasks 5, 6). `getOrCreateDefaultLocation` (Task 4) is shared by the deduction path (Task 5) and the backfill (Task 7), so a branch always resolves to the same default location. `OutOfStockError` (existing `ordering/errors`) is reused, not re-declared, so retail's failure surface is byte-identical to today.

**Deliberate scope boundaries (Part C/D deferred to Spec 9, one modelling compromise flagged):**
- `inventory_lots.supplierId` and `poReceiptLineId` are plain nullable `uuid` columns with **no FK** — `suppliers` / `po_receipt_lines` are Spec 9 tables; Spec 9 adds the constraints. Receiving (which would write `receive` ledger rows against a PO) is **not** built here; `receiveStock` exists and is exercised only by tests, the backfill, and adjustments in this plan.
- The oversell alert is a **real `notify()` call** on the order's tx, not a stub — Spec 5 merged after this plan was written and pre-provisioned the `low_stock` type. What stays deferred to Spec 9 is Part C/D: send-to-supplier, `reorder_rules`, the scheduled low-stock sweep, and its debounce table (see the debounce note in Task 4).
- The `production` ledger type is reserved (batch prep, later); `transfer` is fully implemented (two balanced rows) because the count/adjustment surface needs it.
- **Flagged compromise:** the flat global integer had no per-branch dimension, so the backfill lands legacy on-hand on each branch's *default* location; true per-branch reconciliation happens via a post-go-live stock count. The opening-balance `adjustment` ledger row keeps this auditable. This is called out in Task 7 rather than hidden.
- Storefront `inStock` (`catalog/service.ts:357`) still reads the mirrored legacy integer; rewiring it to on-hand and dropping `products.stockQuantity`/`product_variants.stockQuantity` is deferred to a follow-up (spec Migration §5), so this PR keeps retail's storefront continuity with zero visible change.
