# QA — Tenant storefront

**Surface code:** `SF` · **Host:** `{slug}.serveos.tech` (installable PWA)
**Personas:** guest customer, account customer — see [personas.md](personas.md)
**Last verified against code:** 2026-08-17

The customer's shop. One codebase renders four different businesses — a
restaurant menu, a retail shop, a pharmacy, a timber yard — each with its own
template, terminology, capabilities and checkout adjustments. It is where money
is taken, so this is the largest file in the pack.

---

## How to run this file

```bash
npm run db:seed        # roma (restaurant)
npm run demo:seed      # demo-restaurant, demo-retail, demo-pharmacy, demo-timber
npm run dev
```

Add the hosts entries from [personas.md](personas.md), then work through the
tenants:

| Journey group | Tenant | Why |
|---|---|---|
| `SF-SERVE`, `SF-BROWSE`, `SF-CART`, `SF-CHK`, `SF-SCHED`, `SF-PAY`, `SF-TRACK`, `SF-CANCEL`, `SF-PWA` | `roma` | restaurant: modifiers + service charge |
| `SF-BROWSE` variants | `demo-retail` | the `shop` template with variants |
| `SF-RX` | `demo-pharmacy` | `prescriptionUpload` + `pharmacistReview` |
| `SF-TIMBER` | `demo-timber` | `dimensionalProducts`, `unitsOfMeasure`, `tradeAccounts` |
| `SF-ACCT` | any | per-tenant customer accounts |

**`SF-RX` needs a pharmacist user, which no script seeds** — create one through
`DSH-STAFF` on `demo-pharmacy` first.

### What changes per vertical

| Vertical | Template | Catalogue noun | Distinguishing capability | Checkout adds |
|---|---|---|---|---|
| restaurant | `menu` | Menu | modifiers, recipes | VAT + **service charge** |
| retail | `shop` | Shop | variants | VAT |
| pharmacy | `shop` | Shop | prescription upload, pharmacist review | VAT |
| timber | `yard` | Yard | dimensional products, units of measure, trade accounts | VAT |

Status wording changes too, and it is easy to miss: retail, pharmacy and timber
relabel `preparing` → "Being packed" and `ready` → "Ready for collection", where
restaurant says "Preparing" and "Ready".

### The error contract

Every domain failure surfaces as **HTTP 422** with `{ error, code }`, and the
message is **localised** by `messageFor(locale)`. Testing the `code` rather than
the prose is what makes these cases stable.

| Code | English message |
|---|---|
| `branch_not_accepting_orders` | This branch isn't accepting orders right now |
| `area_not_deliverable` | This delivery area isn't available |
| `minimum_order_not_met` | The minimum order for this area is *{amount}* |
| `order_not_found` | Order not found |
| `invalid_schedule` | detail is one of `unparseable` · `too_soon` · `too_far` · `closed_at_time` |
| `order_validation` | a specific detail string, listed per case below |
| `invalid_transition` | from → to |

A 500 in place of any of these is a defect: the route maps `DomainError` to 422
and everything else to 500, so a 500 means an unmodelled failure.

---

## SF-SERVE — Tenant resolution and servability

**Goal:** the right shop, or a graceful nothing

`isTenantServable` accepts `active` and `trial` only. Anything else renders the
tenant's own "getting ready" copy rather than a catalogue.

> **Minor finding:** `isTenantServable` tests for `"trial"`, but the tenant
> status enum is `active | suspended | rejected` — there is no `trial` tenant
> status (trial lives on the *subscription*). The branch is dead today. Harmless,
> but worth noting so nobody relies on it.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| SF-SERVE-001 | An active tenant serves its storefront | happy | P1 | AUTOMATED (`menu.spec.ts › storefront page renders menu for active tenant`) | 1. Open `roma.serveos.localhost:3000`. | The catalogue renders with the tenant's branding. |
| SF-SERVE-002 | An unknown slug renders "Not found" | negative | P1 | AUTOMATED (`menu.spec.ts › GET /api/menu returns 404 for unknown slug`) | 1. Open `nosuchshop.serveos.localhost:3000`. 2. GET `/api/menu?slug=nosuchshop`. | Page shows a "Not found" empty state. API returns 404. No tenant name is leaked. |
| SF-SERVE-003 | A suspended tenant shows its own "getting ready" copy | permission | P1 | MANUAL | 1. Suspend `roma` (`ADM-SUSP`). 2. Open its storefront. | The tenant's **name** is shown with `This restaurant is getting ready. Check back soon!` — no products, no cart, no checkout. On `demo-retail` the wording is the store variant. |
| SF-SERVE-004 | The marketing host does not leak a tenant | permission | P1 | AUTOMATED (`onboarding.spec.ts › marketing host does not leak a tenant`) | 1. Open the bare root domain. | The marketing page renders. No tenant catalogue, name or branding appears. |
| SF-SERVE-005 | `x-tenant-slug` cannot be spoofed | permission | P1 | MANUAL | 1. Request the marketing host with a forged `x-tenant-slug: roma` header. | The header is stripped by the proxy on non-storefront hosts. Marketing renders; no `roma` data is served. |
| SF-SERVE-006 | A missing slug on the API is a 400, not a 500 | negative | P2 | AUTOMATED (`menu.spec.ts › GET /api/menu returns 400 when slug is missing`) | 1. GET `/api/menu` with no slug. | 400 with `slug is required`. |

