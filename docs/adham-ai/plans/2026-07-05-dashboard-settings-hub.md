# Dashboard Settings Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use ailab:subagent-driven-development (recommended) or ailab:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the dashboard's "Settings" nav item (currently just Fulfillment) into a real multi-section hub — Business Profile, WhatsApp click-to-chat, Fulfillment (relocated), Staff, and Billing/Plan — each gated by existing RBAC permissions, plus one small customer-facing WhatsApp button on the order confirmation page.

**Architecture:** A new `src/app/dashboard/settings/` route group with a shared tab-bar layout; each tab is its own route + `page.tsx` + `actions.ts`, following the codebase's existing per-feature-folder convention (`menu/products/`, `menu/categories/`). No new database tables — WhatsApp number and plan-upgrade requests reuse the existing `tenant_settings` JSONB bag (same pattern as the existing `vatRate`); Business Profile edits existing `tenants` columns; Staff reuses existing `users`/`roles`/`user_roles` tables.

**Tech Stack:** Next.js 16.2.9 (App Router, React 19), Tailwind CSS v4, shadcn/ui (vendored in `src/components/ui/`), Drizzle ORM + Postgres, vitest, Playwright.

**Spec:** `docs/adham-ai/specs/2026-07-05-dashboard-settings-hub-design.md` (authoritative for all decisions below).

## Global Constraints

- **No schema migrations.** Every new field reuses existing columns/JSONB — do not run `drizzle-kit generate` or touch `drizzle/`.
- **RBAC permissions (verbatim, no new permissions):** Business Profile → `tenant:manage` (owner only). WhatsApp → `fulfillment:manage` (owner, manager). Fulfillment → `fulfillment:manage` (unchanged). Staff → `staff:invite` (owner, manager). Billing/Plan → `billing:manage` (owner only).
- **WhatsApp mechanism is click-to-chat only** (`wa.me` link) — no Business API, no plan-gating, works on every plan.
- **Staff creation is direct** (name + email/phone + temp password + role, created immediately) — no email invite links, no new email infrastructure.
- **Native `<select>` for form selects**, not the shadcn `Select` component — this codebase's forms submit via server actions reading `FormData`, and the existing convention (`src/app/dashboard/menu/products/new/page.tsx`) uses a plain `<select>` with a shared Tailwind class string for exactly this reason (Radix `Select` doesn't populate `FormData` without extra wiring).
- **Dashboard chrome is English-only**; `DomainError.messageFor()` calls in this plan use `"en"`.
- **Verification commands:** `npx tsc --noEmit` (typecheck), `npx next build` (build). Run targeted `npx vitest run <file>` per task; run the full `npx vitest run` suite only in the final task (it hits a remote test DB and is slow).
- All work happens on `main` (project convention: direct commits, conventional-commit messages, no PR).
- This is **NOT the Next.js you know** (per `AGENTS.md`) — this plan doesn't touch fonts, icons, or routing conventions, so no doc lookup is required for it.

## File Structure

```
src/server/tenancy/settings.ts                 (mod) whatsapp number + upgrade-request fields/functions, shared merge helper
src/server/tenancy/settings.test.ts            (mod) new tests
src/server/tenancy/errors.ts                   (new) InvalidWhatsappNumberError
src/server/tenancy/errors.test.ts              (new)
src/server/tenancy/service.ts                  (mod) updateTenantProfile
src/server/tenancy/service.test.ts             (mod) new tests
src/server/tenancy/index.ts                    (mod) new exports
src/lib/errors-client.ts                       (new) toastMessageFor — surfaces DomainError messages in toasts
src/lib/errors-client.test.ts                  (new)
src/lib/whatsapp.ts                            (new) buildOrderWhatsappMessage, whatsappChatLink
src/lib/whatsapp.test.ts                       (new)
src/server/auth/errors.ts                      (new) StaffContactTakenError
src/server/auth/errors.test.ts                 (new)
src/server/auth/staff.ts                       (new) createStaff, listStaff, setStaffRole, deactivateStaff
src/server/auth/staff.test.ts                  (new)
src/server/ordering/service.ts                 (mod) ordersThisMonthCount
src/server/ordering/orders.test.ts             (mod) new test
src/server/subscription/service.ts             (mod) listPlans
src/server/subscription/service.test.ts        (mod) new test
src/server/subscription/index.ts               (mod) new export
src/server/billing/service.ts                  (new) listInvoicesForTenant
src/server/billing/service.test.ts             (new)

src/components/dashboard/nav-items.ts          (mod) Settings href → /dashboard/settings
src/components/dashboard/nav-items.test.ts     (mod) href assertion
src/components/dashboard/ToastForm.tsx         (mod) use toastMessageFor for error toasts

src/app/dashboard/settings/tabs.ts                     (new) tab definitions + visibleSettingsTabs
src/app/dashboard/settings/SettingsTabs.tsx            (new) route-based tab bar
src/app/dashboard/settings/layout.tsx                  (new) shared shell
src/app/dashboard/settings/page.tsx                    (new) index → redirect to first visible tab
src/app/dashboard/settings/fulfillment-permission.ts   (new, moved from src/app/dashboard/fulfillment-permission.ts)
src/app/dashboard/settings/fulfillment/page.tsx        (new, moved from src/app/dashboard/fulfillment/page.tsx)
src/app/dashboard/settings/fulfillment/actions.ts      (new, moved from src/app/dashboard/fulfillment/actions.ts)
src/app/dashboard/fulfillment/page.tsx                 (delete)
src/app/dashboard/fulfillment/actions.ts               (delete)
src/app/dashboard/fulfillment-permission.ts            (delete)

src/app/dashboard/settings/whatsapp/page.tsx           (new)
src/app/dashboard/settings/whatsapp/actions.ts         (new)
src/app/order/[token]/page.tsx                         (mod) WhatsApp click-to-chat button

src/app/dashboard/settings/profile-permission.ts       (new)
src/app/dashboard/settings/profile/page.tsx            (new)
src/app/dashboard/settings/profile/actions.ts          (new)

src/app/dashboard/settings/staff-permission.ts         (new)
src/app/dashboard/settings/staff/page.tsx              (new)
src/app/dashboard/settings/staff/actions.ts            (new)

src/app/dashboard/settings/billing-permission.ts       (new)
src/app/dashboard/settings/billing/page.tsx            (new)
src/app/dashboard/settings/billing/actions.ts          (new)

tests/e2e/dashboard.spec.ts                            (mod) settings tab-visibility assertions
```

---

### Task 1: Settings shell — tab layout, index redirect, relocate Fulfillment

**Files:**
- Create: `src/app/dashboard/settings/tabs.ts`, `src/app/dashboard/settings/SettingsTabs.tsx`, `src/app/dashboard/settings/layout.tsx`, `src/app/dashboard/settings/page.tsx`, `src/app/dashboard/settings/fulfillment-permission.ts`, `src/app/dashboard/settings/fulfillment/page.tsx`, `src/app/dashboard/settings/fulfillment/actions.ts`
- Delete: `src/app/dashboard/fulfillment/page.tsx`, `src/app/dashboard/fulfillment/actions.ts`, `src/app/dashboard/fulfillment-permission.ts`
- Modify: `src/components/dashboard/nav-items.ts`, `src/components/dashboard/nav-items.test.ts`

**Interfaces:**
- Consumes: `requireDashboardUser()` from `@/server/auth/dashboard-context`; `can()` from `@/server/rbac/authorize`; `type RoleKey, Permission` from `@/server/rbac/permissions`.
- Produces (later tasks rely on these exact names):
  - `type SettingsTab = { label: string; href: string; permission: Permission }` from `./tabs`
  - `SETTINGS_TABS: SettingsTab[]` and `visibleSettingsTabs(roleKeys: RoleKey[]): SettingsTab[]` from `./tabs`
  - `requireFulfillmentPermission(): Promise<DashboardContext>` from `../fulfillment-permission` (relative to any `settings/<tab>/` folder)

- [ ] **Step 1: Write the failing nav-items test for the new Settings href**

Replace `src/components/dashboard/nav-items.test.ts` in full:

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

  it("points Settings at the new settings hub", () => {
    const settings = dashboardNavItems(["owner"]).find((i) => i.label === "Settings");
    expect(settings?.href).toBe("/dashboard/settings");
  });

  it("gives managers the full nav (Home through Settings)", () => {
    const labels = dashboardNavItems(["manager"]).map((i) => i.label);
    expect(labels).toContain("Home");
    expect(labels).toContain("Settings");
  });
});
```

- [ ] **Step 2: Run it to verify the new assertion fails**

Run: `npx vitest run src/components/dashboard/nav-items.test.ts`
Expected: FAIL — `settings?.href` is `/dashboard/fulfillment`, not `/dashboard/settings`.

- [ ] **Step 3: Update the Settings href in `nav-items.ts`**

In `src/components/dashboard/nav-items.ts`, change:

```ts
  if (has("fulfillment:manage")) items.push({ label: "Settings", href: "/dashboard/fulfillment", icon: "settings" });
```

to:

```ts
  if (has("fulfillment:manage")) items.push({ label: "Settings", href: "/dashboard/settings", icon: "settings" });
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/components/dashboard/nav-items.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/nav-items.ts src/components/dashboard/nav-items.test.ts
git commit -m "feat(dashboard): point Settings nav at the new settings hub"
```

- [ ] **Step 6: Create the tab registry**

Create `src/app/dashboard/settings/tabs.ts`:

```ts
import type { RoleKey, Permission } from "@/server/rbac/permissions";
import { can } from "@/server/rbac/authorize";

