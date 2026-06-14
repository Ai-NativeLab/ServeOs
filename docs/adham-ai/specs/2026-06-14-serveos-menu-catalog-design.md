# ServeOS — Menu & Catalog — Design Spec

**Date:** 2026-06-14
**Status:** Approved (design), pending implementation plan
**Sub-project:** #2 of the ServeOS platform program

---

## 0. Context

ServeOS is a multi-tenant SaaS platform for restaurants, cafés, bakeries, and food
businesses in **Egypt and Saudi Arabia**. This document specifies **sub-project #2:
Menu & Catalog**, which builds directly on top of the completed Tenant & Subscription
Core foundation (sub-project #1).

The foundation provides: multi-tenancy via shared Postgres + FORCE RLS +
`withTenant()`, entitlements gate (`checkQuota` / `hasFeature` / `checkUsage`),
three-surface routing (`{slug}.serveos.com` storefront / `app.serveos.com` dashboard
/ `admin.serveos.com`), self-hosted auth + RBAC, and a per-tenant installable PWA
storefront shell.

This sub-project is the first real consumer of the `withTenant` / FORCE RLS pattern
on genuinely per-tenant operational data tables.

---

## 1. Locked Decisions

| Area | Decision |
|------|----------|
| **Variants / add-ons** | Unified modifier groups model (min/max selection rules, options with price deltas) |
| **Branches** | Shared catalog + per-branch availability + optional per-branch price override |
| **Inventory** | Boolean `is_available` per branch; tenant-wide `is_published` on product |
| **Images** | Supabase Storage with per-tenant path prefixes; URLs stored in columns |
| **Scope** | Dashboard CRUD + public read API + minimal read-only storefront display page (no cart/ordering) |
| **Architecture** | Three focused domain modules (`branches`, `catalog`, `banners`) + on-demand read assembly via `getPublishedMenu` |

---

## 2. Architecture

Three domain modules under `src/server/`, each self-contained (schema + service +
types). All tables are per-tenant operational data: FORCE RLS +
`tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid` policy +
all reads/writes inside `withTenant()`.

**Module responsibilities:**

- **`branches`** — branch CRUD, quota enforcement (`branches` limit)
- **`catalog`** — categories, products, modifier groups/options, branch availability; quota enforcement (`products` limit); `getPublishedMenu` read assembly
- **`banners`** — promotional banner CRUD + active-banner read for storefront

The storefront read path never assembles menu from multiple sources — `getPublishedMenu(tenantId, branchId?)` is the single function every consumer calls.

`src/db/schema.ts` gains three new re-exports:

```typescript
export * from "../server/branches/schema";
export * from "../server/catalog/schema";
export * from "../server/banners/schema";
```

---

## 3. Data Model

All tables carry `tenant_id` directly (not derived through joins) — required for RLS
policy evaluation.

### 3.1 `branches` domain

```
branches
  id           uuid PK DEFAULT gen_random_uuid()
  tenant_id    uuid NOT NULL FK → tenants
  name         text NOT NULL
  address      text
  phone        text
  is_active    boolean NOT NULL DEFAULT true
  sort_order   integer NOT NULL DEFAULT 0
  created_at   timestamptz NOT NULL DEFAULT now()
```

RLS: FORCE RLS, policy on `tenant_id`.

### 3.2 `catalog` domain

```
categories
  id              uuid PK
  tenant_id       uuid NOT NULL FK → tenants
  name_en         text NOT NULL
  name_ar         text NOT NULL
  description_en  text
  description_ar  text
  image_url       text
  sort_order      integer NOT NULL DEFAULT 0
  is_active       boolean NOT NULL DEFAULT true
  created_at      timestamptz NOT NULL DEFAULT now()

products
  id              uuid PK
  tenant_id       uuid NOT NULL FK → tenants
  category_id     uuid NOT NULL FK → categories
  name_en         text NOT NULL
  name_ar         text NOT NULL
  description_en  text
  description_ar  text
  base_price      numeric(10,2) NOT NULL
  image_url       text
  is_published    boolean NOT NULL DEFAULT false
  sort_order      integer NOT NULL DEFAULT 0
  created_at      timestamptz NOT NULL DEFAULT now()

modifier_groups
  id              uuid PK
  tenant_id       uuid NOT NULL FK → tenants   -- denormalized for RLS
  product_id      uuid NOT NULL FK → products
  name_en         text NOT NULL
  name_ar         text NOT NULL
  required        boolean NOT NULL DEFAULT false
  min_selections  integer NOT NULL DEFAULT 0
  max_selections  integer NOT NULL DEFAULT 1
  sort_order      integer NOT NULL DEFAULT 0

modifier_options
  id                uuid PK
  tenant_id         uuid NOT NULL FK → tenants  -- denormalized for RLS
  modifier_group_id uuid NOT NULL FK → modifier_groups
  name_en           text NOT NULL
  name_ar           text NOT NULL
  price_delta       numeric(10,2) NOT NULL DEFAULT 0
  is_default        boolean NOT NULL DEFAULT false
  sort_order        integer NOT NULL DEFAULT 0

branch_product_availability                      -- sparse: absence = available
  id             uuid PK
  tenant_id      uuid NOT NULL FK → tenants     -- denormalized for RLS
  branch_id      uuid NOT NULL FK → branches
  product_id     uuid NOT NULL FK → products
  is_available   boolean NOT NULL DEFAULT true
  price_override numeric(10,2)
  UNIQUE (branch_id, product_id)
```

RLS: FORCE RLS on all five tables, same policy pattern.

**Sparsity rule for `branch_product_availability`:** a row is only inserted when
availability is being overridden (unavailable, or price override set). When
`setBranchAvailability` is called with `available=true` and no `priceOverride`, any
existing row for that `(branch_id, product_id)` pair is deleted, restoring the
default-available state.

### 3.3 `banners` domain

```
banners
  id          uuid PK
  tenant_id   uuid NOT NULL FK → tenants
  title_en    text
  title_ar    text
  image_url   text NOT NULL
  link_url    text
  is_active   boolean NOT NULL DEFAULT true
  sort_order  integer NOT NULL DEFAULT 0
  starts_at   timestamptz
  ends_at     timestamptz
  created_at  timestamptz NOT NULL DEFAULT now()
```

RLS: FORCE RLS, policy on `tenant_id`.

---

## 4. Service Layer

### 4.1 `src/server/branches/service.ts`

```typescript
listBranches(tenantId: string): Promise<Branch[]>
getBranch(tenantId: string, branchId: string): Promise<Branch>          // throws BranchNotFoundError
createBranch(tenantId: string, input: CreateBranchInput): Promise<Branch>
  // → checkQuota(tenantId, 'branches', currentCount) before insert
updateBranch(tenantId: string, branchId: string, input: UpdateBranchInput): Promise<Branch>
deleteBranch(tenantId: string, branchId: string): Promise<void>         // soft-delete: is_active = false
```

### 4.2 `src/server/catalog/service.ts`

**Categories:**
```typescript
listCategories(tenantId: string): Promise<Category[]>
createCategory(tenantId: string, input: CreateCategoryInput): Promise<Category>
updateCategory(tenantId: string, categoryId: string, input: UpdateCategoryInput): Promise<Category>
deleteCategory(tenantId: string, categoryId: string): Promise<void>
  // → throws CategoryNotEmptyError if products exist under this category
```

**Products:**
```typescript
listProducts(tenantId: string, categoryId?: string): Promise<Product[]>
getProduct(tenantId: string, productId: string): Promise<ProductWithModifiers>
  // ProductWithModifiers = Product & { modifierGroups: Array<ModifierGroup & { options: ModifierOption[] }> }
createProduct(tenantId: string, input: CreateProductInput): Promise<Product>
  // → checkQuota(tenantId, 'products', currentCount) before insert
updateProduct(tenantId: string, productId: string, input: UpdateProductInput): Promise<Product>
deleteProduct(tenantId: string, productId: string): Promise<void>
```

**Modifier groups & options:**
```typescript
upsertModifierGroup(tenantId: string, productId: string, input: ModifierGroupInput): Promise<ModifierGroup>
  // → throws InvalidModifierRulesError if min_selections > max_selections or (required && min < 1)
deleteModifierGroup(tenantId: string, groupId: string): Promise<void>   // cascades options
upsertModifierOption(tenantId: string, groupId: string, input: ModifierOptionInput): Promise<ModifierOption>
deleteModifierOption(tenantId: string, optionId: string): Promise<void>
```

**Branch availability:**
```typescript
setBranchAvailability(
  tenantId: string,
  branchId: string,
  productId: string,
  available: boolean,
  priceOverride?: number
): Promise<void>
// Upserts branch_product_availability.
// Deletes row when available=true && priceOverride=undefined (restores sparse default).
```

**Storefront read:**
```typescript
interface PublishedMenu {
  categories: Array<{
    id: string; name_en: string; name_ar: string;
    image_url: string | null;
    products: Array<{
      id: string; name_en: string; name_ar: string;
      description_en: string | null; description_ar: string | null;
      effectivePrice: number;   // base_price overridden by price_override if set
      image_url: string | null;
      modifierGroups: Array<ModifierGroup & { options: ModifierOption[] }>;
    }>;
  }>;
}

getPublishedMenu(tenantId: string, branchId?: string): Promise<PublishedMenu>
// Joins categories (is_active=true) → products (is_published=true)
// If branchId: LEFT JOIN branch_product_availability where branch_id=branchId;
//   exclude rows where is_available=false; apply price_override when set.
// Includes modifier groups + options for each product.
```

### 4.3 `src/server/banners/service.ts`

```typescript
listBanners(tenantId: string): Promise<Banner[]>          // dashboard: all banners
createBanner(tenantId: string, input: CreateBannerInput): Promise<Banner>
updateBanner(tenantId: string, bannerId: string, input: UpdateBannerInput): Promise<Banner>
deleteBanner(tenantId: string, bannerId: string): Promise<void>
getActiveBanners(tenantId: string): Promise<Banner[]>
  // is_active=true AND (starts_at IS NULL OR starts_at <= now())
  //                AND (ends_at IS NULL OR ends_at >= now())
  // ordered by sort_order
```

### 4.4 Image uploads

A server action `uploadMediaAction(tenantId, type, filename, contentType)`:

1. Generates a Supabase Storage presigned upload URL
2. Path pattern: `{tenantId}/{type}/{uuid}.{ext}` where type ∈ `category | product | banner`
3. Returns `{ uploadUrl, publicUrl }` — client uploads directly to Supabase Storage
4. Caller stores `publicUrl` in the relevant `image_url` column

No image record table. No deletion of orphaned files in v1.

---

## 5. API & Routing

### Public menu API

```
GET /api/menu?slug={tenantSlug}&branch={branchId}
```

- File: `src/app/api/menu/route.ts`
- Resolves tenant via `getTenantBySlug(slug)`
- Returns 404 if tenant not found or `status` not in `['active', 'trial']`
- Calls `getPublishedMenu(tenantId, branchId?)`
- Returns `PublishedMenu` as JSON — no auth, fully public

### Dashboard routes

Under the `(dashboard)` route group, guarded by `authorize(user, 'menu:manage')`:

```
/dashboard/branches               list + create
/dashboard/branches/[id]          edit, deactivate
/dashboard/menu                   categories + products tree view
/dashboard/menu/categories/new
/dashboard/menu/categories/[id]   edit, delete
/dashboard/menu/products/new
/dashboard/menu/products/[id]     edit, delete, modifier groups editor
/dashboard/banners                list, create, edit, delete
```

All pages are server components; mutations are server actions. `revalidatePath` after
each mutation to bust Next.js cache.

### RBAC

Add `'menu:manage'` to the static permission catalog in `src/server/rbac/permissions.ts`,
mapped to `owner` and `manager` role keys.

### Storefront display page

Extends the existing `x-surface === 'storefront'` branch in `src/app/page.tsx`:

1. Calls `getActiveBanners(tenantId)` — renders image banner strip
2. Calls `getPublishedMenu(tenantId)` — renders categories as sections, products per section
3. If tenant has multiple branches: renders a branch selector; selecting a branch
   re-calls `GET /api/menu?slug=...&branch=...` client-side and re-renders product list
4. Products are display-only: name, description, price, image. No cart, no add-to-cart button.

---

## 6. Error Handling

Typed domain errors following the foundation's `messageFor(locale: 'en' | 'ar')` pattern:

| Error | When | `messageFor` |
|-------|------|-------------|
| `CategoryNotEmptyError` | Delete category with products | en: "Remove all products first" / ar: "أزل جميع المنتجات أولاً" |
| `ProductNotFoundError` | Fetch/update/delete missing product | en: "Product not found" / ar: "المنتج غير موجود" |
| `BranchNotFoundError` | Fetch/update/delete missing branch | en: "Branch not found" / ar: "الفرع غير موجود" |
| `BannerNotFoundError` | Update/delete missing banner | en: "Banner not found" / ar: "اللافتة غير موجودة" |
| `InvalidModifierRulesError` | min > max or required + min < 1 | en: "Invalid selection rules" / ar: "قواعد الاختيار غير صالحة" |

`QuotaExceededError` is reused from the foundation (branches, products limits).

RLS fails closed: any query outside `withTenant` returns zero rows. Tenant with
non-active/trial status gets 404 from the menu API.

---

## 7. Testing

### Unit tests

- `getPublishedMenu`: filters unpublished products, excludes branch-unavailable items,
  applies `price_override`, excludes inactive categories
- `getActiveBanners`: date-range filtering (starts_at / ends_at boundary cases)
- `setBranchAvailability`: sparse upsert (row inserted on override, deleted when
  restoring default)
- Modifier rules validation: `min > max` rejects, `required=true + min=0` rejects
- Quota gate: `createBranch` and `createProduct` call `checkQuota` with correct resource keys

### Integration tests (real Supabase test DB)

- **RLS isolation:** tenant A cannot read tenant B's products, categories, or branches
  even with a direct query bypassing the service layer
- **Full CRUD:** category → product → modifier group → options → `getProduct` returns
  complete tree
- **Branch availability:** publish product, mark unavailable at branch B →
  `getPublishedMenu(tenantId, branchB)` excludes it; `getPublishedMenu(tenantId)` (no
  branch filter) still includes it
- **Price override:** set `price_override` on branch → `effectivePrice` in
  `getPublishedMenu` reflects override
- **Quota gate (integration):** plan with `products: 2`, insert 2, third throws
  `QuotaExceededError`

### E2E smoke

- Owner creates category + product in dashboard → `GET /api/menu?slug=...` returns it
  after publish
- Storefront page at `{slug}.serveos.localhost` renders product name/price after publish

---

## 8. Scope Boundaries

### In scope

- `branches` domain: CRUD, quota enforcement
- `catalog` domain: categories, products, modifier groups/options, branch availability,
  `getPublishedMenu` read assembly
- `banners` domain: CRUD + active-banner read
- Supabase Storage presigned upload flow for images
- Public menu API (`GET /api/menu`)
- Dashboard CRUD pages for all entities
- Minimal read-only storefront display (banners + menu, branch selector, no cart)
- `menu:manage` RBAC permission

### Out of scope (later sub-projects)

- Cart, checkout, online ordering → **Ordering sub-project**
- QR/table ordering → **Ordering sub-project**
- Real-time inventory (WebSocket / live updates) → future
- Customer favorites, ratings, reviews → future
- Menu scheduling (items available at certain hours) → future

---

## 9. Success Criteria

A tenant owner can create branches, categories, products with modifier groups, and
banners from the dashboard; the published menu is accessible via the public API and
displayed on the storefront PWA page; branch-level availability and price overrides
work correctly; plan quotas on branches and products are enforced; RLS isolation is
proven between tenants; all per-tenant tables follow the FORCE RLS + `withTenant`
pattern established in sub-project #1.
