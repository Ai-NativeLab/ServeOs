# QA — Merchant dashboard

**Surface code:** `DSH` · **Host:** `app.serveos.tech`
**Personas:** owner, manager, cashier (staff), pharmacist — see [personas.md](personas.md)
**Last verified against code:** 2026-08-17

Where the business is actually run: orders, catalogue, stock, staff, money and
the audit trail. ~35 pages, four roles with genuinely different views, and the
widest permission surface in the product.

---

## How to run this file

```bash
npm run db:seed        # roma + owner/manager/staff
npm run demo:seed      # a pharmacy and a timber tenant for the vertical journeys
npm run dev
```

Open `http://app.serveos.localhost:3000/login`. Sign in with **slug + email +
password** — the slug is what scopes the login to a tenant.

Run in file order. `DSH-REG` creates the application that `ADM-APPR` approves,
and `DSH-STAFF` creates the pharmacist that `DSH-RX` and `SF-RX` both need.

### Role landing pages

Each role lands somewhere different, and the difference is derived, not
hardcoded:

| Role | Nav items | Lands on | `/dashboard/settings` redirects to |
|---|---|---|---|
| owner | 13 | Home | Business Profile |
| manager | 12 | Home | **WhatsApp** (first tab they can see) |
| pharmacist | 5 | Home | **WhatsApp** |
| staff | 3 | **Orders** | **`/dashboard/orders`** — no settings tab is visible to them |

`SettingsIndexPage` redirects to the *first visible tab for that role*, falling
back to Orders. So a manager never sees Business Profile and is never shown an
authorization error for it either — worth confirming, because sending everyone to
a fixed first tab is the obvious way to get this wrong.

### The eight settings tabs and their permissions

| Tab | Permission | owner | manager | pharmacist | staff |
|---|---|:-:|:-:|:-:|:-:|
| Business Profile | `tenant:manage` | ✅ | — | — | — |
| WhatsApp | `fulfillment:manage` | ✅ | ✅ | ✅ | — |
| Fulfillment | `fulfillment:manage` | ✅ | ✅ | ✅ | — |
| Taxes | `fulfillment:manage` | ✅ | ✅ | ✅ | — |
| Payments | `fulfillment:manage` | ✅ | ✅ | ✅ | — |
| Staff | `staff:invite` | ✅ | ✅ | — | — |
| Billing | `billing:manage` | ✅ | — | — | — |
| POS devices | `tenant:manage` | ✅ | — | — | — |
| **Visible** | | **8** | **5** | **4** | **0** |

### The order state machine

From `nextStatuses` — note that **`cancelled` is reachable from every
non-terminal state**, and that `ready` branches on fulfillment type:

| From | Allowed next |
|---|---|
| `pending` | `confirmed` · `rejected` · `cancelled` |
| `confirmed` | `preparing` · `cancelled` |
| `preparing` | `ready` · `cancelled` |
| `ready` | delivery → `out_for_delivery` · pickup → `completed` · (both) `cancelled` |
| `out_for_delivery` | `completed` · `cancelled` |
| `completed`, `rejected`, `cancelled` | terminal — nothing |

`rejected` is reachable **only from `pending`**. That asymmetry is `DSH-ORD-006`.

---

## DSH-REG — Registering a business

**Goal:** a new business applies and waits for approval

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| DSH-REG-001 | A new business can register | happy | P1 | MANUAL | 1. Open `/register`. 2. Complete the form with a fresh slug, name, trade, owner email and password. | Account created. An onboarding application exists with status `pending` and the tenant is not yet `active`. |
| DSH-REG-002 | The chosen trade sets the vertical | happy | P1 | MANUAL | 1. Register choosing each trade in turn. | The tenant's vertical matches, and after approval its storefront uses that trade's template and terminology. |
| DSH-REG-003 | A duplicate slug is refused | negative | P1 | MANUAL | 1. Register with slug `roma`. | Refused with a clear message. No second tenant and no orphaned user. |
| DSH-REG-004 | An unapproved tenant cannot serve a storefront | permission | P1 | AUTOMATED (`onboarding.spec.ts` covers the manifest/brand side) | 1. Before approval, open the new tenant's storefront host. | The "getting ready" state — no catalogue. |
| DSH-REG-005 | The owner can sign in before approval | edge | P2 | MANUAL | 1. Sign in as the new owner before approval. | Record what happens. If the dashboard is fully usable while the tenant is unapproved, note it as a finding rather than assuming it is intended. |
| DSH-REG-006 | Required fields are validated | negative | P2 | MANUAL | 1. Submit with a missing email, a weak password and an invalid slug (spaces, uppercase, symbols). | Each is refused with a field-level message. No 500. |

---

## DSH-LOGIN — Signing in and out

**Goal:** the right person reaches the right tenant