export type SettingsTab = { label: string; href: string; permission: Permission };

export const SETTINGS_TABS: SettingsTab[] = [
  { label: "Business Profile", href: "/dashboard/settings/profile", permission: "tenant:manage" },
  { label: "WhatsApp", href: "/dashboard/settings/whatsapp", permission: "fulfillment:manage" },
  { label: "Fulfillment", href: "/dashboard/settings/fulfillment", permission: "fulfillment:manage" },
  { label: "Staff", href: "/dashboard/settings/staff", permission: "staff:invite" },
  { label: "Billing", href: "/dashboard/settings/billing", permission: "billing:manage" },
];

export function visibleSettingsTabs(roleKeys: RoleKey[]): SettingsTab[] {
  return SETTINGS_TABS.filter((tab) => can(roleKeys, tab.permission));
}
```

(Business Profile, WhatsApp, Staff, and Billing routes 404 until Tasks 3–6 add their pages — expected mid-plan; the plan verifies everything end-to-end in Task 7.)

- [ ] **Step 7: Create the route-based tab bar**

Create `src/app/dashboard/settings/SettingsTabs.tsx`:

```tsx
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import type { SettingsTab } from "./tabs";

export function SettingsTabs({ tabs }: { tabs: SettingsTab[] }) {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 border-b mb-6 overflow-x-auto">
      {tabs.map((tab) => {
        const active = pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "px-3 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors",
              active
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 8: Create the settings layout**

Create `src/app/dashboard/settings/layout.tsx`:

```tsx
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { SettingsTabs } from "./SettingsTabs";
import { visibleSettingsTabs } from "./tabs";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const { roleKeys } = await requireDashboardUser();
  const tabs = visibleSettingsTabs(roleKeys);

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Settings"
        description="Business profile, WhatsApp, fulfillment, staff, and billing."
      />
      <SettingsTabs tabs={tabs} />
      {children}
    </>
  );
}
```

- [ ] **Step 9: Create the index redirect**

Create `src/app/dashboard/settings/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { visibleSettingsTabs } from "./tabs";

export default async function SettingsIndexPage() {
  const { roleKeys } = await requireDashboardUser();
  const [firstTab] = visibleSettingsTabs(roleKeys);
  redirect(firstTab?.href ?? "/dashboard/orders");
}
```

- [ ] **Step 10: Move the Fulfillment permission guard**

Create `src/app/dashboard/settings/fulfillment-permission.ts` with the exact current contents of `src/app/dashboard/fulfillment-permission.ts`:

```ts
import { requireDashboardUser, type DashboardContext } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";

export async function requireFulfillmentPermission(): Promise<DashboardContext> {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "fulfillment:manage");
  return ctx;
}
```

- [ ] **Step 11: Move the Fulfillment page and actions**

Create `src/app/dashboard/settings/fulfillment/page.tsx` with the exact current contents of `src/app/dashboard/fulfillment/page.tsx` (the `../fulfillment-permission` relative import stays correct since the guard file moved one directory up alongside it — no import changes needed).

Create `src/app/dashboard/settings/fulfillment/actions.ts` with the current contents of `src/app/dashboard/fulfillment/actions.ts`, but replace every occurrence of `"/dashboard/fulfillment"` with `"/dashboard/settings/fulfillment"`:

```ts
"use server";
import { revalidatePath } from "next/cache";
import { requireFulfillmentPermission } from "../fulfillment-permission";
import { updateBranchOrdering, createDeliveryArea, deleteDeliveryArea } from "@/server/branches/service";
import { setVatRate } from "@/server/tenancy/settings";
import type { OpeningHours } from "@/server/branches/schema";

export async function setAcceptingOrdersAction(branchId: string, accepting: boolean) {
  const { tenantId } = await requireFulfillmentPermission();
  await updateBranchOrdering(tenantId, branchId, { acceptingOrders: accepting });
  revalidatePath("/dashboard/settings/fulfillment");
}

export async function setOpeningHoursAction(branchId: string, formData: FormData) {
  const { tenantId } = await requireFulfillmentPermission();
  const hours: OpeningHours = [];
  for (let day = 0; day < 7; day++) {
    const closed = formData.get(`closed-${day}`) === "on";
    hours.push({ day, closed, open: String(formData.get(`open-${day}`) || "10:00"), close: String(formData.get(`close-${day}`) || "23:00") });
  }
  await updateBranchOrdering(tenantId, branchId, { openingHours: hours });
  revalidatePath("/dashboard/settings/fulfillment");
}

export async function addAreaAction(branchId: string, formData: FormData) {
  const { tenantId } = await requireFulfillmentPermission();
  await createDeliveryArea(tenantId, branchId, {
    nameEn: String(formData.get("nameEn")), nameAr: String(formData.get("nameAr")),
    deliveryFee: String(formData.get("deliveryFee") || "0"), minOrderAmount: String(formData.get("minOrderAmount") || "0"),
    etaMinutes: formData.get("etaMinutes") ? Number(formData.get("etaMinutes")) : null,
  });
  revalidatePath("/dashboard/settings/fulfillment");
}

export async function deleteAreaAction(areaId: string) {
  const { tenantId } = await requireFulfillmentPermission();
  await deleteDeliveryArea(tenantId, areaId);
  revalidatePath("/dashboard/settings/fulfillment");
}

export async function setVatAction(formData: FormData) {
  const { tenantId } = await requireFulfillmentPermission();
  await setVatRate(tenantId, Number(formData.get("vatRate")));
  revalidatePath("/dashboard/settings/fulfillment");
}
```

- [ ] **Step 12: Delete the old Fulfillment route**

```bash
rm -rf src/app/dashboard/fulfillment
rm src/app/dashboard/fulfillment-permission.ts
```

- [ ] **Step 13: Typecheck and build**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx next build`
Expected: build succeeds; `/dashboard/settings/fulfillment` appears in the route list, `/dashboard/fulfillment` does not.

- [ ] **Step 14: Commit**

```bash
git add src/app/dashboard/settings src/app/dashboard/fulfillment
git commit -m "feat(dashboard): settings hub shell with tab bar; relocate Fulfillment under it"
```

---

### Task 2: Tenant settings foundation — WhatsApp number + clearer toast errors

**Files:**
- Create: `src/server/tenancy/errors.ts`, `src/server/tenancy/errors.test.ts`, `src/lib/errors-client.ts`, `src/lib/errors-client.test.ts`
- Modify: `src/server/tenancy/settings.ts`, `src/server/tenancy/settings.test.ts`, `src/server/tenancy/index.ts`, `src/components/dashboard/ToastForm.tsx`

**Interfaces:**
- Consumes: `DomainError, type Locale` from `@/shared/errors`; existing `tenantSettings`/`tenants` schema and `withTenant` from `@/db/with-tenant`.
- Produces (later tasks rely on these exact names):
  - `getWhatsappNumber(tenantId: string): Promise<string | null>` from `@/server/tenancy/settings`
  - `setWhatsappNumber(tenantId: string, number: string | null): Promise<void>` from `@/server/tenancy/settings` (throws `InvalidWhatsappNumberError` for a malformed non-null number)
  - `InvalidWhatsappNumberError` from `@/server/tenancy/errors`
  - `toastMessageFor(err: unknown): string` from `@/lib/errors-client`

- [ ] **Step 1: Write the failing error-class test**

Create `src/server/tenancy/errors.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { InvalidWhatsappNumberError } from "./errors";

describe("tenancy errors", () => {
  it("InvalidWhatsappNumberError carries a code and localized messages", () => {
    const err = new InvalidWhatsappNumberError("not-a-number");
    expect(err.code).toBe("invalid_whatsapp_number");
    expect(err.messageFor("en")).toContain("Invalid WhatsApp number");
    expect(err.messageFor("ar")).toContain("واتساب");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/server/tenancy/errors.test.ts`
Expected: FAIL — `./errors` module doesn't exist.

- [ ] **Step 3: Create the error class**

Create `src/server/tenancy/errors.ts`:

```ts
import { DomainError, type Locale } from "@/shared/errors";

export class InvalidWhatsappNumberError extends DomainError {
  readonly code = "invalid_whatsapp_number";
  constructor(public readonly value: string) {
    super(`Invalid WhatsApp number: ${value}`);
    this.name = "InvalidWhatsappNumberError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar"
      ? "رقم واتساب غير صالح — استخدم الصيغة الدولية، مثال: \u200E+201234567890"
      : "Invalid WhatsApp number — use international format, e.g. +201234567890";
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/server/tenancy/errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing settings tests**

Append to `src/server/tenancy/settings.test.ts` (add these imports to the existing top-of-file import line and add the new `describe` block at the end of the file):

```ts
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "./schema";
import { getVatRate, setVatRate, getTenantSettings, getWhatsappNumber, setWhatsappNumber } from "./settings";
import { InvalidWhatsappNumberError } from "./errors";

async function makeTenant(slug: string, country = "EG") {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country }).returning();
  return t;
}

describe("tenant VAT settings", () => {
  it("defaults to 14 for EG and 15 for SA when unset", async () => {
    const eg = await makeTenant("vat-eg", "EG");
    const sa = await makeTenant("vat-sa", "SA");
    expect(await getVatRate(eg.id)).toBe(14);
    expect(await getVatRate(sa.id)).toBe(15);
  });
  it("setVatRate overrides the default and persists", async () => {
    const t = await makeTenant("vat-set", "EG");
    await setVatRate(t.id, 10);
    expect(await getVatRate(t.id)).toBe(10);
    expect((await getTenantSettings(t.id)).vatRate).toBe(10);
  });
});

describe("tenant WhatsApp settings", () => {
  it("defaults to no WhatsApp number", async () => {
    const t = await makeTenant("wa-default");
    expect(await getWhatsappNumber(t.id)).toBeNull();
  });

  it("sets and retrieves a valid E.164 number", async () => {
    const t = await makeTenant("wa-set");
    await setWhatsappNumber(t.id, "+201234567890");
    expect(await getWhatsappNumber(t.id)).toBe("+201234567890");
  });

  it("rejects a number without international formatting", async () => {
    const t = await makeTenant("wa-invalid");
    await expect(setWhatsappNumber(t.id, "01234567890")).rejects.toBeInstanceOf(InvalidWhatsappNumberError);
  });

  it("clearing the number removes it", async () => {
    const t = await makeTenant("wa-clear");
    await setWhatsappNumber(t.id, "+201234567890");
    await setWhatsappNumber(t.id, null);
    expect(await getWhatsappNumber(t.id)).toBeNull();
  });

  it("setting WhatsApp doesn't clobber an existing VAT rate", async () => {
    const t = await makeTenant("wa-vat-coexist");
    await setVatRate(t.id, 12);
    await setWhatsappNumber(t.id, "+201234567890");
    expect(await getVatRate(t.id)).toBe(12);
    expect(await getWhatsappNumber(t.id)).toBe("+201234567890");
  });
});
```

The full replaced file should keep the existing `describe("tenant VAT settings", ...)` block unchanged and add the new `describe("tenant WhatsApp settings", ...)` block after it.

- [ ] **Step 6: Run it to verify the new tests fail**

Run: `npx vitest run src/server/tenancy/settings.test.ts`
Expected: FAIL — `getWhatsappNumber`/`setWhatsappNumber` are not exported yet.

- [ ] **Step 7: Rewrite `settings.ts` with a shared merge helper and the WhatsApp functions**

Replace `src/server/tenancy/settings.ts` in full:

```ts
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants, tenantSettings } from "./schema";
import { InvalidWhatsappNumberError } from "./errors";

export type TenantSettingsData = {
  vatRate?: number;
  whatsappNumber?: string;
  upgradeRequest?: { planKey: string; requestedAt: string };
};

const E164_RE = /^\+[1-9]\d{6,14}$/;

/** tenant_settings is RLS-backed → read/write through withTenant. */
export async function getTenantSettings(tenantId: string): Promise<TenantSettingsData> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select().from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId)).limit(1),
  );
  return (row?.data as TenantSettingsData | undefined) ?? {};
}

/** Merges `patch` into the tenant's settings bag, creating the row if needed.
 * Keys set to `undefined` in `patch` are dropped from the stored JSON. */
async function patchTenantSettings(tenantId: string, patch: Partial<TenantSettingsData>): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [row] = await tx.select().from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId)).limit(1);
    const data: TenantSettingsData = { ...((row?.data as TenantSettingsData | undefined) ?? {}), ...patch };
    if (row) {
      await tx.update(tenantSettings).set({ data }).where(eq(tenantSettings.id, row.id));
    } else {
      await tx.insert(tenantSettings).values({ tenantId, data });
    }
  });
}

export async function setVatRate(tenantId: string, vatRate: number): Promise<void> {
  await patchTenantSettings(tenantId, { vatRate });
}

export function defaultVatRate(country: string): number {
  return country === "SA" ? 15 : 14;
}

/** Configured VAT rate, or the country default. tenants is a control table → plain db. */
export async function getVatRate(tenantId: string): Promise<number> {
  const settings = await getTenantSettings(tenantId);
  if (typeof settings.vatRate === "number") return settings.vatRate;
  const [t] = await db.select({ country: tenants.country }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return defaultVatRate(t?.country ?? "EG");
}

export async function getWhatsappNumber(tenantId: string): Promise<string | null> {
  const settings = await getTenantSettings(tenantId);
  return settings.whatsappNumber ?? null;
}

/** Pass `null` to disable click-to-chat (removes the stored number). */
export async function setWhatsappNumber(tenantId: string, number: string | null): Promise<void> {
  if (number !== null && !E164_RE.test(number)) {
    throw new InvalidWhatsappNumberError(number);
  }
  await patchTenantSettings(tenantId, { whatsappNumber: number ?? undefined });
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `npx vitest run src/server/tenancy/settings.test.ts`
Expected: PASS (9 tests total).

- [ ] **Step 9: Export the new pieces from the tenancy barrel**

In `src/server/tenancy/index.ts`, change:

```ts
export { getTenantSettings, setVatRate, getVatRate, defaultVatRate, type TenantSettingsData } from "./settings";
```

to:

```ts
export { getTenantSettings, setVatRate, getVatRate, defaultVatRate, getWhatsappNumber, setWhatsappNumber, type TenantSettingsData } from "./settings";
export { InvalidWhatsappNumberError } from "./errors";
```

- [ ] **Step 10: Write the failing test for toast error surfacing**

Create `src/lib/errors-client.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { toastMessageFor } from "./errors-client";
import { InvalidWhatsappNumberError } from "@/server/tenancy/errors";

describe("toastMessageFor", () => {
  it("surfaces a DomainError's English message", () => {
    expect(toastMessageFor(new InvalidWhatsappNumberError("bad"))).toBe(
      "Invalid WhatsApp number — use international format, e.g. +201234567890",
    );
  });

  it("falls back to a generic message for non-domain errors", () => {
    expect(toastMessageFor(new Error("boom"))).toBe("Something went wrong. Please try again.");
    expect(toastMessageFor("boom")).toBe("Something went wrong. Please try again.");
  });
});
```

- [ ] **Step 11: Run it to verify it fails**

Run: `npx vitest run src/lib/errors-client.test.ts`
Expected: FAIL — `./errors-client` module doesn't exist.

- [ ] **Step 12: Create `toastMessageFor`**

Create `src/lib/errors-client.ts`:

```ts
import { DomainError } from "@/shared/errors";

export function toastMessageFor(err: unknown): string {
  if (err instanceof DomainError) return err.messageFor("en");
  return "Something went wrong. Please try again.";
}
```

- [ ] **Step 13: Run it to verify it passes**

Run: `npx vitest run src/lib/errors-client.test.ts`
Expected: PASS.

- [ ] **Step 14: Wire `toastMessageFor` into `ToastForm`**

Replace `src/components/dashboard/ToastForm.tsx` in full:

```tsx
"use client";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { toastMessageFor } from "@/lib/errors-client";

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
        } catch (err) {
          toast.error(toastMessageFor(err));
        }
      }}
    >
      {children}
    </form>
  );
}
```

- [ ] **Step 15: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 16: Commit**

```bash
git add src/server/tenancy src/lib/errors-client.ts src/lib/errors-client.test.ts src/components/dashboard/ToastForm.tsx
git commit -m "feat(tenancy): WhatsApp number setting; surface DomainError messages in toasts"
```

---

### Task 3: WhatsApp settings page + storefront click-to-chat button

**Files:**
- Create: `src/lib/whatsapp.ts`, `src/lib/whatsapp.test.ts`, `src/app/dashboard/settings/whatsapp/page.tsx`, `src/app/dashboard/settings/whatsapp/actions.ts`
- Modify: `src/app/order/[token]/page.tsx`

**Interfaces:**
- Consumes: `getWhatsappNumber`, `setWhatsappNumber` from `@/server/tenancy/settings` (Task 2); `requireFulfillmentPermission` from `../fulfillment-permission` (Task 1); `OrderWithItems` shape from `@/server/ordering/service` (`orderNumber`, `fulfillmentType`, `items[].quantity`, `items[].nameEn`, `total`).
- Produces: `buildOrderWhatsappMessage(order: WhatsappOrderSummary): string` and `whatsappChatLink(number: string, text: string): string` from `@/lib/whatsapp`.

- [ ] **Step 1: Write the failing WhatsApp-message tests**

Create `src/lib/whatsapp.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildOrderWhatsappMessage, whatsappChatLink } from "./whatsapp";

describe("buildOrderWhatsappMessage", () => {
  it("includes order number, fulfillment type, items, and total", () => {
    const msg = buildOrderWhatsappMessage({
      orderNumber: 42,
      fulfillmentType: "pickup",
      items: [{ quantity: 2, nameEn: "Margherita" }],
      total: "178.00",
    });
    expect(msg).toBe("Order #42\nPickup\n2x Margherita\nTotal: 178.00");
  });

  it("labels delivery orders", () => {
    const msg = buildOrderWhatsappMessage({
      orderNumber: 1, fulfillmentType: "delivery", items: [{ quantity: 1, nameEn: "Pie" }], total: "50.00",
    });
    expect(msg).toContain("Delivery");
  });

  it("caps long item lists and notes how many more", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ quantity: 1, nameEn: `Item ${i + 1}` }));
    const msg = buildOrderWhatsappMessage({ orderNumber: 1, fulfillmentType: "delivery", items, total: "500.00" });
    expect(msg).toContain("+2 more item(s)");
    expect(msg).not.toContain("Item 9");
  });
});