---

## SF-BROWSE — Browsing, across four templates

**Goal:** each trade's catalogue reads like that trade's shop
**Preconditions:** `demo:seed` has run

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| SF-BROWSE-001 | Restaurant renders the menu template | happy | P1 | AUTOMATED (`shop.spec.ts › restaurant storefront still renders the menu template (no search bar)`) | 1. Open `demo-restaurant`. | Menu template with categories and dishes. Heading uses the restaurant `storefrontHeading` ("Menu"). **No search bar** — that is a shop-template feature. |
| SF-BROWSE-002 | Retail renders the shop template with search | happy | P1 | AUTOMATED (`shop.spec.ts › retail storefront renders the shop template`) | 1. Open `demo-retail`. | Shop template with a product grid and a search bar. Heading reads "Shop". |
| SF-BROWSE-003 | Pharmacy renders the shop template with its own wording | happy | P1 | MANUAL | 1. Open `demo-pharmacy`. | Shop template. Not-found and getting-ready copy use pharmacy terms ("Pharmacy not found"). Rx-only products are marked as requiring a prescription. |
| SF-BROWSE-004 | Timber renders the yard template | happy | P1 | MANUAL | 1. Open `demo-timber`. | Yard template. Heading reads "Yard". Dimensional products show a per-unit rate (e.g. per linear metre), not a flat each-price. |
| SF-BROWSE-005 | Search filters the grid | happy | P2 | AUTOMATED (`storefront-responsive.spec.ts › shop: search stays usable while scrolling and filters the grid`) | 1. On `demo-retail`, type a product name into search. | The grid narrows to matches. Search stays reachable while scrolling. |
| SF-BROWSE-006 | Out-of-stock products are visible but not orderable | edge | P1 | AUTOMATED (`storefront-responsive.spec.ts › shop: out-of-stock card is visible but not clickable`) | 1. Set a product out of stock. 2. Find it on the shop grid. | The card is visible and marked out of stock, and is not clickable. A customer can see the shop stocks it without being able to order it. |
| SF-BROWSE-007 | The catalogue is bilingual | i18n | P2 | MANUAL | 1. Switch the storefront to Arabic. | Category and product names render in Arabic where an Arabic name exists, layout flips to RTL, and prices stay correctly formatted. |
| SF-BROWSE-008 | Banners and featured items render when configured | happy | P2 | MANUAL | 1. Configure an active banner (`DSH-BAN`). 2. Reload the storefront. | The banner appears. Popular/featured products appear in their strip. With none configured, the layout closes up cleanly rather than leaving a gap. |
| SF-BROWSE-009 | An unpublished catalogue shows the coming-soon state | edge | P2 | MANUAL | 1. On a tenant with nothing published, open the storefront. | The vertical's empty-catalogue copy — restaurant "Menu coming soon", retail "Catalog coming soon", timber "Yard list coming soon". |

---

## SF-PROD — The product sheet

**Goal:** configure an item correctly, and be stopped when it is not

