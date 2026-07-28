# WhatsApp Ordering — Design Spec

**Date:** 2026-07-28
**Status:** Approved (design)
**Author:** Claude Opus 5 (with Mohaned)
**Depends on:** `feat/pos-core-ops` (Spec 4 audit — merged into that stack via PR #24, *not* on `main`)

## 1. Goal

Turn WhatsApp from a `wa.me` deep link into a real ordering channel: a customer messages the
merchant's own WhatsApp number and completes an order inside the chat, tap-driven, in English or
Arabic. The order lands in the same dashboard and POS as every other order.

The marketing site already advertises this as shipped (`src/app/_components/marketing/verticals.ts`,
both `en` and `ar` restaurant copy). It is not. That claim must carry `roadmap: true` until §11's
Phase 2 ships.

## 2. Current state

- `src/lib/whatsapp.ts` builds a `wa.me/<number>?text=<prefilled summary>` link. The customer
  taps it and manually sends a message. That is the entire feature.
- `tenantSettings.whatsappNumber` (`src/server/tenancy/settings.ts:36`, E.164-validated) backs a
  settings page and is rendered on the storefront footer and the order-tracking page.
- `PlanFeatures.whatsapp`, `PlanLimits.whatsapp_numbers` and `PlanLimits.messages_per_month`
  already exist and are seeded across Basic/Pro/Enterprise — **dormant**, no `requireFeature`
  call anywhere. They were reserved for this.
- `verticals/registry.ts` sets `storefront.showWhatsapp: true` for restaurant only.
- No Cloud API, no webhook, no conversation state, no outbound messaging anywhere.

## 3. Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Ordering model | **Conversational bot.** The customer completes the order in chat. |
| D2 | Number | **Tenant brings their own,** onboarded via Meta Embedded Signup, **Coexistence by default** so the merchant keeps the WhatsApp Business app and 180 days of history. |
| D3 | API | **Cloud API direct** behind a `WhatsAppProvider` interface. ServeOS registers as a Meta Tech Provider. No BSP. |
| D4 | Scope | **All four verticals.** Simple items **plus a variant-picker state**, plus "reorder my last". Requires flipping `showWhatsapp` for retail/pharmacy/timber. |
| D5 | Input | **Taps only** — Meta interactive lists and reply buttons. No NLU, no LLM, no intent parsing. **Pickup-only in chat**; delivery routes to the storefront (see D6). Customer name is prefilled from the WhatsApp profile with a confirm/change tap. |
| D6 | Fallback | **Signed cart-handoff token** → storefront with the cart pre-loaded, for delivery, required modifiers, Rx, and dimensional pricing. |
| D7 | Outbound | **Split.** Conversational replies go straight to the Cloud API. Broadcast/status notifications wait for Spec 5 and are **out of scope for v1**. |
| D8 | Payment | **Cash on collection only.** |

### Why pickup-only (D5)

`placeOrder` hard-requires `customerName` (`src/server/ordering/service.ts:65`) and, for delivery,
`deliveryAddressText` (`:204`). A 10-row list cannot produce an Egyptian landmark-based address,
and a location pin does not give the building/floor detail the schema stores. Rather than smuggle
a free-text exception into a tap-only design, delivery hands off to the storefront, which already
solves address capture, delivery-area validation and minimum-order checks properly.

## 4. Verified platform facts

Confirmed against Meta documentation, July 2026:

- Service conversations are free (since 2024-11-01). Any **non-template reply within 24h of the
  customer's last inbound message is free**. Utility templates replying inside an open window are
  free (since 2025-07-01). Pricing is per-message, not per-conversation (since 2025-07-01).
  Conversational ordering is customer-initiated, so **the entire v1 flow costs nothing in message fees.**
- **Interactive lists cap at 10 rows total across all sections** — sections group rows visually,
  they do not add capacity. Row title ≤24 chars, row description ≤72, section title ≤24.
  Reply buttons: max 3, ≤20 chars each, labels must be unique.
- **Tech Provider onboarding is capped at 10 new business customers per rolling 7 days,** rising to
  200/week only after **all three** of Business Verification, App Review and Access Verification.
  Beyond 200/week requires Meta Business Partner status.
- Messaging limits and quality rating are scoped per business portfolio. Because D2 gives each
  tenant their own WABA, **one tenant's quality problems do not throttle another's number.**
- Interactive messages are session-only: they cannot be sent once the 24h window has closed.
- Webhooks are **at-least-once, retried for up to 7 days**, and a single POST may batch multiple
  `entry[]`/`changes[]` items — including items for **different tenants**.
- Coexistence constraints: chat sync covers 180 days, is **one-time and non-repeatable**, caps
  throughput at **20 messages/second**, requires WhatsApp Business App **≥2.24.17**, and unlinks
  companion devices during onboarding.

**Time-boxed risk:** Embedded Signup v2/v3 are reported to deprecate **2026-10-15**, with
deprecated feature types (explicitly including `coexistence`) falling back to the standard flow.
Build against **v4** and re-confirm this date against Meta's changelog before Phase 1 starts.

## 5. Architecture

New domain at `src/server/whatsapp/`. **No `index.ts` barrel** — callers import modules directly,
matching `src/server/pos/` and `src/server/audit/`, the closest structural siblings.

`WhatsAppProvider` interface (`send`, `parseWebhook`, `verifySignature`, `fetchMedia`), with
`CloudApiProvider` the only implementation and a `FakeWhatsAppProvider` for tests — the
`ManualBillingProvider` precedent.

**Orders go through the existing `placeOrder`.** Money math stays in `src/lib/order-totals.ts`.
This requires one schema change the channel does not currently permit: `order_channel` is
`("web","pos")` and must gain `'whatsapp'`, or WhatsApp orders masquerade as web and corrupt the
by-channel reporting Spec 10 depends on.

### 5.1 Request path

```
POST /api/whatsapp/webhook
  └─ verify X-Hub-Signature-256 over the RAW body        ← fail closed, before anything else
  └─ branch on payload shape:
       statuses[] → update whatsapp_messages delivery state, return. Never touches conversations.
       errors[]   → log/alert, return.
       messages[] → continue
  └─ FOR EACH entry/change (a batch may span tenants):
       └─ resolve tenant from value.metadata.phone_number_id  (control-plane, no RLS)
       └─ isTenantServable(tenant)?          ← else silent drop
       └─ requireFeature(tenantId, "whatsapp")
       └─ withTenant(tenantId, tx =>
            pg_advisory_xact_lock(hashtext(tenantId || ':' || waId))   ← conversation lock
            dedup on providerMessageId → already seen? return
            load conversation + fetch fresh catalog slice
            reducer(state, cart, inbound, catalog, branch) → {nextState, nextCart, outbound, effects}
            guarded UPDATE ... WHERE id = ? AND state = <state read at start>
            run effects, then send outbound
          )
```

**Lock ordering is load-bearing.** The conversation lock is keyed on `tenantId:waId`, deliberately
*not* on `tenantId` — that key is already taken by `placeOrder`'s order-number lock and the audit
chain append (`src/server/audit/service.ts:52`). Every path must take the conversation lock
**before** invoking `placeOrder` (which takes `hashtext(tenantId)`), never the reverse.

### 5.2 Tenant routing

Inbound webhooks carry `phone_number_id`; the tenant must be resolved **before** `withTenant` can
open. So `whatsapp_accounts` is a **control-plane table with no RLS**, like the existing
`pos_devices` / `pos_order_receipts`. Per Spec 4, writes to it still run inside `withTenant` so the
audit insert has `app.tenant_id` set.

`phoneNumberId` and `wabaId` are derived **exclusively from a server-to-server Graph API call**
using the token from the OAuth code exchange — never trusted from the client-side Embedded Signup
callback. That handler is the trust boundary the whole isolation model rests on.

## 6. Data model

All tenant-scoped tables use FORCE RLS.

| Table | RLS | Notes |
|---|---|---|
| `whatsapp_accounts` | **none** (control-plane) | tenant ↔ `wabaId`/`phoneNumberId`, secret **reference**, `status`, `coexistence` flag. Unique **partial** index on `phoneNumberId WHERE status = 'active'` so a churned number can be re-linked |
| `whatsapp_conversations` | FORCE | one per `(tenantId, waId)`: `state`, `stateVersion`, `cart` jsonb, `branchId`, `lastInboundAt`, `expiresAt` |
| `whatsapp_messages` | FORCE | inbound + outbound log; unique `providerMessageId`; delivery status |
| `whatsapp_order_receipts` | FORCE | idempotency for the place-order effect, keyed `(conversationId, confirmMessageId)` — the `pos_order_receipts` pattern |
| `cart_handoff_tokens` | FORCE | single-use, short TTL, `redeemedAt` |

**Access tokens are never stored as ciphertext in a row.** `whatsapp_accounts` holds a *reference*
resolved by the provider at send time — the pattern the ETA spec actually specifies
(`docs/ailab/specs/2026-07-24-eta-einvoicing-and-ereceipts-design.md:41,103`), which matters more
here because this table has no RLS: one non-tenant-scoped query bug would otherwise return every
tenant's token at once.

**`cart` stores selection ids only — never prices.** Prices are resolved fresh on every render and
again at confirm.

## 7. The reducer

```ts
type ReducerInput = {
  state: ConversationState;
  stateVersion: number;
  cart: CartLine[];              // { productId, variantId?, quantity } — no prices, ever
  inbound: InboundEvent;         // text | interactive | location | media | unsupported
  catalog: CatalogSlice;         // fetched fresh by the runner, branch-scoped
  branch: BranchInfo | null;
};
type ReducerOutput = {
  nextState: ConversationState;
  nextCart: CartLine[];
  outbound: OutboundMessage[];
  effects: Effect[];             // executed by the impure runner after the reducer returns
};
```

Pure: no I/O, no clock, no randomness. The runner fetches the catalog slice and executes effects.

**States:** `idle → branch → categories → products → variant → cart → fulfillment → contact → confirm → placed`

Branch comes **first**, before any browsing. The web flow does this because
`getPublishedMenu(tenantId, branchId)` returns branch-scoped prices and availability; building a
cart before choosing a branch reintroduces exactly the mismatch `CheckoutForm`'s `branchMismatch`
guard exists to catch, and would fail the whole order at the last step.

`variant` is required because `variants: true` for retail, pharmacy and timber, where a variant is
the default unit of purchase, not an edge case.

`fulfillment` offers pickup or delivery. **Choosing delivery ends the chat flow** and mints a
cart-handoff token (D5/D6) — the storefront collects the address, validates the delivery area and
enforces the minimum order.

`placed → idle` on any subsequent inbound, so a customer can start a second order.

### 7.1 The one bounded free-text field

`contact` renders `[Use "Ahmed"] [Type a different name]`. Taking the profile name is a pure tap.
Choosing to type accepts the **next text message verbatim** as `customerName` — stored, length-capped,
never parsed for intent.

This is the single free-text input in the design and it is called out rather than hidden. D5 forbids
*interpreting* free text; it does not forbid storing one opaque string. Everything else that would
need typing — addresses above all — routes to the storefront instead.

### 7.2 Rules the reducer must obey

- **It is total.** Every state accepts every input type. Anything unrecognised — typed text, a
  voice note, a sticker, an unmapped id — re-renders the current prompt with a short "didn't get
  that". A missing transition would throw, and Meta would retry that same message for up to 7 days.
- **Interactive ids are version-scoped:** `add:<stateVersion>:<productId>`. A tap on a superseded
  message is a *new* `wamid`, so `providerMessageId` dedup will not catch it; the reducer rejects a
  reply whose version doesn't match and re-renders current state.
- **Every state reserves a cancel/start-over control,** and a fixed literal-keyword allowlist
  (exact-match "cancel"/"menu"/"human" plus Arabic equivalents — a lookup table, not NLU) escapes
  from any state. "human" replies with the tenant's phone number, since a staff inbox is out of scope.
- **Lists page at 9 rows** (10 total minus one for "next"). Names are truncated to 24 chars with
  price and unit moved into the 72-char description. Pagination cursors live in row ids, not state.
- **Stale carts are re-validated, never resumed blind.** A conversation idle past its TTL resets to
  `idle` and offers "reorder your last" instead of resurrecting a week-old cart.

## 8. Ordering integration

- `placeOrder` is called with `channel: "whatsapp"` and **always** with `expectedTotal`. Without it
  the mismatch guard (`service.ts:225`) is skipped and a price change between cart and confirm would
  silently charge a different amount than the chat displayed.
- The place-order effect **reserves its `whatsapp_order_receipts` row before calling `placeOrder`**,
  matching `record-sale.ts:57-81`. Otherwise a Meta retry double-places a real order.
- `placeOrder` also requires `online_ordering` (`service.ts:67`) regardless of channel. A tenant
  sold WhatsApp ordering without it gets `FeatureNotAvailableError` on every order — plan
  configuration must reflect this.
- Every `placeOrder` error (`OutOfStockError`, `AreaNotDeliverableError`, `MinimumOrderNotMetError`,
  `InvalidScheduleError`, `TotalMismatchError`, …) maps to a bot message and a target state. These
  already carry bilingual copy via `messageFor(locale)`.
- **Reorder** reads only orders this channel created for this `waId` — *not* arbitrary
  `orders.customerPhone` matches. `customerPhone` is unvalidated free text from web checkout and POS
  walk-ins, so matching on it would surface a stranger's name, address and history to whoever now
  holds a recycled number. Both sides normalised to E.164 regardless.

## 9. Gating

Reuse what already exists rather than inventing a parallel flag:

- `PlanFeatures.whatsapp` — the feature gate, checked **on every inbound**, not just at link time.
- `PlanLimits.whatsapp_numbers` — how many `whatsapp_accounts` rows a tenant may hold.
- `PlanLimits.messages_per_month` — already wired to `checkUsage`/`incrementUsage`.

`verticals/registry.ts` must flip `showWhatsapp` to `true` for retail, pharmacy and timber per D4.

## 10. Security, audit, testing

- HMAC over the **raw** body, fail closed on any missing header, parse error or length mismatch.
  Use `timingSafeEqual` (`src/server/auth/password.ts:18` is the precedent) — note it throws on
  unequal lengths. Confirm raw-body access in this Next.js fork before relying on re-serialised JSON.
- Explicit body-size cap and a rate limit on the route. No rate-limiting infrastructure exists in
  this repo today, so this must be built or configured, not assumed.
- Cart-handoff redemption resolves the tenant from the **storefront URL**, never from the token;
  a cross-tenant replay then fails safely under RLS.
- Audit: every mutation emits `recordAuditEvent` on its own transaction. New actions —
  `whatsapp.account_linked`, `whatsapp.account_unlinked`, `whatsapp.order_placed`,
  `whatsapp.handoff_minted`. The mutating service files join `AUDITED_SERVICE_FILES` or the Spec 4
  coverage guardrail fails the PR.
- Tests: exhaustive reducer transitions (pure, no DB); `FakeWhatsAppProvider`; DB-backed
  integration through `withTenant`; signature verification; webhook replay and **batched
  multi-tenant payloads**; the double-tap concurrency race.

## 11. Phasing

1. **Onboarding + plumbing** — Embedded Signup v4 with Coexistence, `whatsapp_accounts`, webhook
   with signature verification, batching, dedup, and the `statuses`/`messages`/`errors` branch.
   Meta Business Verification + App Review + Access Verification start here; they gate GA.
2. **Conversational ordering** — reducer, all states, `placeOrder` integration, cart handoff,
   `order_channel` migration, `showWhatsapp` flip. Marketing `roadmap: true` comes off when this ships.
3. **Outbound** — deferred until Spec 5 exists. Not in v1.

## 12. Out of scope for v1

Modifiers in chat, Rx workflow, cut-to-size, delivery in chat, online payment, offline-payment
proof capture, staff/human inbox, any LLM or free-text parsing, Meta Commerce catalog sync,
marketing broadcasts, cart-abandonment nudges (they need an approved template and an open window).

## 13. Open questions

1. **Existing `whatsappNumber` setting.** A tenant onboarding the bot is almost certainly using the
   same number already typed into Settings → WhatsApp. Does linking auto-populate and lock that
   field, and does the storefront's `wa.me` link — which now reaches a bot rather than a human —
   get retired for those tenants? Needs a decision before Phase 2.
2. **P2 overlap.** "Reorder my last" is a `waId`-keyed identity, and the vertical roadmap's P2 is a
   phone-keyed customer record doing the same job. Fold this into a minimal P2 slice, or accept two
   identity concepts and reconcile later?
3. **Embedded Signup v4 / coexistence deprecation on 2026-10-15** — confirm directly with Meta
   before Phase 1 begins.
