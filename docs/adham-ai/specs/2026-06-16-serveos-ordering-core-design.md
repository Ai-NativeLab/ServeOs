# ServeOS — Online Ordering Core — Design Spec

**Date:** 2026-06-16
**Status:** Approved (design), pending implementation plan
**Sub-project:** First slice of #3 (Ordering & Checkout) of the ServeOS platform program

---

## 0. Context

ServeOS is a multi-tenant SaaS platform for restaurants, cafés, and food businesses in
**Egypt and Saudi Arabia**. Sub-projects #1 (Tenant & Subscription Core) and #2 (Menu &
Catalog) are built: multi-tenancy with FORCE Row-Level Security via `withTenant`,
self-hosted auth + RBAC, plans/entitlements, manual billing, onboarding/approval, the
per-tenant installable PWA storefront, and the published menu (categories, products,
modifier groups/options, branches, branch-level availability/price overrides).

Sub-project #3 (Ordering & Checkout) as originally scoped bundles five independent
subsystems: cart + checkout, the order model + state machine + unified dashboard list,
QR/table dine-in, coupons/promotions, and customer payment gateways. That is too large
for one spec → plan → build cycle. This document specifies **only the first slice — the
online ordering core** — the transactional backbone everything else hangs off. The
remaining pieces each get their own spec → plan → build cycle.

**Locked forward requirement (from #1):** orders from *all* channels (web storefront,
QR/table, WhatsApp) must surface in a **single unified order list** in the tenant
dashboard — the dashboard is the one source of truth. This slice builds that list for
the web channel in a way the later channels slot into, not a web-only silo.

---

## 1. Scope

### In scope

- Web storefront cart (client-side) layered on the existing read-only menu.
- Server-authoritative checkout: **pickup** and **delivery** (named delivery areas with
  per-area fee, minimum order, optional ETA).
- Guest checkout (name + phone, unverified); no customer accounts.
- Order model + state machine + per-order audit trail of status events.
- Tokenized customer order-status page with client polling.
- Dashboard: unified order list (auto-refresh + new-order badge), order detail with
  state-machine transitions and a separate mark-paid action.
- Branch operational config: weekly opening hours, an "accepting orders" kill-switch,
  and delivery-areas management.
- Per-tenant VAT rate (defaulted by country EG/SA), applied to order totals.
- Entitlements: `online_ordering` feature gate + `orders`/month usage metering
  (no hard cap).
- `cash` payment only, behind a `PaymentProvider` seam so real gateways drop in later.
- en/ar localization + RTL across every new surface (customer and dashboard).

### Out of scope (later slices)

- QR/table dine-in ordering, dine-in service charge.
- Coupons / promotions / discounts.
- Real customer payment gateways (Paymob / Fawry / PayTabs).
- Customer accounts, order history, favorites.
- SMS / WhatsApp order notifications; realtime push (websockets/SSE).
- Delivery zones via maps/polygons or distance radius; geocoding.
- Abandoned-cart capture and ordering analytics.

---

## 2. Locked Decisions

| Topic | Decision |
| --- | --- |
| Slice scope | Online ordering core only; other #3 pieces are separate slices. |
| Fulfillment | Pickup + delivery. |
| Delivery pricing | Named areas per branch (fee + min-order + optional ETA); customer picks area from a dropdown, then types street details. No maps/geocoding. |
| Customer identity | Guest checkout; phone collected **unverified** (OTP deferred to the WhatsApp/accounts slice via the existing `OtpProvider` seam). |
| Order lifecycle | `pending → confirmed → preparing → ready → (out_for_delivery, delivery only) → completed`; exits `rejected` (while pending) and `cancelled` (later, with reason). |
| Payment | Tracked separately from fulfillment as `unpaid → paid`; v1 only `cash`, set by staff, behind a `PaymentProvider` seam. |
| Branch orderable | Weekly opening hours **and** a manual "accepting orders" toggle — both must allow it. |
| Order tracking | Tokenized status page `/order/<token>` with client polling; dashboard list also polls + shows a new-order badge. No realtime infra. |
| Entitlements | Gate behind `features.online_ordering`; increment `orders`/month usage on each placed order; **no hard cap** in v1 (over-limit surfaces to admin only). |
| Taxes | Configurable VAT % per tenant (default EG 14% / SA 15%, editable); totals = subtotal + VAT + delivery fee. No service charge. |
| Cart | Client-side only (localStorage); no server cart tables. Checkout is server-authoritative. |
| Architecture | New `ordering` domain for transactions; fulfillment config folded into the existing `branches` domain; VAT in `tenant_settings`; reuse `entitlements`, `rbac`, `catalog`. |

---

## 3. Architecture & Module Structure

Follows the established pattern: framework-agnostic services under `src/server/<domain>/`,
per-tenant operational tables behind FORCE-RLS + `withTenant`, a single entitlements gate.

### New domain: `src/server/ordering/`

- `schema.ts` — `orders`, `order_items`, `order_status_events` (per-tenant, FORCE-RLS).
- `state-machine.ts` — pure transition table + `canTransition(from, to, fulfillmentType)`
  guard; no framework or DB deps; unit-tested in isolation.
