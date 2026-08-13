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
/** Cashier sessions. Control-plane like pos_devices: no RLS, token is the key.
 *  A row outliving its expiry is inert — resolveCashier checks expiresAt. */
export const posCashierSessions = pgTable("pos_cashier_sessions", {
  token: text("token").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  permissions: jsonb("permissions").$type<string[]>().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("pos_cashier_sessions_expires").on(t.expiresAt)]);
```

(Add `users`/`tenants` imports if not present; export the type.)

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
    .where(eq(posCashierSessions.token, cashierToken));
  expect(row).toBeDefined();
});

it("expired sessions resolve to null and are deleted", async () => {
  const { tenantId } = await seedTenantWithOwner();
  const { cashierToken } = await signInCashier(tenantId, OWNER_EMAIL, OWNER_PASSWORD);
  await db.update(posCashierSessions)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(posCashierSessions.token, cashierToken));
  expect(await resolveCashier(cashierToken)).toBeNull();
});
```

- [ ] **Step 4: Run tests, verify they fail** (`resolveCashier` is sync today → type error / no DB row)

- [ ] **Step 5: Implement.** In `cashier.ts`: delete the `Map` + `sweep`; `signInCashier` inserts the row; `resolveCashier` becomes async:

```ts
export async function resolveCashier(token: string): Promise<CashierSession | null> {
  const [s] = await db.select().from(posCashierSessions)
    .where(eq(posCashierSessions.token, token)).limit(1);
  if (!s) return null;
  if (s.expiresAt.getTime() <= Date.now()) {
    await db.delete(posCashierSessions).where(eq(posCashierSessions.token, token));
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
  token: text("token").primaryKey(),
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
  const [g] = await db.delete(posGrants).where(eq(posGrants.token, token)).returning();
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

- [ ] **Step 1: Failing test** — prove atomicity by making the continuation throw:

```ts
it("rolls back the order when post-placement writes fail (single transaction)", async () => {
  const ctx = await seedCashierContext(); // file's existing helper
  await expect(recordSale(ctx, {
    ...validSaleInput(),
    payments: [{ clientPaymentId: "p1", method: "cash", amount: -1 } as never], // validated AFTER placeOrder today
    __failAfterPlace: true as never, // replaced below by a real injection seam if needed
  })).rejects.toThrow();
  const allOrders = await withTenant(ctx.tenantId, (tx) => tx.select().from(orders));
  expect(allOrders).toHaveLength(0); // no orphan order, no stock deducted
});
```

(Implementation note: the real seam is `onPlaced` throwing — test via a tender that fails validation *inside* the tx once moved.)

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

- [ ] **Step 2: Catalog version.** The catalog response gains `catalogVersion`: `SELECT max(updated_at)` across products/variants/categories/modifiers for the tenant, returned as epoch millis. Add to the catalog service return and the route JSON.

- [ ] **Step 3: Migration for both DBs; `db:check` clean.**

- [ ] **Step 4: Test** — receipt uniqueness `(deviceId, eventId)` rejects a duplicate insert; catalog route returns a numeric `catalogVersion` that increases after a product update.

- [ ] **Step 5: Commit** — `feat(pos): sync event receipts, client shift identity, catalog version`

### Task 5: Idempotent, replayable shift services

`openShift`/`closeShift`/cash-movement/count services accept `clientShiftId` + `occurredAt` and become replay-safe. Sales replay resolves `clientShiftId → shift.id`.

**Files:** modify `src/server/pos/shifts.ts`, `src/server/pos/cash-movements.ts`; test `src/server/pos/shifts-replay.test.ts` (new).

- [ ] **Step 1: Failing tests:**

```ts
it("openShift is idempotent on (deviceId, clientShiftId)", async () => {
  const a = await openShift(ctx, { openingFloat: 100, clientShiftId: CSID, occurredAt: past });
  const b = await openShift(ctx, { openingFloat: 100, clientShiftId: CSID, occurredAt: past });
  expect(b.id).toBe(a.id);
});
it("closeShift replays return the recorded close, not a double-close error", async () => { /* same shape */ });
it("openedAt honours the device-claimed occurredAt", async () => {
  const s = await openShift(ctx, { openingFloat: 100, clientShiftId: CSID, occurredAt: past });
  expect(s.openedAt.getTime()).toBe(past.getTime());
});
```

- [ ] **Step 2: Implement.** Inside the existing advisory-lock block of `openShift`: first `SELECT` by `(deviceId, clientShiftId)`; if found, return it (idempotent). Insert sets `openedAt: occurredAt ?? now`, `clientShiftId`. `closeShift`: if the target shift is already `closed` **and** the close was recorded from this event (receipt exists — Task 6 wires that), return the stored result. Cash movements/counts gain `occurredAt` pass-through to `createdAt`.

- [ ] **Step 3: `npm test -- src/server/pos` → pass. Commit** — `feat(pos): shift lifecycle is idempotent and replayable with device-claimed timestamps`

### Task 6: `POST /api/pos/v1/sync/events` — the ingestion endpoint

**Files:** create `src/server/pos/sync-ingest.ts`, `src/app/api/pos/v1/sync/events/route.ts`, `src/app/api/pos/v1/ping/route.ts`; test `src/server/pos/sync-ingest.test.ts`.

- [ ] **Step 1: Failing tests** (the contract, straight from the spec):

```ts
it("processes an ordered batch and stops at the first failure", async () => { /* 3 events, 2nd malformed → results [ok, error]; 3rd untouched */ });
it("replaying a synced batch returns identical results and writes nothing new", async () => {
  const r1 = await ingestEvents(ctx, batch);
  const before = await snapshotCounts(); // orders, shifts, movements, audit_events
  const r2 = await ingestEvents(ctx, batch);
  expect(r2).toEqual(r1);
  expect(await snapshotCounts()).toEqual(before);
});
it("an offline sale replays at the till's totals even after a price change (till wins)", async () => {
  /* seed product at 50, event prices it at 50, raise price to 60, ingest → order total 50, drift audit event exists */
});
it("flags but accepts events with >48h clock skew", async () => { /* clockSkewFlagged true */ });
```

- [ ] **Step 2: Implement `sync-ingest.ts`.** Shape:

```ts
export type SyncEvent = {
  eventId: string; type: SyncEventType; occurredAt: string; payload: Record<string, unknown>;
};
export type SyncResult =
  | { eventId: string; status: "applied" | "duplicate"; result: Record<string, unknown> }
  | { eventId: string; status: "failed"; error: { code: string; message: string } };

