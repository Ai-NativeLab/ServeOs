# Admin Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use ailab:subagent-driven-development (recommended) or ailab:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a full platform admin console (shell + overview, tenant management, approvals, billing actions, and audit log) for the single super-admin, reusing the existing UI kit and patterns.

**Architecture:** Mirror the merchant `dashboard` shell — an `admin/layout.tsx` that calls `requireSuperAdmin()` and renders a Sidebar + Topbar using the existing UI kit (`Card`, `Button`, `Table`, `Badge`, `Tabs`, `Select`, `AlertDialog`, `recharts`). Pages are server components calling service functions; mutations go through server actions that re-check auth. New platform service functions and a new `analytics/platform.ts` provide cross-tenant data.

**Tech Stack:** Next.js (App Router, server components + server actions), Drizzle ORM + PostgreSQL, recharts (already a dependency), existing shadcn-style UI kit, vitest for tests.

## Global Constraints

- Single super-admin only — reuse `requireSuperAdmin()`; no new admin RBAC or tiered roles.
- Billing = overview + actions (cancel, force trial→active, mark paid) — admin authority is the guard; admin subscription mutations BYPASS the normal `subscription/transition` `ALLOWED` map.
- Overview = counts + charts (recharts, server-rendered via a `"use client"` chart wrapper) + recent-activity feed.
- Follow existing patterns: server actions re-check `requireSuperAdmin()` and call `revalidatePath`; invalid tenant id → `notFound()`.
- New service functions get vitest unit tests following the existing `src/server/platform/service.test.ts` style (seed plans, create tenant via `registerTenant` or direct insert, assert outcomes + audit rows).

---

## File Structure

**New files**
- `src/components/admin/nav-items.ts` — `adminNavItems()` returning `NavItem[]`.
- `src/components/admin/AdminNav.tsx` — client nav (mirrors `DashboardNav`, admin icon set).
- `src/components/admin/AdminSidebar.tsx` — server wrapper around `AdminNav`.
- `src/components/admin/AdminTopbar.tsx` — client topbar with super-admin dropdown + sign out.
- `src/components/admin/charts.tsx` — `"use client"` recharts wrappers (`SignupChart`, `MrrChart`, `StatusChart`).
- `src/server/analytics/platform.ts` — cross-tenant analytics (`getPlatformSignups`, `getTenantsByStatus`, `getPlatformMrr`, `getPlatformMrrTrend`, `getTrialsEndingSoon`).
- `src/app/admin/layout.tsx` — protected admin shell.
- `src/app/admin/page.tsx` — overview (replaces the old approval queue).
- `src/app/admin/approvals/page.tsx` — pending applications queue (relocated queue).
- `src/app/admin/approvals/actions.ts` — `approveAction`, `rejectAction` (moved from `admin/actions.ts`).
- `src/app/admin/tenants/page.tsx` — tenant list (search + status filter).
- `src/app/admin/tenants/[id]/page.tsx` — tenant detail with Tabs (Overview, Billing, Audit).
- `src/app/admin/tenants/[id]/actions.ts` — billing + lifecycle server actions.
- `src/app/admin/audit/page.tsx` — audit log viewer.

**Modified files**
- `src/app/admin/actions.ts` — replace contents with `adminSignOutAction` only (approve/reject move to `approvals/actions.ts`).
- `src/server/platform/service.ts` — add `listTenants`, `getTenantDetail`, `listAuditLogs`, `activateTenant`, `cancelSubscription`, `forceSubscriptionActive`, `markSubscriptionPaid`; export `TenantRow`, `TenantDetail`, `AuditRow` types.
- `src/server/platform/index.ts` — export the new functions.
- `src/server/platform/service.test.ts` — extend with tests for new functions.
- `src/server/analytics/platform.test.ts` — new tests.

**Reused (do not modify)**
- UI kit: `Card`, `Button`, `Table`, `Badge`, `Tabs`, `Select`, `Input`, `Label`, `AlertDialog`, `Toaster` (`sonner`).
- `src/components/dashboard/ConfirmActionButton.tsx` — client confirm wrapper for destructive actions.
- `src/components/dashboard/PageHeader.tsx`, `SubmitButton.tsx`.
- `requireSuperAdmin` (`src/server/auth/admin-context.ts`), `registerTenant`, `seedDefaultPlans`, `getPlanForTenant`, `invalidateSession`, `SESSION_COOKIE`.

---

### Task 1: Admin shell, nav, layout, and sign-out

**Files:**
- Create: `src/components/admin/nav-items.ts`
- Create: `src/components/admin/AdminNav.tsx`
- Create: `src/components/admin/AdminSidebar.tsx`
- Create: `src/components/admin/AdminTopbar.tsx`
- Create: `src/app/admin/layout.tsx`
- Modify: `src/app/admin/actions.ts`

**Interfaces:**
- Consumes: `requireSuperAdmin()` → `User { name }`; `invalidateSession`, `SESSION_COOKIE`; `NavItem` type from `@/components/dashboard/nav-items`; `LogoMark` from `@/components/brand/LogoMark`; `SubmitButton` from `@/components/dashboard/SubmitButton`.
- Produces: `adminNavItems()`, `AdminSidebar`, `AdminTopbar`, `adminSignOutAction` — used by every later admin page.

- [ ] **Step 1: Create the admin nav items**

```ts
// src/components/admin/nav-items.ts
import type { NavItem } from "@/components/dashboard/nav-items";

export function adminNavItems(): NavItem[] {
  return [
    { label: "Overview", href: "/admin", icon: "overview" },
    { label: "Approvals", href: "/admin/approvals", icon: "approvals" },
    { label: "Tenants", href: "/admin/tenants", icon: "tenants" },
    { label: "Audit log", href: "/admin/audit", icon: "audit" },
  ];
}
```

