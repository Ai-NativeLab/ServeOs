# Dashboard Brand Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use ailab:subagent-driven-development (recommended) or ailab:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard's interim look with the real ServeOS brand identity (warm ink/cream/coral tokens, Bricolage Grotesque + Space Grotesk + JetBrains Mono, dark ink sidebar, node-mark logo), then migrate every remaining dashboard page under it.

**Architecture:** Token-level rebrand — all shadcn semantic CSS variables in `src/app/globals.css` are remapped to the brand palette so every existing and future component picks the brand up automatically. Fonts load via `next/font/google` variables on the root layout. Pages are then rewritten one at a time from legacy inline-style JSX to the shared shadcn primitives, reusing all existing server actions and services unchanged.

**Tech Stack:** Next.js 16.2.9 (App Router, React 19), Tailwind CSS v4, shadcn/ui (vendored in `src/components/ui/`), lucide-react, sonner, vitest, Playwright.

**Specs:** `docs/adham-ai/specs/2026-07-04-dashboard-brand-identity-design.md` (brand layer, authoritative for all visual values) and `docs/adham-ai/specs/2026-06-29-serveos-dashboard-frontend-redesign-design.md` (functional page behavior).

## Global Constraints

- **Presentational only.** Do not modify anything under `src/server/`, `src/db/`, any `actions.ts` file, `src/proxy.ts`, or middleware. Pages reuse existing server actions with their exact current signatures.
- **Brand palette (verbatim):** paper `#FBF7F2`, card `#FFFDFB`, ink `#1A0F0A`, body text `#3A332C`, muted text `#948676`, border `rgba(26,15,10,.09)`, coral primary `#F0522B` (hover `#D23F1C`), bright coral `#FF6B45`, sidebar `#17100B`, sidebar border `rgba(255,255,255,.14)`, active-nav tint `rgba(240,82,43,.16)`, destructive `#CE2C2C`.
- **Status colors (verbatim):** pending `#E8A33D`, confirmed `#2E6BFF`, preparing `#2DD4C4`, ready `#38D08C`, out_for_delivery `#0FB5A6`, completed `#948676`, cancelled/rejected `#CE2C2C`.
- **Fonts:** Bricolage Grotesque 600/700/800 (display: H1–H3, big numbers), Space Grotesk 400/500/700 (default UI/body), JetBrains Mono 400/500 (eyebrow labels, order codes), IBM Plex Sans Arabic 400/600/700 (Arabic fallback only). Latin subsets (+ `arabic` for Plex).
- **This is NOT the Next.js you know** (per `AGENTS.md`): before writing font or icon code, read `node_modules/next/dist/docs/01-app/01-getting-started/13-fonts.md` and, for icon files, `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/` if unsure of conventions.
- **Verification commands:** `npx tsc --noEmit` (typecheck), `npx next build` (build). The full `npx vitest run` suite hits a remote test DB and is slow — run targeted files per task (e.g. `npx vitest run src/lib/order-status.test.ts`) and the full suite only in the final task.
- **Dashboard chrome is English-only**; menu content keeps EN+AR fields (`dir="rtl"` on AR inputs).
- All work happens on `main` (project convention: direct commits, conventional-commit messages).

## File Structure

```
src/app/fonts.ts                              (new)  next/font instances
src/app/layout.tsx                            (mod)  font variables on <html>
src/app/globals.css                           (mod)  brand tokens, fonts, eyebrow utility
src/app/icon.svg                              (new)  favicon: coral mark on ink tile
src/app/apple-icon.tsx                        (new)  touch icon via ImageResponse
src/components/brand/LogoMark.tsx             (new)  node-mark SVG, currentColor
src/components/brand/Wordmark.tsx             (new)  mark + Serve[OS] lockup
src/lib/order-status.ts                       (mod)  brand semantic badge classes
src/lib/order-status.test.ts                  (mod)  assert new token names
src/components/dashboard/Sidebar.tsx          (mod)  dark ink reskin
src/components/dashboard/Topbar.tsx           (mod)  warm-white reskin
src/components/dashboard/PageHeader.tsx       (mod)  display font + eyebrow prop
src/components/dashboard/EmptyState.tsx       (new)  shared empty state
src/components/dashboard/StatusBadge.tsx      (new)  status pill
src/components/dashboard/ToastForm.tsx        (new)  form wrapper w/ toast (non-redirecting actions)
src/components/dashboard/ConfirmActionButton.tsx (new) AlertDialog-confirmed action
src/app/dashboard/layout.tsx                  (mod)  token classes
src/app/dashboard/page.tsx                    (mod)  Home brand touches
src/app/dashboard/error.tsx                   (mod)  branded boundary
src/app/dashboard/orders/page.tsx             (mod)  rewrite
src/app/dashboard/orders/OrdersTable.tsx      (mod)  rewrite (Table + Tabs + Badges)
src/app/dashboard/orders/[id]/page.tsx        (mod)  rewrite
src/app/dashboard/menu/page.tsx               (mod)  rewrite
src/app/dashboard/menu/products/new/page.tsx  (mod)  rewrite
src/app/dashboard/menu/products/[id]/page.tsx (mod)  rewrite
src/app/dashboard/menu/categories/new/page.tsx(mod)  rewrite
src/app/dashboard/menu/categories/[id]/page.tsx(mod) rewrite
src/app/dashboard/branches/page.tsx           (mod)  rewrite
src/app/dashboard/branches/[id]/page.tsx      (mod)  rewrite
src/app/dashboard/fulfillment/page.tsx        (mod)  rewrite
src/app/dashboard/banners/page.tsx            (mod)  rewrite
tests/e2e/dashboard.spec.ts                   (new)  login → Orders happy path
```

---

### Task 1: Brand foundation — tokens, fonts, status colors, logo, favicon

**Files:**
- Create: `src/app/fonts.ts`, `src/components/brand/LogoMark.tsx`, `src/components/brand/Wordmark.tsx`, `src/app/icon.svg`, `src/app/apple-icon.tsx`
- Modify: `src/app/layout.tsx`, `src/app/globals.css`, `src/lib/order-status.ts`, `src/lib/order-status.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (later tasks rely on these exact names):
  - `LogoMark({ className }: { className?: string })` from `@/components/brand/LogoMark`
  - `Wordmark({ className }: { className?: string })` from `@/components/brand/Wordmark`
  - CSS utilities: `eyebrow`, `font-display`, `text-ink`, `bg-status-*`/`text-status-*-fg`/`ring-status-*` color utilities
  - `orderStatusMeta(status)` unchanged signature; `badgeClass` strings now reference `status-*` tokens.

- [ ] **Step 1: Update the status-map test to expect brand tokens (failing first)**

Replace the first test body in `src/lib/order-status.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { orderStatusMeta } from "./order-status";

