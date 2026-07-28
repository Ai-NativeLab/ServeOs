# ServeOS — POS Drawer Screens Design

**Date:** 2026-07-28
**Status:** IMPLEMENTED (2026-07-28) — built as specified; see the "Built" note at the end for the two details that only surfaced during implementation.
**Scope:** The Electron POS front end for Spec **2 (Shifts & Cash Drawer)**. Spec 2 shipped the tables, services, and `/api/pos/v1/shifts/*` routes; a cashier still has no way to reach any of it. This spec covers opening a drawer, moving cash in and out, reading the live X-report, and counting the drawer closed. It builds **no new server behaviour** — every rule already exists and is tested behind the API.

## Context

Spec 2 (`docs/ailab/specs/2026-07-24-shifts-and-cash-drawer-design.md`, implemented in PR #27) delivered:

- `pos_shifts`, `cash_counts`, `cash_movements` with FORCE RLS, one open shift per device.
- `openShift`, `closeShift`, `recordCashMovement`, `recordMidShiftCount`, `buildXReport`.
- `POST /api/pos/v1/shifts/open`, `POST /close`, `GET|POST /current`, `POST /movements`.
- `order_payments.shiftId` stamped on every tender; cash refused with `409` when no drawer is open.

The POS app (`apps/pos`) is a Vite + React + Tailwind renderer talking to Electron main over a `window.pos.*` bridge (`apps/pos/electron/preload.ts`), which calls the API with the device Bearer token and `X-POS-Cashier` header (`apps/pos/electron/pos-main.ts`). Its shell (`apps/pos/src/App.tsx`) is a view switcher over three tabs — Take order, Live orders, Parked — behind a pairing gate and a cashier sign-in gate.

## Problem

Every drawer rule is enforced server-side and unreachable from the till. A cashier cannot open a drawer, so cash sales fail with a `409` the payment screen renders as a generic error. Managers cannot count or close. The accountability Spec 2 built is, in practice, switched off.

## Goal

Give a cashier the four things a real till needs — open with a float, move cash, see where the drawer stands, count it closed — using only the existing API, with the server remaining the single source of every number.

## Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| D1 | When the drawer opens | **Prompt after cashier sign-in, skippable.** A drawer is offered, not forced: card-only sales are legal without a shift and the server permits them. A cash tender without a drawer returns `409`, which the payment screen turns into an explicit prompt. |
| D2 | Where drawer actions live | **A fourth "Drawer" tab** beside Take order / Live orders / Parked, holding the X-report, the cash movement actions, Count drawer, and Close drawer. |
| D3 | Who computes the money | **The server, always.** The renderer displays `report.cash.expected`, `counted` and `variance` as returned. The one place the client does arithmetic is summing a denomination pad into a counted total the cashier is about to submit. |
| D4 | Blind close | **No client logic.** The server already returns `expected` and `variance` as `null` for a cashier without `reconciliation:manage`; the screen omits the rows when they are null. The client never infers a hidden number. |
| D5 | Manager approval | **Reuse the existing grant flow.** `ManagerAuthModal` + `window.pos.authorize` already back Spec 1's discount escalation. A `403` from a pay-out or a close escalates through it and retries with the grant. |

## Non-goals (deferred by explicit decision)

- **Report rendering beyond the till** — manager-facing X/Z reporting on the web dashboard is Spec 10.
- **Printing** — no ESC/POS receipt or Z-report printing; peripheral hardware is roadmap backlog item 5.
- **Offline drawer operation** — `apps/pos/electron/_offline/` is parked; the drawer is online-first like the rest of the POS.
- **Shift policy administration** — `blindClose`, `payoutThreshold` and `varianceThreshold` live in `tenant_settings` and are set outside the POS; no dashboard editor here.
- **Component tests** — `apps/pos` has vitest but no jsdom or React Testing Library, and its existing tests (`cart.test.ts`, `payment.test.ts`) are pure logic. Adding a DOM testing stack is a separate decision, not a side effect of this feature.

## Bridge

Four methods on `window.pos`, each a thin pass-through in `pos-main.ts` following the existing `recordSale` pattern (device token + cashier header, JSON in, JSON or thrown error out):

| Method | Route | Returns |
|---|---|---|
| `openShift(openingFloat, denominations?)` | `POST /shifts/open` | `{ shift }` |
| `currentShift()` | `GET /shifts/current` | `{ shift, report }` or `{ shift: null, report: null }` |
| `countDrawer(countedTotal, denominations?)` | `POST /shifts/current` | `{ count, report }` |
| `closeShift(count, grants?)` | `POST /shifts/close` | `{ report }` |
| `cashMovement(input)` | `POST /shifts/movements` | `{ movement }` |

Errors keep their status so the renderer can distinguish them: `409` (no drawer / already open / already closed), `403` (needs a manager), `400` (count does not add up).

## Screens

### `OpenDrawerScreen`
Shown after sign-in when `currentShift()` reports no open drawer. A float amount, an optional denomination pad, **Open drawer** and **Skip**. Skip goes straight to selling.

### `DrawerScreen` (the new tab)
The live X-report, re-fetched on entry and after every action:

- Opened at / by, opening float.
- **Expected cash**, tenders by method (amount, tips, count), sales count, discounts.
- The movement list for the shift.
- Actions: **Pay in**, **Pay out**, **Safe drop**, **No sale**, **Count drawer**, **Close drawer**.

With no open drawer it shows an empty state with **Open drawer**.

### `CashMovementModal`
Type, amount, reason code, optional note. A positive magnitude is always entered — the sign is the server's business (Spec 2 signs by type so the DB `CHECK` and the expected-cash formula cannot disagree). A `403` opens the manager modal and retries once with the grant.

### `CloseDrawerScreen`
Counted total plus optional denomination pad, then the Z-report: tenders by method, movements, sales count, and — when the server returns them — expected, counted and variance, with an over/short label. A `400` means the denominations disagree with the counted total; a `403` escalates to a manager; a `409` means someone else closed it first, which re-fetches and shows the closed state.

### `PaymentScreen` (modified)
The existing `409` on a cash tender becomes an explicit "Open a drawer to take cash" with a jump to the Drawer tab, instead of a generic failure. This is the one change outside the new screens, and it is what makes D1's skip safe.

## Testing

- **`apps/pos/src/drawer/counting.ts`** — pure: denominations to total, counted-total parsing and validation, over/short labelling. Unit-tested like `cart.ts`, including the case where a denomination pad disagrees with a typed total (the client-side mirror of `CashCountMismatchError`).
- **No component tests**, per the non-goal above.
- **Manual acceptance** walks the Spec 2 acceptance path from the till: open with a float, ring a cash sale, move cash in and out, read the X-report twice and confirm it does not change, count mid-shift, close and read the Z-report, and confirm a blind-close cashier sees no variance while a manager does.

## Built

Two things only became clear while building, both worth recording:

1. **Electron's IPC serializes a thrown `Error` down to its message** — custom
   properties such as `code` do not cross the boundary. The pre-existing
   `e.code = "TOTAL_MISMATCH"` in `recordSale` therefore never reached the
   renderer either. The drawer calls return a `DrawerResult` discriminated union
   instead, which is what lets the renderer tell *needs a manager* from *already
   closed* structurally rather than by matching error strings.
2. **The cash guard is a state check, not an error handler.** Rather than
   catching the server's 409, the payment screen is told whether a drawer is open
   and blocks a cash tender up front, offering to open one. The server still
   enforces; this only means the cashier learns before the customer hands over
   notes. It also avoids depending on a server message string.

Shipped as `CloseDrawerModal` rather than a full-screen `CloseDrawerScreen` —
the close is a focused interruption of the drawer view, not a destination.

## Open questions

1. **Does a cashier signing out with an open drawer get prompted to close it?** Deferred; the drawer legitimately outlives a sign-out when a shift is handed over, and the roadmap's staff time-clock (backlog item 9) is where handover belongs.
2. **Should the Drawer tab be hidden for a cashier without `pos:sell`?** Every POS user holds `pos:sell` today, so the question is moot until a read-only till role exists.
