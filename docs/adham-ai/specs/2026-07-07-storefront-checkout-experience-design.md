# Storefront Checkout Experience — Design

**Date:** 2026-07-07
**Status:** Approved (design) — pending implementation plan
**Scope:** Checkout (`/checkout`), order tracking (`/order/[token]`), the cart drawer, branch selection / open-state on the storefront menu page, order scheduling (incl. pre-orders), customer cancellation, currency display, and two small storefront additions (recent-order strip, info footer).
**Depends on:** `2026-07-06-storefront-brand-identity-design.md` (brand tokens, fonts, `Sheet` primitive, storefront component family) and `2026-06-16-serveos-ordering-core-design.md` (ordering service, state machine, status tokens).

## Problem

The storefront menu page now carries the full ServeOS brand, but the moment a
customer commits — checkout and order tracking — is still the original
prototype: raw inline styles, `system-ui`, emoji status markers. Beyond looks,
the transactional flow has real gaps:

- **No currency anywhere.** Every price is a bare `toFixed(2)`; a customer
  cannot tell EGP from SAR.
- **Branch ambiguity.** With no `?branch=` chosen, the cart carries
  `branchId: null` and checkout silently falls back to `branches[0]`
  (`src/app/checkout/page.tsx`). A multi-branch customer can order from a
  branch they never picked.
- **Closed discovered too late.** Orderability (accepting-orders flag +
  opening hours) is only checked at order placement, so a customer can build
  a whole cart and hit "branch closed" at submit. Worse, the check uses
  server wall-clock (Vercel fra1), not the tenant's timezone — a documented
  v1 limitation in `src/server/branches/orderability.ts` that is now
  user-visible.
- **Cart behavior seams.** Adding the same product+options twice duplicates
  the line instead of merging; the drawer has remove-only (no quantity
  editing); the delivery minimum is only enforced server-side, after submit.
- **No way back to an order.** The tracking URL exists only as the
  post-checkout redirect; close the tab and the order is unreachable.
- **No real-world info.** The storefront shows no hours, address, or phone —
  table stakes for a restaurant page.

## Goal

Make the customer transactional flow production-credible: branded checkout,
cart, and tracking in the existing visual language; correct branch and
open/closed handling in the tenant's timezone; order scheduling with
pre-orders while closed; customer cancellation of pending orders; currency on
every amount; and the small trust/re-entry pieces (footer, recent-order
strip, delivery ETA) that use data the schema already has.

## Non-goals

