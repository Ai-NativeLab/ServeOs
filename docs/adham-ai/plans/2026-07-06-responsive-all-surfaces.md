# Responsive Across All Surfaces — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use ailab:subagent-driven-development (recommended) or ailab:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every web surface usable down to a 360px-wide phone, centered on giving the owner dashboard a mobile navigation it currently lacks.

**Architecture:** Extract the dashboard sidebar's interior into a shared `DashboardNav` client component consumed by both the desktop `<aside>` and a new `MobileNav` drawer (Radix `Dialog`, styled as a left panel). Add stacked-card mobile variants for the Orders and Menu tables. Verify the rest with a responsive smoke pass at 375/768/1280 and fix concrete overflows.

**Tech Stack:** Next.js 16 (App Router), React 19, Tailwind v4, `radix-ui` (Dialog primitive — already a dependency), Playwright e2e, Vitest (node env).

## Global Constraints

- Min supported width: **360px**; **no horizontal scroll on `document.body`** on any page.
- Breakpoints: **Tailwind defaults, mobile-first**; the dashboard sidebar switches at `md` (768px).
- Mobile dashboard nav is a **hamburger → left drawer** reusing the exact `dashboardNavItems` list; **no bottom tab bar**, no second nav system.
- Drawer uses the **Radix `Dialog` primitive** (`import { Dialog } from "radix-ui"`) — do **not** reuse or modify `src/components/ui/sheet.tsx` (that Sheet is a bottom-sheet/modal for product details).
- **No data-layer changes.** All work is presentational plus one extracted + one new client component.
- Desktop (`md+`) dashboard layout must remain visually unchanged.
- Only **Orders** and **Menu** tables get stacked-card mobile variants; other tables stay scroll-safe as-is.
- Branch: `feat/responsive-surfaces`. Seed for e2e: `npm run db:seed` (owner `owner@roma.com` / `owner1234`, slug `roma`).

---

## File Structure

- `src/components/dashboard/DashboardNav.tsx` — **new.** Renders the sidebar interior (brand header, restaurant name, nav links with active highlighting). Consumed by `Sidebar` and `MobileNav`.
- `src/components/dashboard/Sidebar.tsx` — **modify.** Thin `<aside className="hidden md:flex …">` wrapper around `DashboardNav`.
- `src/components/dashboard/MobileNav.tsx` — **new.** Hamburger button + Radix `Dialog` left drawer wrapping `DashboardNav`; closes on route change.
- `src/components/dashboard/Topbar.tsx` — **modify.** Accept `items` + `restaurantName`; render `MobileNav` + mobile wordmark on the left (`md:hidden`).
- `src/app/dashboard/layout.tsx` — **modify.** Pass `items`/`restaurantName` to `Topbar`; mobile padding on `<main>`.
- `src/app/dashboard/menu/page.tsx` — **modify.** Add `md:hidden` product-card list; wrap the existing table in `hidden md:block`.
- `src/app/dashboard/orders/OrdersTable.tsx` — **modify.** Add `md:hidden` order-card list; wrap the existing table in `hidden md:block`.
- `tests/e2e/responsive.spec.ts` — **new.** Mobile-nav behavior + no-horizontal-scroll smoke.

---

### Task 1: Extract `DashboardNav` and refactor `Sidebar` (no behavior change on desktop)

**Files:**
- Create: `src/components/dashboard/DashboardNav.tsx`
- Modify: `src/components/dashboard/Sidebar.tsx`
- Verify with existing test: `tests/e2e/dashboard.spec.ts`

**Interfaces:**
- Consumes: `NavItem` from `./nav-items` (`{ label: string; href: string; icon: string }`).
- Produces: `DashboardNav(props: { items: NavItem[]; restaurantName: string; onNavigate?: () => void })` — renders a full-height sidebar-themed column. `Sidebar(props: { items: NavItem[]; restaurantName: string })` (signature unchanged).

