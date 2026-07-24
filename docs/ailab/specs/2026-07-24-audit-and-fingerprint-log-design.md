# ServeOS — Audit & Fingerprint Log Design

**Date:** 2026-07-24
**Status:** Draft — pending review
**Scope:** Spec 4 of the core POS & operations roadmap (`docs/ROADMAP.md`). It builds the tenant-side operational audit trail mandated by locked decision **D1**: every mutating action lands an **append-only, hash-chained (tamper-evident)** row carrying a **device/session fingerprint**. It has no dependency on the unwritten Specs 2/3 and can start immediately. The platform `audit_logs` table (`src/server/platform/audit.schema.ts`) is untouched and continues to serve super-admin actions; this spec adds a *separate*, tenant-scoped log alongside it.

## Context

Today there is exactly one audit surface: the platform `audit_logs` table, written **only** by super-admin control-plane actions. There is no tenant-side trail. When a cashier voids a `250 EGP` line, changes an order's status, or an owner rewrites a menu price, nothing durable records *who*, *from which device*, *at what app version*, or *from what IP* — and nothing makes the record hard to alter after the fact.

Spec 1 (Sale & Tender) already gave us the two ingredients we need. `recordSale` (`src/server/pos/record-sale.ts:51`) writes an append-only discount/void trail (`pos_adjustment_events`) with `byUserId`/`authorizedByUserId`, and `placeOrder` (`src/server/ordering/service.ts:59`) already serializes a per-tenant sequence under `pg_advisory_xact_lock(hashtext(tenantId)::bigint)` for order numbers. This spec generalizes the "append-only, attributed, per-tenant-serialized" idea into one chain that spans every mutation, not just POS adjustments.

## Problem

An append-only trail that a database admin (or a compromised app) can silently `UPDATE` or `DELETE` is not evidence — it is a suggestion. `pos_adjustment_events` records *that* a discount happened, but a row can be edited or removed with no trace, and it says nothing about the terminal or the network the action came from. For dispute resolution, staff fraud investigation, and eventual compliance, ServeOS needs a log where (a) any post-hoc mutation is **detectable**, and (b) every entry carries a **fingerprint** of the device and session that produced it.

## Goal

One tenant-scoped log — `audit_events` — that every mutating write appends to **inside its own transaction**, so the audit row is atomic with the change it records. Each row is linked to its predecessor by a SHA-256 hash chain, so removing or editing any row breaks every hash after it. Each row carries `{deviceId, deviceTokenHash, appVersion, ip, userAgent}`. A DB trigger makes `UPDATE`/`DELETE` fail outright, and a periodic verifier walks each tenant's chain and reports the first broken link. Reads are gated behind a new `audit:view` permission (owner + manager).

## Decisions (locked)

| Decision | Choice |
|---|---|
| Chain model | **Per-tenant hash chain.** `audit_chain_heads` holds `(tenantId, seq, headHash)`; each `audit_events` row carries `prevHash`/`entryHash`. |
| Atomicity | **`recordAuditEvent(ctx, {...})` runs in the same transaction as the mutation.** The audit row commits with the change or not at all. |
| Serialization | **Per-tenant advisory lock**, `pg_advisory_xact_lock(hashtext(tenantId)::bigint)` — the exact pattern `placeOrder` uses for order numbers. No global lock. |
| Hash | **`entryHash = sha256(canonical(prevHash, seq, tenantId, actorUserId, action, entityType, entityId, metadata, createdAt))`.** Genesis `prevHash` = 64 zeros. |
| Tamper-evidence | **A DB trigger raises on `UPDATE`/`DELETE`** of `audit_events`, **plus** a periodic verifier that walks each chain and reports the first break. |
| Fingerprint | **Captured at the API boundary, threaded through `ctx`.** POS sends a new `X-POS-App-Version` header; web derives from session + `User-Agent` + IP. The device token is stored **hashed**, never raw. |
| Authorization | **New `audit:view` permission (owner + manager).** Reads go through `withTenant`. |
| Coexistence | **`audit_events` is tenant-scoped (FORCE RLS) and independent of the platform `audit_logs` table**, which stays for super-admin actions. Neither replaces the other. |

## Non-goals (deferred by explicit decision)

