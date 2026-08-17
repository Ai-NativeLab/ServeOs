# QA — WhatsApp ordering channel

**Surface code:** `WA` · **Entry:** the tenant's own WhatsApp number → `/api/whatsapp/webhook`
**Persona:** WhatsApp customer — identified by `waId`, holds no account
**Last verified against code:** 2026-08-17

A customer messages the shop's WhatsApp number and completes an order inside the
chat, tap-driven, without ever opening a browser. Anything the chat cannot
configure is handed off to the storefront with the basket pre-loaded.

**No Meta test number is required.** `scripts/whatsapp-sandbox.ts` walks the same
reducer, the same runner, the same advisory lock and the same database writes —
the only substitution is a provider that prints messages instead of sending
them. A confirmed pickup order lands in `orders` on the `whatsapp` channel for
real. Every case in this file is executable from a terminal.

---

## How to run this file

```bash
npm run db:seed
npm run demo:seed                                  # gives you a pharmacy and a timber tenant
ENV_FILE=.env.test npx tsx scripts/whatsapp-sandbox.ts --slug roma
```

The tenant needs the `whatsapp` plan feature, which means **pro or above** —
`basic` has `whatsapp_numbers: 0` and `whatsapp: false`. Set the tenant's plan
before running `WA-GATE-004` onward, or every message is silently skipped.

For the real-transport cases (`WA-HOOK`), post crafted payloads at
`/api/whatsapp/webhook` directly with a computed signature.

### The conversation state machine

Ten states, from `whatsapp_conversation_state`:

```
idle → branch → categories → products → variant → cart → fulfillment → contact → confirm → placed
```

`placed` is terminal until the customer says "menu". The reducer is **pure and
total by construction**: every `(state, input)` pair returns a value and at least
one outbound message. A missing transition would throw inside the webhook
handler — and a non-2xx makes Meta retry the same message for up to 7 days, so
totality is an availability property, not tidiness.

### Two invariants worth understanding before testing

**Cart lines hold selection IDs only, never a price.** Prices are resolved fresh
at every render and again at confirm, so a chat left open overnight cannot quote
a number `placeOrder` would not charge. `WA-CART-004` tests this directly.

**Every interactive id is `<action>:<stateVersion>:<payload>`.** A tap on a
superseded message arrives as a brand-new `wamid`, so provider-message dedup
cannot catch it — the version is what makes it rejectable. `WA-STALE` is built
entirely on this.

---

## Known gap — Rx and dimensional products are listed but cannot be ordered

**Severity: P1. Found 2026-08-17 by reading `loadCatalogSlice` (`runner.ts:188`).**

`loadCatalogSlice` filters the catalogue on **`inStock` only**. It does not
filter or flag:

- products with `requiresPrescription` (pharmacy), or
- dimensional products with a `unitOfMeasure` (timber).

Both are therefore offered in chat and can be added to the basket. The failure
lands at `confirm`, where `placeOrder` throws:

| Product kind | Thrown by `placeOrder` | Why WhatsApp can never satisfy it |
|---|---|---|
| Rx | `prescription items require a signed-in customer account` | A WhatsApp order carries no `customerId` — linking `waId` to a customer account is an explicit non-goal of the customer-accounts design |
| Dimensional | `dimensions required for this product` | The chat has no way to capture a length; that is exactly why the design routes dimensional pricing to the storefront |

The consequence, traced through the code: effects run inside the turn's
transaction *before* the state write, so the throw **rolls the whole turn back** —
the conversation stays in `confirm` and no reply is sent. It escapes
`handleInbound` → `ingestWebhook` → the webhook route, which rethrows anything
that is not a signature error (`route.ts:26`), producing a **500**. Meta retries;
on retry `recordInbound` reports the message as already seen, so the turn is
skipped and the route returns 200. Net effect: **the customer sends "Confirm"
and receives absolute silence, forever.**

