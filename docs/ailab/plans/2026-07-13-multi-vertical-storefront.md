# Multi-Vertical Storefront Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use ailab:subagent-driven-development (recommended) or ailab:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture a tenant's trade (restaurant / retail / pharmacy / timber) at signup and render a distinct, per-vertical storefront template without touching the working restaurant experience or building any vertical-specific backend domain.

**Architecture:** Add a `vertical` enum + column to `tenants`. A new server-side `verticals.ts` holds the per-trade accent and storefront copy. The register page gains a trade picker that relabels the form and submits the chosen vertical. `page.tsx` routes the storefront to a per-vertical template component; each template is a distinct file that composes a shared `StorefrontShell` with its own accent + copy, reusing the existing neutral catalog components.

**Tech Stack:** Next.js 16 (App Router, server components + server actions), Drizzle ORM + PostgreSQL, Vitest (integration tests against a migrated test DB), TypeScript, Tailwind v4, lucide-react.

## Global Constraints

- The catalog/products/orders engine is vertical-neutral — templates differ in **terminology, accent, and a few labels only**, never in data shape.
- Do **not** delete or change the restaurant storefront behavior; extract it verbatim into `RestaurantStorefront`.
- Do **not** build barcodes, batch/expiry, dimensions, variants, or units of measure (all remain "Soon").
- Keep the four landing-page accents consistent: restaurant `#F0522B`, retail `#2DD4C4`, pharmacy `#38D08C`, timber `#E8A33D`.
- Tests run against a Supabase test DB; the schema is applied automatically by `vitest` global setup from `./drizzle`, so every migration must be generated and committed.
- Follow existing patterns: server actions in `actions.ts`, Drizzle via `db`, tests use `db` + the `beforeEach` truncate harness.

---

## Task 1: Add `vertical` enum + column to `tenants`

**Files:**
- Modify: `src/server/tenancy/schema.ts` (add enum + column)
- Modify: `src/server/tenancy/schema.test.ts` (add default-value test)

**Interfaces:**
- Produces: `vertical` enum and `tenants.vertical` column; `Tenant.vertical: "restaurant" | "retail" | "pharmacy" | "timber"`.

- [ ] **Step 1: Write the failing test**

In `src/server/tenancy/schema.test.ts`, add:

```ts
  it("defaults vertical to restaurant", async () => {
    const [t] = await db
      .insert(tenants)
      .values({ slug: "vdef", name: "V Default", country: "EG" })
      .returning();
    expect(t.vertical).toBe("restaurant");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/tenancy/schema.test.ts`
Expected: FAIL — `tenants.vertical` does not exist (TS error / column missing).

- [ ] **Step 3: Add the enum and column**

In `src/server/tenancy/schema.ts`, add the enum (the file already imports `pgEnum`):

```ts
export const vertical = pgEnum("vertical", ["restaurant", "retail", "pharmacy", "timber"]);
```

Add the column inside the `tenants` table definition (after `theme`):

```ts
  vertical: vertical("vertical").notNull().default("restaurant"),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/tenancy/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/tenancy/schema.ts src/server/tenancy/schema.test.ts
git commit -m "feat(tenancy): add vertical enum + column to tenants"
```

---

## Task 2: Vertical config module + tests

**Files:**
- Create: `src/server/tenancy/verticals.ts`
- Create: `src/server/tenancy/verticals.test.ts`

**Interfaces:**
- Produces: `VERTICAL_IDS`, `VerticalId`, `VERTICAL_ACCENTS`, `VerticalStorefrontCopy`, `VERTICAL_STOREFRONT_COPY`, `selectStorefrontTemplate(vertical)`. Consumed by Tasks 4, 5, and 6.

- [ ] **Step 1: Write the failing test**

