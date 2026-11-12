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
| `type` | `sale.recorded`, `payment.added`, `shift.opened`, `shift.closed`, `cash.movement`, `count.recorded`, `grant.issued`, `session.signed_in`, `ticket.held`, `ticket.recalled`, `ticket.discarded` |
| `payload` | JSON. Every event carries `actorUserId` (who did it) and, when a manager authorized it, `authorizedByUserId`. Sales carry **full line snapshots** — product/variant/modifier ids *and* names, unit prices, per-line totals — plus order totals, the `catalogVersion` priced against, and `clientShiftId`. The snapshot is what makes till-wins replayable when the live catalog no longer matches (product unpublished, option deleted). Held tickets get a `clientTicketId`. |
| `occurred_at` | Device wall-clock at the moment of the action. Authoritative for business time on replay: the server sets `placedAt`/`closedAt`/movement timestamps from it and evaluates time-dependent checks (e.g. branch opening hours) *as of* it, never as of replay time. |
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

Roster lifecycle: pulled immediately after every successful **online** cashier
sign-in and on the periodic online timer — so a password change or deactivation
goes stale for at most one timer interval, not a full uptime. **First-boot
limitation (accepted):** a freshly paired till that has never completed one
online sign-in has an empty roster; offline sign-in is unavailable until the
first online sign-in, and the UI says so.

**Threat model (accepted risk, documented):** any paired device with a signed-in
cashier can pull scrypt hashes for every POS-capable user of the branch,
including managers/owners (required for offline overrides). A stolen till disk +
a weak owner password = offline crack opportunity. Mitigations: scrypt cost,
`safeStorage` encryption at rest (note: Linux may report available with the weak
`basic_text` backend), device revocation. Recommended follow-up (out of scope):
a separate manager PIN for till overrides, distinct from the dashboard password.

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

A small state machine: `online | offline | syncing | halted`.

- **Detection:** fetch-failure classification (the parked `api.ts` `isNetwork`
  flagging) plus a lightweight `GET /api/pos/v1/ping` heartbeat.
- **Flush order:** strictly ascending `seq`, one event at a time. A shift's sales
  must land after its `shift.opened` and before its `shift.closed`.
- **Single-flight:** at most one flush runs at a time (in-flight mutex); rapid
  disconnect/reconnect cycles must not race two flushes over the same events.
- **Transport:** `POST /api/pos/v1/sync/events` carrying an ordered batch of
  consecutive events (batch size is a client tuning knob; one is valid). Each
  event also carries its local `seq` so the server can detect per-device ordering
  gaps (`out_of_order` rejection — defense-in-depth for an invariant otherwise
  enforced only client-side). The server processes strictly in order, stops at
  the first failure, and returns per-event results; each event is idempotent on
  `(deviceId, eventId)` — resending a synced event returns the previously
  recorded result, and a concurrent-duplicate unique-key violation is answered
  as `duplicate` (re-read the stored receipt), never as a failure.
- **Network failure:** stay/return to `offline`, exponential backoff, resume from
  the first unsynced `seq`.
- **Domain rejection** (server refuses an event on business grounds): should be
  near-impossible under till-wins. If it happens, enter **`halted`**: a blocking
  operator alert, and — critically — **the halt is sticky**: while any event is
  `failed`, `flush()` sends *nothing* (not even later events), because skipping
  would orphan every event that depends on the failed one (e.g. sales inside a
  rejected shift). Resolution is explicit: retry (failed → pending) or a
  manager-authorized void, which is itself an audited event.

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

`POST /api/pos/v1/sync/events` — authenticated by **device token only**. A live
cashier token cannot exist after an outage (offline sessions are device-local
and the server never saw them), so requiring one would 401 the very flush that
ends the outage. Instead every event carries its `actorUserId`; ingest validates
the actor belongs to the device's tenant and is used for `takenByUserId`/audit
attribution. A deactivated-since-the-outage actor is **flagged, not rejected**
(till-wins). A batch may span multiple cashiers (A sells, signs out, B opens the
next shift) — the context is per-event, not per-batch.

Offline manager authorization replays the same way: `grant.issued` ingests as an
audit event (`pos.grant_issued_offline` — permission, authorizer, `occurredAt`),
and gated events (`sale.recorded` with discounts, over-threshold `cash.movement`,
cross-user `shift.closed`) carry `authorizedByUserId`, which the replay path
accepts **in place of** a live grant token — accepted only on device-authenticated
ingest, never on the live POS routes — and stamps into `posAdjustmentEvents` /
audit metadata exactly as `resolveAuthorizer` would have.