- `service.ts` — `placeOrder()`, `transitionStatus()`, `markPaid()`, `listOrders()`,
  `getOrderByToken()`.
- `errors.ts` — typed domain errors (see §6).
- `index.ts` — barrel exposing the service + types.

### Extend `src/server/branches/`

Branch-level fulfillment config (it is all branch-scoped):

- New branch attributes: `accepting_orders` toggle, `opening_hours` (weekly).
- New `delivery_areas` table (per branch).
- Service helpers: `isBranchOrderable(branch, now)`, `resolveDeliveryArea(branchId, areaId)`,
  plus CRUD for areas/hours/toggle.

### Reuse (no rebuild)

- **VAT** → `tenant_settings.data` (e.g. `{ "vatRate": 14 }`); no new table.
- **`entitlements`** → `requireFeature(tenant, 'online_ordering')` gates checkout;
  usage metering via the existing `orders`/month counter.
- **`rbac`** → add permissions `orders:manage` (owner, manager, staff) and
  `fulfillment:manage` (owner, manager) to the matrix.
- **`catalog`** → published-menu types feed the client cart; checkout re-reads catalog
  server-side to validate availability/prices/modifiers.

### `PaymentProvider` seam

```
interface PaymentProvider {
  // v1: CashPaymentProvider — order is created unpaid; staff mark paid on collection.
  // later: PaymobProvider / FawryProvider / PayTabsProvider implement the same seam
  //        + a webhook that sets payment_status = paid. No order-logic changes.
}
```

`payment_method` is an enum with only `cash` for now; the seam exists so gateways are a
later slice with no churn to the order model.

---

## 4. Data Model

All new per-tenant tables carry `tenant_id`, follow FORCE-RLS, and are accessed through
`withTenant`. Money columns are `numeric`.

### `orders`

- `id`, `tenant_id`, `branch_id`
- `order_number` — per-tenant monotonic integer (display `#1023`), generated inside the
  checkout transaction (per-tenant counter, row-locked).
- `status` enum: `pending | confirmed | preparing | ready | out_for_delivery |
  completed | rejected | cancelled`
- `fulfillment_type` enum: `pickup | delivery`
- `channel` enum: `web` (only value now; reserved so later QR/table and WhatsApp orders
  feed the same unified list — defaults to `web`)
- `payment_status` enum: `unpaid | paid`
- `payment_method` enum: `cash`
- `customer_name`, `customer_phone`, `notes` (nullable)
- Delivery fields (null for pickup): `delivery_area_id` (FK), `delivery_area_name_snapshot`,
  `delivery_address_text`
- Money (snapshotted): `subtotal`, `vat_rate_snapshot`, `vat_amount`, `delivery_fee`,
  `total`
- `status_token` (random, unguessable; drives `/order/<token>`)
- `cancel_reason` (nullable)
- `placed_at`, `updated_at`

### `order_items`

Snapshots so later menu edits never alter past orders.

- `id`, `tenant_id`, `order_id` (FK cascade), `product_id` (FK, kept for reference)
- `name_en`, `name_ar`, `unit_base_price`, `quantity`, `line_total`
- `selected_modifiers` `jsonb` — array of
  `{ groupNameEn, groupNameAr, optionNameEn, optionNameAr, priceDelta }`

### `order_status_events`

Audit trail of every transition.

- `id`, `tenant_id`, `order_id` (FK cascade)
- `from_status` (nullable for the initial event), `to_status`
- `changed_by_user_id` (nullable — null = customer/system)
- `reason` (nullable), `created_at`

### `delivery_areas` (branches domain)

- `id`, `tenant_id`, `branch_id` (FK cascade)
- `name_en`, `name_ar`
- `delivery_fee`, `min_order_amount` (default `0`), `eta_minutes` (nullable)
- `is_active` (default true), `sort_order`

### `branches` additions

- `accepting_orders` boolean (default `true`)
- `opening_hours` `jsonb` — 7 entries `{ day: 0-6, open: "HH:MM", close: "HH:MM",
  closed: boolean }`. **Overnight rule:** when `close < open`, the window crosses
  midnight.

### VAT

Stored in `tenant_settings.data.vatRate`. Defaulted by tenant country (EG 14% / SA 15%)
on first read, editable in settings, and snapshotted onto each order as
`vat_rate_snapshot`.

---

## 5. Data Flow

### Browse → cart (client)

Customer uses the existing storefront menu, selects a **branch + fulfillment type**, and
adds products with modifier selections to a localStorage cart keyed by branch +
fulfillment type. The cart computes a **display-only** subtotal.

### Checkout submit

The cart posts to a server action / `POST /api/orders` with `branchId`,
`fulfillmentType`, `areaId?`, `addressText?`, `name`, `phone`, `notes?`, and line refs
(`productId`, `quantity`, `selectedOptionIds[]`). **The client total is never trusted.**

### `placeOrder()` — server-authoritative, inside `withTenant`

1. `requireFeature(tenant, 'online_ordering')`.
2. Load branch; assert orderable (`accepting_orders` **and** within `opening_hours` now)
   → else `BranchNotAcceptingOrdersError`.
