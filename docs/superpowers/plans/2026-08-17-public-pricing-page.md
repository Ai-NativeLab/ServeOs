# Public Pricing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a public `/pricing` page in both locales, and fix the subscribe fork so a prospect holding a demo session is never delivered into a demo tenant's billing page.

**Architecture:** The page lives inside the existing `(marketing)/[lang]` segment and reuses `PricingTerms`/`PlanCard`, so prices have one source. `/subscribe` becomes the single "I want this plan" route: it redirects Free to registration and real customers to billing, and renders an enquiry form for everyone else. An enquiry writes a `plan_enquiries` row *before* attempting delivery, then sends directly through `activeEmailProvider()` — never through the notification outbox, which is tenant-scoped and drained by a once-daily cron.

**Tech Stack:** Next.js (App Router, RSC + server actions), Drizzle ORM + Postgres, Vitest, Playwright, Resend via the existing `EmailProvider` abstraction.

## Global Constraints

- **Arabic is the default locale.** Every user-facing string ships in `ar` and `en`. `src/app/(marketing)/_content/parity.test.ts` compares key paths across both and fails on a missing one.
- **Zero-valued limits are never sold.** A limit of `0` renders as `—`, never `"0"`. `PlanCard` already filters these out.
- **Nothing raises an invoice as a side effect of following a link.** Registration and enquiry never create a charge.
- **Never log or expose `RESEND_API_KEY`, nor a provider's raw response body.** `ResendEmailProvider` already strips these; keep it that way.
- **Plan keys are `basic`, `pro`, `growth`, `enterprise`.** Display names come from `PRICING[locale].planNames`. Never hardcode a price or a plan name in a component.
- **`src/db/schema.ts` re-exports every domain schema.** A new table is invisible to `drizzle-kit` until its module is exported there.
- Unit tests for marketing/pure logic must be added to the `include` list in `vitest.unit.config.ts` if they sit outside its existing globs.

---

### Task 1: Correct the default sender domain

`worker.ts` falls back to `no-reply@mail.serveos.com`. That domain is not ours — the mail domain is `serveos.tech` (serveos.com is an Atom redirect). If `EMAIL_FROM` is ever unset in Vercel, every email attempts to send from an unverifiable domain and fails.

