# Storefront Premium Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Elevate the entire customer storefront (menu, product sheet, cart, checkout, tracking) to the approved "Premium Hybrid" visual direction, backed by small truthful data-model additions and a rich Roma demo seed.

**Architecture:** A shared design-language layer (tokens + a few presentational components) that every surface composes from, plus honest data: two new tenant fields (`tagline`, `cuisine`), one new product field (`isFeatured`), and derived "Popular" (real order counts) / "New" (createdAt) badges. Server tasks first (schema → derived-data → seed → dashboard controls), then surface-by-surface restyle. No fabricated ratings.

**Tech Stack:** Next.js 16 (App Router, Server Components), Tailwind v4 (`@theme`/`@utility` in `globals.css`), Radix `ui` primitives, `lucide-react`, Drizzle + Postgres (FORCE RLS via `withTenant`), Vitest (real test DB), Playwright.

## Global Constraints

- Read `node_modules/next/dist/docs/` before assuming any Next.js API behaves like training data (`AGENTS.md`).
- **No new runtime npm dependencies.** Motion is CSS transitions; icons come from the already-present `lucide-react`.
- **Environment:** before ANY `node`/`npm`/`npx` command run `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"` (system Node is too old). Local Postgres runs on `127.0.0.1:5433`; `.env.local`/`.env.test` exist. If a DB connection fails, restart Postgres: `~/.serveos-dev/node_modules/@embedded-postgres/darwin-arm64/native/bin/pg_ctl -D ~/.serveos-dev/pgdata -o "-p 5433 -k /tmp -c listen_addresses=127.0.0.1" -l ~/.serveos-dev/pg.log start`. Never run bare `npm install` or commit `package-lock.json`.
- **Migrations:** `npm run db:generate` (never hand-written SQL), then `npm run db:migrate:test` and `npm run db:migrate` (both point at the local DB here). Additive nullable/defaulted columns only.
- **Brand tokens (verbatim, from `src/app/globals.css`):** background `#fbf7f2`, card `#fffdfb`, primary/coral `#f0522b`, ink `#1a0f0a`, muted `#948676`, secondary `#f4ede4`, accent `#fbe3da`, border `rgba(26,15,10,.09)`, radius `0.75rem`. Fonts: `font-display` = Bricolage Grotesque, `font-sans` = Space Grotesk, `font-mono` = JetBrains Mono. The `eyebrow` utility exists (mono, uppercase, letter-spaced). Status colors `status-ready-fg` etc. exist.
- **No `animate-in`/`fade-in-0` classes** (plugin not installed). Motion = plain Tailwind `transition`/`translate`/`opacity`, all gated behind `@media (prefers-reduced-motion: no-preference)`.
- **PRESERVE these accessible names/text exactly** (the Vitest/Playwright suites assert them): product Add button starts with `Add —`; cart bar contains `View cart`; cart drawer checkout link contains `Checkout`; checkout page has a heading matching `/Checkout/` and placeholders `Name` and `Phone`; tracking shows text matching `/Scheduled for/`, the word `pending`, a button named `Cancel order`, and `/cancelled/i`.
- **Truthful data only.** No star ratings. Badges derive from real signals; hero chips show only open-state/ETA/min-order/cuisine/area that are truthfully backed.
- **Images:** raw `<img>` (no next-image), every storefront image gets `loading="lazy"` and an explicit `width`/`height` or `aspect-ratio`. Seed uses pinned remote Unsplash URLs.
- All money via `formatMoney(amount, currency)` (`src/lib/money.ts`); currency from `tenant.currency`.

## File Structure

**New files**
- `src/app/_components/storefront/SectionHeader.tsx` — eyebrow + Bricolage title + optional count (presentational).
- `src/app/_components/storefront/Badge.tsx` — Popular/New/Featured pill (presentational).
- `src/app/_components/storefront/FeaturedCard.tsx` — the large cinematic per-section featured card.
- `src/server/catalog/popular.ts` — `getPopularProductIds` (server query; imports DB/`withTenant`, server-only).
- `src/server/catalog/popular.test.ts` — Vitest for `getPopularProductIds`.
- `src/lib/product-badges.ts` — `isNewProduct` (pure, **client-safe**; no server imports — the menu is a client component).
- `src/lib/product-badges.test.ts` — Vitest for `isNewProduct`.

> **Client/server split (important):** `getPopularProductIds` pulls in `withTenant`/`orderItems` (server-only) and must NEVER be imported into a client component. `isNewProduct` is pure and lives in `src/lib/` so `StorefrontMenu` (a `"use client"` component) can import it without dragging server code into the client bundle.

**Modified files**
- `src/app/globals.css` — shared tokens/utilities.
- `src/server/tenancy/schema.ts`, `src/server/catalog/schema.ts` — new columns + `PublishedMenu` product fields.
- `src/server/catalog/service.ts` — thread `isFeatured`/`createdAt` into `getPublishedMenu`; product create/update accept `isFeatured`.
- `src/server/tenancy/service.ts` (or settings) — tenant `tagline`/`cuisine` update.
- `scripts/seed.ts` — Roma content rewrite.
- Dashboard: product editor form + brand/settings form (new-field controls).
- Storefront components: `Hero.tsx`, `CategoryNav.tsx`, `StorefrontMenu.tsx`, `ProductCard.tsx`, `ProductSheet.tsx`, `CartBar.tsx`, `CartDrawer.tsx`, `OpenStateBanner.tsx`, `RecentOrderStrip.tsx`, `StorefrontFooter.tsx`, `src/app/page.tsx`.
- Checkout: `src/app/checkout/page.tsx`, `CheckoutForm.tsx`.
- Tracking: `src/app/order/[token]/page.tsx`, `StatusPoller.tsx`.

---

### Task 1: Shared design-language layer (tokens + SectionHeader + Badge)

**Files:**
- Modify: `src/app/globals.css`
- Create: `src/app/_components/storefront/SectionHeader.tsx`
- Create: `src/app/_components/storefront/Badge.tsx`

**Interfaces:**
- Produces (CSS utilities, usable as Tailwind classes): `card-lift`, `sf-img`, `sf-chip`, `sf-chip-solid`, `sf-badge`, `sf-badge-soft`; theme tokens `--shadow-card`, `--shadow-card-hover` (exposed as `shadow-card`/`shadow-card-hover`).
- Produces: `SectionHeader({ eyebrow, title, count }: { eyebrow?: string; title: string; count?: number })`.
- Produces: `Badge({ kind }: { kind: "popular" | "new" | "featured" })` → styled pill with the label ("Popular" | "New" | "Featured").
- Consumed by Tasks 6–12.

- [ ] **Step 1: Add tokens + utilities to `globals.css`**

In the `@theme inline { … }` block, after the existing `--radius-*` lines, add:

```css
  --shadow-card: 0 4px 16px -10px rgba(26, 15, 10, 0.28);
  --shadow-card-hover: 0 12px 30px -14px rgba(26, 15, 10, 0.38);
```

