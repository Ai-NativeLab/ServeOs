# ServeOS — Tenant & Subscription Core (Foundation) — Design Spec

**Date:** 2026-06-13
**Status:** Approved (design), pending implementation plan
**Sub-project:** #1 of the ServeOS platform program

---

## 0. Context

ServeOS is a multi-tenant SaaS platform (online ordering, restaurant management,
reservations, and WhatsApp commerce) for restaurants, cafés, bakeries, and food
businesses in **Egypt and Saudi Arabia**, modeled on the QrExOrder SaaS concept.

The full platform decomposes into ~6 dependent sub-projects:

1. **Tenant & Subscription Core (this spec)** — multi-tenancy, auth, RBAC,
   onboarding/approval, plans, entitlements, manual billing, admin platform.
2. Menu & Catalog (products, categories, variants/add-ons, branches, inventory).
3. Ordering & Checkout (storefront, QR/table, pickup/delivery, coupons, payment gateways).
4. WhatsApp Commerce (per-tenant WhatsApp Business numbers, conversational ordering, inbox).
5. Reservations.
6. Restaurant Dashboard + Reports/Analytics.

This document specifies **only sub-project #1**, the foundation everything else
builds on. Each later sub-project gets its own spec → plan → build cycle.

---

## 1. Locked Decisions

| Area | Decision |
|------|----------|
| **Stack** | Next.js (App Router) + Postgres + Drizzle ORM |
| **Auth** | Self-hosted (Auth.js or Lucia), Drizzle session adapter |
| **Tenancy** | Shared DB, `tenant_id` on every tenant-scoped table + Postgres Row-Level Security (RLS) |
| **Routing** | `{slug}.serveos.com` storefronts, `app.serveos.com` dashboard, `admin.serveos.com` platform; custom domains later |
| **App structure** | Single modular Next.js app; logic in `src/server/` domain modules |
| **Onboarding** | Instant trial dashboard access → admin approval required to publish public storefront |
| **Billing** | Manual/offline activation now, behind a gateway-ready `BillingProvider` interface (Paymob/Fawry/PayTabs later) |
| **Plans gate on** | Resource quotas + feature flags + WhatsApp-number caps + metered order/message volume |
| **Localization** | English + Arabic, full RTL; per-tenant `country` (EG/SA), `currency` (EGP/SAR), `locale` (ar/en), `timezone` |
| **Storefront** | Installable **PWA** per tenant subdomain (dynamic per-tenant manifest + service worker) |

---

## 2. Architecture & Surfaces

One Next.js (App Router) application deployed once, serving three surfaces
distinguished by hostname via `middleware.ts`.

| Surface | Host | Audience | Auth |
|---------|------|----------|------|
| **Storefront** (PWA shell) | `{slug}.serveos.com` (+ custom domains later) | End customers | Public (customer accounts come in a later sub-project) |
| **Dashboard** | `app.serveos.com` | Restaurant owners & staff | Owner/staff login |
| **Admin** | `admin.serveos.com` | Platform super-admins | Super-admin login |

### Request flow

1. `middleware.ts` reads the `Host` header.
2. For a storefront host: resolve tenant by subdomain slug (cached lookup);
   attach `tenantId` + resolved locale/region to request context; set the
   Postgres RLS session variable `app.tenant_id` for all DB queries in the request.
3. `app.` / `admin.` hosts bypass tenant resolution and apply their own auth guards.
4. Unknown host → marketing 404. Tenant resolution failures **fail closed** (deny).

### Server-side domain modules (`src/server/`)

Each module is self-contained (service + Drizzle schema + types); the rest of the
app depends only on the exported service interface.

- `tenancy` — tenant CRUD, slug/subdomain resolution, RLS context, branding fields (feeds PWA manifest)
- `auth` — sessions, login, password, OTP seam, role checks
- `rbac` — roles & permissions for owner/staff/admin
- `subscription` — plans, plan assignment, trial/active/suspended state machine
- `entitlements` — quotas + feature flags + usage metering; the single gate other features call
- `billing` — `BillingProvider` interface (manual now) + invoices
- `onboarding` — self-registration → trial → admin approval workflow
- `platform` — admin-only: tenant approval, suspension, revenue/usage monitoring

A thin `src/app/` layer (route groups `(storefront)`, `(dashboard)`, `(admin)`)
calls these services through server actions / route handlers.

---

## 3. Data Model

Every tenant-scoped table has `tenant_id` with an RLS policy
`tenant_id = current_setting('app.tenant_id')`. Platform tables (plans, super-admins)
are not tenant-scoped.

### Identity & tenancy

