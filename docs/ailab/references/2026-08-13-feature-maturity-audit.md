# ServeOS Feature Maturity Audit

**Date:** 2026-08-13
**Question:** what exists, what actually works, what needs work, and what is a name with nothing behind it.

## How each feature was classified

The WhatsApp dead end is the reason this audit exists. That feature had 17 test files, 77 passing
tests, a complete state machine and a full database schema — and **a first-time customer could not
place an order at all**, because nothing ever rendered the button that led into the catalogue. Unit
tests could not catch it: every test synthesised the tap directly.

So "has tests" is not the bar. The bar used here is **reachability** — can a real user get from a
cold start to the outcome, using only what the product actually shows them.

| Tier | Meaning |
|---|---|
| **A — Proven** | A journey test walks it end to end, as a user, through the UI or public API |
| **B — Built, unproven** | Every layer exists and is unit-tested, but no test walks the journey. WhatsApp sat here while broken |
| **C — Partial** | A layer is missing — usually domain logic with no way to reach it, or a gate that does not gate |
| **D — Name only** | Appears in config or marketing, no implementation |

Tier B is the important column. It is not "broken" — it is **unverified**, and this codebase has
already produced one silent dead end from exactly that state.

---

## A — Proven working

Each of these has a Playwright journey walking it. 43 e2e tests total.

| Feature | Journey proven | Spec |
|---|---|---|
| Sign in, sign out, role redirects | Owner signs in and reaches Orders; staff is redirected away from settings; sign-out ends the session | `dashboard.spec.ts` |
| Platform admin console | Admin signs in and reaches the console; a tenant user gets an explanation, not a login loop; a non-admin is told why | `admin.spec.ts` |
| Storefront browse → cart → checkout | Customer browses, adds to cart, reaches checkout | `ordering.spec.ts`, `shop.spec.ts` |
| Product variants in cart | Add a variant from a phone viewport; out-of-stock card visible but not clickable | `shop.spec.ts` |
| Menu API | Published products for an active tenant; 404 unknown slug; 400 missing slug | `menu.spec.ts` |
| Order scheduling | Customer schedules an order and cancels it while pending | `scheduling.spec.ts` |
| **Offline payment, full loop** | Checkout shows the enabled method → `POST /api/orders` creates `pending_verification` → **it appears in the merchant's payments queue** | `offline-payment.spec.ts` |
| Storefront PWA + tenant isolation | Branded installable manifest; marketing host does not leak a tenant | `onboarding.spec.ts` |
| Mobile / responsive | Dashboard drawer, card layouts, no horizontal overflow, 40px tap targets, no iOS input zoom | `responsive.spec.ts`, `storefront-responsive.spec.ts` (11 tests) |
| Marketing site | Arabic-first RTL without JS, `/en`, trade switching, roadmap chips, pricing from DB | `marketing.spec.ts` (11 tests) |

The offline-payment chain is the strongest thing in the codebase — it is the only feature with a
verified journey that crosses customer, API and merchant surfaces.

---

## B — Built, but the journey is unproven

Full stack present. Unit-tested. **No test walks the user journey.** Listed by risk.