describe("orderStatusMeta", () => {
  it("maps known statuses to a label and brand badge class", () => {
    expect(orderStatusMeta("pending").label).toBe("Pending");
    expect(orderStatusMeta("pending").badgeClass).toContain("status-pending");
    expect(orderStatusMeta("ready").badgeClass).toContain("status-ready");
    expect(orderStatusMeta("out_for_delivery").label).toBe("Out for delivery");
    expect(orderStatusMeta("cancelled").badgeClass).toContain("status-danger");
  });

  it("falls back gracefully for an unknown status", () => {
    expect(orderStatusMeta("mystery" as never).label).toBe("mystery");
    expect(orderStatusMeta("mystery" as never).badgeClass).toContain("status-completed");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/order-status.test.ts`
Expected: FAIL — badgeClass contains `amber-100`, not `status-pending`.

- [ ] **Step 3: Rewrite `src/lib/order-status.ts` with brand tokens**

```ts
import type { OrderStatus } from "@/server/ordering/schema";

export type OrderStatusMeta = { label: string; badgeClass: string };

const badge = (token: string) =>
  `bg-status-${token}/15 text-status-${token}-fg ring-1 ring-status-${token}/30`;

const MAP: Record<OrderStatus, OrderStatusMeta> = {
  pending: { label: "Pending", badgeClass: badge("pending") },
  confirmed: { label: "Confirmed", badgeClass: badge("confirmed") },
  preparing: { label: "Preparing", badgeClass: badge("preparing") },
  ready: { label: "Ready", badgeClass: badge("ready") },
  out_for_delivery: { label: "Out for delivery", badgeClass: badge("delivery") },
  completed: { label: "Completed", badgeClass: badge("completed") },
  rejected: { label: "Rejected", badgeClass: badge("danger") },
  cancelled: { label: "Cancelled", badgeClass: badge("danger") },
};

export function orderStatusMeta(status: OrderStatus): OrderStatusMeta {
  return MAP[status] ?? { label: String(status), badgeClass: badge("completed") };
}
```

> Tailwind v4 can only generate utilities it sees as complete class strings in source files. The `badge()` helper builds strings dynamically, so Step 5 registers every `status-*` utility via `@source inline(...)` in `globals.css` — do not skip that part.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/order-status.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Replace the token block in `src/app/globals.css`**

Full new file content:

```css
@import "tailwindcss";

/* Dynamic badge classes from src/lib/order-status.ts — Tailwind can't see them, so force-generate. */
@source inline("{bg,ring}-status-{pending,confirmed,preparing,ready,delivery,completed,danger}/{15,30}");
@source inline("text-status-{pending,confirmed,preparing,ready,delivery,completed,danger}-fg");

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-ink: var(--ink);
  --color-chart-1: var(--chart-1);
  --color-chart-2: var(--chart-2);
  --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4);
  --color-chart-5: var(--chart-5);
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-ring: var(--sidebar-ring);
  --color-status-pending: #e8a33d;
  --color-status-pending-fg: #8f6410;
  --color-status-confirmed: #2e6bff;
  --color-status-confirmed-fg: #1f49b0;
  --color-status-preparing: #2dd4c4;
  --color-status-preparing-fg: #0b7a70;
  --color-status-ready: #38d08c;
  --color-status-ready-fg: #177a4f;
  --color-status-delivery: #0fb5a6;
  --color-status-delivery-fg: #086e63;
  --color-status-completed: #948676;
  --color-status-completed-fg: #6e6459;
  --color-status-danger: #ce2c2c;
  --color-status-danger-fg: #a22222;
  --font-sans: var(--font-space-grotesk), var(--font-plex-arabic), ui-sans-serif, system-ui, sans-serif;
  --font-display: var(--font-bricolage), var(--font-space-grotesk), ui-sans-serif, sans-serif;
  --font-mono: var(--font-jetbrains), ui-monospace, monospace;
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
}

:root {
  --background: #fbf7f2;
  --foreground: #3a332c;
  --card: #fffdfb;
  --card-foreground: #3a332c;
  --popover: #fffdfb;
  --popover-foreground: #3a332c;
  --primary: #f0522b;
  --primary-foreground: #ffffff;
  --secondary: #f4ede4;
  --secondary-foreground: #1a0f0a;
  --muted: #f4ede4;
  --muted-foreground: #948676;
  --accent: #fbe3da;
  --accent-foreground: #1a0f0a;
  --destructive: #ce2c2c;
  --border: rgba(26, 15, 10, 0.09);
  --input: rgba(26, 15, 10, 0.12);
  --ring: #f0522b;
  --ink: #1a0f0a;
  --chart-1: #f0522b;
  --chart-2: #2dd4c4;
  --chart-3: #2e6bff;
  --chart-4: #e8a33d;
  --chart-5: #38d08c;
  --radius: 0.75rem;
  --sidebar: #17100b;
  --sidebar-foreground: #fbf1ec;
  --sidebar-primary: #f0522b;
  --sidebar-primary-foreground: #ffffff;
  --sidebar-accent: rgba(240, 82, 43, 0.16);
  --sidebar-accent-foreground: #ff6b45;
  --sidebar-border: rgba(255, 255, 255, 0.14);
  --sidebar-ring: #f0522b;
}

@layer base {
  body {
    font-family: var(--font-sans);
    background-color: var(--background);
    color: var(--foreground);
  }
  h1, h2, h3 {
    color: var(--ink);
  }
}

@utility eyebrow {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}
```

Notes: the `.dark` block is deleted deliberately — no theme toggle exists and the dashboard is light-only per spec. Marketing/storefront pages set fonts/colors via inline styles, so the global `body` rule doesn't visibly change them; residual bleed is accepted per spec ("transitional divergence").

- [ ] **Step 6: Create `src/app/fonts.ts`**

```ts
import { Bricolage_Grotesque, Space_Grotesk, JetBrains_Mono, IBM_Plex_Sans_Arabic } from "next/font/google";

export const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-bricolage",
  display: "swap",
});

export const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-space-grotesk",
  display: "swap",
});

export const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const plexArabic = IBM_Plex_Sans_Arabic({
  subsets: ["arabic"],
  weight: ["400", "600", "700"],
  variable: "--font-plex-arabic",
  display: "swap",
});
```

- [ ] **Step 7: Wire fonts into `src/app/layout.tsx`**

Only the `<html>` line and imports change — keep the surface/manifest logic exactly as is:

```tsx
import type { Metadata } from "next";
import { headers } from "next/headers";
import { ServiceWorkerRegister } from "./sw-register";
import { bricolage, spaceGrotesk, jetbrainsMono, plexArabic } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "ServeOS",
  description: "Restaurant ordering, reservations, and WhatsApp commerce.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const surface = (await headers()).get("x-surface");
  const isStorefront = surface === "storefront";
  return (
    <html
      lang="en"
      className={`${bricolage.variable} ${spaceGrotesk.variable} ${jetbrainsMono.variable} ${plexArabic.variable}`}
    >
      <head>{isStorefront && <link rel="manifest" href="/manifest.webmanifest" />}</head>
      <body>
        {isStorefront && <ServiceWorkerRegister />}
        {children}
      </body>
    </html>
  );
}
```

- [ ] **Step 8: Create `src/components/brand/LogoMark.tsx` and `Wordmark.tsx`**

`src/components/brand/LogoMark.tsx` (geometry copied from the brand concepts' `#mk-node` symbol):

```tsx
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true" focusable="false">
      <path d="M26 32 L74 32 L50 78 Z" fill="none" stroke="currentColor" strokeWidth={6} strokeLinejoin="round" />
      <circle cx="26" cy="32" r="9" fill="currentColor" />
      <circle cx="74" cy="32" r="9" fill="currentColor" />
      <circle cx="50" cy="78" r="9" fill="currentColor" />
    </svg>
  );
}
```

`src/components/brand/Wordmark.tsx` — text inherits `currentColor`, "OS" is always coral:

```tsx
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={`font-display font-bold tracking-tight ${className ?? ""}`}>
      Serve<span className="text-primary">OS</span>
    </span>
  );
}
```

- [ ] **Step 9: Create `src/app/icon.svg` (favicon: coral mark on ink tile)**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="#17100B"/>
  <path d="M26 32 L74 32 L50 78 Z" fill="none" stroke="#F0522B" stroke-width="6" stroke-linejoin="round"/>
  <circle cx="26" cy="32" r="9" fill="#F0522B"/>
  <circle cx="74" cy="32" r="9" fill="#F0522B"/>
  <circle cx="50" cy="78" r="9" fill="#F0522B"/>
</svg>
```

- [ ] **Step 10: Create `src/app/apple-icon.tsx` (touch icon, generated PNG)**

```tsx
import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#17100B",
        }}
      >
        <svg width="120" height="120" viewBox="0 0 100 100">
          <path d="M26 32 L74 32 L50 78 Z" fill="none" stroke="#F0522B" strokeWidth={6} strokeLinejoin="round" />
          <circle cx="26" cy="32" r="9" fill="#F0522B" />
          <circle cx="74" cy="32" r="9" fill="#F0522B" />
          <circle cx="50" cy="78" r="9" fill="#F0522B" />
        </svg>
      </div>
    ),
    size,
  );
}
```

- [ ] **Step 11: Verify — typecheck, build, targeted tests**

Run: `npx tsc --noEmit` → expected: no errors.
Run: `npx next build` → expected: build succeeds (this is the mandatory foundation gate from the spec — do not proceed to Task 2 on a failed build).
Run: `npx vitest run src/lib/order-status.test.ts src/components/dashboard/nav-items.test.ts` → expected: PASS.

- [ ] **Step 12: Manual smoke check**

Run `npm run dev`, open `http://localhost:3000/login`, sign in (`slug: roma`, `owner@roma.com` / `owner1234` — seed with `npm run db:seed` if needed). Confirm: dashboard background is warm cream, text is Space Grotesk, primary buttons are coral `#F0522B`, favicon shows the ink tile with coral mark.

- [ ] **Step 13: Commit**

```bash
git add src/app/globals.css src/app/fonts.ts src/app/layout.tsx src/app/icon.svg src/app/apple-icon.tsx src/components/brand/ src/lib/order-status.ts src/lib/order-status.test.ts
git commit -m "feat(brand): ServeOS brand foundation — tokens, fonts, logo, favicon"
```