The retry storm is therefore bounded — but the conversation is permanently
stuck, which is worse from the customer's side than an error message.

The design intent was clearly the opposite. `loadCatalogSlice`'s own comment
reads: *"Out-of-stock products are dropped rather than shown and then rejected by
placeOrder at the last step."* That reasoning was applied to stock and not to the
other two exclusions. The WhatsApp design doc's D6 lists the handoff as covering
"delivery, required modifiers, **Rx**, and **dimensional pricing**" — only two of
those four are implemented.

`WA-GAP` reproduces both. **File these as bugs**, not as documented behaviour —
unlike the POS gaps, this one is reachable by a real customer of a real pharmacy.

---

## WA-HOOK — Webhook transport and signature

**Goal:** only Meta can drive a conversation, and no failure causes a retry storm

The HMAC is computed over the **raw request body** — `req.text()`, never
`req.json()` re-stringified, because the bytes Meta signed must be the bytes
verified. `verifyWebhookSignature` fails closed on every abnormal input and
never throws: `timingSafeEqual` raises on unequal buffer lengths, and an uncaught
raise would turn "verify" into "crash", which a caller could mistake for a
transport error and retry.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| WA-HOOK-001 | The subscription handshake succeeds with the right token | happy | P1 | MANUAL | 1. GET `/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=<WHATSAPP_VERIFY_TOKEN>&hub.challenge=abc123`. | 200 with body `abc123`. |
| WA-HOOK-002 | The handshake is refused with a wrong token | negative | P1 | MANUAL | 1. Repeat WA-HOOK-001 with `hub.verify_token=wrong`. | 403 `forbidden`. The challenge is not echoed. |
| WA-HOOK-003 | A valid signature is accepted | happy | P1 | MANUAL | 1. POST a valid message payload with `X-Hub-Signature-256: sha256=<hmac of raw body with the app secret>`. | 200 `{"ok":true}`. The message is processed. |
| WA-HOOK-004 | An invalid or absent signature is refused | negative | P1 | MANUAL | 1. POST the same payload with no signature header. 2. Repeat with `sha256=` + 64 wrong hex chars. 3. Repeat with a malformed header (`abc`, wrong length, non-hex). | All return 403. None throws a 500, and no conversation state changes in any case. |
| WA-HOOK-005 | An oversized body is rejected before parsing | negative | P2 | MANUAL | 1. POST a body larger than 1,000,000 bytes. | 413 `payload too large`. The signature is never computed over it. |
| WA-HOOK-006 | Unparseable JSON is absorbed, not retried | edge | P1 | MANUAL | 1. POST a correctly-signed body that is not valid JSON. | 200 — the payload is skipped silently. A non-2xx here would make Meta retry garbage for 7 days. |

---

## WA-GATE — Who may use the channel

**Goal:** three independent gates before any message is acted on
**Preconditions:** a tenant with a registered WhatsApp account row

Every inbound message passes three checks in order, and each one **skips
silently** rather than replying — a skipped message must not tell a stranger
anything about the tenant.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| WA-GATE-001 | An unknown phone number id is skipped | negative | P1 | MANUAL | 1. POST a signed payload whose `phoneNumberId` matches no `whatsapp_accounts` row. | 200, nothing processed, no outbound message. No conversation row is created. |
| WA-GATE-002 | A suspended tenant's channel goes quiet | permission | P1 | MANUAL | 1. Suspend the tenant (`ADM-SUSP`). 2. Send a message. | Skipped — `isTenantServable` fails. The customer receives no reply. Reactivating restores the channel. |
| WA-GATE-003 | A rejected tenant's channel is dead | permission | P1 | MANUAL | 1. Set the tenant to `rejected`. 2. Send a message. | Skipped, no reply. |
| WA-GATE-004 | A basic-plan tenant cannot use the channel | permission | P1 | MANUAL | 1. Put the tenant on `basic` (`whatsapp: false`). 2. Send a message. | Skipped — `hasFeature(tenantId, "whatsapp")` is false. No reply, and no error. |
| WA-GATE-005 | Upgrading to pro opens the channel | happy | P1 | MANUAL | 1. Move the tenant to `pro`. 2. Send "menu". | The greeting arrives. The same message that was skipped on basic now works. |
| WA-GATE-006 | A duplicate delivery is processed once | edge | P1 | MANUAL | 1. POST the same signed message payload twice (same `wamid`). | The first is accepted, the second skipped. Exactly one set of outbound messages and one state advance — `recordInbound` dedups on the provider message id. |

