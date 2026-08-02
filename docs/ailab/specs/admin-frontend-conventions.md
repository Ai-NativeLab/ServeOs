# Admin Front-End Conventions + Component Map

**Date:** 2026-07-30
**Status:** Approved
**Author:** ServeOS team

## 1. Goal

Define the single, canonical way to build admin-console pages at `/admin`, so every
future admin feature is built the same way regardless of who implements it. This
document captures the pattern already shipped in the console and standardizes it.
New admin issues reference this document in their Technical notes.

## 2. Admin page anatomy

Every admin page under `src/app/admin/(console)/` follows the same recipe:

1. A **server-component page** (`page.tsx`) that:
   - calls `await requireSuperAdminOrRedirect()` at the top to guard the route,
   - awaits its `searchParams` (a `Promise` in Next 16) to read URL-driven state,
   - calls a **platform service function** to load data,
   - calls `notFound()` for unknown ids,
   - renders with shared UI primitives.
2. A **server action** (`actions.ts`, `"use server"`) that:
   - re-checks `requireSuperAdmin()` before mutating (defense in depth),
   - calls the service function,
   - calls `revalidatePath()` so the page re-renders with fresh data.
3. **URL-driven filters** via GET forms — filter state lives in the query string,
   never in client state.

### 2.1 Page skeleton

```tsx
// src/app/admin/(console)/<feature>/page.tsx
export default async function FeaturePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireSuperAdminOrRedirect();
  const { q } = await searchParams;
  const rows = await listSomething({ search: q || undefined });

  return (
    <>
      <PageHeader title="..." eyebrow="Platform" description="..." />
      <Card>…filter form…</Card>
      <Card>…table…</Card>
    </>
  );
}
```

### 2.2 Server action skeleton

```ts
// src/app/admin/(console)/<feature>/actions.ts
"use server";
import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/server/auth/admin-context";
import { doThing } from "@/server/platform";

export async function doThingAction(id: string) {
  const admin = await requireSuperAdmin();
  await doThing(id, admin.id);
  revalidatePath("/admin/<feature>");
}
```

### 2.3 Guarding

- Every **page and layout** uses `requireSuperAdminOrRedirect()` from
  `src/server/auth/admin-context.ts` — never bare `requireSuperAdmin()`. It routes
  an *expected* auth failure somewhere useful: signed out → `/admin/login`,
  signed in without the role → `/admin/no-access`. Anything unexpected (DB outage,
  schema drift, a bug) keeps throwing so `admin/error.tsx` shows it with a digest.
  Pages call it themselves even though the layout also does — layouts and pages
  render in parallel, so the layout's redirect cannot stop a sibling page from
  throwing an unhandled render error.
- **Server actions** use bare `requireSuperAdmin()` — they need the throw, not a
  redirect (defense in depth against a stale session mutating data).
- Unknown tenant/record ids render `notFound()` (see `tenants/[id]/page.tsx`), never
  a crash.

### 2.4 Worked example — `/admin/tenants`

`src/app/admin/(console)/tenants/page.tsx`:
- reads `{ status, q }` from `searchParams`,
- calls `listTenants({ status, search })` from `@/server/platform`,
- renders a GET filter form (`Input name="q"` + `<select name="status">`) so filters
  land in the URL,
- renders a `Card` + `Table` with `Badge` status variants and an empty-state row.

## 3. Component map

### 3.1 Reusable UI primitives (`src/components/ui/`)

| Component | What it's for |
|---|---|
| `Card`, `CardContent`, `CardHeader`, `CardTitle` | Standard content container; page sections and stat tiles |
| `Table`, `TableBody`, `TableCell`, `TableHead`, `TableHeader`, `TableRow` | Tabular data; every admin list page |
| `Badge` | Small status/label pill (tenant status, plan, audit action) |
| `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | Sub-navigation within a page (tenant detail tabs) |
| `Select` | Dropdown for URL-driven filters (issue #86 audit filters) |
| `Toaster` (`sonner.tsx`) | Toast notifications, mounted once in the console layout |

### 3.2 Shared dashboard components (`src/components/dashboard/`)

| Component | What it's for |
|---|---|
| `PageHeader` | Page title block: `title`, `description`, `eyebrow`, optional `action` |
| `ConfirmActionButton` | Destructive/confirm actions behind an `AlertDialog` + toast result |
| `SubmitButton` | `Button` bound to form pending state (spinner while submitting) |

### 3.3 Admin-specific components (`src/components/admin/`)

| Component | What it's for |
|---|---|
| `AdminNav` | Client component; nav link list with active-state highlighting |
| `AdminSidebar` | Desktop left sidebar (renders `AdminNav`); `hidden md:flex` |
| `AdminTopbar` | Top bar: user dropdown + sign out |
| `nav-items.ts` | `adminNavItems()` returns the static nav array (Overview, Approvals, Billing, Tenants, Audit log) |
| `charts.tsx` | `SignupChart`, `MrrChart`, `StatusChart` — recharts wrappers for the overview page |

### 3.4 Naming conventions for new code

- Components/files: `PascalCase` (e.g. `FeatureList.tsx`).
- Server actions: `<verb>Action` (e.g. `approveAction`, `cancelSubscriptionAction`).
- Route folders: lowercase kebab under `(console)`; each has `page.tsx` and, when it
  mutates, `actions.ts`.
- Service functions: camelCase verbs (e.g. `listTenants`, `getTenantDetail`).
- Re-export new service functions through the domain barrel `src/server/<domain>/index.ts`.

## 4. "Add a new admin feature" checklist

1. Add the nav item to `src/components/admin/nav-items.ts` (`{ label, href, icon }`).
2. Create the route folder `src/app/admin/(console)/<feature>/` with a server-component
   `page.tsx` that follows §2.
3. Add `loading.tsx` (skeleton mirroring the final layout) and `error.tsx`
   (client component with `reset` retry) for the route.
4. Add the service function(s) to `src/server/platform/service.ts` and export them
   from `src/server/platform/index.ts`.
5. Add Vitest tests following `src/server/platform/service.test.ts` (seed plans with
   `seedDefaultPlans()`, create data via `registerTenant`, assert outcomes + audit rows).
6. Add server actions in `actions.ts` following §2.2 (re-check `requireSuperAdmin()`,
   call the service, `revalidatePath`).
7. Keep pages as server components; only interactive widgets are client components.

### Ticket template for new admin features

```
**Scope:** New admin route: /admin/<feature>
**User story:** As the platform super-admin, I want … , so that …
**Acceptance criteria:** (bullet list)
**Technical notes:** Files: src/app/admin/(console)/<feature>/**,
  src/server/platform/service.ts — follows docs/ailab/specs/admin-frontend-conventions.md
**Parent Epic:** #82
**Labels:** admin-console, type:story|task, size:S|M
```

## 5. Relationship to the epic

This document is the referenced pattern for the remaining child issues of Epic #82:
- #83 (mobile nav + responsive tables) — touches `AdminNav`, `AdminSidebar`, `AdminTopbar`, all `(console)` pages
- #84 (loading skeletons + error boundaries) — adds the `loading.tsx` / `error.tsx` required by the checklist
- #85 (pagination) — extends `listTenants` / `listAuditLogs` and the tenants/audit pages
- #86 (audit filters) — URL-driven GET-form filters on the audit page
- #88 (visual refresh) — restyles the shell + pages but must not change this anatomy