`src/server/tenancy/verticals.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  VERTICAL_IDS,
  VERTICAL_ACCENTS,
  VERTICAL_STOREFRONT_COPY,
  selectStorefrontTemplate,
  type VerticalId,
} from "./verticals";

describe("verticals config", () => {
  it("defines the four trades with distinct accents", () => {
    expect(VERTICAL_IDS).toEqual(["restaurant", "retail", "pharmacy", "timber"]);
    expect(new Set(Object.values(VERTICAL_ACCENTS)).size).toBe(4);
  });

  it("only the restaurant shows the WhatsApp CTA", () => {
    (Object.keys(VERTICAL_STOREFRONT_COPY) as VerticalId[]).forEach((v) => {
      expect(VERTICAL_STOREFRONT_COPY[v].showWhatsapp).toBe(v === "restaurant");
    });
  });

  it("selectStorefrontTemplate falls back to restaurant for unknown values", () => {
    expect(selectStorefrontTemplate("retail")).toBe("retail");
    expect(selectStorefrontTemplate(null)).toBe("restaurant");
    expect(selectStorefrontTemplate("bogus" as VerticalId)).toBe("restaurant");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/tenancy/verticals.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

`src/server/tenancy/verticals.ts`:

```ts
export const VERTICAL_IDS = ["restaurant", "retail", "pharmacy", "timber"] as const;
export type VerticalId = (typeof VERTICAL_IDS)[number];

export const VERTICAL_ACCENTS: Record<VerticalId, string> = {
  restaurant: "#F0522B",
  retail: "#2DD4C4",
  pharmacy: "#38D08C",
  timber: "#E8A33D",
};

export type VerticalStorefrontCopy = {
  /** Section heading above the catalog (Menu / Shop / Yard). */
  menuHeading: string;
  /** Whether the storefront footer renders the WhatsApp contact CTA. */
  showWhatsapp: boolean;
  /** Title shown when the tenant has no published items. */
  emptyMenuTitle: string;
  /** Description shown when the tenant has no published items. */
  emptyMenuDesc: string;
};

export const VERTICAL_STOREFRONT_COPY: Record<VerticalId, VerticalStorefrontCopy> = {
  restaurant: {
    menuHeading: "Menu",
    showWhatsapp: true,
    emptyMenuTitle: "Menu coming soon",
    emptyMenuDesc: "This restaurant hasn't published a menu yet.",
  },
  retail: {
    menuHeading: "Shop",
    showWhatsapp: false,
    emptyMenuTitle: "Catalog coming soon",
    emptyMenuDesc: "This shop hasn't published its catalog yet.",
  },
  pharmacy: {
    menuHeading: "Shop",
    showWhatsapp: false,
    emptyMenuTitle: "Catalog coming soon",
    emptyMenuDesc: "This pharmacy hasn't published its catalog yet.",
  },
  timber: {
    menuHeading: "Yard",
    showWhatsapp: false,
    emptyMenuTitle: "Yard list coming soon",
    emptyMenuDesc: "This yard hasn't published its stock list yet.",
  },
};

