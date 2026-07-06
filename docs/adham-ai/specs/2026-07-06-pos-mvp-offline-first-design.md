# ServeOS POS — MVP (Offline-First Desktop) Design

**Date:** 2026-07-06
**Status:** Approved (design) — pending implementation plan
**Scope:** New cross-platform desktop POS app (`apps/pos/`) + supporting sync API and dashboard pairing UI in the existing web app. This is **v1 / MVP** of a multi-spec POS effort.

## Problem

ServeOS has a customer storefront and an owner dashboard, but no way for staff to take **in-store** (walk-in / counter) orders. Restaurants need a real point-of-sale that runs on the counter machine, keeps working when the internet drops, and feeds sales into the same order pipeline the dashboard and analytics already use.

## Goal

Ship a **lean but real POS** for **Windows and macOS** that a cashier can use to build an order, take cash payment, print a receipt, and have that sale appear in the existing dashboard Orders queue and analytics — **working offline** and syncing when connectivity returns. The architecture must be **scalable** (clean layering, versioned API) so later specs (hardware, card payments, staff shifts, auto-update) layer on without rework.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Platform | Native desktop, **Electron**, Windows + macOS |
| Repo layout | **Same repo**, new `apps/pos/`, convert to **npm workspaces** |
| Renderer | **Vite + React + Tailwind**, reusing the web app's Tailwind theme tokens and `components/ui` primitives (shared, not duplicated) |
| Data model | **Offline-first from v1**: local **SQLite** (better-sqlite3) in the Electron main process |
| Order backend | POS orders flow into the **existing `orders` table via `placeOrder`** — they appear in the dashboard Orders queue + analytics |
| Device auth | **Device pairing**: dashboard issues a pairing code; app exchanges it for a long-lived **device token** (reuses the `sessions` table) bound to `tenantId` + `branchId` |
| Sync API | New **versioned** endpoints `/api/pos/v1/*` in the web app; order push is **idempotent** via a client-generated `clientOrderId` |
| Payment (v1) | **Cash only** → mark the order paid |
| Receipt (v1) | On-screen receipt + **OS print dialog** (any default/thermal printer). No ESC/POS hardware control |
| Fulfillment (v1) | **Pickup / dine-in only** (maps to `placeOrder` `fulfillmentType: "pickup"`) |
| Customer (v1) | **"Walk-in"** placeholder name; phone optional/placeholder |
| Packaging | electron-builder, **auto-update-ready** (electron-updater-compatible), but no update server yet |

## Non-goals (this spec — deferred to later POS specs)

- ESC/POS hardware: direct thermal printing, cash-drawer kick, barcode scanner.
- Card / digital payments; refunds, voids, discounts, split bills.
- Per-staff PIN / shift attribution / clock-in; multiple concurrent cashiers per device.
- Delivery orders from the POS; table management / floor plan; kitchen display (KDS).
- Auto-update **server**, code signing, Apple notarization, Windows certificate (org/ops work).
- Conflict resolution beyond append-only orders + pull-only catalog.
- Fleet/device management UI beyond issuing/revoking a pairing.

## Architecture

Three layers, one typed contract between them:

```
┌─ Renderer (Vite/React/Tailwind) ─┐   IPC (typed preload bridge)   ┌─ Main process ─────────────┐
│  Order-entry UI, cart, payment,  │ <───────────────────────────> │  SQLite (catalog cache,    │
│  receipt, offline banner          │                               │  order_outbox, device),    │
└──────────────────────────────────┘                               │  sync engine               │
                                                                    └──────────────┬─────────────┘
                                                                                   │ HTTPS
                                                                    ┌──────────────▼─────────────┐
                                                                    │  Web app  /api/pos/v1/*     │
                                                                    │  pair · catalog · orders    │
                                                                    │  → existing placeOrder      │
                                                                    └────────────────────────────┘
```

- **Renderer** never talks to the network or SQLite directly. It calls a small, typed API exposed by `preload` (e.g. `pos.getMenu()`, `pos.submitOrder(draft)`, `pos.onSyncState(cb)`). This keeps the UI testable and swappable and is the boundary that lets the app grow.
- **Main process** owns all state: the SQLite database, the device token (stored via Electron `safeStorage`), and the sync engine. It is the only layer that reaches the cloud.
- **Cloud sync API** lives in the existing Next app so it sits next to the `placeOrder`/catalog code it reuses.

### Workspace layout

Convert the repo to npm workspaces. The existing Next app stays at its current path (root app) and a new `apps/pos/` is added; a small shared surface (Tailwind preset + the handful of `ui` primitives + POS API types) is referenced by both. Exact placement (root-app-plus-`apps/pos` vs moving web into `apps/web`) is chosen at plan time to minimize churn; the workspace must not break the web app's existing build, tests, or Vercel deploy.

## Backend: device auth + sync API (new, in the web app)

All under `/api/pos/v1/`. Device-authenticated requests carry `Authorization: Bearer <deviceToken>`.