---

### Task 2: Shell + Home reskin, shared feedback components

**Files:**
- Modify: `src/app/dashboard/layout.tsx`, `src/components/dashboard/Sidebar.tsx`, `src/components/dashboard/Topbar.tsx`, `src/components/dashboard/PageHeader.tsx`, `src/app/dashboard/page.tsx`, `src/app/dashboard/error.tsx`
- Create: `src/components/dashboard/EmptyState.tsx`, `src/components/dashboard/StatusBadge.tsx`, `src/components/dashboard/ToastForm.tsx`, `src/components/dashboard/ConfirmActionButton.tsx`

**Interfaces:**
- Consumes: `LogoMark`, `Wordmark` from Task 1; existing `NavItem`, `SubmitButton`, shadcn primitives.
- Produces (page tasks rely on these exact signatures):
  - `PageHeader({ title, description?, eyebrow?, action? }: { title: string; description?: string; eyebrow?: string; action?: ReactNode })`
  - `EmptyState({ title, description?, action? }: { title: string; description?: string; action?: ReactNode })`
  - `StatusBadge({ status }: { status: OrderStatus })`
  - `ToastForm({ action, successMessage, className?, children }: { action: (formData: FormData) => Promise<void>; successMessage: string; className?: string; children: ReactNode })` — **only for server actions that do NOT redirect** (they `revalidatePath` only).
  - `ConfirmActionButton({ action, label, title, description, confirmLabel?, variant?, successMessage?, size? })` — AlertDialog-confirmed, for destructive actions; `action: () => Promise<void>` (pass pre-bound server actions).

- [ ] **Step 1: Reskin `src/app/dashboard/layout.tsx`**

Replace the wrapper div classes only (data loading unchanged):

```tsx
    <div className="min-h-screen flex bg-background text-foreground">
      <Sidebar items={items} restaurantName={tenant?.name ?? "Restaurant"} />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar userName={user.name} roleLabel={roleKeys[0] ?? "member"} pendingCount={pending} />
        <main className="flex-1 p-6 max-w-5xl w-full mx-auto">{children}</main>
      </div>
      <Toaster richColors position="top-right" />
    </div>
```

- [ ] **Step 2: Reskin `src/components/dashboard/Sidebar.tsx` (dark ink)**

```tsx
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Receipt, Utensils, Store, Image, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { LogoMark } from "@/components/brand/LogoMark";
import type { NavItem } from "./nav-items";

const ICONS: Record<string, React.ComponentType<{ className?: string; strokeWidth?: number }>> = {
  home: Home, receipt: Receipt, utensils: Utensils, store: Store, image: Image, settings: Settings,
};

export function Sidebar({ items, restaurantName }: { items: NavItem[]; restaurantName: string }) {
  const pathname = usePathname();
  return (
    <aside className="hidden md:flex md:w-60 md:flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border">
      <div className="h-16 flex items-center gap-3 px-4">
        <div className="size-9 rounded-lg bg-sidebar-primary grid place-items-center shrink-0">
          <LogoMark className="size-6 text-sidebar-primary-foreground" />
        </div>
        <span className="font-display text-lg font-bold tracking-tight">
          Serve<span className="text-sidebar-accent-foreground">OS</span>
        </span>
      </div>
      <div className="eyebrow px-4 pb-4 text-sidebar-foreground/50 truncate">{restaurantName}</div>
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
    </aside>
  );
}
```

Note: `Wordmark` isn't reused here because the sidebar's "OS" must be the brighter coral (`--sidebar-accent-foreground`) for contrast on ink, not `--primary`.

- [ ] **Step 3: Reskin `src/components/dashboard/Topbar.tsx`**

Only class changes — structure, dropdown, and sign-out form stay identical:
- `<header>`: `"h-14 flex items-center justify-end gap-3 border-b bg-card px-4"`
- Avatar span: `"size-7 rounded-full bg-secondary text-ink grid place-items-center text-xs font-semibold"`
- Pending badge span: replace `text-white` with `text-primary-foreground` (rest unchanged).

- [ ] **Step 4: Rewrite `src/components/dashboard/PageHeader.tsx` (display font + eyebrow)**

```tsx
import type { ReactNode } from "react";

export function PageHeader({
  title, description, eyebrow, action,
}: { title: string; description?: string; eyebrow?: string; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 mb-6">
      <div>
        {eyebrow && <div className="eyebrow text-primary mb-1.5">{eyebrow}</div>}
        <h1 className="font-display text-2xl font-bold tracking-tight text-ink">{title}</h1>
        {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
```

- [ ] **Step 5: Create `src/components/dashboard/EmptyState.tsx` and `StatusBadge.tsx`**

`EmptyState.tsx`:

```tsx
import type { ReactNode } from "react";
import { LogoMark } from "@/components/brand/LogoMark";

export function EmptyState({
  title, description, action,
}: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="grid place-items-center rounded-xl border border-dashed bg-card py-16 px-6 text-center">
      <LogoMark className="size-10 text-muted-foreground/40 mb-4" />
      <h3 className="font-display text-lg font-bold text-ink">{title}</h3>
      {description && <p className="text-sm text-muted-foreground mt-1 max-w-sm">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
```

`StatusBadge.tsx`:

```tsx
import { orderStatusMeta } from "@/lib/order-status";
import type { OrderStatus } from "@/server/ordering/schema";

export function StatusBadge({ status }: { status: OrderStatus }) {
  const meta = orderStatusMeta(status);
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${meta.badgeClass}`}>
      {meta.label}
    </span>
  );
}
```

- [ ] **Step 6: Create `src/components/dashboard/ToastForm.tsx` and `ConfirmActionButton.tsx`**

`ToastForm.tsx` — **only** for actions that `revalidatePath` without `redirect` (redirecting actions must use a plain `<form>`; their navigation is the feedback):

```tsx
"use client";
import type { ReactNode } from "react";
import { toast } from "sonner";

export function ToastForm({
  action, successMessage, className, children,
}: {
  action: (formData: FormData) => Promise<void>;
  successMessage: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <form
      className={className}
      action={async (formData) => {
        try {
          await action(formData);
          toast.success(successMessage);
        } catch {
          toast.error("Something went wrong. Please try again.");
        }
      }}
    >
      {children}
    </form>
  );
}
```

`ConfirmActionButton.tsx`:

```tsx
"use client";
import { useTransition } from "react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

