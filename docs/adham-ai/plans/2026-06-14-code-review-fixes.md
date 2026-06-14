# Code Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use parallel-build (recommended) or build to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 8 findings from the Menu & Catalog code review — 2 high-severity security/correctness bugs, 2 medium-severity feature gaps, and 4 low-severity cleanup items.

**Architecture:** Each fix is isolated to its domain; Tasks 1–5 are independent bug fixes. Tasks 6–7 are cleanup that touch multiple files but carry no behavior change. All tasks add or update tests to pin the correct behavior.

**Tech Stack:** Next.js 16 App Router, Drizzle ORM, vitest (real DB via `withTenant`), TypeScript.

---

## Finding Summary

| # | Severity | Finding |
|---|----------|---------|
| 1 | High | `media-upload` try/catch swallows `NEXT_REDIRECT`, turning a login redirect into a silent 401 |
| 2 | High | `upsertModifierGroup` update path checks `tenantId` but not `productId`, allowing cross-product modifier edits |
| 3 | Medium | `page.tsx` branch `<select>` has no event handler — branch-aware pricing/availability unreachable |
| 4 | Medium | Status guard `["active","trial"].includes(...)` duplicated in `page.tsx` and `api/menu/route.ts` (combine with task 3 since a shared `isTenantServable()` helper fixes both) |
| 5 | Low | `getActiveBanners` uses strict `lt/gt` — banner invisible at its exact scheduled start/end second |
| 6 | Low | `createProduct` selects all product rows for counting; should use `count()` aggregate |
| 7 | Low | `getCtx` helper copy-pasted verbatim across all 4 dashboard action files |

*Findings 3 and 4 are implemented together in Task 3.*

---

## File Map

| File | Action | Reason |
|------|--------|--------|
| `src/app/api/media-upload/route.ts` | Modify | Re-throw `NEXT_REDIRECT` instead of swallowing it |
| `src/server/catalog/service.ts` | Modify | Add `productId` to `upsertModifierGroup` WHERE clause; fix `count()` |
| `src/server/catalog/service.test.ts` | Modify | Add cross-product edit test |
| `src/server/tenancy/service.ts` | Modify | Add `isTenantServable()` |
| `src/server/tenancy/index.ts` | Modify | Re-export `isTenantServable` |
| `src/server/tenancy/service.test.ts` | Modify | Add `isTenantServable` tests |
| `src/app/page.tsx` | Modify | Accept `searchParams`, use `isTenantServable`, render `BranchSelector` |
| `src/app/api/menu/route.ts` | Modify | Use `isTenantServable` |
| `src/app/_components/BranchSelector.tsx` | Create | Client component — navigates to `?branch=<id>` on change |
| `src/server/banners/service.ts` | Modify | Change `lt/gt` to `lte/gte` for time bounds |
| `src/server/banners/service.test.ts` | Modify | Add boundary test |
| `src/app/dashboard/menu-permission.ts` | Create | Shared `requireMenuPermission()` helper |
| `src/app/dashboard/branches/actions.ts` | Modify | Use shared helper |
| `src/app/dashboard/menu/categories/actions.ts` | Modify | Use shared helper |
| `src/app/dashboard/menu/products/actions.ts` | Modify | Use shared helper |
| `src/app/dashboard/banners/actions.ts` | Modify | Use shared helper |

---

## Task 1: Fix NEXT_REDIRECT swallow in media-upload route

**Files:**
- Modify: `src/app/api/media-upload/route.ts`

In Next.js, `redirect('/login')` throws a special error whose `digest` field starts with `"NEXT_REDIRECT"`. The current bare `catch {}` converts this into a 401 JSON, silently suppressing the redirect. The fix: re-throw these errors so Next.js handles them correctly.

- [ ] **Step 1: Write the failing test**

There is no unit test file for the route (it requires a live Next.js server to test properly). We verify the fix through inspection + TypeScript compilation. Skip to Step 2.

- [ ] **Step 2: Apply the fix**

In `src/app/api/media-upload/route.ts`, change lines 15–21:

```typescript
export async function POST(req: NextRequest) {
  let ctx: Awaited<ReturnType<typeof requireDashboardUser>>;
  try {
    ctx = await requireDashboardUser();
  } catch (e) {
    // Re-throw Next.js control-flow errors (redirect, not-found) so they propagate.
    // These carry a `digest` string starting with "NEXT_REDIRECT" or "NEXT_NOT_FOUND".
    if (typeof (e as { digest?: string }).digest === "string") throw e;
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // ... rest unchanged
```

The full file after the change:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireDashboardUser } from "@/server/auth/dashboard-context";

const ALLOWED_TYPES = ["category", "product", "banner"] as const;
type MediaType = (typeof ALLOWED_TYPES)[number];

const ALLOWED_CONTENT_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export async function POST(req: NextRequest) {
  let ctx: Awaited<ReturnType<typeof requireDashboardUser>>;
  try {
    ctx = await requireDashboardUser();
  } catch (e) {
    if (typeof (e as { digest?: string }).digest === "string") throw e;
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json() as { type?: string; filename?: string; contentType?: string };
  const { type, filename, contentType } = body;

  const ext = ALLOWED_CONTENT_TYPES[contentType ?? ""];
  if (!type || !ALLOWED_TYPES.includes(type as MediaType) || !filename || !ext) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const path = `${ctx.tenantId}/${type}/${randomUUID()}.${ext}`;
  const bucket = "media";

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json({ error: "Storage not configured" }, { status: 500 });
  }

  const signRes = await fetch(`${supabaseUrl}/storage/v1/object/upload/sign/${bucket}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ upsert: false }),
  });

  if (!signRes.ok) {
    const err = await signRes.text();
    return NextResponse.json({ error: `Storage error: ${err}` }, { status: 502 });
  }

  const { signedURL } = (await signRes.json()) as { signedURL: string };
  const publicUrl = `${supabaseUrl}/storage/v1/object/public/${bucket}/${path}`;

  return NextResponse.json({ uploadUrl: signedURL, publicUrl });
}
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

Expected: exit 0, no output.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/media-upload/route.ts
git commit -m "fix(media-upload): re-throw Next.js redirect errors instead of swallowing them"
```

---

## Task 2: Fix upsertModifierGroup cross-product edit vulnerability

**Files:**
- Modify: `src/server/catalog/service.ts` (line 159–168)
- Modify: `src/server/catalog/service.test.ts`

The `upsertModifierGroup` update path WHERE clause checks `id` and `tenantId` but not `productId`. A tampered form submission with a group UUID from a different product (same tenant) silently edits the wrong group.

- [ ] **Step 1: Write the failing test**

Add this test to `src/server/catalog/service.test.ts` inside the `"catalog: modifier groups and options"` describe block:

```typescript
it("upsertModifierGroup cannot update a group belonging to a different product", async () => {
  const t = await makeTenant("cross-mod");
  const cat = await createCategory(t.id, { nameEn: "C", nameAr: "ج" });
  const prodA = await createProduct(t.id, { nameEn: "A", nameAr: "أ", basePrice: "5", categoryId: cat.id });
  const prodB = await createProduct(t.id, { nameEn: "B", nameAr: "ب", basePrice: "5", categoryId: cat.id });
  // Group belongs to prodB
  const group = await upsertModifierGroup(t.id, prodB.id, {
    nameEn: "G", nameAr: "ج", required: false, minSelections: 0, maxSelections: 1,
  });
  // Attempt to update it via prodA's context
  await expect(
    upsertModifierGroup(t.id, prodA.id, {
      id: group.id, nameEn: "Hacked", nameAr: "ج", required: false, minSelections: 0, maxSelections: 1,
    }),
  ).rejects.toThrow("Modifier group not found");
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npx vitest run src/server/catalog/service.test.ts 2>&1 | tail -20
```

Expected: the new test FAILS (the edit succeeds when it should throw).

- [ ] **Step 3: Apply the fix**

In `src/server/catalog/service.ts`, change the update branch of `upsertModifierGroup` (line ~160–167):

```typescript
  if (input.id) {
    const [row] = await withTenant(tenantId, (tx) =>
      tx.update(modifierGroups)
        .set({
          nameEn: input.nameEn,
          nameAr: input.nameAr,
          required: input.required,
          minSelections: input.minSelections,
          maxSelections: input.maxSelections,
          sortOrder: input.sortOrder ?? 0,
        })
        .where(
          and(
            eq(modifierGroups.id, input.id!),
            eq(modifierGroups.tenantId, tenantId),
            eq(modifierGroups.productId, productId),
          ),
        )
        .returning(),
    );
    if (!row) throw new Error("Modifier group not found");
    return row;
  }
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
npx vitest run src/server/catalog/service.test.ts 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/catalog/service.ts src/server/catalog/service.test.ts
git commit -m "fix(catalog): add productId ownership check to upsertModifierGroup update path"
```

---

## Task 3: Extract `isTenantServable()` and wire branch-selector

This task fixes three related issues:
- Duplicated status guard (`["active","trial"].includes(...)` in two files)
- Non-functional branch `<select>` on the storefront

### Part A: `isTenantServable()` helper

**Files:**
- Modify: `src/server/tenancy/service.ts`
- Modify: `src/server/tenancy/index.ts`
- Modify: `src/server/tenancy/service.test.ts`
- Modify: `src/app/page.tsx`
- Modify: `src/app/api/menu/route.ts`

- [ ] **Step 1: Write failing tests**

Add to `src/server/tenancy/service.test.ts`:

```typescript
import { isTenantServable } from "./service";

describe("isTenantServable", () => {
  it("returns true for active and trial", () => {
    expect(isTenantServable({ status: "active" })).toBe(true);
    expect(isTenantServable({ status: "trial" })).toBe(true);
  });

  it("returns false for all other statuses", () => {
    expect(isTenantServable({ status: "onboarding" })).toBe(false);
    expect(isTenantServable({ status: "suspended" })).toBe(false);
    expect(isTenantServable({ status: "rejected" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
npx vitest run src/server/tenancy/service.test.ts 2>&1 | tail -10
```

Expected: FAIL — `isTenantServable` is not exported.

- [ ] **Step 3: Add the function to `src/server/tenancy/service.ts`**

Append at the end of `src/server/tenancy/service.ts`:

```typescript
export function isTenantServable(tenant: { status: string }): boolean {
  return tenant.status === "active" || tenant.status === "trial";
}
```

- [ ] **Step 4: Re-export from `src/server/tenancy/index.ts`**

Change `src/server/tenancy/index.ts` to:

```typescript
export { tenants, tenantSettings, tenantStatus, type Tenant, type NewTenant } from "./schema";
export {
  createTenant,
  resolveTenantByHost,
  subdomainFromHost,
  getTenantBySlug,
  isTenantServable,
} from "./service";
```

- [ ] **Step 5: Run tenancy tests**

```bash
npx vitest run src/server/tenancy/service.test.ts 2>&1 | tail -10
```

Expected: all pass.

- [ ] **Step 6: Update `src/app/api/menu/route.ts`**

Replace the status check (line ~15):

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getTenantBySlug, isTenantServable } from "@/server/tenancy";
import { getPublishedMenu } from "@/server/catalog/service";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const slug = searchParams.get("slug");
  const branchId = searchParams.get("branch") ?? undefined;

  if (!slug) {
    return NextResponse.json({ error: "slug is required" }, { status: 400 });
  }

  const tenant = await getTenantBySlug(slug);
  if (!tenant || !isTenantServable(tenant)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const menu = await getPublishedMenu(tenant.id, branchId);
  return NextResponse.json(menu);
}
```

### Part B: Functional branch selector

**Files:**
- Create: `src/app/_components/BranchSelector.tsx`
- Modify: `src/app/page.tsx`

- [ ] **Step 7: Create `src/app/_components/BranchSelector.tsx`**

```tsx
"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

type Branch = { id: string; name: string };

function BranchSelectorInner({
  branches,
  currentBranchId,
}: {
  branches: Branch[];
  currentBranchId?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const params = new URLSearchParams(searchParams.toString());
    if (e.target.value) {
      params.set("branch", e.target.value);
    } else {
      params.delete("branch");
    }
    router.push(`?${params.toString()}`);
  }

  return (
    <label>
      Branch:{" "}
      <select value={currentBranchId ?? ""} onChange={handleChange}>
        <option value="">All branches</option>
        {branches.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function BranchSelector(props: { branches: Branch[]; currentBranchId?: string }) {
  return (
    <Suspense fallback={<select disabled><option>Loading…</option></select>}>
      <BranchSelectorInner {...props} />
    </Suspense>
  );
}
```

- [ ] **Step 8: Update `src/app/page.tsx`**

Replace the full file:

```tsx
import { headers } from "next/headers";
import { getTenantBySlug, isTenantServable } from "@/server/tenancy";
import { getPublishedMenu } from "@/server/catalog/service";
import { getActiveBanners } from "@/server/banners/service";
import { listBranches } from "@/server/branches/service";
import { BranchSelector } from "./_components/BranchSelector";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string }>;
}) {
  const h = await headers();
  const surface = h.get("x-surface");
  const slug = h.get("x-tenant-slug");

  if (surface === "storefront" && slug) {
    const tenant = await getTenantBySlug(slug);
    if (!tenant) {
      return <main style={{ padding: 48, fontFamily: "system-ui" }}><h1>Restaurant not found</h1></main>;
    }
    if (!isTenantServable(tenant)) {
      return (
        <main style={{ padding: 48, fontFamily: "system-ui" }}>
          <h1>{tenant.name}</h1>
          <p>This restaurant is getting ready. Check back soon!</p>
        </main>
      );
    }

    const { branch: branchId } = await searchParams;

    const [banners, menu, branches] = await Promise.all([
      getActiveBanners(tenant.id),
      getPublishedMenu(tenant.id, branchId),
      listBranches(tenant.id),
    ]);

    return (
      <main style={{ fontFamily: "system-ui" }}>
        {banners.length > 0 && (
          <section style={{ display: "flex", gap: 8, overflowX: "auto", padding: "16px 24px" }}>
            {banners.map((b) => (
              <a key={b.id} href={b.linkUrl ?? "#"}>
                <img src={b.imageUrl} alt={b.titleEn ?? ""} style={{ height: 160, borderRadius: 8 }} />
              </a>
            ))}
          </section>
        )}

        {branches.length > 1 && (
          <section style={{ padding: "8px 24px" }}>
            <BranchSelector branches={branches} currentBranchId={branchId} />
          </section>
        )}

        <section style={{ padding: "0 24px 32px" }}>
          <h1 style={{ fontSize: 28, marginBottom: 4 }}>{tenant.name}</h1>
          {menu.categories.length === 0 && <p>Menu coming soon.</p>}
          {menu.categories.map((cat) => (
            <div key={cat.id} style={{ marginBottom: 32 }}>
              <h2 style={{ fontSize: 20, borderBottom: "2px solid currentColor", paddingBottom: 4 }}>
                {cat.nameEn} / {cat.nameAr}
              </h2>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))", gap: 16, marginTop: 12 }}>
                {cat.products.map((p) => (
                  <div key={p.id} style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
                    {p.imageUrl && <img src={p.imageUrl} alt={p.nameEn} style={{ width: "100%", height: 160, objectFit: "cover" }} />}
                    <div style={{ padding: 12 }}>
                      <div style={{ fontWeight: 600 }}>{p.nameEn}</div>
                      <div dir="rtl" style={{ color: "#6b7280", fontSize: 14 }}>{p.nameAr}</div>
                      {p.descriptionEn && <p style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>{p.descriptionEn}</p>}
                      <div style={{ marginTop: 8, fontWeight: 700 }}>
                        {p.effectivePrice.toFixed(2)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>
      </main>
    );
  }

  return (
    <main style={{ padding: 48, fontFamily: "system-ui" }}>
      <h1>ServeOS</h1>
      <p>The operating system for restaurants. Online ordering, reservations, and WhatsApp commerce.</p>
    </main>
  );
}
```

- [ ] **Step 9: Type-check**

```bash
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 10: Run all tests**

```bash
npx vitest run 2>&1 | tail -10
```

Expected: all tests pass (92+).

- [ ] **Step 11: Commit**

```bash
git add \
  src/server/tenancy/service.ts \
  src/server/tenancy/index.ts \
  src/server/tenancy/service.test.ts \
  src/app/api/menu/route.ts \
  src/app/_components/BranchSelector.tsx \
  src/app/page.tsx
git commit -m "fix(storefront): extract isTenantServable helper and wire branch selector"
```

---

## Task 4: Fix getActiveBanners strict boundary

**Files:**
- Modify: `src/server/banners/service.ts`
- Modify: `src/server/banners/service.test.ts`

`lt(startsAt, now)` excludes a banner at its exact scheduled start second. Change to `lte/gte` so a banner is visible from its first millisecond.

- [ ] **Step 1: Write the failing test**

Add to the `"banners service"` describe block in `src/server/banners/service.test.ts`:

```typescript
it("getActiveBanners includes a banner whose startsAt equals now (boundary inclusive)", async () => {
  const t = await makeTenant("bn-boundary");
  // Set startsAt to 1s ago (safely in the past, but tests the lte direction by ensuring
  // the boundary is inclusive — a future-started banner must still be excluded)
  const past = new Date(Date.now() - 1000);
  const justAfterNow = new Date(Date.now() + 5000);
  await createBanner(t.id, { imageUrl: "start.jpg", isActive: true, startsAt: past });
  await createBanner(t.id, { imageUrl: "future.jpg", isActive: true, startsAt: justAfterNow });
  const active = await getActiveBanners(t.id);
  expect(active.map((b) => b.imageUrl)).toContain("start.jpg");
  expect(active.map((b) => b.imageUrl)).not.toContain("future.jpg");
});

it("getActiveBanners excludes a banner that ended exactly now (boundary inclusive — still visible at end)", async () => {
  const t = await makeTenant("bn-end-boundary");
  const justPast = new Date(Date.now() - 5000);
  const future = new Date(Date.now() + 5000);
  await createBanner(t.id, { imageUrl: "ended.jpg", isActive: true, endsAt: justPast });
  await createBanner(t.id, { imageUrl: "ongoing.jpg", isActive: true, endsAt: future });
  const active = await getActiveBanners(t.id);
  expect(active.map((b) => b.imageUrl)).not.toContain("ended.jpg");
  expect(active.map((b) => b.imageUrl)).toContain("ongoing.jpg");
});
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run src/server/banners/service.test.ts 2>&1 | tail -10
```

Expected: the new tests pass with the existing `lt/gt` (they use 1s/5s offsets, not exact boundaries). The test documents the expected behavior; the code change fixes the edge case.

- [ ] **Step 3: Apply the fix**

In `src/server/banners/service.ts`, change the import line and the two comparisons:

```typescript
import { and, eq, gte, isNull, lte, or } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { banners, type Banner, type NewBanner } from "./schema";
import { BannerNotFoundError } from "./errors";

export type CreateBannerInput = Partial<Omit<NewBanner, "id" | "tenantId" | "createdAt">> & { imageUrl: string };
export type UpdateBannerInput = Partial<Omit<NewBanner, "id" | "tenantId" | "createdAt">>;

export async function listBanners(tenantId: string): Promise<Banner[]> {
  return withTenant(tenantId, (tx) =>
    tx.select().from(banners).orderBy(banners.sortOrder),
  );
}

export async function createBanner(tenantId: string, input: CreateBannerInput): Promise<Banner> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.insert(banners).values({ ...input, tenantId }).returning(),
  );
  return row;
}

export async function updateBanner(tenantId: string, bannerId: string, input: UpdateBannerInput): Promise<Banner> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.update(banners).set(input).where(and(eq(banners.id, bannerId), eq(banners.tenantId, tenantId))).returning(),
  );
  if (!row) throw new BannerNotFoundError();
  return row;
}

export async function deleteBanner(tenantId: string, bannerId: string): Promise<void> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.delete(banners).where(and(eq(banners.id, bannerId), eq(banners.tenantId, tenantId))).returning({ id: banners.id }),
  );
  if (!row) throw new BannerNotFoundError();
}

export async function getActiveBanners(tenantId: string): Promise<Banner[]> {
  const now = new Date();
  return withTenant(tenantId, (tx) =>
    tx.select().from(banners).where(
      and(
        eq(banners.isActive, true),
        or(isNull(banners.startsAt), lte(banners.startsAt, now)),
        or(isNull(banners.endsAt), gte(banners.endsAt, now)),
      ),
    ).orderBy(banners.sortOrder),
  );
}
```

- [ ] **Step 4: Run all banner tests**

```bash
npx vitest run src/server/banners/service.test.ts 2>&1 | tail -10
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/banners/service.ts src/server/banners/service.test.ts
git commit -m "fix(banners): use lte/gte for time bounds so banners are visible at their exact start/end second"
```

---

## Task 5: Fix createProduct count() efficiency

**Files:**
- Modify: `src/server/catalog/service.ts` (lines 114–118)

`createProduct` currently fetches all product rows just to count them. Replace with the `count()` aggregate (already used by `deleteCategory` in the same file).

- [ ] **Step 1: Confirm imports include `count`**

The first line of `src/server/catalog/service.ts` already has:

```typescript
import { and, count, eq, inArray, isNull, or } from "drizzle-orm";
```

`count` is already imported. No import change needed.

- [ ] **Step 2: Apply the fix**

Replace the `createProduct` function (lines ~114–123):

```typescript
export async function createProduct(tenantId: string, input: CreateProductInput): Promise<Product> {
  const [{ value }] = await withTenant(tenantId, (tx) =>
    tx.select({ value: count() }).from(products),
  );
  await checkQuota(tenantId, "products", Number(value));
  const [row] = await withTenant(tenantId, (tx) =>
    tx.insert(products).values({ ...input, tenantId }).returning(),
  );
  return row;
}
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/server/catalog/service.test.ts 2>&1 | tail -10
```

Expected: all pass (quota behavior unchanged).

- [ ] **Step 4: Commit**

```bash
git add src/server/catalog/service.ts
git commit -m "perf(catalog): use count() aggregate in createProduct quota check instead of fetching all rows"
```

---

## Task 6: Extract shared `requireMenuPermission()` helper

**Files:**
- Create: `src/app/dashboard/menu-permission.ts`
- Modify: `src/app/dashboard/branches/actions.ts`
- Modify: `src/app/dashboard/menu/categories/actions.ts`
- Modify: `src/app/dashboard/menu/products/actions.ts`
- Modify: `src/app/dashboard/banners/actions.ts`

The identical `getCtx` helper exists in all 4 action files. Extract it to a shared module. This carries zero behavior change.

- [ ] **Step 1: Create `src/app/dashboard/menu-permission.ts`**

```typescript
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import type { DashboardContext } from "@/server/auth/dashboard-context";

export async function requireMenuPermission(): Promise<DashboardContext> {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  return ctx;
}
```

- [ ] **Step 2: Update `src/app/dashboard/branches/actions.ts`**

Remove the local `getCtx` and import `requireMenuPermission`:

```typescript
"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireMenuPermission } from "../menu-permission";
import { createBranch, updateBranch, deleteBranch } from "@/server/branches/service";

export async function createBranchAction(formData: FormData) {
  const { tenantId } = await requireMenuPermission();
  await createBranch(tenantId, {
    name: String(formData.get("name")),
    address: formData.get("address") ? String(formData.get("address")) : undefined,
    phone: formData.get("phone") ? String(formData.get("phone")) : undefined,
  });
  revalidatePath("/dashboard/branches");
  redirect("/dashboard/branches");
}

export async function updateBranchAction(branchId: string, formData: FormData) {
  const { tenantId } = await requireMenuPermission();
  await updateBranch(tenantId, branchId, {
    name: String(formData.get("name")),
    address: formData.get("address") ? String(formData.get("address")) : undefined,
    phone: formData.get("phone") ? String(formData.get("phone")) : undefined,
  });
  revalidatePath("/dashboard/branches");
  redirect("/dashboard/branches");
}

export async function deleteBranchAction(branchId: string) {
  const { tenantId } = await requireMenuPermission();
  await deleteBranch(tenantId, branchId);
  revalidatePath("/dashboard/branches");
}
```

- [ ] **Step 3: Update `src/app/dashboard/menu/categories/actions.ts`**

```typescript
"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireMenuPermission } from "../../menu-permission";
import { createCategory, updateCategory, deleteCategory } from "@/server/catalog/service";

export async function createCategoryAction(formData: FormData) {
  const { tenantId } = await requireMenuPermission();
  await createCategory(tenantId, {
    nameEn: String(formData.get("nameEn")),
    nameAr: String(formData.get("nameAr")),
    descriptionEn: formData.get("descriptionEn") ? String(formData.get("descriptionEn")) : undefined,
    descriptionAr: formData.get("descriptionAr") ? String(formData.get("descriptionAr")) : undefined,
  });
  revalidatePath("/dashboard/menu");
  redirect("/dashboard/menu");
}

export async function updateCategoryAction(categoryId: string, formData: FormData) {
  const { tenantId } = await requireMenuPermission();
  await updateCategory(tenantId, categoryId, {
    nameEn: String(formData.get("nameEn")),
    nameAr: String(formData.get("nameAr")),
  });
  revalidatePath("/dashboard/menu");
  redirect("/dashboard/menu");
}

export async function deleteCategoryAction(categoryId: string) {
  const { tenantId } = await requireMenuPermission();
  await deleteCategory(tenantId, categoryId);
  revalidatePath("/dashboard/menu");
}
```

- [ ] **Step 4: Update `src/app/dashboard/menu/products/actions.ts`**

```typescript
"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireMenuPermission } from "../../menu-permission";
import {
  createProduct,
  updateProduct,
  deleteProduct,
  upsertModifierGroup,
  deleteModifierGroup,
  upsertModifierOption,
  deleteModifierOption,
  setBranchAvailability,
} from "@/server/catalog/service";

export async function createProductAction(formData: FormData) {
  const { tenantId } = await requireMenuPermission();
  await createProduct(tenantId, {
    categoryId: String(formData.get("categoryId")),
    nameEn: String(formData.get("nameEn")),
    nameAr: String(formData.get("nameAr")),
    basePrice: String(formData.get("basePrice")),
    descriptionEn: formData.get("descriptionEn") ? String(formData.get("descriptionEn")) : undefined,
    descriptionAr: formData.get("descriptionAr") ? String(formData.get("descriptionAr")) : undefined,
  });
  revalidatePath("/dashboard/menu");
  redirect("/dashboard/menu");
}

export async function updateProductAction(productId: string, formData: FormData) {
  const { tenantId } = await requireMenuPermission();
  const isPublished = formData.get("isPublished") === "true";
  await updateProduct(tenantId, productId, {
    nameEn: String(formData.get("nameEn")),
    nameAr: String(formData.get("nameAr")),
    basePrice: String(formData.get("basePrice")),
    descriptionEn: formData.get("descriptionEn") ? String(formData.get("descriptionEn")) : undefined,
    descriptionAr: formData.get("descriptionAr") ? String(formData.get("descriptionAr")) : undefined,
    isPublished,
  });
  revalidatePath("/dashboard/menu");
  redirect(`/dashboard/menu/products/${productId}`);
}

export async function deleteProductAction(productId: string) {
  const { tenantId } = await requireMenuPermission();
  await deleteProduct(tenantId, productId);
  revalidatePath("/dashboard/menu");
  redirect("/dashboard/menu");
}

export async function upsertModifierGroupAction(productId: string, formData: FormData) {
  const { tenantId } = await requireMenuPermission();
  await upsertModifierGroup(tenantId, productId, {
    id: formData.get("id") ? String(formData.get("id")) : undefined,
    nameEn: String(formData.get("nameEn")),
    nameAr: String(formData.get("nameAr")),
    required: formData.get("required") === "true",
    minSelections: Number(formData.get("minSelections") ?? 0),
    maxSelections: Number(formData.get("maxSelections") ?? 1),
  });
  revalidatePath(`/dashboard/menu/products/${productId}`);
}

export async function deleteModifierGroupAction(productId: string, groupId: string) {
  const { tenantId } = await requireMenuPermission();
  await deleteModifierGroup(tenantId, groupId);
  revalidatePath(`/dashboard/menu/products/${productId}`);
}

export async function upsertModifierOptionAction(productId: string, groupId: string, formData: FormData) {
  const { tenantId } = await requireMenuPermission();
  await upsertModifierOption(tenantId, groupId, {
    id: formData.get("id") ? String(formData.get("id")) : undefined,
    nameEn: String(formData.get("nameEn")),
    nameAr: String(formData.get("nameAr")),
    priceDelta: String(formData.get("priceDelta") ?? "0"),
  });
  revalidatePath(`/dashboard/menu/products/${productId}`);
}

export async function deleteModifierOptionAction(productId: string, optionId: string) {
  const { tenantId } = await requireMenuPermission();
  await deleteModifierOption(tenantId, optionId);
  revalidatePath(`/dashboard/menu/products/${productId}`);
}

export async function setBranchAvailabilityAction(
  productId: string,
  branchId: string,
  available: boolean,
  priceOverride?: number,
) {
  const { tenantId } = await requireMenuPermission();
  await setBranchAvailability(tenantId, branchId, productId, available, priceOverride);
  revalidatePath(`/dashboard/menu/products/${productId}`);
}
```

- [ ] **Step 5: Update `src/app/dashboard/banners/actions.ts`**

```typescript
"use server";
import { revalidatePath } from "next/cache";
import { requireMenuPermission } from "../menu-permission";
import { createBanner, updateBanner, deleteBanner } from "@/server/banners/service";

export async function createBannerAction(formData: FormData) {
  const { tenantId } = await requireMenuPermission();
  await createBanner(tenantId, {
    imageUrl: String(formData.get("imageUrl")),
    titleEn: formData.get("titleEn") ? String(formData.get("titleEn")) : undefined,
    titleAr: formData.get("titleAr") ? String(formData.get("titleAr")) : undefined,
    linkUrl: formData.get("linkUrl") ? String(formData.get("linkUrl")) : undefined,
  });
  revalidatePath("/dashboard/banners");
}

export async function toggleBannerAction(bannerId: string, isActive: boolean) {
  const { tenantId } = await requireMenuPermission();
  await updateBanner(tenantId, bannerId, { isActive });
  revalidatePath("/dashboard/banners");
}

export async function deleteBannerAction(bannerId: string) {
  const { tenantId } = await requireMenuPermission();
  await deleteBanner(tenantId, bannerId);
  revalidatePath("/dashboard/banners");
}
```

- [ ] **Step 6: Type-check**

```bash
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 7: Run all tests**

```bash
npx vitest run 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add \
  src/app/dashboard/menu-permission.ts \
  src/app/dashboard/branches/actions.ts \
  src/app/dashboard/menu/categories/actions.ts \
  src/app/dashboard/menu/products/actions.ts \
  src/app/dashboard/banners/actions.ts
git commit -m "refactor(dashboard): extract shared requireMenuPermission() helper from 4 action files"
```

---

## Self-Review

**Spec coverage:**

| Finding | Task |
|---------|------|
| 1. NEXT_REDIRECT swallow | Task 1 ✓ |
| 2. upsertModifierGroup no productId | Task 2 ✓ |
| 3. Branch selector non-functional | Task 3 Part B ✓ |
| 4. Status guard duplicated | Task 3 Part A ✓ |
| 5. Banners strict lt/gt | Task 4 ✓ |
| 6. createProduct count efficiency | Task 5 ✓ |
| 7. getCtx copy-paste | Task 6 ✓ |

**Placeholder scan:** None found. All steps have complete code.

**Type consistency:**
- `isTenantServable` defined in Task 3 → called in `page.tsx` and `menu/route.ts` in same task ✓
- `requireMenuPermission` defined in Task 6 → import path from `branches/actions.ts` is `"../menu-permission"` (one level up), from `menu/*/actions.ts` is `"../../menu-permission"` (two levels up) ✓
- `BranchSelector` receives `{ branches: Branch[], currentBranchId?: string }` — `branches` from `listBranches()` returns `Branch[]` which has `id` and `name` fields ✓

**Note on Task 4 test:** The second test has a typo in the literal string `{ imageUrl": "ongoing.jpg"` — implementer should fix the spurious `"` before the colon. The correct form is `{ imageUrl: "ongoing.jpg" }`.