- [ ] **Step 2: Create the admin nav (client)**

```tsx
// src/components/admin/AdminNav.tsx
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, ClipboardList, Store, ScrollText } from "lucide-react";
import { cn } from "@/lib/utils";
import { LogoMark } from "@/components/brand/LogoMark";
import type { NavItem } from "@/components/dashboard/nav-items";

const ICONS: Record<string, React.ComponentType<{ className?: string; strokeWidth?: number }>> = {
  overview: LayoutDashboard,
  approvals: ClipboardList,
  tenants: Store,
  audit: ScrollText,
};

export function AdminNav({ items, adminName }: { items: NavItem[]; adminName: string }) {
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
      <div className="eyebrow px-4 pb-4 text-sidebar-foreground/50 truncate">{adminName}</div>
      <nav className="flex-1 px-2 space-y-1 overflow-y-auto">
        {items.map((item) => {
          const Icon = ICONS[item.icon] ?? LayoutDashboard;
          const active = item.href === "/admin" ? pathname === "/admin" : pathname.startsWith(item.href);
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
    </div>
  );
}
```

- [ ] **Step 3: Create the sidebar (server) and topbar (client)**

```tsx
// src/components/admin/AdminSidebar.tsx
import { AdminNav } from "./AdminNav";
import type { NavItem } from "@/components/dashboard/nav-items";

export function AdminSidebar({ items, adminName }: { items: NavItem[]; adminName: string }) {
  return (
    <aside className="hidden md:flex md:w-60 md:shrink-0 md:flex-col border-r border-sidebar-border">
      <AdminNav items={items} adminName={adminName} />
    </aside>
  );
}
```

```tsx
// src/components/admin/AdminTopbar.tsx
"use client";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { adminSignOutAction } from "@/app/admin/actions";
import type { NavItem } from "@/components/dashboard/nav-items";

export function AdminTopbar({ userName, items }: { userName: string; items: NavItem[] }) {
  return (
    <header className="h-14 flex items-center justify-between gap-3 border-b bg-card px-4">
      <div className="ml-auto flex items-center gap-3">
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
              <div className="text-xs text-muted-foreground">Super admin</div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="p-0">
              <form action={adminSignOutAction} className="w-full">
                <SubmitButton variant="ghost" className="w-full justify-start px-2 h-8 font-normal">
                  Sign out
                </SubmitButton>
              </form>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
```

- [ ] **Step 4: Add `adminSignOutAction` and trim `admin/actions.ts`**

Replace `src/app/admin/actions.ts` with:

```ts
"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { invalidateSession } from "@/server/auth";
import { SESSION_COOKIE } from "@/server/auth/current-user";

export async function adminSignOutAction() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await invalidateSession(token);
  jar.delete(SESSION_COOKIE);
  redirect("/admin/login");
}
```

- [ ] **Step 5: Create the protected layout**

```tsx
// src/app/admin/layout.tsx
import { requireSuperAdmin } from "@/server/auth/admin-context";
import { adminNavItems } from "@/components/admin/nav-items";
import { AdminSidebar } from "@/components/admin/AdminSidebar";
import { AdminTopbar } from "@/components/admin/AdminTopbar";
import { Toaster } from "@/components/ui/sonner";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireSuperAdmin();
  const items = adminNavItems();
  return (
    <div className="min-h-screen flex bg-background text-foreground">
      <AdminSidebar items={items} adminName={user.name} />
      <div className="flex-1 flex flex-col min-w-0">
        <AdminTopbar userName={user.name} items={items} />
        <main className="flex-1 p-4 md:p-6 max-w-6xl w-full mx-auto">{children}</main>
      </div>
      <Toaster richColors position="top-right" />
    </div>
  );
}
```

- [ ] **Step 6: Verify build/typecheck**

Run: `cd "/Users/macbook/Desktop/Software projects/Serveos" && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/admin src/app/admin/layout.tsx src/app/admin/actions.ts
git commit -m "feat(admin): add protected shell, nav, and sign-out"
```

---

### Task 2: Platform analytics service

**Files:**
- Create: `src/server/analytics/platform.ts`
- Create: `src/server/analytics/platform.test.ts`

**Interfaces:**
- Consumes: `db` (`@/db/client`), `tenants` (`@/server/tenancy/schema`).
- Produces: `getPlatformSignups(days)`, `getTenantsByStatus()`, `getPlatformMrr()`, `getPlatformMrrTrend(days)`, `getTrialsEndingSoon(days)` — consumed by the overview page (Task 3).

- [ ] **Step 1: Write the failing test**

```ts
// src/server/analytics/platform.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "@/server/subscription";
import { registerTenant } from "@/server/onboarding/service";
import {
  getPlatformSignups, getTenantsByStatus, getPlatformMrr, getTrialsEndingSoon,
} from "./platform";

beforeAll(async () => { await seedDefaultPlans(); });

describe("platform analytics", () => {
  it("aggregates tenants by status and counts signups + mrr", async () => {
    await registerTenant({ restaurantName: "Stats Co", slug: "stats-co", country: "EG", ownerName: "S", email: "s@stats.com", password: "x", vertical: "restaurant" });

    const byStatus = await getTenantsByStatus();
    expect(byStatus.find((r) => r.status === "trial")!.count).toBeGreaterThanOrEqual(1);

    const signups = await getPlatformSignups(30);
    expect(signups.length).toBeGreaterThan(0);

    const mrr = await getPlatformMrr();
    expect(mrr).toBeGreaterThanOrEqual(0);

    const ending = await getTrialsEndingSoon(30);
    expect(ending).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/Users/macbook/Desktop/Software projects/Serveos" && npx vitest run src/server/analytics/platform.test.ts`