- **`tenants`** — `id`, `slug` (subdomain, unique), `name`, `status`
  (`onboarding` | `trial` | `active` | `suspended` | `rejected`), `country` (EG/SA),
  `currency`, `default_locale` (ar/en), `timezone`, `custom_domain` (nullable, later),
  branding (`logo_url`, `primary_color`, `theme`), `created_at`.
- **`users`** — `id`, `tenant_id` (nullable; null = platform super-admin), `name`,
  `email` (nullable), `phone` (nullable), `password_hash` (nullable for OTP-only),
  `locale`, `status`. Unique `(tenant_id, email)` and `(tenant_id, phone)`.
  *Customer identity is out of scope here — added later as a separate pool.*
- **`sessions`** — `id`, `user_id`, `expires_at`, device/user-agent.

### Roles & permissions

- **`roles`** — `id`, `tenant_id` (null = platform-level), `key`
  (`owner` | `manager` | `staff` | `super_admin`), `name`.
- **`user_roles`** — `user_id`, `role_id`.
- Permissions are a **static catalog in code** mapped to role keys (no permissions
  table in v1) — simple and extensible.

### Subscription, plans & billing

- **`plans`** (platform-level) — `id`, `key`, `name`, `price_monthly`, `currency`,
  `is_active`, JSON `limits`
  (`{ branches, staff, products, whatsapp_numbers, orders_per_month, messages_per_month }`),
  JSON `features`
  (`{ whatsapp, custom_domain, custom_theme, reservations, advanced_analytics }`).
- **`subscriptions`** — `id`, `tenant_id`, `plan_id`, `status`
  (`trialing` | `active` | `past_due` | `suspended` | `canceled`), `trial_ends_at`,
  `current_period_start`, `current_period_end`, `provider` (`manual` now).
- **`invoices`** — `id`, `tenant_id`, `subscription_id`, `amount`, `currency`,
  `status` (`open` | `paid` | `void`), `paid_at`, `method` (manual/bank/cash),
  `marked_by` (admin user).
- **`usage_counters`** — `tenant_id`, `metric` (`orders` | `messages`),
  `period_start`, `count`. Written by later subsystems; entitlements reads it for volume caps.

### Onboarding & audit

- **`onboarding_applications`** — `id`, `tenant_id`, `submitted_at`, `status`
  (`pending` | `approved` | `rejected`), `reviewed_by`, `review_notes`.
- **`audit_logs`** — `id`, `tenant_id` (nullable), `actor_user_id`, `action`,
  `target`, `metadata` (JSON), `created_at`.

**Design notes:** (1) plan `limits`/`features` are JSON so adding a gated dimension
needs no migration; (2) `usage_counters` is defined in the foundation but only
*written* by later subsystems — the foundation owns the read-side enforcement.

---

## 4. Auth, Roles & Entitlements

### Authentication

- Self-hosted via Auth.js (or Lucia) with a Drizzle adapter writing `sessions`.
- **Dashboard (owner/staff):** email + password to start, with a pluggable
  `OtpProvider` seam for **phone OTP** (dominant in EG/SA). OTP delivery rides the
  WhatsApp/SMS subsystem later; the foundation defines the interface + a dev/no-op provider.
- **Admin (super-admin):** email + password, separate guard, `tenant_id = null` users only.
- Sessions are httpOnly cookies scoped to `app.` / `admin.` hosts. Storefront is
  public in this foundation.

### RBAC

- Static permission catalog in code (e.g. `tenant:manage`, `staff:invite`,
  `plan:view`, `billing:manage`, `platform:approve_tenant`) mapped to role keys
  (`owner` > `manager` > `staff`, plus `super_admin`).
- Single `authorize(user, permission)` helper guards every server action / route handler.

### Entitlements — the single gate

One module every plan-limited feature must call. Reads the tenant's active plan +
`usage_counters`. Three check types:

- `checkQuota(tenant, key)` → current count vs `limits[key]`; throws typed
  `QuotaExceededError` carrying limit + current value.
- `hasFeature(tenant, key)` → boolean from `features[key]`.
- `checkUsage(tenant, metric)` → `usage_counters` for the period vs `limits.*_per_month`.

Defined and enforced in the foundation but **consumed everywhere** (e.g. the Menu
sub-project calls `checkQuota(tenant, 'products')`). Suspended/past-due subscriptions
short-circuit the dashboard to read-only.

---

## 5. Onboarding, Approval, Billing & Storefront Shell

### Self-registration → trial → go-live

1. Owner signs up at `app.serveos.com/register`: name, email/phone, restaurant name,
   desired slug (validated for uniqueness/format), country (EG/SA). Creates a
   `tenant` (`status: onboarding`), an owner `user`, a `subscription` on a default
   plan (`status: trialing` + `trial_ends_at`), and an `onboarding_application`
   (`status: pending`).