Sign-out is worth a dedicated case: it lives inside a dropdown menu item, and
selecting an item closes the menu — which once unmounted the form in the same
click, so the server action never ran and the user silently stayed logged in.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| DSH-LOGIN-001 | Owner signs in and reaches the dashboard | happy | P1 | AUTOMATED (`dashboard.spec.ts › owner can sign in and reach Orders`) | 1. At `/login` enter slug `roma`, `owner@roma.com`, `owner1234`. | Lands on the dashboard with the branded shell and the sidebar. |
| DSH-LOGIN-002 | A wrong slug refuses a valid email and password | permission | P1 | MANUAL | 1. Enter slug `demo-retail` with `owner@roma.com` / `owner1234`. | Refused. The slug scopes the login — correct credentials for another tenant must not work here. |
| DSH-LOGIN-003 | A wrong password is refused generically | negative | P1 | MANUAL | 1. Enter the right slug and email with a wrong password. | A generic failure that does not reveal whether the email exists. |
| DSH-LOGIN-004 | A disabled user cannot sign in | permission | P1 | MANUAL | 1. Set a user's status to something other than `active`. 2. Attempt sign-in. | Refused. The same message as a bad password — the account's state is not disclosed. |
| DSH-LOGIN-005 | Sign-out actually ends the session | happy | P1 | AUTOMATED (`dashboard.spec.ts › sign out from the user menu ends the session`) | 1. Open the user menu, press Sign out. 2. Then navigate to `/dashboard`. | Redirected to `/login` **and** `/dashboard` is no longer reachable — the cookie is gone, not just the page changed. |
| DSH-LOGIN-006 | Signed out, every dashboard page redirects to login | permission | P1 | MANUAL | 1. Clear cookies. 2. Request `/dashboard`, `/dashboard/orders`, `/dashboard/menu`, `/dashboard/settings`, `/dashboard/audit`. | Each redirects to `/login`. None renders data. |

---

## DSH-NAV — Role-based navigation

**Goal:** each role sees only what it may use
**Cross-reference:** the full matrix is in [personas.md](personas.md)

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| DSH-NAV-001 | Owner sees all 13 nav items | permission | P1 | MANUAL | 1. Sign in as owner. 2. List the sidebar. | All 13 items, including Prescriptions (owner holds `rx:review`). |
| DSH-NAV-002 | Manager sees 12 — everything but Prescriptions | permission | P1 | MANUAL | 1. Sign in as manager. | 12 items. **Prescriptions is absent** — manager deliberately lacks `rx:review`. |
| DSH-NAV-003 | Staff sees 3 and lands on Orders | permission | P1 | AUTOMATED (`dashboard.spec.ts › staff cannot reach settings and is redirected to Orders`) | 1. Sign in as staff. | Only Orders, Sales history and Inventory. No Home, and `/dashboard/settings` redirects to `/dashboard/orders`. |
| DSH-NAV-004 | Pharmacist sees 5, including Prescriptions | permission | P1 | MANUAL | 1. Sign in as the pharmacist on `demo-pharmacy`. | Home, Orders, Sales history, Settings and Prescriptions. No Analytics, no Inventory, no Menu, no Customers. |
| DSH-NAV-005 | The catalogue item is relabelled per vertical | i18n | P2 | MANUAL | 1. Compare the sidebar on `roma`, `demo-retail` and `demo-timber`. | "Menu", "Products" and "Yard" respectively — from the vertical's `catalogNoun`. |
| DSH-NAV-006 | Direct URL access respects the same permissions | permission | P1 | MANUAL | 1. As staff, request `/dashboard/menu`, `/dashboard/analytics`, `/dashboard/audit`, `/dashboard/customers` directly. | Each is refused or redirected. Hiding a nav item is not the control — the page itself must enforce it. |

---

## DSH-HOME — Home and setup

**Goal:** a new owner knows what to do next

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| DSH-HOME-001 | Home shows setup progress on a fresh tenant | happy | P2 | MANUAL | 1. As the owner of a newly-approved tenant, open Home. | Outstanding setup steps are listed — add products, set hours, publish. |
| DSH-HOME-002 | Completed steps stop being suggested | happy | P2 | MANUAL | 1. Complete a step (e.g. publish). 2. Reload Home. | That step is marked done or removed. |
| DSH-HOME-003 | Home summarises today's trading | happy | P2 | MANUAL | 1. On a tenant with orders, open Home. | Today's order count and revenue render as numbers, agreeing with Orders and Analytics. |

---

## DSH-ORD — The orders queue

**Goal:** move every order through its lifecycle, and never sideways
**Preconditions:** orders in several states — `demo:seed` provides them

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| DSH-ORD-001 | Orders list with status tabs | happy | P1 | AUTOMATED (`dashboard.spec.ts › owner can sign in and reach Orders`) | 1. Open Orders. | The list renders with an "All" tab plus status tabs. An empty tenant shows an empty state, not a broken table. |
| DSH-ORD-002 | A pickup order walks its full path | happy | P1 | MANUAL | 1. Advance a pending pickup order: confirm → preparing → ready → completed. | Each step succeeds. `completed` offers no further transition. |
| DSH-ORD-003 | A delivery order routes through out-for-delivery | happy | P1 | MANUAL | 1. Advance a pending delivery order to `ready`. 2. Continue. | From `ready` the only forward step is `out_for_delivery`, then `completed`. `ready → completed` is **not** offered for delivery. |
| DSH-ORD-004 | An illegal transition is refused | negative | P1 | MANUAL | 1. POST a transition `pending → ready`, then `completed → preparing`. | Both refused with `invalid_transition`. The UI does not offer them either. |
| DSH-ORD-005 | Cancelling is possible from any live state | happy | P1 | MANUAL | 1. Cancel orders sitting in `pending`, `confirmed`, `preparing`, `ready` and `out_for_delivery`. | All five succeed — `cancelled` is reachable from every non-terminal state. |
| DSH-ORD-006 | Rejecting is only possible from pending | negative | P1 | MANUAL | 1. Reject a `pending` order. 2. Attempt to reject a `confirmed` one. | The first succeeds; the second is refused. `rejected` is reachable only from `pending`. |
| DSH-ORD-007 | Cancelling restocks a stock-tracked order | edge | P1 | MANUAL | 1. On `demo-retail`, note stock. 2. Order 2, then cancel from the dashboard. | Stock returns to its original value. |
| DSH-ORD-008 | Order detail shows items, tenders and adjustments | happy | P1 | MANUAL | 1. Open a POS sale with a discount, and an online order paid offline. | Each shows its lines, its tenders with methods, any discounts with reason codes, and the status history. |
| DSH-ORD-009 | Staff can manage orders but nothing else | permission | P1 | MANUAL | 1. As staff, advance an order. 2. Then attempt to reach Menu. | The advance succeeds (`orders:manage`); Menu is refused (`menu:manage`). |
| DSH-ORD-010 | Orders render as cards on a phone | responsive | P2 | AUTOMATED (`responsive.spec.ts › orders shows cards, not a wide table, on mobile`) | 1. Open Orders at 360px. | Cards, not a horizontally-scrolling table. No page overflow. |