---

## WA-START — Getting in, and getting out

**Goal:** the customer can always start over, quit, or reach a human

Three word sets are honoured in **English and Arabic** at any state:

| Set | Words | Effect |
|---|---|---|
| Cancel | `cancel`, `stop`, `الغاء`, `إلغاء` | Clears the basket, returns to `idle` |
| Restart | `menu`, `start`, `hi`, `hello`, `القائمة`, `ابدأ` | Clears the basket and offers a "Start an order" button |
| Human | `human`, `agent`, `موظف`, `بشري` | Points at the shop's phone number, keeps state |

Restart deliberately replies with a **button**, not text. An earlier text-only
reply told the customer to send "menu" — which is itself a restart word — and
looped forever. That regression is `WA-START-003`.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| WA-START-001 | A greeting offers the way in | happy | P1 | MANUAL | 1. From a fresh number send `hi`. | Reply reads "Welcome! Ready to order?" with a single "Start an order" button. |
| WA-START-002 | Restart words work mid-order | happy | P1 | MANUAL | 1. Build a basket, reach `cart`. 2. Send `menu`. | The basket is cleared, state returns to `idle`, and the "Start an order" button is offered. |
| WA-START-003 | Restart never loops | negative | P1 | MANUAL | 1. Send `menu`. 2. Send `menu` again. 3. Repeat a third time. | Each reply contains a tappable button. At no point does the reply merely instruct the customer to send "menu" — that would be an infinite loop. |
| WA-START-004 | Cancel clears the basket | happy | P1 | MANUAL | 1. Add items. 2. Send `cancel`. | Reply: "No problem — I've cleared that. Say \"menu\" whenever you'd like to order." The stored cart is empty and state is `idle`. |
| WA-START-005 | The Arabic words work identically | i18n | P1 | MANUAL | 1. Send `القائمة` to restart, `إلغاء` to cancel, `موظف` for a human, each from a mid-order state. | Each behaves exactly as its English counterpart. |
| WA-START-006 | Asking for a human keeps the basket | edge | P2 | MANUAL | 1. Build a basket. 2. Send `human`. 3. Send `menu`. | The human reply points at the shop's number. State is unchanged by the human request — the basket is only cleared by the subsequent restart. |

---

## WA-BROWSE — Branch, categories, products and variants

**Goal:** find and configure an item using taps only
**Preconditions:** a tenant with a published catalogue; run on `roma` first

Only in-stock products and in-stock variants are listed — out-of-stock items are
dropped rather than shown and then refused at the last step. Meta's interactive
lists cap at **10 rows total across all sections**; sections group rows visually
and do not add capacity, so a catalogue with more than 10 categories or products
per step must paginate.

