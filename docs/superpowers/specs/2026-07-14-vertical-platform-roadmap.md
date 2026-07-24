# ServeOS Vertical Platform — Post-Launch Roadmap

**Date:** 2026-07-14
**Status:** Approved (roadmap; each sub-project gets its own spec → plan → build)
**Context:** The 4-vertical framework (restaurant, retail, pharmacy, timber) shipped in PR #13
(`docs/superpowers/specs/2026-07-13-vertical-storefront-templates-design.md`). That work
delivered the capability registry, retail-grade catalog (variants + stock), vertical-aware
taxes, the shop storefront, and a capability-adaptive dashboard. **Retail is real; pharmacy
and timber are currently retail clones** — identical `variants + stockTracking` capabilities
and the shop template, differing only in terminology and accent. This roadmap sequences the
work that makes every vertical real and completes the commerce platform.

## What shipped vs. what each vertical actually needs

| Vertical | Shipped today | Real-world gaps (researched) |
|---|---|---|
| Restaurant | menu, modifiers, scheduled orders, QR download, service charge | reservations (+deposits), QR dine-in table ordering, tips, allergen/dietary info, loyalty, combos |
| Retail | variants, stock, search, shop UX | returns/refunds, discount codes, carrier shipping (zones/rates/tracking), customer accounts, wishlists |
| Pharmacy | **retail clone** (relabeled only) | prescription upload entry path, Rx/OTC flagging, pharmacist-review gate, VAT-exempt tax classes, compliance audit trail (license/controlled-substance/records) — the Chefaa/Yodawy model |
| Timber | **retail clone** (relabeled only) | cut-to-size dimensions, units of measure (linear m / m² / board ft), per-dimension pricing, cutting-list cart, trade accounts + quotes |
| All four | cash-only, guest checkout | **online payment**, customer accounts, per-line tax classes, promotions |

Research anchors: pharmacy — Chefaa/Yodawy scan-and-order + Egypt e-pharmacy compliance;
timber — Timbersource/Wood2Size cut-to-size + trade accounts; restaurant — 2026 ordering-system
standards (reservations, QR dine-in, loyalty); retail — standard e-commerce (returns, shipping,
discounts); MENA gateways — Paymob/Fawry (EG), Tap/HyperPay (KSA).

## Guiding principle

Keep the discipline that made the framework clean: **shared services branch on capabilities,
never vertical names.** Every item below is expressed as new capability flags + new domain
modules, not `if (vertical === "pharmacy")`. New verticals/features must remain "write a
descriptor + a capability + a module," never edit-every-service.

## Sequenced sub-projects

Ordering is driven by dependencies: payments and accounts underpin deposits, returns, loyalty,
and prescription history, so they come first.

### Phase 1 — cross-cutting foundation (lifts all four verticals)

**P1 · Online order payments** — *build first; brainstormed next into its own spec.*
- Goal: accept card + wallet online at checkout, alongside (not replacing) cash.
- Shape: a `PaymentProvider` interface mirroring the existing `BillingProvider` pattern;
  Paymob first (EG: card, wallet, kiosk/Fawry), provider-abstracted for KSA (Tap/HyperPay).
  Payment intent + webhook confirmation, order `paymentStatus` wired to real settlement,
  refund hook, idempotency. Guest checkout preserved.
- Touches: `orders` (payment intent/reference/method columns), a new `src/server/payments/`
  domain, checkout flow, a webhook route, `payment_method` enum (`cash` → `+card`, `+wallet`).
- Dependencies: none. Unblocks reservation deposits (P6) and returns/refunds (P5).

**P2 · Customer accounts & identity**
- Goal: optional phone/OTP (or email) customer accounts with saved addresses and order history.
- Shape: customer identity separate from the existing tenant `users` (those are merchant staff);
  a per-tenant customer record keyed by phone, linking existing guest orders by phone number.
- Dependencies: none hard; complements P1. Prerequisite for loyalty (P6), returns self-service
  (P5), and prescription history (P3).

### Phase 2 — make the cosmetic shells real

**P3 · Pharmacy Rx workflow**
- Goal: turn pharmacy from a retail clone into a real online pharmacy.
- Scope: capability flags `prescriptionUpload`, `pharmacistReview`, `taxClasses`; a
  prescription-upload order-entry path (photo of script/box → cart, Chefaa/Yodawy style);
  product-level Rx-vs-OTC flag; an order state gated on pharmacist review before fulfillment;
  per-line tax classes so VAT-exempt medicines compute correctly in `computeOrderTotals`
  (the seam is already designed in); a compliance audit trail.
- Dependencies: benefits from P2 (prescription history) but not blocked by it.

**P4 · Timber cut-to-size**
- Goal: dimensional, made-to-measure ordering timber yards actually use.
- Scope: capability flags `dimensionalProducts`, `unitsOfMeasure`, `tradeAccounts`; products
  priced per unit of measure (linear m / m² / board ft) instead of per fixed variant; a
  cut-list line type carrying customer dimensions + a price formula; trade-account pricing
  tiers and a quote/estimate flow.
- Dependencies: the hardest data-model change (unit-of-measure pricing vs the current
  fixed-price variant). Independent of P1–P3.

### Phase 3 — breadth completeness

**P5 · Retail commerce completeness**
- Scope: returns/refunds (needs P1 refund hook + P2 self-service), discount/promo codes,
  carrier shipping (delivery zones already exist; add rates + tracking numbers + fulfillment
  states). Benefits all shop verticals (retail/pharmacy/timber).
- Dependencies: P1, P2.

**P6 · Restaurant hospitality depth**
- Scope: table reservations with deposits (needs P1), QR dine-in table ordering (table-scoped
  carts), tips, allergen/dietary attributes, loyalty (needs P2), combos/meal-deals.
- Dependencies: P1 (deposits), P2 (loyalty).

## Out of scope for this roadmap

- Non-EG/KSA markets and their local payment methods (beyond the provider abstraction hook).
- Native mobile apps (the storefront is an installable PWA).
- Marketplace/multi-vendor aggregation (each tenant is its own storefront).
- Delivery-driver logistics/dispatch, and third-party delivery integrations.

## How this roadmap is executed

Each sub-project is brainstormed into its own `docs/superpowers/specs/…-design.md`, then a
`docs/superpowers/plans/…` implementation plan, then built (subagent-driven TDD). This document
is the sequencing contract; it is not itself an implementation spec. **P1 (online payments) is
brainstormed next.**