- **Hash-anchoring the daily close** into the chain → Spec 7 (Reconciliation) will emit a `reconciliation.closed` event; the anchoring hook lives there.
- **Auditing inventory ledger / lot mutations** → Spec 8, and **PO lifecycle events** → Spec 9, and **refund events** → Spec 3. Each spec adds its own emission points; the helper and chain are ready for them now.
- **Emailing a tamper alert** when the verifier finds a break → Spec 5 (Notifications & Outbound Email). Until then the verifier logs and surfaces status via the read API.
- **A rich log-viewer UI / CSV export** → a minimal paginated read API ships here; the manager reporting surface is Spec 10.
- **External log shipping / SIEM streaming, keystroke or behavioural logging, PII beyond the fingerprint.** Out of scope entirely.

## Data model

### New: `audit_events`

Append-only, tenant-scoped, `FORCE ROW LEVEL SECURITY`. One row per mutating action. Never updated, never deleted (the trigger enforces this).

| Column | Notes |
|---|---|
| `id` | uuid, pk |
| `tenantId` | uuid → `tenants.id`, not null; RLS key |
| `branchId` | uuid → `branches.id`, **nullable** — null for tenant-wide actions (menu, settings) |
| `actorUserId` | uuid → `users.id`, **nullable** — null for `system`/`customer`/`device` actors |
| `actorType` | enum `audit_actor_type`: `user \| system \| device \| customer` |
| `action` | text, dotted verb — e.g. `sale.recorded`, `order.status.changed`, `discount.applied` |
| `entityType` | text — `order`, `payment`, `menu_item`, `staff`, `settings`, … |
| `entityId` | text — the affected row's id (text so non-uuid keys fit) |
| `summary` | text — short human line for the log viewer |
| `metadata` | jsonb — structured context; `{before, after}` where a value changed |
| `fingerprint` | jsonb — `{deviceId, deviceTokenHash, appVersion, ip, userAgent}` |
| `seq` | bigint — per-tenant monotonic position in the chain |
| `prevHash` | char(64) — `entryHash` of the previous row; 64 zeros at genesis |
| `entryHash` | char(64) — sha256 over the canonical serialization (see Architecture) |
| `createdAt` | timestamptz, default `now()` — set by the DB inside the tx, part of the hash |

Unique index on `(tenantId, seq)`. Read index on `(tenantId, createdAt)` and `(tenantId, entityType, entityId)`. RLS policy mirrors every other tenant table: `USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)` with the same `WITH CHECK`.

### New: `audit_chain_heads`

One row per tenant — the current tip of that tenant's chain. Read-and-advanced under the advisory lock inside the same append transaction.

| Column | Notes |
|---|---|
| `tenantId` | uuid → `tenants.id`, **primary key** — one row per tenant |
| `seq` | bigint — the `seq` of the most recent `audit_events` row (0 before genesis) |
| `headHash` | char(64) — the `entryHash` of that row; 64 zeros before genesis |
| `updatedAt` | timestamptz |

`FORCE ROW LEVEL SECURITY`, same isolation policy. Unlike `audit_events`, this row **is** updated (it is the mutable pointer); the tamper-evidence trigger applies to `audit_events` only. Integrity is proven by re-walking the chain, not by trusting the head.

## Authorization

Extend `src/server/rbac/permissions.ts`:

- Add `audit:view` to `PERMISSIONS`.
- `ROLE_PERMISSIONS`: grant to `owner` and `manager`; **not** `staff`. (Matches the roadmap's default mapping.)

Reads (`GET /api/audit/*`) resolve the tenant from the authenticated web session, assert `audit:view`, and query through `withTenant(tenantId, tx => …)` so RLS scopes results. **Writes are never exposed** — no HTTP endpoint inserts into `audit_events`. The only writer is `recordAuditEvent`, called server-side from inside a mutation's transaction. This is deliberate: an audit row you can POST directly is an audit row an attacker can forge.

## API

- `recordAuditEvent(ctx, event)` — **the core surface, not HTTP.** Signature: `recordAuditEvent(ctx: AuditContext, event: { action, entityType, entityId, summary, metadata?, actorType? }, tx: Tx): Promise<void>`. It **must** receive the caller's transaction handle so the insert is atomic with the mutation; it must never open its own. `AuditContext` = `{ tenantId, branchId?, actorUserId?, fingerprint }`. It takes the advisory lock, reads `audit_chain_heads`, computes the hashes, inserts the row, and advances the head (see Architecture).
- **Fingerprint capture at the boundary.** POS: `requirePosCashier` (`src/server/pos/require-cashier.ts`) already resolves `{deviceId, tenantId, branchId, cashierUserId}` from the device Bearer token + `X-POS-Cashier`; extend it to also read a new **`X-POS-App-Version`** header and to compute `deviceTokenHash = sha256(deviceToken)` from the `pos_devices.token` it already looked up (`src/server/pos/schema.ts`). Web: derive `{appVersion: <build>, ip, userAgent}` from the request and session; `deviceId`/`deviceTokenHash` are null. The assembled `fingerprint` is attached to `ctx` and threaded to `recordAuditEvent`.
- `GET /api/audit/events` — web dashboard, requires `audit:view`. Paginated, filterable by `action`, `entityType`/`entityId`, `actorUserId`, and date range. Read-only, via `withTenant`.
- `GET /api/audit/chain/status` — requires `audit:view`. Returns the tenant's `{seq, headHash}` and the last verifier result (`ok` / first broken `seq`). This is how tamper state is surfaced until Spec 5 wires notifications.

## Architecture

`recordAuditEvent` is a synchronous step *inside* the mutation's existing transaction — the same `withTenant` block that writes the order, tender, or menu change. It reuses `placeOrder`'s serialization discipline exactly: acquire the per-tenant advisory lock only after validation I/O, do the read-then-advance, and let the surrounding commit make it durable. If the mutation later throws, the audit row rolls back with it — there is no orphan audit and no lost audit.

```
  mutating service (placeOrder / recordSale / transitionStatus / markPaid / …)
        │  withTenant(tenantId, tx => { ...write the change...;
        │                               recordAuditEvent(ctx, event, tx) })
        ▼
  ┌───────────────────────── recordAuditEvent(ctx, event, tx) ─────────────────────────┐
  │  1. SELECT pg_advisory_xact_lock(hashtext(tenantId)::bigint)   ← same as order no.  │
  │  2. SELECT seq, headHash FROM audit_chain_heads  (0 / 64·'0' if no row → genesis)   │
  │  3. seq' = seq + 1 ;  prevHash = headHash                                           │
  │  4. entryHash = sha256( canonical(                                                  │
  │           prevHash, seq', tenantId, actorUserId,                                    │
  │           action, entityType, entityId, metadata, createdAt ) )                     │
  │  5. INSERT INTO audit_events (…, seq', prevHash, entryHash, createdAt)               │
  │  6. UPSERT audit_chain_heads SET seq = seq', headHash = entryHash                    │
  └────────────────────────────────────────────────────────────────────────────────────┘
        │  (lock released + rows made durable on COMMIT of the outer tx)
        ▼
              ┌──────────────────────── tamper-evidence ────────────────────────┐
              │  trigger: RAISE on UPDATE/DELETE of audit_events (below)          │
              │  verifier (periodic): walk each tenant chain, report first break │
              └──────────────────────────────────────────────────────────────────┘
```

**Canonical serialization** is a stable, deterministic encoding — sorted JSON keys, UTF-8, explicit null tokens, `createdAt` as RFC3339 with fixed precision — so the same logical event always hashes identically. It lives in one module (e.g. `src/server/audit/canonical.ts`) imported by both the writer and the verifier; there must be exactly one implementation, or the verifier will "detect" tamper that is really just an encoding drift.

**Tamper-evidence trigger** (sketch), shipped in the migration that creates the table:

```sql
CREATE FUNCTION audit_events_no_mutate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % rejected', TG_OP;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_no_mutate();
```

The **verifier** is a scheduled server job: for each tenant it reads rows ordered by `seq`, recomputes `entryHash` from the stored fields, checks `prevHash == previous row's entryHash` and `entryHash` matches, and reports the first `seq` where the recomputation diverges (or the head that `audit_chain_heads` claims is absent). It never mutates or "repairs" — a break is a finding, not a bug to auto-fix.

## Emission points

Every mutating write threads `ctx` and calls `recordAuditEvent` inside its transaction. Initial set:

- **`placeOrder`** (`src/server/ordering/service.ts:59`) → `order.placed` (web + POS orders).
- **`recordSale`** (`src/server/pos/record-sale.ts:51`) → `sale.recorded`, with tenders summarized in `metadata`.
- **`transitionStatus`** (`src/server/ordering/service.ts:380`) → `order.status.changed`, `metadata: {before, after}`.
- **Discounts & voids** — where `pos_adjustment_events` rows are written (`src/server/pos/tender-schema.ts`, driven by `recordSale`) → `discount.applied`, `discount.order.applied`, `line.voided`, `order.voided`, carrying `byUserId`/`authorizedByUserId`.
- **`markPaid`** (`src/server/ordering/service.ts:400`) → `payment.marked_paid` (the web cash-on-collection path).
- **Staff changes** (`src/server/rbac`, `staff:invite` and role edits) → `staff.invited`, `staff.role.changed`, `staff.removed`.
- **Menu changes** (catalog service, `menu:manage`) → `menu.item.created/updated/deleted`, `menu.price.changed` with `{before, after}`.
- **Settings changes** (tenant settings / pricing / branches) → `settings.updated`, `pricing.updated` with `{before, after}`.

Forward references — these specs add their own emission points against the same helper: **inventory** ledger/lot/count events → Spec 8; **purchase-order** lifecycle (draft → sent → received → closed) → Spec 9; **refund** events → Spec 3. The chain and `recordAuditEvent` are built to absorb them without change.

## Error handling / edge cases

- **First event for a tenant (genesis):** no `audit_chain_heads` row → treat as `seq = 0`, `headHash` = 64 zeros; the first insert becomes `seq = 1` with `prevHash` = 64 zeros, and the head row is created.
- **Mutation fails after the audit insert:** both are in one transaction → both roll back. There is no partial audit and no orphaned chain advance.
- **Concurrent appends for one tenant:** the advisory lock serializes the read-then-advance window only; it is per-tenant (`hashtext(tenantId)`), not global, so tenants never block each other.
- **Missing `X-POS-App-Version` (older POS build):** record `appVersion: null` and still audit. A missing fingerprint field never blocks the mutation — losing the sale to protect the log is the wrong trade.
- **Verifier finds a broken link:** report the first divergent `seq` via `GET /api/audit/chain/status`; do not self-heal or truncate. (Spec 5 turns this finding into an alert.)
- **Someone disables the trigger and edits a row:** the trigger stops casual/accidental mutation; the chain is the real defence — the verifier still detects the edit because every subsequent `entryHash` no longer reconciles.
- **Device token rotation:** `deviceTokenHash` is a hash of whatever token was valid at capture time; a rotated token simply produces a new hash. The raw token is never stored, so a leaked `audit_events` dump cannot be replayed to authenticate.
- **Clock/`createdAt` integrity:** `createdAt` is set by the database (`now()`) inside the tx and is part of the hash, so it cannot be back-dated after the fact without breaking the chain.
- **Historical backfill:** actions that predate this deploy are **not** retro-chained; the chain starts at genesis on rollout. Backfilling would require fabricating hashes and defeats the purpose.

## Testing

- **Unit (pure):** canonical serialization is deterministic and stable across key order; a known input produces a known sha256 (fixed vector); genesis `prevHash` is 64 zeros; linking `prevHash → entryHash` holds across a synthetic chain; the verifier flags a hand-corrupted row at the correct `seq`.
- **Server (Vitest):** `recordAuditEvent` appends within the caller's tx and rolls back when the mutation throws; `seq` is strictly monotonic per tenant under concurrent appends; RLS hides one tenant's events from another; the trigger raises on `UPDATE` and on `DELETE`; the verifier walks a good chain (`ok`) and reports the first break on a tampered one; `GET /api/audit/events` is gated by `audit:view` (403 for `staff`) and scoped by `withTenant`.
- **Renderer:** the web audit log view lists, filters (action/entity/actor/date), and paginates; the chain-status banner reflects `ok` vs. a reported break.
- **Manual acceptance:** ring a POS sale → an `audit_events` row appears with `fingerprint` containing `deviceTokenHash` (not the raw token) and the `X-POS-App-Version` value; attempt `UPDATE audit_events …` in `psql` → the trigger raises; run the verifier → `ok`; disable the trigger, edit one row, re-run the verifier → it reports the first broken `seq`.

## Roadmap

- **Spec 5 — Notifications & Outbound Email:** consume the verifier's break findings and email the owner; deliver the tamper alert this spec only logs.
- **Spec 7 — Transaction Reconciliation:** hash-anchor each daily close into the chain (`reconciliation.closed`), making the day's totals tamper-evident too.
- **Specs 3 / 8 / 9:** register refund, inventory-ledger, and purchase-order emission points against the existing `recordAuditEvent` helper — no chain changes required.
- **Spec 10 — Cross-Channel Reporting:** promote the minimal read API into a full manager-facing audit/activity surface with export.