A product with **required modifiers** cannot be configured in chat and hands off
to the storefront instead.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| WA-BROWSE-001 | A multi-branch tenant asks which branch | happy | P1 | MANUAL | 1. On a tenant with two active branches, tap "Start an order". | A branch list is offered. Choosing one advances to categories and stores `branchId` on the conversation. |
| WA-BROWSE-002 | Categories then products are listed | happy | P1 | MANUAL | 1. Choose a branch. 2. Choose a category. | Categories list first; picking one lists that category's in-stock products with prices. |
| WA-BROWSE-003 | A simple product goes straight to the basket | happy | P1 | MANUAL | 1. Tap a product with no variants and no required modifiers. | It is added and the basket summary is shown with "Add more" and "Checkout" buttons. |
| WA-BROWSE-004 | A product with variants asks which one | happy | P1 | MANUAL | 1. Tap a product that has variants. | State becomes `variant` and the in-stock variants are listed with their own prices. Choosing one adds that variant. |
| WA-BROWSE-005 | Out-of-stock items are never offered | edge | P1 | MANUAL | 1. Set a product out of stock, and one variant of another product out of stock. 2. Browse to both. | Neither the product nor that variant appears in any list. The customer cannot tap something that would be refused later. |
| WA-BROWSE-006 | A product needing modifiers hands off instead | happy | P1 | MANUAL | 1. Tap a product with a required modifier group. | Reply says the item "needs a few choices — I'll send you a link with your basket ready", followed by a storefront handoff link. The item is **not** added to the chat basket. |
| WA-BROWSE-007 | More than 10 options paginate | edge | P2 | MANUAL | 1. On a tenant with more than 10 categories (or more than 10 products in one category), browse that step. | The list never exceeds 10 rows, and the remaining items are reachable — via a "More" row or equivalent. If items are silently truncated and unreachable, that is a **defect**. |
| WA-BROWSE-008 | An item that vanished mid-conversation is handled | edge | P2 | MANUAL | 1. Reach a product list. 2. Unpublish that product in the dashboard. 3. Tap it. | Reply reads "That item is no longer available." and the conversation stays usable — no crash, no silence. |

---

## WA-CART — Reviewing the basket

**Goal:** the basket is accurate and repriced live

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| WA-CART-001 | The basket lists what was added | happy | P1 | MANUAL | 1. Add two different items. | The summary names both. "Add more" and "Checkout" buttons are offered. |
| WA-CART-002 | "Add more" returns to browsing | happy | P1 | MANUAL | 1. From the basket tap "Add more". | Categories are offered again. The existing basket is preserved — the new item is added to it, not instead of it. |
| WA-CART-003 | "Checkout" advances to fulfillment | happy | P1 | MANUAL | 1. Tap "Checkout". | State becomes `fulfillment` and pickup/delivery is asked. |
| WA-CART-004 | A price change is picked up before charging | edge | P1 | MANUAL | 1. Add an item at price X. 2. In the dashboard change that product's price to Y. 3. Complete the order. | The confirmed order charges **Y**, not X. Cart lines store selection ids only; prices resolve fresh at render and again at confirm. A chat left open overnight can never quote a stale number. |
| WA-CART-005 | An empty basket cannot be confirmed | negative | P1 | MANUAL | 1. Reach `confirm` with an empty basket (e.g. cancel items then force the state). | Reply: "Your basket is empty." No order is created. |

---

## WA-FUL — Pickup or delivery

**Goal:** pickup finishes in chat; delivery finishes on the storefront

Delivery hands off deliberately. `placeOrder` hard-requires
`deliveryAddressText`, and a 10-row list cannot produce an Egyptian
landmark-based address — nor would a location pin give the building and floor
detail the schema stores. Rather than smuggle a free-text exception into a
tap-only design, delivery goes to the storefront, which already solves address
capture, delivery-area validation and minimum-order checks.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| WA-FUL-001 | Pickup continues in the chat | happy | P1 | MANUAL | 1. At fulfillment tap Pickup. | State becomes `contact` and the name question is asked. No handoff link. |
| WA-FUL-002 | Delivery hands off with the basket | happy | P1 | MANUAL | 1. At fulfillment tap Delivery. | Reply explains a link is coming with the basket ready, followed by a storefront handoff URL. The chat does **not** ask for an address. |
| WA-FUL-003 | A stray text at fulfillment re-prompts | edge | P2 | MANUAL | 1. At fulfillment send free text (not a control word). | Reply: "Pickup or delivery?" State is unchanged. |