Each event processes in its own transaction, keyed idempotently on
`(deviceId, eventId)`, and translates onto the **existing domain services**
(`placeOrder`, `openShift`, `closeShift`, cash movement/count services, held
tickets) — the advisory locks, shift math, audit chain, and inventory deduction
all stay exactly where they are. **Receipt atomicity:** each replayable service
accepts a `syncReceipt` descriptor and inserts the `pos_sync_event_receipts` row
as the final statement of *its own* transaction (the table has no RLS for
exactly this reason — same pattern as `pos_order_receipts` in `recordSale`).
There is no crash window between effect and receipt for *any* event type; this
also gives cash movements, counts, and held tickets the idempotency key they
otherwise lack. Shift services gain client-ID idempotency and accept a
device-claimed `occurredAt`; the server stamps `receivedAt` separately. Business
timestamps (`placedAt`, `closedAt`, movement times) come from `occurredAt`, so
reports group offline work into the correct business day; the audit chain keeps
hashing server time (with the claimed time in metadata). Sales replay resolves
the drawer from the payload's `clientShiftId` (or server `shiftId` when the
shift was opened online) — never from "whichever shift is open at replay time" —
and tolerates the resolved shift having since closed, with a flag.

### Till-wins ingestion policy

Skipping the `TOTAL_MISMATCH` 409 is necessary but not sufficient — `placeOrder`
also re-validates lines against the **live** catalog (published flags, variant
active flags, modifier existence) and evaluates opening-hours against `now`.
On the replay path, all of that must defer to the till:

- **Line snapshots are the fallback source of truth.** When a live lookup fails
  (product unpublished/deleted mid-outage, option removed) or snapshot and live
  pricing disagree, the order records from the snapshot (names, unit prices,
  totals) and a `pos.replay.price_drift` audit event captures both sides plus
  the `catalogVersion`.
- **Time-dependent checks evaluate as of `occurredAt`**, not replay time — a
  till reconnecting at 8:30am replaying last night's sales must not be refused
  because the branch "isn't open yet". `placedAt` is set from `occurredAt`.
- Stock effects flow through the normal `deductForOrderLine` path — shortfalls
  become negative on-hand plus the existing owner/manager notification, which is
  the correct landing place for late deductions.

### Supporting changes

- **Auth sync-down:** `GET /api/pos/v1/sync/auth` returns branch-scoped cashier
  and manager records with scrypt hashes (never plaintext), for `auth_cache` —
  including `reconciliation:manage` holders, or offline overrides can't work.
- **Catalog versioning:** a **per-tenant monotonic counter**, bumped by catalog
  writes *and* by pricing-relevant settings writes (VAT, service charge, branch
  price overrides) — a `MAX(updated_at)` over catalog tables would miss
  deletions and settings changes, making drift reports cite "same catalog" when
  pricing genuinely moved.
- **Clock skew:** `occurredAt` is claimed, `receivedAt` is truth; events skewed
  more than 48h are flagged for review, not rejected.
- **Offline sign-in audit:** `session.signed_in` events (including failed
  attempts) replay into the audit chain as `auth.cashier_signed_in` /
  `auth.login_failed` with `occurredAt` in metadata, so offline sessions don't
  vanish from history.

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

The POS subscribes from **Electron main** (which owns all networking) and
forwards signals to the renderer over IPC — the Vite renderer never needs
Supabase envs or a socket of its own. Channel hygiene: use Supabase private
channels (topic authorization) so an anon-key holder cannot subscribe to another
tenant's `tenant:{uuid}` topic; payloads are IDs-only either way, so the
exposure being closed is activity timing, not data. Operational notes: every
open dashboard tab, storefront status page, and till holds one Realtime
connection — watch the plan's concurrent-connection cap; the server-side
broadcast is an awaited `fetch` (~50–200ms) on order-placing requests, priced in
deliberately (fire-and-forget loses the failure signal on serverless).

## Operator-visible behavior

- Connectivity badge: `online / offline / syncing (N queued) / halted`.
- Works identically offline: sign-in, sales, receipts, this till's held tickets,
  manager overrides, cash movements, open/close drawer, local X/Z reports.
- **Not available offline** (server-backed; shown as disabled with a notice, not
  broken): new web orders in the queue, refunds, sales history/reprint of synced
  orders, and held tickets parked on *other* tills.
- Offline receipts print a short client code (from `clientOrderId`) instead of
  the server order number, which doesn't exist yet — the code is searchable
  later via `pos_order_receipts` for lookups/refunds.
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
| App reinstall / data wipe | Deleting the SQLite file while unsynced events exist is the same loss window as device death — acknowledged, same mitigation (aggressive flush). `pos-device.json` surviving a reinstall does not recover the log. |
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