export function ConfirmActionButton({
  action, label, title, description, confirmLabel, variant = "destructive", successMessage, size,
}: {
  action: () => Promise<void>;
  label: string;
  title: string;
  description: string;
  confirmLabel?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
  successMessage?: string;
  size?: React.ComponentProps<typeof Button>["size"];
}) {
  const [pending, startTransition] = useTransition();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant={variant} size={size} disabled={pending}>{label}</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() =>
              startTransition(async () => {
                try {
                  await action();
                  if (successMessage) toast.success(successMessage);
                } catch {
                  toast.error("Something went wrong. Please try again.");
                }
              })
            }
          >
            {confirmLabel ?? label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

- [ ] **Step 7: Home brand touches in `src/app/dashboard/page.tsx`**

Keep all data logic; change only the rendered JSX from `<PageHeader …>` down:

```tsx
  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title="Home"
        description="Your setup progress and a snapshot of recent orders."
      />

      <Card className="p-5 mb-6">
        <h2 className="eyebrow text-primary mb-3">Get set up</h2>
        <ul className="space-y-2">
          {steps.map((step) => (
            <li key={step.key}>
              <Link href={step.href} className="flex items-center gap-3 text-sm hover:underline">
                {step.done
                  ? <CheckCircle2 className="size-5 text-primary" />
                  : <Circle className="size-5 text-muted-foreground/40" />}
                <span className={step.done ? "text-muted-foreground line-through" : ""}>{step.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>

      <h2 className="eyebrow text-primary mb-3">Today's orders</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {snapshot.map((s) => (
          <Card key={s.status} className="p-4">
            <div className="font-display text-3xl font-bold text-ink">{s.count}</div>
            <div className={`inline-block mt-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${s.meta.badgeClass}`}>{s.meta.label}</div>
          </Card>
        ))}
      </div>
    </>
  );
```

- [ ] **Step 8: Brand the error boundary `src/app/dashboard/error.tsx`**

```tsx
"use client";
import { Button } from "@/components/ui/button";
import { LogoMark } from "@/components/brand/LogoMark";

export default function DashboardError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="grid place-items-center py-24 text-center">
      <div className="space-y-3">
        <LogoMark className="size-10 text-muted-foreground/40 mx-auto" />
        <h2 className="font-display text-lg font-bold text-ink">Something went wrong</h2>
        <p className="text-sm text-muted-foreground">This page failed to load. Try again.</p>
        <Button onClick={reset}>Retry</Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 9: Verify**

Run: `npx tsc --noEmit` → no errors.
Run: `npx vitest run src/components/dashboard/nav-items.test.ts src/lib/onboarding.test.ts src/lib/order-status.test.ts` → PASS (skip any of these files that don't exist).
Manual: `npm run dev`, log in; sidebar is dark ink with coral tile + active pill; Home shows eyebrows, coral checkmarks, Bricolage numbers.

- [ ] **Step 10: Commit**

```bash
git add src/app/dashboard/layout.tsx src/app/dashboard/page.tsx src/app/dashboard/error.tsx src/components/dashboard/
git commit -m "feat(brand): dark ink shell, branded Home, shared feedback components"
```

---

### Task 3: Orders list + dashboard e2e happy path

**Files:**
- Modify: `src/app/dashboard/orders/page.tsx`, `src/app/dashboard/orders/OrdersTable.tsx`
- Create: `src/app/dashboard/orders/loading.tsx`, `tests/e2e/dashboard.spec.ts`

**Interfaces:**
- Consumes: `PageHeader`, `EmptyState`, `StatusBadge`, shadcn `Table`/`Tabs`, existing `OrderRow` type (`id`, `orderNumber`, `customerName`, `fulfillmentType`, `total`, `status`, `paymentStatus`) and `/api/dashboard/orders` polling endpoint.
- Produces: nothing consumed later.

- [ ] **Step 1: Rewrite `src/app/dashboard/orders/page.tsx`**

```tsx
import { requireOrdersPermission } from "../orders-permission";
import { listOrders, toOrderRow } from "@/server/ordering/service";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { OrdersTable } from "./OrdersTable";

export default async function OrdersPage() {
  const { tenantId } = await requireOrdersPermission();
  const orders = await listOrders(tenantId, { limit: 100 });
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Orders"
        description="Live view of incoming and in-progress orders. Refreshes automatically."
      />
      <OrdersTable initial={orders.map(toOrderRow)} />
    </>
  );
}
```

- [ ] **Step 2: Rewrite `src/app/dashboard/orders/OrdersTable.tsx`**

```tsx
"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Bike, ShoppingBag } from "lucide-react";
import type { OrderRow } from "@/server/ordering/service";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

const FILTERS: Record<string, (r: OrderRow) => boolean> = {
  all: () => true,
  pending: (r) => r.status === "pending",
  preparing: (r) => r.status === "confirmed" || r.status === "preparing",
  ready: (r) => r.status === "ready" || r.status === "out_for_delivery",
};

