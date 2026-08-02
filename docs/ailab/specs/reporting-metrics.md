# Reporting metric definitions

Single source of truth for what every number in the reporting layer means
(Spec 10 and everything that cites it). Each aggregation in
`src/server/analytics/service.ts` / `pos-reports.ts` implements these
definitions; a new report inherits them rather than re-deciding.

Decisions locked in issue #31.

## The status filter

`orders.status` is an 8-value enum: `pending`, `confirmed`, `preparing`,
`ready`, `out_for_delivery`, `completed`, `rejected`, `cancelled`.

**Revenue excludes `cancelled` and `rejected`; every other status counts.**
In-flight orders (`pending` … `out_for_delivery`) are committed demand —
excluding them would make today's figures collapse as orders progress
through the pipeline. Every revenue-bearing query carries:

```sql
AND status NOT IN ('cancelled', 'rejected')
```

Orders matching that filter are called **sold orders** below.

**Deliberately unfiltered:**

- `getOrdersByStatus` — counting cancelled/rejected orders is its entire
  purpose.
- `getPeakHours` — a demand-timing measure, not a money measure. An order
  that later cancels still told us when demand arrived.

## Measures

| Measure | Definition |
|---|---|
| **revenue** | `SUM(orders.total)` over sold orders in the window. `total` is **gross**: inclusive of `vatAmount`, `serviceChargeAmount` and `deliveryFee` — the take that ties to a cash drawer or a gateway payout. A net-of-tax figure, if ever wanted, is a *separate measure*, never a redefinition of this one. |
| **orderCount** | `COUNT(*)` over sold orders in the window. |
| **averageOrderValue** | `AVG(orders.total)` over sold orders (equivalently revenue ÷ orderCount). |
| **discount** | Amounts from `pos_adjustment_events` rows of type `line_discount` / `order_discount`, plus `orders.discount_amount` for orders that carry one. Reductions granted at sale time — not refunds. |
| **refund** | Money returned after settlement, from Spec 3's `refunds` tables. Until Spec 3 ships this reads as *absent* (`null`), never zero — zero would claim "we checked, there were none". |
| **tender** | A payment row in `order_payments`: `method` (`cash` / `card` / `other`) and `amount`. A split payment is multiple tenders on one order. Tender totals join through sold orders only, windowed on `orders.placed_at`. |
| **tip** | `SUM(order_payments.tip_amount)` over tenders of sold orders. Not part of revenue. |
| **expectedDrawerCash** | `opening float + cash tendered − cash change + drawer movements (pay-ins − pay-outs)` for the open shift. Where no shift exists (Spec 2 data absent for the window) the float/movement terms are zero. The authoritative close-time figure is Spec 2's `gatherShift`; reports must agree with it, not re-derive differently. |

## Window

All windows are computed on `orders.placed_at` (payments join through their
order, so a tender belongs to the day its order was placed, in the tenant's
timezone via `AT TIME ZONE`).
