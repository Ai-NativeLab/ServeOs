# Admin Console — Design Spec

**Date:** 2026-07-13
**Status:** Approved (design)
**Author:** OpenCode (with user)

## 1. Goal

Build a full platform admin console at `/admin` for the single super-admin. It replaces the current minimal admin experience (a bare login page + a single "Pending restaurants" approval queue) with a proper, shelled dashboard that covers platform overview, tenant management, the approval workflow, billing/subscription oversight with actions, and an audit log viewer.

Constraints agreed with the user:
- **Single super-admin only.** Reuse the existing `requireSuperAdmin()` — no new admin RBAC or tiered roles.
- **Billing = overview + actions.** Admin can view subscription state and perform actions (cancel, force trial→active, mark paid), not just read.
- **Overview = counts + charts.** Stat cards plus recharts visualizations and a recent-activity feed.

## 2. Current State (what exists today)

- `src/app/admin/login/page.tsx` — standalone login (inline-styled, not using the shared UI kit).
- `src/app/admin/page.tsx` — single "Pending restaurants" queue with Approve/Reject `<form>` actions.
- `src/app/admin/actions.ts` — `approveAction`, `rejectAction` server actions.
- `src/app/admin/login/actions.ts` — `adminLoginAction`.
- `src/server/auth/admin-context.ts` — `requireSuperAdmin()` (throws if not signed in or not `super_admin`).
- `src/server/platform/service.ts` — `listPendingApplications`, `approveTenant`, `rejectTenant`, `suspendTenant`.
- `src/server/platform/audit.schema.ts` — `auditLogs` table.
- `src/server/subscription/service.ts` — `transition(subId, next)` enforces an `ALLOWED` transition map (admin overrides need a separate bypass path).
- `src/server/analytics/service.ts` — tenant-scoped analytics (revenue trend, top products, etc.). No cross-tenant/platform analytics yet.
- `recharts` is already a dependency.
- The merchant `src/app/dashboard/layout.tsx` uses a `Sidebar` + `Topbar` shell with `dashboardNavItems(roleKeys)`. The admin side will mirror this pattern.

## 3. Architecture

Mirror the merchant dashboard shell. Add `src/app/admin/layout.tsx` that:
- Calls `requireSuperAdmin()` (so every nested admin route is protected — replaces the per-page try/catch+redirect).
- Renders a `Sidebar` + `Topbar` shell reusing the existing UI kit.
- Wraps children in `<main>` and includes the `Toaster`.

Pages are **server components** that call service functions directly; mutations go through **server actions** that re-check `requireSuperAdmin()` and `revalidatePath`. This is exactly the pattern already used by `approveAction`.

### New shared admin components (`src/components/admin/`)
- `Sidebar.tsx` — hardcoded to the approved nav items (Overview, Approvals, Tenants, Audit). Reuses `nav-items` style.
- `Topbar.tsx` — shows the super-admin name + a "Sign out" affordance (optional; can be a link to a logout action).
- `adminNavItems.ts` — array of `{ href, label, icon }` (mirrors `dashboardNavItems` but static, no role gating needed).

Reused existing UI kit (no new primitives): `Card`, `Button`, `Table`, `Badge`, `Tabs`, `Select`, `Input`, `Label`, `AlertDialog` (for destructive confirm), `StatusBadge` (merchant one can be reused or a small admin variant).

### Routes / modules

| Route | Purpose | Key data |
|-------|---------|----------|
| `/admin` | Overview / home | Stat cards + charts + recent activity |
| `/admin/approvals` | Pending application queue | `listPendingApplications` |
| `/admin/tenants` | All-tenant list (search + status filter) | `listTenants` |
| `/admin/tenants/[id]` | Tenant detail (Tabs) | `getTenantDetail` + per-tenant audit |
| `/admin/audit` | Audit log viewer (filters) | `listAuditLogs` |

#### 3.1 `/admin` — Overview
- **Stat cards:** total tenants, active, trials, suspended, pending approvals, platform MRR (sum of active plan `priceMonthly`), trials ending within 7 days.
- **Charts (recharts, server-rendered):**
  - Signups over time (line) — `getPlatformSignups(days)`.
  - MRR trend (area/line) — `getPlatformMrrTrend(days)`.
  - Tenants by status (bar) — `getTenantsByStatus()`.
- **Recent activity feed:** latest N rows from `auditLogs` (action, tenant, actor, time).

#### 3.2 `/admin/approvals`
- Table of pending `onboardingApplications`: tenant name, slug, country, submittedAt.
- Actions per row: **Approve**, **Reject** (with a notes field). Reuse `approveTenant` / `rejectTenant`.
- This replaces the current `/admin` queue (the overview moves to `/admin`; the approval queue becomes its own page). Keep `approveAction`/`rejectAction` working or relocate them into the new page's actions file.

#### 3.3 `/admin/tenants`
- Searchable (name/slug) + status-filterable table.
- Columns: name, slug, vertical, status `Badge`, plan, createdAt, row action "View".
- Backed by new `listTenants({ status?, search? })`.

