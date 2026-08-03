# ServeOS — Timber Cut-to-Size (P4) Design

**Date:** 2026-08-03 · **Issue:** #57 · **Roadmap:** vertical-platform P4
**Owner decisions (2026-08-03):** trade pricing = per-customer discount % (not a second price list) · quote/estimate flow is a fast-follow, not v1.

## Problem
Timber renders today as a relabelled retail clone: fixed-price variants, no
concept of "2.4m of 4x2 timber" or "a 600×400mm sheet of ply." A yard cannot
sell what it actually sells.

## The overlap this spec resolves
Issue #57 flags that Spec 8 (Inventory Core, #51 — **not yet built**) will
also need a unit-of-measure concept for ingredients (`each|g|kg|ml|l`, per
its design doc). Modeling UoM twice would leave two enums claiming the same
idea. **Resolution:** this spec defines ONE shared `unit_of_measure` pg enum
now, as a superset covering both domains (`each, g, kg, ml, l, m, m2, bf`).
Spec 8, when built, imports this enum rather than defining its own — its
design doc's `inventory_uom` name is superseded by this one. This is a build-
order accident (P4 lands first), not a P4-owns-inventory decision — Spec 8
still owns the ledger, lots, and conversion-factor machinery; it just references
the same set of unit symbols.

## Decisions
| # | Decision |
|---|---|
| T1 | **Shared `unit_of_measure` enum**, superset of both domains. Lives in `src/server/catalog/uom.ts` (schema) — catalog owns it because a *sellable product* is the first consumer; Spec 8 imports it later. |
| T2 | **`products.unitOfMeasure`** nullable. Null = today's fixed-price product (every existing vertical, unchanged). Set = `basePrice` is **reinterpreted as price-per-unit-of-measure**, not price-per-each. No new price column — one number, one meaning per row. |
| T3 | **Cut-list line = existing order line + dimensions.** `PlaceOrderLine.dimensions?: {lengthMm, widthMm?, thicknessMm?}` (millimeters — the metric baseline regardless of the product's UoM, since Egypt is a metric country even for a "board ft" product). A pure function converts to the product's UoM quantity; that quantity × `basePrice` becomes the line's `unitPrice`, which then rides the **unchanged** `computeLineTotal`/`computeCartTotals` pipeline — zero blast radius on core money math. |
| T4 | **Board-foot formula**, since it is not metric-native: `bf = (thickness_in × width_in × length_in) / 144`, mm→in via `/25.4`. Standard lumber definition, not a ServeOS invention. |
| T5 | **Trade accounts = per-customer discount %** (not a second price list, per owner decision). `customers.tradeApproved: boolean`, `customers.tradeDiscountPercent: numeric?`. Approval is a **staff action** (owner/manager), not self-service — a customer cannot grant themselves a discount. |
| T6 | **New capability flags** `dimensionalProducts`, `unitsOfMeasure`, `tradeAccounts` — enabled for `timber` only; every other vertical is provably unaffected (capability gate, same pattern as `stockTracking`). |
| T7 | **Quote/estimate flow is a fast-follow** (owner decision) — filed as its own issue. v1 ships real, payable cut-to-size ordering; "save and revisit later" is separate. |

## New surface: dashboard customer directory
Trade approval needs a staff-facing place to happen — none exists yet (P2
built only the storefront `/account`). This spec adds the minimal one: a
`customers:manage` permission (owner + manager), a list page, and a toggle
action. Deliberately minimal — not a CRM, just enough to approve a trade
account and set its discount.

## Non-goals (v1)
Quote/estimate flow (follow-up) · per-product trade price overrides · Spec 8's
ledger/lots/recipes (this spec only reserves the shared enum) · UoM on
existing non-timber products (capability-gated to timber; a restaurant's
`basePrice` keeps meaning price-per-each).