- [ ] **Step 1: Create `DashboardNav.tsx`** with the interior moved out of `Sidebar` (brand header + restaurant name + nav list + active highlighting). Root fills its parent and carries the sidebar theme.

```tsx
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Receipt, Utensils, Store, Image, Settings, BarChart3 } from "lucide-react";
import { cn } from "@/lib/utils";
import { LogoMark } from "@/components/brand/LogoMark";
import type { NavItem } from "./nav-items";

const ICONS: Record<string, React.ComponentType<{ className?: string; strokeWidth?: number }>> = {
  home: Home, analytics: BarChart3, receipt: Receipt, utensils: Utensils, store: Store, image: Image, settings: Settings,
};

export function DashboardNav({
  items, restaurantName, onNavigate,
}: {
  items: NavItem[];
  restaurantName: string;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  return (
    <div className="flex h-full w-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="h-16 flex items-center gap-3 px-4">
        <div className="size-9 rounded-lg bg-sidebar-primary grid place-items-center shrink-0">
          <LogoMark className="size-6 text-sidebar-primary-foreground" />
        </div>
        <span className="font-display text-lg font-bold tracking-tight">
          Serve<span className="text-sidebar-accent-foreground">OS</span>
        </span>
      </div>
      <div className="eyebrow px-4 pb-4 text-sidebar-foreground/50 truncate">{restaurantName}</div>
      <nav className="flex-1 px-2 space-y-1 overflow-y-auto">
        {items.map((item) => {
          const Icon = ICONS[item.icon] ?? Home;
          const active = item.href === "/dashboard"
            ? pathname === "/dashboard"
            : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-white/5 hover:text-sidebar-foreground",
              )}
            >
              <Icon className="size-4" strokeWidth={1.5} />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
```

- [ ] **Step 2: Replace `Sidebar.tsx`** with a thin wrapper. The `<aside>` keeps the desktop width/visibility + right border; `DashboardNav` supplies the background and content.

```tsx
import { DashboardNav } from "./DashboardNav";
import type { NavItem } from "./nav-items";

export function Sidebar({ items, restaurantName }: { items: NavItem[]; restaurantName: string }) {
  return (
    <aside className="hidden md:flex md:w-60 md:shrink-0 md:flex-col border-r border-sidebar-border">
      <DashboardNav items={items} restaurantName={restaurantName} />
    </aside>
  );
}
```

- [ ] **Step 3: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/components/dashboard/DashboardNav.tsx src/components/dashboard/Sidebar.tsx`
Expected: no output (clean).

- [ ] **Step 4: Verify desktop sidebar still works via existing e2e**

Run: `npm run db:seed && npx playwright test tests/e2e/dashboard.spec.ts`
Expected: PASS — the test scopes to `page.locator("aside").getByRole("link", { name: "Orders", exact: true })`, which still resolves because `Sidebar` still renders an `<aside>` at the default (desktop) viewport.

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/DashboardNav.tsx src/components/dashboard/Sidebar.tsx
git commit -m "refactor(dashboard): extract shared DashboardNav from Sidebar"
```

---

### Task 2: Mobile drawer nav (`MobileNav` + `Topbar` hamburger + layout wiring)

**Files:**
- Create: `src/components/dashboard/MobileNav.tsx`
- Modify: `src/components/dashboard/Topbar.tsx`
- Modify: `src/app/dashboard/layout.tsx`
- Create: `tests/e2e/responsive.spec.ts`

**Interfaces:**
- Consumes: `DashboardNav` (Task 1), `NavItem` from `./nav-items`, `signOutAction` from `@/app/dashboard/actions`.
- Produces: `MobileNav(props: { items: NavItem[]; restaurantName: string })`. `Topbar` new signature: `{ userName: string; roleLabel: string; pendingCount: number; items: NavItem[]; restaurantName: string }`.

- [ ] **Step 1: Write the failing e2e test** for mobile navigation.