---

## WA-CONF — Name, confirm, and place

**Goal:** the order lands with a real name on it
**Preconditions:** a pickup basket at the `contact` step

The name field is **the one bounded free-text input** in the whole flow: stored
verbatim, never parsed, truncated at 120 characters. The customer can accept
their WhatsApp profile name with one tap or type a different one.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| WA-CONF-001 | The profile name is offered as a one-tap option | happy | P1 | MANUAL | 1. Reach `contact` with a profile name available. | Two buttons: "Use \<profile name\>" and "Type a name". Tapping the first advances to `confirm` with that name on the order. |
| WA-CONF-002 | A typed name is stored verbatim | happy | P1 | MANUAL | 1. Tap "Type a name". 2. Send `Ahmed – table by window`. | The summary shows the name exactly as sent, punctuation intact. It is not parsed or split. |
| WA-CONF-003 | An over-long name is truncated, not rejected | edge | P2 | MANUAL | 1. Send a 200-character name. | It is accepted and truncated to 120 characters. The conversation continues. |
| WA-CONF-004 | An empty name re-prompts | negative | P2 | MANUAL | 1. Send only whitespace as the name. | Reply: "Please send a name for the order." State stays `contact`. |
| WA-CONF-005 | Confirming places a real order | happy | P1 | MANUAL | 1. At `confirm` tap Confirm. | An order exists in `orders` on the `whatsapp` channel, pickup, with the given name and the live prices. State becomes `placed` and the basket is cleared. |
| WA-CONF-006 | Declining returns to the basket | happy | P2 | MANUAL | 1. At `confirm` tap the decline option. | State returns to `cart` with the basket intact. No order is created. |
| WA-CONF-007 | The order appears on the other surfaces | happy | P1 | MANUAL | 1. Place a WhatsApp order. 2. Check `/dashboard/orders` and the POS Live-orders tab. | It appears in both, badged as an online/WhatsApp order, and can be advanced through the status flow like any other. |
| WA-CONF-008 | A placed conversation is terminal until restart | edge | P2 | MANUAL | 1. After placing, send free text. | Reply: "Your last order is on its way. Say \"menu\" to start a new one." No second order is created. |

---

## WA-REORDER — Reordering the last basket

**Goal:** a returning customer repeats their usual in one tap
**Preconditions:** this `waId` has one completed WhatsApp order

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| WA-REORDER-001 | A returning number is offered its last basket | happy | P1 | MANUAL | 1. Place an order, then send `menu` and start again. | The idle step offers a reorder option alongside starting fresh. |
| WA-REORDER-002 | Reorder loads the previous lines | happy | P1 | MANUAL | 1. Tap reorder. | The basket is populated with the previous order's lines and the basket summary is shown. |
| WA-REORDER-003 | Reorder reprices at today's prices | edge | P1 | MANUAL | 1. Change a product's price after the first order. 2. Reorder. | The new basket shows and charges today's price, not the price of the original order. |
| WA-REORDER-004 | A first-time number is not offered reorder | edge | P2 | MANUAL | 1. From a number with no prior order, send `hi`. | Only "Start an order" is offered — no reorder option. |

---

## WA-HANDOFF — The storefront handoff token

**Goal:** the basket crosses to the browser exactly once, and only for its own tenant