describe("whatsappChatLink", () => {
  it("builds a wa.me link with the number and URL-encoded text", () => {
    const link = whatsappChatLink("+201234567890", "hello world");
    expect(link).toBe("https://wa.me/201234567890?text=hello%20world");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/whatsapp.test.ts`
Expected: FAIL — `./whatsapp` module doesn't exist.

- [ ] **Step 3: Implement `src/lib/whatsapp.ts`**

```ts
export type WhatsappOrderSummary = {
  orderNumber: number;
  fulfillmentType: "pickup" | "delivery";
  items: { quantity: number; nameEn: string }[];
  total: string;
};

const MAX_ITEMS = 8;

export function buildOrderWhatsappMessage(order: WhatsappOrderSummary): string {
  const lines = order.items.slice(0, MAX_ITEMS).map((i) => `${i.quantity}x ${i.nameEn}`);
  const remaining = order.items.length - MAX_ITEMS;
  return [
    `Order #${order.orderNumber}`,
    order.fulfillmentType === "delivery" ? "Delivery" : "Pickup",
    ...lines,
    ...(remaining > 0 ? [`+${remaining} more item(s)`] : []),
    `Total: ${order.total}`,
  ].join("\n");
}

export function whatsappChatLink(number: string, text: string): string {
  return `https://wa.me/${number.replace(/^\+/, "")}?text=${encodeURIComponent(text)}`;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/whatsapp.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit the WhatsApp message helper**

```bash
git add src/lib/whatsapp.ts src/lib/whatsapp.test.ts
git commit -m "feat: WhatsApp click-to-chat link and order-summary message builder"
```

- [ ] **Step 6: Create the WhatsApp settings actions**

Create `src/app/dashboard/settings/whatsapp/actions.ts`:

```ts
"use server";
import { revalidatePath } from "next/cache";
import { requireFulfillmentPermission } from "../fulfillment-permission";
import { setWhatsappNumber } from "@/server/tenancy/settings";

export async function setWhatsappNumberAction(formData: FormData) {
  const { tenantId } = await requireFulfillmentPermission();
  const raw = String(formData.get("whatsappNumber") || "").trim();
  await setWhatsappNumber(tenantId, raw === "" ? null : raw);
  revalidatePath("/dashboard/settings/whatsapp");
}
```

- [ ] **Step 7: Create the WhatsApp settings page**

Create `src/app/dashboard/settings/whatsapp/page.tsx`:

```tsx
import { requireFulfillmentPermission } from "../fulfillment-permission";
import { getWhatsappNumber } from "@/server/tenancy/settings";
import { whatsappChatLink, buildOrderWhatsappMessage } from "@/lib/whatsapp";
import { setWhatsappNumberAction } from "./actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default async function WhatsAppSettingsPage() {
  const { tenantId } = await requireFulfillmentPermission();
  const number = await getWhatsappNumber(tenantId);
  const previewLink = number
    ? whatsappChatLink(
        number,
        buildOrderWhatsappMessage({
          orderNumber: 1024, fulfillmentType: "pickup",
          items: [{ quantity: 2, nameEn: "Margherita" }], total: "178.00",
        }),
      )
    : null;

  return (
    <>
      <PageHeader
        title="WhatsApp"
        description="Customers get a pre-filled WhatsApp message to send you after checkout."
      />
      <Card className="p-5 max-w-lg">
        <ToastForm action={setWhatsappNumberAction} successMessage="WhatsApp number saved" className="space-y-3">
          <div className="grid gap-1.5">
            <Label htmlFor="whatsappNumber">WhatsApp number</Label>
            <Input
              id="whatsappNumber" name="whatsappNumber" placeholder="+201234567890"
              defaultValue={number ?? ""} className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              International format — e.g. +20 for Egypt, +966 for Saudi Arabia. Leave blank to disable.
            </p>
          </div>
          <SubmitButton>Save</SubmitButton>
        </ToastForm>
        {previewLink && (
          <a
            href={previewLink} target="_blank" rel="noopener noreferrer"
            className="mt-4 inline-block text-sm text-primary underline"
          >
            Send test message →
          </a>
        )}
      </Card>
    </>
  );
}
```

- [ ] **Step 8: Add the click-to-chat button to the order confirmation page**

Replace `src/app/order/[token]/page.tsx` in full:

```tsx
import { headers } from "next/headers";
import { getTenantBySlug } from "@/server/tenancy";
import { getOrderByToken } from "@/server/ordering/service";
import { getWhatsappNumber } from "@/server/tenancy/settings";
import { buildOrderWhatsappMessage, whatsappChatLink } from "@/lib/whatsapp";
import { StatusPoller } from "./StatusPoller";

const STEPS_DELIVERY = ["pending", "confirmed", "preparing", "ready", "out_for_delivery", "completed"];
const STEPS_PICKUP = ["pending", "confirmed", "preparing", "ready", "completed"];

export default async function OrderStatusPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const h = await headers();
  const slug = h.get("x-tenant-slug");
  if (!slug) return <main style={{ padding: 32 }}><h1>Not found</h1></main>;

  const tenant = await getTenantBySlug(slug);
  const order = tenant ? await getOrderByToken(tenant.id, token) : null;
  if (!order) return <main style={{ padding: 32, fontFamily: "system-ui" }}><h1>Order not found</h1></main>;

  const whatsappNumber = tenant ? await getWhatsappNumber(tenant.id) : null;
  const steps = order.fulfillmentType === "delivery" ? STEPS_DELIVERY : STEPS_PICKUP;

  return (
    <main style={{ padding: 24, maxWidth: 440, margin: "0 auto", fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 22 }}>Order #{order.orderNumber}</h1>
      <StatusPoller token={token} slug={slug} initialStatus={order.status} steps={steps} terminal={["completed", "rejected", "cancelled"]} />
      <div style={{ borderTop: "1px solid #eee", marginTop: 16, paddingTop: 12, fontSize: 14, color: "#374151" }}>
        <div>{order.fulfillmentType === "delivery" ? `Delivery to ${order.deliveryAreaNameSnapshot ?? ""}` : "Pickup"} · Cash · {order.paymentStatus}</div>
        {order.items.map((it) => <div key={it.id}>{it.quantity}× {it.nameEn}</div>)}
        <div style={{ fontWeight: 700, marginTop: 6 }}>Total {Number(order.total).toFixed(2)}</div>
      </div>
      {whatsappNumber && (
        <a
          href={whatsappChatLink(
            whatsappNumber,
            buildOrderWhatsappMessage({
              orderNumber: order.orderNumber,
              fulfillmentType: order.fulfillmentType,
              items: order.items.map((it) => ({ quantity: it.quantity, nameEn: it.nameEn })),
              total: Number(order.total).toFixed(2),
            }),
          )}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-block", marginTop: 16, padding: "10px 16px",
            background: "#25D366", color: "#fff", borderRadius: 8,
            textDecoration: "none", fontWeight: 600, fontSize: 14,
          }}
        >
          Send order via WhatsApp
        </a>
      )}
    </main>
  );
}
```

- [ ] **Step 9: Typecheck and build**

Run: `npx tsc --noEmit`
Expected: no errors — check that `order.fulfillmentType` is typed as `"pickup" | "delivery"` (matching `WhatsappOrderSummary`); if `OrderWithItems.fulfillmentType` is typed as a broader `string` in `@/server/ordering/schema`, this step will surface it — narrow with `order.fulfillmentType === "delivery" ? "delivery" : "pickup"` in the `buildOrderWhatsappMessage` call instead if so.

Run: `npx next build`
Expected: build succeeds; `/dashboard/settings/whatsapp` and `/order/[token]` both compile.

- [ ] **Step 10: Commit**

```bash
git add src/app/dashboard/settings/whatsapp src/app/order/\[token\]/page.tsx
git commit -m "feat(dashboard): WhatsApp settings tab and storefront click-to-chat button"
```

---

### Task 4: Business Profile

**Files:**
- Create: `src/app/dashboard/settings/profile-permission.ts`, `src/app/dashboard/settings/profile/page.tsx`, `src/app/dashboard/settings/profile/actions.ts`
- Modify: `src/server/tenancy/service.ts`, `src/server/tenancy/service.test.ts`, `src/server/tenancy/index.ts`

**Interfaces:**
- Consumes: `tenants` schema, `type Tenant` from `./schema`; `requireDashboardUser`, `authorize` for the new permission guard.
- Produces: `updateTenantProfile(tenantId: string, input: UpdateTenantProfileInput): Promise<Tenant>` from `@/server/tenancy/service`, where `UpdateTenantProfileInput = Partial<Pick<Tenant, "name" | "logoUrl" | "primaryColor" | "defaultLocale" | "timezone">>`.

- [ ] **Step 1: Write the failing test**

Append to `src/server/tenancy/service.test.ts` — add `updateTenantProfile` to the existing import line and add a new `it` inside the existing `describe("tenancy service", ...)` block:

```ts
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "./schema";
import { resolveTenantByHost, createTenant, isTenantServable, updateTenantProfile } from "./service";
```

```ts
  it("updateTenantProfile updates only the whitelisted fields", async () => {
    const t = await createTenant({ slug: "profile-edit", name: "Old Name", country: "EG" });
    const updated = await updateTenantProfile(t.id, {
      name: "New Name", logoUrl: "https://example.com/logo.png",
      primaryColor: "#123456", defaultLocale: "en", timezone: "Africa/Cairo",
    });
    expect(updated.name).toBe("New Name");
    expect(updated.logoUrl).toBe("https://example.com/logo.png");
    expect(updated.primaryColor).toBe("#123456");
    expect(updated.defaultLocale).toBe("en");
    // slug/country/currency are not part of UpdateTenantProfileInput — untouched.
    expect(updated.slug).toBe("profile-edit");
    expect(updated.country).toBe("EG");
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/server/tenancy/service.test.ts`
Expected: FAIL — `updateTenantProfile` is not exported yet.

- [ ] **Step 3: Implement `updateTenantProfile`**

In `src/server/tenancy/service.ts`, add after the existing `createTenant` function:

```ts
export type UpdateTenantProfileInput = Partial<
  Pick<Tenant, "name" | "logoUrl" | "primaryColor" | "defaultLocale" | "timezone">
>;

/** tenants is a control table → plain db, same as createTenant. */
export async function updateTenantProfile(tenantId: string, input: UpdateTenantProfileInput): Promise<Tenant> {
  const [row] = await db.update(tenants).set(input).where(eq(tenants.id, tenantId)).returning();
  if (!row) throw new Error(`Tenant not found: ${tenantId}`);
  return row;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/server/tenancy/service.test.ts`
Expected: PASS.

- [ ] **Step 5: Export from the tenancy barrel**

In `src/server/tenancy/index.ts`, change:

```ts
export {
  createTenant,
  resolveTenantByHost,
  subdomainFromHost,
  getTenantBySlug,
  getTenantById,
  isTenantServable,
} from "./service";
```

to:

```ts
export {
  createTenant,
  resolveTenantByHost,
  subdomainFromHost,
  getTenantBySlug,
  getTenantById,
  isTenantServable,
  updateTenantProfile,
  type UpdateTenantProfileInput,
} from "./service";
```

- [ ] **Step 6: Commit the service layer**

```bash
git add src/server/tenancy
git commit -m "feat(tenancy): updateTenantProfile for the business-profile settings tab"
```

- [ ] **Step 7: Create the permission guard**

Create `src/app/dashboard/settings/profile-permission.ts`:

```ts
import { requireDashboardUser, type DashboardContext } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";

export async function requireTenantManagePermission(): Promise<DashboardContext> {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "tenant:manage");
  return ctx;
}
```

- [ ] **Step 8: Create the actions**

Create `src/app/dashboard/settings/profile/actions.ts`:

```ts
"use server";
import { revalidatePath } from "next/cache";
import { requireTenantManagePermission } from "../profile-permission";
import { updateTenantProfile } from "@/server/tenancy";

export async function updateTenantProfileAction(formData: FormData) {
  const { tenantId } = await requireTenantManagePermission();
  await updateTenantProfile(tenantId, {
    name: String(formData.get("name") || "").trim(),
    logoUrl: String(formData.get("logoUrl") || "").trim() || null,
    primaryColor: String(formData.get("primaryColor") || "#0F172A"),
    defaultLocale: String(formData.get("defaultLocale") || "ar"),
    timezone: String(formData.get("timezone") || "Africa/Cairo"),
  });
  revalidatePath("/dashboard/settings/profile");
  revalidatePath("/dashboard"); // sidebar restaurant name reads from the layout
}
```

- [ ] **Step 9: Create the page**

Create `src/app/dashboard/settings/profile/page.tsx`:

```tsx
import { requireTenantManagePermission } from "../profile-permission";
import { getTenantById } from "@/server/tenancy";
import { updateTenantProfileAction } from "./actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

export default async function BusinessProfilePage() {
  const { tenantId } = await requireTenantManagePermission();
  const tenant = await getTenantById(tenantId);
  if (!tenant) throw new Error(`Tenant not found: ${tenantId}`);

  return (
    <>
      <PageHeader title="Business Profile" description="Restaurant name, logo, brand color, locale, and timezone." />
      <Card className="p-5 max-w-xl mb-6">
        <ToastForm action={updateTenantProfileAction} successMessage="Profile saved" className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="name">Restaurant name</Label>
            <Input id="name" name="name" defaultValue={tenant.name} required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="logoUrl">Logo URL</Label>
            <Input id="logoUrl" name="logoUrl" type="url" defaultValue={tenant.logoUrl ?? ""} placeholder="https://..." />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="primaryColor">Primary color</Label>
            <div className="flex items-center gap-2">
              <input
                id="primaryColor" name="primaryColor" type="color" defaultValue={tenant.primaryColor}
                className="size-9 rounded border border-input p-0.5"
              />
              <span className="font-mono text-sm text-muted-foreground">{tenant.primaryColor}</span>
            </div>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="defaultLocale">Default locale</Label>
              <select id="defaultLocale" name="defaultLocale" defaultValue={tenant.defaultLocale} className={selectClass}>
                <option value="en">English</option>
                <option value="ar">Arabic</option>
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="timezone">Timezone</Label>
              <select id="timezone" name="timezone" defaultValue={tenant.timezone} className={selectClass}>
                <option value="Africa/Cairo">Africa/Cairo</option>
                <option value="Asia/Riyadh">Asia/Riyadh</option>
              </select>
            </div>
          </div>
          <SubmitButton className="w-fit">Save</SubmitButton>
        </ToastForm>
      </Card>

      <Card className="p-5 max-w-xl bg-muted/30">
        <h2 className="eyebrow text-muted-foreground mb-3">Locked</h2>
        <dl className="text-sm space-y-1.5">
          <div className="flex justify-between"><dt className="text-muted-foreground">Slug (storefront URL)</dt><dd className="font-mono">{tenant.slug}</dd></div>
          <div className="flex justify-between"><dt className="text-muted-foreground">Country</dt><dd>{tenant.country}</dd></div>
          <div className="flex justify-between"><dt className="text-muted-foreground">Currency</dt><dd>{tenant.currency}</dd></div>
        </dl>
        <p className="text-xs text-muted-foreground mt-3">
          These affect your live storefront URL and billing/VAT — contact support to change them.
        </p>
      </Card>
    </>
  );
}
```

- [ ] **Step 10: Typecheck and build**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx next build`
Expected: build succeeds; `/dashboard/settings/profile` compiles.

- [ ] **Step 11: Commit**

```bash
git add src/app/dashboard/settings/profile-permission.ts src/app/dashboard/settings/profile
git commit -m "feat(dashboard): Business Profile settings tab"
```

---

### Task 5: Staff management

**Files:**
- Create: `src/server/auth/errors.ts`, `src/server/auth/errors.test.ts`, `src/server/auth/staff.ts`, `src/server/auth/staff.test.ts`, `src/app/dashboard/settings/staff-permission.ts`, `src/app/dashboard/settings/staff/page.tsx`, `src/app/dashboard/settings/staff/actions.ts`

**Interfaces:**
- Consumes: `users, roles, userRoles, sessions, type User` from `./schema`; `hashPassword` from `./password`; `DomainError, type Locale` from `@/shared/errors`.
- Produces: `type StaffRoleKey = "manager" | "staff"`; `type StaffMember = { id: string; name: string; email: string | null; phone: string | null; status: string; roleKey: StaffRoleKey }`; `createStaff(tenantId: string, input: CreateStaffInput): Promise<User>`; `listStaff(tenantId: string): Promise<StaffMember[]>`; `setStaffRole(tenantId: string, userId: string, roleKey: StaffRoleKey): Promise<void>`; `deactivateStaff(tenantId: string, userId: string): Promise<void>` — all from `@/server/auth/staff`. `StaffContactTakenError` from `@/server/auth/errors`.

- [ ] **Step 1: Write the failing error-class test**

Create `src/server/auth/errors.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { StaffContactTakenError } from "./errors";

describe("auth errors", () => {
  it("StaffContactTakenError carries a code and localized messages", () => {
    const err = new StaffContactTakenError("dup@roma.com");
    expect(err.code).toBe("staff_contact_taken");
    expect(err.messageFor("en")).toContain("already in use");
    expect(err.messageFor("ar")).toContain("مستخدم");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/server/auth/errors.test.ts`
Expected: FAIL — `./errors` module doesn't exist.

- [ ] **Step 3: Create the error class**

Create `src/server/auth/errors.ts`:

```ts
import { DomainError, type Locale } from "@/shared/errors";

export class StaffContactTakenError extends DomainError {
  readonly code = "staff_contact_taken";
  constructor(public readonly contact: string) {
    super(`Email or phone already in use: ${contact}`);
    this.name = "StaffContactTakenError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar"
      ? "البريد الإلكتروني أو رقم الهاتف مستخدم بالفعل"
      : "That email or phone is already in use by another account";
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/server/auth/errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing staff-service tests**

Create `src/server/auth/staff.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { users, sessions, roles, userRoles } from "./schema";
import { createSession } from "./session";
import { createStaff, listStaff, setStaffRole, deactivateStaff } from "./staff";
import { StaffContactTakenError } from "./errors";

async function makeTenant(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG" }).returning();
  return t;
}

describe("staff management", () => {
  it("creates a staff member with a tenant-scoped role", async () => {
    const t = await makeTenant("staff-create");
    const user = await createStaff(t.id, { name: "Nour", email: "nour@roma.com", password: "pass1234", roleKey: "manager" });
    const staff = await listStaff(t.id);
    expect(staff).toHaveLength(1);
    expect(staff[0]).toMatchObject({ id: user.id, name: "Nour", roleKey: "manager", status: "active" });
  });

  it("rejects a duplicate email within the same tenant", async () => {
    const t = await makeTenant("staff-dup");
    await createStaff(t.id, { name: "Nour", email: "dup@roma.com", password: "pass1234", roleKey: "staff" });
    await expect(
      createStaff(t.id, { name: "Karim", email: "dup@roma.com", password: "pass1234", roleKey: "staff" }),
    ).rejects.toBeInstanceOf(StaffContactTakenError);
  });

  it("changes a staff member's role", async () => {
    const t = await makeTenant("staff-role");
    const user = await createStaff(t.id, { name: "Nour", email: "role@roma.com", password: "pass1234", roleKey: "staff" });
    await setStaffRole(t.id, user.id, "manager");
    const staff = await listStaff(t.id);
    expect(staff[0].roleKey).toBe("manager");
  });

  it("deactivates a staff member and clears their sessions", async () => {
    const t = await makeTenant("staff-deactivate");
    const user = await createStaff(t.id, { name: "Nour", email: "deact@roma.com", password: "pass1234", roleKey: "staff" });
    await createSession(user.id);
    await deactivateStaff(t.id, user.id);

    const [row] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    expect(row.status).toBe("inactive");
    const remainingSessions = await db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(remainingSessions).toHaveLength(0);
  });

  it("excludes the owner from the staff list", async () => {
    const t = await makeTenant("staff-owner-excl");
    const [owner] = await db.insert(users).values({ tenantId: t.id, name: "Owner", email: "owner@roma.com", passwordHash: "x" }).returning();
    const [ownerRole] = await db.insert(roles).values({ tenantId: t.id, key: "owner", name: "Owner" }).returning();
    await db.insert(userRoles).values({ userId: owner.id, roleId: ownerRole.id });
    await createStaff(t.id, { name: "Nour", email: "staffmember@roma.com", password: "pass1234", roleKey: "staff" });

    const staff = await listStaff(t.id);
    expect(staff).toHaveLength(1);
    expect(staff[0].name).toBe("Nour");
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/server/auth/staff.test.ts`
Expected: FAIL — `./staff` module doesn't exist.

- [ ] **Step 7: Implement `src/server/auth/staff.ts`**

```ts
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db/client";
import { users, roles, userRoles, sessions, type User } from "./schema";
import { hashPassword } from "./password";
import { StaffContactTakenError } from "./errors";

export type StaffRoleKey = "manager" | "staff";
export type StaffMember = {
  id: string; name: string; email: string | null; phone: string | null; status: string; roleKey: StaffRoleKey;
};
export type CreateStaffInput = { name: string; email?: string; phone?: string; password: string; roleKey: StaffRoleKey };

async function getOrCreateTenantRole(tenantId: string, key: StaffRoleKey): Promise<{ id: string }> {
  const [existing] = await db.select().from(roles).where(and(eq(roles.tenantId, tenantId), eq(roles.key, key))).limit(1);
  if (existing) return existing;
  const name = key === "manager" ? "Manager" : "Staff";
  const [created] = await db.insert(roles).values({ tenantId, key, name }).returning();
  return created;
}

export async function listStaff(tenantId: string): Promise<StaffMember[]> {
  const rows = await db
    .select({ user: users, roleKey: roles.key })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(users.tenantId, tenantId), ne(roles.key, "owner")));
  return rows.map((r) => ({
    id: r.user.id, name: r.user.name, email: r.user.email, phone: r.user.phone,
    status: r.user.status, roleKey: r.roleKey as StaffRoleKey,
  }));
}

export async function createStaff(tenantId: string, input: CreateStaffInput): Promise<User> {
  const email = input.email?.trim() || null;
  const phone = input.phone?.trim() || null;
  if (!email && !phone) throw new Error("Staff member needs an email or phone");

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), email ? eq(users.email, email) : eq(users.phone, phone!)))
    .limit(1);
  if (existing) throw new StaffContactTakenError(email ?? phone!);

  const passwordHash = await hashPassword(input.password);
  const role = await getOrCreateTenantRole(tenantId, input.roleKey);

  const [user] = await db.insert(users).values({ tenantId, name: input.name, email, phone, passwordHash }).returning();
  await db.insert(userRoles).values({ userId: user.id, roleId: role.id });
  return user;
}

export async function setStaffRole(tenantId: string, userId: string, roleKey: StaffRoleKey): Promise<void> {
  const [target] = await db.select().from(users).where(and(eq(users.id, userId), eq(users.tenantId, tenantId))).limit(1);
  if (!target) throw new Error("Staff member not found");
  const role = await getOrCreateTenantRole(tenantId, roleKey);
  await db.delete(userRoles).where(eq(userRoles.userId, userId));
  await db.insert(userRoles).values({ userId, roleId: role.id });
}

export async function deactivateStaff(tenantId: string, userId: string): Promise<void> {
  const [target] = await db
    .update(users)
    .set({ status: "inactive" })
    .where(and(eq(users.id, userId), eq(users.tenantId, tenantId)))
    .returning({ id: users.id });
  if (!target) throw new Error("Staff member not found");
  await db.delete(sessions).where(eq(sessions.userId, userId));
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `npx vitest run src/server/auth/staff.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 9: Commit the service layer**

```bash
git add src/server/auth/errors.ts src/server/auth/errors.test.ts src/server/auth/staff.ts src/server/auth/staff.test.ts
git commit -m "feat(auth): staff management service — create, list, re-role, deactivate"
```

- [ ] **Step 10: Create the permission guard**

Create `src/app/dashboard/settings/staff-permission.ts`:

```ts
import { requireDashboardUser, type DashboardContext } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";

export async function requireStaffPermission(): Promise<DashboardContext> {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "staff:invite");
  return ctx;
}
```

- [ ] **Step 11: Create the actions**

Create `src/app/dashboard/settings/staff/actions.ts`:

```ts
"use server";
import { revalidatePath } from "next/cache";
import { requireStaffPermission } from "../staff-permission";
import { createStaff, setStaffRole, deactivateStaff, type StaffRoleKey } from "@/server/auth/staff";

export async function createStaffAction(formData: FormData) {
  const { tenantId } = await requireStaffPermission();
  const roleKey: StaffRoleKey = formData.get("roleKey") === "manager" ? "manager" : "staff";
  await createStaff(tenantId, {
    name: String(formData.get("name") || "").trim(),
    email: String(formData.get("email") || "").trim() || undefined,
    phone: String(formData.get("phone") || "").trim() || undefined,
    password: String(formData.get("password") || ""),
    roleKey,
  });
  revalidatePath("/dashboard/settings/staff");
}

export async function setStaffRoleAction(userId: string, roleKey: StaffRoleKey) {
  const { tenantId } = await requireStaffPermission();
  await setStaffRole(tenantId, userId, roleKey);
  revalidatePath("/dashboard/settings/staff");
}

export async function deactivateStaffAction(userId: string) {
  const { tenantId } = await requireStaffPermission();
  await deactivateStaff(tenantId, userId);
  revalidatePath("/dashboard/settings/staff");
}
```

- [ ] **Step 12: Create the page**

Create `src/app/dashboard/settings/staff/page.tsx`:

```tsx
import { requireStaffPermission } from "../staff-permission";
import { listStaff } from "@/server/auth/staff";
import { createStaffAction, setStaffRoleAction, deactivateStaffAction } from "./actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { ConfirmActionButton } from "@/components/dashboard/ConfirmActionButton";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

export default async function StaffPage() {
  const { tenantId } = await requireStaffPermission();
  const staff = await listStaff(tenantId);

  return (
    <>
      <PageHeader title="Staff" description="Managers and staff who can sign in to this dashboard." />

      <Card className="p-5 max-w-xl mb-6">
        <h2 className="eyebrow text-primary mb-3">Add staff</h2>
        <ToastForm action={createStaffAction} successMessage="Staff member added" className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" required />
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="phone">Phone</Label>
              <Input id="phone" name="phone" />
            </div>
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="password">Temporary password</Label>
              <Input id="password" name="password" type="password" required minLength={8} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="roleKey">Role</Label>
              <select id="roleKey" name="roleKey" defaultValue="staff" className={selectClass}>
                <option value="manager">Manager</option>
                <option value="staff">Staff</option>
              </select>
            </div>
          </div>
          <SubmitButton className="w-fit">Add staff</SubmitButton>
        </ToastForm>
      </Card>

      {staff.length === 0 ? (
        <EmptyState title="No staff yet" description="Add a manager or staff account above to give them dashboard access." />
      ) : (
        <Card className="p-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {staff.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell className="text-muted-foreground">{s.email ?? s.phone}</TableCell>
                  <TableCell>
                    <ToastForm
                      action={setStaffRoleAction.bind(null, s.id, s.roleKey === "manager" ? "staff" : "manager")}
                      successMessage="Role updated"
                    >
                      <SubmitButton variant="outline" size="sm">
                        {s.roleKey === "manager" ? "Manager — make Staff" : "Staff — make Manager"}
                      </SubmitButton>
                    </ToastForm>
                  </TableCell>
                  <TableCell>
                    <Badge variant={s.status === "active" ? "default" : "secondary"}>{s.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {s.status === "active" && (
                      <ConfirmActionButton
                        action={deactivateStaffAction.bind(null, s.id)}
                        label="Deactivate"
                        size="sm"
                        variant="ghost"
                        title={`Deactivate ${s.name}?`}
                        description="They'll be signed out immediately and won't be able to log in again."
                        successMessage="Staff member deactivated"
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </>
  );
}
```

- [ ] **Step 13: Typecheck and build**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx next build`
Expected: build succeeds; `/dashboard/settings/staff` compiles.

- [ ] **Step 14: Commit**

```bash
git add src/app/dashboard/settings/staff-permission.ts src/app/dashboard/settings/staff
git commit -m "feat(dashboard): Staff settings tab"
```

---

### Task 6: Billing / Plan

**Files:**
- Create: `src/server/billing/service.ts`, `src/server/billing/service.test.ts`, `src/app/dashboard/settings/billing-permission.ts`, `src/app/dashboard/settings/billing/page.tsx`, `src/app/dashboard/settings/billing/actions.ts`
- Modify: `src/server/tenancy/settings.ts`, `src/server/tenancy/settings.test.ts`, `src/server/tenancy/index.ts`, `src/server/ordering/service.ts`, `src/server/ordering/orders.test.ts`, `src/server/subscription/service.ts`, `src/server/subscription/service.test.ts`, `src/server/subscription/index.ts`

**Interfaces:**
- Consumes: `getActiveSubscription, getPlanForTenant` from `@/server/subscription` (existing); `listBranches` from `@/server/branches/service` (existing); `listProducts` from `@/server/catalog/service` (existing); `listStaff` from `@/server/auth/staff` (Task 5); `patchTenantSettings`-backed helpers from `@/server/tenancy/settings` (Task 2's merge helper, reused here).
- Produces: `ordersThisMonthCount(tenantId: string): Promise<number>` from `@/server/ordering/service`; `listInvoicesForTenant(tenantId: string): Promise<Invoice[]>` from `@/server/billing/service`; `listPlans(): Promise<Plan[]>` from `@/server/subscription/service`; `requestPlanUpgrade(tenantId: string, planKey: string): Promise<void>` and `getUpgradeRequest(tenantId: string): Promise<{ planKey: string; requestedAt: string } | null>` from `@/server/tenancy/settings`.

- [ ] **Step 1: Write the failing test for the upgrade-request settings functions**

Append to `src/server/tenancy/settings.test.ts` — add `requestPlanUpgrade, getUpgradeRequest` to the existing settings import line, and add a new `describe` block:

```ts
describe("tenant plan upgrade requests", () => {
  it("has no upgrade request by default", async () => {
    const t = await makeTenant("upgrade-default");
    expect(await getUpgradeRequest(t.id)).toBeNull();
  });

  it("records the requested plan and a timestamp", async () => {
    const t = await makeTenant("upgrade-request");
    await requestPlanUpgrade(t.id, "pro");
    const req = await getUpgradeRequest(t.id);
    expect(req?.planKey).toBe("pro");
    expect(typeof req?.requestedAt).toBe("string");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/server/tenancy/settings.test.ts`
Expected: FAIL — `requestPlanUpgrade`/`getUpgradeRequest` are not exported yet.

- [ ] **Step 3: Implement the upgrade-request functions**

In `src/server/tenancy/settings.ts`, add after `setWhatsappNumber`:

```ts
export async function requestPlanUpgrade(tenantId: string, planKey: string): Promise<void> {
  await patchTenantSettings(tenantId, { upgradeRequest: { planKey, requestedAt: new Date().toISOString() } });
}

export async function getUpgradeRequest(tenantId: string): Promise<TenantSettingsData["upgradeRequest"] | null> {
  const settings = await getTenantSettings(tenantId);
  return settings.upgradeRequest ?? null;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/server/tenancy/settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Export from the tenancy barrel**

In `src/server/tenancy/index.ts`, change the settings export line to:

```ts
export {
  getTenantSettings, setVatRate, getVatRate, defaultVatRate,
  getWhatsappNumber, setWhatsappNumber, requestPlanUpgrade, getUpgradeRequest,
  type TenantSettingsData,
} from "./settings";
export { InvalidWhatsappNumberError } from "./errors";
```

- [ ] **Step 6: Write the failing test for `ordersThisMonthCount`**

In `src/server/ordering/orders.test.ts`, add `ordersThisMonthCount` to the existing service import line, and add a new `it` at the end of the `describe("orders queries + transitions", ...)` block:

```ts
  it("ordersThisMonthCount counts orders placed in the current billing period", async () => {
    const { t } = await setup("o8");
    expect(await ordersThisMonthCount(t.id)).toBe(1);
  });
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run src/server/ordering/orders.test.ts`
Expected: FAIL — `ordersThisMonthCount` is not exported yet.

- [ ] **Step 8: Implement `ordersThisMonthCount`**

In `src/server/ordering/service.ts`, change the drizzle-orm import line:

```ts
import { and, desc, eq, inArray, sql } from "drizzle-orm";
```

to:

```ts
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
```

Then add, after `pendingOrderCount`:

```ts
export async function ordersThisMonthCount(tenantId: string): Promise<number> {
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select({ c: sql<number>`COUNT(*)` }).from(orders).where(gte(orders.placedAt, periodStart)),
  );
  return Number(row.c);
}
```

- [ ] **Step 9: Run it to verify it passes**

Run: `npx vitest run src/server/ordering/orders.test.ts`
Expected: PASS.

- [ ] **Step 10: Write the failing test for `listPlans`**

In `src/server/subscription/service.test.ts`, add `listPlans` to the existing import line, and add a new test:

```ts
  it("listPlans returns all seeded plans ordered by price", async () => {
    await seedDefaultPlans();
    const all = await listPlans();
    expect(all.map((p) => p.key)).toEqual(["basic", "pro", "enterprise"]);
  });
```

- [ ] **Step 11: Run it to verify it fails**

Run: `npx vitest run src/server/subscription/service.test.ts`
Expected: FAIL — `listPlans` is not exported yet.

- [ ] **Step 12: Implement `listPlans`**

In `src/server/subscription/service.ts`, add the `plans` import and the function:

```ts
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { plans, subscriptions, type Subscription } from "./schema";
```

```ts
export async function listPlans() {
  return db.select().from(plans).orderBy(plans.priceMonthly);
}
```

- [ ] **Step 13: Run it to verify it passes**

Run: `npx vitest run src/server/subscription/service.test.ts`
Expected: PASS.

- [ ] **Step 14: Export from the subscription barrel**

In `src/server/subscription/index.ts`, change:

```ts
export { startTrial, transition, getActiveSubscription, getPlanForTenant } from "./service";
```

to:

```ts
export { startTrial, transition, getActiveSubscription, getPlanForTenant, listPlans } from "./service";
```

- [ ] **Step 15: Write the failing test for `listInvoicesForTenant`**

Create `src/server/billing/service.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { ManualBillingProvider } from "./manual-provider";
import { listInvoicesForTenant } from "./service";

describe("listInvoicesForTenant", () => {
  it("returns invoices for a tenant, newest first", async () => {
    const [t] = await db.insert(tenants).values({ slug: "bill-1", name: "T", country: "EG" }).returning();
    await seedDefaultPlans();
    const sub = await startTrial(t.id, "basic");
    const provider = new ManualBillingProvider();
    const first = await provider.createInvoice({ tenantId: t.id, subscriptionId: sub.id, amount: "100", currency: "EGP" });
    await new Promise((r) => setTimeout(r, 10));
    const second = await provider.createInvoice({ tenantId: t.id, subscriptionId: sub.id, amount: "200", currency: "EGP" });

    const invoices = await listInvoicesForTenant(t.id);
    expect(invoices.map((i) => i.id)).toEqual([second.id, first.id]);
  });

  it("returns an empty array for a tenant with no invoices", async () => {
    const [t] = await db.insert(tenants).values({ slug: "bill-2", name: "T", country: "EG" }).returning();
    expect(await listInvoicesForTenant(t.id)).toEqual([]);
  });
});
```

- [ ] **Step 16: Run it to verify it fails**

Run: `npx vitest run src/server/billing/service.test.ts`
Expected: FAIL — `./service` module doesn't exist.

- [ ] **Step 17: Implement `src/server/billing/service.ts`**

```ts
import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { invoices, type Invoice } from "./schema";

/** invoices is a control table (like subscriptions/plans) → plain db, matching ManualBillingProvider. */
export async function listInvoicesForTenant(tenantId: string): Promise<Invoice[]> {
  return db.select().from(invoices).where(eq(invoices.tenantId, tenantId)).orderBy(desc(invoices.createdAt));
}
```

- [ ] **Step 18: Run it to verify it passes**

Run: `npx vitest run src/server/billing/service.test.ts`
Expected: PASS.

- [ ] **Step 19: Commit the service layer**

```bash
git add src/server/tenancy src/server/ordering src/server/subscription src/server/billing
git commit -m "feat: usage/invoice/plan queries for the Billing settings tab"
```

- [ ] **Step 20: Create the permission guard**

Create `src/app/dashboard/settings/billing-permission.ts`:

```ts
import { requireDashboardUser, type DashboardContext } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";

export async function requireBillingPermission(): Promise<DashboardContext> {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "billing:manage");
  return ctx;
}
```

- [ ] **Step 21: Create the actions**

Create `src/app/dashboard/settings/billing/actions.ts`:

```ts
"use server";
import { revalidatePath } from "next/cache";
import { requireBillingPermission } from "../billing-permission";
import { requestPlanUpgrade } from "@/server/tenancy/settings";

export async function requestUpgradeAction(planKey: string) {
  const { tenantId } = await requireBillingPermission();
  await requestPlanUpgrade(tenantId, planKey);
  revalidatePath("/dashboard/settings/billing");
}
```

- [ ] **Step 22: Create the page**

Create `src/app/dashboard/settings/billing/page.tsx`:

```tsx
import { requireBillingPermission } from "../billing-permission";
import { getActiveSubscription, getPlanForTenant, listPlans } from "@/server/subscription";
import { listBranches } from "@/server/branches/service";
import { listProducts } from "@/server/catalog/service";
import { listStaff } from "@/server/auth/staff";
import { ordersThisMonthCount } from "@/server/ordering/service";
import { listInvoicesForTenant } from "@/server/billing/service";
import { getUpgradeRequest } from "@/server/tenancy/settings";
import { requestUpgradeAction } from "./actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function UsageBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="eyebrow text-muted-foreground">{label}</span>
        <span className="font-display text-lg font-bold text-ink">
          {used}<span className="text-sm text-muted-foreground font-normal"> / {limit}</span>
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default async function BillingPage() {
  const { tenantId } = await requireBillingPermission();
  const [subscription, plan, branches, products, staff, ordersThisMonth, invoices, allPlans, upgradeRequest] =
    await Promise.all([
      getActiveSubscription(tenantId),
      getPlanForTenant(tenantId),
      listBranches(tenantId),
      listProducts(tenantId),
      listStaff(tenantId),
      ordersThisMonthCount(tenantId),
      listInvoicesForTenant(tenantId),
      listPlans(),
      getUpgradeRequest(tenantId),
    ]);

  if (!plan || !subscription) {
    return <EmptyState title="No active plan" description="Contact support to set up billing for this restaurant." />;
  }

  return (
    <>
      <PageHeader
        eyebrow="Billing"
        title={plan.name}
        description={
          `${Number(plan.priceMonthly).toFixed(0)} ${plan.currency}/month · ${subscription.status}` +
          (subscription.status === "trialing" && subscription.trialEndsAt
            ? ` — trial ends ${subscription.trialEndsAt.toLocaleDateString()}`
            : "")
        }
      />

      <Card className="p-5 mb-6 grid grid-cols-2 md:grid-cols-4 gap-6">
        <UsageBar label="Branches" used={branches.length} limit={plan.limits.branches} />
        <UsageBar label="Products" used={products.length} limit={plan.limits.products} />
        <UsageBar label="Staff" used={staff.length} limit={plan.limits.staff} />
        <UsageBar label="Orders this month" used={ordersThisMonth} limit={plan.limits.orders_per_month} />
      </Card>

      <h2 className="eyebrow text-primary mb-3">Invoices</h2>
      {invoices.length === 0 ? (
        <EmptyState title="No invoices yet" description="Invoices will appear here once billing starts." />
      ) : (
        <Card className="p-0 overflow-hidden mb-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Method</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((inv) => (
                <TableRow key={inv.id}>
                  <TableCell>{inv.createdAt.toLocaleDateString()}</TableCell>
                  <TableCell className="font-mono">{Number(inv.amount).toFixed(2)} {inv.currency}</TableCell>
                  <TableCell><Badge variant={inv.status === "paid" ? "default" : "outline"}>{inv.status}</Badge></TableCell>
                  <TableCell className="text-muted-foreground">{inv.method ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <h2 className="eyebrow text-primary mb-3">Plans</h2>
      <div className="grid md:grid-cols-3 gap-4">
        {allPlans.map((p) => {
          const isCurrent = p.id === plan.id;
          const isHigher = Number(p.priceMonthly) > Number(plan.priceMonthly);
          const requested = upgradeRequest?.planKey === p.key;
          return (
            <Card key={p.id} className={isCurrent ? "p-5 ring-2 ring-primary" : "p-5"}>
              <h3 className="font-display text-lg font-bold text-ink">{p.name}</h3>
              <p className="font-display text-2xl font-bold mt-1">
                {Number(p.priceMonthly).toFixed(0)} <span className="text-sm text-muted-foreground font-normal">{p.currency}/mo</span>
              </p>
              <ul className="text-sm text-muted-foreground mt-3 space-y-1">
                <li>{p.limits.branches} branches · {p.limits.staff} staff</li>
                <li>{p.limits.products} products</li>
                <li>{p.limits.orders_per_month.toLocaleString()} orders/month</li>
              </ul>
              {isCurrent ? (
                <Badge className="mt-4">Current plan</Badge>
              ) : isHigher ? (
                requested ? (
                  <Badge variant="outline" className="mt-4">
                    Requested {new Date(upgradeRequest!.requestedAt).toLocaleDateString()}
                  </Badge>
                ) : (
                  <ToastForm action={requestUpgradeAction.bind(null, p.key)} successMessage="Upgrade requested — we'll be in touch" className="mt-4">
                    <SubmitButton variant="outline" size="sm">Request upgrade</SubmitButton>
                  </ToastForm>
                )
              ) : null}
            </Card>
          );
        })}
      </div>
    </>
  );
}
```

- [ ] **Step 23: Typecheck and build**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx next build`
Expected: build succeeds; `/dashboard/settings/billing` compiles.

- [ ] **Step 24: Commit**

```bash
git add src/app/dashboard/settings/billing-permission.ts src/app/dashboard/settings/billing
git commit -m "feat(dashboard): Billing/Plan settings tab"
```

---

### Task 7: Final integration — e2e coverage, full suite, manual pass

**Files:**
- Modify: `tests/e2e/dashboard.spec.ts`

**Interfaces:**
- Consumes: seeded accounts from `scripts/seed.ts` (`owner@roma.com` / `owner1234`, `staff@roma.com` / `staff1234`, tenant slug `roma`) — no seed script changes needed, these already exist.

- [ ] **Step 1: Add settings-visibility e2e tests**

Append to `tests/e2e/dashboard.spec.ts`:

```ts
test("owner sees every settings tab and lands on Business Profile", async ({ page }) => {
  await page.goto("/login");
  await page.getByPlaceholder("e.g. roma").fill("roma");
  await page.locator('input[name="email"]').fill("owner@roma.com");
  await page.locator('input[name="password"]').fill("owner1234");
  await page.locator('form button[type="submit"]').click();

  await page.goto("/dashboard/settings");
  await expect(page).toHaveURL(/\/dashboard\/settings\/profile/);
  for (const label of ["Business Profile", "WhatsApp", "Fulfillment", "Staff", "Billing"]) {
    await expect(page.getByRole("link", { name: label })).toBeVisible();
  }
});

test("staff cannot reach settings and is redirected to Orders", async ({ page }) => {
  await page.goto("/login");
  await page.getByPlaceholder("e.g. roma").fill("roma");
  await page.locator('input[name="email"]').fill("staff@roma.com");
  await page.locator('input[name="password"]').fill("staff1234");
  await page.locator('form button[type="submit"]').click();

  await page.goto("/dashboard/settings");
  await expect(page).toHaveURL(/\/dashboard\/orders/);
});
```

- [ ] **Step 2: Run the full vitest suite**

Run: `npx vitest run`
Expected: all tests pass, including every test added in Tasks 1–6.

- [ ] **Step 3: Run the Playwright e2e suite**

Run: `npx playwright test tests/e2e/dashboard.spec.ts`
Expected: all tests pass (requires `npm run db:seed` to have been run against the test/dev database first, per the file's existing header comment).

- [ ] **Step 4: Final typecheck and build**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx next build`
Expected: build succeeds; route list includes `/dashboard/settings`, `/dashboard/settings/profile`, `/dashboard/settings/whatsapp`, `/dashboard/settings/fulfillment`, `/dashboard/settings/staff`, `/dashboard/settings/billing`, and does **not** include `/dashboard/fulfillment`.

- [ ] **Step 5: Manual QA pass**

Using the seeded accounts (`npm run db:seed` if not already run):
1. Log in as `owner@roma.com` — confirm all 5 Settings tabs are visible and each loads without error.
2. On the WhatsApp tab, save a number like `+201234567890`, confirm the toast, reload, confirm it's still populated, click "Send test message" and confirm it opens `wa.me` with the preview text.
3. Place a storefront order at `http://roma.serveos.localhost:3000` (or the configured dev host) as a customer, and on the resulting `/order/[token]` confirmation page confirm the "Send order via WhatsApp" button appears and pre-fills the correct order summary.
4. On the Staff tab, add a staff member, confirm they appear in the table, change their role, then deactivate them and confirm the row updates.
5. On the Billing tab, confirm usage bars show real counts (branches/products/staff/orders), confirm invoices render (or the empty state if none), and click "Request upgrade" on a higher plan — confirm it flips to a "Requested" badge.
6. Log in as `manager@roma.com` — confirm only WhatsApp, Fulfillment, and Staff tabs are visible (no Business Profile, no Billing).
7. Log in as `staff@roma.com` — confirm navigating to `/dashboard/settings` redirects to Orders and no Settings link appears in the sidebar.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/dashboard.spec.ts
git commit -m "test(dashboard): e2e coverage for settings tab visibility per role"
```