---

## DSH-ORDH — Sales history

**Goal:** find any past sale across both channels

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| DSH-ORDH-001 | History spans POS and online | happy | P1 | MANUAL | 1. Ring a POS sale and place a storefront order. 2. Open Sales history. | Both appear, distinguishable by channel. |
| DSH-ORDH-002 | Search and date filters work | happy | P2 | MANUAL | 1. Filter by order number, then by a date range. | Each returns only matching sales. |
| DSH-ORDH-003 | Refunded sales show their refunds | happy | P1 | MANUAL | 1. Refund a sale on the POS. 2. Find it in history. | The refund is listed with its amount, kind and reason, and the payment status reads `refunded` or `partially_refunded`. |
| DSH-ORDH-004 | A manager can refund from the dashboard | permission | P1 | MANUAL | 1. As manager, issue a refund against a paid sale from the dashboard. | Accepted. The branch is assigned server-side — a client-supplied branch belonging to another tenant is refused with `Refund branch does not belong to this tenant`. |

---

## DSH-PAY — Payment verification

**Goal:** confirm money that arrived outside the system
**Preconditions:** a `pending_verification` order from `SF-PAY`

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| DSH-PAY-001 | The queue lists unverified payments | happy | P1 | AUTOMATED (`offline-payment.spec.ts › the pending_verification order appears in the merchant's payments queue`) | 1. Open `/dashboard/payments`. | The order appears with its reference and amount. |
| DSH-PAY-002 | Confirming marks the order paid | happy | P1 | MANUAL | 1. Confirm the payment. | `payment_status` becomes `paid`, it leaves the queue, and the customer's tracking page reflects it. |
| DSH-PAY-003 | A payment can be rejected | happy | P1 | MANUAL | 1. Reject a claimed payment. | The order does not become paid. Record the resulting state so it can be asserted consistently. |
| DSH-PAY-004 | Only `payments:confirm` holders can act | permission | P1 | MANUAL | 1. As staff, open `/dashboard/payments`. | Refused — the nav item is absent and the URL is not reachable. Manager and owner can both act. |
| DSH-PAY-005 | Confirmation is audited | edge | P1 | MANUAL | 1. Confirm a payment. 2. Open `/dashboard/audit`. | An event records the confirmation, who did it and which order. |

---

## DSH-CAT — Catalogue

**Goal:** build the thing customers buy
**Preconditions:** a role holding `menu:manage`

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| DSH-CAT-001 | A category can be created, edited and reordered | happy | P1 | MANUAL | 1. Create a category with EN and AR names. 2. Rename it. 3. Change its sort order. | All three persist and the storefront reflects them after publish. |
| DSH-CAT-002 | A product can be created with prices and images | happy | P1 | MANUAL | 1. Create a product with EN/AR names, a price and an image. | Saved. The image uploads and renders. The product appears under its category. |
| DSH-CAT-003 | Variants can be added and priced | happy | P1 | MANUAL | 1. On `demo-retail`, add two variants with different prices. | Both save and appear on the storefront with their own prices. |
| DSH-CAT-004 | Modifier groups enforce their own rules | happy | P1 | MANUAL | 1. On `roma`, create a group with `required`, min 1, max 2. 2. Try to save min 3 / max 2. | The valid group saves. The invalid one is refused — `min <= max`, and `required` implies min ≥ 1. |
| DSH-CAT-005 | Modifiers are refused on a vertical that lacks the capability | permission | P1 | MANUAL | 1. Attempt to add a modifier group on `demo-retail` (no `modifiers` capability). | Refused or unavailable. Capabilities gate the editor, not just the storefront. |
| DSH-CAT-006 | Stock quantity can be set where tracked | happy | P1 | MANUAL | 1. On `demo-retail`, set a product's stock to 5. 2. On `roma`, look for the same field on a dish. | Retail accepts it and the storefront reflects availability. A made-to-order restaurant dish does not offer finished-goods stock the same way. |
| DSH-CAT-007 | A product can be archived or deactivated | happy | P2 | MANUAL | 1. Deactivate a product. 2. Publish. 3. Check the storefront. | It disappears from the storefront. Historic orders that contain it still render correctly. |
| DSH-CAT-008 | The product limit is enforced by plan | permission | P1 | MANUAL | 1. On a `basic` tenant (limit 50), create products up to and past the limit. | The 51st is refused with a quota error naming the limit, not a 500. |
| DSH-CAT-009 | Menu renders as cards on a phone | responsive | P2 | AUTOMATED (`responsive.spec.ts › menu shows product cards, not a wide table, on mobile`) | 1. Open Menu at 360px. | Cards, not a wide table. No overflow. |

---

## DSH-PUB — Publishing

