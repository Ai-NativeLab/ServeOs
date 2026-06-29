# Dashboard Frontend Redesign — Phase 1: Foundation + Shell + Home — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use parallel-build (recommended) or build to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the Tailwind v4 + shadcn/ui design system, a shared dashboard shell (sidebar nav + topbar + page header), and a real onboarding Home page — so the dashboard is navigable and every later page has patterns to follow.

**Architecture:** Additive UI layer. We add Tailwind + shadcn under `src/components/ui` and `src/lib`, a `src/app/dashboard/layout.tsx` server component that wraps all dashboard pages in the shell (loading user/roles/restaurant name once), and a new `/dashboard` Home. Pure logic (status colors, role-gated nav, onboarding checklist) is extracted into testable functions. No changes to ordering/catalog logic — only a tiny read-only `getTenantById` helper is added for display.

**Tech Stack:** Next.js 16 (App Router), React 19, Tailwind CSS v4, shadcn/ui (Radix), lucide-react, Sonner (toasts), vitest.

**Source spec:** `docs/adham-ai/specs/2026-06-29-serveos-dashboard-frontend-redesign-design.md`

---

## Phasing roadmap

This is Phase 1 of the redesign. Later phases are separate plans, each reusing this foundation:

- **Phase 1 (this plan):** Foundation + Shell + Home
- **Phase 2:** Orders list + Order detail
- **Phase 3:** Menu (categories + products list/new/edit)
- **Phase 4:** Branches list + detail
- **Phase 5:** Fulfillment settings (tabs)
- **Phase 6:** Banners
- **Phase 7:** Extend Playwright e2e + polish pass

---

## File structure (Phase 1)

**Create:**
- `postcss.config.mjs` — Tailwind v4 PostCSS plugin
- `components.json` — shadcn config
- `src/lib/utils.ts` — `cn()` helper (created by shadcn)
- `src/components/ui/*` — shadcn primitives (button, card, badge, table, dialog, alert-dialog, dropdown-menu, tabs, select, switch, input, label, textarea, skeleton, sonner)
- `src/lib/order-status.ts` (+ `.test.ts`) — order-status label + badge class map
- `src/components/dashboard/nav-items.ts` (+ `.test.ts`) — role-gated nav model
- `src/components/dashboard/Sidebar.tsx` — left sidebar (client, active-link aware)
- `src/components/dashboard/Topbar.tsx` — topbar with pending bell + user menu
- `src/components/dashboard/PageHeader.tsx` — shared page header
- `src/components/dashboard/SubmitButton.tsx` — pending-aware submit button
- `src/app/dashboard/actions.ts` — `signOutAction`
- `src/app/dashboard/layout.tsx` — the shell
- `src/app/dashboard/error.tsx` — dashboard error boundary
- `src/lib/onboarding.ts` (+ `.test.ts`) — onboarding checklist derivation

**Modify:**
- `src/app/globals.css` — add Tailwind import + theme tokens (orange primary)
- `src/server/tenancy/service.ts` — add `getTenantById`
- `src/server/tenancy/index.ts` — export `getTenantById`
- `src/app/dashboard/page.tsx` — replace redirect-only index with the Home page

---

## Task 1: Install and configure Tailwind CSS v4

**Files:**
- Create: `postcss.config.mjs`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Install Tailwind v4 + PostCSS**

Run:
```bash
npm install -D tailwindcss@latest @tailwindcss/postcss@latest postcss@latest
```
Expected: packages added to `devDependencies`, no errors.

- [ ] **Step 2: Create the PostCSS config**

Create `postcss.config.mjs`:
```js
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
```

- [ ] **Step 3: Add the Tailwind import to globals.css**

At the very top of `src/app/globals.css` (above the existing `:root` block), add:
```css
@import "tailwindcss";
```
Leave the rest of the file as-is for now (Task 3 replaces the token block).

- [ ] **Step 4: Verify the build compiles with Tailwind**