Create `tests/e2e/responsive.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

const MOBILE = { width: 375, height: 800 };

async function login(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByPlaceholder("e.g. roma").fill("roma");
  await page.locator('input[name="email"]').fill("owner@roma.com");
  await page.locator('input[name="password"]').fill("owner1234");
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/dashboard/);
}

test.describe("mobile dashboard navigation", () => {
  test.use({ viewport: MOBILE });

  test("hamburger opens a drawer that navigates and closes", async ({ page }) => {
    await login(page);

    // Desktop sidebar is hidden on mobile.
    await expect(page.locator("aside")).toBeHidden();

    // Open the drawer from the top bar.
    await page.getByRole("button", { name: "Open menu" }).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();

    // Navigate to Orders from inside the drawer.
    await drawer.getByRole("link", { name: "Orders", exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard\/orders/);
    await expect(page.getByRole("heading", { name: "Orders" })).toBeVisible();

    // Drawer auto-closes after navigation.
    await expect(page.getByRole("dialog")).toBeHidden();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run db:seed && npx playwright test tests/e2e/responsive.spec.ts`
Expected: FAIL — no element with accessible name "Open menu" exists yet.

- [ ] **Step 3: Create `MobileNav.tsx`** (Radix `Dialog` left drawer).

```tsx
"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { Dialog } from "radix-ui";
import { DashboardNav } from "./DashboardNav";
import type { NavItem } from "./nav-items";

export function MobileNav({ items, restaurantName }: { items: NavItem[]; restaurantName: string }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close the drawer whenever the route changes.
  useEffect(() => { setOpen(false); }, [pathname]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        aria-label="Open menu"
        className="md:hidden inline-flex size-9 items-center justify-center rounded-md text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Menu className="size-5" />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 md:hidden" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 left-0 z-50 w-72 max-w-[80vw] md:hidden shadow-xl outline-none"
        >
          <Dialog.Title className="sr-only">Navigation menu</Dialog.Title>
          <DashboardNav items={items} restaurantName={restaurantName} onNavigate={() => setOpen(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

- [ ] **Step 4: Update `Topbar.tsx`** to accept `items`/`restaurantName` and render the hamburger + mobile wordmark on the left. Replace the whole file:

```tsx
"use client";
import Link from "next/link";
import { Bell } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { signOutAction } from "@/app/dashboard/actions";
import { SubmitButton } from "./SubmitButton";
import { MobileNav } from "./MobileNav";
import type { NavItem } from "./nav-items";

