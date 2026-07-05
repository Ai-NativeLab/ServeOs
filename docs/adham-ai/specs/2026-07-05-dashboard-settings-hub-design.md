# ServeOS Dashboard Settings Hub — Design

**Date:** 2026-07-05
**Status:** Approved (design) — pending implementation plan
**Scope:** Restaurant dashboard surface only (`/dashboard/settings/*`), plus one
small addition to the customer-facing order confirmation page.

## Problem

The dashboard's "Settings" nav item currently just points at the Fulfillment
page (VAT, hours, delivery areas, accepting-orders). There is no place to edit
the restaurant's basic profile, connect a WhatsApp number for order
notifications, manage staff accounts, or see the current subscription plan and
usage — even though the RBAC permissions for several of these
(`tenant:manage`, `billing:manage`, `staff:invite`) and the plan schema's
`whatsapp` / `whatsapp_numbers` fields already exist unused. This blocks
restaurants from self-serving basic setup and forces everything through
support.

This is the first of three sub-projects agreed for this round of dashboard
work (Settings Hub → Analytics → Publish menu URL/QR); the other two get their
own specs.

## Goal

Turn "Settings" into a real multi-section hub: Business Profile, WhatsApp,
Fulfillment (relocated, unchanged), Staff, and Billing/Plan — each gated by
existing RBAC permissions, styled with the existing brand system (no new
visual system needed), reusing existing components (`PageHeader`, `ToastForm`,
`SubmitButton`, `Card`, `Tabs`, `AlertDialog`, `EmptyState`).

## Decisions (locked)

| Decision | Choice |
|---|---|
| Settings layout | Single "Settings" sidebar entry; tabs inside (Business Profile · WhatsApp · Fulfillment · Staff · Billing) |
| WhatsApp mechanism | **Click-to-chat `wa.me` link** — customer's own WhatsApp opens with a pre-filled message to the restaurant's number; no Business API, no cost, no new infra |
| WhatsApp plan-gating | **None** — available on every plan; the schema's `whatsapp` feature flag/`whatsapp_numbers` limit stay reserved for a possible future paid Business-API tier |
| Staff creation | **Direct account creation** by owner/manager (name, email/phone, temp password, role) — no email invite link, since no transactional email provider exists in the codebase |
| Billing self-serve | **View + request only** — plan/usage/invoices are read-only; "Request upgrade" flags the tenant for manual platform-admin action (billing is already manual/bank via `manual-provider.ts`, no payment gateway) |
| Business profile edits | Name, logo URL, primary color, default locale, timezone — **not** slug/country/currency (storefront URL and billing/VAT implications) |

## Non-goals (this pass)

- Email invite infrastructure (Resend/nodemailer/etc.) for staff.
- Self-serve payment/checkout for plan upgrades.
- Full redesign of the customer storefront / order confirmation page — only
  one button is added to `/order/[token]`.
- Automated WhatsApp Business API (Meta Cloud API/Twilio) push notifications.
- Arabic UI translation of the dashboard chrome.
- Analytics and Publish-menu-URL/QR screens — separate specs.

## 1. Architecture & routing

- New route group `src/app/dashboard/settings/` with a shared `layout.tsx`:
  loads `requireDashboardUser()` once, renders `PageHeader` + a tab bar
  (`Tabs`-as-links, active tab from the current pathname), showing only tabs
  the signed-in role can access.
- Sub-routes, each its own `page.tsx` (+ `actions.ts` where needed), matching
  the existing per-feature folder convention:
  - `/dashboard/settings/profile` — Business Profile
  - `/dashboard/settings/whatsapp` — WhatsApp
  - `/dashboard/settings/fulfillment` — relocated from `/dashboard/fulfillment`, content/logic unchanged
  - `/dashboard/settings/staff` — Staff
  - `/dashboard/settings/billing` — Billing/Plan
- `/dashboard/settings` (index) redirects to the first tab the current role
  can access.
- `/dashboard/fulfillment` and `fulfillment-permission.ts` are removed; their
  content/guard logic moves to `settings/fulfillment/`.
- `src/components/dashboard/nav-items.ts`: "Settings" href becomes
  `/dashboard/settings`. Existing `nav-items.test.ts` only asserts labels, not
  hrefs, so no test changes needed there.

## 2. Access control per tab

Reuses existing RBAC permissions — **no new permissions added**:

| Tab | Permission | Owner | Manager | Staff |
|---|---|---|---|---|
| Business Profile | `tenant:manage` | ✅ | — | — |
| WhatsApp | `fulfillment:manage` | ✅ | ✅ | — |
| Fulfillment | `fulfillment:manage` | ✅ | ✅ | — |
| Staff | `staff:invite` | ✅ | ✅ | — |
| Billing / Plan | `billing:manage` | ✅ | — | — |

