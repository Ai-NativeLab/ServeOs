# Customer Accounts (P2) — Implementation Plan

> Implements docs/superpowers/specs/2026-08-03-customer-accounts-design.md · issue #55.
> TDD task-by-task. Next migration index: **0028**.

## Task 1 — Schema
`src/server/customers/schema.ts` (customers, customer_sessions), `orders.customerId`
column, barrel registration, migration 0028 with hand-appended RLS for both new
tables. Tests: RLS isolation; `(tenantId, email)` unique but same email OK across
tenants; guest order keeps customerId null.

## Task 2 — Service + sessions
`src/server/customers/service.ts`: `registerCustomer`, `authenticateCustomer`
(both audit per C5, generic invalid-credentials error, bcrypt via shared
`hashPassword`/`verifyPassword`), `createCustomerSession` (returns raw token,
stores sha256), `validateCustomerSession`, `invalidateCustomerSession`.
Register in audit coverage. Tests: register→login round-trip; wrong password
generic; disabled customer refused; session validate/expiry/invalidate; audit
rows with actorType customer; cross-tenant email reuse.

## Task 3 — Storefront surface
`requireCustomer` helper (host header → tenant → cookie → session) +
`/account` page with login/register (server actions), profile (name/phone/
default address), order history (own orders via customerId), sign-out.
Storefront header link. Cookie: `serveos_customer`, httpOnly, 30d.

## Task 4 — Checkout attach + prefill
`placeOrder` input gains optional `customerId` (server-resolved, never trusted
from the client: the checkout action reads it from the session, not the form).
Checkout page prefills name/phone from the signed-in customer. Test: signed-in
checkout stamps customerId; guest stays null.

## Task 5 — Verify + PR
Full suite, tsc, eslint, build. PR closes #55; follow-up issue for password
reset (needs Resend live). Note for #58/#59: the P2 half of their blocker is
now satisfied.
