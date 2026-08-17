# QA — POS (Electron till)

**Surface code:** `POS` · **App:** `apps/pos` desktop build · **API:** `/api/pos/v1/*`
**Personas:** cashier (staff), manager, owner — see [personas.md](personas.md)
**Last verified against code:** 2026-08-17

The till. A device is paired once and stays paired; a human signs in on top of
that device; the drawer is a third, separate thing that belongs to the till
rather than to either. Almost none of this is automated — the Playwright suite
never launches Electron — so this file is where POS coverage actually lives.

---

## How to run this file

```bash
npm run db:seed        # platform admin, demo restaurant `roma`, demo users
npm run dev            # web app on serveos.localhost:3000
npm run pos:dev        # Electron + Vite, second terminal
```

Run the journeys **top to bottom on a fresh seed.** They are ordered as
dependencies: `POS-PAIR` mints the device every later journey needs,
`POS-DRW` opens the drawer `POS-TND` spends, and `POS-ZRP` closes it. Jumping
into the middle of the file will fail cases for the wrong reason.

To re-run from clean, `npm run db:seed` again and unpair the device (delete the
app's stored token — the app returns to the sign-in screen on next launch).

### Reference values

| Thing | Value | Source |
|---|---|---|
| Seeded slug | `roma` (restaurant vertical) | `npm run db:seed` |
| Owner | `owner@roma.com` / `owner1234` | seed |
| Manager | `manager@roma.com` / `manager1234` | seed |
| Staff (cashier) | `staff@roma.com` / `staff1234` | seed |
| Pairing code TTL | 10 minutes, single use, 8 chars `A–Z0–9` | `pos/service.ts:19` |
| Cashier session TTL | 12 hours, **in server process memory** | `pos/cashier.ts:13` |
| Manager grant TTL | 2 minutes, **single use** | `pos/grants.ts:6` |
| `blindClose` default | `false` | `tenancy/settings.ts:205` |
| `payoutThreshold` default | `0` | `tenancy/settings.ts:206` |
| `varianceThreshold` default | `0` | `tenancy/settings.ts:207` |

**The three defaults matter more than they look.** `payoutThreshold: 0` fails
the `policy.payoutThreshold > 0` guard, so on a fresh seed **no pay-out ever
asks for a manager** — the approval cases below tell you to change the setting
first. `varianceThreshold: 0` means any non-zero variance is flagged, because
the check is `|variance| > threshold`.

### Permissions that gate this surface

A cashier session carries only the `pos:*` permissions plus
`reconciliation:manage` (`posPermissionsFor`, `pos/cashier.ts:39`).

| Permission | owner | manager | staff | pharmacist |
|---|---|---|---|---|
| `pos:sell` | ✅ | ✅ | ✅ | ✅ |
| `pos:discount` | ✅ | ✅ | — | — |
| `pos:refund` | ✅ | ✅ | — | — |
| `pos:void` | ✅ | ✅ | — | — |
| `reconciliation:manage` | ✅ | ✅ | — | — |

Anything a cashier lacks is reachable through a **manager grant**: the manager
enters their own credentials at the till, the server verifies password *and*
permission, and returns a single-use token the action then spends
(`resolveAuthorizer`, `pos/grants.ts`).

---

## Known gaps — confirm, do not raise as new bugs

Found by reading the code on 2026-08-17. Each has a case in `POS-GAP` so a
tester who trips over it recognises it instead of filing a duplicate.

1. **`pos:void` is dead.** Owner and manager hold it; `pos_adjustment_events`
   accepts `line_void` and `order_void`; `dashboard/analytics/financial`
   renders a Voids table. **Nothing writes a void anywhere in the codebase**,
   and the POS has no void UI. The permission and the report are both
   unreachable.
2. **Pairing-code entry is unreachable.** `pos.pair(code)` exists in
   `electron/preload.ts:82` and `electron/pos-main.ts:338`, and
   `/dashboard/settings/pos-devices` mints codes, but **no renderer screen
   calls it.** `README.md` documents "or enter a pairing code" — the UI does
   not offer the field. Only slug + email + password pairing works.
3. **There is no offline mode.** `apps/pos/electron/_offline/` (store, sync, db,
   api) is parked and imported by nothing. `tests/e2e/offline-payment.spec.ts`
   covers offline *payment methods* (bank transfer, cash on collection), not
   network loss. Pulling the network mid-sale is untested behaviour, not a
   supported path.

---

## POS-PAIR — Pairing the device

**Persona:** manager, standing at a new till · **Goal:** bind this machine to one branch
**Preconditions:** fresh POS install, no stored device token

The till is paired once by a staff member with a real ServeOS account, entering
the restaurant slug alongside their email and password. If the restaurant has
more than one active branch the server answers `branch_required` with the list,
and the app shows a one-time picker — the choice is baked into the device token,
so a till belongs to a branch permanently. The token is durable and survives
restarts; only a 401 from the server unpairs it.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| POS-PAIR-001 | Single-branch tenant pairs straight through | happy | P1 | MANUAL | 1. Launch the POS on a fresh install. 2. Enter slug `roma`, `manager@roma.com`, `manager1234`. 3. Submit. | No branch picker appears. The app advances to the cashier sign-in screen, headed with the branch name. |
| POS-PAIR-002 | Multi-branch tenant shows a one-time branch picker | happy | P1 | MANUAL | 1. Add a second active branch in the dashboard. 2. Pair a fresh POS with the same credentials. | A list of both branch names is shown under "Choose this device's branch." Picking one pairs the device to it and advances to cashier sign-in. |
| POS-PAIR-003 | Branch picker can be backed out of | edge | P2 | MANUAL | 1. Reach the branch picker as in POS-PAIR-002. 2. Press "← Back". | The credential form returns with no device paired and no error shown. |
| POS-PAIR-004 | Wrong credentials are refused without naming which field | negative | P1 | MANUAL | 1. Pair with slug `roma`, `manager@roma.com`, password `wrong`. | Error reads exactly `Wrong restaurant, email, or password`. The device stays unpaired. The message does not reveal whether the slug, the email or the password was the wrong one. |
| POS-PAIR-005 | A blank field is caught before the request | negative | P2 | MANUAL | 1. Leave the slug empty, fill email and password. 2. Submit. | Error reads `Enter your restaurant, email, and password.` No network request is made. |
| POS-PAIR-006 | A revoked device token returns the app to sign-in | edge | P1 | MANUAL | 1. Pair the device. 2. Delete the device row from `pos_devices` (or revoke it in the dashboard). 3. Perform any action in the POS. | The app reports `Device unpaired — please pair again`, clears the stored token, and returns to the pairing screen. It does not retry in a loop. |

---

## POS-CSH — Cashier sign-in and sign-out

**Persona:** cashier · **Goal:** identify the human behind the till
**Preconditions:** `POS-PAIR` complete

The device token says *which till*; the cashier session says *who*. They are
deliberately different lifetimes: the token is durable in the database, the
session lives 12 hours in the web server's process memory. That second detail is
worth testing on purpose — restarting `npm run dev` logs every cashier out
while leaving every device paired.

Every sign-in attempt is audited, including the failures, with the reason
recorded (`bad_credentials` or `not_a_cashier`).

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| POS-CSH-001 | Staff cashier signs in and reaches the tabs | happy | P1 | MANUAL | 1. On the cashier screen enter `staff@roma.com` / `staff1234`. 2. Submit. | Sign-in succeeds. The drawer prompt appears (POS-DRW), and past it the six tabs: Take order, Live orders, History, Parked, Drawer, Reports. |
| POS-CSH-002 | Wrong password is refused | negative | P1 | MANUAL | 1. Enter `staff@roma.com` with password `wrong`. | Error reads `Invalid cashier credentials`. An `auth.login_failed` audit row appears in `/dashboard/audit` with `reason: bad_credentials` and a null actor. |
| POS-CSH-003 | An account without `pos:sell` is refused with a distinct message | permission | P1 | MANUAL | 1. Create a user holding no POS permission (e.g. a platform-only or disabled account). 2. Attempt cashier sign-in. | Error reads `This account is not allowed to use the POS`. Audit records `reason: not_a_cashier`. The wording differs from POS-CSH-002 — a valid password with the wrong role must not read as a bad password. |
| POS-CSH-004 | Submit stays disabled until both fields are filled | edge | P2 | MANUAL | 1. Fill only the email. | The "Sign in" button is disabled. Filling the password enables it. |
| POS-CSH-005 | Sign-out ends the session but keeps the device paired | happy | P1 | MANUAL | 1. Sign in. 2. Use the header sign-out control. | The cashier sign-in screen returns, still headed with the branch name. Relaunching the app does **not** ask to pair again. |
| POS-CSH-006 | Restarting the web server logs the cashier out, not the device | edge | P2 | MANUAL | 1. Sign in as a cashier. 2. Restart `npm run dev`. 3. Perform any action in the POS. | The cashier is signed out (session lived in process memory). The device remains paired — no pairing screen. |

---

## POS-DRW — Opening and skipping the drawer

**Persona:** cashier · **Goal:** start a till session that can take cash
**Preconditions:** `POS-CSH` complete, no shift open on this device

The drawer is asked about once, after sign-in and before the tabs appear, and it
is **offered rather than forced**: card-only selling is legitimate without a
drawer, so "Skip — card sales only" is a supported choice, not a way round a
control. What makes the skip safe is the server, which refuses a cash tender
when no shift is open — so nothing can be taken in cash and left unaccounted.

The cashier may type a total, or count note by note. If they do both and the two
disagree, they are told before submitting rather than after. The opening count
is stored as the float itself: counted equals expected, variance zero.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| POS-DRW-001 | The prompt appears once, between sign-in and the tabs | happy | P1 | MANUAL | 1. Sign in as a cashier with no shift open. | "Open the drawer" is shown, headed with the branch name. The six tabs are not reachable behind it yet. |
| POS-DRW-002 | Opening with a typed float starts the shift | happy | P1 | MANUAL | 1. Enter float `500`. 2. Press "Open drawer". | The tabs appear. `/dashboard/audit` shows a `shift.open` event reading `Shift opened (float 500.00)`. The Drawer tab reports expected cash `500.00`. |
| POS-DRW-003 | A note-by-note count that agrees is accepted | happy | P2 | MANUAL | 1. Enter float `500`. 2. Press "Count it note by note". 3. Enter denominations summing to exactly 500 (e.g. 2×200, 1×100). 4. Open. | The shift opens. The stored opening count carries the denomination breakdown. |
| POS-DRW-004 | A count that disagrees with the typed float is blocked client-side | negative | P1 | MANUAL | 1. Enter float `500`. 2. Enter denominations summing to `450`. | `The notes counted do not add up to the float.` is shown and the submit does not reach the server. Correcting either side clears it. |
| POS-DRW-005 | An empty float cannot be submitted | negative | P2 | MANUAL | 1. Leave the float blank. | "Open drawer" is disabled. Typing a non-numeric value leaves it disabled. |
| POS-DRW-006 | Skipping gives a card-only till, flagged in the header | happy | P1 | MANUAL | 1. Press "Skip — card sales only". | The tabs appear with a `No drawer` badge in the header. The Payment screen shows "No drawer is open, so this till can only take card payments." with an "Open drawer" button. |

---

## POS-ORD — Taking an order

**Persona:** cashier · **Goal:** build the customer's basket
**Preconditions:** signed in; `roma` has a published menu

The Take-order tab is the menu on the left and the current order on the right.
Products are tapped in; a product with variants or modifiers opens a sheet first
so quantity and options are chosen before the line is added. Identical lines
merge rather than stacking: same product, same variant, same option set means
one line with a higher quantity. Dropping a quantity to zero removes the line
outright.

All money shown comes from the shared `computeCartTotals` — the till never does
its own arithmetic on a total.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| POS-ORD-001 | A simple product is added by tapping it | happy | P1 | MANUAL | 1. Tap a product with no variants or modifiers. | It appears in "Current order" at quantity 1. Subtotal and total update. |
| POS-ORD-002 | A product with options opens a sheet before adding | happy | P1 | MANUAL | 1. Tap a product that has variants or modifiers. | A sheet opens with the option choices and a quantity stepper. Nothing is added to the order until it is confirmed. |
| POS-ORD-003 | Identical lines merge instead of stacking | edge | P2 | MANUAL | 1. Add the same product twice with the same options. | One line at quantity 2 — not two lines at quantity 1. |
| POS-ORD-004 | Differing options produce separate lines | edge | P2 | MANUAL | 1. Add the same product twice with different option sets. | Two distinct lines, each quantity 1. |
| POS-ORD-005 | Decreasing quantity to zero removes the line | edge | P2 | MANUAL | 1. Add a product. 2. Press "Decrease" until quantity would reach 0. | The line is removed from the order. The total returns to zero if it was the only line. |
| POS-ORD-006 | Charge is blocked on an empty order | negative | P1 | MANUAL | 1. Clear the order. | The charge/pay control is disabled while the order has no lines. |

---

## POS-DSC — Discounts and reason codes

**Persona:** cashier without `pos:discount`, then manager · **Goal:** take money off, on the record
**Preconditions:** an order with at least two lines

Discounts exist at two levels — one line, or the whole order — and both demand a
reason code from a fixed list: `staff_meal`, `comp_service`, `promo`,
`manager_discretion`, `wrong_item`, `customer_changed_mind`, `other`. A cashier
who does not hold `pos:discount` can still apply one, but only with a manager
standing at the till (POS-MGR).

Every discount writes an append-only `pos_adjustment_events` row recording both
who applied it and who authorised it — and those are different people whenever a
grant was used. Authorisation is resolved **before** anything is written, so a
refused discount leaves no order behind.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| POS-DSC-001 | Manager applies a line discount with a reason | happy | P1 | MANUAL | 1. Sign in as `manager@roma.com`. 2. On a line, enter discount amount `10` and reason `promo`. 3. Complete the sale. | The line shows `Discount · Promo`. The total drops by 10. A `line_discount` event exists with `byUserId` = `authorizedByUserId` = the manager. |
| POS-DSC-002 | Manager applies an order-level discount | happy | P1 | MANUAL | 1. As manager, enter an order discount of `25` with reason `manager_discretion`. 2. Apply. | The Discount row appears in the totals block and the total drops by 25. An `order_discount` event is written. |
| POS-DSC-003 | Order discount cannot be applied with no amount entered | negative | P2 | MANUAL | 1. Leave the order-discount amount blank. | The apply control is disabled. |
| POS-DSC-004 | Staff cashier is asked for manager approval | permission | P1 | MANUAL | 1. Sign in as `staff@roma.com`. 2. Attempt any discount. | The "Manager approval needed" modal opens for `pos:discount`. No discount is applied until it is satisfied. |
| POS-DSC-005 | Grant records the manager as authoriser, the cashier as actor | permission | P1 | MANUAL | 1. As staff, discount a line. 2. Approve with `manager@roma.com` / `manager1234`. 3. Complete the sale. | The sale completes. The `line_discount` event has `byUserId` = staff and `authorizedByUserId` = manager — two different ids. |
| POS-DSC-006 | Cancelling the approval modal leaves no discount and no order | negative | P1 | MANUAL | 1. As staff, attempt a discount. 2. Cancel the modal. | No discount is applied. Completing the sale afterwards produces an undiscounted order, and no `pos_adjustment_events` row exists for it. |

---

## POS-MGR — Manager grants

**Persona:** cashier + manager together · **Goal:** authorise one action, once
**Preconditions:** signed in as `staff@roma.com`

A grant is a manager physically walking to the till: they type their own email
and password, the server checks both the password and that they actually hold
the permission, and hands back a token. That token is **single-use and expires
in two minutes**, and it is deleted before every failure path — so a token is
spent whether or not it matched. That last property is the one worth probing:
a token cannot be replayed even after a failed attempt.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| POS-MGR-001 | Manager approval unblocks the action | happy | P1 | MANUAL | 1. Trigger the modal (e.g. via POS-DSC-004). 2. Enter `manager@roma.com` / `manager1234`. | The modal closes and the original action proceeds. |
| POS-MGR-002 | A wrong manager password is refused | negative | P1 | MANUAL | 1. In the modal enter `manager@roma.com` with password `wrong`. | Error reads `Invalid cashier credentials`. The modal stays open. The action does not proceed. |
| POS-MGR-003 | A real user who lacks the permission is refused distinctly | permission | P1 | MANUAL | 1. In the modal enter `staff@roma.com` / `staff1234` (valid account, no `pos:discount`). | Error reads `This user cannot authorize that action` — a different message from a bad password. |
| POS-MGR-004 | Approve stays disabled until both fields are filled | edge | P2 | MANUAL | 1. Fill only the manager email. | "Approve" is disabled. |
| POS-MGR-005 | A grant expires after two minutes | edge | P2 | MANUAL | 1. Obtain a grant. 2. Wait more than 2 minutes before the action is submitted. | The action is refused with a missing-permission error, and the modal is offered again. |
| POS-MGR-006 | A grant cannot be used twice | negative | P1 | MANUAL | 1. Use a grant to complete one discounted sale. 2. Attempt a second discounted sale reusing the same session without re-approving. | The second action demands fresh manager approval. One approval never covers two actions. |

---

## POS-PARK — Parking and recalling tickets

**Persona:** cashier · **Goal:** hold a table's order and come back to it
**Preconditions:** an order with lines; signed in

Parked tickets are stored **server-side**, on purpose: till 2 can recall what
till 1 parked. Recall is destructive — the ticket is discarded as it is loaded,
so the same basket cannot be rung twice from one park. The label is free text
and defaults to `Ticket` when left blank.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| POS-PARK-001 | An order is parked under a label | happy | P1 | MANUAL | 1. Build an order. 2. Enter label `Table 4`. 3. Park it. | The current order clears. The Parked tab lists `Table 4` with a timestamp. |
| POS-PARK-002 | A blank label defaults to "Ticket" | edge | P2 | MANUAL | 1. Park an order leaving the label blank. | The Parked tab lists it as `Ticket`. |
| POS-PARK-003 | Recall restores the basket and consumes the ticket | happy | P1 | MANUAL | 1. Park an order. 2. Open Parked and press "Recall". | The lines and any order discount return to Take-order. The ticket no longer appears in Parked. |
| POS-PARK-004 | A ticket parked on one till is recallable on another | edge | P2 | MANUAL | 1. Park a ticket on till A. 2. Pair a second till B to the same branch and sign in. 3. Open Parked on B. | The ticket parked on A is listed on B and can be recalled there. |

---

## POS-TND — Tendering, split payments and change

**Persona:** cashier · **Goal:** take the money correctly
**Preconditions:** an order with a known total; drawer state per case

The payment screen tracks three numbers: amount due, paid so far, and remaining.
"Complete sale" unlocks only when remaining reaches zero, so a split payment is
just several tenders added until it does.

The asymmetry between cash and card is the heart of this journey. **Cash may be
over-tendered** — that is what change is — so handing over 100 against a 73 due
applies 73 and returns 27. **A card may not**: the amount applied is exactly the
amount due, and change on a non-cash tender is refused both in the UI and by the
server. Cash also needs an open drawer, checked in the UI before the customer
hands over notes and enforced again server-side.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| POS-TND-001 | Exact cash completes the sale | happy | P1 | MANUAL | 1. With a drawer open, ring a total of `73.00`. 2. Add a cash tender of `73.00`. 3. Complete. | Remaining reaches `0.00`, no change is shown, and the receipt renders. The order's `payment_status` is `paid`. |
| POS-TND-002 | Over-tendered cash returns change | happy | P1 | MANUAL | 1. Total `73.00`. 2. Add a cash tender of `100.00`. | "Change due" shows `27.00`. The stored tender records `amount 73.00`, `tendered_amount 100.00`, `change_amount 27.00`. |
| POS-TND-003 | Quick-cash chips offer exact then the next notes up | happy | P2 | MANUAL | 1. Total `73.00`, method cash. | Chips show `73.00` plus the next round notes at or above it from 5/10/20/50/100/200 — so `100.00` and `200.00`. Tapping one adds that tender. |
| POS-TND-004 | Split cash and card completes | happy | P1 | MANUAL | 1. Total `100.00`. 2. Add cash `40.00`. 3. Switch to card, add `60.00`. 4. Complete. | Remaining goes 100 → 60 → 0. Two `order_payments` rows exist, one per method. Status `paid`. |
| POS-TND-005 | A card tender may not exceed what is due | negative | P1 | MANUAL | 1. Total `50.00`. 2. Method card, enter `80.00`, add. | Error reads `Only cash can be over-tendered — a card must not exceed what is due`. No tender is added. |
| POS-TND-006 | Cash is refused with no drawer open | negative | P1 | MANUAL | 1. Skip the drawer (POS-DRW-006). 2. Ring a sale, method cash, add a tender. | Error reads `Open a drawer before taking cash`. No tender is added. The "Open drawer" button is offered instead. |
| POS-TND-007 | Card-only selling works with no drawer | happy | P1 | MANUAL | 1. With no drawer open, ring a sale and pay it in full by card. 2. Complete. | The sale completes. The `order_payments` row carries a null `shift_id`. |
| POS-TND-008 | Complete is blocked while anything remains | negative | P1 | MANUAL | 1. Total `100.00`. 2. Add a single tender of `40.00`. | "Complete sale" stays disabled and Remaining reads `60.00` in the destructive colour. |

---

## POS-IDEM — Retry safety

**Persona:** cashier on a flaky connection · **Goal:** never charge twice
**Preconditions:** a completed sale

Every sale carries a client-minted `clientOrderId`, unique per device in
`pos_order_receipts`. A retried submit returns the original sale rather than
creating a second one. The same discipline covers tenders
(`clientPaymentId`) and refunds (`clientRefundId`).

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| POS-IDEM-001 | Re-submitting a sale returns the original | edge | P1 | MANUAL | 1. Complete a sale and note its order number. 2. Replay the same `recordSale` payload (same `clientOrderId`) via the API. | The response carries the original order number and `idempotent: true`. No second order and no second tender exist. |
| POS-IDEM-002 | Re-adding a tender does not double-charge | edge | P1 | MANUAL | 1. Add a tender to a partially-paid sale. 2. Replay the same `clientPaymentId`. | Only one `order_payments` row exists. No second `payment.tender_added` audit row is appended. |
| POS-IDEM-003 | A distinct client id does create a second sale | edge | P2 | MANUAL | 1. Submit the same basket twice with two different `clientOrderId` values. | Two separate orders exist. Idempotency keys on the id, not on the contents — a genuine second round of the same drinks must still ring. |

---

## POS-QUE — Live orders

**Persona:** cashier · **Goal:** move today's orders through the kitchen
**Preconditions:** at least one online and one walk-in order exist

The Live-orders tab is the shared queue: POS sales and storefront/WhatsApp
orders side by side, badged `Walk-in` or `Online`. Each row offers exactly one
forward step and no way back — `pending → confirmed → preparing → ready →
completed`, with `out_for_delivery → completed` for delivery orders. The list
polls every 8 seconds.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| POS-QUE-001 | Both channels appear in one queue | happy | P1 | MANUAL | 1. Place a storefront order. 2. Ring a POS sale. 3. Open Live orders. | Both are listed. The storefront order is badged `Online`, the POS sale `Walk-in`. |
| POS-QUE-002 | The offered action matches the current status | happy | P1 | MANUAL | 1. Advance one order through every step. | Labels appear in order: Accept → Start preparing → Mark ready → Complete. After Complete no action button is offered. |
| POS-QUE-003 | A terminal order offers no action | edge | P2 | MANUAL | 1. Find or create a `cancelled` or `rejected` order. 2. View it in the queue. | The status label renders, and no advance button is shown. |
| POS-QUE-004 | The queue refreshes without interaction | edge | P2 | MANUAL | 1. Leave Live orders open. 2. Place a storefront order from a browser. 3. Wait up to ~10s. | The new order appears without touching the POS. |

---

## POS-HIS — Sales history

**Persona:** cashier or manager · **Goal:** find one sale again
**Preconditions:** several completed sales, at least one refunded

History searches by order number, customer phone, or cashier id, and the detail
pane shows the sale's items, its tenders, and any refunds already taken against
it. The number to read carefully is **net paid (still refundable)** — tenders
minus refunds already issued — because it is the ceiling every refund in
`POS-REF` is checked against.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| POS-HIS-001 | Search by order number finds the sale | happy | P1 | MANUAL | 1. Note a completed sale's order number. 2. Enter it in "Order number" and search. | The sale is listed. Selecting it shows items, payments and refunds. |
| POS-HIS-002 | Search by customer phone finds POS and online sales | happy | P2 | MANUAL | 1. Search the phone used on a storefront order. | Matching orders are listed. |
| POS-HIS-003 | A search with no matches says so | edge | P2 | MANUAL | 1. Search order number `99999999`. | `No sales found.` is shown. No error state, no empty table skeleton. |
| POS-HIS-004 | Net paid reflects refunds already issued | happy | P1 | MANUAL | 1. Open a sale of `100.00` that has one `30.00` refund. | "Net paid (still refundable)" reads `70.00`, and the Refunds block lists the 30.00 refund with its kind and reason. |

---

## POS-RCP — Receipts and reprints

**Persona:** cashier · **Goal:** hand the customer their receipt again
**Preconditions:** a completed sale

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| POS-RCP-001 | A receipt renders on sale completion | happy | P1 | MANUAL | 1. Complete a cash sale with change due. | The receipt shows the lines, any discounts, the tender method, the amount tendered and the change. |
| POS-RCP-002 | A past sale can be reprinted from History | happy | P1 | MANUAL | 1. In History, select a sale. 2. Press "Reprint". | The receipt renders with the same figures as the original. |
| POS-RCP-003 | A reprint failure is reported, not swallowed | negative | P2 | MANUAL | 1. Stop the web server. 2. Press "Reprint" on a selected sale. | `Could not reprint the receipt` is shown. The app stays usable. |

---

## POS-REF — Refunds

**Persona:** manager, and a staff cashier with a grant · **Goal:** return money without ever over-returning
**Preconditions:** a paid, completed sale of a known total; `pos:refund` per case

Refunds are the most heavily guarded path on the till, and the guards are worth
walking one at a time. A refund is `full` or `partial`. A **partial** refund must
be line-itemised and its line amounts must equal its refund payments to the
cent. A **full** refund may be headerless — goodwill, no lines — because the
net-paid ceiling bounds the money either way.

Two ceilings apply independently: money (cumulative refunds may never exceed
tenders minus prior refunds) and quantity (a line may not return more than was
sold, counting what earlier refunds already took). The original order is never
mutated — only the three refund tables, plus the order's *derived*
`payment_status`, which becomes `refunded` or `partially_refunded` from the
arithmetic rather than being set by hand.

Refund money can go out as `cash`, `card`, `store_credit` or `other`.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| POS-REF-001 | Manager takes a full refund | happy | P1 | MANUAL | 1. As manager, select a paid `100.00` sale. 2. Refund, kind `full`, one cash payment of `100.00`, reason `wrong_item`. | The refund is accepted. The order's `payment_status` becomes `refunded`. A `refund.issued` audit event reads `Refund 100.00 (full) — wrong_item`. |
| POS-REF-002 | Manager takes a line-itemised partial refund | happy | P1 | MANUAL | 1. On a `100.00` sale, refund one line worth `30.00`, kind `partial`, cash `30.00`. | Accepted. `payment_status` becomes `partially_refunded`. Net paid drops to `70.00`. |
| POS-REF-003 | A partial refund whose lines disagree with its payments is refused | negative | P1 | MANUAL | 1. Kind `partial`, line amounts totalling `30.00`, refund payment `40.00`. | Refused: `Refund line amounts must equal the refund payments`. Nothing is written. |
| POS-REF-004 | A partial refund with no lines is refused | negative | P1 | MANUAL | 1. Kind `partial`, no lines selected, one payment. | Refused: `A partial refund needs at least one line`. |
| POS-REF-005 | Cumulative refunds cannot exceed net paid | negative | P1 | MANUAL | 1. On a `100.00` sale already refunded `30.00`, attempt a further `80.00`. | Refused: `Refund exceeds the amount still refundable`. Net paid stays `70.00`. |
| POS-REF-006 | A line cannot return more than was sold | negative | P1 | MANUAL | 1. On a line sold at quantity 2, attempt a refund of quantity 3. | Refused: `Cannot return more than was sold`. Repeat after a quantity-1 refund: quantity 2 is now also refused. |
| POS-REF-007 | An unpaid order cannot be refunded | negative | P1 | MANUAL | 1. Find an order with `payment_status` `unpaid` or `pending_verification`. 2. Attempt a refund. | Refused: `An unpaid order has nothing to refund — void it instead`. |
| POS-REF-008 | A cancelled or rejected order cannot be refunded | negative | P1 | MANUAL | 1. Cancel an order. 2. Attempt a refund against it. | Refused: `A voided order has no settled money to refund`. |
| POS-REF-009 | Staff cashier refunds only with a manager grant | permission | P1 | MANUAL | 1. As `staff@roma.com`, attempt a refund. 2. Approve as manager. | The modal reads "Refund requires manager approval". After approval the refund lands with `byUserId` = staff and `authorizedByUserId` = manager. Cancelling instead leaves no refund. |
| POS-REF-010 | A replayed refund does not double-refund | edge | P1 | MANUAL | 1. Issue a refund. 2. Replay the same `clientRefundId`. | The original refund is returned with `idempotent: true`. Net paid moves once, not twice. |
| POS-REF-011 | A restocked line returns stock; an unrestocked one does not | edge | P2 | MANUAL | **Precondition:** the product has `trackStock` on — restock is gated twice, on the vertical's `stockTracking` capability and on the product's own flag. 1. Note the product's stock. 2. Refund one unit with `restock` on. 3. Refund another unit with `restock` off. | Stock rises by exactly 1 across both refunds. On a product with `trackStock` off, neither refund moves stock — that is correct, not a bug. |

---

## POS-CASH — Cash movements

**Persona:** cashier, escalating to manager · **Goal:** account for cash moving outside a sale
**Preconditions:** an open drawer

Four movement types, each with its own reason list: `pay_in` (float top-up,
change fund), `pay_out` (supplier, petty cash, refund cash), `safe_drop` (drop,
end of shift) and `no_sale` — a drawer opening that moves nothing but is still
recorded.

The cashier always types a **positive** amount; the server applies the sign, so
the stored value, the database CHECK and the expected-cash formula can never
disagree about direction. A `no_sale` is the exception and must be exactly zero.

Manager approval on a large pay-out is governed by `payoutThreshold`, and its
default of `0` **disables the check entirely** — the guard is
`payoutThreshold > 0`. Set the tenant's `shiftPolicy.payoutThreshold` before
running POS-CASH-006.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| POS-CASH-001 | A pay-in increases expected cash | happy | P1 | MANUAL | 1. Drawer at expected `500.00`. 2. Pay in `100.00`, reason `float_top_up`. | Expected cash becomes `600.00`. A `cash.movement` audit event records `pay_in 100.00`. |
| POS-CASH-002 | A pay-out decreases expected cash | happy | P1 | MANUAL | 1. Pay out `50.00`, reason `supplier`. | Expected cash falls by 50. The stored `amount` is **negative** though a positive number was typed. |
| POS-CASH-003 | A safe drop decreases expected cash | happy | P1 | MANUAL | 1. Safe drop `200.00`, reason `drop`. | Expected cash falls by 200 and the movement is recorded as `safe_drop`. |
| POS-CASH-004 | A no-sale records an opening and moves nothing | happy | P2 | MANUAL | 1. Record a no-sale with reason `drawer_check`. | Expected cash is unchanged. A `no_sale` movement of `0.00` is recorded. The amount field is not editable. |
| POS-CASH-005 | A zero or blank amount is refused on a real movement | negative | P2 | MANUAL | 1. Attempt a pay-in with the amount blank, then with `0`. | Blank leaves the submit disabled. Zero is refused with `A movement amount must be a positive magnitude`. |
| POS-CASH-006 | A pay-out above the threshold demands a manager | permission | P1 | MANUAL | 1. Set the tenant's `shiftPolicy.payoutThreshold` to `100`. 2. As staff, pay out `150.00`. | The manager modal opens for `reconciliation:manage`. After approval the movement lands with `authorizedByUserId` set. Cancelling shows `A manager must approve this amount` and records nothing. |
| POS-CASH-007 | No movement is possible without an open drawer | negative | P1 | MANUAL | 1. Skip the drawer at sign-in. 2. Attempt any cash movement. | Refused with `Open a shift before taking cash`. If a manager grant was in hand, it is **not** spent — the drawer is checked first. |

---

## POS-CNT — Mid-shift count

**Persona:** manager · **Goal:** verify the drawer without closing it
**Preconditions:** an open drawer with some trade on it

A mid-shift count records what is in the drawer against what should be, and
leaves the shift trading. It uses the same expected-cash figure the close will.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| POS-CNT-001 | A matching count records a zero variance | happy | P1 | MANUAL | 1. On the Drawer tab read expected cash. 2. Count that exact amount. | A `mid_shift` count is stored with variance `0.00`. The shift stays open and selling continues. |
| POS-CNT-002 | A short count records a negative variance and keeps trading | happy | P1 | MANUAL | 1. Count `50.00` less than expected. | A `count` audit event reads `Mid-shift count (variance -50.00)`. The shift remains open. |
| POS-CNT-003 | Counting a closed shift is refused | negative | P2 | MANUAL | 1. Close the drawer. 2. Attempt a mid-shift count on that shift. | Refused with `This shift is already closed`. |

---

## POS-XRP — X report

**Persona:** manager mid-shift · **Goal:** see where the till stands without disturbing it
**Preconditions:** an open shift with at least one cash and one card sale

The X report is a read. It computes the same expected cash the close will,
records no count, and never touches the shift — so reading it twice must give
the identical answer. That non-resetting property is the whole point and is what
POS-XRP-003 exists to prove.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| POS-XRP-001 | The report totals tenders by method | happy | P1 | MANUAL | 1. Ring one cash and one card sale. 2. Open Reports → X. | Cash and card each appear with their own total and count. Sales count matches the number of orders rung on this shift. |
| POS-XRP-002 | Expected cash follows the drawer formula | happy | P1 | MANUAL | 1. Open with float `500`. 2. Take `200` cash. 3. Pay out `50`. 4. Safe drop `100`. 5. Read the X report. | Expected cash reads `550.00` — float + cash tenders − pay-outs + pay-ins − safe drops. |
| POS-XRP-003 | Reading the X report twice changes nothing | edge | P1 | MANUAL | 1. Read the X report. 2. Read it again without trading. | Both readings are identical. No count is recorded and the shift stays open. |
| POS-XRP-004 | Discount totals are reported | happy | P2 | MANUAL | 1. Ring a sale with a `10.00` line discount. 2. Read the X report. | The discount total includes the 10.00. |

---

## POS-ZRP — Z report and closing the drawer

**Persona:** cashier closing their own drawer; manager closing someone else's · **Goal:** end the session on a counted, recorded figure
**Preconditions:** an open shift with trade on it

Closing counts the drawer and ends the shift. `expected` comes from the one
server-side formula, `variance = counted − expected` is **always persisted**
even under blind close, and the shift transition is guarded on
`status = 'open'` so two simultaneous closes cannot both produce a Z report.

Three policies shape what the cashier sees and may do. **Blind close**
(`blindClose`, default off) withholds expected and variance from a non-manager —
they count without being told the target, and the figures are still recorded.
**Variance threshold** (default `0`) flags any non-zero difference, because the
test is `|variance| > threshold`. And **closing a drawer you did not open**
requires `reconciliation:manage`, held or granted.

One subtlety worth a case of its own: a close that is *both* cross-user *and*
flagged resolves the manager only once, so a single grant covers both — it must
not be spent twice and fail halfway.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| POS-ZRP-001 | A balanced close reports zero variance | happy | P1 | MANUAL | 1. Read expected cash. 2. Close, counting exactly that. | "Drawer closed" shows Counted, Expected and `Variance 0.00 (balanced)`, plus sales count and per-method tenders. No flag is shown. |
| POS-ZRP-002 | A short drawer is flagged | happy | P1 | MANUAL | 1. Close counting `20.00` less than expected. | Variance reads `-20.00 (short)` in the destructive colour and `This drawer is flagged for review.` appears. A `shift.close` audit event records `flagged: true`. |
| POS-ZRP-003 | An over drawer is flagged too | happy | P2 | MANUAL | 1. Close counting `20.00` more than expected. | Variance reads `20.00 (over)` and the drawer is flagged — the threshold is absolute, not one-sided. |
| POS-ZRP-004 | Denominations must agree with the counted total | negative | P1 | MANUAL | 1. Enter counted `400`, note breakdown summing to `380`. | `The notes counted do not add up to the total.` is shown and nothing is submitted. |
| POS-ZRP-005 | Blind close hides the target from the cashier | permission | P1 | MANUAL | 1. Set the tenant's `shiftPolicy.blindClose` to `true`. 2. As `staff@roma.com`, close the drawer. | Counted is shown; Expected and Variance are **not**. The note reads "The count is recorded. A manager can see the expected total and variance." The variance is still persisted on the count row. |
| POS-ZRP-006 | A manager sees the figures even under blind close | permission | P1 | MANUAL | 1. With `blindClose` still `true`, close as `manager@roma.com`. | Expected and Variance are shown — the policy governs what a cashier is told, not what a manager may see. |
| POS-ZRP-007 | Closing another cashier's drawer needs approval | permission | P1 | MANUAL | 1. Open a drawer as staff A. 2. Sign in as staff B (no `reconciliation:manage`). 3. Attempt to close. | The manager modal opens reading "Approve closing this drawer". Cancelling shows `A manager must approve this close` and the shift stays open. |
| POS-ZRP-008 | One grant covers a close that is both cross-user and flagged | edge | P1 | MANUAL | 1. As staff B, close staff A's drawer with a deliberate variance. 2. Approve once as manager. | The close succeeds on that single approval. The Z report records both `closedByUserId` (staff B) and `approvedByUserId` (the manager). It does not ask for a second approval. |
| POS-ZRP-009 | A closed drawer cannot be closed again | negative | P1 | MANUAL | 1. Close the drawer. 2. Attempt to close the same shift again. | Refused with `This shift is already closed`. Only one closing count and one `shift.close` event exist. |
| POS-ZRP-010 | The Z tab reflects shift state before and after the close | happy | P2 | MANUAL | 1. With a shift open and uncounted, open Reports → Z. 2. Close the drawer. 3. Return to Z. | Before: pill reads `shift open` and the note says "Not counted yet — close the drawer…". After: pill reads `end of day`, counted cash and over/short are shown, and "Frozen at shift close" appears. |
| POS-ZRP-011 | With no shift on the till, Z says so | edge | P2 | MANUAL | 1. Skip the drawer at sign-in. 2. Open Reports → Z. | Pill reads `no shift` and the note reads "No shift on this till — open a drawer to tie a Z report to a shift." |

---

## POS-GAP — Confirming the known gaps

**Persona:** QA · **Goal:** verify the three gaps above are still gaps, and catch it if one silently closes
**Preconditions:** signed in as owner or manager (both hold `pos:void`)

These are not bug reports. They are assertions about current behaviour so the
pack notices when it changes. If any of them starts failing, that is good news
and the pack needs updating.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| POS-GAP-001 | No void is reachable from the POS | edge | P2 | MANUAL | 1. As owner (holds `pos:void`), search every POS tab and the order/payment screens for a void action. | No void control exists anywhere. Confirms the permission is unreachable. Raise a product question, not a bug: `pos:void` is granted but unimplemented. |
| POS-GAP-002 | The dashboard Voids table is always empty | edge | P2 | MANUAL | 1. Trade normally on the POS for a session. 2. Open `/dashboard/analytics/financial` and find the Voids table. | It is empty regardless of activity, because nothing writes `line_void` or `order_void`. The table is currently decorative. |
| POS-GAP-003 | A pairing code cannot be entered at the till | edge | P2 | MANUAL | 1. Mint a pairing code at `/dashboard/settings/pos-devices`. 2. On a fresh POS, look for a field to enter it. | The sign-in screen offers only restaurant, email and password. The code cannot be redeemed from the UI, contradicting `README.md`. |

---

## Coverage summary

| Journey | Cases | P1 | Automated |
|---|---|---|---|
| POS-PAIR pairing | 6 | 4 | 0 |
| POS-CSH cashier sign-in | 6 | 4 | 0 |
| POS-DRW drawer open/skip | 6 | 4 | 0 |
| POS-ORD taking an order | 6 | 3 | 0 |
| POS-DSC discounts | 6 | 5 | 0 |
| POS-MGR manager grants | 6 | 4 | 0 |
| POS-PARK park & recall | 4 | 2 | 0 |
| POS-TND tendering | 8 | 7 | 0 |
| POS-IDEM retry safety | 3 | 2 | 0 |
| POS-QUE live orders | 4 | 2 | 0 |
| POS-HIS sales history | 4 | 2 | 0 |
| POS-RCP receipts | 3 | 2 | 0 |
| POS-REF refunds | 11 | 10 | 0 |
| POS-CASH cash movements | 7 | 5 | 0 |
| POS-CNT mid-shift count | 3 | 2 | 0 |
| POS-XRP X report | 4 | 3 | 0 |
| POS-ZRP Z report & close | 11 | 8 | 0 |
| POS-GAP known gaps | 3 | 0 | 0 |
| **Total** | **101** | **69** | **0** |

101 cases against a design budget of ~85. The overrun is all in `POS-REF` and
`POS-ZRP`, where each guard is a separate way to lose money and collapsing two
into one case would leave a real hole. Per the design spec the room comes out of
the 420 total rather than being padded back elsewhere.

**Nothing on this surface is automated.** The Playwright suite never launches
Electron, and `apps/pos`'s own Vitest suite covers pure functions (cart, drawer
counting, payment split) rather than journeys. The 69 P1 cases here are the
strongest candidates for a future POS automation harness — `POS-TND`,
`POS-REF` and `POS-ZRP` first, since those are where money is decided.
