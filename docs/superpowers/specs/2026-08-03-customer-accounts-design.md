# ServeOS — Customer Accounts & Identity (P2) Design

**Date:** 2026-08-03 · **Issue:** #55 · **Roadmap:** vertical-platform P2
**Owner decisions (2026-08-03):** per-tenant accounts · email + password · guest checkout stays the default.

## Problem
Storefront customers are anonymous strings on an order. Nothing lets a
returning customer see their orders, prefill checkout, or later hold loyalty
points (P6) or request a return (P5) — both of which are blocked on an
identity to hang state off.

## Decisions
| # | Decision |
|---|---|
| C1 | **Per-tenant accounts.** A customer row lives inside one tenant (FORCE RLS). The same person registers separately at another shop. No cross-tenant identity, no consent surface. |
| C2 | **Email + password**, reusing the shipped primitives (`hashPassword`, session-token pattern). Password reset by email is a follow-up gated on Resend go-live — filed, not built. |
| C3 | **Accounts are optional.** Guest checkout is untouched; signing in only *attaches* `orders.customerId` and prefills contact fields. |
| C4 | **Customer sessions are a separate lane** from staff sessions: own table, own cookie (`serveos_customer`), resolved against the storefront host's tenant — a customer cookie can never open the dashboard, and `validateSession`'s staff lane never sees customer tokens. |
| C5 | **Auth events are audited** (D1 covers all actor types): `customer.registered`, `customer.login`, `customer.login_failed`, `customer.logout`, actorType `customer`. |

## Data model (migration 0028)
- `customers` (FORCE RLS): id, tenantId, name, email, phone?, passwordHash,
  defaultAddressText?, status `active|disabled`, createdAt.
  Unique `(tenantId, email)` — the same email can exist at two shops.
- `customer_sessions` (FORCE RLS): id, tenantId, customerId FK, tokenHash
  (sha256, never the token), userAgent?, expiresAt (30d), createdAt.
- `orders.customerId` — nullable FK; guest orders stay null forever.

## Surfaces
- Storefront `/account` (login/register/profile/orders) + sign-out. Tenant from
  the `x-tenant-slug` host header, exactly like the storefront page itself.
- `requireCustomer(tenantId)` context helper mirrors `requireDashboardUser`,
  reading the customer cookie and validating against `customer_sessions`.
- Checkout: when signed in, name/phone prefill and the placed order carries
  `customerId` (still guest-shaped input otherwise).
- Order history: the customer's own orders (`customerId = me`), newest first —
  RLS plus the customerId predicate; a signed-out visitor sees the login form.

## Non-goals (v1)
Password reset email (follow-up; needs Resend live) · cross-tenant SSO ·
loyalty/returns themselves (P6/P5 consume this) · customer-facing WhatsApp
linking (identity there is the waId; a later bridge can join them).
