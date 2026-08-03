# Timber Cut-to-Size (P4) — Implementation Plan

> Implements docs/superpowers/specs/2026-08-03-timber-dimensional-design.md · issue #57.
> Next migration index: **0029**.

## Task 1 — Shared UoM enum + `products.unitOfMeasure`
`src/server/catalog/uom.ts` (pg enum `unit_of_measure`: each,g,kg,ml,l,m,m2,bf
+ `DIMENSIONAL_UOMS = ['m','m2','bf']` + a `requiredDimensions(uom)` helper).
Modify `products` schema (+`unitOfMeasure`), migration 0029. Capability flags
`dimensionalProducts`/`unitsOfMeasure`/`tradeAccounts` added to
`VerticalCapabilities` + registry (timber: true, others: false). Tests:
registry capability test; `requiredDimensions` per UoM.

## Task 2 — Pure dimensional pricing
`src/server/catalog/dimensional-pricing.ts`: `computeDimensionalQuantity(uom,
dims): number` (m: length/1000; m2: length/1000 × width/1000; bf: standard
board-foot formula via mm→inch); `computeDimensionalUnitPrice(basePrice, uom,
dims): number` = `round2(basePrice × quantity)`. Throws on missing required
dimensions. Tests: each UoM's formula against hand-computed values (e.g. a
2400×100×25mm board in bf against the known board-foot result); missing
dimension throws; non-dimensional products pass through unchanged (n/a here,
consumed in Task 3).

## Task 3 — Cut-list ordering
`PlaceOrderLine.dimensions?`; in `placeOrder`, when the product's
`unitOfMeasure` is set, require dimensions, compute `unitPrice` via Task 2,
persist dimensions in `orderItems.dimensions` (jsonb) for the receipt/BOM
record. Reject a non-dimensional product carrying dimensions (input error,
not silently ignored). Tests: a cut-list order prices correctly end to end
against `computeCartTotals`'s existing pipeline (parity check); missing
dimensions on a dimensional product rejected; dimensions on a NON-dimensional
product rejected; a normal restaurant/retail order is provably unaffected
(regression, existing fixtures untouched).

## Task 4 — Trade accounts
`customers` gains `tradeApproved`, `tradeDiscountPercent` (migration, same
0029 or 0030 depending on Task 1's timing — check at execution). `placeOrder`
applies the discount via the EXISTING `orderDiscountAmount` param when
`ctx.customerId` resolves to a trade-approved customer AND the tenant's
vertical has `tradeAccounts` — computed as `round2(grossSubtotal ×
tradeDiscountPercent/100)`, no new discount pipeline. Tests: trade customer's
order shows the discount; non-trade customer unaffected; a trade-approved
customer on a NON-timber tenant gets no discount (capability-gated).

## Task 5 — Dashboard customer directory + trade approval
`customers:manage` permission (owner+manager). `src/app/dashboard/customers/`
list page + a server action to set `tradeApproved`/`tradeDiscountPercent`.
Reuses `PageHeader`/`Table`/`EmptyState` conventions. Audited
(`customer.trade_approved`).

## Task 6 — Storefront dimensional UI + verify + PR
Product card for a dimensional product collects length/width/thickness as
required by its UoM and shows the live computed price before add-to-cart
(client-side call to the same pure Task 2 function via a shared import — no
duplicate formula). Full suite, tsc, eslint, build. PR closes #57; files the
quote/estimate follow-up issue per owner decision T7.
