# POS Offline-First & Platform Sync Propagation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or build to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Electron POS keeps working through network loss — selling, shifts, cash movements, cashier sign-in, manager overrides — and replays everything idempotently on reconnect; every other surface (dashboard, queue, storefront) hears about synced data within seconds via Supabase Realtime.

**Architecture:** Append-only SQLite event log in Electron main behind the existing `PosMain` seam; strict-`seq` idempotent replay onto existing domain services through a new `sync/events` endpoint; till-wins ingestion policy; per-tenant Supabase Realtime broadcast with polling fallback. Spec: `docs/moai/specs/2026-08-09-pos-offline-sync-design.md`.

**Tech Stack:** Next.js 16 App Router, Drizzle + Postgres (FORCE RLS via `withTenant`), Electron 33 + better-sqlite3, Supabase Realtime (`@supabase/supabase-js` browser-side, REST broadcast server-side), Vitest (server tests hit real Postgres; POS tests run under `apps/pos/vitest.config.ts`).

**Conventions that bind every task:**
- Server tests live next to code (`*.test.ts`), run with `npm test -- <path>`; they truncate tables per test via the global setup — never assume seed data.
- Every mutating service records an audit event on the caller's `tx` (the `audit/coverage.ts` guardrail fails the build otherwise).
- Money uses `money()` from `@shared` conventions (numeric strings, `.toFixed(2)`); never float-format by hand.
- Commits: conventional style, signed, attributed to mohanedsayed, no co-author lines.

---

## Phase 1 — Server prerequisites

### Task 1: DB-backed cashier sessions

Cashier sessions live in a process-memory `Map` (`src/server/pos/cashier.ts:28`) — broken on serverless and fatal for reconnect flows. Move them to a table. **No RLS**: like `pos_devices`, sessions are control-plane, keyed by opaque token, and read before a tenant context exists.

**Files:**
- Modify: `src/server/pos/schema.ts` (append table)
- Create: `drizzle/00XX_*` via `npm run db:generate`
- Modify: `src/server/pos/cashier.ts`
- Test: `src/server/pos/cashier.test.ts` (extend existing)

- [ ] **Step 1: Add the table to `src/server/pos/schema.ts`**

```ts
/** Cashier sessions. Control-plane like pos_devices: no RLS. Keyed by the
 *  SHA-256 of the bearer token — a read-only DB leak must not hand out live
 *  sessions. A row outliving its expiry is inert — resolveCashier checks expiresAt. */
export const posCashierSessions = pgTable("pos_cashier_sessions", {
  tokenHash: text("token_hash").primaryKey(),   // sha256 hex of the raw token
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  permissions: jsonb("permissions").$type<string[]>().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("pos_cashier_sessions_expires").on(t.expiresAt)]);
```

(Add `users`/`tenants` imports if not present; export the type. Helper, shared with Task 2: `const tokenHash = (t: string) => createHash("sha256").update(t).digest("hex");` — the raw token is returned to the client once and never stored.)

- [ ] **Step 2: Generate + apply the migration**

Run: `npm run db:generate` then `npm run db:migrate && npm run db:migrate:test`
Expected: new migration applies; `npm run db:check` reports all applied.

- [ ] **Step 3: Write the failing test** (append to `cashier.test.ts`)

```ts
it("survives a process restart: session resolves from the DB, not memory", async () => {
  const { tenantId } = await seedTenantWithOwner(); // use this file's existing helper
  const { cashierToken } = await signInCashier(tenantId, OWNER_EMAIL, OWNER_PASSWORD);
  // simulate another instance: resolveCashier must not depend on module state
  const resolved = await resolveCashier(cashierToken);
  expect(resolved?.tenantId).toBe(tenantId);
  const [row] = await db.select().from(posCashierSessions)
    .where(eq(posCashierSessions.tokenHash, tokenHash(cashierToken)));
  expect(row).toBeDefined(); // stored hashed, resolvable from raw
});

it("expired sessions resolve to null and are deleted", async () => {
  const { tenantId } = await seedTenantWithOwner();
  const { cashierToken } = await signInCashier(tenantId, OWNER_EMAIL, OWNER_PASSWORD);
  await db.update(posCashierSessions)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(posCashierSessions.tokenHash, tokenHash(cashierToken)));
  expect(await resolveCashier(cashierToken)).toBeNull();
});
```

- [ ] **Step 4: Run tests, verify they fail** (`resolveCashier` is sync today → type error / no DB row)

- [ ] **Step 5: Implement.** In `cashier.ts`: delete the `Map` + `sweep`; `signInCashier` inserts the row; `resolveCashier` becomes async:

```ts
export async function resolveCashier(token: string): Promise<CashierSession | null> {
  const hash = tokenHash(token);
  const [s] = await db.select().from(posCashierSessions)
    .where(eq(posCashierSessions.tokenHash, hash)).limit(1);
  if (!s) return null;
  if (s.expiresAt.getTime() <= Date.now()) {
    await db.delete(posCashierSessions).where(eq(posCashierSessions.tokenHash, hash));
    return null;
  }
  return { userId: s.userId, tenantId: s.tenantId, name: s.name,
           permissions: s.permissions as Permission[], expiresAt: s.expiresAt.getTime() };
}
```

Update the one caller (`src/server/pos/require-cashier.ts`) to `await resolveCashier(...)`. Opportunistic sweep: in `signInCashier`, `db.delete(posCashierSessions).where(lt(posCashierSessions.expiresAt, new Date()))` before insert.

- [ ] **Step 6: Run the POS server tests** — `npm test -- src/server/pos` → all pass.
- [ ] **Step 7: Commit** — `fix(pos): cashier sessions move from process memory to the database`

### Task 2: DB-backed manager grants

Same disease, same cure (`src/server/pos/grants.ts:10`). Single-use semantics move to a guarded `DELETE ... RETURNING`.