3. Re-read each product from `catalog`; reject unpublished / unavailable-at-branch;
   take effective price from `branch_product_availability` override when present.
4. Validate modifiers against the DB: every option belongs to the product's groups;
   enforce each group's `required` / `min_selections` / `max_selections`; price deltas
   come from the DB, not the client.
5. Delivery only: resolve the area (active, belongs to the branch) → `delivery_fee` +
   `min_order_amount`; assert `subtotal >= min_order_amount`
   (`AreaNotDeliverableError` / `MinimumOrderNotMetError`).
6. Compute `subtotal`, `vat_amount` (rate from `tenant_settings`), `total` server-side.
7. Generate per-tenant `order_number` (row-locked counter) + `status_token`.
8. Insert `order` + `order_items` (snapshots) + initial `order_status_events`
   (→ `pending`).
9. `incrementUsage(tenant, 'orders')` for the current period.
10. Return `{ orderNumber, statusToken }` → redirect to `/order/<token>`.

All of steps 1–9 run in a single transaction; any failure writes no order.

### Status transitions (dashboard)

Staff with `orders:manage` open the order list (polls; new-order badge = count of
`pending`). The order detail offers only the actions the state machine allows for the
current status + fulfillment type. `transitionStatus(orderId, toStatus, userId, reason?)`
validates via `state-machine.ts` (illegal moves → `InvalidTransitionError`), writes the
order + a status event, and bumps `updated_at`. `markPaid(orderId, userId)` flips
`payment_status` independently of fulfillment status. **Customers cannot cancel in v1** —
staff Reject (while pending) or Cancel (with reason).

### Customer status page

`/order/<token>` resolves a single order by `status_token` (no tenant context required
from the customer) and polls for the current status + summary.

---

## 6. Error Handling

Extends the foundation's typed-error + per-surface localized-boundary pattern. New typed
errors carry structured, **en/ar-localizable** data:

- `OrderValidationError` — item unavailable, price/modifier mismatch, empty cart.
- `BranchNotAcceptingOrdersError` — closed by hours or toggle.
- `AreaNotDeliverableError` — area inactive / not on this branch.
- `MinimumOrderNotMetError` — subtotal below the area minimum (carries the minimum).
- `InvalidTransitionError` — illegal status change (carries from/to).
- `OrderNotFoundError` — bad/expired status token or unknown order.

Behavior:

- Checkout fails **closed** — any validation failure aborts the transaction; no partial
  order. The storefront maps errors to friendly messages (e.g. "Margherita just sold
  out — please remove it and try again").
- `online_ordering` feature off → storefront renders the menu read-only with no
  cart/checkout. Suspended / past-due tenant → storefront closed (existing foundation
  behavior, unchanged).
- RLS backstop covers all new per-tenant tables; cross-tenant reads/writes fail closed.
  The tokenized status page is the one intentional unauthenticated read, scoped to a
  single order by its unguessable `status_token`.

---

## 7. Testing

Mirrors the foundation's unit / integration / e2e split.

- **Unit:**
  - State machine: full legal/illegal transition matrix per fulfillment type.
  - Totals math: subtotal + VAT + delivery, rounding.
  - Modifier validation: required / min / max selection rules.
  - Branch-orderable logic: hours + toggle, including the midnight-crossing rule.
- **Integration:**
  - Full `placeOrder`: price/availability re-validation, area resolution, min-order
    enforcement, order-number counter increment, usage metering.
  - RLS isolation on `orders`, `order_items`, `order_status_events`, `delivery_areas`
    (tenant A cannot read tenant B under any query).
  - Entitlement gating: feature off blocks checkout.
  - Status-page token lookup returns only the matching order.
- **E2E (smoke):** browse → add to cart → checkout (delivery) → order appears in the
  dashboard list → staff confirms → the status page reflects the new status.
- **Seed:** extend the `roma` demo tenant with delivery areas, opening hours, a VAT
  rate, and a couple of sample orders across statuses.

---

## 8. Cross-Cutting Requirements

- **RTL + en/ar:** every new surface (cart drawer, checkout, order-status page, dashboard
  order list/detail, settings) is built RTL-aware with full Arabic mirroring, following
  the foundation's existing localization/RTL setup. This is a first-class requirement,
  not a follow-up.
- **Unified order list:** the dashboard list is designed so the later QR/table and
  WhatsApp channels feed the same list (a `channel` discriminator is reserved on
  `orders`, defaulting to `web` in this slice).

---

## 9. Success Criteria

A customer can open a live `{slug}.serveos.com` storefront, add menu items (with
modifiers) to a cart, check out as a guest for pickup or delivery (with a correct
server-computed total including VAT and area delivery fee), and follow the order on a
tokenized status page. Restaurant staff see the order immediately in a unified dashboard
list, advance it through a validated lifecycle, and mark it paid. Online ordering is
gated by the `online_ordering` plan feature and metered per month, branch hours +
accepting-orders + delivery areas are configurable, every new per-tenant table follows
the FORCE-RLS + `withTenant` pattern, and all surfaces work in en/ar with RTL — ready for
the QR/table, coupons, and payment-gateway slices to build on top.