The token is signed, **single-use**, expires after **60 minutes**, and is scoped
by RLS to the minting tenant — a token minted for one shop cannot seed a basket
at another. Redemption stamps `redeemedAt`, and the query requires that to still
be null.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| WA-HANDOFF-001 | The link opens the storefront with the basket loaded | happy | P1 | MANUAL | 1. Trigger a handoff (delivery, or a required-modifier product). 2. Open the link. | The tenant's storefront opens with the chat's items already in the cart, ready for checkout. |
| WA-HANDOFF-002 | The token is single-use | negative | P1 | MANUAL | 1. Open the handoff link. 2. Open the same link again in a clean session. | The second attempt does not seed a basket. The storefront loads normally with an empty cart rather than erroring. |
| WA-HANDOFF-003 | An expired token does not seed | negative | P1 | MANUAL | 1. Mint a handoff. 2. Age it past 60 minutes (or set `expiresAt` into the past). 3. Open the link. | No basket is seeded. The storefront still loads. |
| WA-HANDOFF-004 | A token cannot cross tenants | permission | P1 | MANUAL | 1. Mint a handoff on `demo-retail`. 2. Use that token on `demo-restaurant`'s storefront host. | Nothing is seeded. RLS scopes redemption to the minting tenant. |
| WA-HANDOFF-005 | A forged token is refused | negative | P1 | MANUAL | 1. Open the storefront with `?handoff=` and an invented token value. | No basket is seeded and no error page is shown. |
| WA-HANDOFF-006 | Delivery can be completed after the handoff | happy | P1 | MANUAL | 1. Hand off from delivery. 2. On the storefront add an address and complete checkout. | The order is created with the delivery address, and delivery-area and minimum-order rules apply as they do for any storefront order (`SF-CHK`). |

---

## WA-STALE — Stale taps and concurrency

**Goal:** a tap on an old message never acts on it

Every interactive id embeds the `stateVersion` it was rendered at. The whole
read-reduce-write cycle is serialised on an advisory lock keyed on
`tenantId:waId`, and the state write carries an optimistic
`WHERE state_version = <read value>` guard. The conversation lock is always taken
**before** `placeOrder` acquires the tenant lock, never the reverse — a
deliberate ordering to avoid deadlock.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| WA-STALE-001 | A tap on a superseded message is rejected | negative | P1 | MANUAL | 1. Reach a product list. 2. Send `menu` to advance the state. 3. Scroll up and tap an option from the **old** product list. | Reply: "That option has expired — here's the current step again." The old option is not acted on. |
| WA-STALE-002 | The current step is re-offered, not just refused | happy | P1 | MANUAL | 1. After WA-STALE-001. | The reply includes the current step's tappable options, so the customer is not stranded. |
| WA-STALE-003 | A malformed reply id is rejected safely | negative | P1 | MANUAL | 1. POST an interactive reply with `replyId` of `garbage`, then `a:b:c`, then an empty string. | Each is treated as expired and re-prompted. None throws, and none advances state. |
| WA-STALE-004 | Two messages arriving together do not corrupt state | edge | P1 | MANUAL | 1. Send two different taps for the same `waId` as near-simultaneously as possible. | Exactly one is applied; the other is either rejected as expired or applied after it, and the final state is coherent. The basket contains no duplicate or lost line. |

---

## WA-STATUS — Outbound status updates

**Goal:** delivery receipts are recorded, and never disturb the conversation

Status callbacks stamp the delivery state onto the logged outbound message.
They **never** touch conversation state — a `read` receipt must not advance an
order.

| ID | Title | Type | Pri | Auto | Steps | Expected |
|----|-------|------|-----|------|-------|----------|
| WA-STATUS-001 | A delivery status is recorded on the message | happy | P2 | MANUAL | 1. POST a signed status callback (`sent`/`delivered`/`read`) for a known outbound message id. | The `whatsapp_messages` row's `deliveryStatus` is updated. |
| WA-STATUS-002 | A status callback never advances the conversation | edge | P1 | MANUAL | 1. Note the conversation's state and `stateVersion`. 2. POST a `read` status callback. 3. Re-check. | Both are unchanged. No outbound message is sent in response. |
| WA-STATUS-003 | A status for an unknown message is ignored | edge | P2 | MANUAL | 1. POST a status callback for a `providerMessageId` that does not exist. | 200, nothing updated, no error. |
| WA-STATUS-004 | Order-status notifications reach the customer | happy | P2 | MANUAL | 1. Place a WhatsApp order. 2. Advance it to preparing, then ready, from the dashboard or POS. | The customer receives the corresponding status messages, in the vertical's own wording (e.g. retail says "Being packed" / "Ready for collection"). |