**Goal:** changes reach customers only when the merchant says so

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| DSH-PUB-001 | Unpublished edits are invisible to customers | happy | P1 | MANUAL | 1. Change a price without publishing. 2. Check the storefront and `/api/menu`. | The storefront still shows the old price. Draft edits do not leak. |
| DSH-PUB-002 | Publishing pushes everything at once | happy | P1 | MANUAL | 1. Make several edits. 2. Publish. 3. Reload the storefront. | All changes appear together. |
| DSH-PUB-003 | The publish screen shows what will change | happy | P2 | MANUAL | 1. With pending edits, open Publish. | A summary of pending changes. With none, it says there is nothing to publish. |
| DSH-PUB-004 | Publishing is audited | edge | P2 | MANUAL | 1. Publish. 2. Open the audit log. | An event records the publish and who did it. |

---

## DSH-INV — Inventory items and on-hand

**Goal:** know what stock exists and where
**Preconditions:** `inventory` capability (on for all four verticals); a role with `inventory:view`

Inventory is a **lot-based ledger** with units of measure and per-branch storage
locations — not a single counter. Two error types matter and must not be
confused: `OutOfStockError` is a shortage; `InventoryConfigError` is a
misconfiguration ("Inventory isn't fully configured for this item"). Reporting a
misconfiguration as a shortage would send someone to count shelves for a data
problem.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| DSH-INV-001 | Items list with on-hand per location | happy | P1 | MANUAL | 1. Open Inventory. | Items list with their unit of measure and on-hand quantity per storage location. |
| DSH-INV-002 | An item can be created with a unit of measure | happy | P1 | MANUAL | 1. Create an item measured in `kg`, another in `each`. | Both save with their UoM. The UoM is validated at the API boundary. |
| DSH-INV-003 | Incompatible unit conversion is refused | negative | P1 | MANUAL | 1. Configure a conversion from `g` to `ml`. | Refused with `dimensional_uom` — "These units of measure can't be converted to each other". Density is not modelled, so mass-to-volume is not guessed. |
| DSH-INV-004 | A product can be linked to an item or a recipe | happy | P1 | MANUAL | 1. Link a retail product to a finished-goods item. 2. Link a restaurant dish to a recipe. | Both links save. The link kind selects which deduction path a sale uses. |
| DSH-INV-005 | A misconfigured link fails as configuration, not shortage | negative | P1 | MANUAL | 1. Link a product to a recipe, then delete the recipe. 2. Sell that product. | The failure is `inventory_config` ("Inventory isn't fully configured for this item"), **not** an out-of-stock error. |
| DSH-INV-006 | Staff can view and count but not manage | permission | P1 | MANUAL | 1. As staff, open Inventory. 2. Attempt to edit an item, then to open a count. | Viewing works and counting works (`inventory:view` + `inventory:count`). Editing is refused (`inventory:manage`). |
| DSH-INV-007 | A pharmacist cannot reach Inventory at all | permission | P1 | MANUAL | 1. As the pharmacist, look for Inventory in the nav and request the URL. | Absent and refused — pharmacist holds no `inventory:*` permission. |

---

## DSH-MOVE — Receipts, adjustments and transfers

**Goal:** stock moves in, out and between locations, always accounted for

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| DSH-MOVE-001 | Receiving stock creates a lot | happy | P1 | MANUAL | 1. Receive 10kg of an item at a location, with a lot code and expiry. | On-hand rises by 10. A lot exists carrying the code and expiry. |
| DSH-MOVE-002 | An adjustment can correct a lot down | happy | P1 | MANUAL | 1. Adjust a lot down by 2 with a reason. | On-hand falls by 2 and the adjustment is recorded against that lot. |
| DSH-MOVE-003 | An adjustment beyond the lot is refused | negative | P1 | MANUAL | 1. Adjust a lot holding 3 down by 5. | Refused with `adjustment exceeds what the lot holds`. On-hand is unchanged. |
| DSH-MOVE-004 | An adjustment against the wrong lot is refused | negative | P1 | MANUAL | 1. Adjust using a lot id belonging to a different item or location. | Refused with `lot does not belong to this item and location`. |
| DSH-MOVE-005 | A transfer moves stock between locations | happy | P1 | MANUAL | 1. Transfer 4kg from location A to B. | A falls by 4, B rises by 4, and the total is unchanged. Lot identity is preserved through the transfer. |
| DSH-MOVE-006 | A transfer beyond available stock is refused | negative | P1 | MANUAL | 1. Transfer 100 from a location holding 10. | Refused with `not enough stock at the source location to transfer`. Neither location moves. |
| DSH-MOVE-007 | A non-positive transfer is refused | negative | P2 | MANUAL | 1. Transfer 0, then -5. | Refused with `a transfer quantity must be positive`. |
| DSH-MOVE-008 | Selling deducts through the link | happy | P1 | MANUAL | 1. Sell a linked retail product. 2. Sell a recipe-linked dish. | The finished-goods item falls by the quantity sold; the dish's recipe components each fall by their recipe amount. |

---

## DSH-CNT — Stock counts

**Goal:** count the shelves and commit the truth

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| DSH-CNT-001 | A count can be opened for a location | happy | P1 | MANUAL | 1. Open a count for a branch location. | Status `open`. Lines can be added. |
| DSH-CNT-002 | A location from another branch is refused | negative | P1 | MANUAL | 1. Open a count naming a location belonging to a different branch. | Refused with `location does not belong to this branch`. |
| DSH-CNT-003 | Counted lines can be entered and revised | happy | P1 | MANUAL | 1. Add counted quantities, then change one before committing. | The latest value is held. Nothing has moved on-hand yet. |
| DSH-CNT-004 | Committing applies the variance | happy | P1 | MANUAL | 1. Count an item 3 below its on-hand. 2. Commit. | On-hand becomes the counted figure and the variance is recorded as an adjustment. Status becomes committed. |
| DSH-CNT-005 | A committed count cannot be reopened or recommitted | negative | P1 | MANUAL | 1. Add lines to a committed count. 2. Commit it again. | Both refused with `stock count is already <status>`. |
| DSH-CNT-006 | Staff can run a count | permission | P1 | MANUAL | 1. As staff, open a count, enter lines and commit. | Allowed — `inventory:count` exists precisely so shop-floor staff can count without holding `inventory:manage`. |