**Files:** modify `src/server/pos/schema.ts`, `src/server/pos/grants.ts`; test `src/server/pos/grants.test.ts`; new migration.

- [ ] **Step 1: Table** (in `schema.ts`, next to sessions):

```ts
export const posGrants = pgTable("pos_grants", {
  tokenHash: text("token_hash").primaryKey(),   // sha256 hex, same helper as sessions
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  permission: text("permission").notNull(),
  authorizedByUserId: uuid("authorized_by_user_id").notNull().references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
```

- [ ] **Step 2: Generate + apply migration** (both DBs), `db:check` clean.

- [ ] **Step 3: Failing test** (extend `grants.test.ts`; existing tests keep passing):

```ts
it("a grant is single-use across 'instances' (DB-backed)", async () => {
  const { tenantId, ownerId } = await seedTenantWithOwner();
  const token = await issueGrant(tenantId, "pos:discount", ownerId);
  expect(await consumeGrant(tenantId, token, "pos:discount")).toBe(ownerId);
  await expect(consumeGrant(tenantId, token, "pos:discount"))
    .rejects.toThrow(PosForbiddenError);
});
```

- [ ] **Step 4: Implement.** `issueGrant`/`consumeGrant` become async; consume is atomic:

```ts
export async function consumeGrant(tenantId: string, token: string, permission: Permission): Promise<string> {
  const [g] = await db.delete(posGrants).where(eq(posGrants.tokenHash, tokenHash(token))).returning();
  if (!g || g.expiresAt.getTime() <= Date.now() || g.tenantId !== tenantId || g.permission !== permission) {
    throw new PosForbiddenError(permission);
  }
  return g.authorizedByUserId;
}
```

`resolveAuthorizer` becomes async; update its callers (`record-sale.ts`, cash-movement/refund paths — grep `resolveAuthorizer(`).

- [ ] **Step 5: `npm test -- src/server/pos` → pass. Commit** — `fix(pos): manager grants move to the database; consume is atomic`

### Task 3: Single-transaction `recordSale`

`record-sale.ts` runs three sequential commits (placeOrder ➊, tenders/audit ➋, receipt ➌). A crash after ➊ duplicates the sale on retry. Fold ➋+➌ into ➊'s transaction by passing a tx-scoped continuation into `placeOrder`.

**Files:** modify `src/server/ordering/service.ts` (placeOrder gains `onPlaced?`), `src/server/pos/record-sale.ts`; test `src/server/pos/record-sale.test.ts`.

- [ ] **Step 1: Failing test** — prove atomicity through the one check that stays *inside* `onPlaced` (paid-exceeds-total, which needs `placed.total` and therefore runs after the order is written):

```ts
it("rolls back the order when the in-transaction total check fails (single transaction)", async () => {
  const ctx = await seedCashierContext(); // file's existing helper
  await expect(recordSale(ctx, {
    ...validSaleInput(), // seeded product total is 50
    payments: [{ clientPaymentId: "p1", method: "cash", amount: 500, tenderedAmount: 500 }], // exceeds total → throws inside onPlaced
  })).rejects.toThrow(PosSaleError);
  const allOrders = await withTenant(ctx.tenantId, (tx) => tx.select().from(orders));
  expect(allOrders).toHaveLength(0); // no orphan order, no stock deducted, no receipt row
});
```