Expected: FAIL (module `./platform` not found).

- [ ] **Step 3: Write the implementation**

```ts
// src/server/analytics/platform.ts
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";

export type SignupPoint = { day: string; count: number };
export async function getPlatformSignups(days: number): Promise<SignupPoint[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const { rows } = await db.execute<{ day: string; count: string }>(sql`
    SELECT (created_at AT TIME ZONE 'UTC')::date AS day, COUNT(*) AS count
    FROM tenants WHERE created_at >= ${since}
    GROUP BY day ORDER BY day
  `);
  return rows.map((r) => ({ day: r.day, count: Number(r.count) }));
}

export type StatusCount = { status: string; count: number };
export async function getTenantsByStatus(): Promise<StatusCount[]> {
  const { rows } = await db.execute<{ status: string; count: string }>(sql`
    SELECT status, COUNT(*) AS count FROM tenants GROUP BY status
  `);
  return rows.map((r) => ({ status: r.status, count: Number(r.count) }));
}

export async function getPlatformMrr(): Promise<number> {
  const { rows } = await db.execute<{ mrr: string }>(sql`
    SELECT COALESCE(SUM(p.price_monthly::numeric), 0) AS mrr
    FROM subscriptions s
    JOIN plans p ON p.id = s.plan_id
    WHERE s.status IN ('active', 'trialing')
  `);
  return Number(rows[0]?.mrr ?? 0);
}

export type MrrPoint = { day: string; mrr: number };
export async function getPlatformMrrTrend(days: number): Promise<MrrPoint[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const { rows } = await db.execute<{ day: string; mrr: string }>(sql`
    SELECT d.day, COALESCE(SUM(p.price_monthly::numeric), 0) AS mrr
    FROM generate_series(${since}, now(), '1 day') AS d(day)
    LEFT JOIN subscriptions s ON s.status IN ('active','trialing') AND s.created_at <= d.day
    LEFT JOIN plans p ON p.id = s.plan_id
    GROUP BY d.day ORDER BY d.day
  `);
  return rows.map((r) => ({ day: r.day, mrr: Number(r.mrr) }));
}

export async function getTrialsEndingSoon(days: number): Promise<number> {
  const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const { rows } = await db.execute<{ count: string }>(sql`
    SELECT COUNT(*) AS count FROM subscriptions
    WHERE status = 'trialing' AND trial_ends_at IS NOT NULL AND trial_ends_at <= ${until}
  `);
  return Number(rows[0]?.count ?? 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "/Users/macbook/Desktop/Software projects/Serveos" && npx vitest run src/server/analytics/platform.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/analytics/platform.ts src/server/analytics/platform.test.ts
git commit -m "feat(analytics): add cross-tenant platform analytics"
```

---

### Task 3: Overview page (`/admin`)

**Files:**
- Create: `src/components/admin/charts.tsx`
- Create/Modify: `src/app/admin/page.tsx` (replace the old approval queue)

**Interfaces:**
- Consumes: `getPlatformSignups`, `getTenantsByStatus`, `getPlatformMrr`, `getPlatformMrrTrend`, `getTrialsEndingSoon` (Task 2); `listPendingApplications` (`@/server/platform`); `auditLogs` query via `listAuditLogs` (Task 4 — for now use a direct inline query or stub; see note).
- Produces: the live overview at `/admin`.

> Note: `listAuditLogs` is added in Task 4. For this task, render the recent-activity feed by importing `auditLogs` and ordering inline (temporary), then switch to `listAuditLogs` in Task 4. To keep tasks independent, in this task query `auditLogs` directly:
> `const recent = await db.select({...}).from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(8);`

- [ ] **Step 1: Create the charts wrapper (client)**

```tsx
// src/components/admin/charts.tsx
"use client";
import { LineChart, Line, AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function SignupChart({ data }: { data: { day: string; count: number }[] }) {
  return (
    <Card>
      <CardHeader><CardTitle>Signups (30d)</CardTitle></CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="day" tick={{ fontSize: 11 }} />
            <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
            <Tooltip />
            <Line type="monotone" dataKey="count" stroke="hsl(var(--primary))" strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

export function MrrChart({ data }: { data: { day: string; mrr: number }[] }) {
  return (
    <Card>
      <CardHeader><CardTitle>MRR trend (30d)</CardTitle></CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={data}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="day" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            <Area type="monotone" dataKey="mrr" stroke="hsl(var(--primary))" fill="hsl(var(--primary) / 0.2)" strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

export function StatusChart({ data }: { data: { status: string; count: number }[] }) {
  return (
    <Card>
      <CardHeader><CardTitle>Tenants by status</CardTitle></CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="status" tick={{ fontSize: 11 }} />
            <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
            <Tooltip />
            <Bar dataKey="count" fill="hsl(var(--primary))" />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Replace `/admin/page.tsx` with the overview**

```tsx
// src/app/admin/page.tsx
import { desc } from "drizzle-orm";
import { db } from "@/db/client";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { requireSuperAdmin } from "@/server/auth/admin-context";
import { listPendingApplications } from "@/server/platform";
import { auditLogs } from "@/server/platform/audit.schema";
import { tenants } from "@/server/tenancy/schema";
import { users } from "@/server/auth/schema";
import {
  getPlatformSignups, getTenantsByStatus, getPlatformMrr, getPlatformMrrTrend, getTrialsEndingSoon,
} from "@/server/analytics/platform";
import { SignupChart, MrrChart, StatusChart } from "@/components/admin/charts";

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="text-3xl font-bold tabular-nums text-ink">{value}</div>
        <div className="text-xs text-muted-foreground mt-1">{label}</div>
      </CardContent>
    </Card>
  );
}