---

## DSH-REC — Recipes and BOM

**Goal:** a dish knows what it consumes
**Preconditions:** `recipes` capability — restaurant only

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| DSH-REC-001 | A recipe can be created with components | happy | P1 | MANUAL | 1. On `roma`, create a recipe with two components and quantities. | Saved with both components and their UoMs. |
| DSH-REC-002 | Component quantities must be positive | negative | P2 | MANUAL | 1. Save a component at 0, then -1. | Refused. |
| DSH-REC-003 | A recipe component in an incompatible unit is refused | negative | P1 | MANUAL | 1. Add a component measured in `ml` to an item stocked in `g`. | Refused with `dimensional_uom`. |
| DSH-REC-004 | Selling a recipe dish deducts its components | happy | P1 | MANUAL | 1. Note component on-hand. 2. Sell 2 of the dish. | Each component falls by twice its recipe quantity. |
| DSH-REC-005 | A recipe with a missing component item fails as config | negative | P1 | MANUAL | 1. Delete an item still referenced by a recipe. 2. Sell the dish. | Refused with `inventory_config` — `recipe component item missing`, not an out-of-stock error. |
| DSH-REC-006 | Recipes are unavailable on non-restaurant verticals | permission | P2 | MANUAL | 1. Look for Recipes on `demo-retail`. | Absent — gated on the `recipes` capability. |

---

## DSH-BR — Branches, hours and delivery areas

**Goal:** the shop's real-world geography and opening times

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| DSH-BR-001 | A branch can be created and edited | happy | P1 | MANUAL | 1. Create a branch with a name and address. | Saved and offered on the storefront picker. |
| DSH-BR-002 | The branch limit is enforced by plan | permission | P1 | MANUAL | 1. On `basic` (limit 1), create a second branch. | Refused with a quota error naming the limit of 1. On `pro` (3) it succeeds until the fourth. |
| DSH-BR-003 | Opening hours drive the storefront banner | happy | P1 | MANUAL | 1. Set hours excluding now. 2. Check the storefront. | The closed banner appears and immediate orders are refused (`SF-BRANCH-003`). |
| DSH-BR-004 | A delivery area can be created with a fee and minimum | happy | P1 | MANUAL | 1. Create an area with a 100 minimum and a 15 fee. | Saved and offered at checkout, applying both figures. |
| DSH-BR-005 | Deactivating an area removes it from checkout | permission | P1 | MANUAL | 1. Deactivate the area. 2. Open checkout. | It is not offered, and ordering to it returns `area_not_deliverable`. |
| DSH-BR-006 | A branch can be deactivated | happy | P2 | MANUAL | 1. Deactivate a branch. | It leaves the storefront picker. Existing orders against it still render. |
| DSH-BR-007 | Hours are interpreted in the tenant's time zone | edge | P1 | MANUAL | 1. Set hours 09:00–17:00. 2. Check the open state near both boundaries. | Open and closed flip at the tenant's local wall-clock time, not UTC. |

---

## DSH-BAN — Banners

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| DSH-BAN-001 | A banner can be created and shown | happy | P2 | MANUAL | 1. Create an active banner with an image and link. 2. Check the storefront. | It renders and its link works. |
| DSH-BAN-002 | An inactive or expired banner does not render | edge | P2 | MANUAL | 1. Deactivate it, then set an end date in the past. | It does not render in either case. |
| DSH-BAN-003 | No banners leaves a clean layout | edge | P2 | MANUAL | 1. Remove all banners. | The storefront closes the gap rather than leaving an empty band. |

---

## DSH-CUST — Customers

**Goal:** see who buys, without leaking who buys elsewhere

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| DSH-CUST-001 | Registered customers are listed | happy | P1 | MANUAL | 1. Register a customer on the storefront (`SF-ACCT`). 2. Open `/dashboard/customers`. | They appear with their contact details and order count. |
| DSH-CUST-002 | Guest orders do not create customers | edge | P1 | MANUAL | 1. Place a guest order. 2. Check the customers list. | No customer row is created — guest orders stay anonymous. |
| DSH-CUST-003 | Only this tenant's customers are visible | permission | P1 | MANUAL | 1. Register the same email on two tenants. 2. View each tenant's list. | Each sees only its own row. Per-tenant accounts are genuinely separate. |
| DSH-CUST-004 | A timber customer can be trade-approved | happy | P1 | MANUAL | 1. On `demo-timber`, set a customer trade-approved with a discount percent. | Saved, and the discount applies at checkout (`SF-TIMBER-009`). On `demo-retail` the option is absent — `tradeAccounts` is timber-only. |
| DSH-CUST-005 | Only `customers:manage` holders can reach it | permission | P1 | MANUAL | 1. As staff and as the pharmacist, look for Customers and request the URL. | Absent and refused for both. |

---

## DSH-RX — Prescription review