Modifier rules are enforced server-side and each has its own error detail, so
these are worth driving through the API as well as the UI.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| SF-PROD-001 | A simple product adds directly | happy | P1 | AUTOMATED (`ordering.spec.ts › customer can browse, add to cart, and reach checkout`) | 1. Tap a product with no options. | It is added at quantity 1 and the cart bar updates. |
| SF-PROD-002 | A variant must be chosen | happy | P1 | AUTOMATED (`storefront-responsive.spec.ts › shop: add a variant to the cart from a phone viewport`) | 1. Open a product with variants. | The sheet lists variants with their prices. Adding without choosing is not possible. |
| SF-PROD-003 | A required modifier group blocks adding | negative | P1 | MANUAL | 1. Open a restaurant dish with a required modifier group. 2. Try to add without selecting. | The UI prevents it. Driving `POST /api/orders` directly returns 422 `order_validation` with detail `required modifier missing`. |
| SF-PROD-004 | Too few or too many selections are refused | negative | P1 | MANUAL | 1. On a group with min 2 / max 3, submit 1 selection, then 4. | 422 with `too few modifier selections`, then `too many modifier selections`. |
| SF-PROD-005 | An invalid modifier id is refused | negative | P1 | MANUAL | 1. POST an order with a modifier option id from a different product. | 422 `invalid modifier selection`. |
| SF-PROD-006 | Modifiers cannot ride on a variant line | negative | P2 | MANUAL | 1. POST a line with both a `variantId` and `selectedOptionIds`. | 422 `modifiers not allowed on variant lines`. |
| SF-PROD-007 | Quantity must be a positive integer | negative | P1 | MANUAL | 1. POST lines with quantity `0`, `-1`, and `1.5`. | Each returns 422 `bad quantity`. |
| SF-PROD-008 | A product unavailable at the chosen branch is refused | negative | P1 | MANUAL | 1. Mark a product unavailable at branch A. 2. Order it against branch A. | 422 `product unavailable at branch`. Ordering it at branch B still works. |
| SF-PROD-009 | Tap targets are large enough on a phone | responsive | P2 | AUTOMATED (`storefront-responsive.spec.ts › tap targets: product-card add buttons are at least 40px`) | 1. At 360px, measure the add buttons. | Each is at least 40px. |

---

## SF-CART — The cart

**Goal:** the cart shows what will be charged

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| SF-CART-001 | Items accumulate and the total updates | happy | P1 | AUTOMATED (`ordering.spec.ts`) | 1. Add two products. | Both appear in the cart drawer with a running subtotal. |
| SF-CART-002 | Identical configurations merge | edge | P2 | MANUAL | 1. Add the same product with the same options twice. | One line at quantity 2, not two lines. |
| SF-CART-003 | Quantity can be changed and a line removed | happy | P1 | MANUAL | 1. Increase, decrease, then remove a line. | The total tracks each change. Removing the last line empties the cart. |
| SF-CART-004 | An empty cart cannot check out | negative | P1 | MANUAL | 1. Empty the cart. 2. Attempt checkout, and POST an order with no lines. | The UI blocks it; the API returns 422 `empty cart`. |
| SF-CART-005 | Restaurant totals include the service charge | happy | P1 | AUTOMATED (`storefront-responsive.spec.ts › checkout page does not overflow, inputs do not trigger iOS zoom, and totals breakdown renders`) | 1. On `roma`, open checkout with items. | The breakdown lists subtotal, service charge and VAT separately, then the total. |
| SF-CART-006 | Retail, pharmacy and timber have no service charge | edge | P1 | MANUAL | 1. Open checkout on `demo-retail`, `demo-pharmacy` and `demo-timber`. | Each shows VAT but **no** service-charge line — only restaurant carries it. |
| SF-CART-007 | A stale price cannot be charged | edge | P1 | MANUAL | 1. Fill a cart. 2. Change a product's price in the dashboard. 3. Submit the order with the old `expectedTotal`. | 422 from `TotalMismatchError` — the register never quietly charges a different amount than the one shown. Reloading shows the new price. |

---

## SF-BRANCH — Branch selection and opening hours

**Goal:** order from a branch that is actually open

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| SF-BRANCH-001 | A multi-branch tenant offers a picker | happy | P1 | MANUAL | 1. On a tenant with two active branches, open the storefront. | A branch picker is offered. The chosen branch persists across navigation via `?branch=`. |
| SF-BRANCH-002 | The open/closed banner reflects real hours | happy | P1 | MANUAL | 1. Set the branch's hours to a window that excludes now. 2. Reload. | A closed banner shows, with the next opening time. Setting hours to include now shows it as open. |
| SF-BRANCH-003 | A closed branch refuses an immediate order | negative | P1 | MANUAL | 1. With the branch closed, submit an unscheduled order. | 422 `branch_not_accepting_orders` — "This branch isn't accepting orders right now". |
| SF-BRANCH-004 | An unknown branch id is refused | negative | P1 | MANUAL | 1. POST an order with a `branchId` belonging to another tenant. | 422 `order_validation` / `unknown branch`. No cross-tenant branch is ever accepted. |
| SF-BRANCH-005 | The Arabic closed message is translated | i18n | P2 | MANUAL | 1. Repeat SF-BRANCH-003 with an Arabic locale. | The error reads `هذا الفرع لا يستقبل الطلب حالياً`. |