After the existing `@utility eyebrow { … }` block, add:

```css
@utility card-lift {
  box-shadow: var(--shadow-card);
}
@media (prefers-reduced-motion: no-preference) {
  @utility card-lift {
    transition: box-shadow 0.2s ease, transform 0.2s ease;
  }
}

@utility sf-img {
  object-fit: cover;
  border-radius: var(--radius);
  box-shadow: inset 0 0 0 1px var(--border);
  background: var(--secondary);
}

@utility sf-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: rgba(255, 255, 255, 0.16);
  backdrop-filter: blur(6px);
  color: #fff;
  font-size: 12px;
  font-weight: 500;
  padding: 4px 10px;
  border-radius: 100px;
}
@utility sf-chip-solid {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--card);
  color: var(--ink);
  font-size: 12px;
  font-weight: 500;
  padding: 4px 10px;
  border-radius: 100px;
  box-shadow: inset 0 0 0 1px var(--border);
}

@utility sf-badge {
  display: inline-flex;
  align-items: center;
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-weight: 500;
  background: var(--primary);
  color: var(--primary-foreground);
  padding: 3px 8px;
  border-radius: 100px;
}
@utility sf-badge-soft {
  display: inline-flex;
  align-items: center;
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-weight: 500;
  background: var(--accent);
  color: #a2331c;
  padding: 3px 8px;
  border-radius: 100px;
}
```

- [ ] **Step 2: Create `SectionHeader.tsx`**

```tsx
export function SectionHeader({ eyebrow, title, count }: { eyebrow?: string; title: string; count?: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3 pb-1 pt-5">
      <div>
        {eyebrow && <div className="eyebrow text-muted-foreground">{eyebrow}</div>}
        <h2 className="font-display text-xl font-bold text-ink sm:text-2xl">{title}</h2>
      </div>
      {typeof count === "number" && (
        <span className="font-mono text-xs text-muted-foreground">{count} item{count === 1 ? "" : "s"}</span>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create `Badge.tsx`**

```tsx
const LABELS = { popular: "Popular", new: "New", featured: "Featured" } as const;

export function Badge({ kind }: { kind: keyof typeof LABELS }) {
  return <span className={kind === "featured" ? "sf-badge-soft" : "sf-badge"}>{LABELS[kind]}</span>;
}
```

- [ ] **Step 4: Verify build**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && npx tsc --noEmit && npm run build`
Expected: no errors; all routes compile. (Tailwind v4 picks up the new `@utility`/`@theme` entries — a clean build confirms they parse.)

- [ ] **Step 5: Commit**

```bash
git add src/app/globals.css src/app/_components/storefront/SectionHeader.tsx src/app/_components/storefront/Badge.tsx
git commit -m "feat(storefront): shared premium design-language tokens + SectionHeader/Badge"
```

---

### Task 2: Data model — tenant `tagline`/`cuisine`, product `isFeatured`

**Files:**
- Modify: `src/server/tenancy/schema.ts` (tenants table)
- Modify: `src/server/catalog/schema.ts` (products table + `PublishedMenu`)
- Modify: `src/server/catalog/service.ts` (`CreateProductInput`/`UpdateProductInput` + create/update)
- Modify: `src/server/tenancy/service.ts` (tenant update accepts tagline/cuisine)
- Modify: `src/server/catalog/catalog.test.ts` (or the nearest existing catalog test file) and `src/server/tenancy/*.test.ts`
- Create: migration via `npm run db:generate`

**Interfaces:**
- Produces: `tenants.tagline: string | null`, `tenants.cuisine: string | null`; `products.isFeatured: boolean` (default false).
- Produces: `PublishedMenu.categories[].products[]` gains `isFeatured: boolean` and `createdAt: string` (ISO) — consumed by Tasks 3/6/7.
- Produces: product create/update accept optional `isFeatured`; tenant update accepts optional `tagline`/`cuisine`.

- [ ] **Step 1: Write failing tests**

In the existing catalog service test file, add:

```ts
it("createProduct defaults isFeatured false; updateProduct can set it", async () => {
  const { t, cat } = await setupCatalog("feat1"); // reuse the file's existing setup helper
  const p = await createProduct(t.id, { nameEn: "X", nameAr: "س", basePrice: "50", categoryId: cat.id });
  expect(p.isFeatured).toBe(false);
  const updated = await updateProduct(t.id, p.id, { isFeatured: true });
  expect(updated.isFeatured).toBe(true);
});
```

In the tenancy service test file, add:

```ts
it("updateTenant persists tagline and cuisine", async () => {
  const [t] = await db.insert(tenants).values({ slug: "tl1", name: "T", country: "EG" }).returning();
  const { updateTenant } = await import("./service");
  const updated = await updateTenant(t.id, { tagline: "Wood-fired", cuisine: "Italian" });
  expect(updated.tagline).toBe("Wood-fired");
  expect(updated.cuisine).toBe("Italian");
});
```