- **Quote/checkout-session API.** Totals remain client-computed for display
  and server-validated at submit (today's trust model). A server-driven
  quote endpoint is a deliberate future option; nothing here precludes it.
- **Payments.** Cash only, unchanged. `BillingProvider` seam is for
  subscription billing, not customer payments.
- **Arabic UI / RTL restructuring.** Own upcoming spec. The existing dual
  EN/AR display pattern is kept. (`DomainError` AR messages are already
  returned and used where the client shows server errors.)
- **Rate limiting and observability.** Next specs (infra hardening); this
  spec adds no new unauthenticated surface beyond the cancel endpoint, which
  is covered there too.
- **Menu caching / image optimization, custom domains, dine-in/table
  ordering (POS sub-project), packages/bundles, featured items, compare-at
  pricing, reviews, social links, live chat.** Roadmap, not this pass.
- **New npm dependencies.** Timezone math uses `Intl`; UI uses existing
  primitives.

## 1. Server core

### 1.1 Data model

One new nullable column:

```ts
// src/server/ordering/schema.ts — orders table
scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
```

`null` = ASAP. No backfill needed; every existing order remains valid.
Migration via `drizzle-kit generate`, applied with `db:migrate:test` then
`db:migrate` (additive nullable column, same procedure as `coverImageUrl`).

### 1.2 Slots & timezone module

New pure module `src/server/branches/slots.ts`, sibling and stylistic twin of
`orderability.ts`. No new dependencies — tenant-timezone wall-clock via
`Intl.DateTimeFormat(..., { timeZone })` parts.

```ts
/** Wall-clock (day-of-week + minutes) of `date` in an IANA timezone. */
function wallClock(date: Date, timeZone: string): { day: number; minutes: number }

/** Open/closed now, with next transition times formatted "HH:MM" tenant-local. */
export function getBranchOpenState(branch: Branch, timeZone: string, now: Date):
  { open: boolean; opensAt?: string; closesAt?: string }

/** Orderable slot instants: 30-min steps inside opening windows (midnight
 *  wrap included), ≥ MIN_LEAD_MINUTES from now, within today+tomorrow
 *  tenant-local. Empty openingHours → slots across the whole horizon. */
export function listSlots(branch: Branch, timeZone: string, now: Date): Date[]

/** isBranchOrderable, evaluated tz-correctly at an arbitrary instant. */
export function isBranchOrderableAt(branch: Branch, timeZone: string, at: Date): boolean
```

Constants (exported for tests and UI copy): `SLOT_STEP_MINUTES = 30`,
`MIN_LEAD_MINUTES = 30`, `HORIZON = today + tomorrow` (tenant-local days).

`isBranchOrderableAt` becomes the single orderability truth: the existing
`isBranchOrderable(branch, now)` is refactored to delegate to it (keeping its
current tests green), and `placeOrder` calls the tz-correct form directly.
This closes the documented timezone limitation.

### 1.3 `placeOrder` changes (`src/server/ordering/service.ts`)

`PlaceOrderInput` gains `scheduledFor?: string` (ISO 8601). The service loads
the tenant row (for `timezone`) alongside the existing `getVatRate` read.

- **ASAP** (`scheduledFor` absent): validate `isBranchOrderableAt(branch,
  tz, now)` — behavior identical to today, minus the timezone bug.
- **Scheduled:** validate in order — parseable date; `>= now + MIN_LEAD`;
  within horizon; `isBranchOrderableAt(branch, tz, scheduledFor)`. The
  branch's `isActive`/`acceptingOrders` gates apply to both paths (a paused
  branch takes no orders of any kind). Persist to `orders.scheduledFor`.

Failures throw a new `InvalidScheduleError` (DomainError, EN/AR messages,
distinct detail for too-soon / too-far / closed-at-time) → 422 from
`/api/orders`, matching existing error flow. The API route allowlist in
`src/app/api/orders/route.ts` passes `scheduledFor` through as a plain
string (server-validated; `now` remains server-controlled).

### 1.4 Customer cancel

```ts
// src/server/ordering/service.ts
export async function cancelOrderByToken(tenantId: string, token: string): Promise<Order>
```

Inside `withTenant`: load order by `statusToken`; require `status ===
"pending"` (customer policy — stricter than the state machine, which the
dashboard keeps using for its own cancels); transition via the existing
`canTransition` guard; write `orderStatusEvents` row with `changedByUserId:
null`, `reason: "cancelled_by_customer"`; set `cancelReason`. Non-pending →
`InvalidTransitionError`.

New route `POST /api/orders/[token]/cancel`: tenant resolution identical to
the status route (`x-tenant-slug` header ?? `slug` query param); returns
`{ status }` on success, DomainError → 422. Authorization is possession of
the unguessable status token — the same trust model as viewing the order.

### 1.5 Currency

```ts
// src/lib/money.ts
export function formatMoney(amount: number, currency: string): string
// Intl.NumberFormat("en", { style: "currency", currencyDisplay: "code", currency })
// → "EGP 120.00", "SAR 45.00"
```

Threaded from `tenant.currency` through the storefront page into
`StorefrontMenu` (cards, sheet, cart bar, drawer), checkout, and tracking.
Dashboard adoption is out of scope (can migrate later).

### 1.6 Dashboard surfacing (minimal)

Orders list (`/dashboard/orders`) and detail (`/dashboard/orders/[id]`) show
a "Scheduled · {weekday HH:MM tenant-local}" badge when `scheduledFor` is
set. Sorting stays `placedAt`. Customer-cancelled orders already render via
the existing `cancelled` status + events timeline; the
`cancelled_by_customer` reason string appears in the detail's event list.
No workflow changes.

## 2. UI flows

All new components live in `src/app/_components/storefront/`; brand tokens,
fonts, and the `Sheet` primitive come from the brand-identity pass. Raw
`<img>` usage continues (image optimization is a named non-goal).