#### 3.4 `/admin/tenants/[id]` — Detail (Tabs)
- **Overview tab:** branding/contact (name, slug, logo/cover, tagline, country, currency, timezone), and counts (branches, published products, orders).
- **Billing tab:** plan name + `priceMonthly`, subscription status, `trialEndsAt`, computed MRR. Admin actions (each behind `AlertDialog` confirm, each a server action re-checking `requireSuperAdmin`):
  - `cancelSubscription(tenantId, adminId)` — force subscription → `canceled`.
  - `forceSubscriptionActive(tenantId, adminId)` — force subscription → `active` (e.g., flip a trial to paid/live).
  - `markSubscriptionPaid(tenantId, adminId)` — mark an open invoice paid (reuses `billing/manual-provider` logic if applicable) and/or set subscription active.
- **Danger zone:** `suspendTenant` (exists) and a new `activateTenant(tenantId, adminId)` that sets status back to `active` (or `trial` if still in trial window — keep simple: set `active`).
- **Audit tab:** per-tenant `auditLogs`.

#### 3.5 `/admin/audit`
- Filterable `auditLogs` table: by `action` (select), by `tenant` (optional), by date range (optional). Columns: time, actor, action, target, tenant.

## 4. Server layer additions

### `src/server/platform/service.ts` (extend)
- `listTenants({ status?, search? })` → tenants joined with their subscription/plan for the plan column.
- `getTenantDetail(id)` → `{ tenant, subscription, plan, branchCount, productCount, orderCount }`. Returns `null` if not found (page calls `notFound()`).
- `listAuditLogs({ action?, tenantId?, limit? })` → ordered by time desc.
- `activateTenant(tenantId, adminId)` → set status `active` + audit row.
- Admin billing actions (these **bypass** the normal `subscription/transition` `ALLOWED` map because the super-admin is the authority):
  - `cancelSubscription(tenantId, adminId)`
  - `forceSubscriptionActive(tenantId, adminId)`
  - `markSubscriptionPaid(tenantId, adminId)` (reuse `billing/manual-provider` "mark paid" where possible; otherwise set subscription active and write an audit row).
  - Each writes an `auditLogs` row (`tenant.subscription.*`).

### `src/server/analytics/platform.ts` (new)
Cross-tenant equivalents of `analytics/service.ts`:
- `getPlatformSignups(days)` — tenants created per day.
- `getPlatformMrrTrend(days)` — sum of active plans' `priceMonthly` per day (snapshot-based; simple daily sum is acceptable for v1).
- `getTenantsByStatus()` — count per `tenant.status`.
- `getPlatformMrr()` — current sum of `priceMonthly` across active/trial subscriptions.

### Auth / guards
- `admin/layout.tsx` calls `requireSuperAdmin()` once.
- Every server action re-invokes `requireSuperAdmin()` before mutating (defense in depth).
- Invalid/unknown tenant id → `notFound()`.

## 5. Data flow (example: Billing action)
1. Admin clicks "Cancel subscription" → `AlertDialog` confirm.
2. Server action `cancelSubscriptionAction(formData)` runs: `requireSuperAdmin()` → `cancelSubscription(tenantId, admin.id)` (writes audit) → `revalidatePath('/admin/tenants/[id]')`.
3. Page re-renders with updated subscription status + new audit entry.

## 6. Error handling
- Auth failures throw → layout redirects to `/admin/login` (existing behavior preserved).
- `notFound()` for missing tenant / unknown audit filters.
- Destructive actions confirmed via `AlertDialog`.
- Service functions validate inputs (e.g., tenant exists before mutating).

## 7. Testing
- Unit tests for new `platform/service.ts` functions (`listTenants`, `getTenantDetail`, `listAuditLogs`, `activateTenant`, billing actions) following the existing `service.test.ts` style (seed plans, create tenant via `registerTenant` or direct insert, assert outcomes + audit rows).
- Unit tests for new `analytics/platform.ts` queries.
- Light/optional: render check for the overview page stat cards. No heavy E2E required for v1.

## 8. Out of scope (v1)
- Tiered admin roles / RBAC beyond `super_admin`.
- Editing tenant data from admin (only suspend/activate + billing actions).
- Real-time updates / websockets.
- Invoicing UI beyond "mark paid".

## 9. Implementation order (suggested)
1. `admin/layout.tsx` + `components/admin/*` (shell + nav) + protect routes.
2. `analytics/platform.ts` + overview page (`/admin`).
3. `platform/service.ts`: `listTenants`, `getTenantDetail`, `listAuditLogs`, `activateTenant`.
4. `/admin/tenants` list + `/admin/tenants/[id]` detail (Overview + Audit tabs).
5. Billing actions + Billing tab (AlertDialog-confirmed).
6. `/admin/approvals` (relocate existing queue) + `/admin/audit`.
7. Tests throughout.
