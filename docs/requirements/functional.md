# Functional Overview

What ServeOS does today, stated against the code. Where something is planned but not built, it says so.

## 1. Summary

ServeOS is a multi-tenant commerce and operations platform. Storefront orders, POS sales and WhatsApp orders all become rows in the same `orders` table (`channel` = `web`, `pos` or `whatsapp`) and go through the same `placeOrder` service, so stock, totals and reporting are shared across channels. Each tenant runs one **vertical** — `restaurant`, `retail`, `pharmacy` or `timber` — which switches capabilities on and off.

## 2. Verticals

Capabilities come from `src/server/verticals/registry.ts` (this table is generated from it):

| Capability | restaurant | retail | pharmacy | timber |
|---|---|---|---|---|
| `modifiers` | ✅ | — | — | — |
| `variants` | — | ✅ | ✅ | ✅ |
| `stockTracking` | ✅ | ✅ | ✅ | ✅ |
| `serviceCharge` | ✅ | — | — | — |
| `dimensionalProducts` | — | — | — | ✅ |
| `unitsOfMeasure` | — | — | — | ✅ |
| `tradeAccounts` | — | — | — | ✅ |
| `prescriptionUpload` | — | — | ✅ | — |
| `pharmacistReview` | — | — | ✅ | — |
| `taxClasses` | — | — | — | — |
| `inventory` | ✅ | ✅ | ✅ | ✅ |
| `recipes` | ✅ | — | — | — |
| storefront template | `menu` | `shop` | `shop` | `shop` |
| checkout adjustments | vat, service_charge | vat | vat | vat |

`stockTracking` is a legacy alias of `inventory` kept for the migration window; `taxClasses` is off everywhere.

What that means per vertical:

- **Restaurant** — modifier groups/options on products, recipes (BOMs) that deduct ingredients from the branch's kitchen location when a dish sells, a service charge at checkout, and the `menu` storefront template. By default (tenant setting `allowNegativeStock`, on for restaurants) a shortfall lets on-hand go negative and raises a `low_stock` notification rather than blocking the sale.
- **Retail** — product variants, finished-goods stock deducted FIFO from the branch's retail location; by default an order that would oversell is rejected (`OutOfStockError`). Replayed offline POS sales are never rejected for stock; the shortfall is recorded and notified instead.
- **Pharmacy** — products can be flagged `requires_prescription`. Ordering one requires a signed-in customer with an uploaded, still-pending prescription; the order is placed with `rx_review_status = pending` and, while it is pending, can only be rejected or cancelled. A user with `rx:review` approves or rejects the prescription, which sets the order's `rx_review_status`.
- **Timber** — dimensional products priced by `m`, `m2` or `bf` from length/width/thickness entered at order time; cut-to-size stock consumes a board and returns the offcut (3 mm kerf, offcuts under 300 mm are discarded — `src/server/inventory/service.ts`); trade accounts (approved customers with a trade discount percentage).

Fulfillment is **pickup or delivery** for every vertical (`fulfillment_type` enum). There is no dine-in or table service.

## 3. Modules

### 3.1 Catalog
- Categories, products, variants, modifier groups/options; English and Arabic names in separate `*_en` / `*_ar` columns.
- Per-branch availability and price override (`branch_product_availability`).
- A per-tenant catalog version counter, bumped on catalog/pricing writes and cached by the POS.
- Banners for the storefront.

### 3.2 Ordering
- Channels: storefront (`POST /api/orders`), POS (`POST /api/pos/v1/sales`, offline replay via sync events) and the WhatsApp bot.
- Order statuses: `pending → confirmed → preparing → ready → (out_for_delivery →) completed`, with `rejected` / `cancelled`. See [state-machines.md](../flows/state-machines.md).
- Customers track and cancel orders with an opaque status token.
- Branch opening hours, accepting-orders switch, scheduled orders, delivery areas (fee, minimum order, ETA minutes).
- Totals from one implementation (`src/lib/order-totals.ts`): VAT, restaurant service charge, delivery fee, trade discount.
- Payment methods: cash, plus offline methods (InstaPay, Vodafone Cash, mobile wallet) that the tenant enables; these start at `pending_verification` and are confirmed or rejected by a user with `payments:confirm`. There is no card payment gateway (roadmap D3 is parked).