Run:
```bash
npm run build
```
Expected: build completes successfully (compiled, route list printed). If it fails on PostCSS, confirm `postcss.config.mjs` exists and the plugin name is exactly `@tailwindcss/postcss`.

- [ ] **Step 5: Commit**

```bash
git add postcss.config.mjs src/app/globals.css package.json package-lock.json
git commit -m "build: add Tailwind CSS v4 + PostCSS"
```

---

## Task 2: Initialize shadcn/ui and add primitives

**Files:**
- Create: `components.json`, `src/lib/utils.ts`, `src/components/ui/*`

- [ ] **Step 1: Create the shadcn config**

Create `components.json`:
```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/app/globals.css",
    "baseColor": "slate",
    "cssVariables": true,
    "prefix": ""
  },
  "iconLibrary": "lucide",
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  }
}
```

- [ ] **Step 2: Install the runtime deps shadcn components need**

Run:
```bash
npm install clsx tailwind-merge class-variance-authority lucide-react sonner
```
Expected: added to `dependencies`.

- [ ] **Step 3: Create the `cn` helper**

Create `src/lib/utils.ts`:
```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 4: Add the shadcn primitives via the CLI**

Run (the CLI reads `components.json` and writes into `src/components/ui/`):
```bash
npx shadcn@latest add button card badge table dialog alert-dialog dropdown-menu tabs select switch input label textarea skeleton sonner --yes
```
Expected: files created under `src/components/ui/` (e.g. `button.tsx`, `card.tsx`, `sonner.tsx`, …). If the CLI prompts about React 19 peer deps, accept the suggested install. If a component fails to fetch, re-run for just that component name.

- [ ] **Step 5: Verify typecheck + build**

Run:
```bash
npx tsc --noEmit && npm run build
```
Expected: no type errors; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add components.json src/lib/utils.ts src/components/ui package.json package-lock.json src/app/globals.css
git commit -m "feat(ui): init shadcn/ui + base primitives"
```

---

## Task 3: Set the light theme tokens (orange primary)

shadcn's `add`/`init` writes neutral CSS variables into `globals.css`. This task pins the brand: orange primary on slate neutrals.

**Files:**
- Modify: `src/app/globals.css`

- [ ] **Step 1: Set the primary color to orange in both `:root` and `.dark`**

In `src/app/globals.css`, find the `:root { … }` block shadcn added (contains `--primary:` and `--primary-foreground:`). Replace those two lines in `:root` with:
```css
  --primary: oklch(0.705 0.213 47.6);
  --primary-foreground: oklch(0.985 0 0);
```
And in the `.dark { … }` block, replace its `--primary` / `--primary-foreground` with the same two lines. (`oklch(0.705 0.213 47.6)` is the ServeOS orange `#f97316`.)

- [ ] **Step 2: Remove the now-redundant manual reset**

Delete the old hand-written reset still in `globals.css` from before Tailwind — specifically the `* { box-sizing… padding:0; margin:0 }` rule and the old `:root { --background:#fff; --foreground:#171717 }` / matching dark block and the `body { font-family: Arial… }` rule. Tailwind preflight + shadcn tokens now own these. Keep `@import "tailwindcss";` at the top and the shadcn `@theme`/`:root`/`.dark` blocks.

- [ ] **Step 3: Verify marketing + auth pages still render**