---

## SF-CHK — Checkout

**Goal:** take a correct order, for pickup or delivery
**Preconditions:** a branch with at least one active delivery area with a minimum and a fee

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| SF-CHK-001 | A pickup order completes | happy | P1 | AUTOMATED (`ordering.spec.ts`) | 1. Fill a cart, choose pickup, enter name and phone, submit. | 201. The order appears in `/dashboard/orders` with status `pending`, and the customer lands on the tracking page. |
| SF-CHK-002 | A delivery order completes with fee and area | happy | P1 | MANUAL | 1. Choose delivery, pick an area, enter an address, submit. | 201. The area's delivery fee is added to the total, and the order records the area name and the address text. |
| SF-CHK-003 | Name and phone are required | negative | P1 | MANUAL | 1. Submit with an empty name, then an empty phone. | 422 `order_validation` / `missing customer details` in both cases. |
| SF-CHK-004 | Delivery without an area is refused | negative | P1 | MANUAL | 1. POST a delivery order with no `areaId`. | 422 `area_not_deliverable`. |
| SF-CHK-005 | Delivery without an address is refused | negative | P1 | MANUAL | 1. POST a delivery order with an `areaId` but a blank address. | 422 `order_validation` / `missing delivery address`. |
| SF-CHK-006 | An inactive or foreign area is refused | negative | P1 | MANUAL | 1. Deactivate an area and order to it. 2. Then use an area belonging to another branch. | 422 `area_not_deliverable` in both cases — the area must be active **and** belong to the chosen branch. |
| SF-CHK-007 | Below the area minimum is refused, with the figure | negative | P1 | MANUAL | 1. On an area with a 100 minimum, submit a delivery order with a 50 subtotal. | 422 `minimum_order_not_met` reading "The minimum order for this area is 100.00". The customer is told the number, not just refused. |
| SF-CHK-008 | The minimum is measured on subtotal, not the total | edge | P1 | MANUAL | 1. With a 100 minimum, build a subtotal of 95 whose total exceeds 100 once fee and VAT are added. | Still refused. The check is against `subtotal` before fee, service charge and VAT. |
| SF-CHK-009 | Order numbers are sequential per tenant and never collide | edge | P1 | MANUAL | 1. Note the last order number. 2. Submit two orders as close to simultaneously as possible. | Two distinct consecutive numbers. No duplicates and no gap. Numbering is per tenant — another tenant's sequence is unaffected. |
| SF-CHK-010 | Checkout is usable on a phone | responsive | P2 | AUTOMATED (`storefront-responsive.spec.ts › checkout page does not overflow, inputs do not trigger iOS zoom…`) | 1. At 360px, complete checkout. | No horizontal overflow; inputs are at least 16px so iOS does not zoom; the totals breakdown renders. |
| SF-CHK-011 | Stock is decremented on a stock-tracked order | edge | P1 | MANUAL | 1. On `demo-retail`, note a product's stock. 2. Order 2 of it. | Stock falls by exactly 2. On `roma` (restaurant, made-to-order dishes) no dish stock moves. |

---

## SF-SCHED — Scheduling an order for later

**Goal:** order ahead, within the rules

Three constants govern this: slots step every **30 minutes**, the minimum lead
time is **30 minutes**, and there is a scheduling horizon beyond which a time is
too far. Each failure has its own `invalid_schedule` detail.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| SF-SCHED-001 | A valid future slot is accepted | happy | P1 | AUTOMATED (`scheduling.spec.ts › customer can schedule an order and cancel it while pending`) | 1. Choose a slot later today while the branch is open. 2. Submit. | 201. The order records `scheduledFor` and the tracking page shows the scheduled time. |
| SF-SCHED-002 | Slots are offered on 30-minute steps | happy | P2 | MANUAL | 1. Open the slot picker. | Offered times step every 30 minutes and none is sooner than 30 minutes from now. |
| SF-SCHED-003 | A time inside the lead window is refused | negative | P1 | MANUAL | 1. POST an order scheduled 10 minutes from now. | 422 `invalid_schedule` with detail `too_soon`. |
| SF-SCHED-004 | A time beyond the horizon is refused | negative | P1 | MANUAL | 1. POST an order scheduled a year out. | 422 `invalid_schedule` with detail `too_far`. |
| SF-SCHED-005 | A slot when the branch is shut is refused | negative | P1 | MANUAL | 1. POST an order scheduled for 03:00, outside opening hours. | 422 `invalid_schedule` with detail `closed_at_time`. |
| SF-SCHED-006 | An unparseable time is refused, not crashed | negative | P1 | MANUAL | 1. POST `scheduledFor: "tomorrow-ish"`. | 422 `invalid_schedule` with detail `unparseable`. **Not** a 500. |
| SF-SCHED-007 | Scheduling works while the branch is currently closed | edge | P2 | MANUAL | 1. With the branch shut now, schedule for tomorrow's opening hours. | Accepted. Being closed now blocks immediate orders (`SF-BRANCH-003`) but not scheduled ones. |