export function OrdersTable({ initial }: { initial: OrderRow[] }) {
  const [rows, setRows] = useState<OrderRow[]>(initial);
  const [filter, setFilter] = useState<string>("all");
  const router = useRouter();
  const pendingCount = rows.filter((r) => r.status === "pending").length;

  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const res = await fetch("/api/dashboard/orders", { cache: "no-store" });
        if (res.ok) setRows(await res.json());
      } catch { /* keep polling */ }
    }, 8000);
    return () => clearInterval(id);
  }, []);

  const visible = rows.filter(FILTERS[filter] ?? FILTERS.all);

  return (
    <div className="space-y-4">
      <Tabs value={filter} onValueChange={setFilter}>
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="pending">
            Pending{pendingCount > 0 && <span className="ml-1.5 rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">{pendingCount}</span>}
          </TabsTrigger>
          <TabsTrigger value="preparing">Preparing</TabsTrigger>
          <TabsTrigger value="ready">Ready</TabsTrigger>
        </TabsList>
      </Tabs>

      {visible.length === 0 ? (
        <EmptyState
          title={filter === "all" ? "No orders yet" : "Nothing here right now"}
          description={filter === "all"
            ? "New orders from your storefront will appear here automatically."
            : "Orders in this state will appear here."}
        />
      ) : (
        <div className="rounded-xl border bg-card overflow-hidden">
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
                  <TableCell className="font-mono text-sm">{r.orderNumber}</TableCell>
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
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create `src/app/dashboard/orders/loading.tsx` (skeleton rows while the page's data resolves)**

```tsx
import { Skeleton } from "@/components/ui/skeleton";

export default function OrdersLoading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-9 w-80" />
      <div className="rounded-xl border bg-card p-4 space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create `tests/e2e/dashboard.spec.ts`**

Follows the existing e2e conventions (seeded roma tenant; run `npm run db:seed` first):

```ts
import { test, expect } from "@playwright/test";

// Requires: `npm run db:seed` (owner@roma.com / owner1234, slug roma).

test("owner can sign in and reach Orders", async ({ page }) => {
  await page.goto("/login");
  await page.getByPlaceholder("e.g. roma").fill("roma");
  await page.locator('input[name="email"]').fill("owner@roma.com");
  await page.locator('input[name="password"]').fill("owner1234");
  await page.locator('form button[type="submit"]').click();

  // Lands on the dashboard Home with the branded shell.
  // Scope to the sidebar <aside>: the topbar bell is also a link whose
  // accessible name ("Pending orders") substring-matches "Orders".
  await expect(page).toHaveURL(/\/dashboard/);
  const sidebarOrders = page.locator("aside").getByRole("link", { name: "Orders", exact: true });
  await expect(sidebarOrders).toBeVisible();

  await sidebarOrders.click();
  await expect(page.getByRole("heading", { name: "Orders" })).toBeVisible();
  // Either the table or the empty state renders — both are valid seeded states.
  await expect(page.getByRole("tab", { name: "All" })).toBeVisible();
});
```

Before writing, check the actual login submit button and password field with `grep -n "password\|type=\"submit\"" src/app/login/page.tsx` and adjust selectors to match (the page is legacy inline-style; placeholders/names above were read from source but the submit button text may differ).

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit` → no errors.
Run: `npx playwright test tests/e2e/dashboard.spec.ts` (requires seeded DB + dev server; the config starts one) → expected: 1 passed.
Manual: Orders page shows tabs, branded table, pending rows tinted coral, clicking a row opens the (still-legacy) detail page.

- [ ] **Step 6: Commit**

```bash
git add src/app/dashboard/orders/ tests/e2e/dashboard.spec.ts
git commit -m "feat(dashboard): branded Orders list with status tabs, skeleton, e2e"
```

---

### Task 4: Order detail

**Files:**
- Modify: `src/app/dashboard/orders/[id]/page.tsx`

**Interfaces:**
- Consumes: `PageHeader`, `StatusBadge`, `ToastForm`, `ConfirmActionButton`, `SubmitButton`, `Card`; existing `getOrder`, `nextStatuses(from, fulfillmentType)`, `transitionOrderAction(orderId, to, reason?)`, `markPaidAction(orderId)` — both actions revalidate without redirecting, so `ToastForm`/`ConfirmActionButton` toasts are correct here.
- Produces: nothing consumed later.

- [ ] **Step 1: Rewrite `src/app/dashboard/orders/[id]/page.tsx`**

```tsx
import Link from "next/link";
import { ArrowLeft, Bike, ShoppingBag, StickyNote } from "lucide-react";
import { requireOrdersPermission } from "../../orders-permission";
import { getOrder } from "@/server/ordering/service";
import { nextStatuses } from "@/server/ordering/state-machine";
import { transitionOrderAction, markPaidAction } from "./actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { ConfirmActionButton } from "@/components/dashboard/ConfirmActionButton";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<string, string> = {
  confirmed: "Confirm", preparing: "Start preparing", ready: "Mark ready",
  out_for_delivery: "Out for delivery", completed: "Complete",
  cancelled: "Cancel order", rejected: "Reject order",
};

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { tenantId } = await requireOrdersPermission();
  const order = await getOrder(tenantId, id);
  const actions = nextStatuses(order.status, order.fulfillmentType);
  const advance = actions.filter((to) => to !== "cancelled" && to !== "rejected");
  const danger = actions.filter((to) => to === "cancelled" || to === "rejected");

  return (
    <>
      <Link href="/dashboard/orders" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="size-4" strokeWidth={1.5} /> Orders
      </Link>
      <PageHeader
        eyebrow="Order"
        title={`#${order.orderNumber}`}
        action={<StatusBadge status={order.status} />}
      />

      <div className="grid gap-4 md:grid-cols-2 mb-4">
        <Card className="p-5">
          <h2 className="eyebrow text-primary mb-3">Customer</h2>
          <div className="text-sm space-y-1.5">
            <div className="font-medium text-ink">{order.customerName}</div>
            <div className="font-mono">{order.customerPhone}</div>
            <div className="flex items-center gap-1.5 text-muted-foreground">
              {order.fulfillmentType === "delivery"
                ? <><Bike className="size-4" strokeWidth={1.5} />Delivery — {order.deliveryAreaNameSnapshot ?? ""}{order.deliveryAddressText ? `, ${order.deliveryAddressText}` : ""}</>
                : <><ShoppingBag className="size-4" strokeWidth={1.5} />Pickup</>}
            </div>
            <div>
              Cash ·{" "}
              <span className={cn("font-medium", order.paymentStatus === "paid" ? "text-status-ready-fg" : "text-status-danger-fg")}>
                {order.paymentStatus}
              </span>
            </div>
            {order.notes && (
              <div className="flex items-start gap-1.5 text-muted-foreground">
                <StickyNote className="size-4 mt-0.5" strokeWidth={1.5} />{order.notes}
              </div>
            )}
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="eyebrow text-primary mb-3">Items</h2>
          <div className="text-sm space-y-1.5">
            {order.items.map((it) => (
              <div key={it.id} className="flex justify-between gap-2">
                <span>
                  {it.quantity}× {it.nameEn}
                  {it.selectedModifiers.length > 0 && (
                    <span className="text-muted-foreground"> ({it.selectedModifiers.map((m) => m.optionNameEn).join(", ")})</span>
                  )}
                </span>
                <span className="font-mono">{Number(it.lineTotal).toFixed(2)}</span>
              </div>
            ))}
            <div className="border-t pt-2 mt-2 space-y-1 text-muted-foreground">
              <div className="flex justify-between"><span>Subtotal</span><span className="font-mono">{Number(order.subtotal).toFixed(2)}</span></div>
              <div className="flex justify-between"><span>VAT</span><span className="font-mono">{Number(order.vatAmount).toFixed(2)}</span></div>
              <div className="flex justify-between"><span>Delivery</span><span className="font-mono">{Number(order.deliveryFee).toFixed(2)}</span></div>
              <div className="flex justify-between items-baseline text-ink pt-1">
                <span className="font-medium">Total</span>
                <span className="font-display text-xl font-bold">{Number(order.total).toFixed(2)}</span>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <div className="flex flex-wrap gap-2 mb-6">
        {advance.map((to, i) => (
          <ToastForm key={to} action={transitionOrderAction.bind(null, id, to, undefined)} successMessage={`Order marked ${to.replace(/_/g, " ")}`}>
            <SubmitButton variant={i === 0 ? "default" : "outline"}>{STATUS_LABEL[to] ?? to.replace(/_/g, " ")}</SubmitButton>
          </ToastForm>
        ))}
        {order.paymentStatus === "unpaid" && (
          <ToastForm action={markPaidAction.bind(null, id)} successMessage="Order marked paid">
            <SubmitButton variant="outline">Mark paid</SubmitButton>
          </ToastForm>
        )}
        {danger.map((to) => (
          <ConfirmActionButton
            key={to}
            action={transitionOrderAction.bind(null, id, to, "Cancelled by staff")}
            label={STATUS_LABEL[to] ?? to}
            title={`${STATUS_LABEL[to] ?? to}?`}
            description="The customer's order will be stopped. This can't be undone."
            successMessage={`Order ${to}`}
          />
        ))}
      </div>

      <h2 className="eyebrow text-primary mb-2">History</h2>
      <ul className="text-sm text-muted-foreground space-y-1">
        {order.events.map((e) => (
          <li key={e.id} className="flex gap-2">
            <span className="font-mono text-xs pt-0.5">{new Date(e.createdAt).toLocaleString()}</span>
            <span>{e.fromStatus ? `${e.fromStatus} → ` : ""}{e.toStatus}{e.reason ? ` (${e.reason})` : ""}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` → no errors.
Manual: open a seeded order; cards render; advancing status fires a success toast and the badge updates; Cancel opens the confirm dialog; Mark paid toasts.

- [ ] **Step 3: Commit**

```bash
git add "src/app/dashboard/orders/[id]/page.tsx"
git commit -m "feat(dashboard): branded order detail with state actions and confirms"
```

---

### Task 5: Menu list

**Files:**
- Modify: `src/app/dashboard/menu/page.tsx`

**Interfaces:**
- Consumes: `PageHeader`, `EmptyState`, `ConfirmActionButton`, `Card`, `Button`, `Table*`; existing `listCategories`, `listProducts`, `deleteCategoryAction(categoryId)` (revalidates, no redirect).
- Produces: nothing consumed later.

- [ ] **Step 1: Rewrite `src/app/dashboard/menu/page.tsx`**

```tsx
import Link from "next/link";
import { Plus, Pencil, ImageIcon } from "lucide-react";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { listCategories, listProducts } from "@/server/catalog/service";
import { deleteCategoryAction } from "./categories/actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { ConfirmActionButton } from "@/components/dashboard/ConfirmActionButton";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

export default async function MenuPage() {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  const cats = await listCategories(ctx.tenantId);
  const prods = await listProducts(ctx.tenantId);

  return (
    <>
      <PageHeader
        eyebrow="Catalog"
        title="Menu"
        description="Categories and products your customers can order."
        action={
          <Button asChild>
            <Link href="/dashboard/menu/categories/new"><Plus className="size-4" />New category</Link>
          </Button>
        }
      />

      {cats.length === 0 ? (
        <EmptyState
          title="No menu yet"
          description="Start with a category — like Pizzas or Drinks — then add products to it."
          action={<Button asChild><Link href="/dashboard/menu/categories/new"><Plus className="size-4" />New category</Link></Button>}
        />
      ) : (
        <div className="space-y-6">
          {cats.map((cat) => {
            const catProds = prods.filter((p) => p.categoryId === cat.id);
            return (
              <Card key={cat.id} className="p-5">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <h2 className="font-display text-lg font-bold text-ink">{cat.nameEn}</h2>
                    <div className="text-sm text-muted-foreground" dir="rtl">{cat.nameAr}</div>
                  </div>
                  <div className="flex gap-2">
                    <Button asChild variant="ghost" size="sm">
                      <Link href={`/dashboard/menu/categories/${cat.id}`}><Pencil className="size-4" />Edit</Link>
                    </Button>
                    {catProds.length === 0 && (
                      <ConfirmActionButton
                        action={deleteCategoryAction.bind(null, cat.id)}
                        label="Delete"
                        size="sm"
                        title={`Delete "${cat.nameEn}"?`}
                        description="This empty category will be removed from your menu."
                        successMessage="Category deleted"
                      />
                    )}
                  </div>
                </div>

                {catProds.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-2">No products in this category yet.</p>
                ) : (
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
                )}

                <Button asChild variant="outline" size="sm" className="mt-3">
                  <Link href={`/dashboard/menu/products/new?categoryId=${cat.id}`}><Plus className="size-4" />Add product</Link>
                </Button>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` → no errors.
Manual: Menu shows category cards, product tables with thumbs and Published/Draft pills; deleting an empty category confirms + toasts.

- [ ] **Step 3: Commit**

```bash
git add src/app/dashboard/menu/page.tsx
git commit -m "feat(dashboard): branded menu page with category cards and product tables"
```

---

### Task 6: Product + category forms

**Files:**
- Modify: `src/app/dashboard/menu/products/new/page.tsx`, `src/app/dashboard/menu/products/[id]/page.tsx`, `src/app/dashboard/menu/categories/new/page.tsx`, `src/app/dashboard/menu/categories/[id]/page.tsx`

**Interfaces:**
- Consumes: `PageHeader`, `ToastForm`, `ConfirmActionButton`, `SubmitButton`, `Card`, `Input`, `Label`; existing actions with exact signatures: `createProductAction(formData)` (redirects), `updateProductAction(id, formData)` (redirects), `deleteProductAction(id)` (redirects), `upsertModifierGroupAction(productId, formData)`, `deleteModifierGroupAction(productId, groupId)`, `upsertModifierOptionAction(productId, groupId, formData)`, `deleteModifierOptionAction(productId, optionId)` (all four revalidate only), `createCategoryAction(formData)` / `updateCategoryAction(id, formData)` (redirect).
- Produces: nothing consumed later.
- Form-field convention used on all four pages (no new component; matches shadcn Label+Input):
  `<div className="grid gap-1.5"><Label htmlFor={id}>…</Label><Input id={id} name … /></div>`
  AR inputs always get `dir="rtl"`. Redirecting forms use plain `<form action={…}>` + `SubmitButton`; revalidate-only forms use `ToastForm`.
- Native `<select>` styling class (shadcn Select is interactive-client; unnecessary here):
  `className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"`

- [ ] **Step 1: Rewrite `src/app/dashboard/menu/products/new/page.tsx`**

```tsx
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { listCategories } from "@/server/catalog/service";
import { createProductAction } from "../actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

export default async function NewProductPage({ searchParams }: { searchParams: Promise<{ categoryId?: string }> }) {
  const { categoryId } = await searchParams;
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  const cats = await listCategories(ctx.tenantId);

  return (
    <>
      <Link href="/dashboard/menu" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="size-4" strokeWidth={1.5} /> Menu
      </Link>
      <PageHeader eyebrow="Catalog" title="New product" />
      <Card className="p-5 max-w-2xl">
        <form action={createProductAction} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="categoryId">Category</Label>
            <select id="categoryId" name="categoryId" defaultValue={categoryId ?? ""} required className={selectClass}>
              <option value="">Select…</option>
              {cats.map((c) => <option key={c.id} value={c.id}>{c.nameEn}</option>)}
            </select>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="nameEn">Name (EN)</Label>
              <Input id="nameEn" name="nameEn" required />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="nameAr">Name (AR)</Label>
              <Input id="nameAr" name="nameAr" required dir="rtl" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="descriptionEn">Description (EN)</Label>
              <Input id="descriptionEn" name="descriptionEn" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="descriptionAr">Description (AR)</Label>
              <Input id="descriptionAr" name="descriptionAr" dir="rtl" />
            </div>
          </div>
          <div className="grid gap-1.5 max-w-48">
            <Label htmlFor="basePrice">Base price</Label>
            <Input id="basePrice" name="basePrice" type="number" step="0.01" min="0" required />
          </div>
          <div><SubmitButton>Create product</SubmitButton></div>
        </form>
      </Card>
    </>
  );
}
```

- [ ] **Step 2: Rewrite `src/app/dashboard/menu/products/[id]/page.tsx`**

```tsx
import Link from "next/link";
import { ArrowLeft, Plus } from "lucide-react";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { getProduct } from "@/server/catalog/service";
import {
  updateProductAction, deleteProductAction, upsertModifierGroupAction,
  deleteModifierGroupAction, upsertModifierOptionAction, deleteModifierOptionAction,
} from "../actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { ConfirmActionButton } from "@/components/dashboard/ConfirmActionButton";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  const product = await getProduct(ctx.tenantId, id);

  return (
    <>
      <Link href="/dashboard/menu" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="size-4" strokeWidth={1.5} /> Menu
      </Link>
      <PageHeader eyebrow="Catalog" title={product.nameEn} />

      <Card className="p-5 max-w-2xl mb-6">
        <form action={updateProductAction.bind(null, id)} className="grid gap-4">
          <div className="grid md:grid-cols-2 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="nameEn">Name (EN)</Label>
              <Input id="nameEn" name="nameEn" defaultValue={product.nameEn} required />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="nameAr">Name (AR)</Label>
              <Input id="nameAr" name="nameAr" defaultValue={product.nameAr} required dir="rtl" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="descriptionEn">Description (EN)</Label>
              <Input id="descriptionEn" name="descriptionEn" defaultValue={product.descriptionEn ?? ""} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="descriptionAr">Description (AR)</Label>
              <Input id="descriptionAr" name="descriptionAr" defaultValue={product.descriptionAr ?? ""} dir="rtl" />
            </div>
          </div>
          <div className="grid gap-1.5 max-w-48">
            <Label htmlFor="basePrice">Base price</Label>
            <Input id="basePrice" name="basePrice" type="number" step="0.01" min="0" defaultValue={String(product.basePrice)} required />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="isPublished" value="true" defaultChecked={product.isPublished} className="size-4 accent-(--color-primary)" />
            Published — visible on your storefront
          </label>
          <div><SubmitButton>Save changes</SubmitButton></div>
        </form>
      </Card>

      <h2 className="eyebrow text-primary mb-3">Modifier groups</h2>
      <div className="space-y-4 max-w-2xl mb-6">
        {product.modifierGroups.map((group) => (
          <Card key={group.id} className="p-5">
            <div className="flex items-start justify-between gap-3 mb-2">
              <div>
                <div className="font-medium text-ink">{group.nameEn} <span className="text-muted-foreground" dir="rtl">/ {group.nameAr}</span></div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  min {group.minSelections} · max {group.maxSelections} · {group.required ? "required" : "optional"}
                </div>
              </div>
              <ConfirmActionButton
                action={deleteModifierGroupAction.bind(null, id, group.id)}
                label="Delete group"
                size="sm"
                title={`Delete "${group.nameEn}"?`}
                description="The group and all its options will be removed from this product."
                successMessage="Group deleted"
              />
            </div>
            <ul className="text-sm divide-y">
              {group.options.map((opt) => (
                <li key={opt.id} className="py-2 flex items-center justify-between gap-2">
                  <span>{opt.nameEn} <span className="text-muted-foreground" dir="rtl">/ {opt.nameAr}</span></span>
                  <span className="flex items-center gap-3">
                    <span className="font-mono text-xs">+{Number(opt.priceDelta).toFixed(2)}</span>
                    <ToastForm action={deleteModifierOptionAction.bind(null, id, opt.id)} successMessage="Option removed">
                      <SubmitButton variant="ghost" size="sm" className="text-destructive hover:text-destructive">Remove</SubmitButton>
                    </ToastForm>
                  </span>
                </li>
              ))}
            </ul>
            <ToastForm action={upsertModifierOptionAction.bind(null, id, group.id)} successMessage="Option added" className="flex flex-wrap items-end gap-2 mt-3">
              <Input name="nameEn" placeholder="Option (EN)" required className="w-36" />
              <Input name="nameAr" placeholder="Option (AR)" dir="rtl" required className="w-36" />
              <Input name="priceDelta" type="number" step="0.01" placeholder="+ price" defaultValue="0" className="w-24" />
              <SubmitButton variant="outline" size="sm"><Plus className="size-4" />Add option</SubmitButton>
            </ToastForm>
          </Card>
        ))}

        <Card className="p-5">
          <h3 className="text-sm font-medium text-ink mb-3">Add modifier group</h3>
          <ToastForm action={upsertModifierGroupAction.bind(null, id)} successMessage="Group added" className="flex flex-wrap items-end gap-2">
            <Input name="nameEn" placeholder="Group name (EN)" required className="w-40" />
            <Input name="nameAr" placeholder="Group name (AR)" dir="rtl" required className="w-40" />
            <Input name="minSelections" type="number" defaultValue="0" min="0" className="w-20" aria-label="Min selections" />
            <Input name="maxSelections" type="number" defaultValue="1" min="1" className="w-20" aria-label="Max selections" />
            <label className="flex items-center gap-1.5 text-sm h-9">
              <input type="checkbox" name="required" value="true" className="size-4 accent-(--color-primary)" /> Required
            </label>
            <SubmitButton variant="outline" size="sm"><Plus className="size-4" />Add group</SubmitButton>
          </ToastForm>
        </Card>
      </div>

      <ConfirmActionButton
        action={deleteProductAction.bind(null, id)}
        label="Delete product"
        title={`Delete "${product.nameEn}"?`}
        description="The product and its modifiers will be removed from your menu. This can't be undone."
      />
    </>
  );
}
```

- [ ] **Step 3: Rewrite the category forms**

`src/app/dashboard/menu/categories/new/page.tsx`:

```tsx
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { createCategoryAction } from "../actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default async function NewCategoryPage() {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");

  return (
    <>
      <Link href="/dashboard/menu" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="size-4" strokeWidth={1.5} /> Menu
      </Link>
      <PageHeader eyebrow="Catalog" title="New category" />
      <Card className="p-5 max-w-2xl">
        <form action={createCategoryAction} className="grid gap-4">
          <div className="grid md:grid-cols-2 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="nameEn">Name (EN)</Label>
              <Input id="nameEn" name="nameEn" required />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="nameAr">Name (AR)</Label>
              <Input id="nameAr" name="nameAr" required dir="rtl" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="descriptionEn">Description (EN)</Label>
              <Input id="descriptionEn" name="descriptionEn" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="descriptionAr">Description (AR)</Label>
              <Input id="descriptionAr" name="descriptionAr" dir="rtl" />
            </div>
          </div>
          <div><SubmitButton>Create category</SubmitButton></div>
        </form>
      </Card>
    </>
  );
}
```

`src/app/dashboard/menu/categories/[id]/page.tsx`:

```tsx
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { listCategories } from "@/server/catalog/service";
import { updateCategoryAction } from "../actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default async function EditCategoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  const cats = await listCategories(ctx.tenantId);
  const cat = cats.find((c) => c.id === id);
  if (!cat) notFound();

  return (
    <>
      <Link href="/dashboard/menu" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="size-4" strokeWidth={1.5} /> Menu
      </Link>
      <PageHeader eyebrow="Catalog" title={cat.nameEn} />
      <Card className="p-5 max-w-2xl">
        <form action={updateCategoryAction.bind(null, id)} className="grid gap-4">
          <div className="grid md:grid-cols-2 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="nameEn">Name (EN)</Label>
              <Input id="nameEn" name="nameEn" defaultValue={cat.nameEn} required />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="nameAr">Name (AR)</Label>
              <Input id="nameAr" name="nameAr" defaultValue={cat.nameAr} required dir="rtl" />
            </div>
          </div>
          <div><SubmitButton>Save changes</SubmitButton></div>
        </form>
      </Card>
    </>
  );
}
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit` → no errors.
Manual: create a category → redirected to Menu; create a product; edit product — add a modifier group and option (toast, no navigation); delete option (toast); delete product via confirm dialog → back at Menu.

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/menu/products/ src/app/dashboard/menu/categories/
git commit -m "feat(dashboard): branded product and category forms with confirms and toasts"
```

---

### Task 7: Branches

**Files:**
- Modify: `src/app/dashboard/branches/page.tsx`, `src/app/dashboard/branches/[id]/page.tsx`

**Interfaces:**
- Consumes: `PageHeader`, `EmptyState`, `ConfirmActionButton`, `SubmitButton`, `Card`, `Input`, `Label`; existing `listBranches`, `getBranch`, `createBranchAction(formData)` (redirects), `updateBranchAction(id, formData)` (redirects), `deleteBranchAction(id)` (revalidates only).
- Produces: nothing consumed later.

- [ ] **Step 1: Rewrite `src/app/dashboard/branches/page.tsx`**

```tsx
import Link from "next/link";
import { MapPin, Phone, ChevronRight } from "lucide-react";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { listBranches } from "@/server/branches/service";
import { createBranchAction } from "./actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default async function BranchesPage() {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  const branches = await listBranches(ctx.tenantId);

  return (
    <>
      <PageHeader
        eyebrow="Locations"
        title="Branches"
        description="Your restaurant's locations. Hours and delivery areas are set per branch in Settings."
      />

      {branches.length === 0 ? (
        <EmptyState
          title="No branches yet"
          description="Add your first location below — orders and opening hours are managed per branch."
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 mb-6">
          {branches.map((b) => (
            <Link key={b.id} href={`/dashboard/branches/${b.id}`}>
              <Card className="p-5 hover:border-primary/40 transition-colors h-full">
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-1">
                    <div className="font-display font-bold text-ink">{b.name}</div>
                    {b.address && (
                      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        <MapPin className="size-4" strokeWidth={1.5} />{b.address}
                      </div>
                    )}
                    {b.phone && (
                      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        <Phone className="size-4" strokeWidth={1.5} /><span className="font-mono">{b.phone}</span>
                      </div>
                    )}
                  </div>
                  <ChevronRight className="size-4 text-muted-foreground shrink-0" strokeWidth={1.5} />
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <Card className="p-5 max-w-2xl">
        <h2 className="eyebrow text-primary mb-3">Add branch</h2>
        <form action={createBranchAction} className="grid gap-4">
          <div className="grid md:grid-cols-3 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" required />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="address">Address (optional)</Label>
              <Input id="address" name="address" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="phone">Phone (optional)</Label>
              <Input id="phone" name="phone" />
            </div>
          </div>
          <div><SubmitButton>Create branch</SubmitButton></div>
        </form>
      </Card>
    </>
  );
}
```

- [ ] **Step 2: Rewrite `src/app/dashboard/branches/[id]/page.tsx`**

```tsx
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { getBranch } from "@/server/branches/service";
import { updateBranchAction, deleteBranchAction } from "../actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { ConfirmActionButton } from "@/components/dashboard/ConfirmActionButton";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default async function EditBranchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  const branch = await getBranch(ctx.tenantId, id);

  return (
    <>
      <Link href="/dashboard/branches" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="size-4" strokeWidth={1.5} /> Branches
      </Link>
      <PageHeader eyebrow="Locations" title={branch.name} />

      <Card className="p-5 max-w-2xl mb-6">
        <form action={updateBranchAction.bind(null, id)} className="grid gap-4">
          <div className="grid md:grid-cols-3 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" defaultValue={branch.name} required />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="address">Address</Label>
              <Input id="address" name="address" defaultValue={branch.address ?? ""} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="phone">Phone</Label>
              <Input id="phone" name="phone" defaultValue={branch.phone ?? ""} />
            </div>
          </div>
          <div><SubmitButton>Save changes</SubmitButton></div>
        </form>
      </Card>

      <ConfirmActionButton
        action={deleteBranchAction.bind(null, id)}
        label="Deactivate branch"
        title={`Deactivate "${branch.name}"?`}
        description="The branch will stop appearing on your storefront and can no longer take orders."
        successMessage="Branch deactivated"
      />
    </>
  );
}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` → no errors.
Manual: branch cards render and link to detail; save redirects back; deactivate confirms + toasts.

- [ ] **Step 4: Commit**

```bash
git add src/app/dashboard/branches/
git commit -m "feat(dashboard): branded branches list and detail"
```

---

### Task 8: Fulfillment settings

**Files:**
- Modify: `src/app/dashboard/fulfillment/page.tsx`

**Interfaces:**
- Consumes: `PageHeader`, `ToastForm`, `ConfirmActionButton`, `SubmitButton`, `Card`, `Tabs*`, `Input`; existing data loaders and actions (all revalidate-only, so `ToastForm` everywhere): `setVatAction(formData)`, `setAcceptingOrdersAction(branchId, accepting)`, `setOpeningHoursAction(branchId, formData)` (field names `closed-{d}`, `open-{d}`, `close-{d}` for d 0–6 must be preserved exactly), `addAreaAction(branchId, formData)`, `deleteAreaAction(areaId)`.
- Produces: nothing consumed later.
- Layout note: the old spec imagined one global tab bar, but hours and delivery areas are per-branch data — so each branch card gets its own `Hours | Delivery areas` Tabs, with the accepting-orders "go live" toggle in the card header and VAT as a standalone card above. (Deliberate, documented deviation.)

- [ ] **Step 1: Rewrite `src/app/dashboard/fulfillment/page.tsx`**

```tsx
import { Plus } from "lucide-react";
import { requireFulfillmentPermission } from "../fulfillment-permission";
import { listBranches, listDeliveryAreasForTenant } from "@/server/branches/service";
import { getVatRate } from "@/server/tenancy/settings";
import { setAcceptingOrdersAction, setOpeningHoursAction, addAreaAction, deleteAreaAction, setVatAction } from "./actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { ConfirmActionButton } from "@/components/dashboard/ConfirmActionButton";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default async function FulfillmentPage() {
  const { tenantId } = await requireFulfillmentPermission();
  const [branches, vatRate, allAreas] = await Promise.all([
    listBranches(tenantId),
    getVatRate(tenantId),
    listDeliveryAreasForTenant(tenantId),
  ]);
  const areasByBranch = allAreas.reduce<Record<string, typeof allAreas>>((acc, a) => {
    (acc[a.branchId] ??= []).push(a);
    return acc;
  }, {});

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Ordering settings"
        description="VAT, opening hours, and delivery areas per branch."
      />

      <Card className="p-5 max-w-2xl mb-6">
        <h2 className="eyebrow text-primary mb-3">VAT</h2>
        <ToastForm action={setVatAction} successMessage="VAT rate saved" className="flex items-end gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor="vatRate">Rate (%)</Label>
            <Input id="vatRate" name="vatRate" type="number" step="0.1" min="0" defaultValue={vatRate} className="w-28" />
          </div>
          <SubmitButton variant="outline">Save</SubmitButton>
        </ToastForm>
      </Card>

      <div className="space-y-6">
        {branches.map((b) => {
          const hours = b.openingHours ?? [];
          const byDay = (d: number) => hours.find((h) => h.day === d);
          return (
            <Card key={b.id} className="p-5">
              <div className="flex items-center justify-between gap-3 mb-4">
                <h2 className="font-display text-lg font-bold text-ink">{b.name}</h2>
                <ToastForm
                  action={setAcceptingOrdersAction.bind(null, b.id, !b.acceptingOrders)}
                  successMessage={b.acceptingOrders ? "Orders paused" : "You're live — accepting orders"}
                >
                  <SubmitButton variant={b.acceptingOrders ? "outline" : "default"}>
                    <span className={`size-2 rounded-full ${b.acceptingOrders ? "bg-status-ready" : "bg-status-danger"}`} />
                    {b.acceptingOrders ? "Accepting orders — pause" : "Paused — go live"}
                  </SubmitButton>
                </ToastForm>
              </div>

              <Tabs defaultValue="hours">
                <TabsList>
                  <TabsTrigger value="hours">Hours</TabsTrigger>
                  <TabsTrigger value="areas">Delivery areas</TabsTrigger>
                </TabsList>

                <TabsContent value="hours" className="pt-3">
                  <ToastForm action={setOpeningHoursAction.bind(null, b.id)} successMessage="Hours saved">
                    <div className="grid gap-1.5">
                      {DAYS.map((name, d) => {
                        const e = byDay(d);
                        return (
                          <div key={d} className="flex items-center gap-3 text-sm">
                            <span className="eyebrow w-10">{name}</span>
                            <label className="flex items-center gap-1.5 w-20">
                              <input type="checkbox" name={`closed-${d}`} defaultChecked={e?.closed ?? false} className="size-4 accent-(--color-primary)" /> Closed
                            </label>
                            <Input type="time" name={`open-${d}`} defaultValue={e?.open ?? "10:00"} className="w-28 font-mono" />
                            <span className="text-muted-foreground">–</span>
                            <Input type="time" name={`close-${d}`} defaultValue={e?.close ?? "23:00"} className="w-28 font-mono" />
                          </div>
                        );
                      })}
                    </div>
                    <SubmitButton variant="outline" className="mt-3">Save hours</SubmitButton>
                  </ToastForm>
                </TabsContent>

                <TabsContent value="areas" className="pt-3">
                  <ul className="divide-y text-sm mb-3">
                    {(areasByBranch[b.id] ?? []).map((a) => (
                      <li key={a.id} className="py-2 flex items-center justify-between gap-2">
                        <span>
                          {a.nameEn}
                          <span className="text-muted-foreground"> — fee <span className="font-mono">{Number(a.deliveryFee).toFixed(2)}</span> · min <span className="font-mono">{Number(a.minOrderAmount).toFixed(2)}</span>{a.etaMinutes ? ` · ${a.etaMinutes}m` : ""}</span>
                        </span>
                        <ConfirmActionButton
                          action={deleteAreaAction.bind(null, a.id)}
                          label="Delete"
                          size="sm"
                          variant="ghost"
                          title={`Delete "${a.nameEn}"?`}
                          description="Customers in this area will no longer see delivery for this branch."
                          successMessage="Area deleted"
                        />
                      </li>
                    ))}
                    {(areasByBranch[b.id] ?? []).length === 0 && (
                      <li className="py-2 text-muted-foreground">No delivery areas yet — add one below.</li>
                    )}
                  </ul>
                  <ToastForm action={addAreaAction.bind(null, b.id)} successMessage="Area added" className="flex flex-wrap items-end gap-2">
                    <Input name="nameEn" placeholder="Area (EN)" required className="w-36" />
                    <Input name="nameAr" placeholder="Area (AR)" dir="rtl" required className="w-36" />
                    <Input name="deliveryFee" type="number" step="0.01" placeholder="Fee" className="w-24" />
                    <Input name="minOrderAmount" type="number" step="0.01" placeholder="Min order" className="w-28" />
                    <Input name="etaMinutes" type="number" placeholder="ETA (min)" className="w-24" />
                    <SubmitButton variant="outline" size="sm"><Plus className="size-4" />Add area</SubmitButton>
                  </ToastForm>
                </TabsContent>
              </Tabs>
            </Card>
          );
        })}
      </div>
    </>
  );
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` → no errors.
Manual: VAT saves with toast; per-branch card shows go-live toggle (state flips + toast), Hours tab saves, Delivery-areas tab adds/deletes with confirm + toast. Confirm the hours field names still round-trip (`closed-0` … `close-6`) by saving and reloading.

- [ ] **Step 3: Commit**

```bash
git add src/app/dashboard/fulfillment/page.tsx
git commit -m "feat(dashboard): branded fulfillment settings with per-branch tabs"
```

---

### Task 9: Banners + final verification

**Files:**
- Modify: `src/app/dashboard/banners/page.tsx`

**Interfaces:**
- Consumes: `PageHeader`, `EmptyState`, `ToastForm`, `ConfirmActionButton`, `SubmitButton`, `Card`, `Input`, `Label`; existing `listBanners`, `createBannerAction(formData)`, `toggleBannerAction(id, isActive)`, `deleteBannerAction(id)` (all revalidate-only).
- Produces: completed project.

- [ ] **Step 1: Rewrite `src/app/dashboard/banners/page.tsx`**

```tsx
import { Plus } from "lucide-react";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { listBanners } from "@/server/banners/service";
import { createBannerAction, toggleBannerAction, deleteBannerAction } from "./actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { ConfirmActionButton } from "@/components/dashboard/ConfirmActionButton";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default async function BannersPage() {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  const banners = await listBanners(ctx.tenantId);

  return (
    <>
      <PageHeader
        eyebrow="Storefront"
        title="Banners"
        description="Promotional images shown at the top of your storefront."
      />

      {banners.length === 0 ? (
        <EmptyState
          title="No banners yet"
          description="Add a promotional image below — it appears at the top of your storefront."
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 mb-6">
          {banners.map((b) => (
            <Card key={b.id} className="p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={b.imageUrl} alt={b.titleEn ?? ""} className="w-full h-32 rounded-lg object-cover mb-3" />
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-ink truncate">{b.titleEn ?? "Untitled banner"}</div>
                  <span className={b.isActive
                    ? "inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium bg-status-ready/15 text-status-ready-fg ring-1 ring-status-ready/30"
                    : "inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium bg-secondary text-muted-foreground"}>
                    {b.isActive ? "Active" : "Inactive"}
                  </span>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <ToastForm
                    action={toggleBannerAction.bind(null, b.id, !b.isActive)}
                    successMessage={b.isActive ? "Banner deactivated" : "Banner activated"}
                  >
                    <SubmitButton variant="outline" size="sm">{b.isActive ? "Deactivate" : "Activate"}</SubmitButton>
                  </ToastForm>
                  <ConfirmActionButton
                    action={deleteBannerAction.bind(null, b.id)}
                    label="Delete"
                    size="sm"
                    title="Delete this banner?"
                    description="It will be removed from your storefront immediately."
                    successMessage="Banner deleted"
                  />
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Card className="p-5 max-w-2xl">
        <h2 className="eyebrow text-primary mb-3">Add banner</h2>
        <ToastForm action={createBannerAction} successMessage="Banner added" className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="imageUrl">Image URL</Label>
            <Input id="imageUrl" name="imageUrl" required />
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="titleEn">Title (EN)</Label>
              <Input id="titleEn" name="titleEn" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="titleAr">Title (AR)</Label>
              <Input id="titleAr" name="titleAr" dir="rtl" />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="linkUrl">Link URL (optional)</Label>
            <Input id="linkUrl" name="linkUrl" />
          </div>
          <div><SubmitButton><Plus className="size-4" />Add banner</SubmitButton></div>
        </ToastForm>
      </Card>
    </>
  );
}
```

- [ ] **Step 2: Final full verification**

Run: `npx tsc --noEmit` → no errors.
Run: `npx next build` → build succeeds.
Run: `npx vitest run` → full suite passes (hits remote test DB; slow is normal).
Run: `npx playwright test` → existing specs + `dashboard.spec.ts` pass.
Manual sweep: visit every dashboard page against the brand concepts (`Serve OS Brand Identity Concepts/`) — dark sidebar, cream canvas, coral primaries, eyebrows, Bricolage headings, empty states, confirm dialogs, toasts.

- [ ] **Step 3: Commit**

```bash
git add src/app/dashboard/banners/page.tsx
git commit -m "feat(dashboard): branded banners page; completes brand identity rollout"
```
