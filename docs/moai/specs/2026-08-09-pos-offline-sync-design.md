# POS Offline-First Operation & Platform Sync Propagation — Design

**Date:** 2026-08-09
**Status:** Approved (design); implementation plan to follow
**Owner surfaces:** `apps/pos` (Electron), `src/server/pos`, `src/app/api/pos/v1`, dashboard/queue/storefront subscribers

## Problem

The POS is strictly online-first: every action — loading the menu, recording a sale,
opening the drawer — is a live REST call from Electron main to the cloud backend.
When the network drops, the till stops selling. `docs/ROADMAP.md` lists this as the
top POS backlog item. A complete SQLite offline store was built and parked at
`apps/pos/electron/_offline/` (db, store, sync engine, network-error classifier,
tests) with zero live imports; `electron/pos-main.ts` documents itself as the seam
it should return through.

Separately, nothing in the platform *hears* about new data: the dashboard polls
every 8s, the storefront status page every 5s, the POS queue every 8s. When an
offline till reconnects and syncs a batch of sales, every other surface should
update within seconds, not on the next poll.

## Decisions (locked with the user)

| # | Question | Decision |
|---|----------|----------|
| D1 | Offline scope | **POS terminal only.** Dashboard/storefront/admin stay online-only; they get live propagation instead of offline capability. |
| D2 | Drawer lifecycle | **Everything offline on day one** — sales, shift open/close, cash movements, counts, manager authorizations, cashier sign-in. Not a selling-only v1. |
| D3 | Propagation | **Supabase Realtime** per-tenant broadcast channels; subscribers refetch on signal; existing polling retained as a relaxed-interval fallback. |
| D4 | Replay conflicts | **Till wins.** A replayed sale is accepted at the totals the till charged. Price drift is recorded and reported, never re-priced. Stock shortfalls use the existing negative-on-hand + notification path. |
| D5 | Engine architecture | **Revive the parked outbox as an append-only event log** (approach A). No third-party sync framework, no local store server. |

## The ownership rule

> During a partition, the device is the authority for everything that physically
> happened at its till; the cloud is the system of record that ingests those facts
> on reconnect — it may flag, never veto.

This holds because writes are naturally partitioned: exactly one device owns one
cash drawer. There are no multi-writer conflicts to merge, so the sync problem
reduces to **ordered, idempotent replay of an event log** — no CRDTs, no vendor
sync engine.

## Client architecture (Electron main process)

`better-sqlite3` is promoted from `optionalDependencies` to a real dependency of
`apps/pos`. All storage and sync lives in Electron main behind the existing
`PosMain` surface — the renderer keeps calling `window.pos.*` and cannot tell
whether the device is online.

### Tables

**`local_events`** — the heart of the design. Append-only.

| column | meaning |
|--------|---------|
| `event_id` | UUID minted when the event is created. This is the idempotency key end-to-end. |
| `seq` | Local monotonic integer. Defines replay order. |
| `type` | `sale.recorded`, `payment.added`, `shift.opened`, `shift.closed`, `cash.movement`, `count.recorded`, `grant.issued`, `ticket.held`, `ticket.recalled`, `ticket.discarded` |
| `payload` | JSON. For sales: full draft, totals, `catalogVersion` priced against, `clientShiftId`. |
| `occurred_at` | Device wall-clock at the moment of the action. |
| `status` | `pending` → `synced` \| `failed` (+ `server_response` JSON) |

Every operator action writes here **first**, online or offline. Online mode means
the flush happens immediately after; there is one write path, not two.

**`catalog_cache`** — published menu + `CheckoutPricing` + server-issued
`catalogVersion`. Refreshed on boot, on a timer while online, and on reconnect.

**`auth_cache`** — the branch's cashiers and managers: user id, name, role,
permissions, and their **scrypt password hashes**, synced down while online. This
is what makes offline cashier sign-in and offline manager authorization possible.
Sensitive columns are encrypted with a key held in Electron `safeStorage` (the
same mechanism protecting `pos-device.json` today).

**`local_state`** — materialized "now": open shift (client id, opened-at, opening
float), X-report running totals, held tickets. Never authoritative — it is rebuilt
on boot by replaying unsynced `local_events` over the last server-confirmed
snapshot, so a crash mid-outage loses nothing.

### Client-minted identity

Entities created offline get client UUIDs: `clientOrderId` (minted at **draft
creation**, not send time — moving it is part of this work) and `clientShiftId`.
Sales carry the `clientShiftId` they occurred under; the server resolves it to the
server-side shift row during ingest.

## Sync engine

A small state machine: `online | offline | syncing`.

- **Detection:** fetch-failure classification (the parked `api.ts` `isNetwork`
  flagging) plus a lightweight `GET /api/pos/v1/ping` heartbeat.
- **Flush order:** strictly ascending `seq`, one event at a time. A shift's sales
  must land after its `shift.opened` and before its `shift.closed`.
- **Transport:** `POST /api/pos/v1/sync/events` carrying an ordered batch of
  consecutive events (batch size is a client tuning knob; one is valid). The
  server processes strictly in order, stops at the first failure, and returns
  per-event results; each event is idempotent on `(deviceId, eventId)` —
  resending a synced event returns the previously recorded result.
- **Network failure:** stay/return to `offline`, exponential backoff, resume from
  the first unsynced `seq`.
- **Domain rejection** (server refuses an event on business grounds): should be
  near-impossible under till-wins. If it happens, **halt the flush** and surface a
  blocking operator alert — skipping would orphan every later event that depends
  on it (e.g. sales inside a rejected shift). Failed events require explicit
  resolution, not silent drops.