**Goal:** a licensed reviewer approves or rejects a script
**Preconditions:** `demo-pharmacy`, a pharmacist user, an uploaded prescription from `SF-RX`

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| DSH-RX-001 | The pharmacist sees the review queue | happy | P1 | MANUAL | 1. As the pharmacist, open `/dashboard/prescriptions`. | Pending prescriptions are listed with their uploaded file and linked order. |
| DSH-RX-002 | A prescription can be approved | happy | P1 | MANUAL | 1. Approve one. | Its status changes and the linked order can proceed. An audit event names the pharmacist. |
| DSH-RX-003 | A prescription can be rejected with a reason | happy | P1 | MANUAL | 1. Reject one, giving a reason. | The status and reason are recorded, and the order does not proceed on it. |
| DSH-RX-004 | A manager cannot review prescriptions | permission | P1 | MANUAL | 1. As manager on `demo-pharmacy`, look for Prescriptions and request the URL. | Absent and refused. Manager deliberately lacks `rx:review` — the compliance trail must name a licensed reviewer. |
| DSH-RX-005 | The owner can review | permission | P2 | MANUAL | 1. As owner, open Prescriptions. | Reachable — owner holds `rx:review`. |
| DSH-RX-006 | The page is unavailable on a non-pharmacy tenant | permission | P2 | MANUAL | 1. As owner on `roma`, look for Prescriptions. | Absent — `pharmacistReview` is a pharmacy capability. |

---

## DSH-ANL — Analytics

**Goal:** the numbers are right, and gated

Four pages: overview, sales, financial, inventory, purchasing.

> **Open question the pack must answer.** `ROADMAP.md` decision D6 states the
> `advanced_analytics` entitlement is "now-enforced". Whether `requireFeature`
> actually gates these pages is **not** established by reading the nav gate
> (which is `menu:manage`). `DSH-ANL-006` settles it — record the real behaviour
> rather than assuming either way.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| DSH-ANL-001 | Overview renders its aggregations | happy | P1 | MANUAL | 1. On a tenant with trading history, open Analytics. | Revenue, order count and top products render as numbers with no empty or errored charts. |
| DSH-ANL-002 | Sales analytics agrees with the orders list | edge | P1 | MANUAL | 1. Compare the sales figure for a date range against the orders in that range. | They agree. A discrepancy is a reporting defect, not a rounding one. |
| DSH-ANL-003 | Financial analytics spans both channels | happy | P1 | MANUAL | 1. Ring a POS sale and place an online order. 2. Open Analytics → Financial. | Both are included. Discounts appear in the discounts table. |
| DSH-ANL-004 | The Voids table is empty — and that is current behaviour | edge | P2 | MANUAL | 1. Open Analytics → Financial and find Voids. | Always empty: nothing in the codebase writes `line_void` or `order_void`. See `POS-GAP-002` — a product question, not a bug to re-file. |
| DSH-ANL-005 | An empty tenant renders zeroes, not errors | edge | P2 | MANUAL | 1. On a tenant with no orders, open all four analytics pages. | Zeroes and empty charts. No exception. |
| DSH-ANL-006 | Determine whether `advanced_analytics` is enforced | permission | P1 | MANUAL | 1. On a `basic` tenant (`advanced_analytics: false`), open each analytics page as owner. | **Record the actual behaviour.** If the pages render fully, the entitlement is dormant and `ROADMAP.md` D6 is wrong — file that as a finding. If they are gated, confirm the message is a feature-unavailable error and not a crash. |
| DSH-ANL-007 | Staff and pharmacist cannot reach analytics | permission | P1 | MANUAL | 1. As staff and as the pharmacist, request `/dashboard/analytics`. | Refused for both — gated on `menu:manage`. |
| DSH-ANL-008 | Analytics does not overflow at 360px | responsive | P2 | AUTOMATED (`responsive.spec.ts › dashboard pages do not overflow`) | 1. Open analytics at 360px. | No horizontal overflow, including the Top Products grid. |

---

## DSH-AUD — The tenant audit log

**Goal:** the trail is complete and provably untampered

This is the **tenant** log: append-only, **hash-chained** (each entry carries
`prevHash` and `entryHash`), device-fingerprinted, and covering all mutations
plus auth events across every actor type. It is deliberately separate from the
platform `audit_logs` that `ADM-AUD` covers.

`GET /api/audit/chain/status` returns the chain head and a verification result —
that endpoint is the point of a tamper-evident log, so it earns its own cases.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| DSH-AUD-001 | Actions across every surface appear | happy | P1 | MANUAL | 1. Perform a POS sale, a dashboard price change, a customer login and a failed cashier sign-in. 2. Open `/dashboard/audit`. | All four appear, each with its actor, actor type, action and summary. |
| DSH-AUD-002 | The chain verifies clean | happy | P1 | MANUAL | 1. GET `/api/audit/chain/status`. | A head with a `seq` and `headHash`, and a verification result reporting the chain intact. |
| DSH-AUD-003 | Tampering is detected | edge | P1 | MANUAL | 1. On a disposable database, edit one `audit_events` row's summary directly in SQL. 2. Re-check chain status. | Verification now **fails** and identifies the break. A log that still verifies after an edit is not tamper-evident. |
| DSH-AUD-004 | Sequence numbers are gapless | edge | P1 | MANUAL | 1. Perform several audited actions. 2. Inspect `seq` values. | Consecutive with no gaps and no reuse. |
| DSH-AUD-005 | Failed sign-ins are recorded with a null actor | edge | P1 | MANUAL | 1. Fail a cashier sign-in twice — once with a bad password, once with an account lacking `pos:sell`. | Two `auth.login_failed` events, actor type `system`, null actor user, with reasons `bad_credentials` and `not_a_cashier`. |
| DSH-AUD-006 | Only `audit:view` holders can read it | permission | P1 | MANUAL | 1. As staff and as the pharmacist, open `/dashboard/audit` and GET the chain-status endpoint. | Page refused for both; the endpoint returns **403** `Forbidden` rather than redirecting or leaking. |
| DSH-AUD-007 | The log cannot be edited or deleted | permission | P1 | MANUAL | 1. Look for any edit or delete affordance. 2. Attempt a delete through the API. | None exists and none succeeds. |
| DSH-AUD-008 | Another tenant's events never appear | permission | P1 | MANUAL | 1. Act on two tenants. 2. Read each tenant's audit page. | Each shows only its own events — RLS-scoped. |