Each `page.tsx` calls `authorize(roleKeys, "<permission>")` directly (same
pattern as today's `requireFulfillmentPermission()`), so direct URL access is
blocked even if a tab is hidden from the tab bar. Staff (whose only dashboard
permission is `orders:manage`) see no Settings tabs at all and are redirected
to Orders, consistent with today's Home-page behavior.

## 3. Data model changes

No new tables. Extends existing structures:

- **WhatsApp number** — extend `TenantSettingsData` in
  `src/server/tenancy/settings.ts`:
  ```ts
  export type TenantSettingsData = { vatRate?: number; whatsappNumber?: string };
  ```
  Add `getWhatsappNumber(tenantId)` / `setWhatsappNumber(tenantId, e164: string)`
  mirroring `getVatRate`/`setVatRate` exactly (same JSONB-merge read/write
  pattern against `tenant_settings`, RLS via `withTenant`). Stored/validated
  as E.164 (`+20…`, `+966…`); clearing the value removes the key.

- **Business Profile** — direct `db.update(tenants)` on `name`, `logoUrl`,
  `primaryColor`, `defaultLocale`, `timezone` (control table, plain `db`, same
  as `registerRestaurant`'s insert). `slug`, `country`, `currency` are
  read-only in this screen.

- **Staff** — new function in `src/server/auth` (e.g. `createStaffUser`)
  that does what `registerRestaurant` does for the owner — insert into
  `users` (with `tenantId`, hashed password) + look up/create the tenant's
  `manager`/`staff` `roles` row + insert `user_roles` — but without creating a
  new tenant. Listing = join `users` → `user_roles` → `roles` filtered by
  `tenantId`. Deactivate = `users.status = "inactive"` (soft, preserves
  history/audit trail — order records, etc. still reference the user) **and**
  deletes that user's rows from `sessions`, so an already-logged-in deactivated
  staff member is signed out immediately rather than staying in until natural
  expiry. Owner's own row is excluded from list actions (can't demote/
  deactivate self via this screen).

- **Billing/Plan** — read-only, no new writes except "Request upgrade" which
  sets a `requestedPlanKey` + `requestedAt` timestamp in the same
  `tenant_settings` JSONB bag (extend `TenantSettingsData` further:
  `upgradeRequest?: { planKey: string; requestedAt: string }`) for a platform
  admin to see and act on manually — reuses the same schema mechanism as VAT
  and WhatsApp, no new table.

## 4. Screen-by-screen content

**Business Profile** (`tenant:manage`)
Form: Restaurant name, Logo URL (with live thumbnail preview), primary color
(swatch input), default locale (EN/AR select), timezone (select). Read-only
info card: slug, country, currency, with a short note on why they're locked.
`ToastForm` + `SubmitButton`, same feedback pattern as every existing form.

**WhatsApp** (`fulfillment:manage`)
Single field: WhatsApp number (E.164), validated client- and server-side.
Live preview of the resulting `wa.me` link. "Send test message" button opens
it in a new tab so the owner can confirm the number works before relying on
it. Explanatory copy: "Customers get a pre-filled WhatsApp message to send you
after checkout." Clearing the field disables the storefront button (Section 5).

**Fulfillment** (`fulfillment:manage`)
Moved as-is from `/dashboard/fulfillment` — VAT, per-branch hours, delivery
areas, accepting-orders toggle. Zero behavior change, pure relocation.

**Staff** (`staff:invite`)
Table: name, email/phone, role badge, status (active/inactive). "+ Add staff"
opens a form (name, email or phone, temporary password, role select limited
to Manager/Staff — cannot create another Owner). Row actions: change role,
deactivate (`AlertDialog` confirm). Owner's own row isn't editable here.
`EmptyState` when no staff added yet.

**Billing / Plan** (`billing:manage`)
Current-plan card: name, price, status badge, trial countdown if trialing.
Usage section: Bricolage big-number bars for branches/products/staff/orders
this month vs. plan limits (`usageCounters`, existing counts). Invoice history
table (date, amount, status, method) — read-only, from `invoices`. Plan
comparison table (Starter/Growth/Enterprise, features + limits) with
"Request upgrade" button on higher tiers than current.

## 5. Customer-facing touchpoint

`src/app/order/[token]/page.tsx` (currently fully unstyled, out of scope for
the brand rollout) gets exactly one addition: if the tenant has a WhatsApp
number configured (`getWhatsappNumber`), render a single button — "Send order
via WhatsApp" — linking to:

```
https://wa.me/{number}?text={encoded order summary}
```

where the summary includes order number, items, total, and fulfillment type
(pickup/delivery). If no number is configured, the button doesn't render — no
broken or empty states. This does **not** restyle the rest of that page; a
full storefront redesign is a separate future project.

## 6. States, feedback & error handling

- All new forms use existing conventions: `ToastForm` + `SubmitButton`
  (pending spinner + disabled state), inline field errors in brand red,
  `AlertDialog` for destructive actions (staff deactivate).
- `EmptyState` for Staff (no staff yet) and Invoices (no invoices yet).
- Settings tab bar hides tabs the role can't access; direct navigation to a
  hidden tab's URL is blocked server-side by the same `authorize()` guard.

## 7. Testing & rollout

- Unit tests: `settings` tab-visibility-per-role (mirrors `nav-items.test.ts`
  style); `tenancy/settings.ts` additions (`getWhatsappNumber`/
  `setWhatsappNumber`, E.164 validation); new staff-creation service function
  (role restriction, soft-disable behavior).
- Typecheck + `next build` before and after (per `AGENTS.md`'s non-standard
  Next.js warning).
- Existing vitest suite stays green — no changes to Orders/Menu/Branches/
  Banners logic.
- Manual pass: each new tab against the brand system; the WhatsApp button on
  `/order/[token]` with and without a configured number.
- **Ship order** (each a reviewable, shippable unit): Foundation (settings
  layout + tab shell + Fulfillment relocation) → Business Profile → WhatsApp
  (+ storefront button) → Staff → Billing/Plan.

## Risks

- **Staff row uniqueness**: `users` has per-tenant unique indexes on
  email/phone — creating a staff account with an email/phone already used by
  another user in the same tenant must surface a clear inline error, not a
  raw DB constraint failure.
- **`wa.me` link length**: very large orders (many line items) could produce
  a long pre-filled text; cap the summary (e.g. first N items + "+K more") if
  needed so the link doesn't silently fail on some devices.