### 2.1 Menu page (`src/app/page.tsx` storefront branch)

- **Branch selection.** URL `?branch=` stays the source of truth;
  single-branch tenants resolve implicitly. On multi-branch tenants, a
  product tap with no branch chosen opens a **branch-pick sheet** (each
  branch with name + open/closed state from `getBranchOpenState`); picking
  sets `?branch=` and continues to the product sheet. The existing
  cart-reset-on-branch-switch behavior is unchanged.
- **Open-state strip** below the hero, from `getBranchOpenState` of the
  active branch:
  - Open → "Open · closes 23:00" (subtle).
  - Closed by hours → "Closed · pre-order for when we open at 13:00" —
    browsing and carting stay enabled; checkout will require a slot.
  - `acceptingOrders` off or branch inactive → "Not taking orders right
    now" — same treatment as a tenant without the `online_ordering`
    feature: cards non-interactive, no cart bar. A pause is not a schedule.
- **Recent-order strip.** Checkout success appends `{ token, orderNumber,
  placedAt }` to `serveos.recent-orders` in localStorage (keep last 3).
  When present, the menu shows "Your order · #42 →" linking to
  `/order/[token]`; the strip re-checks status lazily via the existing
  status endpoint and drops an entry once its status is terminal
  (completed/rejected/cancelled) or its `placedAt` is over 24 hours old.
- **Footer** (`StorefrontFooter`): active branch's `address`, `phone`
  (tap-to-call), weekly hours rendered tenant-local from `openingHours`,
  and the tenant WhatsApp link when configured (`getWhatsappNumber`). Zero
  schema changes.

### 2.2 Cart

- **Behavior fix in `src/app/_components/cart.ts`:** `addLine` merges a new
  line into an existing one when `productId` and the `selectedOptionIds`
  set match (order-insensitive); quantities add. API and event contract
  otherwise unchanged; existing `cart.test.ts` extended.
- **Drawer rebuilt** on the `Sheet` primitive (bottom sheet mobile / side
  panel desktop), replacing the hand-rolled fixed div in
  `StorefrontMenu.tsx`: per-line quantity steppers (− at 1 removes), line
  totals and subtotal via `formatMoney`, checkout button always carrying
  the cart's `branchId`. `cart.ts` gains `setLineQuantity(index, quantity)`
  (quantity 0 removes the line) alongside the existing `removeLine`, both
  unit-tested.

### 2.3 Checkout (`/checkout`)

Branded single-column page (storefront tokens/fonts), replacing all inline
styles:

1. **Branch guard.** If `?branch=` and `cart.branchId` disagree, render a
   "Your cart is for {branch name}" notice linking to the correct URL —
   never silently proceed. The `branches[0]` fallback is removed; a missing
   branch renders the guard, not a guess.
2. **Fulfillment toggle** — Delivery / Pickup pills (existing logic).
3. **Time section** — "ASAP" pill + "Schedule" opening a picker:
   Today/Tomorrow toggle, 30-min slot pills from `listSlots` (computed
   server-side in the page, passed as props; render-time drift absorbed by
   the 30-min lead and re-validated at submit). Branch closed now → ASAP
   pill disabled with "closed" note, earliest slot preselected.
4. **Contact & delivery** — name, phone, area select (now showing
   `etaMinutes` as "~45 min" when set), address, notes. Values persisted to
   `serveos.customer` in localStorage on successful submit and prefilled on
   return visits.
5. **Summary card** — lines with modifier summaries, subtotal, VAT,
   delivery fee, total — all `formatMoney`. **Min-order pre-check**: when
   the chosen area's `minOrderAmount` exceeds the subtotal, an inline
   warning shows the shortfall and submit is disabled (server check remains
   the backstop).
6. **Submit** — existing `POST /api/orders` plus `scheduledFor` when a slot
   is chosen; on success, record the recent-order entry, clear cart,
   redirect to tracking (unchanged).

### 2.4 Tracking (`/order/[token]`)

Branded rebuild of the page and `StatusPoller` (5 s polling and terminal
statuses unchanged):

- **Status timeline** in brand language (replaces emoji markers); scheduled
  orders show "Scheduled for {weekday HH:MM}" prominently above it.