---

## WA-GAP — Reproducing the Rx and dimensional defect

**Goal:** demonstrate the P1 gap above so it can be fixed and regression-tested
**Preconditions:** `demo-pharmacy` and `demo-timber` on a `pro`-or-above plan with WhatsApp enabled

These four cases are expected to **FAIL** against current code. They are written
as the desired behaviour, so they become the regression test once the gap is
closed. Do not mark them as passed by reinterpreting them.

| ID | Title | Type | Pri | Auto | Steps | Expected (desired — currently fails) |
|----|-------|------|-----|------|-------|----------|
| WA-GAP-001 | An Rx product is not offered in chat | negative | P1 | MANUAL | 1. On `demo-pharmacy`, browse to a category containing a `requiresPrescription` product. | **Desired:** the Rx product is either absent from the list, or handed off to the storefront on tap. **Actual:** it is listed and addable. |
| WA-GAP-002 | Confirming an Rx basket does not strand the customer | negative | P1 | MANUAL | 1. Add an Rx product. 2. Reach `confirm` and tap Confirm. | **Desired:** a clear reply, or a handoff link. **Actual:** `placeOrder` throws `prescription items require a signed-in customer account`, the turn rolls back, the route 500s, and the customer receives **nothing** — permanently. |
| WA-GAP-003 | A dimensional product is not offered in chat | negative | P1 | MANUAL | 1. On `demo-timber`, browse to a product priced per metre. | **Desired:** absent, or handed off on tap. **Actual:** listed and addable with no way to give a length. |
| WA-GAP-004 | Confirming a dimensional basket does not strand the customer | negative | P1 | MANUAL | 1. Add a per-metre product. 2. Confirm. | **Desired:** a reply or a handoff. **Actual:** `placeOrder` throws `dimensions required for this product` with the same silent-stranding outcome as WA-GAP-002. |

---

## Coverage summary

| Journey | Cases | P1 | Automated |
|---|---|---|---|
| WA-HOOK transport & signature | 6 | 5 | 0 |
| WA-GATE access gates | 6 | 6 | 0 |
| WA-START start, cancel, human | 6 | 5 | 0 |
| WA-BROWSE browse & variants | 8 | 6 | 0 |
| WA-CART the basket | 5 | 5 | 0 |
| WA-FUL pickup or delivery | 3 | 2 | 0 |
| WA-CONF name, confirm, place | 8 | 4 | 0 |
| WA-REORDER reordering | 4 | 3 | 0 |
| WA-HANDOFF handoff token | 6 | 6 | 0 |
| WA-STALE stale taps | 4 | 4 | 0 |
| WA-STATUS status callbacks | 4 | 1 | 0 |
| WA-GAP the Rx/dimensional defect | 4 | 4 | 0 |
| **Total** | **64** | **51** | **0** |

64 cases against a budget of 40. WhatsApp turned out to be the second-largest
surface in the product — a 10-state machine, three access gates, a signed
webhook, a single-use cross-surface token and an optimistic-concurrency
guard — and it is the **only** surface with zero automated coverage despite
37 modules and its own unit tests.

**Nothing here is automated end to end.** The unit tests under
`src/server/whatsapp/` cover the reducer, the signature and the status queue in
isolation, but no test drives a conversation. `scripts/whatsapp-sandbox.ts` is
most of an automation harness already — it drives the real reducer, runner, lock
and writes — so `WA-START`, `WA-BROWSE`, `WA-CART` and `WA-CONF` are the cheapest
automation wins anywhere in this pack.

Priority once the pack is executed: **fix `WA-GAP` first.** It is the only
finding in the whole pack that silently and permanently breaks a real customer's
order.