### 3.3 POS (Electron, `apps/pos`)
- **Pairing:** an 8-character code minted in the dashboard (valid 10 minutes), or an owner/manager signing in on the till with slug + email + password.
- **Cashier sign-in:** email + password of a staff user who holds `pos:sell`; 12-hour cashier session.
- **Shifts:** opening float, pay-ins, pay-outs, safe drops, no-sale, mid-shift counts, close with counted cash and variance; one open shift per device.
- **Sales:** split tenders (`cash`, `card`, `other`; card is record-only), tips, change; line and order discounts need `pos:discount` or a manager grant.
- **Refunds:** full or partial, optional restock per line; need `pos:refund` or a manager grant.
- **Manager override:** a manager signs in on the till to issue a single-use, 2-minute grant.
- **Held tickets** (branch-wide), **sales history**, **reprints**, **X / Z reports**.
- **Offline:** the till keeps a local SQLite event log (`apps/pos/electron/_offline/`), keeps selling through an outage (offline sign-in against a synced roster), and replays queued events in batches of up to 50 to `POST /api/pos/v1/sync/events` when back online (shipped in PR #138).

### 3.4 Inventory
- Item kinds: `ingredient`, `finished_good`, `raw_material`; storage locations per branch (`kitchen`, `retail`, `back_of_house`, `transit`).
- Lots with cost and optional expiry; FIFO deduction ordered by expiry then receipt time, skipping expired lots.
- Append-only `stock_ledger` (`receive`, `sale_deduction`, `adjustment`, `count`, `transfer`, `waste`, `refund_restock`, `production`).
- Receipts outside a PO, adjustments/waste, transfers, stock counts (open → add lines → commit).
- Product links: a product/variant deducts either a recipe or a finished-goods item; unlinked products don't touch stock.
- Reorder rules per item and location; the reorder check (daily GitHub workflow, after each verified deploy, or on demand) raises `low_stock` alerts and pre-fills draft POs.

### 3.5 Purchasing
- Suppliers and supplier items (SKU, last cost, pack unit).
- PO lifecycle `draft → sent → partially_received → received → closed`, or `cancelled` from draft/sent.
- Sending renders the PO as HTML and queues it to the supplier's email through the notification outbox (sent via Resend).
- Receiving creates lots and `receive` ledger rows valued at the ordered line cost; invoice totals are recorded and compared in a variance view.

### 3.6 WhatsApp ordering
- Conversation states: `idle → branch → categories → products → (variant →) cart → fulfillment → contact → confirm → placed` (`whatsapp_conversation_state` enum; transitions in `src/server/whatsapp/reducer.ts`).
- Pickup orders are placed inside the chat. Delivery orders and products with required modifiers are handed to the storefront with a single-use cart handoff link (`/?handoff=<token>`, valid 60 minutes).
- For WhatsApp orders, the `confirmed`, `ready` and `out_for_delivery` transitions are queued back to the customer and sent by the notifications worker.

### 3.7 Customers
- Storefront customer accounts (email + password, `serveos_customer` session cookie, 30-day sessions).
- Trade accounts (timber): an approved flag and a trade discount percentage, set by a user with `customers:manage`.

### 3.8 Audit
- `audit_events`: per-tenant hash chain (SHA-256 over a canonical encoding of prev hash, sequence, tenant, actor, action, entity, metadata and timestamp); a trigger blocks UPDATE/DELETE; staff with `audit:view` can list events and verify the chain.
- Each event carries a fingerprint (IP, user agent; for POS also device id, device-token hash and app version).
- `audit_logs` is a separate table for platform super-admin actions.

### 3.9 Notifications
- In-app notifications targeted at users or roles, with type and severity (`low_stock`, `reorder_suggested`, `po_sent`, `po_received`, `shift_variance`, `reconciliation_exception`, `refund_issued`, `system_alert`).
- Email via an outbox drained by `GET /api/notifications/worker` (Vercel Cron) through Resend; Resend delivery events come back through a signed webhook.

### 3.10 Tenancy & billing
- Sign-up at `/register` creates the tenant in `trial` with a 14-day trialing subscription and an onboarding application; a platform admin approves (tenant `active`) or rejects it.
- Plans (`src/server/subscription/plans.seed.ts`), EGP per month:

| Key | Display name | Price | Branches | Staff | Products |
|---|---|---|---|---|---|
| `basic` | Free | 0 | 1 | 2 | 50 |
| `pro` | Starter | 499 | 3 | 10 | 500 |
| `growth` | Growth | 699 | 5 | 25 | 2000 |
| `enterprise` | Professional | 1099 | 50 | 200 | 100000 |

- Entitlements: `checkQuota` / `requireFeature` (`src/server/entitlements/service.ts`); e.g. advanced reports require the `advanced_analytics` feature (Growth and Professional).
- Billing is manual behind the `BillingProvider` interface: the tenant uploads payment proof for an invoice; a platform admin confirms (invoice `paid`, subscription activated) or rejects it (invoice `void`).

### 3.11 Not built
- Fiscal e-invoicing (ETA — Spec 11; ZATCA) — specified, not implemented.
- Card payment gateway / settlement (Specs 6–7) — parked.
- Dine-in / table management, kitchen display, receipt-printer and other peripheral integrations, loyalty, delivery dispatch — roadmap backlog only.

## 4. Roles and permissions

Roles are `owner`, `manager`, `staff`, `pharmacist` (tenant roles) and `super_admin` (platform). Generated from `src/server/rbac/permissions.ts`:

| Permission | `owner` | `manager` | `staff` | `pharmacist` | `super_admin` |
|---|---|---|---|---|---|
| `tenant:manage` | ✅ | — | — | — | — |
| `staff:invite` | ✅ | ✅ | — | — | — |
| `plan:view` | ✅ | ✅ | ✅ | ✅ | — |
| `plan:change` | ✅ | — | — | — | — |
| `billing:manage` | ✅ | — | — | — | — |
| `platform:approve_tenant` | — | — | — | — | ✅ |
| `platform:suspend_tenant` | — | — | — | — | ✅ |
| `platform:view_revenue` | — | — | — | — | ✅ |
| `menu:manage` | ✅ | ✅ | — | — | — |
| `orders:manage` | ✅ | ✅ | ✅ | ✅ | — |
| `fulfillment:manage` | ✅ | ✅ | — | ✅ | — |
| `payments:confirm` | ✅ | ✅ | — | — | — |
| `pos:sell` | ✅ | ✅ | ✅ | ✅ | — |
| `pos:discount` | ✅ | ✅ | — | — | — |
| `pos:void` | ✅ | ✅ | — | — | — |
| `pos:refund` | ✅ | ✅ | — | — | — |
| `audit:view` | ✅ | ✅ | — | — | — |
| `reconciliation:manage` | ✅ | ✅ | — | — | — |
| `reports:view` | ✅ | ✅ | — | — | — |
| `reports:financial` | ✅ | ✅ | — | — | — |
| `customers:manage` | ✅ | ✅ | — | — | — |
| `rx:review` | ✅ | — | — | ✅ | — |
| `inventory:view` | ✅ | ✅ | ✅ | — | — |
| `inventory:manage` | ✅ | ✅ | — | — | — |
| `inventory:count` | ✅ | ✅ | ✅ | — | — |
| `purchasing:manage` | ✅ | ✅ | — | — | — |
| `suppliers:manage` | ✅ | ✅ | — | — | — |

Notes:
- A **cashier** is any user signed in at the POS; sign-in requires `pos:sell`.
- At the till, `pos:*` and `reconciliation:manage` can be granted for one action by a manager override (`POST /api/pos/v1/authorize`).
- `pos:void` is defined and granted to owners/managers, but no code path checks it yet.
- **Customers** are not RBAC users; they authenticate with their own storefront session.

## 5. References

- Roadmap and locked decisions: [docs/ROADMAP.md](../ROADMAP.md)
- PRDs: [MASTER-PRD](../prds/MASTER-PRD.md), [PRD-002: cross-channel reporting](../prds/PRD-002-feature-cross-channel-reporting.md), [high-level product PRD](../prds/prd-high-serveos.md), [ZATCA e-invoicing (high level)](../prds/prd-high-zatca-einvoicing.md)
- Per-feature design specs: `docs/{ailab,superpowers,moai,adham-ai}/`