export function Topbar({
  userName, roleLabel, pendingCount, items, restaurantName,
}: {
  userName: string;
  roleLabel: string;
  pendingCount: number;
  items: NavItem[];
  restaurantName: string;
}) {
  return (
    <header className="h-14 flex items-center justify-between gap-3 border-b bg-card px-4">
      <div className="flex items-center gap-2 md:hidden">
        <MobileNav items={items} restaurantName={restaurantName} />
        <span className="font-display text-base font-bold tracking-tight">
          Serve<span className="text-primary">OS</span>
        </span>
      </div>
      <div className="flex items-center gap-3 ml-auto">
        <Button asChild variant="ghost" size="icon" className="relative">
          <Link href="/dashboard/orders" aria-label="Pending orders">
            <Bell className="size-5" />
            {pendingCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-primary text-[10px] leading-4 text-primary-foreground text-center">
                {pendingCount}
              </span>
            )}
          </Link>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="gap-2">
              <span className="size-7 rounded-full bg-secondary text-ink grid place-items-center text-xs font-semibold">
                {userName.slice(0, 1).toUpperCase()}
              </span>
              <span className="text-sm">{userName}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel className="font-normal">
              <div className="text-sm font-medium">{userName}</div>
              <div className="text-xs text-muted-foreground">{roleLabel}</div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="p-0">
              <form action={signOutAction} className="w-full">
                <SubmitButton variant="ghost" className="w-full justify-start px-2 h-8 font-normal">Sign out</SubmitButton>
              </form>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
```

- [ ] **Step 5: Wire `layout.tsx`** — pass the new props to `Topbar` and tighten mobile padding. Replace the returned JSX body:

```tsx
  return (
    <div className="min-h-screen flex bg-background text-foreground">
      <Sidebar items={items} restaurantName={tenant?.name ?? "Restaurant"} />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar
          userName={user.name}
          roleLabel={roleKeys[0] ?? "member"}
          pendingCount={pending}
          items={items}
          restaurantName={tenant?.name ?? "Restaurant"}
        />
        <main className="flex-1 p-4 md:p-6 max-w-5xl w-full mx-auto">{children}</main>
      </div>
      <Toaster richColors position="top-right" />
    </div>
  );
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx playwright test tests/e2e/responsive.spec.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck, lint, and re-run the desktop e2e**

Run: `npx tsc --noEmit && npx eslint src/components/dashboard/MobileNav.tsx src/components/dashboard/Topbar.tsx src/app/dashboard/layout.tsx && npx playwright test tests/e2e/dashboard.spec.ts`
Expected: clean + PASS (desktop unaffected).

- [ ] **Step 8: Commit**

```bash
git add src/components/dashboard/MobileNav.tsx src/components/dashboard/Topbar.tsx src/app/dashboard/layout.tsx tests/e2e/responsive.spec.ts
git commit -m "feat(dashboard): mobile drawer navigation for small screens"
```

---

### Task 3: Menu page — stacked product cards on mobile

**Files:**
- Modify: `src/app/dashboard/menu/page.tsx`
- Extend test: `tests/e2e/responsive.spec.ts`

**Interfaces:**
- Consumes: existing `listProducts`/`listCategories` output (`p.id`, `p.imageUrl`, `p.nameEn`, `p.basePrice`, `p.isPublished`, `p.categoryId`) already in scope on this page.
- Produces: no new exports (page-level markup only).

- [ ] **Step 1: Add the failing assertion** to `tests/e2e/responsive.spec.ts` inside the `mobile dashboard navigation` describe block (same `MOBILE` viewport):

```ts
  test("menu shows product cards, not a wide table, on mobile", async ({ page }) => {
    await login(page);
    await page.goto("/dashboard/menu");
    await expect(page.getByRole("heading", { name: "Menu" })).toBeVisible();

    // No horizontal overflow of the page body at 375px.
    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollW).toBeLessThanOrEqual(375 + 1);

    // The product table is hidden on mobile (its wrapper is `hidden md:block`).
    // If any categories with products exist, the mobile card list is what shows.
    await expect(page.locator("table").first()).toBeHidden();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test tests/e2e/responsive.spec.ts -g "menu shows product cards"`
Expected: FAIL — the table is currently always visible on mobile (`page.locator("table").first()` is visible), so `toBeHidden()` fails. (If the seed has no products, add one via the dashboard or `npm run db:seed` output first; the roma seed includes menu items.)

- [ ] **Step 3: Update `menu/page.tsx`** — replace the product-rendering block. Find the `catProds.length === 0 ? (...) : (<Table>…</Table>)` expression and replace the non-empty branch so the table is desktop-only and a card list renders on mobile. The full replacement for that ternary:

```tsx
                {catProds.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-2">No products in this category yet.</p>
                ) : (
                  <>
                    {/* Mobile: stacked cards */}
                    <ul className="md:hidden space-y-2">
                      {catProds.map((p) => (
                        <li key={p.id}>
                          <Link
                            href={`/dashboard/menu/products/${p.id}`}
                            className="flex items-center gap-3 rounded-lg border p-3"
                          >
                            {p.imageUrl
                              ? /* eslint-disable-next-line @next/next/no-img-element */
                                <img src={p.imageUrl} alt="" className="size-12 rounded-md object-cover shrink-0" />
                              : <span className="size-12 rounded-md bg-secondary grid place-items-center shrink-0"><ImageIcon className="size-4 text-muted-foreground" strokeWidth={1.5} /></span>}
                            <div className="min-w-0 flex-1">
                              <div className="font-medium text-ink truncate">{p.nameEn}</div>
                              <div className="font-mono text-sm text-muted-foreground">{Number(p.basePrice).toFixed(2)}</div>
                            </div>
                            <span className={p.isPublished
                              ? "shrink-0 inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium bg-status-ready/15 text-status-ready-fg ring-1 ring-status-ready/30"
                              : "shrink-0 inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium bg-secondary text-muted-foreground"}>
                              {p.isPublished ? "Published" : "Draft"}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>

                    {/* Desktop: table */}
                    <div className="hidden md:block">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="eyebrow w-14"></TableHead>
                            <TableHead className="eyebrow">Product</TableHead>
                            <TableHead className="eyebrow text-right">Price</TableHead>
                            <TableHead className="eyebrow">Status</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {catProds.map((p) => (
                            <TableRow key={p.id}>
                              <TableCell>
                                {p.imageUrl
                                  ? /* eslint-disable-next-line @next/next/no-img-element */
                                    <img src={p.imageUrl} alt="" className="size-10 rounded-md object-cover" />
                                  : <span className="size-10 rounded-md bg-secondary grid place-items-center"><ImageIcon className="size-4 text-muted-foreground" strokeWidth={1.5} /></span>}
                              </TableCell>
                              <TableCell>
                                <Link href={`/dashboard/menu/products/${p.id}`} className="font-medium text-ink hover:underline">{p.nameEn}</Link>
                              </TableCell>
                              <TableCell className="font-mono text-sm text-right">{Number(p.basePrice).toFixed(2)}</TableCell>
                              <TableCell>
                                <span className={p.isPublished
                                  ? "inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium bg-status-ready/15 text-status-ready-fg ring-1 ring-status-ready/30"
                                  : "inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium bg-secondary text-muted-foreground"}>
                                  {p.isPublished ? "Published" : "Draft"}
                                </span>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </>
                )}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx playwright test tests/e2e/responsive.spec.ts -g "menu shows product cards"`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/app/dashboard/menu/page.tsx`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/app/dashboard/menu/page.tsx tests/e2e/responsive.spec.ts
git commit -m "feat(dashboard): stacked product cards for menu on mobile"
```

---

### Task 4: Orders table — stacked order cards on mobile

**Files:**
- Modify: `src/app/dashboard/orders/OrdersTable.tsx`
- Extend test: `tests/e2e/responsive.spec.ts`

**Interfaces:**
- Consumes: `OrderRow` fields already used by this component (`r.id`, `r.orderNumber`, `r.customerName`, `r.fulfillmentType`, `r.total`, `r.paymentStatus`, `r.status`); `StatusBadge`, `Bike`, `ShoppingBag`, `cn`, `Link` already imported.
- Produces: no new exports (component-internal markup only).

- [ ] **Step 1: Add the failing assertion** to `tests/e2e/responsive.spec.ts` (same describe/viewport):

```ts
  test("orders shows cards, not a wide table, on mobile", async ({ page }) => {
    await login(page);
    await page.goto("/dashboard/orders");
    await expect(page.getByRole("heading", { name: "Orders" })).toBeVisible();

    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollW).toBeLessThanOrEqual(375 + 1);

    // On mobile the table wrapper is `hidden md:block`; with seeded orders the
    // card list renders instead. When there are zero orders the EmptyState shows
    // and there is simply no <table> — both satisfy "table not visible".
    await expect(page.locator("table")).toBeHidden();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test tests/e2e/responsive.spec.ts -g "orders shows cards"`
Expected: FAIL (when the seed has orders, the table is visible on mobile). If the seed has no orders the test would pass trivially — confirm the roma seed creates at least one order; the ordering e2e relies on seeded orders, so this holds.

- [ ] **Step 3: Update `OrdersTable.tsx`** — replace the `visible.length === 0 ? (<EmptyState…/>) : (<div className="rounded-xl border …"><Table>…</Table></div>)` block's non-empty branch with a mobile card list plus a desktop-only table wrapper:

```tsx
      {visible.length === 0 ? (
        <EmptyState
          title={(EMPTY_STATE_COPY[filter] ?? EMPTY_STATE_COPY.all).title}
          description={(EMPTY_STATE_COPY[filter] ?? EMPTY_STATE_COPY.all).description}
        />
      ) : (
        <>
          {/* Mobile: order cards */}
          <ul className="md:hidden space-y-2">
            {visible.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/dashboard/orders/${r.id}`}
                  className={cn("block rounded-xl border bg-card p-3", r.status === "pending" && "bg-primary/5")}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-sm">{r.orderNumber}</span>
                    <StatusBadge status={r.status} />
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="text-sm text-ink truncate">{r.customerName}</span>
                    <span className="font-mono text-sm">{Number(r.total).toFixed(2)}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      {r.fulfillmentType === "delivery"
                        ? <Bike className="size-3.5" strokeWidth={1.5} />
                        : <ShoppingBag className="size-3.5" strokeWidth={1.5} />}
                      {r.fulfillmentType === "delivery" ? "Delivery" : "Pickup"}
                    </span>
                    <span className={cn("font-medium", r.paymentStatus === "paid" ? "text-status-ready-fg" : "text-status-danger-fg")}>
                      {r.paymentStatus}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          {/* Desktop: table */}
          <div className="hidden md:block rounded-xl border bg-card overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="eyebrow">#</TableHead>
                  <TableHead className="eyebrow">Customer</TableHead>
                  <TableHead className="eyebrow">Type</TableHead>
                  <TableHead className="eyebrow text-right">Total</TableHead>
                  <TableHead className="eyebrow">Payment</TableHead>
                  <TableHead className="eyebrow">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((r) => (
                  <TableRow
                    key={r.id}
                    onClick={() => router.push(`/dashboard/orders/${r.id}`)}
                    className={cn("cursor-pointer", r.status === "pending" && "bg-primary/5")}
                  >
                    <TableCell className="font-mono text-sm">
                      <Link
                        href={`/dashboard/orders/${r.id}`}
                        className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {r.orderNumber}
                      </Link>
                    </TableCell>
                    <TableCell>{r.customerName}</TableCell>
                    <TableCell>
                      {r.fulfillmentType === "delivery"
                        ? <span className="inline-flex items-center gap-1.5 text-sm"><Bike className="size-4" strokeWidth={1.5} />Delivery</span>
                        : <span className="inline-flex items-center gap-1.5 text-sm"><ShoppingBag className="size-4" strokeWidth={1.5} />Pickup</span>}
                    </TableCell>
                    <TableCell className="font-mono text-sm text-right">{Number(r.total).toFixed(2)}</TableCell>
                    <TableCell>
                      <span className={cn("text-xs font-medium", r.paymentStatus === "paid" ? "text-status-ready-fg" : "text-status-danger-fg")}>
                        {r.paymentStatus}
                      </span>
                    </TableCell>
                    <TableCell><StatusBadge status={r.status} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx playwright test tests/e2e/responsive.spec.ts -g "orders shows cards"`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/app/dashboard/orders/OrdersTable.tsx`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/app/dashboard/orders/OrdersTable.tsx tests/e2e/responsive.spec.ts
git commit -m "feat(dashboard): stacked order cards for orders on mobile"
```

---

### Task 5: Cross-surface no-horizontal-scroll audit

**Files:**
- Extend test: `tests/e2e/responsive.spec.ts`
- Modify (only if the audit finds a violation): any offending page/component.

**Interfaces:** none (verification task).

- [ ] **Step 1: Add a no-horizontal-scroll smoke test** for public + authenticated pages at 360px. Append to `tests/e2e/responsive.spec.ts`:

```ts
test.describe("no horizontal overflow at 360px", () => {
  test.use({ viewport: { width: 360, height: 780 } });

  async function assertNoHScroll(page: import("@playwright/test").Page, url: string) {
    await page.goto(url);
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal overflow on ${url}`).toBeLessThanOrEqual(1);
  }

  test("public pages do not overflow", async ({ page }) => {
    await assertNoHScroll(page, "/");        // marketing
    await assertNoHScroll(page, "/login");
    await assertNoHScroll(page, "/register");
  });

  test("dashboard pages do not overflow", async ({ page }) => {
    await login(page);
    for (const url of ["/dashboard", "/dashboard/menu", "/dashboard/orders", "/dashboard/analytics", "/dashboard/settings"]) {
      await assertNoHScroll(page, url);
    }
  });
});
```

- [ ] **Step 2: Run the smoke test**

Run: `npx playwright test tests/e2e/responsive.spec.ts -g "no horizontal overflow"`
Expected: ideally PASS. If a page reports overflow, note which URL from the assertion message.

- [ ] **Step 3: Fix any reported overflow** using the minimal technique for the offending element (only touch what the test flags):
  - A wide fixed-width element → add `max-w-full` (and `w-full` where appropriate).
  - A non-wrapping flex row of buttons/badges → add `flex-wrap` (or `min-w-0` + `truncate` on the growing child).
  - Long unbroken text → `break-words` / `min-w-0` on its flex parent.
  - A genuinely wide block (code/table/diagram) → wrap it in `<div className="overflow-x-auto">`.

  Re-run Step 2 after each fix until green. If Step 2 already passed, make no changes.

- [ ] **Step 4: Manual check of host-based storefront + admin** (not reachable by plain path in the e2e baseURL). Run `npm run dev`, then in the browser at a 360px viewport (DevTools device toolbar) open:
  - the storefront (per `tests/e2e/menu.spec.ts` for how the storefront host/URL is formed),
  - a product's add-to-cart sheet and the cart/checkout,
  - `/admin` and `/admin/login`.

  Confirm no horizontal scrollbar and that primary buttons are reachable. Apply the same Step 3 techniques to any overflow found. Storefront components (`Hero`, `CartBar`, `CategoryNav`, `ProductCard`, `ProductSheet`) are already responsive, so expect few or no changes.

- [ ] **Step 5: Typecheck, lint, and full e2e**

Run: `npx tsc --noEmit && npm run lint && npx playwright test tests/e2e/responsive.spec.ts`
Expected: `tsc` clean; `lint` shows no **new** errors in files touched this task (the repo has pre-existing lint noise — compare against files you changed only); Playwright PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test(responsive): no-horizontal-scroll smoke + audit fixes"
```

---

## Self-Review

**Spec coverage:**
- Mobile dashboard drawer nav (hamburger → left drawer, reuse nav items) → Tasks 1–2. ✅
- Shared `DashboardNav` single source of truth → Task 1. ✅
- Drawer via existing Radix primitive, product `Sheet` untouched → Task 2 (uses `radix-ui` `Dialog` directly; constraint documented). ✅
- Drawer closes on route change → Task 2 (`useEffect` on `usePathname`). ✅
- Topbar hamburger + mobile brand → Task 2. ✅
- Mobile content padding `p-4 md:p-6` → Task 2, Step 5. ✅
- Orders + Menu stacked cards below `md`; other tables scroll-safe as-is → Tasks 3–4. ✅
- 360px min, no horizontal body scroll, all surfaces → Task 5. ✅
- Verification via Playwright at 375/360 → Tasks 2–5; 768/1280 covered because desktop paths keep the table/sidebar (existing `dashboard.spec.ts` runs at default desktop viewport). ✅

**Placeholder scan:** No "TBD/handle appropriately" steps; every code step shows complete code. Task 5's audit is expressed as a concrete automated assertion plus an explicit, enumerated remediation technique — not a vague "fix issues." ✅

**Type consistency:** `DashboardNav` props (`items`, `restaurantName`, `onNavigate?`) are identical everywhere they appear (Tasks 1–2). `Topbar`'s expanded signature in Task 2 matches the `layout.tsx` call site in the same task. `MobileNav` props match its Topbar call site. `OrderRow`/menu-product field names are copied verbatim from the current components. ✅