---

## DSH-NOT — Notifications

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| DSH-NOT-001 | New orders raise a notification | happy | P1 | MANUAL | 1. Place a storefront order. 2. Check the topbar bell and `/dashboard/notifications`. | A notification appears with an unread indicator. |
| DSH-NOT-002 | Marking read clears the indicator | happy | P2 | MANUAL | 1. Mark it read. | The unread count drops and the indicator clears. It does not return on reload. |
| DSH-NOT-003 | The worker endpoint processes the queue | edge | P2 | MANUAL | 1. POST to `/api/notifications/worker`. | Queued notifications are processed. Calling it twice does not double-send. |
| DSH-NOT-004 | A provider webhook updates delivery state | edge | P2 | MANUAL | 1. POST a provider webhook to `/api/notifications/webhook/<provider>`. | The delivery state is recorded. An unknown provider is rejected cleanly, not 500. |

---

## DSH-SET — The settings hub

**Goal:** each role reaches exactly the tabs it may use

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| DSH-SET-001 | Owner sees all 8 tabs and lands on Business Profile | permission | P1 | AUTOMATED (`dashboard.spec.ts › owner sees every settings tab and lands on Business Profile`) | 1. As owner open `/dashboard/settings`. | Redirects to `/dashboard/settings/profile`. All 8 tabs visible. |
| DSH-SET-002 | Manager sees 5 tabs and lands on WhatsApp | permission | P1 | MANUAL | 1. As manager open `/dashboard/settings`. | Redirects to the WhatsApp tab — the first one they can see. Business Profile, Billing and POS devices are **absent**, and requesting them directly is refused. |
| DSH-SET-003 | Pharmacist sees 4 tabs | permission | P1 | MANUAL | 1. As the pharmacist open `/dashboard/settings`. | WhatsApp, Fulfillment, Taxes, Payments only. No Staff tab — they lack `staff:invite`. |
| DSH-SET-004 | Staff is redirected out entirely | permission | P1 | AUTOMATED (`dashboard.spec.ts › staff cannot reach settings and is redirected to Orders`) | 1. As staff open `/dashboard/settings`. | Redirects to `/dashboard/orders` — no visible tab, so the fallback applies. |
| DSH-SET-005 | Business profile changes reach the storefront | happy | P1 | MANUAL | 1. As owner change the business name and logo. 2. Check the storefront and its PWA manifest. | Both reflect the change. |
| DSH-SET-006 | Fulfillment settings drive checkout | happy | P1 | MANUAL | 1. Toggle pickup and delivery availability. 2. Open checkout. | Only the enabled options are offered. |
| DSH-SET-007 | Tax settings change the totals breakdown | happy | P1 | MANUAL | 1. Change the VAT rate, toggle `vatEnabled`, then toggle `pricesIncludeVat`. 2. Check a storefront total. | The breakdown and total follow each setting. Prices-inclusive changes how VAT is presented rather than adding to the total. |
| DSH-SET-008 | The service charge applies to restaurant only | edge | P1 | MANUAL | 1. Set a service-charge rate on `roma` and on `demo-retail`. | It applies on `roma`. On retail it either is not offered or does not affect the total — only restaurant has the `serviceCharge` capability. |
| DSH-SET-009 | WhatsApp number is E.164 validated | negative | P2 | MANUAL | 1. Save `01012345678`, then `+201012345678`. | The first is refused (no country code), the second accepted. |

---

## DSH-STAFF — Staff and roles

**Goal:** add people with the right access
**Note:** this journey is how the **pharmacist** account for `DSH-RX` and `SF-RX` gets created

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| DSH-STAFF-001 | A staff member can be invited with a role | happy | P1 | MANUAL | 1. As owner invite a user and assign `manager`. | Created. They can sign in and see the manager's 12 nav items. |
| DSH-STAFF-002 | A pharmacist can be created | happy | P1 | MANUAL | 1. On `demo-pharmacy` invite a user with the `pharmacist` role. | Created. Signing in shows 5 nav items including Prescriptions and excluding Analytics and Inventory. |
| DSH-STAFF-003 | The staff limit is enforced by plan | permission | P1 | MANUAL | 1. On `basic` (limit 2), invite past the limit. | Refused with a quota error naming the limit. |
| DSH-STAFF-004 | A role can be changed and access follows | happy | P1 | MANUAL | 1. Change a staff user to manager. 2. Sign in as them. | Their nav and permissions change accordingly — the change takes effect on their next request, not only after a re-invite. |
| DSH-STAFF-005 | A user can be deactivated | happy | P1 | MANUAL | 1. Deactivate a user. 2. Attempt dashboard and POS sign-in as them. | Both refused. An active POS cashier session for them should not survive — record what happens if it does. |
| DSH-STAFF-006 | A manager can invite but not grant owner | permission | P1 | MANUAL | 1. As manager, invite a user. 2. Attempt to assign the `owner` role. | The invite works (`staff:invite`). Granting owner must not be possible — a manager escalating to owner would defeat the whole matrix. |
| DSH-STAFF-007 | Staff cannot reach the Staff tab | permission | P1 | MANUAL | 1. As staff, request `/dashboard/settings/staff`. | Refused. |