(Today this scenario *leaves* the orphan order behind — `paidAmount > placed.total` is checked after placeOrder's transaction committed, at `record-sale.ts:122` — which is exactly the bug. The test passes only once the check and the tender writes run inside `onPlaced`.)

- [ ] **Step 2: Add the seam to `placeOrder`.** In `ordering/service.ts`, after the order+items+audit writes and inventory deduction, still inside `withTenant`:

```ts
export type PlaceOrderResult = { orderId: string; orderNumber: number; total: number; itemIds: string[] };

// in PlaceOrderInput:
/** Runs inside the SAME transaction after the order is written. POS uses this
 *  to make tenders + receipt atomic with the order. Throwing rolls everything back. */
onPlaced?: (tx: Tx, placed: PlaceOrderResult) => Promise<void>;
```

Call `await input.onPlaced?.(tx, placed)` as the last statement before the transaction returns.

- [ ] **Step 3: Rewrite `recordSale`** to do tender validation and `paidAmount` math *before* `placeOrder`, then move everything from the current second `withTenant` block and the `posOrderReceipts` insert into `onPlaced`:

```ts
const placed = await placeOrder(ctx.tenantId, {
  /* ...unchanged fields... */
  onPlaced: async (tx, placed) => {
    if (paidAmount > placed.total + 0.001) throw new PosSaleError("Tenders exceed the amount due");
    /* tenderRows insert, adjustment events, paymentStatus update,
       discount + sale.recorded audit events — verbatim from today's block, on tx */
    await tx.insert(posOrderReceipts).values({
      deviceId: ctx.deviceId, clientOrderId: input.clientOrderId,
      orderId: placed.orderId, orderNumber: String(placed.orderNumber),
    });
  },
});
```

`posOrderReceipts` has no RLS precisely so this insert works on the tenant tx. Delete the trailing standalone insert.

- [ ] **Step 4: `npm test -- src/server/pos src/server/ordering` → pass. Commit** — `fix(pos): recordSale is one transaction — receipt commits with the sale`

---

## Phase 2 — Ingestion path

### Task 4: Schema for sync — event receipts + client shift identity + catalog version

**Files:** modify `src/server/pos/schema.ts`, `src/server/pos/shift-schema.ts`, `src/server/catalog/service.ts` + `src/app/api/pos/v1/catalog/route.ts`; migration; tests `src/server/pos/sync-schema.test.ts`.

- [ ] **Step 1: Tables/columns.**

```ts
// schema.ts — mirror of pos_order_receipts, for non-sale events. No RLS.
export const posSyncEventReceipts = pgTable("pos_sync_event_receipts", {
  deviceId: uuid("device_id").notNull().references(() => posDevices.id, { onDelete: "cascade" }),
  eventId: uuid("event_id").notNull(),
  type: text("type").notNull(),
  resultJson: jsonb("result_json").$type<Record<string, unknown>>().notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  clockSkewFlagged: boolean("clock_skew_flagged").notNull().default(false),
}, (t) => [uniqueIndex("pos_sync_event_receipts_key").on(t.deviceId, t.eventId)]);
```

```ts
// shift-schema.ts — add to posShifts columns:
clientShiftId: uuid("client_shift_id"),
```
with `uniqueIndex("pos_shifts_device_client").on(t.deviceId, t.clientShiftId).where(sql\`client_shift_id IS NOT NULL\`)`.

```ts
// tender-schema.ts — add to posHeldTickets columns (offline ticket identity;
// a later ticket.discarded event references this, not the server-minted id):
clientTicketId: uuid("client_ticket_id"),
```
with `uniqueIndex("pos_held_tickets_device_client").on(t.deviceId, t.clientTicketId).where(sql\`client_ticket_id IS NOT NULL\`)` (add `deviceId` column if the table lacks it).

- [ ] **Step 2: Catalog version — a per-tenant monotonic counter, NOT `max(updated_at)`.** A MAX over catalog tables misses deletions (max unchanged), `branch_product_availability.price_override` changes, and tenant pricing settings (VAT/service charge) — so drift reports would cite "same catalog" while pricing genuinely moved. Implement a `catalog_versions (tenant_id PK, version bigint)` row bumped with `UPDATE ... SET version = version + 1 RETURNING version` from: catalog service mutations, branch price-override writes, and `patchTenantSettings` when VAT/service-charge keys change. The catalog response returns it as `catalogVersion`.

- [ ] **Step 3: Migration for both DBs; `db:check` clean.**

- [ ] **Step 4: Test** — receipt uniqueness `(deviceId, eventId)` rejects a duplicate insert; catalog route returns a numeric `catalogVersion` that increases after a product update.

- [ ] **Step 5: Commit** — `feat(pos): sync event receipts, client shift identity, catalog version`

### Task 5: Idempotent, replayable shift services — every effect commits with its receipt

The atomicity mechanism for **all** non-sale events is the Task 3 pattern, not ingest-level wrapping (nested `withTenant` calls are independent transactions, so an outer wrapper cannot exist): each replayable service accepts an optional `syncReceipt` descriptor and inserts the `pos_sync_event_receipts` row **as the last statement of its own tenant transaction** (the table has no RLS for exactly this reason). That closes every crash-between-effect-and-receipt window and is also what gives cash movements, counts, and held tickets — which have no natural idempotency key — one.

```ts
// shared type, exported from sync-ingest.ts (Task 6) and imported by the services:
export type SyncReceipt = {
  deviceId: string; eventId: string; type: string;
  occurredAt: Date; clockSkewFlagged: boolean;
};
// each service, inside its tx, last statement:
if (syncReceipt) await tx.insert(posSyncEventReceipts).values({ ...syncReceipt, resultJson: result });
```

**Files:** modify `src/server/pos/shifts.ts`, `src/server/pos/cash-movements.ts`, held-tickets service, `src/server/pos/record-sale.ts` (shift resolution); test `src/server/pos/shifts-replay.test.ts` (new).

- [ ] **Step 1: Failing tests:**

```ts
it("openShift is idempotent on (deviceId, clientShiftId)", async () => {
  const a = await openShift(ctx, { openingFloat: 100, clientShiftId: CSID, occurredAt: past });
  const b = await openShift(ctx, { openingFloat: 100, clientShiftId: CSID, occurredAt: past });
  expect(b.id).toBe(a.id);
});
it("closeShift with a syncReceipt commits receipt and close atomically; a retry returns the stored result", async () => {
  await closeShift(ctx, { ...closeInput, occurredAt: past, syncReceipt: receiptFor(EVT) });
  const again = await closeShift(ctx, { ...closeInput, occurredAt: past, syncReceipt: receiptFor(EVT) });
  expect(again.idempotent).toBe(true); // receipt found → stored result, not ShiftClosedError
});
it("openedAt/closedAt honour the device-claimed occurredAt", async () => {
  const s = await openShift(ctx, { openingFloat: 100, clientShiftId: CSID, occurredAt: past });
  expect(s.openedAt.getTime()).toBe(past.getTime()); // and closedAt likewise on close
});
it("cash movements with the same syncReceipt eventId apply exactly once", async () => { /* expected-cash math unchanged on retry */ });
it("a replayed cash sale resolves its drawer from clientShiftId, not whichever shift is open", async () => {
  /* open shift A (client id CSID), close it server-side, replay a sale carrying CSID
     → tender rows reference shift A, sale ingests with a flag — no NoOpenShiftError */
});
```

- [ ] **Step 2: Implement.**
  - `openShift`: inside the existing advisory-lock block, first `SELECT` by `(deviceId, clientShiftId)`; if found, return it (idempotent). Insert sets `openedAt: occurredAt ?? now`, `clientShiftId`.
  - `closeShift`: **check the sync receipt first** — if `syncReceipt` given and a receipt row exists for its `eventId`, return the stored result. Otherwise close normally with `closedAt: occurredAt ?? now`, writing the receipt in the same tx.
  - Cash movements / counts / held tickets: accept `occurredAt` (→ `createdAt`) + `syncReceipt`; held tickets also accept `clientTicketId` (Task 4 column) so `ticket.discarded`/`ticket.recalled` can reference tickets created offline. Note: ticket *recall* has no server service today (recall = renderer loads draft + DELETE) — add a `recallHeldTicket` service that deletes by `clientTicketId` and records the receipt.
  - `recordSale` (replay path): when the payload carries `clientShiftId`, resolve the drawer by `(deviceId, clientShiftId)` — or by server `shiftId` if the shift was opened online — instead of `findOpenShift`. Tolerate the resolved shift being `closed`: record the tender against it and flag in audit metadata (`shiftClosedAtReplay: true`). Live (non-replay) sales keep today's `findOpenShift` behavior.

- [ ] **Step 3: `npm test -- src/server/pos` → pass. Commit** — `feat(pos): shift lifecycle replayable with atomic sync receipts and client shift identity`

### Task 6: `POST /api/pos/v1/sync/events` — the ingestion endpoint

Three load-bearing decisions (from spec + review):
1. **Device-token auth only.** A live cashier token cannot exist after an outage — offline sessions are device-local, and a pre-outage token is past TTL. Requiring one would 401 the very flush that ends the outage. Every event instead carries `actorUserId`; a batch may span multiple cashiers.
2. **Offline authorization replays as data.** `grant.issued` has a handler (audit event), and gated events carry `authorizedByUserId`, accepted in place of a live grant token — on this ingest path only.
3. **Till-wins needs snapshots, not just a skipped 409.** `placeOrder` re-validates lines against the live catalog and evaluates opening-hours at `now` — both must defer to the till on replay.

**Files:** create `src/server/pos/sync-ingest.ts`, `src/app/api/pos/v1/sync/events/route.ts`, `src/app/api/pos/v1/ping/route.ts`; modify `src/server/pos/record-sale.ts`, `src/server/ordering/service.ts` (replay inputs); test `src/server/pos/sync-ingest.test.ts`.

- [ ] **Step 1: Failing tests** (the contract):

```ts
it("processes an ordered batch and stops at the first failure", async () => { /* 3 events, 2nd malformed → results [ok, error]; 3rd untouched */ });
it("replaying a synced batch returns identical results and writes nothing new", async () => {
  const r1 = await ingestEvents(device, batch);
  const before = await snapshotCounts(); // orders, shifts, movements, audit_events
  const r2 = await ingestEvents(device, batch);
  expect(r2).toEqual(r1);
  expect(await snapshotCounts()).toEqual(before);
});
it("a batch spanning two cashiers attributes each event to its own actor", async () => {
  /* cashier A sale + cashier B shift.opened in one batch → takenByUserId/audit actor differ per event */
});
it("an offline sale replays at the till's totals even after a price change (till wins)", async () => {
  /* seed product at 50, snapshot prices it at 50, raise price to 60, ingest → order total 50, drift audit event exists */
});
it("a sale for a product unpublished mid-outage still ingests from its snapshot", async () => { /* names/prices from snapshot; drift event */ });
it("a batch replayed outside branch opening hours still ingests (occurredAt was inside hours)", async () => {});
it("a discounted sale authorized offline replays with the manager stamped as authorizer", async () => {
  /* pos:sell-only actor + authorizedByUserId of a manager → posAdjustmentEvents.authorizedByUserId = manager */
});
it("a deactivated-since-outage actor is flagged, not rejected", async () => {});
it("concurrent duplicate ingest resolves as duplicate, not failure (23505 → re-read)", async () => {});
it("an out-of-order seq is rejected with code out_of_order", async () => {});
it("flags but accepts events with >48h clock skew", async () => { /* clockSkewFlagged true */ });
```

- [ ] **Step 2: Implement `sync-ingest.ts`.** Shape:

```ts
export type SyncEvent = {
  eventId: string; seq: number; type: SyncEventType; occurredAt: string;
  actorUserId: string; authorizedByUserId?: string;
  payload: Record<string, unknown>;
};
export type SyncResult =
  | { eventId: string; status: "applied" | "duplicate"; result: Record<string, unknown>; flags?: string[] }
  | { eventId: string; status: "failed"; error: { code: string; message: string } };

/** Device-authenticated: ctx is the device, NOT a cashier session. */
export async function ingestEvents(device: PosDeviceContext, events: SyncEvent[]): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  let lastSeq = await lastReceiptSeq(device.deviceId); // ordering gap detection
  for (const e of events) {
    const receipt = await findReceipt(device.deviceId, e.eventId);   // duplicate → stored result
    if (receipt) { results.push({ eventId: e.eventId, status: "duplicate", result: receipt.resultJson }); continue; }
    if (e.seq <= lastSeq) { results.push(fail(e, "out_of_order")); break; }
    try {
      const actor = await resolveActor(device.tenantId, e.actorUserId); // in-tenant check; inactive → flag, not reject
      const result = await applyEvent(device, actor, e);             // dispatch by type, ONE tx per event incl. its receipt (Task 5's syncReceipt)
      results.push({ eventId: e.eventId, status: "applied", result, flags: actor.flags });
      lastSeq = e.seq;
    } catch (err) {
      if (isUniqueViolation(err, "pos_sync_event_receipts_key")) {   // concurrent duplicate: re-read, answer duplicate
        const r = await findReceipt(device.deviceId, e.eventId);
        results.push({ eventId: e.eventId, status: "duplicate", result: r!.resultJson });
        lastSeq = e.seq;
        continue;
      }
      results.push({ eventId: e.eventId, status: "failed", error: toErrorShape(err) });
      break;                                                          // strict order: stop at first failure
    }
  }
  return results;
}
```

`applyEvent` dispatch — **every type has a handler** (an unknown type is a `failed`, never a crash):
- `sale.recorded → recordSale` (payload: `clientOrderId`, **line snapshots**, tenders, `catalogVersion`, `clientShiftId`, `replay: { occurredAt, actorUserId, authorizedByUserId }`)
- `shift.opened → openShift`, `shift.closed → closeShift` (with `syncReceipt`, `occurredAt`, `authorizedByUserId` pass-through)
- `cash.movement`, `count.recorded` → existing services (+ `syncReceipt`; over-threshold pay-out accepts `authorizedByUserId`)
- `ticket.held / ticket.recalled / ticket.discarded` → held-tickets services by `clientTicketId`
- `grant.issued → recordAuditEvent("pos.grant_issued_offline", { permission, authorizedByUserId, occurredAt })` + receipt
- `session.signed_in → recordAuditEvent("auth.cashier_signed_in" | "auth.login_failed", { occurredAt, offline: true })` + receipt

Replay authorization: the services' `resolveAuthorizer(ctx, perm, grantToken)` call sites gain a replay branch — when the input carries `authorizedByUserId` **and** the caller is the ingest path, validate the user exists in-tenant (deactivated → flag) and use it directly; live routes never accept the field (strip it in route parsing).

Till-wins in `placeOrder`: add `replay?: { occurredAt: Date; lineSnapshots: LineSnapshot[] }` to `PlaceOrderInput`. When present: `now = occurredAt` for the orderability check, `placedAt = occurredAt`; on any line-validation failure (unpublished product, missing variant/option) **or** price disagreement, build the line from its snapshot instead of throwing, and emit `pos.replay.price_drift` audit with `{ expectedTotal, serverTotal, catalogVersion, missingEntities }`. Skip the `TOTAL_MISMATCH` 409. Clock skew: `Math.abs(occurredAt - now) > 48h` → `clockSkewFlagged: true` on the receipt.

- [ ] **Step 3: Route** — **`requirePosDevice` only** (per decision 1); body `{ events: SyncEvent[] }` (validate array, cap at 50/batch); returns `{ results }`. `ping/route.ts` — `requirePosDevice` then `{ ok: true, serverTime }`.

- [ ] **Step 4: `npm test -- src/server/pos` → pass. Commit** — `feat(pos): device-authenticated ordered ingestion with snapshot till-wins and offline authorization replay`

### Task 7: Auth sync-down endpoint

**Files:** create `src/app/api/pos/v1/sync/auth/route.ts`, `src/server/pos/auth-sync.ts`; test `src/server/pos/auth-sync.test.ts`.

- [ ] **Step 1: Failing test** — returns the branch's POS-capable users with scrypt hashes **including `reconciliation:manage` holders** (offline overrides need managers in the roster); excludes inactive users and other tenants' users; requires cashier auth.

- [ ] **Step 2: Implement** — `listPosUsers(tenantId)`: users whose roles grant any `pos:*` permission **or `reconciliation:manage`**, projecting `{ userId, name, email, passwordHash, permissions }` (permissions = the same union `posPermissionsFor` computes, so offline `resolveAuthorizer`-equivalent checks match online ones). Route: `requirePosCashier`, respond `{ users, syncedAt }`. Never log hashes. Client cadence (wired in Task 10): pulled immediately after every successful **online** cashier sign-in and on the periodic online timer — first-boot-offline shows "offline sign-in unavailable until first online sign-in".

- [ ] **Step 3: Commit** — `feat(pos): branch auth roster sync-down for offline sign-in`

---

## Client wire contract — learned by driving the real API (binding on Tasks 8–11)

The server half is built and proven by `src/server/pos/offline-lifecycle.test.ts`, which
ingests a full offline shift (`session.signed_in` → `shift.opened` → 2 sales → pay-out →
count → `shift.closed`) and asserts the resulting rows, Z-report, audit chain, and a
no-op replay. Driving it surfaced five rules the client MUST follow — each is a real
failure, not a style preference:

1. **Every `sale.recorded` carries `clientShiftId` (or `shiftId`) — including card-only
   sales.** Without it `recordSale` falls back to `findOpenShift`; a sale replayed after
   its drawer closed then gets `shiftId: null` on its tender and silently drops out of
   the Z-report's sales count and tender totals. Money quietly disappears from
   reconciliation.
2. **An over-threshold `cash.movement` MUST carry `authorizedByUserId`.** Without it the
   event throws `forbidden`, and because the halt is sticky (spec §Sync engine) that
   **jams the entire queue** behind it. The till has to capture the manager offline at
   the moment of the pay-out — there is no way to supply it later.
3. **`grant.issued` gates nothing on its own.** It is an audit record. The gated event
   (discounted sale, cross-user close, over-threshold pay-out) must carry its own
   `authorizedByUserId`. The event also requires a valid `Permission` string or it fails
   validation.
4. **`order.discountAmount` is order-level only.** Line discounts live on
   `order_items.discountAmount` and `pos_adjustment_events`. A local X/Z view that reads
   `order.discountAmount` as "total discount" will under-report.
5. **`seq` is strictly increasing per device and gap-free.** A failed event leaves no
   receipt, so a corrected retry at the same `seq` resumes correctly — but skipping a
   `seq` is rejected as `out_of_order`.

Verified server behaviour the client can rely on: business timestamps come from
`occurredAt` (orders' `placedAt`, shift open/close, cash counts), so offline work lands
in the correct business day; a batch halts at its first failure leaving later events
completely untouched (no partial writes, no receipts); a full replay is a byte-identical
no-op; and `status` is `"duplicate"` for a genuine concurrent race across all event
types.

---

## Phase 3 — Client store & offline auth

### Task 8: SQLite store v2 — `local_events`, `auth_cache`, `local_state`

**Files:** modify `apps/pos/electron/_offline/db.ts`, `store.ts`; rewrite `store.test.ts`; remove `_offline` exclusion from `apps/pos/vitest.config.ts`.

- [ ] **Step 1: Schema v2** (in `openDb`, additive `CREATE TABLE IF NOT EXISTS`):

```sql
CREATE TABLE IF NOT EXISTS local_events (
  event_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,          -- AUTOINCREMENT via sqlite_sequence: INTEGER PRIMARY KEY on a shadow? use: seq INTEGER NOT NULL
  type TEXT NOT NULL,
  payload TEXT NOT NULL,                -- JSON
  occurred_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | synced | failed
  server_response TEXT
);
CREATE TABLE IF NOT EXISTS auth_cache (
  user_id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL,
  password_hash TEXT NOT NULL,          -- encrypted with safeStorage before insert
  permissions TEXT NOT NULL,            -- JSON array
  synced_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS local_state (
  key TEXT PRIMARY KEY, json TEXT NOT NULL
);
-- catalog_cache (existing table) gains what offline totals math and drift audit need:
ALTER TABLE catalog_cache ADD COLUMN pricing_json TEXT;      -- CheckoutPricing (VAT, service charge)
ALTER TABLE catalog_cache ADD COLUMN catalog_version INTEGER; -- server counter (Task 4)
-- (guard the ALTERs with a pragma table_info check — SQLite has no IF NOT EXISTS for columns)
```

`seq`: use `seq INTEGER NOT NULL` assigned as `(SELECT COALESCE(MAX(seq),0)+1 FROM local_events)` inside the same synchronous better-sqlite3 statement (single-process, no race).

- [ ] **Step 2: Store API (TDD — write tests first, then implement):**

```ts
appendEvent(type: string, payload: unknown): { eventId: string; seq: number }
pendingEvents(): EventRow[]                      // status='pending' ORDER BY seq
hasFailedEvents(): boolean                       // sticky-halt guard (Task 10)
retryFailedEvent(eventId: string): void          // failed → pending (operator resolution)
markEventSynced(eventId: string, response: unknown): void
markEventFailed(eventId: string, error: string): void
saveCatalog(json: string, pricingJson: string, catalogVersion: number, syncedAt: string): void
saveAuthRoster(users: AuthUser[], syncedAt: string): void   // replace-all
findAuthUser(email: string): AuthUser | null
getState<T>(key: string): T | null
setState(key: string, value: unknown): void
```

Tests: append assigns increasing `seq`; `pendingEvents` respects order; synced events excluded; `hasFailedEvents` true after a markEventFailed and false after retry; roster replace removes departed users.

- [ ] **Step 2b: Promote `better-sqlite3` to a real dependency** — move it out of `optionalDependencies` in `apps/pos/package.json` (delete the explanatory `//` comment key). This is load-bearing: the package.json note exists because a failed native build used to break installs. Verify: (a) `npm ci` at repo root succeeds; (b) `npm run pos:test` runs the `_offline` tests against the real binding (electron-rebuild vs node ABI: vitest runs under Node, so the plain prebuilt binary is the one exercised — fine); (c) Vercel builds don't compile it (`vercel.json`/root build never installs POS workspace binaries — confirm the build log). If (c) fails, scope the dependency install with `ELECTRON_SKIP_BINARY_DOWNLOAD` guidance from the CI workflow.

- [ ] **Step 3: Reducer** — create `apps/pos/electron/_offline/reducer.ts` + test:

```ts
/** Rebuilds till state from the confirmed snapshot + unsynced events.
 *  Pure: (snapshot, events) → state. Boot calls this; nothing else mutates local_state.
 *  Shape is rich enough to render a local X/Z report: per-method tenders,
 *  movements by type, and the expected-cash formula
 *  (openingFloat + cashTenders − payOuts − safeDrops + payIns). */
export type TillState = {
  openShift: { clientShiftId: string; openedAt: string; openingFloat: number; openedByUserId: string } | null;
  tendersByMethod: { cash: number; card: number; other: number };
  movements: { payIn: number; payOut: number; safeDrop: number; noSaleCount: number };
  salesCount: number;
  discountTotal: number;
  heldTickets: { clientTicketId: string; label: string; draftJson: string }[];
};
export function reduce(snapshot: TillState, events: EventRow[]): TillState { /* switch on type */ }
export function expectedCash(s: TillState): number { /* openingFloat + cash − payOut − safeDrop + payIn */ }
```

Tests: `shift.opened` sets openShift; sales/movements accumulate; `shift.closed` nulls it; `ticket.held/recalled` round-trips; replay of the same list is deterministic (`reduce(s, e)` twice → deep-equal).

- [ ] **Step 4: `npm run pos:test` → green (with `_offline` un-excluded). Commit** — `feat(pos-app): sqlite event log, auth cache, and deterministic till-state reducer`

### Task 9: Offline cashier sign-in & manager grants

**Files:** create `apps/pos/electron/_offline/offline-auth.ts`; test alongside. Modify `apps/pos/electron/pos-main.ts` sign-in/authorize paths (Task 10 wires fully).

- [ ] **Step 1: Failing tests** — verify against the server's scrypt format (`salt:hash`, `crypto.scryptSync(password, salt, 64)` — confirm the exact format against `src/server/auth/password.ts` before implementing; if it differs, mirror it):

```ts
it("verifies a cached cashier offline", () => {
  const hash = serverStyleHash("pw123");
  saveRoster([{ email: "c@x.com", passwordHash: hash, permissions: ["pos:sell"], ... }]);
  expect(offlineSignIn(store, "c@x.com", "pw123")?.permissions).toContain("pos:sell");
  expect(offlineSignIn(store, "c@x.com", "wrong")).toBeNull();
});
it("offline manager grant requires an authorizer with the permission", () => { /* grant.issued event appended, local token returned */ });
```

- [ ] **Step 2: Implement** — `offlineSignIn` verifies against `auth_cache` (decrypt hash via `safeStorage`), mints a local cashier session (kept in Electron main memory — device-local is correct here) and **appends a `session.signed_in` event** (success or failed attempt — both replay into the server audit chain, so offline sessions don't vanish from history); `offlineGrant(authorizerEmail, password, permission)` verifies the authorizer holds the permission, appends a `grant.issued` event, returns a local single-use token consumed by the next gated action's event payload (`authorizedByUserId` travels inside the event).

- [ ] **Step 3: Commit** — `feat(pos-app): offline cashier sign-in and manager authorization from the synced roster`

---

## Phase 4 — Sync engine & PosMain wiring

### Task 10: SyncEngine v2 + write-through PosMain

**Files:** rewrite `apps/pos/electron/_offline/sync.ts` (+ `sync.test.ts`), modify `apps/pos/electron/_offline/api.ts`, `apps/pos/electron/pos-main.ts`, `preload.ts` (expose state), `apps/pos/electron/main.ts` (new IPC: `pos:syncState`).

- [ ] **Step 1: Failing engine tests** (mock `PosApiClient`):

```ts
it("flushes strictly in seq order and resumes after a network cut mid-batch", ...);
it("halts on a domain rejection and leaves later events pending", ...);
it("the halt is STICKY: after a rejection, subsequent ticks send NOTHING until the failed event is resolved", ...);
it("retryFailedEvent(failed → pending) lets the next flush resume from that seq", ...);
it("only one flush runs at a time — overlapping triggers coalesce (single-flight)", ...);
it("a flush after reconnect replays duplicates safely (server says duplicate → mark synced)", ...);
it("ping failure flips state to offline; success flips back and triggers flush + pull", ...);
```

- [ ] **Step 2: Implement.** Engine holds `state: online|offline|syncing|halted`, exposes `onState(cb)`. **Single-flight:** an in-flight promise guard so overlapping triggers (timer + reconnect + write-through) coalesce into one run. Loop: every 15s (and on any API `isNetwork` error) ping; on transition offline→online run `pull()` (catalog **with pricing + version**, auth roster) then `flush()`; roster also refreshes on the periodic online tick, not just on transition. Flush: **first check `hasFailedEvents()` — if any, state = `halted` and send nothing** (skipping past a failed event would break causal order); otherwise post `pendingEvents()` in batches of 20 to `sync/events` (each event carrying its `seq` and `actorUserId`); per result: `applied|duplicate → markEventSynced`, `failed → markEventFailed` + state `halted` + surface `haltedOn: eventId`. Resolution API: `retryFailed()` (failed → pending, state re-evaluated) exposed over IPC for Task 11's alert actions.

- [ ] **Step 3: Write-through PosMain.** Every operator action in `pos-main.ts` becomes: append event → if engine online, flush immediately → return the local result (for sales: local receipt data computed from cached catalog; server confirmation upgrades it silently). `recordSale`'s `clientOrderId` now comes from the appended event's payload (minted at draft time — delete the `crypto.randomUUID()` at the fetch site). Reads (`catalog`, `currentShift`) serve from cache/`local_state` first, refresh in background. Boot: rebuild `local_state` via the reducer, then start the engine — **no network call blocks the UI**.

- [ ] **Step 4: `npm run pos:test` → green. Commit** — `feat(pos-app): write-through event log with ordered reconnect sync`

### Task 11: POS UI — connectivity states

**Files:** modify `apps/pos/src/App.tsx`, create `apps/pos/src/components/SyncBadge.tsx`; renderer tests per existing pattern.

- [ ] **Step 1:** Badge shows `online / offline / syncing (N queued) / halted` from the `pos:syncState` IPC subscription; OrdersQueue tab shows a "web orders unavailable offline" notice when offline (refunds/history/reprint entry points likewise disable with a notice — they are server-backed); offline receipts print the short client code derived from `clientOrderId` in place of the not-yet-assigned server order number; a blocking modal appears only on `halted` with the event summary and two actions: **Retry** (`retryFailed()` over IPC) and **contact support** (the manager-void path is a follow-up; until it exists, support resolves via the server).
- [ ] **Step 2:** Boot no longer blocks on `currentShift()` network success (it reads local state) — remove the "Checking the drawer…" network dependency.
- [ ] **Step 3:** `npm run pos:test`, then manual smoke via `npm run pos:demo:web` + `pos:dev`: kill the network (turn off Wi-Fi or stop the dev server), sell twice, close shift, restore, watch the badge cycle and the queue drain. Commit — `feat(pos-app): connectivity badge, offline queue notice, sync-halt alert`

---

## Phase 5 — Realtime propagation

### Task 12: Server-side publisher

**Files:** create `src/server/realtime/publish.ts` (+ test with fetch mocked), modify emit points: `src/server/pos/sync-ingest.ts`, `src/server/ordering/service.ts` (placeOrder, transitionStatus, confirmOrderPayment), `src/app/api/orders/route.ts` is covered via placeOrder.

- [ ] **Step 1:**

```ts
/** Fire-and-forget tenant broadcast. IDs only — subscribers refetch through
 *  authenticated endpoints, so RLS/permissions are never bypassed. Failure is
 *  swallowed: realtime is an accelerant, polling remains the guarantee. */
export async function publishTenantEvent(
  tenantId: string,
  event: { type: "orders.changed" | "sync.applied" | "stock.changed"; entityIds: string[] },
): Promise<void> {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return; // dev without realtime configured is fine
  try {
    await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ topic: `tenant:${tenantId}`, event: event.type, payload: { entityIds: event.entityIds } }] }),
    });
  } catch { /* deliberately swallowed */ }
}
```

Emit **after** the owning transaction commits (call sites, not inside services' tx blocks). Sync ingest publishes once per batch (`sync.applied` + affected order ids, `stock.changed` when any sale applied).

- [ ] **Step 2: Test** — publisher called after placeOrder commit with the order id; a fetch failure does not fail the order.
- [ ] **Step 3: Commit** — `feat(realtime): per-tenant broadcast on order/sync/stock changes`

### Task 13: Browser subscribers

**Files:** add `@supabase/supabase-js` dependency; create `src/lib/realtime-client.ts` (`"use client"` hook `useTenantEvents(tenantId, types, onEvent)`); modify `src/app/dashboard/orders/OrdersTable.tsx`, `src/app/order/[token]/StatusPoller.tsx`, dashboard payments + inventory pages' pollers; envs `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (document in `docs/NEW-LAPTOP-SETUP.md`).

- [ ] **Step 1:** Hook subscribes to `tenant:{tenantId}` broadcast (use Supabase **private channels** so an anon-key holder can't subscribe to another tenant's topic; payloads are IDs-only regardless); on matching event calls `onEvent` (pages respond by running their existing refetch). Polling intervals relax to 60s as the fallback. Missing env → hook is a no-op and polling stays at today's cadence. Document the concurrent-connection budget: every dashboard tab, storefront status page, and till holds one socket — check the Supabase plan's cap before rollout.
- [ ] **Step 2: POS queue subscription** — the Electron **main process** subscribes with `@supabase/supabase-js` (main owns all networking; the Vite renderer has no `NEXT_PUBLIC_*` envs and needs none) and forwards `orders.changed` signals over a new `pos:realtimeEvent` IPC channel; `OrdersQueue.tsx` refetches on signal and relaxes its poll to 60s. Offline → the subscription drops with the network; polling resumes on reconnect either way.
- [ ] **Step 3:** Manual verification: two browsers — place an order in one, dashboard updates in the other within ~2s without waiting for the poll; with the POS open, the queue updates on a storefront order without waiting for its poll.
- [ ] **Step 4: Commit** — `feat(realtime): dashboard/storefront/POS subscribe and refetch on tenant events`

---

## Phase 6 — Hardening & E2E

### Task 14: Retention, encryption, skew surfacing

- [ ] Local pruning: on boot delete `local_events` where `status='synced' AND occurred_at < now-30d` (test in `store.test.ts`).
- [ ] Encrypt `auth_cache.password_hash` and `catalog_cache.json` at rest via `safeStorage` (helpers in `db.ts`; skip transparently when `safeStorage.isEncryptionAvailable()` is false, e.g. Linux CI).
- [ ] Dashboard: clock-skew-flagged receipts and `price_drift` audit events appear on the audit page (they already flow through `audit_events`; verify a filter surfaces them).
- [ ] Commit — `feat(pos): retention, at-rest encryption, and drift/skew surfacing`

### Task 15: End-to-end offline lifecycle test

**Files:** create `src/server/pos/offline-lifecycle.test.ts` (server-side, real Postgres — the authoritative test) and `tests/e2e/pos-offline.md` (scripted manual run for the Electron shell).

- [ ] Server test: build the exact event batch a till would produce for a full offline shift — `session.signed_in` → `shift.opened` → 2× `sale.recorded` (one with discount authorized via offline `grant.issued`) → `cash.movement` (pay_out) → `count.recorded` → `shift.closed` — ingest it, then assert: shift row with claimed timestamps (`openedAt`/`closedAt` = `occurredAt`s, orders' `placedAt` in the correct business day); orders with correct totals and tenders attributed to the right actors; discount rows carry the offline authorizer; inventory deducted (or negative-on-hand + notification when short); Z-report figures match the event math; audit chain verifies (`verifyChain`); replaying the whole batch changes nothing. Then the adversarial variants: the same batch with a product unpublished after the outage began (ingests from snapshot + drift event), replayed outside opening hours (ingests), a second concurrent ingest of the same batch (all duplicates), and a batch whose 2nd event is malformed (halts at it; events 3+ untouched; a later retry after fixing resumes from seq order).
- [ ] Manual script: the Wi-Fi-pull run from the spec, with expected screenshots/badge states listed step by step.
- [ ] Commit — `test(pos): offline shift lifecycle is replay-complete and tamper-evident`

---

## Self-review checklist (run after drafting, fixed inline)

- Spec coverage: D1–D5 all mapped (D1 → Tasks 12–13 only touch web reads; D2 → Tasks 5–11; D3 → 12–13; D4 → Task 6; D5 → no new frameworks anywhere). Prereqs → Tasks 1–3. Edge cases: crash-rebuild (Task 8 reducer), skew (4/6/14), retention (14), multi-terminal (idempotency keys are device-scoped throughout).
- No placeholder verbs without code; every task names exact files and its test path.
- Type consistency: `SyncEvent`/`SyncResult` (Task 6) are the wire types Task 10's engine consumes; `clientShiftId`/`clientTicketId` naming is uniform; `resolveCashier`/`resolveAuthorizer` async signatures propagate to `require-cashier.ts` and `record-sale.ts` (Tasks 1–2 name the callers); `SyncReceipt` (Task 5) is the descriptor Task 6's dispatch passes to every service.

## Review hardening (2026-08-09 code-review pass — all applied above)

An adversarial review walked the six flows end-to-end and found five criticals, all fixed in place:
1. **C1** Ingest is device-authenticated with per-event `actorUserId` — a cashier token can't exist after an outage (Task 6).
2. **C2** Offline authorization replays as data: `grant.issued` handler + `authorizedByUserId` accepted on the ingest path only (Tasks 6, 9).
3. **C3** Till-wins uses line snapshots, `now`/`placedAt` from `occurredAt` — unpublished products and closed-hours replays ingest instead of halting (Tasks 6, 15).
4. **C4** The halt is sticky: `flush()` sends nothing while a failed event exists; `halted` is a first-class engine/UI state with an explicit retry (Tasks 8, 10, 11).
5. **C5** Receipt atomicity via `syncReceipt` inside each service's own transaction — closes the double-apply window for movements/counts/tickets and the spurious-halt on `closeShift` retries (Tasks 5, 6).
Plus: shift resolution by `clientShiftId` (Task 5), single-flight + 23505→duplicate (Tasks 6, 10), POS realtime via Electron main (Task 13), roster cadence + `session.signed_in` audit (Tasks 7, 9, 10), catalog-version counter covering settings/overrides (Task 4), `catalog_cache` pricing columns (Task 8), better-sqlite3 promotion (Task 8), hashed tokens at rest (Tasks 1–2), richer `TillState` for local X/Z (Task 8), held-ticket client ids + recall service (Tasks 4–5).