| Feature | What exists | Why it is unproven |
|---|---|---|
| **POS** | 25 API routes (`pos/v1/*`: pair, login, catalog, sales, payments, refund, reprint, held tickets, shifts open/close/movements, X and Z reports), pairing UI with `generatePairingCodeAction`, a separate Vite/Electron app, 12 test files | **No e2e at all.** The largest surface in the product with zero journey coverage. Pairing a device, opening a shift, ringing a sale, taking payment, closing with a Z report — none walked |
| **WhatsApp ordering** | State machine, 25 files, 17 test files, webhook with HMAC, handoff tokens | **Was broken until today.** Fixed, and a reachability test added — but still no e2e, and it has never run against real Meta traffic in any database I can see |
| **Inventory** | 12 API routes (items, on-hand, adjustments, counts + commit, transfers, receipts, recipes, product links), dashboard pages, 5 test files | Stock ledger and BOM deduction are financially consequential and unwalked |
| **Prescriptions** | Domain with storage, `/prescriptions` page, actions, API route, 2 test files | Rx review and dispensing — the pharmacy vertical's whole reason to buy |
| **Analytics** | Four pages (sales, financial, inventory, purchasing), 4 test files, gated on `advanced_analytics` | Gate is enforced; the reports themselves are unwalked |
| **Audit log** | 13 test files — the second-most-tested domain — page, `/api/audit/events`, chain status | Heavily unit-tested, journey unwalked |
| **Notifications + email** | Worker, webhook per provider, mark-read, daily cron in `vercel.json`, 6 test files | Delivery is unproven end to end |
| **Customers / CRM** | Page, actions, trade approval form, 4 test files | — |
| **Branches, delivery areas, fulfilment** | Actions, `/api/delivery-areas`, 4 test files | Partially exercised by scheduling and ordering |
| **Staff / RBAC** | Actions, 3 test files | Only the staff-redirect case is walked |
| **Billing / subscription** | Actions, manual provider, 6 test files | Plan change and trial expiry unwalked |
| **Banners** | Page, actions, 1 test file | — |
| **Taxes** | Actions | No dedicated tests found |
| **Media upload** | API route | — |

---

## C — Partial: a layer is missing

| Item | What is there | What is missing |
|---|---|---|
| **Cut-to-order lists** | `deductCutToSize` in `inventory/service.ts:706` | **No UI anywhere.** `cutLength` appears nowhere in the dashboard — a timber yard cannot produce a cutting list. Correctly still chipped قريبًا |
| **Entitlement gates** | 12 knobs on the `plans` table | **6 enforce nothing**: `staff`, `custom_domain`, `custom_theme`, `messages_per_month` are never checked; `orders_per_month` is counted but deliberately never blocks; `reservations` points at no domain |
| **WhatsApp token storage** | `secrets.ts` resolves `env://VAR` | Its own comment: *"production must point this at the deployment's secret manager before Phase 1 ships"* |
| **WhatsApp modifier handling** | Products with modifiers mint a storefront handoff | Any menu using sizes or extras sends most customers to the web to finish — a product decision, not a bug, but it undercuts an in-chat ordering pitch |
| **App localisation** | Marketing site is Arabic-first | Dashboard has **no i18n at all**; storefront resolves `.en` in `registry.ts:118` and shows `nameEn` as the heading. The product is English-primary |

---

## D — Name only

| Item | Evidence |
|---|---|
| **Table reservations** | `plans.features.reservations` is a flag. No domain, no schema, no UI. It can be sold by accident |
| **Barcode checkout** | Nothing in `src/server` or the UI |
| **Generic substitutes** | Nothing |

All three correctly carry the قريبًا chip on the marketing page.

---

## What I have NOT verified

Honesty about confidence, since the whole point of this audit is not to repeat the WhatsApp mistake:

- **Tier B is classified from file presence and unit tests, not from running the journeys.** I walked WhatsApp by hand and it was broken. I have not walked POS, inventory, prescriptions, analytics, audit, notifications, billing or customers.
- **Nothing here speaks to production readiness beyond code**: secrets management, monitoring, error budgets, backup restore drills, load behaviour.
- **Production data was not inspected.** Local `.env.local` points at `127.0.0.1`; whether any of this has real usage in the Supabase production database is unknown from here.

## Recommended order of verification

By consequence if broken, not by ease:

1. **POS** — largest unproven surface, handles cash and refunds. A shift that cannot close, or a Z report that misreports, is a financial incident
2. **Inventory + recipes** — stock ledger and BOM deduction move numbers a business relies on
3. **WhatsApp** — now fixed, but never run against real Meta traffic
4. **Billing / subscription** — a plan change that silently fails is revenue
5. **Prescriptions** — regulated domain, pharmacy vertical's core purchase reason

The cheapest way to move a feature from B to A is one Playwright spec walking its primary journey
the way `offline-payment.spec.ts` does — customer action, API effect, merchant sees it.