(If `updateTenant`/`setupCatalog` have different names in the real files, mirror the existing local patterns — the assertions are the contract. Read the test file's existing helpers first.)

- [ ] **Step 2: Run to verify failure**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && npx vitest run src/server/catalog/ src/server/tenancy/`
Expected: FAIL — `isFeatured`/`tagline`/`cuisine` not present.

- [ ] **Step 3: Add columns**

In `src/server/tenancy/schema.ts` `tenants` table, after `coverImageUrl`:

```ts
  tagline: text("tagline"),
  cuisine: text("cuisine"),
```

In `src/server/catalog/schema.ts` `products` table, after `imageUrl`:

```ts
  isFeatured: boolean("is_featured").notNull().default(false),
```

- [ ] **Step 4: Extend `PublishedMenu`**

In `src/server/catalog/schema.ts`, in the `PublishedMenu` product shape, add after `imageUrl: string | null;`:

```ts
      isFeatured: boolean;
      createdAt: string;
```

- [ ] **Step 5: Generate + apply migration**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && npm run db:generate && npm run db:migrate:test && npm run db:migrate`
Expected: a new `drizzle/00XX_*.sql` with the three `ADD COLUMN`s; migrations apply cleanly.

- [ ] **Step 6: Thread through service inputs**

In `src/server/catalog/service.ts`: add `isFeatured?: boolean` to `CreateProductInput` and `UpdateProductInput`; include it in the create `.values({…})` (only if provided) and update `.set({…})`. In `src/server/tenancy/service.ts`: add `tagline?: string | null; cuisine?: string | null` to the tenant update input type and `.set({…})`. (Read each function's exact current shape and follow its pattern.)

- [ ] **Step 7: Run tests**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && npx vitest run src/server/catalog/ src/server/tenancy/`
Expected: PASS (new + existing).

- [ ] **Step 8: Commit**

```bash
git add src/server/tenancy/ src/server/catalog/ drizzle/
git commit -m "feat(catalog): tenant tagline/cuisine + product isFeatured fields"
```

---

### Task 3: Derived badges — `getPopularProductIds` + `isNewProduct`, threaded into the menu

**Files:**
- Create: `src/server/catalog/popular.ts` (server query)
- Create: `src/server/catalog/popular.test.ts`
- Create: `src/lib/product-badges.ts` (pure, client-safe)
- Create: `src/lib/product-badges.test.ts`
- Modify: `src/server/catalog/service.ts` (`getPublishedMenu` maps `isFeatured` + `createdAt`)

**Interfaces:**
- Consumes: `orderItems` schema; `withTenant`; product fields from Task 2.
- Produces: `getPopularProductIds(tenantId: string): Promise<Set<string>>` (in `src/server/catalog/popular.ts`) — top 5 product ids per tenant by summed `orderItems.quantity`, only products with ≥1 order. Consumed by Task 6. **Server-only.**
- Produces: `isNewProduct(createdAt: string | Date, now?: Date): boolean` (in `src/lib/product-badges.ts`) — true when `createdAt` is within the last 14 days. Pure/client-safe. Consumed by Task 7.
- Produces: `getPublishedMenu` products now carry `isFeatured` and `createdAt` (ISO string).

- [ ] **Step 1: Write failing tests**

Create `src/lib/product-badges.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isNewProduct } from "./product-badges";

describe("isNewProduct", () => {
  const now = new Date("2026-07-10T12:00:00Z");
  it("true within 14 days, false beyond", () => {
    expect(isNewProduct("2026-07-01T12:00:00Z", now)).toBe(true);
    expect(isNewProduct("2026-06-20T12:00:00Z", now)).toBe(false);
  });
});
```

Create `src/server/catalog/popular.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { createBranch, updateBranchOrdering } from "@/server/branches/service";
import { createCategory, createProduct, updateProduct } from "@/server/catalog/service";
import { placeOrder } from "@/server/ordering/service";
import { getPopularProductIds } from "./popular";

async function setup(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG" }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro");
  const branch = await createBranch(t.id, { name: "Main" });
  await updateBranchOrdering(t.id, branch.id, { acceptingOrders: true, openingHours: [] });
  const cat = await createCategory(t.id, { nameEn: "P", nameAr: "ب" });
  const mk = async (name: string) => {
    const p = await createProduct(t.id, { nameEn: name, nameAr: name, basePrice: "100", categoryId: cat.id });
    await updateProduct(t.id, p.id, { isPublished: true });
    return p;
  };
  return { t, branch, mk };
}

