# ServeOS — Shifts & Cash Drawer Design

**Date:** 2026-07-24
**Status:** Draft — pending review
**Scope:** Spec **2 (Shifts & Cash Drawer)** of the core POS & operations roadmap (`docs/ROADMAP.md`). It gives every cash tender a **session** — a cashier's shift at a device/drawer — and makes the drawer accountable: an opening float, in-shift cash movements (pay-in/out, safe drops, no-sale), a counted close, and an expected-vs-counted **variance**. It has no dependency on the payment gateway and can start immediately. It is a **prerequisite for Spec 7 (Reconciliation)** — whose cash-drawer layer *reads* the `cash_counts` and `pos_shifts` this spec defines and the `order_payments.shiftId` it populates — and it feeds the POS **X/Z reports** of Spec 10 (Reporting). Where a downstream spec (3 Refunds, 7 Reconciliation, 10 Reporting) is named, it is treated as a consumer, not something this spec builds.

## Context

The POS already records tenders in `order_payments` (`src/server/pos/tender-schema.ts`) with a `method` of `cash | card | other`, `tenderedAmount`, `changeAmount`, and `tipAmount`, written by `recordSale` / `addTender` (`src/server/pos/record-sale.ts:51`). Crucially, that schema **already carries a `shiftId uuid` column (lines ~13–16, 29) that is reserved and entirely unused** — every tender written today leaves it null. There is no table it points at, no session that owns it, and nothing that stamps it.

The device layer that would anchor a session already exists: `pos_devices` (`src/server/pos/schema.ts`) is a control-plane, per-branch table, and `requirePosCashier` (`src/server/pos/require-cashier.ts`) resolves `{deviceId, tenantId, branchId, cashierUserId}` from the device Bearer token + `X-POS-Cashier` header on every POS request. What is missing is the thing *between* the device and the tender: a shift.

## Problem

Without a shift, cash is unaccountable. There is no opening float to reconcile against, no record of a cashier reaching into the drawer for a pay-out or a safe drop, and no counted close — so the question "was the drawer right at the end of the day?" has no answer beyond trust. Spec 7's reconciliation makes this concrete: its cash-drawer layer (b) needs an *expected cash per shift* and a *counted cash per shift* to compute a variance, and today it can produce neither. Until this spec lands, that layer degrades to "cash reconciliation unavailable (Spec 2 pending)" — which is exactly the placeholder Spec 7 ships with. The reserved `order_payments.shiftId` is the seam left for us; nothing fills it.

## Goal

Introduce a **shift** as a cashier's session at one device/drawer, with at most one open shift per device at a time. Opening a shift records an opening float; every cash tender written during it is stamped with `shiftId`; cash leaving or entering the drawer outside a sale is an explicit, attributed `cash_movements` row; and closing the shift takes a physical `cash_counts` count, computes the **expected** cash by a single normative formula, and records the **variance** (over/short). Support a per-tenant **blind close** where the cashier counts without seeing the expected figure. Produce a **Z-report** at close (and a non-resetting **X-report** mid-shift) whose data feeds Spec 10. Every shift open, close, movement, and count emits a Spec 4 audit event.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Session grain | **One shift = one cashier at one device/drawer.** `pos_shifts.deviceId → pos_devices`; the drawer is the device. Multi-drawer-per-device is out of scope. |
| Concurrency guard | **At most one `open` shift per device**, enforced by a **unique partial index on `deviceId WHERE status = 'open'`**, and serialized on open with `pg_advisory_xact_lock(hashtext(deviceId)::bigint)` so a race returns a clean error, not a raw constraint violation — the same lock discipline `placeOrder` uses for order numbers (`src/server/ordering/service.ts`). |
| Tender stamping | **`recordSale` / `addTender` stamp `order_payments.shiftId`** with the device's active open shift for **cash** tenders; non-cash tenders carry it too, for reporting. No open shift ⇒ cash sale is refused. |
| Expected cash | **One normative formula** (below), computed server-side. `variance = counted − expected`; its **sign is over/short**. |
| Blind close | **Per-tenant `blindClose` policy.** When on, the cashier submits a count without ever seeing `expectedTotal`; expected + variance are computed server-side and revealed only to a `reconciliation:manage` holder. |
| Money convention | **Unchanged.** All amounts are `numeric` strings via `money(n)` (`src/server/ordering/service.ts`). Movement `amount` is **signed by type**. |
| Reports | **Z at close, X mid-shift and non-resetting.** This spec defines the close/count math and the projection; the *rendering* of X/Z is Spec 10. |
| Isolation | **`pos_shifts`, `cash_counts`, `cash_movements` are tenant-scoped with FORCE RLS**, reached only through `withTenant` (`src/db/with-tenant.ts`). `pos_devices` stays control-plane (no RLS), as today. |