**Files:**
- Modify: `src/server/notifications/worker.ts:66`
- Test: `src/server/notifications/worker.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: nothing new; corrects an existing default

- [ ] **Step 1: Write the failing test**

Add to `src/server/notifications/worker.test.ts`:

```ts
it("falls back to a sender on a domain we actually control", async () => {
  const previous = process.env.EMAIL_FROM;
  delete process.env.EMAIL_FROM;
  try {
    // The fallback must be on serveos.tech; mail.serveos.com is not ours and
    // can never pass DKIM/SPF, so a missing EMAIL_FROM would silently break
    // every send.
    const { defaultSender } = await import("./worker");
    expect(defaultSender()).toBe("no-reply@serveos.tech");
  } finally {
    if (previous !== undefined) process.env.EMAIL_FROM = previous;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/notifications/worker.test.ts -t "domain we actually control"`
Expected: FAIL — `defaultSender` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/server/notifications/worker.ts`, extract and export the fallback, then use it at line 66:

```ts
/** The sender used when EMAIL_FROM is unset. Must be a domain verified in the
 *  email provider — serveos.tech. mail.serveos.com was a pre-launch guess and
 *  is not a domain we control. */
export function defaultSender(): string {
  return process.env.EMAIL_FROM ?? "no-reply@serveos.tech";
}
```

Replace the inline `process.env.EMAIL_FROM ?? "no-reply@mail.serveos.com"` with `defaultSender()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/server/notifications/worker.test.ts`
Expected: PASS, including the pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/notifications/worker.ts src/server/notifications/worker.test.ts
git commit -m "fix(email): default the sender to a domain we control"
```

---

### Task 2: Route /pricing through the locale allowlist

`marketingLocaleAction` returns `{ kind: "none" }` for `/pricing`, so the route would 404. It needs an allowlist — never a catch-all, because the same fallthrough keeps `/login`, `/register` and `/api/health` out of the marketing segment.

**Files:**
- Modify: `src/marketing-locale.ts`
- Test: `src/marketing-locale.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `/pricing` resolving to `{ kind: "rewrite", pathname: "/ar/pricing", locale: "ar" }`

- [ ] **Step 1: Write the failing tests**

Add to `src/marketing-locale.test.ts`, inside the existing `describe("marketingLocaleAction")`:

```ts
it("rewrites the bare pricing path to the Arabic route", () => {
  expect(marketingLocaleAction("/pricing")).toEqual({
    kind: "rewrite",
    pathname: "/ar/pricing",
    locale: "ar",
  });
});

it("passes the English pricing path through", () => {
  expect(marketingLocaleAction("/en/pricing")).toEqual({ kind: "pass", locale: "en" });
});

it("redirects an explicit Arabic pricing path to its canonical form", () => {
  expect(marketingLocaleAction("/ar/pricing")).toEqual({ kind: "redirect", pathname: "/pricing" });
});

// The allowlist must not become a catch-all: these are the auth and health
// paths that must never be rewritten into the marketing [lang] segment.
it("still leaves non-marketing paths alone after the allowlist", () => {
  expect(marketingLocaleAction("/login")).toEqual({ kind: "none" });
  expect(marketingLocaleAction("/register")).toEqual({ kind: "none" });
  expect(marketingLocaleAction("/api/health")).toEqual({ kind: "none" });
  expect(marketingLocaleAction("/pricing-guide")).toEqual({ kind: "none" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/marketing-locale.test.ts`
Expected: FAIL on the first test — receives `{ kind: "none" }`.

- [ ] **Step 3: Write minimal implementation**

In `src/marketing-locale.ts`, add above `marketingLocaleAction` and use it before the final `return { kind: "none" }`:

```ts
/**
 * Marketing pages that live under the [lang] segment but are reached without a
 * locale prefix. An ALLOWLIST, never a catch-all: the `none` fallthrough below
 * is what keeps /login, /register and /api/health out of the marketing
 * segment, and rewriting those would break sign-in.
 */
const MARKETING_PATHS = new Set(["/pricing"]);
```

Then, immediately before the final `return { kind: "none" };`:

```ts
  if (MARKETING_PATHS.has(pathname)) {
    return { kind: "rewrite", pathname: `/ar${pathname}`, locale: "ar" };
  }
```

Note the existing `/en/*` and `/ar/*` rules already handle the other two cases; no change is needed for them.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/marketing-locale.test.ts src/proxy.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add src/marketing-locale.ts src/marketing-locale.test.ts
git commit -m "feat(marketing): route /pricing through the locale allowlist"
```

---

### Task 3: The subscribe decision, as a pure function

The fork currently lives inside a redirect-only server component, which makes it testable only through a browser. Extract it.

**Files:**
- Create: `src/app/subscribe/destination.ts`
- Create: `src/app/subscribe/destination.test.ts`
- Modify: `vitest.unit.config.ts`

**Interfaces:**
- Consumes: `isDemoSlug` from `@/server/demo/entry`
- Produces:
  ```ts
  export type SubscribeVisitor = {
    planKey: string | undefined;
    planExists: boolean;
    tenantSlug: string | null;  // null when signed out or no tenant
  };
  export type SubscribeDestination =
    | { kind: "redirect"; href: string }
    | { kind: "enquire"; planKey: string };
  export function subscribeDestination(v: SubscribeVisitor): SubscribeDestination;
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/app/subscribe/destination.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { subscribeDestination } from "./destination";

describe("subscribeDestination", () => {
  it("sends an unknown plan key to the pricing page", () => {
    expect(subscribeDestination({ planKey: "platinum", planExists: false, tenantSlug: null }))
      .toEqual({ kind: "redirect", href: "/pricing" });
  });

  it("sends an absent plan key to the pricing page", () => {
    expect(subscribeDestination({ planKey: undefined, planExists: false, tenantSlug: null }))
      .toEqual({ kind: "redirect", href: "/pricing" });
  });

  it("sends the free plan to registration carrying its key", () => {
    expect(subscribeDestination({ planKey: "basic", planExists: true, tenantSlug: null }))
      .toEqual({ kind: "redirect", href: "/register?plan=basic" });
  });

  it("sends a real customer to billing with the plan highlighted", () => {
    expect(subscribeDestination({ planKey: "enterprise", planExists: true, tenantSlug: "zeytoun" }))
      .toEqual({ kind: "redirect", href: "/dashboard/settings/billing?plan=enterprise" });
  });

  // The reported bug: a demo visitor is a prospect, not a customer. Sending
  // them to billing lands them in the demo tenant's account.
  it("treats a demo session as a prospect, not a customer", () => {
    expect(subscribeDestination({ planKey: "enterprise", planExists: true, tenantSlug: "demo-pharmacy" }))
      .toEqual({ kind: "enquire", planKey: "enterprise" });
  });

  it("asks a signed-out visitor to enquire about a paid plan", () => {
    expect(subscribeDestination({ planKey: "growth", planExists: true, tenantSlug: null }))
      .toEqual({ kind: "enquire", planKey: "growth" });
  });

  it("sends a demo visitor choosing the free plan to registration", () => {
    expect(subscribeDestination({ planKey: "basic", planExists: true, tenantSlug: "demo-retail" }))
      .toEqual({ kind: "redirect", href: "/register?plan=basic" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/subscribe/destination.test.ts`
Expected: FAIL — cannot resolve `./destination`.

- [ ] **Step 3: Write minimal implementation**

Create `src/app/subscribe/destination.ts`:

```ts
import { isDemoSlug } from "@/server/demo/entry";

/** The free plan self-serves: there is nothing to sell and nothing to invoice. */
const FREE_PLAN_KEY = "basic";

export type SubscribeVisitor = {
  planKey: string | undefined;
  /** Whether planKey matched a row in the plans table. */
  planExists: boolean;
  /** The signed-in tenant's slug, or null when signed out / no tenant. */
  tenantSlug: string | null;
};

export type SubscribeDestination =
  | { kind: "redirect"; href: string }
  | { kind: "enquire"; planKey: string };

/**
 * Where "I want this plan" leads.
 *
 * A demo session deliberately does NOT count as a customer. The marketing page
 * hands out a real session via /api/demo/login one click earlier, so treating
 * "signed in" as "is a customer" delivered prospects into the demo tenant's
 * billing page — its usage meters, and a Subscribe button that would invoice a
 * tenant reset nightly.
 */
export function subscribeDestination(v: SubscribeVisitor): SubscribeDestination {
  if (!v.planKey || !v.planExists) return { kind: "redirect", href: "/pricing" };

  if (v.planKey === FREE_PLAN_KEY) {
    return { kind: "redirect", href: `/register?plan=${encodeURIComponent(v.planKey)}` };
  }

  const isCustomer = v.tenantSlug !== null && !isDemoSlug(v.tenantSlug);
  if (isCustomer) {
    return { kind: "redirect", href: `/dashboard/settings/billing?plan=${encodeURIComponent(v.planKey)}` };
  }

  return { kind: "enquire", planKey: v.planKey };
}
```

- [ ] **Step 4: Register the test with the unit config**

In `vitest.unit.config.ts`, add to the `include` array:

```ts
      "src/app/subscribe/**/*.test.ts",
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run --config vitest.unit.config.ts`
Expected: PASS, all files.

- [ ] **Step 6: Commit**

```bash
git add src/app/subscribe/destination.ts src/app/subscribe/destination.test.ts vitest.unit.config.ts
git commit -m "feat(subscribe): extract the fork into a testable decision"
```

---

### Task 4: Capture a plan enquiry as a lead

The notification outbox cannot carry this: `notification_outbox.tenant_id` is `NOT NULL` with an FK to `tenants` and `notify()` wraps writes in `withTenant()` for RLS, while a marketing lead has no tenant — and `vercel.json` drains the outbox at `0 3 * * *`, so a queued lead could wait 24 hours. Persist first, send directly.

**Files:**
- Create: `src/server/enquiries/schema.ts`
- Create: `src/server/enquiries/service.ts`
- Create: `src/server/enquiries/service.test.ts`
- Modify: `src/db/schema.ts`
- Generated: `drizzle/NNNN_*.sql`

**Interfaces:**
- Consumes: `activeEmailProvider` from `@/server/email`
- Produces:
  ```ts
  export type NewEnquiry = {
    planKey: string; name: string; businessName: string;
    phone: string; email: string; locale: "ar" | "en";
  };
  export async function createEnquiry(input: NewEnquiry): Promise<{ id: string; emailed: boolean }>;
  export async function recentlyEnquired(email: string, withinMinutes?: number): Promise<boolean>;
  ```

- [ ] **Step 1: Write the schema**

Create `src/server/enquiries/schema.ts`:

```ts
import { pgTable, text, uuid, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Interest in a paid plan, captured from the public pricing page.
 *
 * CONTROL-PLANE — there is no tenant. A prospect has not signed up yet, which
 * is precisely why this cannot live in notification_outbox (tenant_id NOT NULL,
 * writes wrapped in withTenant for RLS). Follows the `tenants` precedent: a
 * control table with no row-level security.
 *
 * The row is committed BEFORE delivery is attempted, so a provider outage or a
 * missing API key leaves an unsent lead here rather than losing it.
 */
export const planEnquiries = pgTable("plan_enquiries", {
  id: uuid("id").defaultRandom().primaryKey(),
  planKey: text("plan_key").notNull(),
  name: text("name").notNull(),
  businessName: text("business_name").notNull(),
  phone: text("phone").notNull(),
  email: text("email").notNull(),
  locale: text("locale").notNull(),
  /** "sent" once the provider accepted it; "unsent" until then. */
  status: text("status").notNull().default("unsent"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
}, (t) => [
  // The throttle reads by email, newest first.
  index("plan_enquiries_email_created").on(t.email, t.createdAt),
]);

export type PlanEnquiry = typeof planEnquiries.$inferSelect;
```

- [ ] **Step 2: Export it so drizzle-kit can see it**

Append to `src/db/schema.ts`:

```ts
export * from "../server/enquiries/schema";
```

A table absent from this file is invisible to `drizzle-kit generate` and no migration is produced.

- [ ] **Step 3: Generate the migration**

Run: `npm run db:generate`
Expected: a new `drizzle/NNNN_*.sql` creating `plan_enquiries`. Read it and confirm it only creates that table.

- [ ] **Step 4: Write the failing tests**

Create `src/server/enquiries/service.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const send = vi.fn();
vi.mock("@/server/email", () => ({ activeEmailProvider: () => ({ name: "fake", send }) }));

const rows: Record<string, unknown>[] = [];
vi.mock("@/db", () => ({
  db: {
    insert: () => ({ values: (v: Record<string, unknown>) => ({ returning: async () => {
      const row = { id: "11111111-1111-1111-1111-111111111111", ...v };
      rows.push(row);
      return [row];
    } }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));

import { createEnquiry } from "./service";

beforeEach(() => { rows.length = 0; send.mockReset(); process.env.SALES_INBOX_EMAIL = "sales@serveos.tech"; });

describe("createEnquiry", () => {
  it("emails the sales inbox with the plan and a reply-to of the enquirer", async () => {
    send.mockResolvedValue({ providerMessageId: "abc" });
    const res = await createEnquiry({
      planKey: "enterprise", name: "Ahmed", businessName: "El Nour",
      phone: "+201000000000", email: "ahmed@example.com", locale: "en",
    });
    expect(res.emailed).toBe(true);
    const msg = send.mock.calls[0][0];
    expect(msg.to).toBe("sales@serveos.tech");
    expect(msg.replyTo).toBe("ahmed@example.com");
    expect(msg.subject).toContain("enterprise");
  });

  // The whole reason the row is written first: a lead must survive a bad key.
  it("keeps the lead when the provider fails", async () => {
    send.mockRejectedValue(new Error("Resend send failed: 403"));
    const res = await createEnquiry({
      planKey: "growth", name: "Sara", businessName: "Nile Books",
      phone: "+201111111111", email: "sara@example.com", locale: "ar",
    });
    expect(res.emailed).toBe(false);
    expect(res.id).toBeTruthy();
    expect(rows).toHaveLength(1);
  });

  it("records the lead before attempting delivery", async () => {
    send.mockImplementation(() => { expect(rows).toHaveLength(1); throw new Error("boom"); });
    await createEnquiry({
      planKey: "pro", name: "Omar", businessName: "Cairo Cafe",
      phone: "+201222222222", email: "omar@example.com", locale: "en",
    });
    expect(send).toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npx vitest run src/server/enquiries/service.test.ts`
Expected: FAIL — cannot resolve `./service`.

- [ ] **Step 6: Write the implementation**

Create `src/server/enquiries/service.ts`:

```ts
import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { activeEmailProvider } from "@/server/email";
import { planEnquiries } from "./schema";

export type NewEnquiry = {
  planKey: string;
  name: string;
  businessName: string;
  phone: string;
  email: string;
  locale: "ar" | "en";
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Records interest in a paid plan and notifies the sales inbox.
 *
 * The row is committed BEFORE the provider is called, deliberately. Email is
 * the fragile half — a missing RESEND_API_KEY, an unverified domain, a provider
 * outage — and a lead that only exists in an email is a lead you lose. Delivery
 * failure is recorded on the row, never thrown at the visitor.
 *
 * Sends directly rather than through notify(): that path requires a tenant, and
 * its worker runs once a day.
 */
export async function createEnquiry(input: NewEnquiry): Promise<{ id: string; emailed: boolean }> {
  const [row] = await db.insert(planEnquiries).values({
    planKey: input.planKey,
    name: input.name,
    businessName: input.businessName,
    phone: input.phone,
    email: input.email,
    locale: input.locale,
  }).returning();

  const to = process.env.SALES_INBOX_EMAIL;
  if (!to) {
    await db.update(planEnquiries)
      .set({ lastError: "SALES_INBOX_EMAIL is not set" })
      .where(eq(planEnquiries.id, row.id));
    return { id: row.id, emailed: false };
  }

  try {
    await activeEmailProvider().send({
      from: process.env.EMAIL_FROM ?? "no-reply@serveos.tech",
      to,
      replyTo: input.email,
      subject: `Plan enquiry: ${input.planKey} — ${input.businessName}`,
      html:
        `<p><strong>${escapeHtml(input.name)}</strong> (${escapeHtml(input.businessName)}) ` +
        `wants the <strong>${escapeHtml(input.planKey)}</strong> plan.</p>` +
        `<p>Phone: ${escapeHtml(input.phone)}<br/>Email: ${escapeHtml(input.email)}<br/>` +
        `Reading in: ${escapeHtml(input.locale)}</p>`,
      idempotencyKey: row.id,
    });
    await db.update(planEnquiries)
      .set({ status: "sent", sentAt: new Date() })
      .where(eq(planEnquiries.id, row.id));
    return { id: row.id, emailed: true };
  } catch (e) {
    await db.update(planEnquiries)
      .set({ lastError: e instanceof Error ? e.message : "unknown" })
      .where(eq(planEnquiries.id, row.id));
    return { id: row.id, emailed: false };
  }
}

/** Throttle source: the enquiries table itself, so no new infrastructure. */
export async function recentlyEnquired(email: string, withinMinutes = 5): Promise<boolean> {
  const since = new Date(Date.now() - withinMinutes * 60_000);
  const [recent] = await db.select({ id: planEnquiries.id })
    .from(planEnquiries)
    .where(and(eq(planEnquiries.email, email), gt(planEnquiries.createdAt, since)))
    .orderBy(desc(planEnquiries.createdAt))
    .limit(1);
  return Boolean(recent);
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/server/enquiries/service.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 8: Apply the migration and typecheck**

Run: `npm run db:migrate && npx tsc --noEmit`
Expected: migration applies; tsc exits 0.

- [ ] **Step 9: Commit**

```bash
git add src/server/enquiries src/db/schema.ts drizzle
git commit -m "feat(enquiries): capture plan interest as a lead, then notify"
```

---

### Task 5: The enquiry form, and wiring /subscribe

**Files:**
- Create: `src/app/subscribe/EnquiryForm.tsx`
- Create: `src/app/subscribe/actions.ts`
- Modify: `src/app/subscribe/page.tsx`
- Modify: `src/app/(marketing)/_content/pricing.ts`

**Interfaces:**
- Consumes: `subscribeDestination` (Task 3), `createEnquiry` / `recentlyEnquired` (Task 4)
- Produces: `submitEnquiryAction(formData: FormData): Promise<{ ok: boolean; error?: string }>`

- [ ] **Step 1: Add the form's copy in both locales**

In `src/app/(marketing)/_content/pricing.ts`, extend `PricingContent` with:

```ts
  enquiry: {
    heading: string;
    intro: string;
    name: string;
    businessName: string;
    phone: string;
    email: string;
    submit: string;
    success: string;
    tooSoon: string;
    failed: string;
  };
```

Add to the `ar` object:

```ts
    enquiry: {
      heading: "اطلب الباقة",
      intro: "سيبلنا بياناتك وهنتواصل معاك ونظبّطلك الحساب.",
      name: "الاسم",
      businessName: "اسم النشاط",
      phone: "رقم الموبايل",
      email: "البريد الإلكتروني",
      submit: "ابعت الطلب",
      success: "وصلنا طلبك. هنتواصل معاك قريب.",
      tooSoon: "استلمنا طلبك بالفعل. هنتواصل معاك قريب.",
      failed: "حصلت مشكلة. حاول تاني من فضلك.",
    },
```

And to the `en` object:

```ts
    enquiry: {
      heading: "Request this plan",
      intro: "Leave your details and we'll get in touch to set you up.",
      name: "Name",
      businessName: "Business name",
      phone: "Phone",
      email: "Email",
      submit: "Send request",
      success: "Got it. We'll be in touch shortly.",
      tooSoon: "We already have your request. We'll be in touch shortly.",
      failed: "Something went wrong. Please try again.",
    },
```

- [ ] **Step 2: Run the parity test**

Run: `npx vitest run "src/app/(marketing)/_content/parity.test.ts"`
Expected: PASS — both locales carry identical key paths.

- [ ] **Step 3: Write the server action**

Create `src/app/subscribe/actions.ts`:

```ts
"use server";
import { listPlans } from "@/server/subscription";
import { createEnquiry, recentlyEnquired } from "@/server/enquiries/service";

/**
 * A public form that causes an email needs a guard, and no rate limiter exists
 * in this codebase. Two cheap ones that fail closed: a honeypot field that a
 * human never fills, and a throttle read off the enquiries table itself.
 */
export async function submitEnquiryAction(
  _prev: { ok: boolean; error?: string } | null,
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  // Honeypot. Bots fill every field; humans never see this one.
  if (String(formData.get("company") || "")) return { ok: true };

  const planKey = String(formData.get("plan") || "");
  const email = String(formData.get("email") || "").trim();
  const name = String(formData.get("name") || "").trim();
  const businessName = String(formData.get("businessName") || "").trim();
  const phone = String(formData.get("phone") || "").trim();
  const locale = String(formData.get("locale") || "en") === "ar" ? "ar" : "en";

  if (!name || !businessName || !phone || !email) return { ok: false, error: "failed" };

  // Never trust the key from the form; it decides what we tell sales.
  const plans = await listPlans();
  if (!plans.some((p) => p.key === planKey)) return { ok: false, error: "failed" };

  if (await recentlyEnquired(email)) return { ok: false, error: "tooSoon" };

  await createEnquiry({ planKey, name, businessName, phone, email, locale });
  // Delivery failure is recorded on the row and must not be shown as failure:
  // the lead is captured either way.
  return { ok: true };
}
```

- [ ] **Step 4: Write the form component**

Create `src/app/subscribe/EnquiryForm.tsx`:

```tsx
"use client";
import { useActionState } from "react";
import type { Locale } from "@/shared/errors";
import { PRICING } from "@/app/(marketing)/_content/pricing";
import { submitEnquiryAction } from "./actions";

export function EnquiryForm({ planKey, locale }: { planKey: string; locale: Locale }) {
  const t = PRICING[locale];
  const planName = t.planNames[planKey] ?? planKey;
  const [state, action, pending] = useActionState(submitEnquiryAction, null);

  if (state?.ok) {
    return <p className="mt-6 text-sm">{t.enquiry.success}</p>;
  }

  return (
    <form action={action} className="mt-6 grid gap-4">
      <input type="hidden" name="plan" value={planKey} />
      <input type="hidden" name="locale" value={locale} />
      {/* Honeypot: hidden from people, irresistible to bots. */}
      <input
        type="text"
        name="company"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="hidden"
      />

      <p className="text-sm text-muted-foreground">{t.enquiry.intro}</p>
      <p className="text-sm font-bold">{planName}</p>

      <label className="grid gap-1 text-sm">
        {t.enquiry.name}
        <input name="name" required className="rounded-md border border-border px-3 py-2" />
      </label>
      <label className="grid gap-1 text-sm">
        {t.enquiry.businessName}
        <input name="businessName" required className="rounded-md border border-border px-3 py-2" />
      </label>
      <label className="grid gap-1 text-sm">
        {t.enquiry.phone}
        <input name="phone" required inputMode="tel" className="rounded-md border border-border px-3 py-2" />
      </label>
      <label className="grid gap-1 text-sm">
        {t.enquiry.email}
        <input name="email" required type="email" className="rounded-md border border-border px-3 py-2" />
      </label>

      {state?.error ? (
        <p className="text-sm text-destructive">
          {state.error === "tooSoon" ? t.enquiry.tooSoon : t.enquiry.failed}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-border px-4 py-2.5 text-sm font-medium hover:bg-muted"
      >
        {t.enquiry.submit}
      </button>
    </form>
  );
}
```

- [ ] **Step 5: Rewrite the subscribe page**

Replace the body of `src/app/subscribe/page.tsx` (keep its existing doc comment, updating it to describe the enquiry fork):

```tsx
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { validateSession } from "@/server/auth/session";
import { SESSION_COOKIE } from "@/server/auth/current-user";
import { listPlans } from "@/server/subscription";
import { getTenantById } from "@/server/tenancy/service";
import { subscribeDestination } from "./destination";
import { EnquiryForm } from "./EnquiryForm";

export default async function SubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string }>;
}) {
  const { plan } = await searchParams;
  const plans = await listPlans();
  const planExists = Boolean(plan && plans.some((p) => p.key === plan));

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = token ? await validateSession(token) : null;

  let tenantSlug: string | null = null;
  if (session?.user.tenantId) {
    const tenant = await getTenantById(session.user.tenantId);
    tenantSlug = tenant?.slug ?? null;
  }

  const destination = subscribeDestination({ planKey: plan, planExists, tenantSlug });
  if (destination.kind === "redirect") redirect(destination.href);

  const locale = (await headers()).get("x-locale") === "ar" ? "ar" : "en";
  return (
    <main className="mx-auto max-w-md px-6 py-20">
      <EnquiryForm planKey={destination.planKey} locale={locale} />
    </main>
  );
}
```

`getTenantById(id: string): Promise<Tenant | null>` already exists at
`src/server/tenancy/service.ts:81` — import it, do not write a new one.

- [ ] **Step 6: Typecheck and run the suite**

Run: `npx tsc --noEmit && npx vitest run --config vitest.unit.config.ts`
Expected: tsc exits 0; unit tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/app/subscribe "src/app/(marketing)/_content/pricing.ts" src/server/tenancy/service.ts
git commit -m "feat(subscribe): enquire instead of dropping prospects into a tenant dashboard"
```

---

### Task 6: Carry the plan key through registration

**Files:**
- Modify: `src/app/register/page.tsx`
- Modify: `src/app/register/RegisterForm.tsx`
- Modify: `src/app/register/actions.ts`
- Create: `src/app/register/plan-redirect.ts`
- Create: `src/app/register/plan-redirect.test.ts`
- Modify: `vitest.unit.config.ts`

**Interfaces:**
- Produces: `export function postRegisterHref(planKey: string | undefined, planExists: boolean): string`

- [ ] **Step 1: Write the failing tests**

Create `src/app/register/plan-redirect.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { postRegisterHref } from "./plan-redirect";

describe("postRegisterHref", () => {
  it("lands on the dashboard when no plan was carried", () => {
    expect(postRegisterHref(undefined, false)).toBe("/dashboard");
  });

  it("ignores a plan key that is not a real plan", () => {
    expect(postRegisterHref("platinum", false)).toBe("/dashboard");
  });

  it("opens billing with a carried plan highlighted", () => {
    expect(postRegisterHref("enterprise", true)).toBe("/dashboard/settings/billing?plan=enterprise");
  });

  // Free carries its key too, but there is nothing to highlight: they already
  // have it the moment the tenant is created.
  it("sends the free plan to the dashboard", () => {
    expect(postRegisterHref("basic", true)).toBe("/dashboard");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/register/plan-redirect.test.ts`
Expected: FAIL — cannot resolve `./plan-redirect`.

- [ ] **Step 3: Write the implementation**

Create `src/app/register/plan-redirect.ts`:

```ts
/**
 * Where registration lands. A validated plan key rather than a general `next`
 * parameter: `next` is an open-redirect surface needing the safeNext guard,
 * while a plan key is a closed set checked against the plans table.
 */
export function postRegisterHref(planKey: string | undefined, planExists: boolean): string {
  if (!planKey || !planExists || planKey === "basic") return "/dashboard";
  return `/dashboard/settings/billing?plan=${encodeURIComponent(planKey)}`;
}
```

- [ ] **Step 4: Carry the key through the form**

In `src/app/register/page.tsx`, read `searchParams.plan`, validate it against `listPlans()`, and pass the validated key (or `undefined`) into `<RegisterForm plan={...} />`.

In `src/app/register/RegisterForm.tsx`, accept `plan?: string` and render, inside the `<form>`:

```tsx
{plan ? <input type="hidden" name="plan" value={plan} /> : null}
```

- [ ] **Step 5: Use it in the action**

In `src/app/register/actions.ts`, replace `redirect("/dashboard")` with:

```ts
  const planKey = String(formData.get("plan") || "") || undefined;
  const planExists = planKey ? (await listPlans()).some((p) => p.key === planKey) : false;
  redirect(postRegisterHref(planKey, planExists));
```

Add the imports `import { listPlans } from "@/server/subscription";` and `import { postRegisterHref } from "./plan-redirect";`.

- [ ] **Step 6: Register the test and run**

Add `"src/app/register/**/*.test.ts"` to `include` in `vitest.unit.config.ts`, then run:
`npx tsc --noEmit && npx vitest run --config vitest.unit.config.ts`
Expected: tsc exits 0; PASS.

- [ ] **Step 7: Commit**

```bash
git add src/app/register vitest.unit.config.ts
git commit -m "feat(register): carry the chosen plan through signup"
```

---

### Task 7: The plan comparison table and a reusable FAQ

**Files:**
- Create: `src/app/(marketing)/_components/PlanComparison.tsx`
- Modify: `src/app/(marketing)/_components/Faq.tsx`
- Modify: `src/app/(marketing)/[lang]/page.tsx`
- Modify: `src/app/(marketing)/_content/pricing.ts`

**Interfaces:**
- Produces: `<PlanComparison plans={Plan[]} locale={Locale} />`, and `Faq` accepting `{ content, id }`

- [ ] **Step 1: Make Faq reusable**

Change `src/app/(marketing)/_components/Faq.tsx` to take its content and id as props, rather than reading `FAQ[locale]` and hardcoding `id="faq"`:

```tsx
import type { FaqContent } from "../_content/faq";

export function Faq({ content, id = "faq" }: { content: FaqContent; id?: string }) {
  return (
    <section id={id} className="mx-auto max-w-3xl px-6 py-20">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{content.eyebrow}</p>
      <h2 className="mt-4 text-3xl font-bold leading-tight tracking-[-0.03em]">{content.heading}</h2>
      <dl className="mt-10 divide-y divide-border/60">
        {content.items.map((item) => (
          <div key={item.q} className="py-5">
            <dt className="text-base font-bold tracking-[-0.01em]">{item.q}</dt>
            <dd className="mt-2 text-sm leading-7 text-muted-foreground">{item.a}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
```

`FaqContent` is already exported from `src/app/(marketing)/_content/faq.ts:3`. Update the home page call site in `src/app/(marketing)/[lang]/page.tsx` from `<Faq locale={locale} />` to `<Faq content={FAQ[locale]} />`, importing `FAQ`.

- [ ] **Step 2: Add the pricing FAQ content**

Extend `PricingContent` with `faq: FaqContent;` and add entries to both locales. Arabic:

```ts
    faq: {
      eyebrow: "أسئلة",
      heading: "أسئلة عن الباقات",
      items: [
        { q: "أقل مدة اشتراك كام؟", a: "ثلاثة شهور. الأسعار معروضة شهريًا وبتتحسب على المدة اللي تختارها." },
        { q: "أقدر أغيّر الباقة؟", a: "أيوه. كلّمنا وهنظبّطلك الباقة الجديدة من غير ما تفقد أي بيانات." },
        { q: "لو عديت حد الباقة؟", a: "بنبلغك قبل ما توصل للحد، وبنتفق على الترقية المناسبة." },
        { q: "الأسعار بالجنيه؟", a: "أيوه، كل الأسعار بالجنيه المصري." },
      ],
    },
```

English:

```ts
    faq: {
      eyebrow: "Questions",
      heading: "Questions about plans",
      items: [
        { q: "What is the minimum term?", a: "Three months. Prices are shown per month and billed over the term you choose." },
        { q: "Can I change plan later?", a: "Yes. Talk to us and we'll move you across without losing any data." },
        { q: "What if I exceed a limit?", a: "We tell you before you hit it and agree the right upgrade with you." },
        { q: "Are prices in Egyptian pounds?", a: "Yes, every price is in EGP." },
      ],
    },
```

- [ ] **Step 3: Write the comparison table**

Create `src/app/(marketing)/_components/PlanComparison.tsx`:

```tsx
import type { Plan, PlanFeatures, PlanLimits } from "@/server/subscription";
import type { Locale } from "@/shared/errors";
import { PRICING } from "../_content/pricing";

/**
 * Every value comes from the same `plan` rows PlanCard renders, never from
 * copy — so the table cannot contradict the cards.
 *
 * A zero limit renders as an em dash, not "0": PlanCard filters those out
 * because "0 WhatsApp numbers" is not a benefit, and a comparison grid is the
 * easiest place to reintroduce that mistake.
 */
export function PlanComparison({ plans, locale }: { plans: Plan[]; locale: Locale }) {
  const t = PRICING[locale];
  const limitKeys = Object.keys(t.limits) as (keyof PlanLimits)[];
  const featureKeys = Object.keys(t.features) as (keyof PlanFeatures)[];
  const nf = new Intl.NumberFormat(locale === "ar" ? "ar-EG" : "en");

  return (
    // Five columns do not fit a phone. The table scrolls inside this container
    // so the page body never scrolls sideways.
    <div className="mt-10 overflow-x-auto">
      <table className="w-full min-w-[36rem] border-collapse text-sm">
        <thead>
          <tr>
            <th scope="col" className="p-3 text-start font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
              {t.eyebrow}
            </th>
            {plans.map((p) => (
              <th key={p.id} scope="col" className="p-3 text-start font-bold">
                {t.planNames[p.key] ?? p.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {limitKeys.map((key) => (
            <tr key={key} className="border-t border-border/60">
              <th scope="row" className="p-3 text-start font-normal text-muted-foreground">{t.limits[key]}</th>
              {plans.map((p) => (
                <td key={p.id} className="p-3">
                  {p.limits[key] > 0 ? nf.format(p.limits[key]) : "—"}
                </td>
              ))}
            </tr>
          ))}
          {featureKeys.map((key) => (
            <tr key={key} className="border-t border-border/60">
              <th scope="row" className="p-3 text-start font-normal text-muted-foreground">{t.features[key]}</th>
              {plans.map((p) => (
                <td key={p.id} className="p-3">
                  <span aria-label={p.features[key] ? "included" : "not included"}>
                    {p.features[key] ? "✓" : "—"}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 4: Run parity and typecheck**

Run: `npx tsc --noEmit && npx vitest run "src/app/(marketing)/_content/parity.test.ts"`
Expected: tsc exits 0; PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(marketing)"
git commit -m "feat(marketing): plan comparison table and a reusable FAQ"
```

---

### Task 8: The /pricing page

**Files:**
- Create: `src/app/(marketing)/[lang]/pricing/page.tsx`

**Interfaces:**
- Consumes: `PricingTerms`, `PlanComparison` (Task 7), `Faq` (Task 7)

- [ ] **Step 1: Write the page**

Create `src/app/(marketing)/[lang]/pricing/page.tsx`:

```tsx
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { listPlans } from "@/server/subscription";
import type { Locale } from "@/shared/errors";
import { Header } from "../../_components/Header";
import { Footer } from "../../_components/Footer";
import { PaperSurface } from "../../_components/PaperSurface";
import { PricingTerms } from "../../_components/PricingTerms";
import { PlanComparison } from "../../_components/PlanComparison";
import { Faq } from "../../_components/Faq";
import { PRICING } from "../../_content/pricing";

function toLocale(lang: string): Locale {
  if (lang !== "ar" && lang !== "en") notFound();
  return lang;
}

const META: Record<Locale, { title: string; description: string }> = {
  ar: {
    title: "أسعار ServeOS — باقات بالجنيه المصري",
    description: "باقات ServeOS بالجنيه المصري: الحدود والمميزات لكل باقة، من غير مفاجآت.",
  },
  en: {
    title: "ServeOS pricing — plans in Egyptian pounds",
    description: "Every ServeOS plan, its limits and its features, priced in EGP.",
  },
};

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const locale = toLocale((await params).lang);
  const site = "https://serveos.tech";
  return {
    title: META[locale].title,
    description: META[locale].description,
    alternates: {
      canonical: locale === "ar" ? `${site}/pricing` : `${site}/en/pricing`,
      languages: { ar: `${site}/pricing`, en: `${site}/en/pricing` },
    },
  };
}

export default async function PricingPage({ params }: { params: Promise<{ lang: string }> }) {
  const locale = toLocale((await params).lang);

  // Same guard as the home page: /pricing is a marketing surface only, never
  // reachable on a tenant or admin host.
  const surface = (await headers()).get("x-surface");
  if (surface !== "marketing") notFound();

  const plans = (await listPlans()).filter((p) => p.isActive === "true");
  const t = PRICING[locale];

  return (
    <PaperSurface>
      <Header locale={locale} />
      <main>
        <section className="mx-auto max-w-6xl px-6 py-20">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t.eyebrow}</p>
          <h1 className="mt-4 max-w-2xl text-4xl font-bold leading-tight tracking-[-0.03em]">{t.heading}</h1>
          <p className="mt-4 max-w-xl text-sm leading-7 text-muted-foreground">{t.note}</p>
          <PricingTerms plans={plans} locale={locale} />
          <PlanComparison plans={plans} locale={locale} />
        </section>
        <Faq content={t.faq} id="pricing-faq" />
      </main>
      <Footer locale={locale} />
    </PaperSurface>
  );
}
```

- [ ] **Step 2: Verify both locales render**

Run the dev server, then:
`curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3006/pricing` → expect `200`
`curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3006/en/pricing` → expect `200`
`curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3006/login` → expect `200` (the allowlist must not have swallowed it)

- [ ] **Step 3: Commit**

```bash
git add "src/app/(marketing)/[lang]/pricing"
git commit -m "feat(marketing): a public pricing page in both locales"
```

---

### Task 9: Point the home section at it, and prove the bug is dead

**Files:**
- Modify: `src/app/(marketing)/_components/PlanCard.tsx`
- Modify: `src/app/(marketing)/_components/Pricing.tsx`
- Modify: `src/app/(marketing)/_content/pricing.ts`
- Create: `tests/e2e/pricing.spec.ts`

- [ ] **Step 1: Route every CTA through the fork**

In `PlanCard.tsx`, replace the conditional `href` so **all** plans, free included, go through `/subscribe`. The fork now owns the free-plan redirect (Task 3):

```tsx
      <Link
        href={`/subscribe?plan=${encodeURIComponent(plan.key)}`}
        className="mt-6 rounded-md border border-border px-4 py-2.5 text-center text-sm font-medium hover:bg-muted"
      >
        {isFree ? t.ctaFree : t.cta}
      </Link>
```

- [ ] **Step 2: Add the compare link**

Add `compareAll: string;` to `PricingContent`, with `"قارن كل الباقات"` (ar) and `"Compare all plans"` (en). In `Pricing.tsx`, after `<PricingTerms .../>`:

```tsx
      <a href="/pricing" className="mt-8 inline-block text-sm font-medium underline underline-offset-4">
        {t.compareAll}
      </a>
```

- [ ] **Step 3: Write the E2E tests**

Create `tests/e2e/pricing.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test("the pricing page serves Arabic right-to-left and English left-to-right", async ({ page }) => {
  await page.goto("/pricing");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.goto("/en/pricing");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("the comparison table lists every limit", async ({ page }) => {
  await page.goto("/en/pricing");
  for (const label of ["branches", "staff", "products", "orders / month"]) {
    await expect(page.getByRole("rowheader", { name: label, exact: true })).toBeVisible();
  }
});

test("the free plan self-serves, carrying its key into registration", async ({ page }) => {
  await page.goto("/en/pricing");
  await page.getByRole("link", { name: "Start free" }).first().click();
  await expect(page).toHaveURL(/\/register\?plan=basic/);
});

test("a paid plan asks a signed-out visitor to enquire", async ({ page }) => {
  await page.goto("/en/pricing");
  await page.getByRole("link", { name: "Get started" }).first().click();
  await expect(page).toHaveURL(/\/subscribe\?plan=/);
  await expect(page.getByRole("button", { name: "Send request" })).toBeVisible();
});

// The reported bug. The marketing page hands out a real session via the demo
// door, and that session used to satisfy "is signed in", delivering prospects
// into the demo tenant's billing page.
test("a demo visitor is never delivered into the demo tenant's billing page", async ({ page }) => {
  await page.goto("/api/demo/login?trade=pharmacy");
  await expect(page).toHaveURL(/\/dashboard/);

  await page.goto("/en/pricing");
  await page.getByRole("link", { name: "Get started" }).first().click();

  await expect(page.getByRole("button", { name: "Send request" })).toBeVisible();
  expect(page.url()).not.toContain("/dashboard/settings/billing");
});

// Guards the locale allowlist: these must never be rewritten into [lang].
test("sign-in routes still work alongside the pricing rewrite", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator("form")).toBeVisible();
  await page.goto("/register");
  await expect(page.locator("form")).toBeVisible();
});
```

- [ ] **Step 4: Run the E2E suite**

Run: `npx playwright test tests/e2e/pricing.spec.ts tests/e2e/marketing.spec.ts`
Expected: PASS. The marketing spec must still pass — `PlanCard`'s href changed.

- [ ] **Step 5: Run everything**

Run: `npx tsc --noEmit && npx eslint "src/app/(marketing)" src/app/subscribe src/app/register src/server/enquiries && npm test`
Expected: tsc 0, eslint 0, all vitest tests pass.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(marketing)" tests/e2e/pricing.spec.ts
git commit -m "feat(marketing): send every plan CTA through the corrected fork"
```

---

## Deployment prerequisites

Not code, and not blocking the build — enquiries are captured either way, as `unsent` rows.

- `SALES_INBOX_EMAIL` on both Vercel projects (`serve-os`, `serve-os-qa`).
- `RESEND_API_KEY` and `EMAIL_FROM=no-reply@serveos.tech` on both.
- The `serveos.tech` domain verified in Resend. DNS (DKIM, SPF, MX, DMARC) is live and correct as of 2026-08-17; Resend returned 403 because it had not yet re-polled. Press "Verify DNS Records" there.
- Rotate the Resend API key once setup is confirmed — it was shared in a chat transcript.