2. Owner gets **immediate dashboard access** (branding, plan selection). Public
   storefront subdomain stays unpublished ("coming soon" page) until approval.
   Tenant flips to `status: trial` internally on first login.
3. A platform admin reviews the application in the **approval queue** at
   `admin.serveos.com` and **approves** (storefront goes live; tenant `active`-eligible)
   or **rejects** (`status: rejected`, owner notified, can edit & resubmit). Every
   action writes an `audit_log`.

### Billing (manual now, gateway-ready)

- `BillingProvider` interface: `createInvoice(subscription)`,
  `settleInvoice(invoice, method)`, `getStatus(subscription)`.
- v1 `ManualBillingProvider`: generates an `open` invoice when a trial ends or a
  period renews; an admin records payment (`bank`/`cash`/`manual`) → invoice `paid`,
  subscription `active`, period extended.
- Unpaid past a grace window → `past_due` → `suspended` (dashboard read-only,
  storefront shows closed).
- Future `PaymobProvider` / `FawryProvider` / `PayTabsProvider` implement the same
  interface + a webhook handler — **no changes to subscription logic.**

### Storefront / PWA shell (foundation scope)

- Each `{slug}.serveos.com` serves a minimal shell with a **dynamic per-tenant
  manifest** (`/manifest.webmanifest` route reads tenant branding → name, icons,
  `theme_color`, `background_color`, `start_url`) and a **service worker scoped to
  the tenant origin**.
- The foundation ships an installable "coming soon"/placeholder storefront proving
  PWA install + per-tenant branding works end-to-end.
- The menu/ordering UI and offline caching strategy land in the Ordering sub-project.

---

## 6. Error Handling

- **Typed domain errors:** `QuotaExceededError`, `FeatureNotAvailableError`,
  `SubscriptionInactiveError`, `TenantNotFoundError`, `UnauthorizedError`,
  `SlugTakenError` — each carrying structured data (limit, current value, required
  plan) for actionable, **localized (en/ar)** UI messages.
- A single error boundary per surface maps domain errors → HTTP status + localized
  message; unexpected errors are logged with `tenant_id` + request id and shown as a
  generic fallback.
- **RLS as a safety net:** even if app code forgets a `tenant_id` filter, RLS blocks
  cross-tenant reads/writes. Tenant resolution fails **closed**.
- Middleware guards: unknown host → marketing 404; unapproved tenant storefront →
  "coming soon"; suspended tenant → read-only/closed states.

---

## 7. Testing

- **Unit:** entitlement checks (quota/feature/usage at and across limits),
  subscription state machine transitions, RBAC `authorize` matrix, slug validation,
  manual billing lifecycle.
- **Integration:** RLS isolation (tenant A cannot read tenant B under any query),
  middleware host→tenant resolution, full register→trial→approve→publish flow,
  trial-expiry→past_due→suspend flow.
- **E2E (smoke):** owner registers → sets branding → admin approves → storefront
  subdomain resolves and is **installable as a PWA** with the tenant's branding in
  the manifest.
- **Seed script:** demo tenants, plans (Basic/Pro/Enterprise), a super-admin.

---

## 8. Scope Boundaries

### In scope (this foundation)

Multi-tenancy + RLS, three-surface routing, self-hosted auth + RBAC, plans +
entitlements (quotas/flags/usage read-side), onboarding + admin approval, manual
billing behind a provider interface, per-tenant installable PWA storefront shell,
en/ar + RTL, EG/SA region fields, audit logging.

### Out of scope (later sub-projects)

- Menu/catalog, products, branches' operational data → **Menu sub-project**
- Online ordering, cart, checkout, QR/table ordering, customer payment gateways →
  **Ordering sub-project**. *Captured forward requirement: orders from all channels
  (web storefront, QR/table, and WhatsApp) must surface in a single unified order
  list in the tenant dashboard, so the owner sees web and WhatsApp orders side by
  side — the dashboard is the one source of truth, with WhatsApp as an additional
  channel feeding into it, not a separate silo.*
- WhatsApp commerce integration (foundation only reserves the number-count
  entitlement + `OtpProvider` seam) → **WhatsApp sub-project**
- Reservations, customer accounts/favorites, analytics dashboards, real
  payment-gateway subscription billing → respective later sub-projects

---

## 9. Success Criteria

A restaurant can self-register, get a trial dashboard, be approved by an admin, and
have a branded, **installable PWA** storefront resolve on its subdomain — with plan
entitlements enforceable and RLS-guaranteed tenant isolation — ready for the Menu
sub-project to build on top.