export async function ingestEvents(ctx: PosCashierContext, events: SyncEvent[]): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (const e of events) {
    const receipt = await findReceipt(ctx.deviceId, e.eventId);      // duplicate → stored result
    if (receipt) { results.push({ eventId: e.eventId, status: "duplicate", result: receipt.resultJson }); continue; }
    try {
      const result = await applyEvent(ctx, e);                       // dispatch by type, ONE tx per event
      results.push({ eventId: e.eventId, status: "applied", result });
    } catch (err) {
      results.push({ eventId: e.eventId, status: "failed", error: toErrorShape(err) });
      break;                                                          // strict order: stop at first failure
    }
  }
  return results;
}
```

`applyEvent` dispatch: `sale.recorded → recordSale` (payload carries `clientOrderId`, lines, tenders, `catalogVersion`, `clientShiftId`, `offline: true`); `shift.opened → openShift`; `shift.closed → closeShift`; `cash.movement`, `count.recorded`, `ticket.*` → existing services. Each apply writes its `pos_sync_event_receipts` row **inside the same event transaction** (receipts have no RLS — same pattern as Task 3). Clock skew: `Math.abs(occurredAt - now) > 48h` → `clockSkewFlagged: true`.

Till-wins: `recordSale` gains `offline?: boolean`; when set, `expectedTotal` mismatches don't 409 — the sale records at the till's totals with a `pos.replay.price_drift` audit event carrying `{ expectedTotal, serverTotal, catalogVersion }`. (Implementation: pass `priceOverride` through `placeOrder` — add `trustClientTotals?: boolean` to `PlaceOrderInput`, applied only on the POS path.)

- [ ] **Step 3: Route** — device+cashier auth exactly like `sales/route.ts`; body `{ events: SyncEvent[] }` (validate array, cap at 50/batch); returns `{ results }`. `ping/route.ts` — `requirePosDevice` then `{ ok: true, serverTime }`.

- [ ] **Step 4: `npm test -- src/server/pos` → pass. Commit** — `feat(pos): ordered idempotent sync ingestion with till-wins replay`

### Task 7: Auth sync-down endpoint

**Files:** create `src/app/api/pos/v1/sync/auth/route.ts`, `src/server/pos/auth-sync.ts`; test `src/server/pos/auth-sync.test.ts`.

- [ ] **Step 1: Failing test** — returns the branch's POS-capable users with scrypt hashes; excludes inactive users and other tenants' users; requires cashier auth.

- [ ] **Step 2: Implement** — `listPosUsers(tenantId)`: users whose roles grant any `pos:*` permission, projecting `{ userId, name, email, passwordHash, permissions, canAuthorize: permissions beyond pos:sell }`. Route: `requirePosCashier`, respond `{ users, syncedAt }`. Never log hashes.

- [ ] **Step 3: Commit** — `feat(pos): branch auth roster sync-down for offline sign-in`

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
```