/** Resolve the storefront template for a tenant's vertical. Unknown → restaurant. */
export function selectStorefrontTemplate(vertical: VerticalId | null | undefined): VerticalId {
  return vertical && (VERTICAL_IDS as readonly string[]).includes(vertical) ? vertical : "restaurant";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/tenancy/verticals.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/tenancy/verticals.ts src/server/tenancy/verticals.test.ts
git commit -m "feat(tenancy): add per-vertical storefront config"
```

---

## Task 3: Generate and apply the migration

**Files:**
- Create: `drizzle/0014_*.sql` + `drizzle/meta/_journal.json` update (generated by drizzle-kit)

**Interfaces:**
- Produces: migrated `tenants.vertical` in both local and test databases.

- [ ] **Step 1: Generate the migration**

Run: `npm run db:generate`
Expected: a new file `drizzle/0014_*.sql` is created. Inspect it; it must contain:

```sql
CREATE TYPE "public"."vertical" AS ENUM('restaurant', 'retail', 'pharmacy', 'timber');--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "vertical" "vertical" DEFAULT 'restaurant' NOT NULL;
```

- [ ] **Step 2: Apply to the local database**

Run: `npm run db:migrate`
Expected: exit 0, no errors.

- [ ] **Step 3: Verify the test DB applies it on next test run**

Run: `npx vitest run src/server/tenancy/schema.test.ts`
Expected: PASS (global setup migrates the test DB from `./drizzle`; the new column is now present).

- [ ] **Step 4: Commit**

```bash
git add drizzle
git commit -m "migrate: add vertical column to tenants"
```

---

## Task 4: Persist `vertical` at registration

**Files:**
- Modify: `src/server/onboarding/service.ts` (rename `registerRestaurant` → `registerTenant`, accept + validate + persist `vertical`)
- Modify: `src/server/onboarding/index.ts` (re-export rename)
- Modify: `src/app/register/actions.ts` (read `vertical`, pass to service)
- Modify: `src/server/onboarding/service.test.ts` (rename + add `vertical`; new tests)
- Modify: `src/server/platform/service.test.ts` (rename + add `vertical`)

**Interfaces:**
- Consumes: `VERTICAL_IDS`, `VerticalId` from `@/server/tenancy/verticals` (Task 2).
- Produces: `registerTenant(input: RegisterInput & { vertical: VerticalId })`: persists `tenants.vertical`.

- [ ] **Step 1: Write the failing tests**

In `src/server/onboarding/service.test.ts`, update the import and `describe` name, change every `registerRestaurant(` call to `registerTenant(` and add `vertical: "restaurant"` to each input object. Then add:

```ts
  it("persists the chosen vertical", async () => {
    await seedDefaultPlans();
    const { tenantId } = await registerTenant({
      restaurantName: "Wood Co", slug: "woodco", country: "EG",
      ownerName: "W", email: "w@w.com", password: "x", vertical: "timber",
    });
    const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(t.vertical).toBe("timber");
  });

  it("rejects an invalid vertical", async () => {
    await seedDefaultPlans();
    await expect(
      registerTenant({
        restaurantName: "X", slug: "xv", country: "EG",
        ownerName: "X", email: "x@x.com", password: "x", vertical: "spaceship" as VerticalId,
      }),
    ).rejects.toThrow(/vertical/i);
  });
```

In `src/server/platform/service.test.ts`, change the import to `import { registerTenant } from "@/server/onboarding";` and every `registerRestaurant(` to `registerTenant(`, adding `vertical: "restaurant"` to each call.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/server/onboarding/service.test.ts src/server/platform/service.test.ts`
Expected: FAIL — `registerRestaurant` does not exist (rename) and `vertical` not accepted.

- [ ] **Step 3: Implement the service change**

In `src/server/onboarding/service.ts`, add the import and update `RegisterInput`, validation, and insert:

```ts
import { VERTICAL_IDS, type VerticalId } from "@/server/tenancy/verticals";
```

```ts
export type RegisterInput = {
  restaurantName: string;
  slug: string;
  country: "EG" | "SA";
  ownerName: string;
  email: string;
  password: string;
  vertical: VerticalId;
};

export async function registerTenant(input: RegisterInput): Promise<RegisterResult> {
  if (!SLUG_RE.test(input.slug)) throw new Error(`Invalid slug: ${input.slug}`);
  if (!(VERTICAL_IDS as readonly string[]).includes(input.vertical))
    throw new Error(`Invalid vertical: ${input.vertical}`);

  const passwordHash = await hashPassword(input.password);

  return db.transaction(async (tx) => {
    const currency = input.country === "SA" ? "SAR" : "EGP";
    const timezone = input.country === "SA" ? "Asia/Riyadh" : "Africa/Cairo";

    const [tenant] = await tx
      .insert(tenants)
      .values({
        slug: input.slug, name: input.restaurantName, country: input.country,
        currency, timezone, status: "onboarding", vertical: input.vertical,
      })
      .returning();
    // ... remainder of the function is UNCHANGED ...
```

In `src/server/onboarding/index.ts`, change the export to:

```ts
export { registerTenant, type RegisterInput, type RegisterResult } from "./service";
```

- [ ] **Step 4: Update the register action**

In `src/app/register/actions.ts`, change the import to `import { registerTenant } from "@/server/onboarding";` and add `import type { VerticalId } from "@/server/tenancy/verticals";`. Update the call:

```ts
export async function registerAction(formData: FormData) {
  const vertical = String(formData.get("vertical") || "restaurant");
  const result = await registerTenant({
    restaurantName: String(formData.get("restaurantName")),
    slug: String(formData.get("slug")),
    country: String(formData.get("country")) === "SA" ? "SA" : "EG",
    ownerName: String(formData.get("ownerName")),
    email: String(formData.get("email")),
    password: String(formData.get("password")),
    vertical: vertical as VerticalId,
  });
  const token = await createSession(result.ownerUserId, "dashboard");
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/" });
  redirect("/dashboard");
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/server/onboarding/service.test.ts src/server/platform/service.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/onboarding/service.ts src/server/onboarding/index.ts src/server/onboarding/service.test.ts src/server/platform/service.test.ts src/app/register/actions.ts
git commit -m "feat(onboarding): capture and persist tenant vertical"
```

---

## Task 5: Trade picker on the register page

**Files:**
- Create: `src/app/register/RegisterForm.tsx` (client component with picker)
- Modify: `src/app/register/page.tsx` (render `RegisterForm`, generic heading)

**Interfaces:**
- Consumes: `VERTICAL_IDS`, `VERTICAL_ACCENTS`, `VerticalId` from `@/server/tenancy/verticals`; `registerAction` from `./actions` (Task 4).
- Produces: a form that submits `vertical` plus the existing fields.

- [ ] **Step 1: Write the client form component**

`src/app/register/RegisterForm.tsx`:

```tsx
"use client";
import { useState, type CSSProperties } from "react";
import { registerAction } from "./actions";
import { VERTICAL_IDS, VERTICAL_ACCENTS, type VerticalId } from "@/server/tenancy/verticals";

const NAME_LABEL: Record<VerticalId, string> = {
  restaurant: "Restaurant name",
  retail: "Shop name",
  pharmacy: "Pharmacy name",
  timber: "Yard name",
};
const CARD_LABEL: Record<VerticalId, string> = {
  restaurant: "Restaurant",
  retail: "Retail",
  pharmacy: "Pharmacy",
  timber: "Timber",
};

const inputStyle: CSSProperties = {
  background: "#0f172a", border: "1px solid #334155", borderRadius: 6,
  padding: "10px 12px", color: "#f1f5f9", fontSize: 14, width: "100%", boxSizing: "border-box",
};
const labelStyle: CSSProperties = { color: "#94a3b8", fontSize: 12, fontWeight: 500, marginBottom: 4 };

export function RegisterForm() {
  const [vertical, setVertical] = useState<VerticalId>("restaurant");
  const accent = VERTICAL_ACCENTS[vertical];
  return (
    <form action={registerAction} style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {VERTICAL_IDS.map((v) => {
          const active = v === vertical;
          return (
            <button
              type="button"
              key={v}
              onClick={() => setVertical(v)}
              style={{
                padding: "10px 12px", borderRadius: 8,
                border: `1px solid ${active ? accent : "#334155"}`,
                background: active ? `${accent}1A` : "transparent",
                color: active ? accent : "#94a3b8", fontWeight: 600, cursor: "pointer", fontSize: 13,
              }}
            >
              {CARD_LABEL[v]}
            </button>
          );
        })}
      </div>
      <input type="hidden" name="vertical" value={vertical} />

      <label style={{ display: "grid" }}>
        <span style={labelStyle}>{NAME_LABEL[vertical]}</span>
        <input name="restaurantName" placeholder="Roma Ristorante" required style={inputStyle} />
      </label>
      <label style={{ display: "grid" }}>
        <span style={labelStyle}>Subdomain</span>
        <input name="slug" placeholder="roma" required style={inputStyle} />
        <span style={{ color: "#475569", fontSize: 11, marginTop: 4 }}>
          Your storefront will be at roma.serveos.com
        </span>
      </label>
      <label style={{ display: "grid" }}>
        <span style={labelStyle}>Country</span>
        <select
          name="country"
          defaultValue="EG"
          style={{ ...inputStyle, appearance: "auto" as CSSProperties["appearance"] }}
        >
          <option value="EG">Egypt</option>
          <option value="SA">Saudi Arabia</option>
        </select>
      </label>
      <label style={{ display: "grid" }}>
        <span style={labelStyle}>Your name</span>
        <input name="ownerName" placeholder="Ahmed Hassan" required style={inputStyle} />
      </label>
      <label style={{ display: "grid" }}>
        <span style={labelStyle}>Email</span>
        <input name="email" type="email" required style={inputStyle} />
      </label>
      <label style={{ display: "grid" }}>
        <span style={labelStyle}>Password</span>
        <input name="password" type="password" placeholder="Min. 8 characters" required style={inputStyle} />
      </label>
      <button
        type="submit"
        style={{
          marginTop: 8, background: accent, color: "#14120F", fontSize: 14, fontWeight: 600,
          padding: 11, borderRadius: 6, border: "none", cursor: "pointer", width: "100%",
        }}
      >
        Start free trial
      </button>
    </form>
  );
}
```

- [ ] **Step 2: Simplify the page to render the form**

Replace the body of `src/app/register/page.tsx` with:

```tsx
import { RegisterForm } from "./RegisterForm";

export default function RegisterPage() {
  return (
    <main
      style={{
        background: "#0f172a", minHeight: "100vh", display: "flex",
        alignItems: "center", justifyContent: "center", fontFamily: "system-ui", padding: 24,
      }}
    >
      <div style={{ background: "#1e293b", borderRadius: 12, padding: 40, width: "100%", maxWidth: 400 }}>
        <a
          href="/"
          style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 28, textDecoration: "none" }}
        >
          <div style={{ width: 24, height: 24, background: "#f97316", borderRadius: 6 }} />
          <span style={{ color: "#fff", fontWeight: 700, fontSize: 16 }}>ServeOS</span>
        </a>

        <h1 style={{ color: "#fff", fontSize: 22, fontWeight: 700, margin: 0 }}>Create your store</h1>
        <p style={{ color: "#64748b", fontSize: 14, marginTop: 4, marginBottom: 24 }}>
          Start your free trial. No credit card required.
        </p>

        <RegisterForm />

        <p style={{ marginTop: 20, textAlign: "center", fontSize: 13, color: "#64748b" }}>
          Already have an account?{" "}
          <a href="/login" style={{ color: "#f97316", textDecoration: "none" }}>
            Sign in →
          </a>
        </p>
      </div>
    </main>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/register/RegisterForm.tsx src/app/register/page.tsx
git commit -m "feat(register): add vertical picker that relabels the form"
```

---

## Task 6: Per-vertical storefront templates + routing

**Files:**
- Create: `src/app/_components/storefront/templates/StorefrontShell.tsx`
- Create: `src/app/_components/storefront/templates/RestaurantStorefront.tsx`
- Create: `src/app/_components/storefront/templates/RetailStorefront.tsx`
- Create: `src/app/_components/storefront/templates/PharmacyStorefront.tsx`
- Create: `src/app/_components/storefront/templates/TimberStorefront.tsx`
- Modify: `src/app/page.tsx` (route to the selected template; generic not-found/getting-ready strings)

**Interfaces:**
- Consumes: `VERTICAL_ACCENTS`, `VERTICAL_STOREFRONT_COPY`, `selectStorefrontTemplate`, `VerticalId`, `VerticalStorefrontCopy` from `@/server/tenancy/verticals`; `Banner` from `@/server/banners/schema`; `Branch`, `BranchOpenState` from `@/server/branches/schema`; `PublishedMenu` from `@/server/catalog/schema`; `Tenant` from `@/server/tenancy/schema`.
- Produces: `StorefrontTemplateProps` (exported from `StorefrontShell`) and the four template components.

- [ ] **Step 1: Write the shared shell**

`src/app/_components/storefront/templates/StorefrontShell.tsx`:

```tsx
import type { CSSProperties } from "react";
import type { PublishedMenu } from "@/server/catalog/schema";
import type { Banner } from "@/server/banners/schema";
import type { Branch, BranchOpenState } from "@/server/branches/schema";
import type { Tenant } from "@/server/tenancy/schema";
import type { VerticalStorefrontCopy } from "@/server/tenancy/verticals";
import { Hero } from "../Hero";
import { OpenStateBanner } from "../OpenStateBanner";
import { RecentOrderStrip } from "../RecentOrderStrip";
import { StorefrontMenu } from "@/app/_components/StorefrontMenu";
import { StorefrontFooter } from "../StorefrontFooter";
import { BranchSelector } from "@/app/_components/BranchSelector";
import { EmptyState } from "@/components/dashboard/EmptyState";

export type StorefrontTemplateProps = {
  tenant: Pick<Tenant, "name" | "logoUrl" | "coverImageUrl" | "tagline" | "cuisine" | "currency">;
  accent: string;
  config: VerticalStorefrontCopy;
  banners: Banner[];
  menu: PublishedMenu;
  branches: Branch[];
  branchSummaries: { id: string; name: string; open: boolean }[];
  activeBranch: Branch | null;
  openState: BranchOpenState | null;
  paused: boolean;
  orderingEnabled: boolean;
  slug: string;
  popularIds: string[];
  whatsappNumber: string | null;
  openLabel?: string | null;
  etaLabel?: string | null;
  minOrderLabel?: string | null;
};

export function StorefrontShell(props: StorefrontTemplateProps) {
  const {
    tenant, accent, config, banners, menu, branches, branchSummaries,
    activeBranch, openState, paused, orderingEnabled, slug, popularIds,
    whatsappNumber, openLabel, etaLabel, minOrderLabel,
  } = props;

  return (
    <main className="min-h-screen bg-background">
      <Hero
        name={tenant.name}
        logoUrl={tenant.logoUrl}
        coverImageUrl={tenant.coverImageUrl}
        tagline={tenant.tagline}
        cuisine={tenant.cuisine}
        area={activeBranch?.address ?? null}
        openLabel={openLabel}
        etaLabel={etaLabel}
        minOrderLabel={minOrderLabel}
      />

      {openState && <OpenStateBanner state={openState} paused={paused} />}

      <RecentOrderStrip slug={slug} />

      {banners.length > 0 && (
        <section className="flex gap-3 overflow-x-auto px-4 py-4 sm:px-6">
          {banners.map((b) => (
            <a key={b.id} href={b.linkUrl ?? "#"} className="shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={b.imageUrl} alt={b.titleEn ?? ""} className="h-36 rounded-xl object-cover" />
            </a>
          ))}
        </section>
      )}

      {branches.length > 1 && (
        <section className="px-4 pb-2 sm:px-6">
          <BranchSelector branches={branches} currentBranchId={activeBranch?.id ?? null} />
        </section>
      )}

      <section className="px-4 pb-32 sm:px-6">
        <h2 className="mb-4 font-display text-xl font-bold text-ink" style={{ color: accent }}>
          {config.menuHeading}
        </h2>
        {menu.categories.length === 0 ? (
          <EmptyState title={config.emptyMenuTitle} description={config.emptyMenuDesc} />
        ) : (
          <StorefrontMenu
            menu={menu}
            branchId={activeBranch?.id ?? null}
            slug={slug}
            orderingEnabled={orderingEnabled && !paused}
            preorderOnly={openState !== null && !openState.open && !paused}
            branches={branchSummaries}
            currency={tenant.currency}
            popularIds={[...popularIds]}
          />
        )}
      </section>

      <StorefrontFooter
        branch={activeBranch ?? branches[0] ?? null}
        whatsappNumber={config.showWhatsapp ? whatsappNumber : null}
      />
    </main>
  );
}
```

- [ ] **Step 2: Write the four template components**

`src/app/_components/storefront/templates/RestaurantStorefront.tsx`:

```tsx
import { StorefrontShell, type StorefrontTemplateProps } from "./StorefrontShell";
import { VERTICAL_ACCENTS, VERTICAL_STOREFRONT_COPY } from "@/server/tenancy/verticals";

export function RestaurantStorefront(props: StorefrontTemplateProps) {
  return (
    <StorefrontShell
      {...props}
      accent={VERTICAL_ACCENTS.restaurant}
      config={VERTICAL_STOREFRONT_COPY.restaurant}
    />
  );
}
```

`src/app/_components/storefront/templates/RetailStorefront.tsx`:

```tsx
import { StorefrontShell, type StorefrontTemplateProps } from "./StorefrontShell";
import { VERTICAL_ACCENTS, VERTICAL_STOREFRONT_COPY } from "@/server/tenancy/verticals";

export function RetailStorefront(props: StorefrontTemplateProps) {
  return (
    <StorefrontShell
      {...props}
      accent={VERTICAL_ACCENTS.retail}
      config={VERTICAL_STOREFRONT_COPY.retail}
    />
  );
}
```

`src/app/_components/storefront/templates/PharmacyStorefront.tsx`:

```tsx
import { StorefrontShell, type StorefrontTemplateProps } from "./StorefrontShell";
import { VERTICAL_ACCENTS, VERTICAL_STOREFRONT_COPY } from "@/server/tenancy/verticals";

export function PharmacyStorefront(props: StorefrontTemplateProps) {
  return (
    <StorefrontShell
      {...props}
      accent={VERTICAL_ACCENTS.pharmacy}
      config={VERTICAL_STOREFRONT_COPY.pharmacy}
    />
  );
}
```

`src/app/_components/storefront/templates/TimberStorefront.tsx`:

```tsx
import { StorefrontShell, type StorefrontTemplateProps } from "./StorefrontShell";
import { VERTICAL_ACCENTS, VERTICAL_STOREFRONT_COPY } from "@/server/tenancy/verticals";

export function TimberStorefront(props: StorefrontTemplateProps) {
  return (
    <StorefrontShell
      {...props}
      accent={VERTICAL_ACCENTS.timber}
      config={VERTICAL_STOREFRONT_COPY.timber}
    />
  );
}
```

- [ ] **Step 3: Wire routing in `page.tsx`**

In `src/app/page.tsx`:
- Remove the `import { StorefrontMenu } from "./_components/StorefrontMenu";` line (now used only inside the shell).
- Add imports:

```tsx
import { selectStorefrontTemplate } from "@/server/tenancy/verticals";
import { RestaurantStorefront } from "./_components/storefront/templates/RestaurantStorefront";
import { RetailStorefront } from "./_components/storefront/templates/RetailStorefront";
import { PharmacyStorefront } from "./_components/storefront/templates/PharmacyStorefront";
import { TimberStorefront } from "./_components/storefront/templates/TimberStorefront";
```

- Change the two early-return `EmptyState` strings to generic ones:
  - `"Restaurant not found"` → `"Store not found"`
  - `"This restaurant is getting ready. Check back soon!"` → `"This store is getting ready. Check back soon!"`

- Replace the entire inline storefront JSX block (the `<main className="min-h-screen bg-background"> ... </main>` currently returned for the storefront surface) with:

```tsx
    const resolvedVertical = selectStorefrontTemplate(tenant.vertical);
    const Template = {
      restaurant: RestaurantStorefront,
      retail: RetailStorefront,
      pharmacy: PharmacyStorefront,
      timber: TimberStorefront,
    }[resolvedVertical];

    return (
      <Template
        tenant={{
          name: tenant.name,
          logoUrl: tenant.logoUrl,
          coverImageUrl: tenant.coverImageUrl,
          tagline: tenant.tagline,
          cuisine: tenant.cuisine,
          currency: tenant.currency,
        }}
        banners={banners}
        menu={menu}
        branches={branches}
        branchSummaries={branchSummaries}
        activeBranch={activeBranch}
        openState={openState}
        paused={paused}
        orderingEnabled={orderingEnabled}
        slug={slug!}
        popularIds={[...popularSet]}
        whatsappNumber={whatsappNumber}
        openLabel={openLabel}
        etaLabel={etaLabel}
        minOrderLabel={minOrderLabel}
      />
    );
```

Note: the data (`banners`, `menu`, `branches`, `branchSummaries`, `activeBranch`, `openState`, `paused`, `orderingEnabled`, `slug`, `popularSet`, `whatsappNumber`, `openLabel`, `etaLabel`, `minOrderLabel`) is already computed earlier in `page.tsx` — leave that computation unchanged.

- [ ] **Step 4: Typecheck and lint**

Run: `npx tsc --noEmit -p tsconfig.json && npm run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/_components/storefront/templates src/app/page.tsx
git commit -m "feat(storefront): route to per-vertical templates with shared shell"
```

---

## Task 7: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests PASS (including the new `schema.test.ts`, `verticals.test.ts`, and updated onboarding/platform tests). The test DB is migrated automatically by the vitest global setup.

- [ ] **Step 2: Run lint + typecheck**

Run: `npm run lint && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Smoke-check the dev storefront (manual, optional)**

Run: `npm run dev`, open a restaurant subdomain storefront (e.g. an existing seeded tenant) — confirm it still renders the original "Menu" heading, WhatsApp CTA, and restaurant accent. This validates the restaurant path is unchanged.

- [ ] **Step 4: Commit any stray fixes**

If Steps 1–2 surfaced fixes, commit them:
```bash
git add -A && git commit -m "fix: resolve lint/typecheck issues from vertical storefront work"
```