---

## SF-PAY — Offline payment methods

**Goal:** pay by the merchant's own arrangements, verified by a human

There is **no payment gateway** — roadmap Spec 6 is parked. What exists is
per-tenant offline methods (bank transfer, wallet, cash on collection) with a
pay-to detail, and an order status of `pending_verification` for a customer who
claims to have paid.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| SF-PAY-001 | Enabled methods appear with their pay-to detail | happy | P1 | AUTOMATED (`offline-payment.spec.ts › checkout shows the enabled offline method and its pay-to detail`) | 1. Enable a bank-transfer method with a pay-to detail (`DSH-PAYM`). 2. Open checkout. | The method appears with its label and the pay-to detail the customer needs in order to pay. |
| SF-PAY-002 | A disabled method does not appear | permission | P1 | MANUAL | 1. Disable the method. 2. Reload checkout. | It is gone. Submitting an order naming it does not create a paid order. |
| SF-PAY-003 | Paying offline creates a pending_verification order | happy | P1 | AUTOMATED (`offline-payment.spec.ts › POST /api/orders with the offline method + reference creates a pending_verification order`) | 1. Check out choosing the offline method and giving a reference. | 201. `payment_status` is `pending_verification`, and the reference is stored. |
| SF-PAY-004 | It reaches the merchant's payments queue | happy | P1 | AUTOMATED (`offline-payment.spec.ts › the pending_verification order appears in the merchant's payments queue`) | 1. Open `/dashboard/payments`. | The order is listed awaiting verification with its reference. |
| SF-PAY-005 | Methods are ordered as configured | edge | P2 | MANUAL | 1. Configure three methods with distinct sort orders. 2. Open checkout. | They appear in the configured order. |
| SF-PAY-006 | Cash on collection needs no reference | happy | P2 | MANUAL | 1. Choose a cash-on-collection method and submit with no reference. | Accepted. A reference is only meaningful for a transfer. |

---

## SF-TRACK — Order tracking

**Goal:** the customer follows their order without an account

Tracking is authorised by possession of an unguessable `statusToken` in the URL.
Terminal states are `completed`, `rejected` and `cancelled`.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| SF-TRACK-001 | The tracking page shows the current status | happy | P1 | MANUAL | 1. Place an order and open its tracking link. | Status, items and total render. The tenant's WhatsApp number is offered for contact where configured. |
| SF-TRACK-002 | Status changes appear without a manual reload | happy | P1 | MANUAL | 1. Keep the page open. 2. Advance the order from the dashboard. | The displayed status updates on its own. |
| SF-TRACK-003 | Vertical wording is used | i18n | P1 | MANUAL | 1. Track a `demo-retail` order through preparing and ready. | It reads "Being packed" then "Ready for collection" — not "Preparing"/"Ready", which is restaurant wording. |
| SF-TRACK-004 | An unknown token gives a clean not-found | negative | P1 | MANUAL | 1. Open `/order/00000000-0000-0000-0000-000000000000`. | A clean not-found state. No other customer's order, and no stack trace. |
| SF-TRACK-005 | A token cannot cross tenants | permission | P1 | MANUAL | 1. Take a valid token from `roma`. 2. Open it on `demo-retail`'s host. | Not found. Tokens are scoped to their tenant by RLS. |

---

## SF-CANCEL — Customer cancellation

**Goal:** cancel while it is still safe to

Policy: **only while `pending`.** Once the shop confirms, the customer escalates
by phone or WhatsApp instead. The cancel restocks the order's items and the
`UPDATE` is guarded on `status = 'pending'`, which is what serialises it against
a simultaneous confirm.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| SF-CANCEL-001 | A pending order can be cancelled | happy | P1 | AUTOMATED (`scheduling.spec.ts › customer can schedule an order and cancel it while pending`) | 1. On the tracking page of a pending order, cancel. | Status becomes `cancelled` with reason `cancelled_by_customer`. The dashboard reflects it. |
| SF-CANCEL-002 | A confirmed order cannot be cancelled | negative | P1 | MANUAL | 1. Confirm the order from the dashboard. 2. Attempt to cancel from the tracking page. | The cancel affordance is gone. Forcing the call returns 422 `invalid_transition`. |
| SF-CANCEL-003 | Cancelling restocks the items | edge | P1 | MANUAL | 1. On `demo-retail` note stock. 2. Order 2, then cancel. | Stock returns to its original value — no leakage in either direction. |
| SF-CANCEL-004 | A simultaneous cancel and confirm resolve to one winner | edge | P1 | MANUAL | 1. Trigger a customer cancel and a dashboard confirm as close to simultaneously as possible. | Exactly one succeeds; the loser gets `invalid_transition`. The order lands in one coherent state, never both. |

---

## SF-ACCT — Customer accounts

**Goal:** a returning customer signs in and sees their own orders

Accounts are **per tenant**: the same person registers separately at each shop,
unique on `(tenantId, email)`. Customer sessions are a **separate lane** from
staff sessions — their own table, their own cookie (`serveos_customer`), resolved
against the storefront host's tenant. A customer cookie can never open the
dashboard, and that is the case worth caring about most.

Accounts are optional throughout: guest checkout is untouched, and signing in
only *attaches* `customerId` and prefills contact fields.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| SF-ACCT-001 | A customer registers and lands signed in | happy | P1 | MANUAL | 1. On `/account`, register with an email and password. | Signed in. The profile and an (empty) order list render. An audit event `customer.registered` exists with actor type `customer`. |
| SF-ACCT-002 | A customer signs in and out | happy | P1 | MANUAL | 1. Sign out, then sign in again. 2. Sign out. | Both succeed. `customer.login` and `customer.logout` audit events are recorded. |
| SF-ACCT-003 | A wrong password is refused and audited | negative | P1 | MANUAL | 1. Sign in with a wrong password. | Refused with a generic message. A `customer.login_failed` audit event is recorded. |
| SF-ACCT-004 | The same email can register at two shops | edge | P1 | MANUAL | 1. Register `a@b.com` on `roma`. 2. Register `a@b.com` on `demo-retail`. | Both succeed — uniqueness is `(tenantId, email)`, not email alone. The two accounts are unrelated and see only their own shop's orders. |
| SF-ACCT-005 | A duplicate email at the same shop is refused | negative | P1 | MANUAL | 1. Register `a@b.com` on `roma` twice. | The second is refused with a clear message, not a 500. |
| SF-ACCT-006 | Signing in prefills checkout and attaches the order | happy | P1 | MANUAL | 1. Signed in, open checkout. 2. Complete an order. | Name and phone are prefilled. The created order carries `customerId`, and it appears under "Your orders". |
| SF-ACCT-007 | Guest checkout still works and stays anonymous | happy | P1 | MANUAL | 1. Signed out, complete an order. | It succeeds. The order's `customerId` is null forever — it is not retro-attached if that person later registers with the same phone. |
| SF-ACCT-008 | A customer sees only their own orders | permission | P1 | MANUAL | 1. As customer A, place an order. 2. Sign in as customer B at the same shop. | B's list does not contain A's order. |
| SF-ACCT-009 | A customer cookie cannot open the dashboard | permission | P1 | MANUAL | 1. Signed in as a customer, request `app.serveos.localhost:3000/dashboard`. | Not signed in as far as the dashboard is concerned — redirected to the staff login. The staff session lane never accepts a customer token. |
| SF-ACCT-010 | A signed-out visitor sees the login form, not an error | edge | P2 | MANUAL | 1. Signed out, open `/account`. | The login/register form renders with copy explaining accounts are optional ("You can always order as a guest"). |

---

## SF-RX — Pharmacy prescriptions

**Goal:** a prescription-only item cannot be bought without a script on file
**Preconditions:** `demo-pharmacy`; a pharmacist user created via `DSH-STAFF`

Two hard requirements, both server-enforced: an Rx line needs a **signed-in
customer** (the compliance trail must name someone) and a **pending prescription
with no order attached**. Upload itself requires the vertical capability and a
customer session.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| SF-RX-001 | An Rx product is marked as needing a prescription | happy | P1 | MANUAL | 1. Browse to an Rx product on `demo-pharmacy`. | The card states a prescription is required before it can be ordered. |
| SF-RX-002 | A guest cannot order an Rx item | permission | P1 | MANUAL | 1. Signed out, add an Rx item and check out. | 422 `order_validation` / `prescription items require a signed-in customer account`. |
| SF-RX-003 | A signed-in customer with no script is refused | negative | P1 | MANUAL | 1. Signed in with no prescription uploaded, order an Rx item. | 422 `a prescription must be uploaded before ordering these items`. |
| SF-RX-004 | Uploading a prescription requires sign-in | permission | P1 | MANUAL | 1. Signed out, POST to `/api/prescriptions`. | 401 `Please sign in to upload a prescription`. |
| SF-RX-005 | Upload is unavailable on a non-pharmacy tenant | permission | P1 | MANUAL | 1. POST to `/api/prescriptions` on `roma`. | 404 `Not available` — gated on the `prescriptionUpload` capability, so the endpoint does not exist for a restaurant. |
| SF-RX-006 | A missing or invalid file is rejected | negative | P2 | MANUAL | 1. POST with no file, then with a non-file field. | 400 `No file provided`. Oversized or wrong-type files are rejected with their own status, not a 500. |
| SF-RX-007 | With a script on file, the order succeeds and is linked | happy | P1 | MANUAL | 1. Signed in, upload a prescription. 2. Order the Rx item. | 201. The prescription row's `orderId` is now set to that order — the script is consumed by it. |
| SF-RX-008 | A consumed prescription cannot cover a second order | edge | P1 | MANUAL | 1. After SF-RX-007, order another Rx item without uploading again. | Refused — the query requires a pending prescription with a null `orderId`. |
| SF-RX-009 | The pharmacist sees it in the review queue | happy | P1 | MANUAL | 1. As the pharmacist, open `/dashboard/prescriptions`. | The uploaded prescription is listed for review with its order. A manager (no `rx:review`) cannot see this page at all. |

---

## SF-TIMBER — Dimensional products and trade accounts

**Goal:** buy a cut length at a computed price, at trade rates where applicable
**Preconditions:** `demo-timber`

Dimensional products are priced **per unit of measure** — `m`, `m2` or `bf` — not
per item. Dimensions are entered in **millimetres** (Egypt is metric even for a
board-foot product) and converted per formula. Variants and modifiers are not
supported on a dimensional line.

Trade discount is capability-gated to timber, applies only to a signed-in
customer whose account is `tradeApproved`, and is folded into the same
order-discount slot rather than a parallel pipeline. A guest never gets it.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| SF-TIMBER-001 | A per-metre product asks for a length | happy | P1 | MANUAL | 1. Open a product priced per linear metre. | A length input in millimetres is required. The price shown updates from the entered length. |
| SF-TIMBER-002 | The computed price matches the formula | happy | P1 | MANUAL | 1. On a product at 100/m, enter a length of 2400mm. | Unit price is 240.00 — `100 × (2400 ÷ 1000)`, rounded to 3 decimals on quantity before money rounding. |
| SF-TIMBER-003 | An area product needs length and width | happy | P1 | MANUAL | 1. On an `m2` product, supply length only, then both. | Length alone is refused with `missing required dimension: widthMm`. With both, the price equals rate × (L÷1000) × (W÷1000). |
| SF-TIMBER-004 | A board-foot product needs all three dimensions | happy | P2 | MANUAL | 1. On a `bf` product, supply length and width only, then all three. | The first is refused naming `thicknessMm`. With all three, quantity is `(t_in × w_in × l_in) ÷ 144` with mm converted at 25.4. |
| SF-TIMBER-005 | Missing dimensions are refused | negative | P1 | MANUAL | 1. POST a dimensional line with no `dimensions`. | 422 `order_validation` / `dimensions required for this product`. |
| SF-TIMBER-006 | A non-positive dimension is refused | negative | P1 | MANUAL | 1. POST `lengthMm: 0`, then `-500`. | Refused both times with a positive-number message, not a zero-priced line. |
| SF-TIMBER-007 | Dimensions on a non-dimensional product are refused | negative | P2 | MANUAL | 1. POST dimensions on an ordinary each-priced product. | 422 `dimensions not applicable to this product`. |
| SF-TIMBER-008 | A variant cannot be combined with a dimensional line | negative | P2 | MANUAL | 1. POST a dimensional line carrying a `variantId`. | 422 `variants/modifiers not supported on a dimensional line`. |
| SF-TIMBER-009 | An approved trade customer gets their discount | happy | P1 | MANUAL | 1. Set a customer `tradeApproved` with 10%. 2. Sign in and order 1000 of goods. | 100 is discounted off the gross subtotal, before VAT. The order records it in the order-discount slot. |
| SF-TIMBER-010 | A guest and a non-timber tenant get no trade discount | permission | P1 | MANUAL | 1. Order as a guest on `demo-timber`. 2. Then as a trade-approved customer on `demo-retail`. | Neither receives a discount — it needs both a `customerId` and the `tradeAccounts` capability. |

---

## SF-PWA — Installable PWA

**Goal:** the shop installs to a phone home screen as that shop

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| SF-PWA-001 | The manifest is branded per tenant | happy | P1 | AUTOMATED (`onboarding.spec.ts › storefront serves a branded, installable PWA manifest`) | 1. GET `/manifest.webmanifest` on `roma`. | Valid manifest naming `roma`, with icons and a start URL. `demo-retail` returns its own name — not a shared ServeOS manifest. |
| SF-PWA-002 | The storefront renders the tenant's brand | happy | P1 | AUTOMATED (`onboarding.spec.ts › storefront home renders the restaurant brand`) | 1. Open the storefront. | The tenant's name and accent are used, matching its vertical's accent. |
| SF-PWA-003 | Install works on a phone | happy | P2 | MANUAL | 1. On a mobile browser, use "Add to home screen". | It installs under the tenant's name and icon, and opens the storefront standalone. |
| SF-PWA-004 | Two tenants install as two separate apps | edge | P2 | MANUAL | 1. Install `roma`, then `demo-retail`. | Two distinct home-screen icons and names. Neither shows the other's branding. |

---

## SF-HANDOFF — Receiving a WhatsApp basket

**Goal:** a chat basket arrives intact and can be checked out
**Cross-reference:** the minting side is `WA-HANDOFF` in [06-whatsapp.md](06-whatsapp.md)

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| SF-HANDOFF-001 | A valid token seeds the cart | happy | P1 | MANUAL | 1. Open the storefront with a fresh `?handoff=<token>`. | The chat's items appear in the cart, ready for checkout. |
| SF-HANDOFF-002 | A spent, expired or forged token seeds nothing | negative | P1 | MANUAL | 1. Reuse a redeemed token. 2. Use an expired one. 3. Invent one. | In all three cases the storefront loads normally with an empty cart. No error page. |
| SF-HANDOFF-003 | A handed-off delivery order can be completed | happy | P1 | MANUAL | 1. Hand off from a WhatsApp delivery. 2. Add an address and check out. | The order completes with the address, and delivery-area and minimum rules apply exactly as in `SF-CHK`. |

---

## Coverage summary

| Journey | Cases | P1 | Automated |
|---|---|---|---|
| SF-SERVE tenant resolution | 6 | 5 | 4 |
| SF-BROWSE browsing | 9 | 5 | 4 |
| SF-PROD product sheet | 9 | 7 | 3 |
| SF-CART the cart | 7 | 6 | 2 |
| SF-BRANCH branch & hours | 5 | 4 | 0 |
| SF-CHK checkout | 11 | 10 | 2 |
| SF-SCHED scheduling | 7 | 5 | 1 |
| SF-PAY offline payments | 6 | 4 | 3 |
| SF-TRACK order tracking | 5 | 5 | 0 |
| SF-CANCEL cancellation | 4 | 4 | 1 |
| SF-ACCT customer accounts | 10 | 9 | 0 |
| SF-RX prescriptions | 9 | 8 | 0 |
| SF-TIMBER dimensional & trade | 10 | 7 | 0 |
| SF-PWA installable PWA | 4 | 2 | 2 |
| SF-HANDOFF WhatsApp basket | 3 | 3 | 0 |
| **Total** | **105** | **84** | **22** |

105 cases against a budget of 90. The overrun is in `SF-TIMBER` and `SF-RX`,
where each validation rule is a separate way to sell something wrong — a
mispriced cut length or a prescription-only drug sold without a script are not
defects you catch by sampling.

**22 of 105 automated.** The existing suite covers browsing, the cart, offline
payments, scheduling and the PWA manifest reasonably well. The gaps are stark and
they are all in the newest work: **`SF-ACCT` (10 cases, 0 automated)**,
**`SF-RX` (9, 0)** and **`SF-TIMBER` (10, 0)** — three whole subsystems with no
end-to-end coverage at all, two of which decide either legal compliance or the
price on the invoice. Those are the three strongest automation candidates in the
pack after the POS money paths.