describe("getPopularProductIds", () => {
  it("ranks by ordered quantity, caps at 5, excludes zero-order products, isolates tenants", async () => {
    const { t, branch, mk } = await setup("pop1");
    const a = await mk("A"); const b = await mk("B"); const c = await mk("C");
    // A ordered qty 5, B qty 2, C never ordered
    await placeOrder(t.id, { branchId: branch.id, fulfillmentType: "pickup", customerName: "x", customerPhone: "1", lines: [{ productId: a.id, quantity: 5, selectedOptionIds: [] }] });
    await placeOrder(t.id, { branchId: branch.id, fulfillmentType: "pickup", customerName: "y", customerPhone: "2", lines: [{ productId: b.id, quantity: 2, selectedOptionIds: [] }] });
    const ids = await getPopularProductIds(t.id);
    expect(ids.has(a.id)).toBe(true);
    expect(ids.has(b.id)).toBe(true);
    expect(ids.has(c.id)).toBe(false); // zero orders
    // other tenant sees nothing
    const { t: t2 } = await setup("pop2");
    expect((await getPopularProductIds(t2.id)).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && npx vitest run src/lib/product-badges.test.ts src/server/catalog/popular.test.ts`
Expected: FAIL — cannot resolve `./product-badges` / `./popular`.

- [ ] **Step 3a: Implement `src/lib/product-badges.ts` (pure, client-safe)**

```ts
const NEW_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** True when the product was created within the last 14 days. */
export function isNewProduct(createdAt: string | Date, now: Date = new Date()): boolean {
  return now.getTime() - new Date(createdAt).getTime() < NEW_WINDOW_MS;
}
```

- [ ] **Step 3b: Implement `src/server/catalog/popular.ts` (server query)**

```ts
import { sql, desc } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { orderItems } from "@/server/ordering/schema";

const POPULAR_LIMIT = 5;

/** Top product ids by lifetime ordered quantity (only products with ≥1 order). */
export async function getPopularProductIds(tenantId: string): Promise<Set<string>> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({ productId: orderItems.productId, qty: sql<number>`sum(${orderItems.quantity})::int` })
      .from(orderItems)
      .groupBy(orderItems.productId)
      .orderBy(desc(sql`sum(${orderItems.quantity})`))
      .limit(POPULAR_LIMIT);
    return new Set(rows.map((r) => r.productId));
  });
}
```

(`orderItems` is tenant-scoped via RLS inside `withTenant`, so the grouping is per-tenant automatically. Confirm `withTenant`'s import path is `@/db/with-tenant` — match how `src/server/ordering/service.ts` imports it.)

- [ ] **Step 4: Map new fields in `getPublishedMenu`**

In `src/server/catalog/service.ts`, wherever `getPublishedMenu` assembles each product object for the returned `PublishedMenu`, add `isFeatured: p.isFeatured` and `createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : String(p.createdAt)`. Ensure the `branchId` branch's `prodRows.map(...)` also carries `isFeatured` and `createdAt` from the row (add them to the select projection and the mapped object — the projection already selects `createdAt`; add `isFeatured: products.isFeatured`).

- [ ] **Step 5: Run tests**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && npx vitest run src/lib/product-badges.test.ts src/server/catalog/ && npx tsc --noEmit`
Expected: PASS; types clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/product-badges.ts src/lib/product-badges.test.ts src/server/catalog/popular.ts src/server/catalog/popular.test.ts src/server/catalog/service.ts
git commit -m "feat(catalog): popular (order-count) + new (createdAt) product signals"
```

---

### Task 4: Roma demo seed rewrite

**Files:**
- Modify: `scripts/seed.ts`

**Interfaces:**
- Consumes: existing seed helpers (`createCategory`, `createProduct`, `updateProduct`, `upsertModifierGroup`, `upsertModifierOption`, `createBranch`, `updateBranchOrdering`, `createDeliveryArea`, banner + order helpers) and the Task 2 fields.
- Produces: a Roma tenant with tagline/cuisine/cover/logo, ~6 imaged categories, ~30 published imaged products (some `isFeatured`, a spread of `createdAt`), modifiers, 2–3 banners, and enough seeded orders that a few products are "Popular". Idempotent (safe to re-run).

- [ ] **Step 1: Add pinned image constants + content data**

At the top of the Roma seed section in `scripts/seed.ts`, define stable image URLs and content. Use this exact helper for consistent sizing:

```ts
const IMG = (id: string) => `https://images.unsplash.com/photo-${id}?w=800&q=80&auto=format&fit=crop`;
```

Category + product content (pinned Unsplash photo IDs — all real, food-appropriate):

```ts
const ROMA_MENU: Array<{
  cat: { nameEn: string; nameAr: string; img: string };
  products: Array<{ nameEn: string; nameAr: string; descEn: string; price: string; img: string; featured?: boolean; ageDays?: number }>;
}> = [
  { cat: { nameEn: "Pizza", nameAr: "بيتزا", img: "1513104890138-7c749659a591" }, products: [
    { nameEn: "Margherita", nameAr: "مارجريتا", descEn: "San Marzano tomato, fior di latte, fresh basil, cold-pressed olive oil.", price: "145", img: "1513104890138-7c749659a591", featured: true },
    { nameEn: "Diavola", nameAr: "ديافولا", descEn: "Spicy salami, mozzarella, chili honey drizzle.", price: "175", img: "1628840042765-356cda07504e", ageDays: 3 },
    { nameEn: "Quattro Formaggi", nameAr: "أربعة أجبان", descEn: "Mozzarella, gorgonzola, parmesan, taleggio.", price: "190", img: "1601924582970-9238bcb495d9" },
    { nameEn: "Marinara", nameAr: "مارينارا", descEn: "Tomato, garlic, oregano, extra virgin olive oil.", price: "120", img: "1571407970349-bc81e7e96d47" },
    { nameEn: "Prosciutto e Rucola", nameAr: "بروشوتو وجرجير", descEn: "Parma ham, rocket, shaved parmesan, cherry tomatoes.", price: "210", img: "1595854341625-f33ee10dbf94" },
  ]},
  { cat: { nameEn: "Pasta", nameAr: "باستا", img: "1621996346565-e3dbc646d9a9" }, products: [
    { nameEn: "Spaghetti Carbonara", nameAr: "سباجيتي كاربونارا", descEn: "Guanciale, egg yolk, pecorino romano, black pepper.", price: "165", img: "1612874742237-6526221588e3", featured: true },
    { nameEn: "Penne Arrabbiata", nameAr: "بيني أرابياتا", descEn: "Tomato, garlic, chili, parsley.", price: "135", img: "1563379926898-05f4575a45d8" },
    { nameEn: "Fettuccine Alfredo", nameAr: "فيتوتشيني ألفريدو", descEn: "Butter, cream, parmesan, nutmeg.", price: "155", img: "1645112411341-6c4fd023714a", ageDays: 5 },
    { nameEn: "Lasagna Bolognese", nameAr: "لازانيا بولونيز", descEn: "Slow-cooked beef ragù, béchamel, parmesan.", price: "185", img: "1619895092538-128341789043" },
    { nameEn: "Pesto Genovese", nameAr: "بيستو جينوفيز", descEn: "Basil pesto, pine nuts, green beans, potato.", price: "150", img: "1473093295043-cdd812d0e601" },
  ]},
  { cat: { nameEn: "Salads", nameAr: "سلطات", img: "1512621776951-a57141f2eefd" }, products: [
    { nameEn: "Caprese", nameAr: "كابريزي", descEn: "Buffalo mozzarella, heirloom tomato, basil, balsamic.", price: "110", img: "1608897013039-887f21d8c804", featured: true },
    { nameEn: "Caesar", nameAr: "سيزر", descEn: "Romaine, parmesan, croutons, anchovy dressing.", price: "95", img: "1550304943-4f24f54ddde9" },
    { nameEn: "Rucola & Parmesan", nameAr: "جرجير وبارميزان", descEn: "Rocket, shaved parmesan, lemon, olive oil.", price: "90", img: "1540420773420-3366772f4999" },
  ]},
  { cat: { nameEn: "Starters", nameAr: "مقبلات", img: "1541529086526-db283c563270" }, products: [
    { nameEn: "Bruschetta", nameAr: "بروشيتا", descEn: "Grilled sourdough, tomato, garlic, basil.", price: "75", img: "1572695157366-5e585ab2b69f", featured: true },
    { nameEn: "Arancini", nameAr: "أرانشيني", descEn: "Fried risotto balls, mozzarella, marinara.", price: "95", img: "1580217593608-61931cefc821", ageDays: 2 },
    { nameEn: "Garlic Bread", nameAr: "خبز بالثوم", descEn: "Wood-fired, garlic butter, parsley.", price: "55", img: "1573140247632-f8fd74997d5c" },
    { nameEn: "Antipasto Misto", nameAr: "أنتيباستو", descEn: "Cured meats, cheeses, olives, grilled vegetables.", price: "160", img: "1544025162-d76694265947" },
  ]},
  { cat: { nameEn: "Dolci", nameAr: "حلويات", img: "1551024601-bec78aea704b" }, products: [
    { nameEn: "Tiramisù", nameAr: "تيراميسو", descEn: "Espresso-soaked savoiardi, mascarpone, cocoa.", price: "85", img: "1571877227200-a0d98ea607e9", featured: true },
    { nameEn: "Panna Cotta", nameAr: "بانا كوتا", descEn: "Vanilla cream, berry coulis.", price: "75", img: "1488477181946-6428a0291777" },
    { nameEn: "Cannoli", nameAr: "كانولي", descEn: "Crisp shells, sweet ricotta, pistachio.", price: "80", img: "1607920591413-4ec007e70023", ageDays: 6 },
  ]},
  { cat: { nameEn: "Drinks", nameAr: "مشروبات", img: "1437418747212-8d9709afab22" }, products: [
    { nameEn: "San Pellegrino", nameAr: "سان بيليجرينو", descEn: "Sparkling mineral water, 500ml.", price: "45", img: "1523371054106-bbf80586c33c" },
    { nameEn: "Fresh Lemonade", nameAr: "ليموناضة", descEn: "Lemon, mint, lightly sweetened.", price: "50", img: "1621263764928-df1444c5e859" },
    { nameEn: "Italian Soda", nameAr: "صودا إيطالية", descEn: "Sparkling water, fruit syrup.", price: "55", img: "1437418747212-8d9709afab22" },
    { nameEn: "Espresso", nameAr: "إسبريسو", descEn: "Double shot, Italian roast.", price: "40", img: "1510591509098-f4fdc6d0ff04" },
  ]},
];
```

- [ ] **Step 2: Set tenant fields + cover/logo in the seed**

Where the Roma tenant is upserted/updated in `scripts/seed.ts`, set (via the tenant update helper or a direct `db.update(tenants)`):

```ts
tagline: "Wood-fired Italian, made fresh",
cuisine: "Italian",
coverImageUrl: IMG("1517248135467-4c7edcad34c4"),
logoUrl: IMG("1552566626-52f8b828add9"),
```

- [ ] **Step 3: Replace the Roma catalog seed loop**

Replace the existing bare product creation with a loop over `ROMA_MENU` that creates each category (with `imageUrl`), then its products (published, with `descriptionEn`, `imageUrl`, `isFeatured`, and a back-dated `createdAt` when `ageDays` is set), and a size modifier group for Pizza/Pasta/Drinks. Make it idempotent by skipping when the category already exists:

```ts
{
  const { listCategories, createCategory, listProducts, createProduct, updateProduct,
          upsertModifierGroup, upsertModifierOption } = await import("../src/server/catalog/service");
  const { db } = await import("../src/db/client");
  const { products: productsTable } = await import("../src/server/catalog/schema");
  const { eq } = await import("drizzle-orm");

  const existing = await listCategories(romaTenant.id);
  if (existing.length === 0) {
    for (const entry of ROMA_MENU) {
      const cat = await createCategory(romaTenant.id, {
        nameEn: entry.cat.nameEn, nameAr: entry.cat.nameAr, imageUrl: IMG(entry.cat.img),
      });
      for (const pr of entry.products) {
        const p = await createProduct(romaTenant.id, {
          nameEn: pr.nameEn, nameAr: pr.nameAr, descriptionEn: pr.descEn, descriptionAr: pr.descEn,
          basePrice: pr.price, categoryId: cat.id, imageUrl: IMG(pr.img),
        });
        await updateProduct(romaTenant.id, p.id, { isPublished: true, isFeatured: !!pr.featured });
        if (pr.ageDays) {
          await db.update(productsTable)
            .set({ createdAt: new Date(Date.now() - pr.ageDays * 24 * 60 * 60 * 1000) })
            .where(eq(productsTable.id, p.id));
        }
        if (["Pizza", "Pasta", "Drinks"].includes(entry.cat.nameEn)) {
          const g = await upsertModifierGroup(romaTenant.id, p.id, { nameEn: "Size", nameAr: "الحجم", required: true, minSelections: 1, maxSelections: 1 });
          await upsertModifierOption(romaTenant.id, g.id, { nameEn: "Regular", nameAr: "عادي", priceDelta: "0" });
          await upsertModifierOption(romaTenant.id, g.id, { nameEn: "Large", nameAr: "كبير", priceDelta: "35" });
        }
      }
    }
  }
}
```

(Verify the helper input field names against `service.ts` — e.g. `createCategory`/`createProduct` argument keys — and adjust if the real signatures differ. `createProduct` may not accept `imageUrl`/`descriptionEn` directly; if not, set them via `updateProduct`.)

- [ ] **Step 4: Seed "Popular" signal orders**

After the catalog loop, place a few pickup orders so 3–4 products accumulate quantity (reuse the file's existing order-seeding helper/pattern; if none, call `placeOrder`). Order the two featured pizzas + carbonara several times each so `getPopularProductIds` has clear winners. Keep it idempotent (guard on an existing-order count).

- [ ] **Step 5: Run the seed + verify content**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && npm run db:seed`
Expected: completes; prints the Roma storefront URL.

Verify counts:
```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
node -e "const{Client}=require('pg');(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL||'postgresql://serveos_app:serveos@127.0.0.1:5433/serveos'});await c.connect();for(const q of ['select count(*) from categories','select count(*) from products where is_published','select count(*) from products where is_featured']){console.log(q,(await c.query(q)).rows[0].count)}await c.end()})()"
```
Expected: ~6 categories, ~30 published products, ~6 featured.

- [ ] **Step 6: Commit**

```bash
git add scripts/seed.ts
git commit -m "feat(seed): rich Roma demo menu with imagery, featured items, popular signal"
```

---

### Task 5: Dashboard controls for the new fields

**Files:**
- Modify: the product editor form (find it: `grep -rl "isPublished" src/app/dashboard`) — add an `isFeatured` toggle.
- Modify: the tenant brand/settings form (find it: `grep -rl "coverImageUrl\|logoUrl" src/app/dashboard`) — add `tagline` + `cuisine` inputs.
- Modify: the corresponding server actions to pass the new fields through.

**Interfaces:**
- Consumes: Task 2 service inputs (`isFeatured` on product update; `tagline`/`cuisine` on tenant update).
- Produces: dashboard UI + actions that persist the three fields. Keeps existing tests green.

- [ ] **Step 1: Add the product `isFeatured` toggle**

In the product editor form component, add a labelled checkbox/switch bound to `isFeatured` alongside the existing `isPublished` control, and include `isFeatured` in the form's submitted payload. In the product update server action, read and pass `isFeatured` to `updateProduct`. Match the file's existing control pattern (Radix `Switch`/`Checkbox` or native input as used).

- [ ] **Step 2: Add tenant `tagline` + `cuisine` inputs**

In the brand/settings form, add two `Input`s ("Tagline", "Cuisine") bound to the tenant's current values, and include them in the submitted payload. In the settings/tenant update action, pass `tagline`/`cuisine` to the tenant update.

- [ ] **Step 3: Verify**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && npx tsc --noEmit && npm run build`
Expected: clean.
Manual: on the dashboard, toggle a product's Featured and set tagline/cuisine; reload and confirm they persist.

- [ ] **Step 4: Commit**

```bash
git add src/app/dashboard/
git commit -m "feat(dashboard): controls for product isFeatured and tenant tagline/cuisine"
```

---

### Task 6: Menu home — Hero + sticky scroll-spy CategoryNav + page wiring

**Files:**
- Modify: `src/app/_components/storefront/Hero.tsx`
- Modify: `src/app/_components/storefront/CategoryNav.tsx`
- Modify: `src/app/page.tsx` (storefront branch)
- Modify: `src/app/_components/StorefrontMenu.tsx` (accept + pass new props)

**Interfaces:**
- Consumes: `getBranchOpenState` (open/closes), `deliveryAreas` (ETA/min-order), `getPopularProductIds` (Task 3), tenant `tagline`/`cuisine`, `formatMoney`.
- Produces: `Hero` renders cover+logo+name+tagline/cuisine + truthful chip row; `CategoryNav` is sticky/glassy with scroll-spy; `StorefrontMenu` gains `popularIds: string[]`, `currency: string` (already), `tagline`/`cuisine` not needed (hero handles). `page.tsx` computes `popularIds` via `getPopularProductIds` and an ETA/min-order summary from delivery areas, passing them down.

- [ ] **Step 1: Rewrite `Hero.tsx`**

Full-bleed cover with ink scrim, overlapping logo badge, name in Bricolage, `cuisine · area` line, and a chip row. Props extend the current ones; render truthfully (omit any chip whose data is absent):

```tsx
import { Star } from "lucide-react"; // only if used; otherwise omit
export function Hero({
  name, logoUrl, coverImageUrl, tagline, cuisine, area, openLabel, etaLabel, minOrderLabel,
}: {
  name: string; logoUrl: string | null; coverImageUrl: string | null;
  tagline?: string | null; cuisine?: string | null; area?: string | null;
  openLabel?: string | null; etaLabel?: string | null; minOrderLabel?: string | null;
}) {
  return (
    <header className="relative">
      <div className="relative h-52 w-full sm:h-64">
        {coverImageUrl
          ? <img src={coverImageUrl} alt="" width={1200} height={512} loading="eager" className="h-full w-full object-cover" />
          : <div className="h-full w-full bg-secondary" />}
        <div className="absolute inset-0 bg-gradient-to-b from-ink/10 to-ink/75" />
        <div className="absolute inset-x-0 bottom-0 p-4 sm:p-6">
          <div className="flex flex-wrap gap-2">
            {openLabel && <span className="sf-chip">{openLabel}</span>}
            {etaLabel && <span className="sf-chip">{etaLabel}</span>}
            {minOrderLabel && <span className="sf-chip">{minOrderLabel}</span>}
          </div>
        </div>
      </div>
      <div className="relative -mt-9 flex items-end gap-3 px-4 sm:px-6">
        {logoUrl && <img src={logoUrl} alt="" width={72} height={72} className="size-[72px] flex-none rounded-2xl border-4 border-background object-cover shadow-lg" />}
        <div className="pb-1">
          <h1 className="font-display text-2xl font-extrabold leading-none text-ink sm:text-3xl">{name}</h1>
          {(cuisine || area || tagline) && (
            <p className="mt-1.5 text-sm text-muted-foreground">
              {[cuisine, area].filter(Boolean).join(" · ")}{tagline ? ` — ${tagline}` : ""}
            </p>
          )}
        </div>
      </div>
    </header>
  );
}
```

(Drop the `Star` import if unused. Keep whatever the current `Hero` already received — `primaryColor` etc. — if `page.tsx` still passes it; otherwise remove.)

- [ ] **Step 2: Make `CategoryNav` sticky + glassy + scroll-spy**

Convert the nav to `position: sticky; top: 0` with a translucent blurred background, and add scroll-spy: an `IntersectionObserver` over the `#category-<id>` section anchors that sets the active pill; clicking a pill smooth-scrolls to the section. Preserve the existing category list/props.

```tsx
"use client";
import { useEffect, useState } from "react";

export function CategoryNav({ categories }: { categories: { id: string; nameEn: string }[] }) {
  const [active, setActive] = useState(categories[0]?.id ?? "");
  useEffect(() => {
    const obs = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (vis[0]) setActive(vis[0].target.id.replace("category-", ""));
      },
      { rootMargin: "-45% 0px -50% 0px" },
    );
    categories.forEach((c) => { const el = document.getElementById(`category-${c.id}`); if (el) obs.observe(el); });
    return () => obs.disconnect();
  }, [categories]);

  return (
    <nav className="sticky top-0 z-20 -mx-4 border-b border-border bg-background/85 px-4 backdrop-blur-md sm:-mx-6 sm:px-6">
      <div className="flex gap-2 overflow-x-auto py-3">
        {categories.map((c) => (
          <a
            key={c.id}
            href={`#category-${c.id}`}
            onClick={(e) => { e.preventDefault(); document.getElementById(`category-${c.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
            className={`whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${active === c.id ? "bg-ink text-background" : "bg-card text-ink"}`}
          >
            {c.nameEn}
          </a>
        ))}
      </div>
    </nav>
  );
}
```

- [ ] **Step 3: Wire `page.tsx`**

Add `getPopularProductIds` to the storefront `Promise.all`; compute hero labels from the active branch + its delivery areas (open/closes via `getBranchOpenState`; ETA range = min–max of area `etaMinutes`; min-order = min area `minOrderAmount`, via `formatMoney`). Pass `tagline`/`cuisine`/`area`/labels to `<Hero>` and `popularIds={[...popularSet]}` to `<StorefrontMenu>`. Keep the existing banner/branch-selector/footer wiring.

- [ ] **Step 4: Thread the prop in `StorefrontMenu`**

Add `popularIds: string[]` to `StorefrontMenu`'s props type and pass it into the section renderer (Task 7 consumes it). No behavior change otherwise.

- [ ] **Step 5: Verify**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && npx tsc --noEmit && npm run build && npx playwright test tests/e2e/menu.spec.ts`
Expected: clean; `menu.spec.ts` green (hero heading still present).
Manual: hero shows cover/logo/tagline + truthful chips; nav sticks and highlights the section in view.

- [ ] **Step 6: Commit**

```bash
git add src/app/_components/storefront/Hero.tsx src/app/_components/storefront/CategoryNav.tsx src/app/page.tsx src/app/_components/StorefrontMenu.tsx
git commit -m "feat(storefront): cinematic hero + sticky scroll-spy category nav"
```

---

### Task 7: Menu sections — SectionHeader, ProductCard restyle, FeaturedCard, badges

**Files:**
- Modify: `src/app/_components/StorefrontMenu.tsx` (section rendering)
- Modify: `src/app/_components/storefront/ProductCard.tsx`
- Create: `src/app/_components/storefront/FeaturedCard.tsx`

**Interfaces:**
- Consumes: `SectionHeader`, `Badge` (Task 1); `isNewProduct` (Task 3); `popularIds` (Task 6); `formatMoney`; the extended `PublishedMenu` product (`isFeatured`, `createdAt`).
- Produces: each category renders a `SectionHeader`, one `FeaturedCard` for the section's `isFeatured` product, and a grid of restyled `ProductCard`s; each card shows Popular/New/Featured badges where earned. `Add —` accessible name preserved.

- [ ] **Step 1: Create `FeaturedCard.tsx`**

```tsx
import { formatMoney } from "@/lib/money";
import type { MenuProduct } from "./ProductCard";

export function FeaturedCard({ product, currency, interactive, onOpen }: {
  product: MenuProduct; currency: string; interactive: boolean; onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={interactive ? onOpen : undefined}
      disabled={!interactive}
      aria-label={interactive ? `Configure ${product.nameEn}` : product.nameEn}
      className="card-lift relative block h-44 w-full overflow-hidden rounded-2xl text-left disabled:opacity-100 sm:h-52"
    >
      {product.imageUrl
        ? <img src={product.imageUrl} alt="" width={800} height={416} loading="lazy" className="h-full w-full object-cover" />
        : <div className="h-full w-full bg-secondary" />}
      <div className="absolute inset-0 bg-gradient-to-r from-ink/85 via-ink/40 to-transparent" />
      <div className="absolute inset-y-0 left-0 flex max-w-[75%] flex-col justify-end p-4 sm:p-5">
        <span className="sf-badge-soft mb-2 self-start">Featured</span>
        <h3 className="font-display text-xl font-bold text-white sm:text-2xl">{product.nameEn}</h3>
        {product.descriptionEn && <p className="mt-1 line-clamp-2 text-xs text-white/85 sm:text-sm">{product.descriptionEn}</p>}
        <span className="mt-2 font-display text-lg font-bold text-white">{formatMoney(product.effectivePrice, currency)}</span>
      </div>
    </button>
  );
}
```

- [ ] **Step 2: Restyle `ProductCard.tsx`**

Keep its props (`product`, `interactive`, `onOpen`) and the `Configure {nameEn}` aria-label. Add an optional `badge?: "popular" | "new" | null` prop. Image-forward layout: image on top (`aspect-[4/3]`, `sf-img`, lazy), then name (Bricolage), one-line description, and a footer row with price (`formatMoney`) + a coral round add affordance. Overlay the `Badge` at the top-left of the image when `badge` is set. (Preserve the interactive/disabled gating exactly as today.)

```tsx
import { formatMoney } from "@/lib/money";
import { Badge } from "./Badge";
// ...existing MenuProduct type export stays...
export function ProductCard({ product, interactive, onOpen, currency, badge }: {
  product: MenuProduct; interactive: boolean; onOpen: () => void; currency: string; badge?: "popular" | "new" | null;
}) {
  return (
    <button
      type="button"
      onClick={interactive ? onOpen : undefined}
      disabled={!interactive}
      aria-label={interactive ? `Configure ${product.nameEn}` : product.nameEn}
      className="card-lift group flex flex-col overflow-hidden rounded-2xl bg-card text-left"
    >
      <div className="relative aspect-[4/3] w-full">
        {product.imageUrl
          ? <img src={product.imageUrl} alt="" loading="lazy" className="sf-img h-full w-full" />
          : <div className="sf-img h-full w-full" />}
        {badge && <span className="absolute left-2 top-2"><Badge kind={badge} /></span>}
      </div>
      <div className="flex flex-1 flex-col p-3">
        <h3 className="font-sans text-sm font-semibold leading-tight text-ink">{product.nameEn}</h3>
        {product.descriptionEn && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{product.descriptionEn}</p>}
        <div className="mt-auto flex items-center justify-between pt-2.5">
          <span className="font-display font-bold text-ink">{formatMoney(product.effectivePrice, currency)}</span>
          {interactive && <span className="grid size-8 place-items-center rounded-full bg-primary text-lg leading-none text-primary-foreground shadow-sm">+</span>}
        </div>
      </div>
    </button>
  );
}
```

- [ ] **Step 3: Render sections in `StorefrontMenu.tsx`**

For each category: render `<SectionHeader eyebrow={cat.nameAr} title={cat.nameEn} count={cat.products.length} />`, then the featured product (first with `isFeatured`) as `<FeaturedCard>` full-width, then the remaining products in the existing responsive grid as `<ProductCard>` with `badge` computed as: `popularIds.includes(p.id) ? "popular" : isNewProduct(p.createdAt) ? "new" : null`. Keep the section wrapper `id={`category-${cat.id}`}` and `scroll-mt` for the sticky nav. Featured product must NOT be duplicated in the grid.

```tsx
import { SectionHeader } from "./storefront/SectionHeader";
import { FeaturedCard } from "./storefront/FeaturedCard";
import { isNewProduct } from "@/lib/product-badges"; // pure, client-safe (NOT from popular.ts, which is server-only)
// inside the category map:
const featured = cat.products.find((p) => p.isFeatured) ?? null;
const rest = cat.products.filter((p) => p.id !== featured?.id);
// render: <SectionHeader .../>  { featured && <FeaturedCard .../> }  <div grid> rest.map(ProductCard) </div>
// badge per card: popularIds.includes(p.id) ? "popular" : isNewProduct(p.createdAt) ? "new" : null
```

`MenuProduct` (the product type in `ProductCard.tsx`) must include the fields Task 2 added to `PublishedMenu` products — ensure it has `isFeatured: boolean` and `createdAt: string` (add them if `MenuProduct` is a standalone interface rather than an alias of the `PublishedMenu` product), so `p.isFeatured`/`p.createdAt` typecheck here and in `FeaturedCard`.

- [ ] **Step 4: Verify**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && npx tsc --noEmit && npm run build && npx playwright test tests/e2e/menu.spec.ts tests/e2e/ordering.spec.ts`
Expected: clean; both specs green (`Configure`, `Add —` still reachable).
Manual: featured card per section, badges on the right items, cards image-forward, no duplicate of the featured item.

- [ ] **Step 5: Commit**

```bash
git add src/app/_components/StorefrontMenu.tsx src/app/_components/storefront/ProductCard.tsx src/app/_components/storefront/FeaturedCard.tsx
git commit -m "feat(storefront): section headers, featured cards, image-forward product cards + badges"
```

---

### Task 8: Product sheet restyle

**Files:**
- Modify: `src/app/_components/storefront/ProductSheet.tsx`

**Interfaces:**
- Consumes: `formatMoney`, `currency` (already passed), the `Sheet` primitive.
- Produces: restyled sheet; the Add button still starts with `Add —` and the total updates live.

- [ ] **Step 1: Restyle**

Add a large product hero image at the top of the sheet content (`aspect-[16/10]`, `sf-img`, lazy) when `product.imageUrl` exists; product name in `font-display`; description in muted text; modifier groups with a group header (name + required/optional hint) and option rows that show a clear selected state (coral ring/background) and the `+{formatMoney(delta, currency)}` on the right; a quantity stepper; and a sticky footer button `Add — {formatMoney(total, currency)}` (substring preserved). Keep all existing selection logic, props, and the `onAdd` contract unchanged — only markup/classes change.

- [ ] **Step 2: Verify**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && npx tsc --noEmit && npm run build && npx playwright test tests/e2e/ordering.spec.ts`
Expected: clean; `ordering.spec.ts` green (opens sheet, clicks `Add —`).
Manual: open a pizza, change size, watch the total update, add to cart.

- [ ] **Step 3: Commit**

```bash
git add src/app/_components/storefront/ProductSheet.tsx
git commit -m "feat(storefront): premium product sheet (hero image, modifier styling)"
```

---

### Task 9: Cart bar + cart drawer restyle

**Files:**
- Modify: `src/app/_components/storefront/CartBar.tsx`
- Modify: `src/app/_components/storefront/CartDrawer.tsx`

**Interfaces:**
- Consumes: `formatMoney`, `currency`, `setLineQuantity` wiring (already in place), `Sheet` primitive.
- Produces: restyled floating cart bar (`View cart` preserved) and drawer (`Checkout` link preserved; steppers, line thumbnails, currency).

- [ ] **Step 1: Restyle `CartBar`**

Keep props (`count`, `subtotal`, `onOpen`) and the `View cart` text. Render as a floating, rounded, coral bar fixed near the bottom with a soft shadow: left = "View cart · N items", right = `{formatMoney(subtotal, currency)} →` in `font-display`. Hidden when `count === 0` (existing behavior). Add `pb-[env(safe-area-inset-bottom)]` padding for mobile.

- [ ] **Step 2: Restyle `CartDrawer`**

Keep props and the `Checkout` link (with slug+branch query preserved). For each line: a small product thumbnail (if the line carries an image; if `CartLine` has no imageUrl, skip the thumbnail — do NOT add a new cart field in this task), name, modifier summary, a bordered stepper (− at 1 removes via `onSetQuantity(i, 0)`), and the line total via `formatMoney`. Subtotal row in `font-display`. Preserve the empty state and the `preorderOnly` note. Keep the per-line `key` as `${productId}-${selectedOptionIds.join(".")}`.

- [ ] **Step 3: Verify**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && npx tsc --noEmit && npm run build && npx playwright test tests/e2e/ordering.spec.ts`
Expected: clean; `ordering.spec.ts` green (`View cart` → drawer → `Checkout`).
Manual: add items, open drawer, adjust steppers, reach checkout.

- [ ] **Step 4: Commit**

```bash
git add src/app/_components/storefront/CartBar.tsx src/app/_components/storefront/CartDrawer.tsx
git commit -m "feat(storefront): floating cart bar + refined cart drawer"
```

---

### Task 10: Checkout restyle

**Files:**
- Modify: `src/app/checkout/page.tsx`
- Modify: `src/app/checkout/CheckoutForm.tsx`

**Interfaces:**
- Consumes: `formatMoney`, the `ui` primitives, existing slot/area/prefill/min-order logic.
- Produces: restyled checkout matching the shared language. ALL logic preserved; heading `/Checkout/` and placeholders `Name`/`Phone` preserved; `data-testid="slot"` on slot pills preserved.

- [ ] **Step 1: Restyle `page.tsx` header**

Keep the accessible heading containing "Checkout" (the existing `<h1 class="eyebrow">Checkout</h1>` + tenant name). Wrap the page in the storefront canvas (`bg-background`), constrain width, and add a slim branded header (tenant name in `font-display`, branch name muted). No logic change.

- [ ] **Step 2: Restyle `CheckoutForm.tsx`**

Purely presentational changes to the existing form: segmented pill toggles for fulfillment and ASAP/Schedule with a clear selected state (coral); Today/Tomorrow sub-toggle and slot pills (keep `data-testid="slot"`); grouped fields using `Label`+`Input`; a summary `card-lift` panel with item rows and subtotal/VAT/delivery/total via `formatMoney`; the min-order shortfall warning in `text-destructive` that still disables submit; the branch-mismatch card restyled. Preserve: `placeholder="Name"`, `placeholder="Phone"`, the submit disabled logic, stale-slot pre-check, prefill load/save, `scheduledFor` only-when-scheduled, `rememberOrder`→`clearCart`→redirect. Do not touch `submit()` logic — only markup/classes.

- [ ] **Step 3: Verify**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && npx tsc --noEmit && npm run build && npx playwright test tests/e2e/ordering.spec.ts tests/e2e/scheduling.spec.ts`
Expected: clean; both green (heading `/Checkout/`, placeholder `Name`, `data-testid=slot`, `Place order` flow intact).
Manual: full checkout (ASAP + a scheduled slot), min-order warning, prefill on return.

- [ ] **Step 4: Commit**

```bash
git add src/app/checkout/page.tsx src/app/checkout/CheckoutForm.tsx
git commit -m "feat(checkout): restyle to premium storefront language"
```

---

### Task 11: Order tracking restyle

**Files:**
- Modify: `src/app/order/[token]/page.tsx`
- Modify: `src/app/order/[token]/StatusPoller.tsx`

**Interfaces:**
- Consumes: `formatMoney`, `formatDayTime`, the `AlertDialog` primitives.
- Produces: restyled tracking; preserves 5s poll + terminal stop, `/Scheduled for/`, `pending`, `Cancel order`, `/cancelled/i`, WhatsApp CTA.

- [ ] **Step 1: Restyle `page.tsx`**

A hero-lite header (tenant name eyebrow + `Order #N` in `font-display` + placed/scheduled time via `formatDayTime`), the scheduled banner kept (text `Scheduled for …`), the receipt and fulfillment recap as `card-lift` cards with `formatMoney` totals, WhatsApp CTA kept. No data/logic change.

- [ ] **Step 2: Restyle `StatusPoller.tsx`**

Keep the 5s poll, terminal-stop, `cancellable`/`status`-driven Cancel button (named `Cancel order`), the AlertDialog confirm (action also `Cancel order`), the race-loser re-sync + escalation copy, and the terminal `/cancelled/i` rendering. Restyle the timeline: current step in coral/ink emphasis, completed steps filled, upcoming muted, with a connecting rail. Markup/classes only.

- [ ] **Step 3: Verify**

Run: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && npx tsc --noEmit && npm run build && npx playwright test tests/e2e/scheduling.spec.ts`
Expected: clean; `scheduling.spec.ts` green (scheduled banner, pending, Cancel order → cancelled).
Manual: place → track → cancel while pending.

- [ ] **Step 4: Commit**

```bash
git add "src/app/order/[token]/page.tsx" "src/app/order/[token]/StatusPoller.tsx"
git commit -m "feat(tracking): restyle status timeline + receipt to premium language"
```

---

### Task 12: Remaining surfaces + full verification pass

**Files:**
- Modify: `src/app/_components/storefront/OpenStateBanner.tsx`
- Modify: `src/app/_components/storefront/RecentOrderStrip.tsx`
- Modify: `src/app/_components/storefront/StorefrontFooter.tsx`
- Modify: `src/app/_components/storefront/BranchPickSheet.tsx`

**Interfaces:**
- Consumes: shared tokens/components from Task 1.
- Produces: the four remaining storefront bits restyled to match; then a full green verification pass.

- [ ] **Step 1: Restyle the components**

`OpenStateBanner`: a warm inline bar using `accent`/`muted` backgrounds with an icon; keep the three states (open/closes, closed-pre-order, paused) and their copy. `RecentOrderStrip`: `card-lift` pill rows linking to `/order/[token]`, keep the lazy status refresh and prune behavior. `StorefrontFooter`: a proper multi-column footer (Find us / Hours / links) using `SectionHeader`-style labels; fix the prior Minor by hoisting the WhatsApp link out of the `{branch && …}` block so it shows whenever `whatsappNumber` is set. `BranchPickSheet`: restyle the branch rows to `card-lift` selectable rows with the open/closed state chip, keeping the pick→`?branch=&product=` navigation. Markup/classes only; no data/logic change.

- [ ] **Step 2: Full verification pass**

Run each, expecting all green:
```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
npm run test          # full Vitest suite (incl. popular.test.ts)
npm run build         # type-safe production build
npm run test:e2e      # full Playwright suite (warm run; if a cold-cache flake in dashboard/responsive appears, re-run once — see prior plan's Task 12 note)
```

- [ ] **Step 3: Manual pass on the live Roma storefront**

`npm run dev`, open `http://roma.serveos.localhost:3000` (Chromium/Firefox resolve `*.localhost` to loopback). Walk the whole flow across a phone-width and desktop viewport, plus with OS "reduce motion" on: hero + chips, sticky scroll-spy nav, featured cards + badges, product sheet, cart drawer steppers, checkout (ASAP + scheduled + min-order + prefill), tracking (timeline + receipt + cancel), footer. Confirm all amounts read `EGP …` and no layout shift as images load.

- [ ] **Step 4: Commit**

```bash
git add src/app/_components/storefront/OpenStateBanner.tsx src/app/_components/storefront/RecentOrderStrip.tsx src/app/_components/storefront/StorefrontFooter.tsx
git commit -m "feat(storefront): restyle open-state banner, recent-order strip, footer + final polish"
```