- **Pairing UI:** new dashboard page **Settings → POS devices** (`menu:manage` permission). Lists paired devices; a "Pair a device" action generates a short-lived pairing **code** tied to `tenantId` + a chosen `branchId`.
- `POST /api/pos/v1/pair` — body `{ code }`. Validates the unexpired code, creates a long-lived device session (in `sessions`, flagged/named as a device), returns `{ deviceToken, tenantId, branchId, branchName }`. Code is single-use.
- `GET /api/pos/v1/catalog` — device-auth'd. Returns the full menu for the device's branch: categories, published products, modifier groups/options, prices, image URLs, plus a `version`/`syncedAt` marker.
- `POST /api/pos/v1/orders` — device-auth'd. Body includes `clientOrderId` (UUID from the device) for **idempotency**. Maps the POS draft to `PlaceOrderInput` (`branchId` from the device, `fulfillmentType: "pickup"`, `customerName: "Walk-in"`, `lines`), calls `placeOrder`, then `markPaid` for cash. Returns `{ orderId, orderNumber }`. A repeated `clientOrderId` returns the original result rather than creating a duplicate.

Device token validation reuses `validateSession`; a thin `requirePosDevice()` helper resolves `{ tenantId, branchId }` from the token and is the analog of `requireDashboardUser`.

## Local store + sync engine (offline-first)

**SQLite** (better-sqlite3) in the main process, tables:
- `catalog_cache` — the last pulled menu payload (+ `synced_at`), read by the UI so it renders instantly and offline.
- `order_outbox` — append-only rows: `clientOrderId`, JSON draft, `status` (`pending` | `synced` | `failed`), `orderNumber` (once synced), timestamps, error.
- `device` — one row: encrypted device token, `tenantId`, `branchId`, `branchName`.

**Sync engine** (main process):
- **Pull:** on launch, on reconnect, and on an interval — `GET catalog` → overwrite `catalog_cache`. Pull-only, so no conflicts.
- **Push:** flush `pending`/`failed` outbox rows to `POST orders` (idempotent). On success mark `synced` and store `orderNumber`; on network failure keep `pending`; on a validation error mark `failed` and surface it.
- **State:** exposes `online | offline | syncing` + pending count to the renderer for an offline banner and per-ticket status. Reachability = last successful call + `navigator.onLine` signal.

Because orders are append-only and idempotent, an order taken offline is never lost and never duplicated on retry.

## POS UI (renderer) — v1 scope

- **Pairing screen:** enter pairing code → confirm branch. Shown until a device token exists.
- **Order-entry screen (primary):** category tabs, product grid (name, price, image), tap to add; a **modifier sheet** when a product has modifier groups (reusing the storefront modifier-selection logic/shape); a **cart** with quantity edit and running total; **"Charge (cash)"** → payment confirm → mark paid → **receipt** (on-screen + OS print) → clears cart.
- **Recent tickets:** list from `order_outbox` with sync status (synced # / pending / failed).
- **Offline banner** when the sync engine reports `offline`, plus a pending-sync count.

## Data flow (a sale)

1. Cashier builds a cart in the renderer (data from `catalog_cache`).
2. On "Charge", renderer calls `pos.submitOrder(draft)`; main writes a `pending` row to `order_outbox` with a fresh `clientOrderId` and returns immediately (works offline).
3. Renderer shows the receipt and clears the cart.
4. Sync engine flushes the outbox → `POST /api/pos/v1/orders` → `placeOrder` + `markPaid` → row becomes `synced` with the real `orderNumber`; the sale now appears in the dashboard Orders queue and analytics.

## Error handling / edge cases

- **Offline at charge time:** order is queued locally; receipt prints; syncs later. Never blocks the sale.
- **Duplicate submit / retry:** idempotent `clientOrderId` returns the original order.
- **Server validation failure** (e.g. product no longer exists): outbox row → `failed`, surfaced in Recent tickets with the reason; does not crash the app.
- **Token invalid/revoked:** app returns to the pairing screen.
- **Stale catalog offline:** UI shows the last `synced_at`; sales still allowed against cached prices.
- **`placeOrder` requires customer fields:** POS passes `"Walk-in"` and a placeholder phone; if `placeOrder` rejects an empty phone, use a constant placeholder (decided at plan time, no schema change).

## Testing

- **Backend (Vitest, existing harness):** `/api/pos/v1/pair` (valid/expired/reused code), `catalog` (device-auth, branch scoping), `orders` (maps to `placeOrder`, cash `markPaid`, **idempotency** on repeated `clientOrderId`, rejects bad token).
- **Sync engine + outbox (Vitest, pure TS, no Electron):** state machine — queue while offline, flush on reconnect, idempotent retry, `failed` on validation error.
- **Renderer (component tests where practical):** cart math, modifier selection, receipt contents.
- **Manual v1 acceptance checklist:** pair a device → build order with modifiers → charge cash → receipt prints → order appears in dashboard Orders + analytics → repeat offline (airplane mode) → reconnect → order syncs exactly once.

## Roadmap (later specs, not this one)

1. **Hardware & payments:** ESC/POS thermal printing, cash drawer, card/digital payment, refunds/voids/discounts.
2. **Staff & operations:** per-staff PIN/shift attribution, multiple cashiers, table/floor management, KDS.
3. **Release engineering:** auto-update server, code signing (Apple notarization + Windows cert), device fleet management.