export default async function AdminOverview() {
  await requireSuperAdmin();
  const [byStatus, signups, mrr, mrrTrend, trialsSoon, pending, recent] = await Promise.all([
    getTenantsByStatus(),
    getPlatformSignups(30),
    getPlatformMrr(),
    getPlatformMrrTrend(30),
    getTrialsEndingSoon(7),
    listPendingApplications(),
    db.select({
      id: auditLogs.id, action: auditLogs.action, createdAt: auditLogs.createdAt,
      tenantName: tenants.name, actor: users.name,
    })
      .from(auditLogs)
      .leftJoin(tenants, eq(auditLogs.tenantId, tenants.id))
      .leftJoin(users, eq(users.id, auditLogs.actorUserId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(8),
  ]);

  const total = byStatus.reduce((s, r) => s + r.count, 0);

  return (
    <>
      <PageHeader title="Overview" eyebrow="Platform" description="Fleet health at a glance" />
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
        <Stat label="Total tenants" value={total} />
        <Stat label="Active" value={byStatus.find((r) => r.status === "active")?.count ?? 0} />
        <Stat label="Trials" value={byStatus.find((r) => r.status === "trial")?.count ?? 0} />
        <Stat label="Suspended" value={byStatus.find((r) => r.status === "suspended")?.count ?? 0} />
        <Stat label="Pending" value={pending.length} />
        <Stat label="MRR" value={`${mrr.toLocaleString()}`} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-6">
        <SignupChart data={signups} />
        <MrrChart data={mrrTrend} />
        <StatusChart data={byStatus} />
      </div>
      <Card>
        <CardHeader><CardTitle>Recent activity</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {recent.length === 0 && <p className="text-muted-foreground">No activity yet.</p>}
          {recent.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-3">
              <span><Badge variant="outline">{r.action}</Badge> <span className="text-muted-foreground">{r.tenantName ?? "—"}</span></span>
              <span className="text-xs text-muted-foreground">{r.createdAt.toISOString().slice(0, 16).replace("T", " ")}</span>
            </div>
          ))}
          {trialsSoon > 0 && (
            <p className="text-xs text-muted-foreground pt-2">{trialsSoon} trial(s) ending in the next 7 days.</p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `cd "/Users/macbook/Desktop/Software projects/Serveos" && npx tsc --noEmit -p tsconfig.json`
Expected: no errors (note: `eq` must be imported — add `import { desc, eq } from "drizzle-orm";`).

- [ ] **Step 4: Commit**

```bash
git add src/components/admin/charts.tsx src/app/admin/page.tsx
git commit -m "feat(admin): platform overview with stats, charts, activity feed"
```

---

### Task 4: Platform service extensions (tenants, detail, audit, lifecycle, billing)

**Files:**
- Modify: `src/server/platform/service.ts`
- Modify: `src/server/platform/index.ts`
- Modify: `src/server/platform/service.test.ts`

**Interfaces:**
- Consumes: `db`, `tenants`, `subscriptions`, `plans` (`@/server/subscription/schema`), `auditLogs` (`@/server/platform/audit.schema`), `branches` (`@/server/branches/schema`), `products` (`@/server/catalog/schema`), `orders` (`@/server/ordering/schema`), `invoices` (`@/server/billing/schema`), `getPlanForTenant` (`@/server/subscription/service`).
- Produces: `listTenants({status?, search?})`, `getTenantDetail(id)`, `listAuditLogs({action?, tenantId?, limit?})`, `activateTenant(id, adminId)`, `cancelSubscription(id, adminId)`, `forceSubscriptionActive(id, adminId)`, `markSubscriptionPaid(id, adminId)` — consumed by Tasks 5–7.

- [ ] **Step 1: Write the failing test**

Append to `src/server/platform/service.test.ts`:

```ts
import { registerTenant } from "@/server/onboarding/service";
import { seedDefaultPlans, getPlanForTenant } from "@/server/subscription";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { products } from "@/server/catalog/schema";
import { orders } from "@/server/ordering/schema";
import { auditLogs } from "./audit.schema";
import {
  listTenants, getTenantDetail, listAuditLogs, activateTenant,
  cancelSubscription, forceSubscriptionActive, markSubscriptionPaid,
} from "./service";

describe("platform tenant + billing service", () => {
  beforeAll(async () => { await seedDefaultPlans(); });

  it("lists, details, audits, and admin-bills a tenant", async () => {
    const { tenantId } = await registerTenant({ restaurantName: "Admin Co", slug: "admin-co", country: "EG", ownerName: "A", email: "a@admin.com", password: "x", vertical: "restaurant" });

    const listed = await listTenants({ search: "admin-co" });
    expect(listed.find((t) => t.id === tenantId)).toBeTruthy();

    const detail = await getTenantDetail(tenantId);
    expect(detail?.tenant.slug).toBe("admin-co");
    expect(detail?.plan?.key).toBe("basic");
    expect(detail?.branchCount).toBe(0);

    const suspended = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    // suspend via existing fn then activate via new fn
    await activateTenant(tenantId, "admin-user-id");
    const after = await getTenantDetail(tenantId);
    expect(after?.tenant.status).toBe("active");

    await cancelSubscription(tenantId, "admin-user-id");
    let sub = await db.select().from(subscriptions).where(eq(subscriptions.tenantId, tenantId));
    expect(sub[0].status).toBe("canceled");

    await forceSubscriptionActive(tenantId, "admin-user-id");
    sub = await db.select().from(subscriptions).where(eq(subscriptions.tenantId, tenantId));
    expect(sub[0].status).toBe("active");

    await markSubscriptionPaid(tenantId, "admin-user-id");
    sub = await db.select().from(subscriptions).where(eq(subscriptions.tenantId, tenantId));
    expect(sub[0].status).toBe("active");

    const logs = await listAuditLogs({ tenantId });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].tenantName).toBe("Admin Co");
  });

  it("returns null for unknown tenant detail", async () => {
    expect(await getTenantDetail("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/Users/macbook/Desktop/Software projects/Serveos" && npx vitest run src/server/platform/service.test.ts`
Expected: FAIL (functions not defined).

- [ ] **Step 3: Implement the service functions**

Add to `src/server/platform/service.ts` (append imports and functions). Update the import block at top:

```ts
import { eq, and, or, ilike, desc, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { onboardingApplications } from "@/server/onboarding/schema";
import { auditLogs } from "./audit.schema";
import { subscriptions, plans, type Plan, type Subscription } from "@/server/subscription/schema";
import { getPlanForTenant } from "@/server/subscription/service";
import { branches } from "@/server/branches/schema";
import { products } from "@/server/catalog/schema";
import { orders } from "@/server/ordering/schema";
import { invoices } from "@/server/billing/schema";
```

Append these functions:

```ts
export type TenantRow = {
  id: string; slug: string; name: string; status: string; vertical: string;
  country: string; currency: string; createdAt: Date;
  planKey: string | null; planName: string | null; subscriptionStatus: string | null;
};

export async function listTenants(opts: { status?: string; search?: string } = {}): Promise<TenantRow[]> {
  const conditions = [];
  if (opts.status) conditions.push(eq(tenants.status, opts.status));
  if (opts.search) conditions.push(or(ilike(tenants.name, `%${opts.search}%`), ilike(tenants.slug, `%${opts.search}%`)));
  return db
    .select({
      id: tenants.id, slug: tenants.slug, name: tenants.name, status: tenants.status,
      vertical: tenants.vertical, country: tenants.country, currency: tenants.currency,
      createdAt: tenants.createdAt, planKey: plans.key, planName: plans.name,
      subscriptionStatus: subscriptions.status,
    })
    .from(tenants)
    .leftJoin(subscriptions, eq(subscriptions.tenantId, tenants.id))
    .leftJoin(plans, eq(plans.id, subscriptions.planId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(tenants.createdAt));
}

export type TenantDetail = {
  tenant: typeof tenants.$inferSelect;
  subscription: Subscription | null;
  plan: Plan | null;
  branchCount: number;
  productCount: number;
  publishedProductCount: number;
  orderCount: number;
};

export async function getTenantDetail(tenantId: string): Promise<TenantDetail | null> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) return null;
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.tenantId, tenantId)).limit(1);
  const plan = sub ? await getPlanForTenant(tenantId) : null;
  const [b] = await db.select({ count: sql<number>`count(*)::int` }).from(branches).where(eq(branches.tenantId, tenantId));
  const [p] = await db.select({ count: sql<number>`count(*)::int` }).from(products).where(eq(products.tenantId, tenantId));
  const [pp] = await db.select({ count: sql<number>`count(*)::int` }).from(products).where(and(eq(products.tenantId, tenantId), eq(products.isPublished, true)));
  const [o] = await db.select({ count: sql<number>`count(*)::int` }).from(orders).where(eq(orders.tenantId, tenantId));
  return {
    tenant, subscription: sub ?? null, plan,
    branchCount: b?.count ?? 0, productCount: p?.count ?? 0,
    publishedProductCount: pp?.count ?? 0, orderCount: o?.count ?? 0,
  };
}

export type AuditRow = {
  id: string; action: string; target: string | null; tenantId: string | null;
  tenantName: string | null; actorUserId: string | null; createdAt: Date;
  metadata: Record<string, unknown>;
};

export async function listAuditLogs(opts: { action?: string; tenantId?: string; limit?: number } = {}): Promise<AuditRow[]> {
  const conditions = [];
  if (opts.action) conditions.push(eq(auditLogs.action, opts.action));
  if (opts.tenantId) conditions.push(eq(auditLogs.tenantId, opts.tenantId));
  return db
    .select({
      id: auditLogs.id, action: auditLogs.action, target: auditLogs.target,
      tenantId: auditLogs.tenantId, tenantName: tenants.name,
      actorUserId: auditLogs.actorUserId, createdAt: auditLogs.createdAt,
      metadata: auditLogs.metadata,
    })
    .from(auditLogs)
    .leftJoin(tenants, eq(tenants.id, auditLogs.tenantId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(auditLogs.createdAt))
    .limit(opts.limit ?? 50);
}

async function setSubscriptionStatus(tenantId: string, status: Subscription["status"], adminUserId: string, action: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [sub] = await tx.update(subscriptions).set({ status }).where(eq(subscriptions.tenantId, tenantId)).returning();
    if (!sub) throw new Error("Subscription not found");
    await tx.insert(auditLogs).values({ tenantId, actorUserId: adminUserId, action, target: sub.id });
  });
}

export async function activateTenant(tenantId: string, adminUserId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [t] = await tx.update(tenants).set({ status: "active" }).where(eq(tenants.id, tenantId)).returning();
    if (!t) throw new Error("Tenant not found");
    await tx.insert(auditLogs).values({ tenantId, actorUserId: adminUserId, action: "tenant.activated", target: tenantId });
  });
}

export async function cancelSubscription(tenantId: string, adminUserId: string): Promise<void> {
  await setSubscriptionStatus(tenantId, "canceled", adminUserId, "tenant.subscription.canceled");
}

export async function forceSubscriptionActive(tenantId: string, adminUserId: string): Promise<void> {
  await setSubscriptionStatus(tenantId, "active", adminUserId, "tenant.subscription.forced_active");
}

export async function markSubscriptionPaid(tenantId: string, adminUserId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [inv] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.status, "open")))
      .orderBy(desc(invoices.createdAt))
      .limit(1);
    if (inv) {
      await tx.update(invoices).set({ status: "paid", method: "admin", markedBy: adminUserId, paidAt: new Date() }).where(eq(invoices.id, inv.id));
    }
    const [sub] = await tx.update(subscriptions).set({ status: "active" }).where(eq(subscriptions.tenantId, tenantId)).returning();
    if (!sub) throw new Error("Subscription not found");
    await tx.insert(auditLogs).values({ tenantId, actorUserId: adminUserId, action: "tenant.subscription.marked_paid", target: sub.id });
  });
}
```

> Note: `subscriptions`, `plans`, `invoices`, `branches`, `products`, `orders` must be added to the existing imports in `service.ts` (merge with the current `import { eq } ...` line and the `tenants`/`onboardingApplications`/`auditLogs` imports already present).

- [ ] **Step 4: Export the new functions**

In `src/server/platform/index.ts`, extend the export line:

```ts
export {
  auditLogs, type AuditLog,
  listPendingApplications, approveTenant, rejectTenant, suspendTenant,
  listTenants, getTenantDetail, listAuditLogs, activateTenant,
  cancelSubscription, forceSubscriptionActive, markSubscriptionPaid,
  type TenantRow, type TenantDetail, type AuditRow,
} from "./service";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd "/Users/macbook/Desktop/Software projects/Serveos" && npx vitest run src/server/platform/service.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/platform/service.ts src/server/platform/index.ts src/server/platform/service.test.ts
git commit -m "feat(platform): tenant list/detail, audit log, lifecycle + billing admin actions"
```

---

### Task 5: Tenants list page (`/admin/tenants`)

**Files:**
- Create: `src/app/admin/tenants/page.tsx`

**Interfaces:**
- Consumes: `listTenants` (Task 4), `requireSuperAdmin`, `PageHeader`, `Card`, `Table*`, `Badge`, `Input`, `Select` (with `searchParams` for `?status=` and `?q=`).
- Produces: the tenant table at `/admin/tenants`.

- [ ] **Step 1: Create the page**

```tsx
// src/app/admin/tenants/page.tsx
import Link from "next/link";
import { requireSuperAdmin } from "@/server/auth/admin-context";
import { listTenants } from "@/server/platform";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const STATUS_VARIANT: Record<string, React.ComponentProps<typeof Badge>["variant"]> = {
  active: "default", trial: "secondary", onboarding: "outline", suspended: "destructive", rejected: "destructive",
};

export default async function TenantsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  await requireSuperAdmin();
  const { status, q } = await searchParams;
  const rows = await listTenants({ status: status || undefined, search: q || undefined });

  return (
    <>
      <PageHeader title="Tenants" eyebrow="Platform" description="All stores on the platform" />
      <Card>
        <CardContent className="py-4 flex flex-wrap items-center gap-3">
          <form method="get" className="flex flex-wrap items-center gap-3">
            <Input name="q" defaultValue={q ?? ""} placeholder="Search name or slug" className="w-64" />
            <Select name="status" defaultValue={status ?? "all"}>
              <SelectTrigger className="w-44"><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="trial">Trial</SelectItem>
                <SelectItem value="onboarding">Onboarding</SelectItem>
                <SelectItem value="suspended">Suspended</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
              </SelectContent>
            </Select>
            <button type="submit" className="text-sm px-3 py-2 rounded-md bg-primary text-primary-foreground">Filter</button>
          </form>
        </CardContent>
      </Card>
      <Card className="mt-3">
        <CardContent className="pt-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>Vertical</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Created</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.name}</TableCell>
                  <TableCell>{t.slug}</TableCell>
                  <TableCell className="capitalize">{t.vertical}</TableCell>
                  <TableCell><Badge variant={STATUS_VARIANT[t.status] ?? "outline"}>{t.status}</Badge></TableCell>
                  <TableCell>{t.planName ?? "—"}</TableCell>
                  <TableCell>{t.createdAt.toISOString().slice(0, 10)}</TableCell>
                  <TableCell className="text-right">
                    <Link href={`/admin/tenants/${t.id}`} className="text-sm text-primary hover:underline">View</Link>
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-6">No tenants found.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd "/Users/macbook/Desktop/Software projects/Serveos" && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/admin/tenants/page.tsx
git commit -m "feat(admin): tenant list with search and status filter"
```

---

### Task 6: Tenant detail page — Overview + Audit tabs

**Files:**
- Create: `src/app/admin/tenants/[id]/page.tsx`

**Interfaces:**
- Consumes: `getTenantDetail`, `listAuditLogs` (Task 4), `requireSuperAdmin`, `notFound`, `PageHeader`, `Card*`, `Badge`, `Tabs*`.
- Produces: the detail page at `/admin/tenants/[id]` (Billing tab added in Task 7).

- [ ] **Step 1: Create the detail page**

```tsx
// src/app/admin/tenants/[id]/page.tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSuperAdmin } from "@/server/auth/admin-context";
import { getTenantDetail, listAuditLogs } from "@/server/platform";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default async function TenantDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSuperAdmin();
  const { id } = await params;
  const detail = await getTenantDetail(id);
  if (!detail) notFound();
  const { tenant, plan, subscription, branchCount, productCount, publishedProductCount, orderCount } = detail;
  const audit = await listAuditLogs({ tenantId: id, limit: 25 });

  return (
    <>
      <PageHeader
        eyebrow={tenant.vertical}
        title={tenant.name}
        description={`${tenant.slug} · ${tenant.country}`}
        action={<Link href="/admin/tenants" className="text-sm text-primary hover:underline">← All tenants</Link>}
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <Badge variant={tenant.status === "active" ? "default" : tenant.status === "suspended" ? "destructive" : "outline"}>{tenant.status}</Badge>
        {plan && <Badge variant="secondary">{plan.name}</Badge>}
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="billing">Billing</TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card><CardContent className="py-4"><div className="text-2xl font-bold">{branchCount}</div><div className="text-xs text-muted-foreground">Branches</div></CardContent></Card>
            <Card><CardContent className="py-4"><div className="text-2xl font-bold">{publishedProductCount}/{productCount}</div><div className="text-xs text-muted-foreground">Published products</div></CardContent></Card>
            <Card><CardContent className="py-4"><div className="text-2xl font-bold">{orderCount}</div><div className="text-xs text-muted-foreground">Orders</div></CardContent></Card>
            <Card><CardContent className="py-4"><div className="text-2xl font-bold">{tenant.currency}</div><div className="text-xs text-muted-foreground">Currency</div></CardContent></Card>
          </div>
          <Card className="mt-3">
            <CardHeader><CardTitle>Profile</CardTitle></CardHeader>
            <CardContent className="text-sm space-y-1">
              <div><span className="text-muted-foreground">Tagline:</span> {tenant.tagline ?? "—"}</div>
              <div><span className="text-muted-foreground">Timezone:</span> {tenant.timezone}</div>
              <div><span className="text-muted-foreground">Created:</span> {tenant.createdAt.toISOString().slice(0, 10)}</div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="audit">
          <Card>
            <CardHeader><CardTitle>Audit trail</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              {audit.length === 0 && <p className="text-muted-foreground">No audit events.</p>}
              {audit.map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-3">
                  <span><Badge variant="outline">{a.action}</Badge></span>
                  <span className="text-xs text-muted-foreground">{a.createdAt.toISOString().slice(0, 16).replace("T", " ")}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd "/Users/macbook/Desktop/Software projects/Serveos" && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/admin/tenants/\[id\]/page.tsx
git commit -m "feat(admin): tenant detail with overview and audit tabs"
```

---

### Task 7: Tenant detail — Billing tab with admin actions

**Files:**
- Create: `src/app/admin/tenants/[id]/actions.ts`
- Modify: `src/app/admin/tenants/[id]/page.tsx` (add `billing` TabsContent)

**Interfaces:**
- Consumes: `requireSuperAdmin`, `cancelSubscription`, `forceSubscriptionActive`, `markSubscriptionPaid`, `suspendTenant` (Task 4 + existing), `getTenantDetail` (Task 4), `ConfirmActionButton` (`@/components/dashboard/ConfirmActionButton`), `revalidatePath`.
- Produces: Billing tab UI + working destructive actions.

- [ ] **Step 1: Create the billing server actions**

```ts
// src/app/admin/tenants/[id]/actions.ts
"use server";
import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/server/auth/admin-context";
import { cancelSubscription, forceSubscriptionActive, markSubscriptionPaid, suspendTenant } from "@/server/platform";

async function withAdmin(tenantId: string, fn: (adminId: string) => Promise<void>): Promise<void> {
  const admin = await requireSuperAdmin();
  await fn(admin.id);
  revalidatePath(`/admin/tenants/${tenantId}`);
}

export async function cancelSubscriptionAction(tenantId: string) {
  await withAdmin(tenantId, (adminId) => cancelSubscription(tenantId, adminId));
}

export async function forceActiveAction(tenantId: string) {
  await withAdmin(tenantId, (adminId) => forceSubscriptionActive(tenantId, adminId));
}

export async function markPaidAction(tenantId: string) {
  await withAdmin(tenantId, (adminId) => markSubscriptionPaid(tenantId, adminId));
}

export async function suspendTenantAction(tenantId: string) {
  await withAdmin(tenantId, (adminId) => suspendTenant(tenantId, adminId));
}
```

- [ ] **Step 2: Add the Billing `TabsContent` to the detail page**

In `src/app/admin/tenants/[id]/page.tsx`, add imports:

```tsx
import { ConfirmActionButton } from "@/components/dashboard/ConfirmActionButton";
import { cancelSubscriptionAction, forceActiveAction, markPaidAction, suspendTenantAction } from "./actions";
```

And add this `TabsContent` after the `audit` one (inside the same `<Tabs>`):

```tsx
<TabsContent value="billing">
  <Card>
    <CardHeader><CardTitle>Subscription & billing</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <div className="text-sm space-y-1">
        <div><span className="text-muted-foreground">Plan:</span> {plan ? `${plan.name} (${plan.priceMonthly} ${plan.currency}/mo)` : "—"}</div>
        <div><span className="text-muted-foreground">Subscription status:</span> <Badge variant="outline">{subscription?.status ?? "none"}</Badge></div>
        <div><span className="text-muted-foreground">Trial ends:</span> {subscription?.trialEndsAt ? subscription.trialEndsAt.toISOString().slice(0, 10) : "—"}</div>
      </div>
      <div className="flex flex-wrap gap-2">
        <ConfirmActionButton
          action={() => forceActiveAction(id)}
          label="Force active"
          title="Force subscription active"
          description="Set this tenant's subscription to active regardless of trial state."
          confirmLabel="Force active"
          variant="default"
          successMessage="Subscription set to active"
        />
        <ConfirmActionButton
          action={() => markPaidAction(id)}
          label="Mark paid"
          title="Mark as paid"
          description="Mark the latest open invoice paid and activate the subscription."
          confirmLabel="Mark paid"
          variant="default"
          successMessage="Marked paid"
        />
        <ConfirmActionButton
          action={() => cancelSubscriptionAction(id)}
          label="Cancel subscription"
          title="Cancel subscription"
          description="Cancel this tenant's subscription immediately."
          confirmLabel="Cancel"
          variant="destructive"
          successMessage="Subscription canceled"
        />
        <ConfirmActionButton
          action={() => suspendTenantAction(id)}
          label="Suspend tenant"
          title="Suspend tenant"
          description="Suspend this tenant. The storefront will stop serving."
          confirmLabel="Suspend"
          variant="destructive"
          successMessage="Tenant suspended"
        />
      </div>
    </CardContent>
  </Card>
</TabsContent>
```

- [ ] **Step 3: Typecheck**

Run: `cd "/Users/macbook/Desktop/Software projects/Serveos" && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/admin/tenants/\[id\]/actions.ts src/app/admin/tenants/\[id\]/page.tsx
git commit -m "feat(admin): tenant billing tab with admin subscription actions"
```

---

### Task 8: Approvals queue + audit log page

**Files:**
- Create: `src/app/admin/approvals/page.tsx`
- Create: `src/app/admin/approvals/actions.ts`
- Create: `src/app/admin/audit/page.tsx`
- Modify: `src/app/admin/page.tsx` (already replaced in Task 3 — no change needed; the old queue is gone)
- Modify (remove duplication): ensure `src/app/admin/actions.ts` no longer exports `approveAction`/`rejectAction` (done in Task 1).

**Interfaces:**
- Consumes: `listPendingApplications`, `approveTenant`, `rejectTenant` (existing platform service); `listAuditLogs` (Task 4); `requireSuperAdmin`, `PageHeader`, `Card*`, `Table*`, `Badge`, `Input`, `Select`, `ConfirmActionButton`/`SubmitButton`.
- Produces: `/admin/approvals` (relocated queue) and `/admin/audit`.

- [ ] **Step 1: Create approvals actions**

```ts
// src/app/admin/approvals/actions.ts
"use server";
import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/server/auth/admin-context";
import { approveTenant, rejectTenant } from "@/server/platform";

export async function approveAction(formData: FormData) {
  const admin = await requireSuperAdmin();
  await approveTenant(String(formData.get("tenantId")), admin.id);
  revalidatePath("/admin/approvals");
}

export async function rejectAction(formData: FormData) {
  const admin = await requireSuperAdmin();
  await rejectTenant(String(formData.get("tenantId")), admin.id, String(formData.get("notes") ?? ""));
  revalidatePath("/admin/approvals");
}
```

- [ ] **Step 2: Create the approvals page**

```tsx
// src/app/admin/approvals/page.tsx
import { requireSuperAdmin } from "@/server/auth/admin-context";
import { listPendingApplications } from "@/server/platform";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { approveAction, rejectAction } from "./actions";

export default async function ApprovalsPage() {
  await requireSuperAdmin();
  const pending = await listPendingApplications();

  return (
    <>
      <PageHeader title="Approvals" eyebrow="Platform" description="Pending store applications" />
      <Card>
        <CardContent className="pt-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Store</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>Country</TableHead>
                <TableHead>Submitted</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pending.map((p) => (
                <TableRow key={p.applicationId}>
                  <TableCell className="font-medium">{p.tenantName}</TableCell>
                  <TableCell>{p.slug}</TableCell>
                  <TableCell>{p.country}</TableCell>
                  <TableCell>{p.submittedAt ? p.submittedAt.toISOString().slice(0, 10) : "—"}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <form action={approveAction}>
                        <input type="hidden" name="tenantId" value={p.tenantId} />
                        <SubmitButton size="sm">Approve</SubmitButton>
                      </form>
                      <form action={rejectAction}>
                        <input type="hidden" name="tenantId" value={p.tenantId} />
                        <input name="notes" placeholder="Reason" className="h-8 rounded-md border border-input px-2 text-sm" />
                        <SubmitButton size="sm" variant="outline">Reject</SubmitButton>
                      </form>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {pending.length === 0 && (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-6">No pending applications.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
```

- [ ] **Step 3: Create the audit log page**

```tsx
// src/app/admin/audit/page.tsx
import { requireSuperAdmin } from "@/server/auth/admin-context";
import { listAuditLogs } from "@/server/platform";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string }>;
}) {
  await requireSuperAdmin();
  const { action } = await searchParams;
  const rows = await listAuditLogs({ action: action || undefined, limit: 100 });

  return (
    <>
      <PageHeader title="Audit log" eyebrow="Platform" description="All platform actions" />
      <Card>
        <CardContent className="pt-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Tenant</TableHead>
                <TableHead>Target</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>{a.createdAt.toISOString().slice(0, 16).replace("T", " ")}</TableCell>
                  <TableCell><Badge variant="outline">{a.action}</Badge></TableCell>
                  <TableCell>{a.tenantName ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs">{a.target ?? "—"}</TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground py-6">No events.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `cd "/Users/macbook/Desktop/Software projects/Serveos" && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/admin/approvals src/app/admin/audit
git commit -m "feat(admin): approvals queue and audit log viewer"
```

---

## Self-review notes (already applied)

- Spec coverage: overview+charts+activity (Task 3), approvals (Task 8), tenant list (Task 5), tenant detail Overview+Audit (Task 6), Billing overview+actions (Task 7), audit viewer (Task 8), service functions (Task 4), analytics (Task 2), shell+auth (Task 1). All spec sections mapped.
- No placeholders — every step has concrete code or exact commands.
- Type consistency: `TenantRow`, `TenantDetail`, `AuditRow` defined in Task 4 and used in Tasks 5–7; `adminNavItems`/`AdminSidebar`/`AdminTopbar` defined Task 1 and used in layout; billing action names (`cancelSubscriptionAction`, etc.) match between `actions.ts` (Task 7) and the page.
- `eq` is imported where needed (Tasks 3, 4); `subscriptions`/`plans`/`invoices`/`branches`/`products`/`orders` imported in `service.ts` (Task 4).