---

## DSH-POSD — POS devices

**Goal:** pair and revoke tills
**Cross-reference:** the till side is `POS-PAIR` in [05-pos.md](05-pos.md)

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| DSH-POSD-001 | A pairing code can be minted | happy | P1 | MANUAL | 1. As owner open Settings → POS devices. 2. Mint a code for a branch with a label. | An 8-character code (`A–Z0–9`) with a 10-minute expiry is shown. An audit event records `device.pairing_created`. |
| DSH-POSD-002 | Paired devices are listed | happy | P1 | MANUAL | 1. Pair a till (`POS-PAIR`). 2. Reload the page. | The device appears with its label and branch. |
| DSH-POSD-003 | A device can be revoked | happy | P1 | MANUAL | 1. Revoke a paired device. 2. Use the POS. | The POS reports `Device unpaired — please pair again` and returns to the pairing screen. |
| DSH-POSD-004 | Only `tenant:manage` holders can reach it | permission | P1 | MANUAL | 1. As manager, look for the POS devices tab and request its URL. | Absent and refused — it is an owner-only tab. |
| DSH-POSD-005 | The minted code cannot be redeemed at the till | edge | P2 | MANUAL | 1. Mint a code. 2. Look for a field to enter it in the POS. | There is none — see `POS-GAP-003`. Confirms the documented gap; do not re-file. |

---

## DSH-BILL — Billing and plan

**Goal:** see the plan, its usage, and pay for it

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| DSH-BILL-001 | The current plan and usage render | happy | P1 | MANUAL | 1. As owner open Settings → Billing. | The plan name, price and usage bars against each limit — branches, staff, products, orders this month. |
| DSH-BILL-002 | Usage bars reflect real counts | edge | P1 | MANUAL | 1. Add a product and a staff member. 2. Reload Billing. | Both bars advance by one and agree with the actual counts. |
| DSH-BILL-003 | A plan change can be requested | happy | P1 | MANUAL | 1. Request an upgrade to Pro. | The request is recorded (`upgradeRequest` in tenant settings) and surfaces to the platform admin. |
| DSH-BILL-004 | Payment proof can be submitted | happy | P1 | MANUAL | 1. Submit a reference and proof for an invoice. | It appears in the admin billing queue (`ADM-BILL-001`). |
| DSH-BILL-005 | Only `billing:manage` holders can reach it | permission | P1 | MANUAL | 1. As manager, look for the Billing tab and request its URL. | Absent and refused — owner only. |
| DSH-BILL-006 | An admin override is reflected here | edge | P1 | MANUAL | 1. Have an admin force the subscription active (`ADM-BILL-003`). 2. Reload Billing. | The active subscription and restored entitlements are shown. |

---

## Coverage summary

| Journey | Cases | P1 | Automated |
|---|---|---|---|
| DSH-REG registration | 6 | 4 | 1 |
| DSH-LOGIN sign-in/out | 6 | 6 | 2 |
| DSH-NAV role navigation | 6 | 5 | 1 |
| DSH-HOME home & setup | 3 | 0 | 0 |
| DSH-ORD orders queue | 10 | 9 | 2 |
| DSH-ORDH sales history | 4 | 3 | 0 |
| DSH-PAY payment verification | 5 | 5 | 1 |
| DSH-CAT catalogue | 9 | 7 | 1 |
| DSH-PUB publishing | 4 | 2 | 0 |
| DSH-INV inventory & on-hand | 7 | 7 | 0 |
| DSH-MOVE receipts/adjust/transfer | 8 | 7 | 0 |
| DSH-CNT stock counts | 6 | 6 | 0 |
| DSH-REC recipes & BOM | 6 | 4 | 0 |
| DSH-BR branches & areas | 7 | 6 | 0 |
| DSH-BAN banners | 3 | 0 | 0 |
| DSH-CUST customers | 5 | 5 | 0 |
| DSH-RX prescription review | 6 | 4 | 0 |
| DSH-ANL analytics | 8 | 5 | 1 |
| DSH-AUD tenant audit log | 8 | 8 | 0 |
| DSH-NOT notifications | 4 | 1 | 0 |
| DSH-SET settings hub | 9 | 8 | 2 |
| DSH-STAFF staff & roles | 7 | 7 | 0 |
| DSH-POSD POS devices | 5 | 4 | 0 |
| DSH-BILL billing & plan | 6 | 6 | 0 |
| **Total** | **148** | **119** | **11** |

148 cases against a budget of 115. The dashboard is ~35 pages with four distinct
role views; the overrun is concentrated in inventory (`DSH-INV`, `DSH-MOVE`,
`DSH-CNT`, `DSH-REC` — 27 cases between them), which is the newest and largest
subsystem and has no end-to-end coverage at all.

**11 of 148 automated**, and the 11 cluster in sign-in, navigation and
responsiveness. Everything that changes business data — catalogue, stock,
recipes, branches, staff, roles, billing — is manual.

Two things to carry out of this file:

- **`DSH-ANL-006` is an open question, not a test.** It settles whether the
  `advanced_analytics` entitlement is actually enforced. `ROADMAP.md` D6 claims
  it is; nothing in the nav gate suggests it. Whichever way it lands, something
  needs correcting — the code or the roadmap.
- **`DSH-AUD-003` is the single highest-value case in the pack.** A hash-chained
  audit log that still verifies after a row is edited provides no evidence at
  all, and nothing automated tests it today.