## Server-side changes

### Prerequisites folded into this work

1. **Cashier sessions and manager grants move from in-process `Map`s to DB tables**
   (`src/server/pos/cashier.ts`, `grants.ts`). This also fixes the live serverless
   bug where a sign-in on one instance 401s on the next.
2. **`recordSale` becomes a single transaction** including the
   `pos_order_receipts` idempotency row (`src/server/pos/record-sale.ts` is three
   sequential transactions today; a crash between them makes a same-key retry
   duplicate the sale). `pos_order_receipts` already has no RLS specifically so it
   can join the tenant transaction.

### New ingestion path

`POST /api/pos/v1/sync/events` — authenticated by device token + cashier token as
today. Each event processes in its own transaction, keyed idempotently on
`(deviceId, eventId)`, and translates onto the **existing domain services**
(`placeOrder`, `openShift`, `closeShift`, cash movement/count services, held
tickets) — the advisory locks, shift math, audit chain, and inventory deduction
all stay exactly where they are. Shift services gain client-ID idempotency and
accept a device-claimed `occurredAt`; the server stamps `receivedAt` separately.
Reports group by `occurredAt`; the audit chain keeps hashing server time (with the
claimed time in metadata).

### Till-wins ingestion policy

Events flagged as offline replays skip the `TOTAL_MISMATCH` 409: the sale is
recorded at the till's totals together with the `catalogVersion` it priced
against. Price drift emits an audit event and is queryable for reporting. Stock
effects flow through the normal `deductForOrderLine` path — shortfalls become
negative on-hand plus the existing owner/manager notification, which is the
correct landing place for late deductions.

### Supporting changes

- **Auth sync-down:** `GET /api/pos/v1/sync/auth` returns branch-scoped cashier
  and manager records with scrypt hashes (never plaintext), for `auth_cache`.
- **Catalog versioning:** the catalog response gains a monotonic `catalogVersion`.
- **Clock skew:** `occurredAt` is claimed, `receivedAt` is truth; events skewed
  more than 48h are flagged for review, not rejected.

## Propagation — Supabase Realtime

After any state-changing write (a sync batch lands, a web order is placed, a
status changes, stock moves), the server publishes a compact broadcast —
`{ type, entityType, entityIds }` — to a per-tenant Supabase Realtime channel
(`tenant:{tenantId}`). Payloads carry **ids only**; subscribers refetch through
their existing authenticated endpoints, so RLS and permission checks are never
bypassed.

Subscribers: dashboard orders table, payments review page, inventory/stock
screens, POS OrdersQueue (online mode), storefront order-status page. Existing
polling drops to a relaxed 60s fallback so a Realtime outage degrades to today's
behavior, never worse.

## Operator-visible behavior

- Connectivity badge: `online / offline / syncing (N queued)`.
- Everything works identically offline — sign-in, sales, receipts, held tickets,
  manager overrides, cash movements, open/close drawer, local X/Z reports — except
  **seeing new web orders**, which is impossible by definition and shown as a
  degraded-queue notice.
- Server reconciliation never overwrites a local Z-report; discrepancies surface
  as flagged differences.

## Edge cases

| Case | Handling |
|------|----------|
| Crash mid-outage | Events hit SQLite before the UI confirms; `local_state` rebuilds from the log on boot. |
| Long outage, stale prices | Till-wins by policy; drift recorded and reported. |
| Multi-terminal branch | Each device has its own drawer, log, and idempotency scope — disjoint by construction. |
| Local disk full/corrupt | Sales are blocked with an explicit error (never silently unqueued); catalog cache is rebuildable. |
| Device retirement | Revoking the device (existing flow) after a final sync; unsynced events on a dead device are the accepted loss window, mitigated by aggressive flush-on-any-connectivity. |
| Retention | Synced events pruned locally after 30 days; the server is the permanent record. |

## Testing

- **Unit (client):** event-log reducer (state rebuild determinism), flush ordering,
  backoff, `occurredAt` handling. The `_offline` exclusion in
  `apps/pos/vitest.config.ts` is removed.
- **Integration (server, real Postgres + RLS):** ingest idempotency (same batch
  twice → byte-identical state), ordering violations rejected, till-wins drift
  recording, full offline shift lifecycle producing correct Z-reports, audit
  events, and inventory effects.
- **End-to-end:** scripted "pull the network mid-shift" run — open shift → sell →
  kill network → sell + cash movement + close shift → restore network → assert
  server state, reports, notifications, and Realtime fan-out to a subscribed
  dashboard.

## Build order (single release, sequenced to de-risk)

1. Server prerequisites: sessions/grants → DB; single-transaction `recordSale`
   (each independently valuable and shippable).
2. Ingestion endpoint + idempotent shift services + auth sync-down + catalog
   version.
3. Client store, event log, reducer, offline auth.
4. Sync engine + connectivity handling.
5. POS UI states (badge, queue counts, halt alerts).
6. Supabase Realtime publisher + subscriber hooks (dashboard, queue, storefront).
7. Hardening: clock skew, retention, cache encryption, flush-halt alerting.

## Explicitly out of scope

- Offline dashboard/storefront/admin (D1).
- Cross-device or store-LAN coordination (no local server; D5).
- Payment gateway integration (no gateway exists yet; tenders remain cash/card-label/other).
- Replicache/PowerSync/ElectricSQL adoption (D5 rationale: they solve multi-writer
  merging this domain does not have, and the invariants live in domain services
  regardless).