- **Receipt**: items with modifier summaries and per-line totals, subtotal /
  VAT / delivery / total via `formatMoney`, fulfillment recap (pickup:
  branch name + address; delivery: area + address + "~{etaMinutes} min"
  when set), order number and placed time.
- **Cancel order** button rendered only while status is `pending`
  (poller-driven): confirm dialog (existing `alert-dialog` primitive) →
  `POST /api/orders/[token]/cancel` → poller state updates to `cancelled`.
  Any non-pending response (race with the restaurant) shows "the restaurant
  has already confirmed this order" with the WhatsApp link as escalation.
- **WhatsApp CTA** unchanged.

## 3. Error handling

- All new server failures are `DomainError`s (EN/AR) → 422, matching the
  ordering core. New: `InvalidScheduleError`. Cancel reuses
  `InvalidTransitionError`.
- **Stale slot:** submit after the picked slot slips under the lead time →
  server 422 (`InvalidScheduleError`); checkout surfaces "that time is no
  longer available", drops expired slots client-side, and lets the customer
  re-pick. The client also filters expired slots at submit time to make
  this rare.
- **Cancel race:** simultaneous customer cancel / restaurant confirm is
  serialized by the transaction; the loser gets `InvalidTransitionError`
  and the tracking page refreshes to the true status with explanatory copy.
- **Branch mismatch and min-order** are prevented client-side (2.3) with
  the existing server validation as backstop; nothing new server-side.
- Cart localStorage parsing keeps its existing fail-safe (corrupt → empty
  cart); `serveos.customer` and `serveos.recent-orders` parse with the same
  try/catch-to-default pattern.

## 4. Testing

Per repo convention: Vitest against the real test DB for server logic, no
component unit tests (UI verified by `tsc`/`next build` + Playwright +
manual pass).

- **Vitest — `slots.test.ts`** (heaviest): wall-clock correctness across
  timezones incl. Africa/Cairo DST, midnight-wrap windows, closed days,
  empty `openingHours`, min-lead and horizon boundaries, slot-step
  alignment, `getBranchOpenState` opensAt/closesAt.
- **Vitest — ordering:** scheduled `placeOrder` paths (valid slot persists
  `scheduledFor`; too soon / too far / closed-at-time / paused branch each
  throw `InvalidScheduleError` or `BranchNotAcceptingOrdersError`); ASAP
  path unchanged; `cancelOrderByToken` (pending → cancelled + event row
  with `changedByUserId: null`; confirmed → `InvalidTransitionError`).
- **Vitest — client-safe modules:** `cart.ts` merge semantics (same
  product+options merge order-insensitively; different options stay
  separate; quantity helpers), `formatMoney`.
- **Playwright:** `ordering.spec.ts` updated for the rebuilt checkout (ASAP
  happy path incl. prefill); new `scheduling.spec.ts`: pick slot → place →
  tracking shows scheduled time → cancel while pending → status flips to
  cancelled. Existing `menu.spec.ts` / `responsive.spec.ts` assertions
  re-checked against new markup.
- **Manual pass** on the live `roma` storefront (`roma.serveos.tech`) as
  the final gate: full journey — branch pick, closed-state pre-order,
  cart merge/steppers, scheduled checkout with prefill, receipt, cancel.

## 5. Decision log

| Decision | Choice |
| --- | --- |
| Milestone slicing | UX spec first; rate limiting + observability as separate follow-up specs |
| Branch flow | Pick-before-cart via sheet; no silent `branches[0]` fallback |
| Closed by hours | Pre-orders allowed (scheduled only); paused branch blocks everything |
| Cart | Fix behavior (merge, steppers, min-order pre-check) + restyle |
| Tracking | Restyle + full receipt + customer cancel (pending only) |
| Checkout fields | Existing fields + localStorage prefill + scheduling |
| Scheduling defaults | 30-min slots, 30-min lead, today+tomorrow horizon |
| Architecture | Approach 1 — minimal extension of existing core; quote API is a non-goal |
| From old ServeOS storefront | Adopt: recent-order strip, info footer, ETA display. Defer: packages, featured, reviews, social, dine-in |