Run:
```bash
npm run dev
```
Then open `http://localhost:3000/` and `http://localhost:3000/login`. Expected: pages still render (they use inline styles, so they're unaffected aside from preflight defaults). Stop the dev server when done (Ctrl-C).

- [ ] **Step 4: Commit**

```bash
git add src/app/globals.css
git commit -m "feat(ui): orange primary theme tokens"
```

---

## Task 4: Order-status label + badge map (TDD)

**Files:**
- Create: `src/lib/order-status.ts`
- Test: `src/lib/order-status.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/order-status.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { orderStatusMeta } from "./order-status";

describe("orderStatusMeta", () => {
  it("maps known statuses to a label and badge class", () => {
    expect(orderStatusMeta("pending").label).toBe("Pending");
    expect(orderStatusMeta("ready").badgeClass).toContain("green");
    expect(orderStatusMeta("out_for_delivery").label).toBe("Out for delivery");
    expect(orderStatusMeta("cancelled").badgeClass).toContain("red");
  });

  it("falls back gracefully for an unknown status", () => {
    expect(orderStatusMeta("mystery" as never).label).toBe("mystery");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npx vitest run src/lib/order-status.test.ts
```
Expected: FAIL — cannot find module `./order-status`.

- [ ] **Step 3: Implement the map**

Create `src/lib/order-status.ts`:
```ts
import type { OrderStatus } from "@/server/ordering/schema";

export type OrderStatusMeta = { label: string; badgeClass: string };

const MAP: Record<OrderStatus, OrderStatusMeta> = {
  pending: { label: "Pending", badgeClass: "bg-amber-100 text-amber-800 ring-1 ring-amber-600/20" },
  confirmed: { label: "Confirmed", badgeClass: "bg-blue-100 text-blue-800 ring-1 ring-blue-600/20" },
  preparing: { label: "Preparing", badgeClass: "bg-indigo-100 text-indigo-800 ring-1 ring-indigo-600/20" },
  ready: { label: "Ready", badgeClass: "bg-green-100 text-green-800 ring-1 ring-green-600/20" },
  out_for_delivery: { label: "Out for delivery", badgeClass: "bg-cyan-100 text-cyan-800 ring-1 ring-cyan-600/20" },
  completed: { label: "Completed", badgeClass: "bg-slate-100 text-slate-700 ring-1 ring-slate-500/20" },
  rejected: { label: "Rejected", badgeClass: "bg-red-100 text-red-800 ring-1 ring-red-600/20" },
  cancelled: { label: "Cancelled", badgeClass: "bg-red-100 text-red-800 ring-1 ring-red-600/20" },
};

export function orderStatusMeta(status: OrderStatus): OrderStatusMeta {
  return MAP[status] ?? { label: String(status), badgeClass: "bg-slate-100 text-slate-700 ring-1 ring-slate-500/20" };
}
```
(Full literal class strings so Tailwind's scanner keeps them.)

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npx vitest run src/lib/order-status.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/order-status.ts src/lib/order-status.test.ts
git commit -m "feat(ui): order-status label + badge map"
```

---

## Task 5: Role-gated nav model (TDD)

**Files:**
- Create: `src/components/dashboard/nav-items.ts`
- Test: `src/components/dashboard/nav-items.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/components/dashboard/nav-items.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { dashboardNavItems } from "./nav-items";

describe("dashboardNavItems", () => {
  it("shows staff only Orders (no Home/Menu/Settings)", () => {
    const hrefs = dashboardNavItems(["staff"]).map((i) => i.href);
    expect(hrefs).toEqual(["/dashboard/orders"]);
  });

  it("shows owners the full nav including Home and Settings", () => {
    const labels = dashboardNavItems(["owner"]).map((i) => i.label);
    expect(labels).toEqual(["Home", "Orders", "Menu", "Branches", "Banners", "Settings"]);
  });

  it("gives managers everything except nothing role-locked beyond owner extras", () => {
    const labels = dashboardNavItems(["manager"]).map((i) => i.label);
    expect(labels).toContain("Home");
    expect(labels).toContain("Settings");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npx vitest run src/components/dashboard/nav-items.test.ts
```
Expected: FAIL — cannot find module `./nav-items`.

- [ ] **Step 3: Implement the nav model**

Create `src/components/dashboard/nav-items.ts`:
```ts
import type { RoleKey, Permission } from "@/server/rbac/permissions";
import { can } from "@/server/rbac/authorize";

export type NavItem = { label: string; href: string; icon: string };

export function dashboardNavItems(roleKeys: RoleKey[]): NavItem[] {
  const has = (p: Permission) => can(roleKeys, p);
  const items: NavItem[] = [];

  // Home is setup-focused → owners/managers only (staff go straight to Orders).
  if (has("menu:manage") || has("fulfillment:manage")) items.push({ label: "Home", href: "/dashboard", icon: "home" });
  if (has("orders:manage")) items.push({ label: "Orders", href: "/dashboard/orders", icon: "receipt" });
  if (has("menu:manage")) items.push({ label: "Menu", href: "/dashboard/menu", icon: "utensils" });
  if (has("menu:manage")) items.push({ label: "Branches", href: "/dashboard/branches", icon: "store" });
  if (has("menu:manage")) items.push({ label: "Banners", href: "/dashboard/banners", icon: "image" });
  if (has("fulfillment:manage")) items.push({ label: "Settings", href: "/dashboard/fulfillment", icon: "settings" });

  return items;
}
```
Note: `Permission` and `RoleKey` are both exported from `src/server/rbac/permissions.ts` (verify the import resolves).

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npx vitest run src/components/dashboard/nav-items.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/nav-items.ts src/components/dashboard/nav-items.test.ts
git commit -m "feat(dashboard): role-gated nav model"
```

---

## Task 6: Sidebar component

**Files:**
- Create: `src/components/dashboard/Sidebar.tsx`

- [ ] **Step 1: Implement the sidebar (client component, active-link aware)**

Create `src/components/dashboard/Sidebar.tsx`:
```tsx
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Receipt, Utensils, Store, Image, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NavItem } from "./nav-items";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  home: Home, receipt: Receipt, utensils: Utensils, store: Store, image: Image, settings: Settings,
};

export function Sidebar({ items, restaurantName }: { items: NavItem[]; restaurantName: string }) {
  const pathname = usePathname();
  return (
    <aside className="hidden md:flex md:w-60 md:flex-col border-r bg-white">
      <div className="h-14 flex items-center gap-2 px-4 border-b">
        <div className="size-6 rounded bg-primary" />
        <span className="font-semibold">ServeOS</span>
      </div>
      <div className="px-4 py-3 text-sm text-muted-foreground truncate">{restaurantName}</div>
      <nav className="flex-1 px-2 space-y-1">
        {items.map((item) => {
          const Icon = ICONS[item.icon] ?? Home;
          const active = item.href === "/dashboard"
            ? pathname === "/dashboard"
            : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium",
                active ? "bg-primary/10 text-primary" : "text-slate-600 hover:bg-slate-100",
              )}
            >
              <Icon className="size-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/dashboard/Sidebar.tsx
git commit -m "feat(dashboard): sidebar nav component"
```

---

## Task 7: Sign-out action + pending-aware submit button + topbar

**Files:**
- Create: `src/app/dashboard/actions.ts`, `src/components/dashboard/SubmitButton.tsx`, `src/components/dashboard/Topbar.tsx`

- [ ] **Step 1: Implement the sign-out server action**

Create `src/app/dashboard/actions.ts`:
```ts
"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { invalidateSession } from "@/server/auth";
import { SESSION_COOKIE } from "@/server/auth/current-user";

export async function signOutAction() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await invalidateSession(token);
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}
```

- [ ] **Step 2: Implement the pending-aware submit button**

Create `src/components/dashboard/SubmitButton.tsx`:
```tsx
"use client";
import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ComponentProps } from "react";

export function SubmitButton({ children, ...props }: ComponentProps<typeof Button>) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} {...props}>
      {pending && <Loader2 className="size-4 animate-spin" />}
      {children}
    </Button>
  );
}
```

- [ ] **Step 3: Implement the topbar**

Create `src/components/dashboard/Topbar.tsx`:
```tsx
import Link from "next/link";
import { Bell } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { signOutAction } from "@/app/dashboard/actions";
import { SubmitButton } from "./SubmitButton";

export function Topbar({ userName, roleLabel, pendingCount }: { userName: string; roleLabel: string; pendingCount: number }) {
  return (
    <header className="h-14 flex items-center justify-end gap-3 border-b bg-white px-4">
      <Button asChild variant="ghost" size="icon" className="relative">
        <Link href="/dashboard/orders" aria-label="Pending orders">
          <Bell className="size-5" />
          {pendingCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-primary text-[10px] leading-4 text-white text-center">
              {pendingCount}
            </span>
          )}
        </Link>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="gap-2">
            <span className="size-7 rounded-full bg-slate-200 grid place-items-center text-xs font-semibold">
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
          <DropdownMenuItem asChild>
            <form action={signOutAction}>
              <SubmitButton variant="ghost" className="w-full justify-start px-2 h-8 font-normal">Sign out</SubmitButton>
            </form>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
```

- [ ] **Step 4: Verify typecheck**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/actions.ts src/components/dashboard/SubmitButton.tsx src/components/dashboard/Topbar.tsx
git commit -m "feat(dashboard): topbar with sign-out + pending bell"
```

---

## Task 8: PageHeader component

**Files:**
- Create: `src/components/dashboard/PageHeader.tsx`

- [ ] **Step 1: Implement the page header**

Create `src/components/dashboard/PageHeader.tsx`:
```tsx
import type { ReactNode } from "react";

export function PageHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 mb-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/dashboard/PageHeader.tsx
git commit -m "feat(dashboard): PageHeader component"
```

---

## Task 9: Add `getTenantById` read helper

**Files:**
- Modify: `src/server/tenancy/service.ts`, `src/server/tenancy/index.ts`

- [ ] **Step 1: Add the helper to the service**

In `src/server/tenancy/service.ts`, add (near `getTenantBySlug`; reuse the file's existing `db`, `tenants`, and `eq` imports — add `eq` to the drizzle import if not already present):
```ts
export async function getTenantById(id: string): Promise<Tenant | null> {
  const [row] = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
  return row ?? null;
}
```

- [ ] **Step 2: Export it from the barrel**

In `src/server/tenancy/index.ts`, add `getTenantById` to the existing `export { … } from "./service";` list.

- [ ] **Step 3: Verify typecheck**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/server/tenancy/service.ts src/server/tenancy/index.ts
git commit -m "feat(tenancy): getTenantById read helper"
```

---

## Task 10: Dashboard shell layout + Toaster + error boundary

**Files:**
- Create: `src/app/dashboard/layout.tsx`, `src/app/dashboard/error.tsx`

- [ ] **Step 1: Implement the shell layout**

Create `src/app/dashboard/layout.tsx`:
```tsx
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { getTenantById } from "@/server/tenancy";
import { pendingOrderCount } from "@/server/ordering/service";
import { dashboardNavItems } from "@/components/dashboard/nav-items";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { Topbar } from "@/components/dashboard/Topbar";
import { Toaster } from "@/components/ui/sonner";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, tenantId, roleKeys } = await requireDashboardUser();
  const [tenant, pending] = await Promise.all([getTenantById(tenantId), pendingOrderCount(tenantId)]);
  const items = dashboardNavItems(roleKeys);

  return (
    <div className="min-h-screen flex bg-slate-50 text-slate-900">
      <Sidebar items={items} restaurantName={tenant?.name ?? "Restaurant"} />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar userName={user.name} roleLabel={roleKeys[0] ?? "member"} pendingCount={pending} />
        <main className="flex-1 p-6 max-w-5xl w-full mx-auto">{children}</main>
      </div>
      <Toaster richColors position="top-right" />
    </div>
  );
}
```

- [ ] **Step 2: Implement the dashboard error boundary**

Create `src/app/dashboard/error.tsx`:
```tsx
"use client";
import { Button } from "@/components/ui/button";

export default function DashboardError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="grid place-items-center py-24 text-center">
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Something went wrong</h2>
        <p className="text-sm text-muted-foreground">This page failed to load. Try again.</p>
        <Button onClick={reset}>Retry</Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify typecheck + build**

Run:
```bash
npx tsc --noEmit && npm run build
```
Expected: no type errors; build succeeds and lists `/dashboard` as a route.

- [ ] **Step 4: Commit**

```bash
git add src/app/dashboard/layout.tsx src/app/dashboard/error.tsx
git commit -m "feat(dashboard): shell layout (sidebar + topbar + toaster) and error boundary"
```

---

## Task 11: Onboarding checklist derivation (TDD)

**Files:**
- Create: `src/lib/onboarding.ts`
- Test: `src/lib/onboarding.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/onboarding.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { onboardingSteps } from "./onboarding";

describe("onboardingSteps", () => {
  it("marks steps done based on input flags", () => {
    const steps = onboardingSteps({ branchCount: 1, publishedProductCount: 0, hasOpeningHours: true, acceptingOrders: false });
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s.done]));
    expect(byKey.branch).toBe(true);
    expect(byKey.menu).toBe(false);
    expect(byKey.hours).toBe(true);
    expect(byKey.live).toBe(false);
  });

  it("returns the four setup steps in order with hrefs", () => {
    const steps = onboardingSteps({ branchCount: 0, publishedProductCount: 0, hasOpeningHours: false, acceptingOrders: false });
    expect(steps.map((s) => s.key)).toEqual(["branch", "menu", "hours", "live"]);
    expect(steps.every((s) => s.href.startsWith("/dashboard/"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npx vitest run src/lib/onboarding.test.ts
```
Expected: FAIL — cannot find module `./onboarding`.

- [ ] **Step 3: Implement the derivation**

Create `src/lib/onboarding.ts`:
```ts
export type OnboardingStep = { key: string; label: string; href: string; done: boolean };

export type OnboardingInput = {
  branchCount: number;
  publishedProductCount: number;
  hasOpeningHours: boolean;
  acceptingOrders: boolean;
};

export function onboardingSteps(input: OnboardingInput): OnboardingStep[] {
  return [
    { key: "branch", label: "Add a branch", href: "/dashboard/branches", done: input.branchCount > 0 },
    { key: "menu", label: "Publish menu items", href: "/dashboard/menu", done: input.publishedProductCount > 0 },
    { key: "hours", label: "Set opening hours", href: "/dashboard/fulfillment", done: input.hasOpeningHours },
    { key: "live", label: "Start accepting orders", href: "/dashboard/fulfillment", done: input.acceptingOrders },
  ];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npx vitest run src/lib/onboarding.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/onboarding.ts src/lib/onboarding.test.ts
git commit -m "feat(dashboard): onboarding checklist derivation"
```

---

## Task 12: Dashboard Home page (replaces redirect index)

The current `src/app/dashboard/page.tsx` only redirects. Owners/managers now land on a real Home; staff (Orders-only) still redirect to Orders.

**Files:**
- Modify: `src/app/dashboard/page.tsx`

- [ ] **Step 1: Replace the index with the Home page**

Replace the entire contents of `src/app/dashboard/page.tsx` with:
```tsx
import { redirect } from "next/navigation";
import Link from "next/link";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { can } from "@/server/rbac/authorize";
import { listBranches } from "@/server/branches/service";
import { listProducts } from "@/server/catalog/service";
import { listOrders } from "@/server/ordering/service";
import { onboardingSteps } from "@/lib/onboarding";
import { orderStatusMeta } from "@/lib/order-status";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Card } from "@/components/ui/card";
import { CheckCircle2, Circle } from "lucide-react";

export default async function DashboardHome() {
  const { tenantId, roleKeys } = await requireDashboardUser();

  // Staff (Orders is their only section) have no Home — send them to Orders.
  if (!can(roleKeys, "menu:manage") && !can(roleKeys, "fulfillment:manage")) {
    redirect("/dashboard/orders");
  }

  const [branches, products, orders] = await Promise.all([
    listBranches(tenantId),
    listProducts(tenantId),
    listOrders(tenantId, { limit: 100 }),
  ]);

  const steps = onboardingSteps({
    branchCount: branches.length,
    publishedProductCount: products.filter((p) => p.isPublished).length,
    hasOpeningHours: branches.some((b) => (b.openingHours ?? []).length > 0),
    acceptingOrders: branches.some((b) => b.acceptingOrders),
  });

  const counts = orders.reduce<Record<string, number>>((acc, o) => {
    acc[o.status] = (acc[o.status] ?? 0) + 1;
    return acc;
  }, {});
  const snapshot = (["pending", "preparing", "ready", "completed"] as const).map((s) => ({
    status: s, count: counts[s] ?? 0, meta: orderStatusMeta(s),
  }));

  return (
    <>
      <PageHeader title="Home" description="Your setup progress and today's orders." />

      <Card className="p-5 mb-6">
        <h2 className="text-sm font-semibold mb-3">Get set up</h2>
        <ul className="space-y-2">
          {steps.map((step) => (
            <li key={step.key}>
              <Link href={step.href} className="flex items-center gap-3 text-sm hover:underline">
                {step.done
                  ? <CheckCircle2 className="size-5 text-green-600" />
                  : <Circle className="size-5 text-slate-300" />}
                <span className={step.done ? "text-muted-foreground line-through" : ""}>{step.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>

      <h2 className="text-sm font-semibold mb-3">Orders</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {snapshot.map((s) => (
          <Card key={s.status} className="p-4">
            <div className="text-2xl font-semibold">{s.count}</div>
            <div className={`inline-block mt-1 rounded px-2 py-0.5 text-xs ${s.meta.badgeClass}`}>{s.meta.label}</div>
          </Card>
        ))}
      </div>
    </>
  );
}
```

- [ ] **Step 2: Verify typecheck + build**

Run:
```bash
npx tsc --noEmit && npm run build
```
Expected: no type errors; build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/app/dashboard/page.tsx
git commit -m "feat(dashboard): onboarding Home page"
```

---

## Task 13: Full verification (manual + test suite)

**Files:** none (verification only)

- [ ] **Step 1: Run unit tests for the new logic**

Run:
```bash
npx vitest run src/lib/order-status.test.ts src/lib/onboarding.test.ts src/components/dashboard/nav-items.test.ts
```
Expected: all PASS.

- [ ] **Step 2: Typecheck + production build**

Run:
```bash
npx tsc --noEmit && npm run build
```
Expected: clean.

- [ ] **Step 3: Manual smoke test (local)**

Run `npm run dev`, then:
- Sign in at `http://localhost:3000/login` as `owner@roma.com` / `owner1234` (slug `roma`).
- Confirm: the dashboard shows the **sidebar** (Home, Orders, Menu, Branches, Banners, Settings), the **topbar** with the user menu + pending bell, and the **Home** page (setup checklist + order snapshot cards).
- Click each nav item — confirm active highlight follows the route and pages still load (older pages remain unstyled; that's expected until later phases).
- Open the user menu → **Sign out** → confirm redirect to `/login`.
- Sign in as `staff@roma.com` / `staff1234` → confirm you land on **Orders** and the sidebar shows only Orders.

Stop the dev server when done.

- [ ] **Step 4: Final commit (if any manual fixups were needed)**

```bash
git add -A
git commit -m "chore(dashboard): phase 1 foundation + shell + home verified" || echo "nothing to commit"
```

---

## Self-review notes

- **Spec coverage (Phase 1 portion):** Tailwind+shadcn foundation (Tasks 1–3) ✓; design tokens incl. orange + status colors (Tasks 3–4) ✓; shell with role-gated sidebar, topbar with bell + user menu, PageHeader (Tasks 5–10) ✓; onboarding Home with checklist + snapshot, staff→Orders routing (Tasks 11–12) ✓; error boundary + toaster foundation (Tasks 7, 10) ✓. Pages 1–11 redesign, full toast-on-action migration, e2e extension → deferred to Phases 2–7 per the roadmap.
- **No placeholders:** every code step contains complete code; CLI steps (shadcn add) state exact commands + expected files.
- **Type consistency:** `NavItem` (Task 5) consumed by `Sidebar`/layout with matching `{label, href, icon}`; `orderStatusMeta` returns `{label, badgeClass}` used in Topbar-adjacent Home; `onboardingSteps` `{key,label,href,done}` consumed by Home; `getTenantById` returns `Tenant | null`, layout handles null.