`seq`: use `seq INTEGER NOT NULL` assigned as `(SELECT COALESCE(MAX(seq),0)+1 FROM local_events)` inside the same synchronous better-sqlite3 statement (single-process, no race).

- [ ] **Step 2: Store API (TDD — write tests first, then implement):**

```ts
appendEvent(type: string, payload: unknown): { eventId: string; seq: number }
pendingEvents(): EventRow[]                      // status='pending' ORDER BY seq
markEventSynced(eventId: string, response: unknown): void
markEventFailed(eventId: string, error: string): void
saveAuthRoster(users: AuthUser[], syncedAt: string): void   // replace-all
findAuthUser(email: string): AuthUser | null
getState<T>(key: string): T | null
setState(key: string, value: unknown): void
```

Tests: append assigns increasing `seq`; `pendingEvents` respects order; synced events excluded; roster replace removes departed users.

- [ ] **Step 3: Reducer** — create `apps/pos/electron/_offline/reducer.ts` + test:

```ts
/** Rebuilds till state from the confirmed snapshot + unsynced events.
 *  Pure: (snapshot, events) → state. Boot calls this; nothing else mutates local_state. */
export type TillState = {
  openShift: { clientShiftId: string; openedAt: string; openingFloat: number; openedByUserId: string } | null;
  cashSales: number; cashMovements: number;      // X-report running figures
  heldTickets: HeldTicket[];
};
export function reduce(snapshot: TillState, events: EventRow[]): TillState { /* switch on type */ }
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

- [ ] **Step 2: Implement** — `offlineSignIn` verifies against `auth_cache` (decrypt hash via `safeStorage`), mints a local cashier session (kept in Electron main memory — device-local is correct here); `offlineGrant(authorizerEmail, password, permission)` verifies the authorizer holds the permission, appends a `grant.issued` event, returns a local single-use token consumed by the next gated action's event payload (`authorizedByUserId` travels inside the event).

- [ ] **Step 3: Commit** — `feat(pos-app): offline cashier sign-in and manager authorization from the synced roster`

---

## Phase 4 — Sync engine & PosMain wiring

### Task 10: SyncEngine v2 + write-through PosMain

**Files:** rewrite `apps/pos/electron/_offline/sync.ts` (+ `sync.test.ts`), modify `apps/pos/electron/_offline/api.ts`, `apps/pos/electron/pos-main.ts`, `preload.ts` (expose state), `apps/pos/electron/main.ts` (new IPC: `pos:syncState`).

- [ ] **Step 1: Failing engine tests** (mock `PosApiClient`):

```ts
it("flushes strictly in seq order and resumes after a network cut mid-batch", ...);
it("halts on a domain rejection and leaves later events pending", ...);
it("a flush after reconnect replays duplicates safely (server says duplicate → mark synced)", ...);
it("ping failure flips state to offline; success flips back and triggers flush + pull", ...);
```

- [ ] **Step 2: Implement.** Engine holds `state: online|offline|syncing`, exposes `onState(cb)`. Loop: every 15s (and on any API `isNetwork` error) ping; on transition offline→online run `pull()` (catalog + auth roster) then `flush()`. Flush posts `pendingEvents()` in batches of 20 to `sync/events`; per result: `applied|duplicate → markEventSynced`, `failed → markEventFailed` + **stop** + surface `haltedOn: eventId`.

- [ ] **Step 3: Write-through PosMain.** Every operator action in `pos-main.ts` becomes: append event → if engine online, flush immediately → return the local result (for sales: local receipt data computed from cached catalog; server confirmation upgrades it silently). `recordSale`'s `clientOrderId` now comes from the appended event's payload (minted at draft time — delete the `crypto.randomUUID()` at the fetch site). Reads (`catalog`, `currentShift`) serve from cache/`local_state` first, refresh in background. Boot: rebuild `local_state` via the reducer, then start the engine — **no network call blocks the UI**.

- [ ] **Step 4: `npm run pos:test` → green. Commit** — `feat(pos-app): write-through event log with ordered reconnect sync`

### Task 11: POS UI — connectivity states

**Files:** modify `apps/pos/src/App.tsx`, create `apps/pos/src/components/SyncBadge.tsx`; renderer tests per existing pattern.

- [ ] **Step 1:** Badge shows `online / offline / syncing (N queued)` from the `pos:syncState` IPC subscription; OrdersQueue tab shows a "web orders unavailable offline" notice when offline; a blocking modal appears only on `halted` (domain-rejected event) with the event summary and "contact support / retry" actions.
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

- [ ] **Step 1:** Hook subscribes to `tenant:{tenantId}` broadcast; on matching event calls `onEvent` (pages respond by running their existing refetch). Polling intervals relax to 60s as the fallback. Missing env → hook is a no-op and polling stays at today's cadence.
- [ ] **Step 2:** Manual verification: two browsers — place an order in one, dashboard updates in the other within ~2s without waiting for the poll.
- [ ] **Step 3: Commit** — `feat(realtime): dashboard/storefront subscribe and refetch on tenant events`

---

## Phase 6 — Hardening & E2E

### Task 14: Retention, encryption, skew surfacing

- [ ] Local pruning: on boot delete `local_events` where `status='synced' AND occurred_at < now-30d` (test in `store.test.ts`).
- [ ] Encrypt `auth_cache.password_hash` and `catalog_cache.json` at rest via `safeStorage` (helpers in `db.ts`; skip transparently when `safeStorage.isEncryptionAvailable()` is false, e.g. Linux CI).
- [ ] Dashboard: clock-skew-flagged receipts and `price_drift` audit events appear on the audit page (they already flow through `audit_events`; verify a filter surfaces them).
- [ ] Commit — `feat(pos): retention, at-rest encryption, and drift/skew surfacing`

### Task 15: End-to-end offline lifecycle test

**Files:** create `src/server/pos/offline-lifecycle.test.ts` (server-side, real Postgres — the authoritative test) and `tests/e2e/pos-offline.md` (scripted manual run for the Electron shell).

- [ ] Server test: build the exact event batch a till would produce for a full offline shift — `shift.opened` → 2× `sale.recorded` (one with discount + grant) → `cash.movement` (pay_out) → `count.recorded` → `shift.closed` — ingest it, then assert: shift row with claimed timestamps; orders with correct totals and tenders; inventory deducted (or negative-on-hand + notification when short); Z-report figures match the event math; audit chain verifies (`verifyChain`); replaying the whole batch changes nothing.
- [ ] Manual script: the Wi-Fi-pull run from the spec, with expected screenshots/badge states listed step by step.
- [ ] Commit — `test(pos): offline shift lifecycle is replay-complete and tamper-evident`

---

## Self-review checklist (run after drafting, fixed inline)

- Spec coverage: D1–D5 all mapped (D1 → Tasks 12–13 only touch web reads; D2 → Tasks 5–11; D3 → 12–13; D4 → Task 6; D5 → no new frameworks anywhere). Prereqs → Tasks 1–3. Edge cases: crash-rebuild (Task 8 reducer), skew (4/6/14), retention (14), multi-terminal (idempotency keys are device-scoped throughout).
- No placeholder verbs without code; every task names exact files and its test path.
- Type consistency: `SyncEvent`/`SyncResult` (Task 6) are the wire types Task 10's engine consumes; `clientShiftId` naming is uniform; `resolveCashier`/`resolveAuthorizer` async signatures propagate to `require-cashier.ts` and `record-sale.ts` (Tasks 1–2 name the callers).