## Non-goals (deferred by explicit decision)

- **Cash refunds / refund tenders** (money out via a return) → **Spec 3**. The expected-cash formula *reserves a term* for `Σ cash refunds`; until Spec 3 lands that term is zero. This spec does not build the refund flow.
- **Gateway payouts, card settlement, order↔tender integrity** → **Specs 6 / 7**. This spec produces the per-shift cash numbers; Spec 7's daily close composes them with the other two layers.
- **Rendering the X / Z report UI and the manager cash reports** → **Spec 10**. We define what the reports *contain*; Spec 10 draws them on the POS bridge and dashboard.
- **Labour / time-clock, tip pooling, tip-out distribution** → POS backlog (roadmap item 9). A shift is a *cash* session, not a clock-in; tips are recorded on the tender (`tipAmount`) but never enter the drawer-expected math.
- **Multi-currency drawers, foreign-cash counting** → out of scope; one tenant currency, as elsewhere.

## Data model

Three new tables, canonical roadmap names, all tenant-scoped (FORCE RLS). One existing column is finally wired.

### New: `pos_shifts`

A cashier's session at one device/drawer.

| Column | Notes |
|---|---|
| `id`, `tenantId` | uuid; tenant-scoped, FORCE RLS. |
| `branchId` | uuid → branch. Denormalized from the device for per-branch reporting and RLS locality. |
| `deviceId` | uuid → `pos_devices` (control-plane). The drawer. |
| `openedByUserId` | uuid — the cashier who opened it (`requirePosCashier`'s `cashierUserId`). |
| `closedByUserId` | uuid, **nullable** — set at close; may differ from the opener (a manager can close an abandoned shift). |
| `status` | enum `pos_shift_status` — **`open \| closed`**. |
| `openingFloat` | numeric — the starting cash in the drawer, via `money(n)`. |
| `openedAt` | timestamptz. |
| `closedAt` | timestamptz, **nullable** — null while open. |

**Unique partial index:** `UNIQUE (deviceId) WHERE status = 'open'` — the hard guarantee of one open shift per drawer. Index `(tenantId, branchId, status)` and `(deviceId, status)` for the "current shift" lookup on every stamp.

### New: `cash_movements`

Cash entering or leaving the drawer **outside** a sale — the audit trail of the physical drawer.

| Column | Notes |
|---|---|
| `id`, `tenantId` | tenant-scoped, FORCE RLS. |
| `shiftId` | uuid → `pos_shifts`. |
| `type` | enum `cash_movement_type` — **`pay_in \| pay_out \| safe_drop \| no_sale`**. |
| `amount` | numeric, **signed by type**: `pay_in` positive; `pay_out` and `safe_drop` negative; `no_sale` is `0` (a drawer-open with no cash effect, recorded for audit). |
| `reasonCode` | text — a controlled code (e.g. `float_top_up`, `till_lift`, `owner_draw`). |
| `reasonText` | text, nullable — free-text elaboration. |
| `byUserId` | uuid — who performed it. |
| `authorizedByUserId` | uuid, **nullable** — the manager who authorized it. A `pay_out` over the per-tenant threshold **must** carry one; resolved by **`resolveAuthorizer`** (the Spec 1 helper that already populates `authorizedByUserId` on discount/void events). |
| `createdAt` | timestamptz. |

Index `(shiftId, type)` — the close reads all movements for a shift, grouped by type.

### New: `cash_counts`

A physical count of the drawer, and the variance it implies.

| Column | Notes |
|---|---|
| `id`, `tenantId` | tenant-scoped, FORCE RLS. |
| `shiftId` | uuid → `pos_shifts`. |
| `kind` | enum `cash_count_kind` — **`opening \| closing \| mid_shift`**. |
| `countedTotal` | numeric — what the cashier physically counted (via `money(n)`). |
| `denominations` | jsonb, **nullable** — optional `{ "200": 3, "100": 5, … }` breakdown; `Σ denom·qty` must equal `countedTotal` when present. |
| `expectedTotal` | numeric — the server-computed expected cash (formula below). Persisted even under blind close (the cashier just doesn't see it). |
| `variance` | numeric — **`countedTotal − expectedTotal`**. Positive = **over**, negative = **short**. |
| `byUserId` | uuid — who counted. |
| `createdAt` | timestamptz. |

Index `(shiftId, kind)`. A `closing` count is what Spec 7's cash layer and per-shift `reconciliation_runs` read.

#### Expected-cash formula (normative)

For a shift, expected drawer cash at any point is:

```
expectedTotal =   openingFloat
                + Σ cash tenders            (order_payments where method = 'cash', this shiftId; net of changeAmount)
                − Σ cash refunds            (Spec 3; 0 until Spec 3 lands)
                − Σ pay_outs                (cash_movements.type = 'pay_out',  absolute)
                + Σ pay_ins                 (cash_movements.type = 'pay_in')
                − Σ safe_drops              (cash_movements.type = 'safe_drop', absolute)
```

Cash tenders contribute `tenderedAmount − changeAmount` (i.e. `amount`); tips (`tipAmount`) are **excluded** — consistent with the Sale & Tender rule that tips never enter the order total or the drawer math. `no_sale` movements are `0` and drop out. This is the single source of truth for "expected cash"; Spec 7's layer-(b) shorthand (`opening float + Σ cash tenders − Σ cash refunds/payouts`) is the same formula and defers to this one.

### Wired: `order_payments.shiftId`

The reserved-and-unused `shiftId` (`src/server/pos/tender-schema.ts`) is now populated. Inside the existing `recordSale` / `addTender` transaction (`src/server/pos/record-sale.ts`), after the device+cashier context is resolved, the writer looks up the device's active `open` shift and stamps `shiftId` on every tender it inserts. **A cash tender with no open shift is refused** (`NoOpenShiftError`) — you cannot take cash into an unaccounted drawer. Non-cash tenders (`card`/`other`) are stamped too when a shift is open, so per-shift reporting sees them, but their absence does not block the sale. No schema change is needed; the column already exists.

## Authorization

Threaded through `requirePosCashier`, which already yields `{deviceId, tenantId, branchId, cashierUserId}`.

- **Open / close your own shift, record a routine movement, submit a count** → **`pos:sell`** (the permission every cashier already holds to ring a sale). A cashier is trusted to run their own drawer.
- **Close a shift you did not open** (abandoned drawer), **approve a flagged variance**, and **authorize a `pay_out` over the per-tenant threshold** → **`reconciliation:manage`** (owner + manager, defined in the roadmap). The over-threshold pay-out also stamps `authorizedByUserId` via `resolveAuthorizer`, mirroring how Spec 1 gates a large discount/void.
- **Seeing the expected figure under blind close** → `reconciliation:manage`. The counting cashier with only `pos:sell` submits blind; the reveal is a manager action.

RLS does the rest: all three tables are FORCE RLS, so a request only ever reads/writes its own tenant's shifts through `withTenant`.

## API

POS surface, device-authenticated, under `src/app/api/pos/v1/shifts/`. **Every route runs `requirePosCashier`** (device Bearer token + `X-POS-Cashier`); there is no web-session variant.

- `POST /api/pos/v1/shifts/open` — body `{ openingFloat, denominations? }`. Takes the device advisory lock, asserts no open shift on the device, inserts `pos_shifts` (`status: 'open'`) + an `opening` `cash_counts` row, emits `shift.open`. Returns the shift. `pos:sell`. `409` if the device already has an open shift.
- `POST /api/pos/v1/shifts/close` — body `{ count: { countedTotal, denominations? } }`. Computes `expectedTotal` and `variance`, inserts a `closing` `cash_counts` row, sets `status: 'closed'` + `closedAt` + `closedByUserId`, emits `shift.close`, and returns the **Z-report** projection. Under `blindClose` the response omits `expectedTotal`/`variance` unless the caller holds `reconciliation:manage`. A variance beyond the tenant threshold marks the shift **flagged** and requires a `reconciliation:manage` approval (carried in the same call or a follow-up) to settle. Closing another's shift needs `reconciliation:manage`.
- `GET /api/pos/v1/shifts/current` — the caller device's open shift with its running **X-report** (mid-shift, **non-resetting**): live `expectedTotal` (blinded per policy), tender totals by method, movement list, sales count. A `mid_shift` `cash_counts` snapshot may be recorded by passing a count body here; it never closes the shift.
- `POST /api/pos/v1/shifts/movements` — body `{ type, amount, reasonCode, reasonText? }`. Inserts a signed `cash_movements` row, emits `cash.movement`. A `pay_out` over threshold requires the manager grant (`reconciliation:manage` + `authorizedByUserId`); otherwise `pos:sell`.

## Architecture

The drawer's life, open to Z-report. The advisory lock guards only the open (the one race that matters); everything after keys off the single open shift the index guarantees.

```
  Cashier / Device                 shifts API                     DB (withTenant, FORCE RLS)
        │                              │                                    │
  open (float) ───────────────────────►│  advisory_xact_lock(deviceId)      │
        │                              │  assert no open shift  ────────────► pos_shifts (status=open)
        │                              │  emit shift.open                    cash_counts (kind=opening)
        │◄──── shift ──────────────────│                                     │
        │                                                                    │
  sell (cash/card) ──► recordSale/addTender ──► stamp order_payments.shiftId ►│ order_payments (shiftId set)
        │                                        (no open shift ⇒ refuse cash)│
  pay_in / pay_out / safe_drop / no_sale ─► movements ─► signed row ──────────► cash_movements  (+ shift.close's peer: cash.movement)
        │                              │                                     │
  GET current  ──────────────────────►│  X-report (mid-shift, NON-resetting):│
        │◄── expected(blinded) + tender totals + movements + sales count ────│  (optional mid_shift cash_count snapshot)
        │                              │                                     │
  close (counted) ─────────────────────►│  expected = float + Σcash − refunds │
        │                              │            − payouts + payins − drops│
        │                              │  variance = counted − expected      ► cash_counts (kind=closing)
        │                              │  status=closed; emit shift.close     pos_shifts (status=closed)
        │◄── Z-REPORT ─────────────────│  ── flagged if |variance| > threshold ──► needs reconciliation:manage
             (tenders by method, cash variance, sales count,
              discounts/voids, refunds)  ──feeds──► Spec 10 reporting; Spec 7 reads closing count
```

## Error handling / edge cases

- **No open shift on a cash sale:** `recordSale` refuses with `NoOpenShiftError` before any tender is written — cash never lands in an unaccounted drawer. Card/other sales are allowed but their `shiftId` stays null.
- **Two opens racing the same device:** the advisory lock serializes them; the second sees the open shift and gets `409`. Even if the lock were bypassed, the unique partial index makes the second `INSERT` fail — belt and suspenders.
- **Double close:** closing an already-`closed` shift is rejected; the close is idempotent only in that a second call returns the existing Z-report, never a second `closing` count.
- **Blind close:** `countedTotal` is accepted without the cashier seeing `expectedTotal`; both are persisted; the response withholds expected/variance unless `reconciliation:manage`. The count itself is never re-openable — a mistaken count is corrected by a manager annotation, not an edit.
- **Variance over threshold:** the shift is marked flagged and cannot be considered reconciled until a `reconciliation:manage` holder approves; the approval is audited (`shift.close` metadata carries the approver and the variance).
- **Denomination mismatch:** if `denominations` is present and `Σ denom·qty ≠ countedTotal`, the count is rejected — the breakdown must reconcile to the total.
- **`pay_out` over threshold without a manager:** rejected with `AuthorizationRequiredError`; `resolveAuthorizer` supplies `authorizedByUserId` only when a valid grant is presented.
- **Abandoned shift (cashier gone):** a `reconciliation:manage` holder closes it (`closedByUserId ≠ openedByUserId`); this is the only cross-user close.
- **Refunds before Spec 3:** the `Σ cash refunds` term is structurally present but evaluates to `0`; when Spec 3 lands, refund tenders flow in with no formula change.
- **Money precision:** all sums use `money(n)` on `numeric`; no float. A count is compared to expected exactly; a non-zero variance of any magnitude is real (the *threshold* only governs flagging, not truth).

## Testing

- **Schema / RLS (Vitest + DB):** the unique partial index rejects a second open shift on a device; tenant A cannot see tenant B's `pos_shifts` / `cash_counts` / `cash_movements` through `withTenant`; movement `amount` sign is enforced per `type`.
- **Stamping (integration):** a cash sale through `recordSale` stamps `order_payments.shiftId` with the device's open shift; a cash sale with no open shift throws `NoOpenShiftError` and writes nothing; a card sale stamps when a shift is open and succeeds (null `shiftId`) when none is.
- **Expected-cash formula (unit, pure):** a fixture shift with a float, mixed cash/card tenders, a pay-in, a pay-out, and a safe-drop computes the exact expected; tips are excluded; a planted over and a planted short each yield a `variance` of the correct sign and magnitude.
- **Blind close (integration):** a `pos:sell` cashier's close response omits expected/variance; the same shift read by a `reconciliation:manage` holder reveals them.
- **Authorization:** open/close-own and routine movements pass with `pos:sell`; closing another's shift and an over-threshold `pay_out` are `403` without `reconciliation:manage`; the over-threshold pay-out stamps `authorizedByUserId`.
- **Audit (with Spec 4):** `shift.open`, `shift.close`, `cash.movement`, and `count` each append exactly one `audit_events` row inside the mutation's transaction and roll back if it throws.
- **Reports:** `GET current` returns a non-resetting X-report that is unchanged by being read twice; `close` returns a Z-report whose tender-by-method totals, cash variance, sales count, and discount/void figures match the shift's rows.

## Roadmap

- **Unblocks — Spec 7 (Reconciliation), layer (b):** provides `pos_shifts`, `openingFloat`, the normative expected-cash formula, blind-close `cash_counts`, and the populated `order_payments.shiftId` its cash layer and per-shift `reconciliation_runs` read directly. Spec 7's "cash reconciliation unavailable (Spec 2 pending)" placeholder is retired once this lands.
- **Feeds — Spec 10 (Cross-Channel Reporting):** the Z-report (close) and X-report (mid-shift) projections defined here are *rendered* by Spec 10 on the POS bridge; per-cashier sales and drawer counts draw on these tables.
- **Consumes — Spec 3 (Refunds & Sales History):** the `Σ cash refunds` term activates when refund tenders exist; no change to this spec's schema or formula is required.
- **Emits into — Spec 4 (Audit & Fingerprint Log):** all four event types call `recordAuditEvent` inside their transaction; if Spec 4 has not landed the emission is a no-op and the shift math is unaffected.
- **Later — multi-drawer, cash-in-transit, banking deposits:** a device with more than one physical drawer, and reconciling safe drops onward to a bank deposit, are natural extensions once the single-drawer session model is proven.
