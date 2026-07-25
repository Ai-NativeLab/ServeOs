# Audit & Fingerprint Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use mo-ai:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every tenant an **append-only, hash-chained (tamper-evident)** operational audit trail with **system-wide** coverage. Each mutating write appends one `audit_events` row **inside its own transaction**; every auth event and sensitive read/export appends one at its boundary — all linked to their predecessor by a SHA-256 chain, all carrying a device/session **fingerprint** (`{deviceId, deviceTokenHash, appVersion, ip, userAgent}`). A DB trigger makes `UPDATE`/`DELETE` fail; a verifier walks each chain and reports the first broken link; reads are gated behind a new `audit:view` permission. A **coverage-guardrail test** fails CI when a mutating surface ships without an emission. Implements `docs/ailab/specs/2026-07-24-audit-and-fingerprint-log-design.md` (Spec 4, decision **D1**).

**Architecture:** One writer, one chain per tenant. `recordAuditEvent(ctx, event, tx)` (`src/server/audit/service.ts`) is a synchronous step *inside* the caller's existing `withTenant` transaction — the same block that writes the order, tender, menu change, branch, or settings row. It reuses `placeOrder`'s serialization discipline exactly (`src/server/ordering/service.ts`): `SELECT pg_advisory_xact_lock(hashtext(tenantId)::bigint)`, read `audit_chain_heads`, compute `entryHash = sha256(canonical(...))`, insert the row, advance the head. Auth events and sensitive reads have no data write to bind to, so they open a one-statement `withTenant` append. Canonical serialization lives in **one** module (`src/server/audit/canonical.ts`) imported by both the writer and the verifier — there must be exactly one implementation, or the verifier "detects" tamper that is only encoding drift. The platform `audit_logs` table (`src/server/platform/audit.schema.ts`) is untouched and continues to serve super-admin actions; `audit_events` is a **separate**, tenant-scoped, FORCE-RLS log alongside it that covers **tenant + user + customer + system** actions only.

**Tech Stack:** Next.js (App Router), Drizzle ORM + Postgres (RLS via `withTenant`), `node:crypto` (`createHash('sha256')` — no new dependency), Vitest against a remote Supabase Postgres.

## Global Constraints

- **No new runtime dependencies.** SHA-256 comes from `node:crypto`, already available.
- **Coverage is system-wide and enforced.** Every mutating service function in every domain emits, every auth event emits, every sensitive read/export emits. The coverage-guardrail test (Task 10) fails if a mutating surface has no emission and no allowlist entry. Ordinary reads / page views / list loads are **not** logged.
- **Tenant-scoped tables are behind RLS.** `audit_events` and `audit_chain_heads` are `ENABLE` + `FORCE ROW LEVEL SECURITY` with the house isolation policy: `USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)` and the same `WITH CHECK`. Every read/write goes through `withTenant(tenantId, tx => …)`.
- **Control-plane mutations still emit.** Tables without RLS (`tenants`, `users`, `pos_devices`, `subscriptions`) are mutated inside `withTenant(tenantId, tx => …)` **for the emission's sake** — the RLS-free write is unaffected, and the audit insert gets `app.tenant_id`. Refactor `db.transaction`/plain-`db` writers to `withTenant` where they need to emit.
- **Append-only is an invariant, not a convention.** No code path ever `UPDATE`s or `DELETE`s an `audit_events` row. A DB trigger enforces it. `audit_chain_heads` is the one mutable pointer (it *is* upserted); its integrity is proven by re-walking the chain, never by trusting the head.
- **The audit write shares the mutation's transaction.** `recordAuditEvent` **must** receive the caller's `tx` handle and must never open its own. If the mutation throws, the audit row rolls back with it — no orphan audit, no lost audit.
- **Never store raw device tokens.** The fingerprint carries `deviceTokenHash = sha256(deviceToken)`, never the token. A leaked `audit_events` dump must not be replayable to authenticate.
- **A missing fingerprint field never blocks a mutation.** An older POS build without `X-POS-App-Version` records `appVersion: null` and still audits. A mutation with no available fingerprint records `emptyFingerprint()` and still audits.
- **The chain hash covers exactly the nine fields the spec names** (`prevHash, seq, tenantId, actorUserId, action, entityType, entityId, metadata, createdAt`). The fingerprint is stored but **not** hashed.
- **Actor mapping is fixed.** staff/manager/owner → `actorType: "user"` (role in `metadata.roleKey`); storefront → `customer`; jobs/seeds → `system`; POS terminal with no human → `device`. A failed login has a null `actorUserId`.
- Run `npx tsc --noEmit && npx eslint <files>` before every commit. Both must be clean.

---

## File Structure

**Database**
- Create: `src/server/audit/schema.ts` — `audit_events`, `audit_chain_heads`, enum `audit_actor_type`.
- Modify: `src/db/schema.ts` — register the new schema barrel export.
- Create: `drizzle/00XX_*.sql` — generated migration; RLS policies + the append-only trigger hand-appended.

**Core (pure + writer + verifier)**
- Create: `src/server/audit/canonical.ts` — canonical serialization, `sha256Hex`, `entryHash`, `ZERO_HASH`.
- Create: `src/server/audit/canonical.test.ts`.
- Create: `src/server/audit/service.ts` — `recordAuditEvent`, `AuditContext`, `AuditFingerprint`, `AuditActorInput`, `AuditEventInput`.
- Create: `src/server/audit/service.test.ts`.
- Create: `src/server/audit/verifier.ts` — `verifyChain`, `ChainStatus`.
- Create: `src/server/audit/verifier.test.ts`.

**Fingerprint + actor capture**
- Create: `src/server/audit/fingerprint.ts` — `webFingerprint`, `headersFingerprint`, `emptyFingerprint`.
- Create: `src/server/audit/action-context.ts` — `actionAudit(ctx)` for dashboard server actions.
- Modify: `src/server/pos/require-cashier.ts` — `PosCashierContext` gains `fingerprint`; read `X-POS-App-Version` + hash the bearer token.
- Modify: `src/server/pos/test-helpers.ts` — `seedPosContext` attaches a synthetic fingerprint.

**Authorization + read surface**
- Modify: `src/server/rbac/permissions.ts` — add `audit:view` (owner + manager).
- Create: `src/server/audit/read.ts` — `listAuditEvents`, `getChainStatus`.
- Create: `src/app/dashboard/audit-permission.ts` — `requireAuditPermission`.
- Create: `src/app/api/audit/events/route.ts`, `src/app/api/audit/chain/status/route.ts`.
- Create: `src/app/dashboard/audit/page.tsx` — minimal read-only view.

**Emission wiring — Group A (ordering + POS)**
- Modify: `src/server/ordering/service.ts` — `placeOrder`, `transitionStatus`, `markPaid`, `cancelOrderByToken`.
- Modify: `src/server/pos/record-sale.ts` — `recordSale`, `addTender`.
- Modify: `src/server/pos/cashier.ts` — `signInCashier`.
- Modify: `src/server/pos/held-tickets.ts` — `holdTicket`, `discardHeldTicket`.
- Modify: `src/server/pos/service.ts` — `createPairingCode`, `redeemPairingCode`, `revokeDevice`, `loginForPos`.
- Modify: `src/app/api/orders/route.ts`, `src/app/api/orders/[token]/cancel/route.ts`, `src/app/dashboard/orders/[id]/actions.ts`, `src/app/api/pos/v1/orders/status/route.ts`, `src/app/api/pos/v1/sales/route.ts`, `src/app/api/pos/v1/sales/[id]/payments/route.ts`, `src/app/api/pos/v1/cashier/login/route.ts`, `src/app/api/pos/v1/held-tickets/route.ts`, `.../held-tickets/[id]/route.ts`, `src/app/api/pos/v1/authorize/route.ts`, `src/app/api/pos/v1/pair/route.ts`, `src/app/api/pos/v1/login/route.ts`, `src/app/dashboard/settings/pos-devices/actions.ts`.

**Emission wiring — Group B (catalog)**
- Modify: `src/server/catalog/service.ts`, `src/server/catalog/variants.ts`.
- Modify: `src/app/dashboard/menu/categories/actions.ts`, `src/app/dashboard/menu/products/actions.ts`.

**Emission wiring — Group C (auth + staff + settings + branches + banners + subscription + onboarding)**
- Modify: `src/server/auth/staff.ts`, `src/server/tenancy/settings.ts`, `src/server/branches/service.ts`, `src/server/banners/service.ts`, `src/server/subscription/service.ts`, `src/server/onboarding/service.ts`.
- Modify: `src/app/login/actions.ts`, `src/app/register/actions.ts`, `src/app/dashboard/actions.ts`, `src/app/dashboard/settings/staff/actions.ts`, `src/app/dashboard/settings/taxes/actions.ts`, `src/app/dashboard/settings/whatsapp/actions.ts`, `src/app/dashboard/settings/profile/actions.ts`, `src/app/dashboard/settings/fulfillment/actions.ts`, `src/app/dashboard/settings/billing/actions.ts`, `src/app/dashboard/branches/actions.ts`, `src/app/dashboard/banners/actions.ts`.

**Emission wiring — Group D (sensitive reads / exports)**
- Modify: `src/app/dashboard/analytics/page.tsx` — emit `report.financial_viewed`.
- Modify: `src/app/dashboard/orders/[id]/page.tsx` — emit `customer.pii_viewed`.

**Coverage guardrail**
- Create: `src/server/audit/coverage.ts` — `AUDIT_ALLOWLIST`, the mutating-symbol enumerator.
- Create: `src/server/audit/coverage.test.ts`.

---

## Task 1: Schema — `audit_events` + `audit_chain_heads`

Two tables. `audit_events` is the append-only, hash-chained log; `audit_chain_heads` is the one-row-per-tenant mutable tip. Both tenant-scoped with FORCE RLS. Drizzle's generator does **not** emit RLS policies or triggers (no schema file in this repo declares `pgPolicy`), so — exactly as `drizzle/0016_bitter_beast.sql` did for the tender tables — the `ENABLE`/`FORCE`/`CREATE POLICY` block and the trigger are **hand-appended** to the generated migration.

**Files:**
- Create: `src/server/audit/schema.ts`
- Modify: `src/db/schema.ts`
- Create: `drizzle/00XX_*.sql` (generated, then edited)

**Interfaces:**
- Produces: tables `auditEvents`, `auditChainHeads`; enum `auditActorTypeEnum` (`user | system | device | customer`); types `AuditEvent`, `AuditChainHead`.

- [ ] **Step 1: Write the schema.** Create `src/server/audit/schema.ts`:

```ts
import { pgTable, uuid, text, timestamp, jsonb, bigint, char, pgEnum, uniqueIndex, index } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { users } from "@/server/auth/schema";

export const auditActorTypeEnum = pgEnum("audit_actor_type", ["user", "system", "device", "customer"]);

/**
 * Append-only, tenant-scoped, hash-chained. One row per mutating action, auth
 * event, or sensitive read. Never updated, never deleted — the
 * audit_events_append_only trigger enforces it. `seq`/`prevHash`/`entryHash`
 * are set by recordAuditEvent under the per-tenant advisory lock; `createdAt`
 * is captured from the DB clock inside the tx and is part of the hash, so it
 * cannot be back-dated after the fact.
 */
export const auditEvents = pgTable("audit_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  actorType: auditActorTypeEnum("actor_type").notNull(),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  summary: text("summary").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  fingerprint: jsonb("fingerprint").$type<Record<string, unknown>>().notNull().default({}),
  seq: bigint("seq", { mode: "number" }).notNull(),
  prevHash: char("prev_hash", { length: 64 }).notNull(),
  entryHash: char("entry_hash", { length: 64 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("audit_events_tenant_seq").on(t.tenantId, t.seq),
  index("audit_events_tenant_created").on(t.tenantId, t.createdAt),
  index("audit_events_tenant_entity").on(t.tenantId, t.entityType, t.entityId),
  index("audit_events_tenant_action").on(t.tenantId, t.action),
]);

/** The current tip of a tenant's chain. Read-and-advanced under the advisory lock. */
export const auditChainHeads = pgTable("audit_chain_heads", {
  tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id, { onDelete: "cascade" }),
  seq: bigint("seq", { mode: "number" }).notNull(),
  headHash: char("head_hash", { length: 64 }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AuditEvent = typeof auditEvents.$inferSelect;
export type AuditChainHead = typeof auditChainHeads.$inferSelect;
```

- [ ] **Step 2: Register it.** Append to `src/db/schema.ts` (after the `pos/tender-schema` line):

```ts
export * from "../server/audit/schema";
```

- [ ] **Step 3: Generate the migration.**

```bash
npm run db:generate
```

Expected: a new `drizzle/00XX_*.sql` creating enum `audit_actor_type`, both tables, the FKs, and the four indexes. It will **not** contain RLS or the trigger.

- [ ] **Step 4: Hand-append RLS + the append-only trigger.** Open the generated file and append (mirror `drizzle/0016_bitter_beast.sql:67-81` for the policy shape):

```sql
--> statement-breakpoint
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY audit_events_isolation ON "audit_events"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "audit_chain_heads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_chain_heads" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY audit_chain_heads_isolation ON "audit_chain_heads"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE FUNCTION audit_events_no_mutate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % rejected', TG_OP;
END; $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_no_mutate();
```

The trigger is `BEFORE UPDATE OR DELETE FOR EACH ROW` — it does **not** fire on `TRUNCATE`, so `src/db/test-harness.ts`'s `TRUNCATE … CASCADE` still resets the table between tests. `audit_chain_heads` intentionally has no such trigger; it is the mutable pointer.

- [ ] **Step 5: Apply and verify the existing suite still passes.**

```bash
npm run db:migrate:test
npm test
```

Expected: migration applies; full suite PASS (nothing references the new tables yet).

- [ ] **Step 6: Commit.**

```bash
git add src/server/audit/schema.ts src/db/schema.ts drizzle/
git commit -m "feat(audit): append-only audit_events + audit_chain_heads with FORCE RLS and no-mutate trigger"
```

---

## Task 2: The hash primitive — canonical serialization + SHA-256

The chain's integrity rests on one thing: the same logical event always hashes identically. This is a **pure** module with no DB and no I/O, so it is tested with fixed vectors. It is imported by both the writer (Task 3) and the verifier (Task 5) — there is exactly one implementation.

**Files:**
- Create: `src/server/audit/canonical.ts`
- Test: `src/server/audit/canonical.test.ts`

**Interfaces:**
- Produces:
  - `const ZERO_HASH = "0".repeat(64)` — genesis `prevHash`.
  - `type AuditActorType = "user" | "system" | "device" | "customer"`
  - `type CanonicalInput = { prevHash: string; seq: number; tenantId: string; actorUserId: string | null; action: string; entityType: string; entityId: string; metadata: Record<string, unknown>; createdAt: string }`
  - `function canonicalize(input: CanonicalInput): string` — deterministic, sorted-key encoding.
  - `function sha256Hex(input: string): string`
  - `function entryHash(input: CanonicalInput): string` — `sha256Hex(canonicalize(input))`.

- [ ] **Step 1: Write the failing tests.** Create `src/server/audit/canonical.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { canonicalize, sha256Hex, entryHash, ZERO_HASH, type CanonicalInput } from "./canonical";

const base: CanonicalInput = {
  prevHash: ZERO_HASH,
  seq: 1,
  tenantId: "11111111-1111-1111-1111-111111111111",
  actorUserId: null,
  action: "order.placed",
  entityType: "order",
  entityId: "order-1",
  metadata: { total: "125.40", channel: "pos" },
  createdAt: "2026-07-24T10:00:00.000Z",
};

describe("canonicalize", () => {
  it("is stable regardless of metadata key order", () => {
    const a = canonicalize({ ...base, metadata: { total: "125.40", channel: "pos" } });
    const b = canonicalize({ ...base, metadata: { channel: "pos", total: "125.40" } });
    expect(a).toBe(b);
  });

  it("encodes a null actor explicitly (not as absent)", () => {
    expect(canonicalize(base)).toContain("null");
  });

  it("changes when any hashed field changes", () => {
    expect(canonicalize(base)).not.toBe(canonicalize({ ...base, seq: 2 }));
    expect(canonicalize(base)).not.toBe(canonicalize({ ...base, entityId: "order-2" }));
    expect(canonicalize(base)).not.toBe(canonicalize({ ...base, action: "order.cancelled" }));
  });
});

describe("sha256Hex", () => {
  it("matches a known vector", () => {
    // echo -n "serveos" | shasum -a 256
    expect(sha256Hex("serveos")).toBe("a4a1...");
  });

  it("is 64 lowercase hex chars", () => {
    expect(entryHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("ZERO_HASH", () => {
  it("is 64 zeros (genesis prevHash)", () => {
    expect(ZERO_HASH).toBe("0000000000000000000000000000000000000000000000000000000000000000");
  });
});
```

- [ ] **Step 2: Run to verify they fail.**

Run: `npx vitest run src/server/audit/canonical.test.ts`
Expected: FAIL — `canonicalize is not a function`.

- [ ] **Step 3: Implement.** Create `src/server/audit/canonical.ts`:

```ts
import { createHash } from "node:crypto";

export const ZERO_HASH = "0".repeat(64);

export type AuditActorType = "user" | "system" | "device" | "customer";

export type CanonicalInput = {
  prevHash: string;
  seq: number;
  tenantId: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown>;
  /** RFC3339, fixed millisecond precision — the DB clock captured inside the tx. */
  createdAt: string;
};

/** Recursively sorts object keys so the same logical value always serializes identically. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

/**
 * The exact byte sequence that gets hashed. The nine fields the spec names, in
 * a fixed order, with the metadata object key-sorted. Nulls are explicit tokens
 * so "no actor" hashes differently from "actor missing from the encoding".
 */
export function canonicalize(input: CanonicalInput): string {
  return stableStringify({
    prevHash: input.prevHash,
    seq: input.seq,
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    metadata: input.metadata,
    createdAt: input.createdAt,
  });
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function entryHash(input: CanonicalInput): string {
  return sha256Hex(canonicalize(input));
}
```

- [ ] **Step 4: Pin the known vector.** Compute the real hash and replace the `"a4a1..."` placeholder:

```bash
printf 'serveos' | shasum -a 256
```

Paste the 64-char digest into the test.

- [ ] **Step 5: Run to verify they pass.**

Run: `npx vitest run src/server/audit/canonical.test.ts && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 6: Commit.**

```bash
git add src/server/audit/canonical.ts src/server/audit/canonical.test.ts
git commit -m "feat(audit): canonical serialization + sha256 entry hash (pure, one implementation)"
```

---

## Task 3: `recordAuditEvent` — append inside the caller's transaction

The core surface. It takes the per-tenant advisory lock, reads the head (genesis = `seq 0`, `ZERO_HASH`), advances, and inserts — all on the `tx` it is handed, so it commits or rolls back with the mutation.

**Files:**
- Create: `src/server/audit/service.ts`
- Test: `src/server/audit/service.test.ts`

**Interfaces:**
- Consumes: `entryHash`, `ZERO_HASH`, `AuditActorType` (Task 2); `auditEvents`, `auditChainHeads` (Task 1); `withTenant` (`@/db/with-tenant`).
- Produces:
  - `type AuditFingerprint = { deviceId: string | null; deviceTokenHash: string | null; appVersion: string | null; ip: string | null; userAgent: string | null }`
  - `type AuditContext = { tenantId: string; branchId?: string | null; actorUserId?: string | null; fingerprint: AuditFingerprint }`
  - `type AuditActorInput = { actorUserId?: string | null; actorType?: AuditActorType; fingerprint: AuditFingerprint; roleKey?: string | null }` — the shape every mutating service accepts as its optional `audit?` param (Tasks 6–9), used to build an `AuditContext` + `metadata.roleKey`.
  - `type AuditEventInput = { action: string; entityType: string; entityId: string; summary: string; metadata?: Record<string, unknown>; actorType?: AuditActorType }`
  - `type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]`
  - `function recordAuditEvent(ctx: AuditContext, event: AuditEventInput, tx: Tx): Promise<void>`

- [ ] **Step 1: Write the failing tests.** Create `src/server/audit/service.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { auditEvents, auditChainHeads } from "./schema";
import { recordAuditEvent, type AuditContext } from "./service";
import { ZERO_HASH, entryHash } from "./canonical";

let n = 0;
async function seedTenant() {
  const [t] = await db.insert(tenants).values({
    slug: `audit-${n++}`, name: "T", country: "EG", vertical: "restaurant",
  }).returning();
  return t.id;
}
const ctxFor = (tenantId: string): AuditContext => ({
  tenantId,
  fingerprint: { deviceId: null, deviceTokenHash: null, appVersion: null, ip: null, userAgent: null },
});
const ev = (entityId: string) => ({
  action: "test.event", entityType: "test", entityId, summary: "s", actorType: "system" as const,
});

describe("recordAuditEvent", () => {
  it("genesis: first event is seq 1 with prevHash = 64 zeros and advances the head", async () => {
    const tenantId = await seedTenant();
    await withTenant(tenantId, (tx) => recordAuditEvent(ctxFor(tenantId), ev("e1"), tx));

    const [row] = await withTenant(tenantId, (tx) => tx.select().from(auditEvents));
    expect(row.seq).toBe(1);
    expect(row.prevHash).toBe(ZERO_HASH);

    const [head] = await withTenant(tenantId, (tx) => tx.select().from(auditChainHeads));
    expect(head.seq).toBe(1);
    expect(head.headHash).toBe(row.entryHash);
  });

  it("links each row's prevHash to the previous entryHash and recomputes exactly", async () => {
    const tenantId = await seedTenant();
    for (const id of ["a", "b", "c"]) {
      await withTenant(tenantId, (tx) => recordAuditEvent(ctxFor(tenantId), ev(id), tx));
    }
    const rows = await withTenant(tenantId, (tx) => tx.select().from(auditEvents).orderBy(asc(auditEvents.seq)));
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    for (let i = 0; i < rows.length; i++) {
      const prev = i === 0 ? ZERO_HASH : rows[i - 1].entryHash;
      expect(rows[i].prevHash).toBe(prev);
      expect(rows[i].entryHash).toBe(entryHash({
        prevHash: prev, seq: rows[i].seq, tenantId, actorUserId: null,
        action: rows[i].action, entityType: rows[i].entityType, entityId: rows[i].entityId,
        metadata: rows[i].metadata, createdAt: rows[i].createdAt.toISOString(),
      }));
    }
  });

  it("rolls back with the mutation when the surrounding tx throws", async () => {
    const tenantId = await seedTenant();
    await expect(withTenant(tenantId, async (tx) => {
      await recordAuditEvent(ctxFor(tenantId), ev("x"), tx);
      throw new Error("boom");
    })).rejects.toThrow("boom");
    const rows = await withTenant(tenantId, (tx) => tx.select().from(auditEvents));
    expect(rows).toHaveLength(0);
    const heads = await withTenant(tenantId, (tx) => tx.select().from(auditChainHeads));
    expect(heads).toHaveLength(0);
  });

  it("assigns a strictly monotonic seq with no gap/duplicate under concurrent appends", async () => {
    const tenantId = await seedTenant();
    await Promise.all([
      withTenant(tenantId, (tx) => recordAuditEvent(ctxFor(tenantId), ev("p1"), tx)),
      withTenant(tenantId, (tx) => recordAuditEvent(ctxFor(tenantId), ev("p2"), tx)),
    ]);
    const rows = await withTenant(tenantId, (tx) => tx.select().from(auditEvents).orderBy(asc(auditEvents.seq)));
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    const [head] = await withTenant(tenantId, (tx) => tx.select().from(auditChainHeads));
    expect(head.seq).toBe(2);
    expect(head.headHash).toBe(rows[1].entryHash);
  });

  it("hides one tenant's events from another (RLS)", async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    await withTenant(a, (tx) => recordAuditEvent(ctxFor(a), ev("only-a"), tx));
    const seenByB = await withTenant(b, (tx) => tx.select().from(auditEvents));
    expect(seenByB).toHaveLength(0);
  });

  it("the trigger rejects UPDATE and DELETE of an event", async () => {
    const tenantId = await seedTenant();
    await withTenant(tenantId, (tx) => recordAuditEvent(ctxFor(tenantId), ev("e1"), tx));
    // Must run inside withTenant: RLS hides the row from a context with no
    // app.tenant_id, so the UPDATE would match zero rows and never fire the
    // per-row trigger. Inside the tenant context the row is visible and the
    // trigger raises.
    await expect(withTenant(tenantId, (tx) =>
      tx.execute(sql`UPDATE audit_events SET action = 'tampered'`))).rejects.toThrow(/append-only/);
    await expect(withTenant(tenantId, (tx) =>
      tx.execute(sql`DELETE FROM audit_events`))).rejects.toThrow(/append-only/);
  });
});
```

- [ ] **Step 2: Run to verify they fail.**

Run: `npx vitest run src/server/audit/service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement.** Create `src/server/audit/service.ts`:

```ts
import { sql, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { auditEvents, auditChainHeads } from "./schema";
import { entryHash, ZERO_HASH, type AuditActorType } from "./canonical";

export type AuditFingerprint = {
  deviceId: string | null;
  deviceTokenHash: string | null;
  appVersion: string | null;
  ip: string | null;
  userAgent: string | null;
};

export type AuditContext = {
  tenantId: string;
  branchId?: string | null;
  actorUserId?: string | null;
  fingerprint: AuditFingerprint;
};

/** The optional `audit?` param every mutating service accepts (Tasks 6-9). */
export type AuditActorInput = {
  actorUserId?: string | null;
  actorType?: AuditActorType;
  fingerprint: AuditFingerprint;
  roleKey?: string | null;
};

export type AuditEventInput = {
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  metadata?: Record<string, unknown>;
  actorType?: AuditActorType;
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Appends one row to the tenant's chain, ON THE CALLER'S TRANSACTION. Must be
 * called inside a withTenant(tenantId, tx => …) block: the advisory lock and
 * the head read/advance rely on app.tenant_id being set (RLS) and on the outer
 * commit for durability. Never opens its own transaction — the audit row is
 * atomic with the mutation it records. Safe to call more than once per tx (each
 * call sees the prior insert and advances the head again).
 */
export async function recordAuditEvent(ctx: AuditContext, event: AuditEventInput, tx: Tx): Promise<void> {
  // 1. Serialize the read-then-advance window per tenant — same lock, same key
  //    as placeOrder's order-number step. Re-acquiring a lock the transaction
  //    already holds is a no-op, so this is safe even when placeOrder is the caller.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ctx.tenantId})::bigint)`);

  // 2. Read the head (genesis if absent).
  const [head] = await tx.select().from(auditChainHeads).where(eq(auditChainHeads.tenantId, ctx.tenantId)).limit(1);
  const prevSeq = head?.seq ?? 0;
  const prevHash = head?.headHash ?? ZERO_HASH;
  const seq = prevSeq + 1;

  // 3. Capture the DB clock inside the tx so the stored createdAt IS the hashed
  //    createdAt (millisecond precision both ways).
  const nowRes = await tx.execute<{ now: Date }>(sql`SELECT now() AS now`);
  const createdAt = new Date(nowRes.rows[0].now);

  const actorUserId = ctx.actorUserId ?? null;
  const metadata = event.metadata ?? {};

  // 4. Hash over exactly the nine spec fields (fingerprint is NOT hashed).
  const hash = entryHash({
    prevHash, seq, tenantId: ctx.tenantId, actorUserId,
    action: event.action, entityType: event.entityType, entityId: event.entityId,
    metadata, createdAt: createdAt.toISOString(),
  });

  // 5. Insert the row.
  await tx.insert(auditEvents).values({
    tenantId: ctx.tenantId,
    branchId: ctx.branchId ?? null,
    actorUserId,
    actorType: event.actorType ?? (actorUserId ? "user" : "system"),
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    summary: event.summary,
    metadata,
    fingerprint: ctx.fingerprint as unknown as Record<string, unknown>,
    seq, prevHash, entryHash: hash, createdAt,
  });

  // 6. Advance the head (create on genesis, update thereafter).
  await tx.insert(auditChainHeads)
    .values({ tenantId: ctx.tenantId, seq, headHash: hash, updatedAt: createdAt })
    .onConflictDoUpdate({
      target: auditChainHeads.tenantId,
      set: { seq, headHash: hash, updatedAt: createdAt },
    });
}
```

- [ ] **Step 4: Run to verify they pass.**

Run: `npx vitest run src/server/audit/service.test.ts && npx tsc --noEmit`
Expected: PASS, clean. The concurrency test proves the advisory lock serializes the window; the trigger test proves append-only.

- [ ] **Step 5: Commit.**

```bash
git add src/server/audit/service.ts src/server/audit/service.test.ts
git commit -m "feat(audit): recordAuditEvent — per-tenant advisory-locked, atomic chain append"
```

---

## Task 4: Fingerprint + actor capture at the API boundary

The fingerprint is assembled where the request enters and threaded through `ctx`. POS reads the new `X-POS-App-Version` header and hashes the device bearer token; web routes derive `{appVersion, ip, userAgent}` from the `Request`; server actions derive them from `await headers()`, with `deviceId`/`deviceTokenHash` null. `actionAudit(ctx)` bundles the signed-in dashboard user + a header fingerprint into the `audit?` param every service accepts.

**Files:**
- Create: `src/server/audit/fingerprint.ts`
- Create: `src/server/audit/action-context.ts`
- Modify: `src/server/pos/require-cashier.ts`
- Modify: `src/server/pos/test-helpers.ts`
- Test: `src/server/audit/fingerprint.test.ts`

**Interfaces:**
- Consumes: `sha256Hex` (Task 2), `AuditFingerprint`, `AuditActorInput` (Task 3), `DashboardContext` (`@/server/auth/dashboard-context`).
- Produces:
  - `function emptyFingerprint(): AuditFingerprint` — all null (system/backfill actor).
  - `function webFingerprint(req: Request): AuditFingerprint`
  - `function headersFingerprint(h: Headers): AuditFingerprint` — for server actions that hold `await headers()` rather than a `Request`.
  - `function actionAudit(ctx: DashboardContext): Promise<AuditActorInput>` — `{ actorUserId, actorType: "user", roleKey, fingerprint }`.
  - `PosCashierContext` gains `fingerprint: AuditFingerprint`.

- [ ] **Step 1: Write the failing tests.** Create `src/server/audit/fingerprint.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { webFingerprint, emptyFingerprint } from "./fingerprint";
import { sha256Hex } from "./canonical";

describe("webFingerprint", () => {
  it("derives ip + userAgent from headers, device fields null", () => {
    const req = new Request("https://x/api/orders", {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8", "user-agent": "Mozilla/5.0" },
    });
    const fp = webFingerprint(req);
    expect(fp.ip).toBe("1.2.3.4"); // first hop
    expect(fp.userAgent).toBe("Mozilla/5.0");
    expect(fp.deviceId).toBeNull();
    expect(fp.deviceTokenHash).toBeNull();
  });
});

describe("emptyFingerprint", () => {
  it("is all null", () => {
    expect(emptyFingerprint()).toEqual({
      deviceId: null, deviceTokenHash: null, appVersion: null, ip: null, userAgent: null,
    });
  });
});

describe("token hashing (POS)", () => {
  it("hashes, never stores raw", () => {
    const token = "dev-secret-token";
    expect(sha256Hex(token)).not.toBe(token);
    expect(sha256Hex(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npx vitest run src/server/audit/fingerprint.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the fingerprint helpers.** Create `src/server/audit/fingerprint.ts`:

```ts
import type { AuditFingerprint } from "./service";

/** The build version surfaced to the audit trail; unset in dev is fine (null). */
const WEB_APP_VERSION = process.env.SERVEOS_APP_VERSION ?? null;

export function emptyFingerprint(): AuditFingerprint {
  return { deviceId: null, deviceTokenHash: null, appVersion: null, ip: null, userAgent: null };
}

/** First hop of X-Forwarded-For, else X-Real-IP. */
function clientIp(h: Headers): string | null {
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return h.get("x-real-ip")?.trim() || null;
}

export function headersFingerprint(h: Headers): AuditFingerprint {
  return {
    deviceId: null,
    deviceTokenHash: null,
    appVersion: WEB_APP_VERSION,
    ip: clientIp(h),
    userAgent: h.get("user-agent"),
  };
}

export function webFingerprint(req: Request): AuditFingerprint {
  return headersFingerprint(req.headers);
}
```

- [ ] **Step 4: Implement `actionAudit`.** Create `src/server/audit/action-context.ts` — the single helper every dashboard server action calls to build its `audit?` param:

```ts
import { headers } from "next/headers";
import type { DashboardContext } from "@/server/auth/dashboard-context";
import { headersFingerprint } from "./fingerprint";
import type { AuditActorInput } from "./service";

/**
 * The audit actor for a dashboard server action: the signed-in user
 * (staff/manager/owner all record as `user`, role in metadata) + a fingerprint
 * derived from the request headers. Pass the result as the service's `audit?` arg.
 */
export async function actionAudit(ctx: DashboardContext): Promise<AuditActorInput> {
  return {
    actorUserId: ctx.user.id,
    actorType: "user",
    roleKey: ctx.roleKeys[0] ?? null,
    fingerprint: headersFingerprint(await headers()),
  };
}
```

- [ ] **Step 5: Extend `requirePosCashier`.** In `src/server/pos/require-cashier.ts`, add `fingerprint` to the context type and build it. Add the imports:

```ts
import { sha256Hex } from "@/server/audit/canonical";
import type { AuditFingerprint } from "@/server/audit/service";
```

Add to `PosCashierContext`:

```ts
  fingerprint: AuditFingerprint;
```

Inside `requirePosCashier`, after resolving `device` and `session`, extract the bearer token (already on the header) and assemble the fingerprint before the return:

```ts
  const bearer = req.headers.get("authorization") ?? "";
  const deviceToken = bearer.startsWith("Bearer ") ? bearer.slice(7).trim() : "";
  const fingerprint: AuditFingerprint = {
    deviceId: device.deviceId,
    // Hash of whatever token was valid at capture time. The raw token is never
    // stored, so a leaked audit dump cannot be replayed to authenticate.
    deviceTokenHash: deviceToken ? sha256Hex(deviceToken) : null,
    // Missing on older POS builds → null, and we still audit (never block a sale).
    appVersion: req.headers.get("x-pos-app-version")?.trim() || null,
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: req.headers.get("user-agent"),
  };
```

Add `fingerprint,` to the returned object.

- [ ] **Step 6: Fix the test fixture.** `PosCashierContext` now requires `fingerprint`, so `seedPosContext` (`src/server/pos/test-helpers.ts`) no longer type-checks. Add a synthetic fingerprint to the returned `ctx`:

```ts
      permissions: session.permissions,
      fingerprint: {
        deviceId: device.deviceId, deviceTokenHash: "test-token-hash",
        appVersion: "test-1.0.0", ip: "127.0.0.1", userAgent: "vitest",
      },
```

- [ ] **Step 7: Run tests + typecheck.**

Run: `npx vitest run src/server/audit/fingerprint.test.ts && npx tsc --noEmit && npx eslint src/server/audit src/server/pos`
Expected: PASS, clean. Existing `record-sale.test.ts` still passes because `seedPosContext` now supplies the field.

- [ ] **Step 8: Commit.**

```bash
git add src/server/audit/fingerprint.ts src/server/audit/action-context.ts src/server/audit/fingerprint.test.ts src/server/pos/require-cashier.ts src/server/pos/test-helpers.ts
git commit -m "feat(audit): capture device/session fingerprint + dashboard action actor at the boundary"
```

---

## Task 5: `audit:view` permission + the chain verifier

Two independent additions. The permission gates every read (Task 11). The verifier walks a tenant's chain, recomputes each hash, and reports the first `seq` that no longer reconciles — it never mutates or "repairs".

**Files:**
- Modify: `src/server/rbac/permissions.ts`
- Test: `src/server/rbac/permissions.test.ts`
- Create: `src/server/audit/verifier.ts`
- Test: `src/server/audit/verifier.test.ts`

**Interfaces:**
- Produces:
  - Permission `audit:view` — held by `owner` and `manager`, **not** `staff`.
  - `type ChainStatus = { ok: true; seq: number; headHash: string } | { ok: false; brokenSeq: number }`
  - `function verifyChain(tenantId: string): Promise<ChainStatus>`

- [ ] **Step 1: Write the failing permission test.** Append to (or create) `src/server/rbac/permissions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ROLE_PERMISSIONS } from "./permissions";

describe("audit:view", () => {
  it("is held by owner and manager", () => {
    expect(ROLE_PERMISSIONS.owner).toContain("audit:view");
    expect(ROLE_PERMISSIONS.manager).toContain("audit:view");
  });
  it("is NOT held by staff", () => {
    expect(ROLE_PERMISSIONS.staff).not.toContain("audit:view");
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npx vitest run src/server/rbac/permissions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the permission.** In `src/server/rbac/permissions.ts`, add `"audit:view",` to the `PERMISSIONS` array, then append it to the `owner` and `manager` arrays in `ROLE_PERMISSIONS`:

```ts
  owner: ["tenant:manage", "staff:invite", "plan:view", "plan:change", "billing:manage", "menu:manage", "orders:manage", "fulfillment:manage", "pos:sell", "pos:discount", "pos:void", "pos:refund", "audit:view"],
  manager: ["staff:invite", "plan:view", "menu:manage", "orders:manage", "fulfillment:manage", "pos:sell", "pos:discount", "pos:void", "pos:refund", "audit:view"],
```

- [ ] **Step 4: Write the failing verifier tests.** Create `src/server/audit/verifier.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { recordAuditEvent, type AuditContext } from "./service";
import { verifyChain } from "./verifier";

let n = 0;
async function seedChain(len: number) {
  const [t] = await db.insert(tenants).values({
    slug: `verify-${n++}`, name: "T", country: "EG", vertical: "restaurant",
  }).returning();
  const ctx: AuditContext = {
    tenantId: t.id,
    fingerprint: { deviceId: null, deviceTokenHash: null, appVersion: null, ip: null, userAgent: null },
  };
  for (let i = 0; i < len; i++) {
    await withTenant(t.id, (tx) => recordAuditEvent(ctx, {
      action: "test.event", entityType: "test", entityId: `e${i}`, summary: "s", actorType: "system",
    }, tx));
  }
  return t.id;
}

describe("verifyChain", () => {
  it("returns ok for an untampered chain", async () => {
    const tenantId = await seedChain(3);
    const status = await verifyChain(tenantId);
    expect(status.ok).toBe(true);
    if (status.ok) expect(status.seq).toBe(3);
  });

  it("returns ok for an empty (never-written) chain", async () => {
    const [t] = await db.insert(tenants).values({
      slug: `verify-empty-${n++}`, name: "T", country: "EG", vertical: "restaurant",
    }).returning();
    expect((await verifyChain(t.id)).ok).toBe(true);
  });

  it("reports the first broken seq after a hand-corrupted row", async () => {
    const tenantId = await seedChain(4);
    // The trigger blocks UPDATE, so disable it to simulate a DB-admin tamper —
    // exactly the manual-acceptance scenario in the spec.
    await db.execute(sql`ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only`);
    await withTenant(tenantId, (tx) =>
      tx.execute(sql`UPDATE audit_events SET metadata = '{"tampered":true}'::jsonb WHERE seq = 2`));
    await db.execute(sql`ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only`);

    const status = await verifyChain(tenantId);
    expect(status).toEqual({ ok: false, brokenSeq: 2 });
  });
});
```

- [ ] **Step 5: Run to verify they fail.**

Run: `npx vitest run src/server/audit/verifier.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 6: Implement the verifier.** Create `src/server/audit/verifier.ts`:

```ts
import { asc } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { auditEvents } from "./schema";
import { entryHash, ZERO_HASH } from "./canonical";

export type ChainStatus =
  | { ok: true; seq: number; headHash: string }
  | { ok: false; brokenSeq: number };

/**
 * Walks a tenant's chain in seq order, recomputing each entryHash from the
 * stored fields and checking prevHash == the previous row's entryHash. Returns
 * the first seq that diverges. Read-only, RLS-scoped — a break is a finding,
 * never auto-repaired (Spec 5 turns it into an alert).
 */
export async function verifyChain(tenantId: string): Promise<ChainStatus> {
  const rows = await withTenant(tenantId, (tx) =>
    tx.select().from(auditEvents).orderBy(asc(auditEvents.seq)));

  let prevHash = ZERO_HASH;
  for (const row of rows) {
    if (row.prevHash !== prevHash) return { ok: false, brokenSeq: row.seq };
    const recomputed = entryHash({
      prevHash, seq: row.seq, tenantId, actorUserId: row.actorUserId,
      action: row.action, entityType: row.entityType, entityId: row.entityId,
      metadata: row.metadata, createdAt: row.createdAt.toISOString(),
    });
    if (recomputed !== row.entryHash) return { ok: false, brokenSeq: row.seq };
    prevHash = row.entryHash;
  }
  return { ok: true, seq: rows.length === 0 ? 0 : rows[rows.length - 1].seq, headHash: prevHash };
}
```

- [ ] **Step 7: Run everything for this task.**

Run: `npx vitest run src/server/rbac/permissions.test.ts src/server/audit/verifier.test.ts && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 8: Commit.**

```bash
git add src/server/rbac/permissions.ts src/server/rbac/permissions.test.ts src/server/audit/verifier.ts src/server/audit/verifier.test.ts
git commit -m "feat(audit): audit:view permission + chain verifier reporting the first broken seq"
```

---

## Task 6: Emit — Group A: ordering + POS

The largest emission group: the money-and-till path. Every mutating write threads its `audit?` actor and calls `recordAuditEvent` inside its own transaction. `placeOrder` always emits `order.placed` (web → `customer`, POS → `user`); when no fingerprint is supplied (older tests, backfill) it defaults to `emptyFingerprint()` so the chain still advances. `recordSale` adds `sale.recorded` + one `discount.*` row per adjustment; `addTender` → `payment.tender_added`; `transitionStatus` → `order.status_changed {before,after}`; `markPaid` → `order.marked_paid`; `cancelOrderByToken` → `order.cancelled` (customer). POS session/device/ticket surfaces emit `auth.cashier_signed_in`/`auth.login`(+`auth.login_failed`), `ticket.held`/`ticket.discarded`, `device.pairing_created`/`device.paired`/`device.revoked`, and `authz.manager_granted`.

**Files:**
- Modify: `src/server/ordering/service.ts`, `src/server/pos/record-sale.ts`, `src/server/pos/cashier.ts`, `src/server/pos/held-tickets.ts`, `src/server/pos/service.ts`
- Modify: `src/app/api/orders/route.ts`, `src/app/api/orders/[token]/cancel/route.ts`, `src/app/dashboard/orders/[id]/actions.ts`, `src/app/api/pos/v1/orders/status/route.ts`, `src/app/api/pos/v1/sales/route.ts`, `src/app/api/pos/v1/sales/[id]/payments/route.ts`, `src/app/api/pos/v1/cashier/login/route.ts`, `src/app/api/pos/v1/held-tickets/route.ts`, `src/app/api/pos/v1/held-tickets/[id]/route.ts`, `src/app/api/pos/v1/authorize/route.ts`, `src/app/api/pos/v1/pair/route.ts`, `src/app/api/pos/v1/login/route.ts`, `src/app/dashboard/settings/pos-devices/actions.ts`
- Test: `src/server/audit/emission-ordering.test.ts`, `src/server/audit/emission-pos.test.ts`

**Interfaces:**
- Consumes: `recordAuditEvent`, `AuditContext`, `AuditActorInput`, `AuditFingerprint` (Task 3); `emptyFingerprint`, `webFingerprint` (Task 4); `verifyChain` (Task 5); `PosCashierContext.fingerprint` (Task 4).
- Produces:
  - `PlaceOrderInput` gains `audit?: { fingerprint: AuditFingerprint; actorUserId?: string | null; actorType?: AuditActorType }`.
  - `transitionStatus(tenantId, orderId, to, userId, reason?, audit?: { fingerprint: AuditFingerprint })`.
  - `markPaid(tenantId, orderId, userId, audit?: { fingerprint: AuditFingerprint })`.
  - `cancelOrderByToken(tenantId, token, audit?: { fingerprint: AuditFingerprint })`.
  - `signInCashier(tenantId, email, password, audit?: { fingerprint: AuditFingerprint })` emits `auth.cashier_signed_in` / `auth.login_failed`.

- [ ] **Step 1: Write the failing ordering emission tests.** Create `src/server/audit/emission-ordering.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { auditEvents } from "./schema";
import { verifyChain } from "./verifier";
import { placeOrder, transitionStatus, markPaid, cancelOrderByToken } from "@/server/ordering/service";
import { seedPosContext } from "@/server/pos/test-helpers";

async function eventsFor(tenantId: string, action: string) {
  return withTenant(tenantId, (tx) =>
    tx.select().from(auditEvents).where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.action, action))));
}
const walkIn = (branchId: string, productId: string) => ({
  branchId, fulfillmentType: "pickup" as const, customerName: "Walk-in", customerPhone: "000000000",
  lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
});

describe("audit emission — ordering", () => {
  it("placeOrder emits order.placed and keeps a valid chain", async () => {
    const { ctx, tenantId, branchId, productId } = await seedPosContext("owner");
    await placeOrder(tenantId, {
      ...walkIn(branchId, productId), channel: "pos", cashierUserId: ctx.cashierUserId,
      audit: { fingerprint: ctx.fingerprint, actorUserId: ctx.cashierUserId, actorType: "user" },
    });
    expect(await eventsFor(tenantId, "order.placed")).toHaveLength(1);
    expect((await verifyChain(tenantId)).ok).toBe(true);
  });

  it("transitionStatus emits order.status_changed with before/after", async () => {
    const { ctx, tenantId, branchId, productId } = await seedPosContext("owner");
    const res = await placeOrder(tenantId, { ...walkIn(branchId, productId), audit: { fingerprint: ctx.fingerprint } });
    await transitionStatus(tenantId, res.orderId, "confirmed", ctx.cashierUserId, undefined, { fingerprint: ctx.fingerprint });
    const [row] = await eventsFor(tenantId, "order.status_changed");
    expect(row.metadata).toMatchObject({ before: "pending", after: "confirmed" });
  });

  it("markPaid emits order.marked_paid", async () => {
    const { ctx, tenantId, branchId, productId } = await seedPosContext("owner");
    const res = await placeOrder(tenantId, { ...walkIn(branchId, productId), audit: { fingerprint: ctx.fingerprint } });
    await markPaid(tenantId, res.orderId, ctx.cashierUserId, { fingerprint: ctx.fingerprint });
    expect(await eventsFor(tenantId, "order.marked_paid")).toHaveLength(1);
  });

  it("cancelOrderByToken emits order.cancelled as a customer actor", async () => {
    const { ctx, tenantId, branchId, productId } = await seedPosContext("owner");
    const res = await placeOrder(tenantId, { ...walkIn(branchId, productId), audit: { fingerprint: ctx.fingerprint } });
    const [order] = await withTenant(tenantId, (tx) => tx.select().from(auditEvents).limit(0)); // noop keep import
    await cancelOrderByToken(tenantId, res.statusToken);
    const [row] = await eventsFor(tenantId, "order.cancelled");
    expect(row.actorType).toBe("customer");
    expect((await verifyChain(tenantId)).ok).toBe(true);
    void order;
  });
});
```

(Read `src/server/pos/test-helpers.ts` first and match `seedPosContext`'s return shape; drop the noop line if it does not typecheck.)

- [ ] **Step 2: Run to verify they fail.**

Run: `npx vitest run src/server/audit/emission-ordering.test.ts`
Expected: FAIL — `audit` is not a known input / no rows emitted.

- [ ] **Step 3: Wire `placeOrder`.** In `src/server/ordering/service.ts` add the imports:

```ts
import { recordAuditEvent, type AuditFingerprint } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import type { AuditActorType } from "@/server/audit/canonical";
```

Add to `PlaceOrderInput`:

```ts
  audit?: { fingerprint: AuditFingerprint; actorUserId?: string | null; actorType?: AuditActorType };
```

Immediately after the initial status event insert (before `return { orderId: order.id, … }`), emit inside the same `tx`:

```ts
    await recordAuditEvent(
      {
        tenantId, branchId: input.branchId,
        actorUserId: input.audit?.actorUserId ?? input.cashierUserId ?? null,
        fingerprint: input.audit?.fingerprint ?? emptyFingerprint(),
      },
      {
        action: "order.placed", entityType: "order", entityId: order.id,
        summary: `Order #${orderNumber} placed (${input.channel ?? "web"})`,
        metadata: { orderNumber, channel: input.channel ?? "web", total: money(totals.total) },
        actorType: input.audit?.actorType ?? (input.cashierUserId ? "user" : "customer"),
      },
      tx,
    );
```

- [ ] **Step 4: Wire `transitionStatus`, `markPaid`, `cancelOrderByToken`.** Extend the signatures and emit inside their existing `withTenant` blocks.

`transitionStatus` — after the `orderStatusEvents` insert, before `return updated;`:

```ts
export async function transitionStatus(tenantId: string, orderId: string, to: OrderStatus, userId: string, reason?: string, audit?: { fingerprint: AuditFingerprint }): Promise<Order> {
  // …existing body…
    await recordAuditEvent(
      { tenantId, branchId: updated.branchId, actorUserId: userId, fingerprint: audit?.fingerprint ?? emptyFingerprint() },
      { action: "order.status_changed", entityType: "order", entityId: orderId,
        summary: `Order status ${order.status} → ${to}`,
        metadata: { before: order.status, after: to, reason: reason ?? null }, actorType: "user" },
      tx,
    );
```

`markPaid` (rename `_userId` → `userId`, now used) — after the update, before `return updated;`:

```ts
export async function markPaid(tenantId: string, orderId: string, userId: string, audit?: { fingerprint: AuditFingerprint }): Promise<Order> {
  // …existing body…
    await recordAuditEvent(
      { tenantId, branchId: updated.branchId, actorUserId: userId, fingerprint: audit?.fingerprint ?? emptyFingerprint() },
      { action: "order.marked_paid", entityType: "order", entityId: orderId,
        summary: `Order marked paid`, metadata: { total: updated.total }, actorType: "user" },
      tx,
    );
```

`cancelOrderByToken` — this is the storefront customer path (no user). After the `orderStatusEvents` insert, before `return updated;`:

```ts
export async function cancelOrderByToken(tenantId: string, token: string, audit?: { fingerprint: AuditFingerprint }): Promise<Order> {
  // …existing body…
    await recordAuditEvent(
      { tenantId, branchId: updated.branchId, actorUserId: null, fingerprint: audit?.fingerprint ?? emptyFingerprint() },
      { action: "order.cancelled", entityType: "order", entityId: order.id,
        summary: `Order cancelled by customer`, metadata: { reason: "cancelled_by_customer" }, actorType: "customer" },
      tx,
    );
```

- [ ] **Step 5: Write the failing POS emission tests.** Create `src/server/audit/emission-pos.test.ts` — seed with `seedPosContext`, then assert:
  - `recordSale` emits exactly one `sale.recorded`, and one `discount.line_applied` per discounted line (derive `expectedTotal` from the discounted cart with the fixture's `computeCartTotals`, exactly as `record-sale.test.ts` does — read that file first and copy its total-derivation, do not hardcode).
  - `addTender` on a partially-paid order emits `payment.tender_added`.
  - `signInCashier(tenantId, email, "correct", { fingerprint })` emits `auth.cashier_signed_in`; a wrong password emits `auth.login_failed` (null `actorUserId`) and still throws `PosCashierError`.
  - `holdTicket` → `ticket.held`; `discardHeldTicket` → `ticket.discarded`.
  - `redeemPairingCode` / `revokeDevice` emit `device.paired` / `device.revoked`, and `verifyChain(tenantId).ok` after each.

Follow the seeding + total-derivation shapes already in `src/server/pos/record-sale.test.ts` and `src/server/pos/cashier.test.ts`.

- [ ] **Step 6: Run to verify they fail.**

Run: `npx vitest run src/server/audit/emission-pos.test.ts`
Expected: FAIL.

- [ ] **Step 7: Wire `recordSale` + `addTender`.** In `src/server/pos/record-sale.ts`, import `recordAuditEvent`. Inside the existing `withTenant(ctx.tenantId, async (tx) => { … })` block (the one that writes tenders + adjustments), after the adjustment-event inserts, build the audit context once and emit one `discount.*` per adjustment (a `for` loop, awaited so each insert is visible to the next append), then `sale.recorded` **last** so it is the tip:

```ts
    const auditCtx = { tenantId: ctx.tenantId, branchId: ctx.branchId, actorUserId: ctx.cashierUserId, fingerprint: ctx.fingerprint };
    for (let i = 0; i < input.lines.length; i++) {
      const line = input.lines[i];
      if ((line.discountAmount ?? 0) > 0) {
        await recordAuditEvent(auditCtx, {
          action: "discount.line_applied", entityType: "order", entityId: placed.orderId,
          summary: `Line discount ${money(line.discountAmount!)}`,
          metadata: { orderItemId: placed.itemIds[i], amount: money(line.discountAmount!), reasonCode: line.discountReason ?? "other", byUserId: ctx.cashierUserId, authorizedByUserId: discountAuthorizer },
          actorType: "user",
        }, tx);
      }
    }
    // …order-discount `discount.order_applied` when hasOrderDiscount…
    await recordAuditEvent(auditCtx, {
      action: "sale.recorded", entityType: "order", entityId: placed.orderId,
      summary: `Sale #${placed.orderNumber} — ${paymentStatus}`,
      metadata: {
        orderNumber: String(placed.orderNumber), total: money(placed.total), paymentStatus,
        tenders: input.payments.map((p) => ({ method: p.method, amount: money(p.amount) })),
      }, actorType: "user",
    }, tx);
```

Add a code comment: forward emission points (`void.line`, `void.order`, `refund.*`, inventory/PO/ETA events) attach to this same helper in Specs 3/8/9/11 — no chain change. In `addTender`, inside its `withTenant` block after the new tender insert, emit `payment.tender_added` (`metadata: { method, amount, paymentStatus }`, `actorType: "user"`).

- [ ] **Step 8: Wire `signInCashier` + held tickets + device lifecycle.**
  - `src/server/pos/cashier.ts` `signInCashier(tenantId, email, password, audit?)`: on the wrong-password / not-a-cashier branch, emit `auth.login_failed` (`actorType: "system"`, `actorUserId: null`, `metadata: { email }`) via a one-statement `withTenant(tenantId, tx => recordAuditEvent(...))` **before** throwing; on success emit `auth.cashier_signed_in` (`actorType: "user"`, `actorUserId: user.id`). Use `audit?.fingerprint ?? emptyFingerprint()`.
  - `src/server/pos/held-tickets.ts` `holdTicket` / `discardHeldTicket`: emit `ticket.held` / `ticket.discarded` inside their existing `withTenant` blocks (ctx carries the fingerprint).
  - `src/server/pos/service.ts` `createPairingCode` / `redeemPairingCode` / `revokeDevice` / `loginForPos`: these use the plain `db` client (control-plane, no RLS). Wrap the write + emission in `withTenant(tenantId, tx => …)` so the audit insert has `app.tenant_id`; emit `device.pairing_created` / `device.paired` / `device.revoked`, and `auth.login` / `auth.login_failed` for `loginForPos`. Where no human is involved (device pairing), use `actorType: "device"`.

- [ ] **Step 9: Thread the fingerprint from the boundaries.**
  - `src/app/api/orders/route.ts` — add `audit: { fingerprint: webFingerprint(req) }` to the `placeOrder` input. Web orders keep `actorType: "customer"` by default.
  - `src/app/api/orders/[token]/cancel/route.ts` — pass `{ fingerprint: webFingerprint(req) }` to `cancelOrderByToken`.
  - `src/app/dashboard/orders/[id]/actions.ts` — server actions; import `headersFingerprint` + `headers`, pass `{ fingerprint: headersFingerprint(await headers()) }` to `transitionStatus` / `markPaid`.
  - `src/app/api/pos/v1/orders/status/route.ts` — resolve the POS cashier ctx (it already does) and pass `{ fingerprint: ctx.fingerprint }` to `transitionStatus`.
  - `src/app/api/pos/v1/sales/route.ts`, `.../sales/[id]/payments/route.ts`, `.../held-tickets/route.ts`, `.../held-tickets/[id]/route.ts` — already resolve `ctx` via `requirePosCashier`, so the emission is automatic once the services read `ctx.fingerprint`; no change beyond confirming they pass `ctx`.
  - `src/app/api/pos/v1/cashier/login/route.ts` — pass `{ fingerprint: webFingerprint(req) }` (device-level; `deviceId` null pre-sign-in) to `signInCashier`.
  - `src/app/api/pos/v1/authorize/route.ts` — after `issueGrant`, emit `authz.manager_granted` (`actorUserId: manager.userId`, `actorType: "user"`, `metadata: { permission, cashierUserId: ctx.cashierUserId }`) via a one-statement `withTenant`.
  - `src/app/api/pos/v1/pair/route.ts`, `.../login/route.ts`, `src/app/dashboard/settings/pos-devices/actions.ts` — pass a fingerprint (`webFingerprint(req)` / `actionAudit(ctx)`) into `redeemPairingCode` / `loginForPos` / `createPairingCode` / `revokeDevice`.

- [ ] **Step 10: Run the group's tests, then the full suite.**

Run: `npx vitest run src/server/audit/emission-ordering.test.ts src/server/audit/emission-pos.test.ts && npm test`
Expected: group tests PASS; full suite PASS. Existing `placeOrder`/`recordSale`/`cashier`/`held-tickets` tests still pass — every new arg is optional and defaults to `emptyFingerprint()`, and each mutation simply gains audit rows.

- [ ] **Step 11: Typecheck + lint + commit.**

```bash
npx tsc --noEmit && npx eslint src/server/ordering src/server/pos src/server/audit src/app/api/orders src/app/api/pos src/app/dashboard/orders src/app/dashboard/settings/pos-devices
git add src/server/ordering/service.ts src/server/pos src/app/api/orders src/app/api/pos src/app/dashboard/orders src/app/dashboard/settings/pos-devices src/server/audit/emission-ordering.test.ts src/server/audit/emission-pos.test.ts
git commit -m "feat(audit): emit ordering + POS events (order/sale/discount/tender/status/cancel/cashier/ticket/device/grant)"
```

---

## Task 7: Emit — Group B: catalog

Every catalog mutation emits. Category/product/modifier/variant/branch-availability/stock writes each gain an optional `audit?: AuditActorInput` param; the emission runs inside the same `withTenant` transaction as the write. `updateProduct` compares old vs new price and emits `catalog.product.price_changed` (in addition to `catalog.product.updated`) when the price moved. The dashboard menu actions pass `actionAudit(ctx)`.

**Files:**
- Modify: `src/server/catalog/service.ts`, `src/server/catalog/variants.ts`
- Modify: `src/app/dashboard/menu/categories/actions.ts`, `src/app/dashboard/menu/products/actions.ts`
- Test: `src/server/audit/emission-catalog.test.ts`

**Interfaces:**
- Consumes: `recordAuditEvent`, `AuditActorInput`, `emptyFingerprint` (Tasks 3–4).
- Produces: each mutating catalog function gains `audit?: AuditActorInput`; `updateProduct` emits `catalog.product.updated` + optional `catalog.product.price_changed`.

- [ ] **Step 1: Write the failing tests.** Create `src/server/audit/emission-catalog.test.ts` — reuse the catalog test fixtures already in `src/server/catalog/service.test.ts` / `variants.test.ts` (read them first; do not invent a new seed). Assert:
  - `createProduct` → one `catalog.product.created`; `deleteProduct` → one `catalog.product.deleted`; chain `ok`.
  - `updateProduct` that changes the price → both `catalog.product.updated` and `catalog.product.price_changed` with `metadata:{before,after}`.
  - `createCategory` → `catalog.category.created`; `setBranchAvailability` → `catalog.branch_availability.changed`.
  - `upsertVariant` → `catalog.variant.upserted`; `setProductStock` → `catalog.stock.set` with `{before,after}`.
  - each mutation supplied `audit: { actorUserId, actorType:"user", roleKey:"owner", fingerprint }` records `actorType:"user"` and `metadata.roleKey:"owner"`.

- [ ] **Step 2: Run to verify they fail.**

Run: `npx vitest run src/server/audit/emission-catalog.test.ts`
Expected: FAIL.

- [ ] **Step 3: Wire `src/server/catalog/service.ts`.** For each of `createCategory`, `updateCategory`, `deleteCategory`, `createProduct`, `updateProduct`, `deleteProduct`, `upsertModifierGroup`, `deleteModifierGroup`, `upsertModifierOption`, `deleteModifierOption`, `setBranchAvailability`: add a trailing `audit?: AuditActorInput` param, and ensure the write runs inside `withTenant(tenantId, async (tx) => { …write…; await recordAuditEvent(ctx, event, tx); })`. Where the function currently does a bare `withTenant(tenantId, tx => tx.insert(...))`, expand it to the block form. Build the `AuditContext` as `{ tenantId, actorUserId: audit?.actorUserId ?? null, fingerprint: audit?.fingerprint ?? emptyFingerprint() }` and put `roleKey: audit?.roleKey` into `metadata`. Action names follow the taxonomy: `catalog.category.created|updated|deleted`, `catalog.product.created|updated|deleted`, `catalog.modifier_group.upserted|deleted`, `catalog.modifier_option.upserted|deleted`, `catalog.branch_availability.changed`. For `updateProduct`, read the current row first (already in scope for the update), and after the write, if `before.price !== after.price` emit a second `catalog.product.price_changed` `{before, after}` row.

  Example (`updateProduct`):

```ts
export async function updateProduct(tenantId: string, productId: string, input: UpdateProductInput, audit?: AuditActorInput): Promise<Product> {
  return withTenant(tenantId, async (tx) => {
    const [before] = await tx.select().from(products).where(eq(products.id, productId)).limit(1);
    const [row] = await tx.update(products).set(input).where(eq(products.id, productId)).returning();
    const ctx = { tenantId, actorUserId: audit?.actorUserId ?? null, fingerprint: audit?.fingerprint ?? emptyFingerprint() };
    const meta = (extra: Record<string, unknown>) => ({ roleKey: audit?.roleKey ?? null, ...extra });
    await recordAuditEvent(ctx, {
      action: "catalog.product.updated", entityType: "product", entityId: productId,
      summary: `Product "${row.name}" updated`, metadata: meta({}), actorType: audit?.actorType ?? "user",
    }, tx);
    if (before && before.price !== row.price) {
      await recordAuditEvent(ctx, {
        action: "catalog.product.price_changed", entityType: "product", entityId: productId,
        summary: `Price ${before.price} → ${row.price}`,
        metadata: meta({ before: before.price, after: row.price }), actorType: audit?.actorType ?? "user",
      }, tx);
    }
    return row;
  });
}
```

- [ ] **Step 4: Wire `src/server/catalog/variants.ts`.** Same pattern for `upsertVariant` → `catalog.variant.upserted`, `deleteVariant` → `catalog.variant.deleted`, `setVariantStock` / `setProductStock` → `catalog.stock.set` (read the old qty first, emit `{before, after}`).

- [ ] **Step 5: Pass `actionAudit` from the menu actions.** In `src/app/dashboard/menu/categories/actions.ts` and `src/app/dashboard/menu/products/actions.ts`, import `actionAudit`, and pass `await actionAudit(ctx)` (where `ctx` is the `requireMenuPermission()` result) as the trailing arg to every catalog call.

- [ ] **Step 6: Run the group's tests + full suite.**

Run: `npx vitest run src/server/audit/emission-catalog.test.ts && npm test`
Expected: group tests PASS; full suite PASS (existing catalog tests unaffected — `audit?` is optional).

- [ ] **Step 7: Typecheck + lint + commit.**

```bash
npx tsc --noEmit && npx eslint src/server/catalog src/app/dashboard/menu src/server/audit
git add src/server/catalog src/app/dashboard/menu src/server/audit/emission-catalog.test.ts
git commit -m "feat(audit): emit catalog events (category/product/price/modifier/variant/stock/availability)"
```

---

## Task 8: Emit — Group C: auth + staff + settings + branches + banners + subscription + onboarding

The rest of the tenant's mutating surface, plus the auth events. Staff/settings/branches/banners/subscription mutations gain an `audit?: AuditActorInput` param and emit inside `withTenant`. Auth events (login / failed login / logout) emit at the action boundary. Onboarding's `registerTenant` emits `tenant.registered` as its tenant's **genesis** row.

**Files:**
- Modify: `src/server/auth/staff.ts`, `src/server/tenancy/settings.ts`, `src/server/branches/service.ts`, `src/server/banners/service.ts`, `src/server/subscription/service.ts`, `src/server/onboarding/service.ts`
- Modify: `src/app/login/actions.ts`, `src/app/register/actions.ts`, `src/app/dashboard/actions.ts`, `src/app/dashboard/settings/staff/actions.ts`, `src/app/dashboard/settings/taxes/actions.ts`, `src/app/dashboard/settings/whatsapp/actions.ts`, `src/app/dashboard/settings/profile/actions.ts`, `src/app/dashboard/settings/fulfillment/actions.ts`, `src/app/dashboard/settings/billing/actions.ts`, `src/app/dashboard/branches/actions.ts`, `src/app/dashboard/banners/actions.ts`
- Test: `src/server/audit/emission-admin.test.ts`, `src/server/audit/emission-auth.test.ts`

**Interfaces:**
- Consumes: `recordAuditEvent`, `AuditActorInput`, `emptyFingerprint`, `actionAudit` (Tasks 3–4).
- Produces:
  - `staff.ts`: `createStaff`/`setStaffRole`/`deactivateStaff` gain `audit?`, refactor `db.transaction` → `withTenant`, emit `staff.invited`/`staff.role_changed`/`staff.deactivated`.
  - `tenancy/settings.ts`: add `updateTaxSettings(tenantId, patch, audit?)` (one write + one `settings.vat_changed` / `settings.service_charge_changed` snapshot), and give `setWhatsappNumber`/`requestPlanUpgrade` an `audit?`; `tenancy/service.ts` `updateTenantProfile` gains `audit?` → `settings.profile_updated` (+`settings.theme_changed`).
  - `branches/service.ts`: create/update/delete/updateBranchOrdering + delivery-area CRUD gain `audit?` → `branch.*`.
  - `banners/service.ts`: create/update/delete gain `audit?` → `banner.*`.
  - `subscription/service.ts`: `startTrial`/`transition` gain `audit?` → `subscription.trial_started`/`subscription.status_changed`.
  - `onboarding/service.ts`: `registerTenant` emits `tenant.registered` (actor = new owner) inside its existing transaction.

- [ ] **Step 1: Write the failing admin emission tests.** Create `src/server/audit/emission-admin.test.ts` — reuse existing per-domain fixtures (read `staff.test.ts`, `settings.test.ts`, `branches/service.test.ts`, `banners/service.test.ts`, `subscription/service.test.ts` first). Assert one row + valid chain for a representative mutation in each: `staff.role_changed` with `{before,after}` roleKey; `settings.vat_changed` with `{before,after}`; `branch.created`; `banner.created`; `subscription.trial_started`; and that `registerTenant` produces a `tenant.registered` genesis row at `seq = 1`.

- [ ] **Step 2: Write the failing auth emission tests.** Create `src/server/audit/emission-auth.test.ts`:
  - a correct `loginAction` (drive it with a seeded owner, or test the underlying emit helper) writes `auth.login`;
  - a wrong password writes `auth.login_failed` with null `actorUserId` and the attempted email in metadata;
  - `signOutAction` (or the invalidate path) writes `auth.logout`.

  Auth actions read cookies/headers; if driving the server action directly is impractical in Vitest, factor the emit into a tiny testable `recordAuthEvent(tenantId, action, {actorUserId, email, fingerprint})` helper in `src/server/audit/auth-events.ts` and test that helper directly, then call it from the actions. Prefer the helper — it keeps the action files thin and the test deterministic.

- [ ] **Step 3: Run to verify they fail.**

Run: `npx vitest run src/server/audit/emission-admin.test.ts src/server/audit/emission-auth.test.ts`
Expected: FAIL.

- [ ] **Step 4: Wire staff.** In `src/server/auth/staff.ts`, refactor `createStaff` and `setStaffRole` from `db.transaction(async (tx) => …)` to `withTenant(tenantId, async (tx) => …)` (control tables have no RLS, so the writes are unaffected, and the audit insert now has `app.tenant_id`). Add `audit?: AuditActorInput` to all three. Emit:
  - `createStaff` → `staff.invited` (`entityType:"staff"`, `entityId:user.id`, `metadata:{roleKey:input.roleKey}`).
  - `setStaffRole` → `staff.role_changed` (`metadata:{before:oldRoleKey, after:roleKey}` — read the current role before the delete/insert).
  - `deactivateStaff` → `staff.deactivated`; it already deletes the user's sessions, so note session-revoke in `metadata`. Wrap its `db.update`+`db.delete`+emit in one `withTenant`.

- [ ] **Step 5: Wire settings + profile.** In `src/server/tenancy/settings.ts` add `updateTaxSettings(tenantId, patch: { vatEnabled?; vatRate?; pricesIncludeVat?; serviceChargeRate? }, audit?)` that reads the current tax config, applies the patch via the existing low-level setters (or a single update), and emits **one** `settings.vat_changed` (and `settings.service_charge_changed` when the service charge moved) with `{before, after}`. Give `setWhatsappNumber` → `settings.whatsapp_changed` and `requestPlanUpgrade` → `subscription.upgrade_requested` an `audit?` + emission. In `src/server/tenancy/service.ts`, give `updateTenantProfile` an `audit?` → `settings.profile_updated`, and when a theme field (`logoUrl`/`coverImageUrl`/`primaryColor`) changed, a second `settings.theme_changed` `{before, after}`. The low-level VAT setters (`setVatRate`/`setVatEnabled`/`setPricesIncludeVat`/`setServiceChargeRate`) stay but are **allowlisted** in Task 10 (justification: "composed by updateTaxSettings, which emits").

- [ ] **Step 6: Wire branches + banners + subscription + onboarding.**
  - `src/server/branches/service.ts`: add `audit?` + emission to `createBranch`/`updateBranch`/`deleteBranch` (`branch.created|updated|deleted`), `updateBranchOrdering` (`branch.ordering_changed`), `createDeliveryArea`/`updateDeliveryArea`/`deleteDeliveryArea` (`branch.delivery_area.created|updated|deleted`), each inside `withTenant`.
  - `src/server/banners/service.ts`: `createBanner`/`updateBanner`/`deleteBanner` → `banner.created|updated|deleted`.
  - `src/server/subscription/service.ts`: `startTrial` → `subscription.trial_started`; `transition` → `subscription.status_changed` (`{before, after}` status; actor `system` when driven by a job, else the passed `audit`).
  - `src/server/onboarding/service.ts`: inside `registerTenant`'s existing `db.transaction`, after the owner+role rows exist, set `app.tenant_id` for the new tenant and emit `tenant.registered` (`actorUserId: owner.id`, `actorType:"user"`, `metadata:{slug, vertical}`) so it is the chain's genesis. Since `registerTenant` uses a raw `db.transaction`, wrap the emission with `tx.execute(sql\`SELECT set_config('app.tenant_id', ${tenant.id}, true)\`)` before `recordAuditEvent(..., tx)` — the same `set_config` `withTenant` uses — so the RLS insert succeeds within the bootstrap transaction.

- [ ] **Step 7: Wire the auth-event boundaries.** Create `src/server/audit/auth-events.ts` exporting `recordAuthEvent(tenantId, action, opts)` (a one-statement `withTenant` append). Call it from:
  - `src/app/login/actions.ts` `loginAction` — `auth.login` on success (`actorUserId: user.id`), `auth.login_failed` on wrong password (`actorUserId: null`, `metadata:{email}`); fingerprint from `headersFingerprint(await headers())`.
  - `src/app/register/actions.ts` — `auth.login` after the session is created (the `tenant.registered` genesis already came from `registerTenant`).
  - `src/app/dashboard/actions.ts` `signOutAction` — `auth.logout` before/after `invalidateSession` (resolve tenantId from the session user first).

- [ ] **Step 8: Pass `actionAudit` from the remaining dashboard actions.** In `settings/staff/actions.ts`, `settings/taxes/actions.ts` (now calling `updateTaxSettings`), `settings/whatsapp/actions.ts`, `settings/profile/actions.ts`, `settings/fulfillment/actions.ts`, `settings/billing/actions.ts`, `branches/actions.ts`, `banners/actions.ts` — import `actionAudit` and pass `await actionAudit(ctx)` to each service call.

- [ ] **Step 9: Run the group's tests + full suite.**

Run: `npx vitest run src/server/audit/emission-admin.test.ts src/server/audit/emission-auth.test.ts && npm test`
Expected: group tests PASS; full suite PASS. Existing staff/settings/branches/banners/subscription/onboarding tests still pass — `audit?` is optional and the `db.transaction`→`withTenant` refactors are behaviour-preserving.

- [ ] **Step 10: Typecheck + lint + commit.**

```bash
npx tsc --noEmit && npx eslint src/server/auth src/server/tenancy src/server/branches src/server/banners src/server/subscription src/server/onboarding src/server/audit src/app/login src/app/register src/app/dashboard
git add src/server/auth src/server/tenancy src/server/branches src/server/banners src/server/subscription src/server/onboarding src/server/audit src/app/login src/app/register src/app/dashboard
git commit -m "feat(audit): emit auth, staff, settings, branch, banner, subscription, and onboarding events"
```

---

## Task 9: Emit — Group D: sensitive reads / exports

The narrow, deliberate set of **reads** that qualify (see the spec's "what qualifies"). Two land today; two are forward-referenced and enforced by the guardrail.

**Files:**
- Modify: `src/app/dashboard/analytics/page.tsx` — `report.financial_viewed`.
- Modify: `src/app/dashboard/orders/[id]/page.tsx` — `customer.pii_viewed`.
- Test: `src/server/audit/emission-reads.test.ts`

**Interfaces:**
- Consumes: `recordAuditEvent` / a one-statement boundary append, `actionAudit`/`headersFingerprint`.

- [ ] **Step 1: Write the failing tests.** Create `src/server/audit/emission-reads.test.ts` — factor the two emissions into testable helpers (`recordFinancialView(tenantId, actor)`, `recordCustomerPiiView(tenantId, orderId, actor)` in `src/server/audit/read-events.ts`) and assert each writes one row (`report.financial_viewed` / `customer.pii_viewed`), the chain stays `ok`, and the actor is a `user`. Testing the page component directly is impractical; the helper is the load-bearing unit.

- [ ] **Step 2: Run to verify they fail.**

Run: `npx vitest run src/server/audit/emission-reads.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the read-event helpers.** Create `src/server/audit/read-events.ts` with `recordFinancialView` and `recordCustomerPiiView`, each a one-statement `withTenant(tenantId, tx => recordAuditEvent(ctx, event, tx))` append. `report.financial_viewed` uses `entityType:"report", entityId:"financial"`; `customer.pii_viewed` uses `entityType:"customer", entityId:orderId`, with the viewed fields named (not valued) in metadata: `{ fields: ["customerName","customerPhone","addressText"] }` — record *that* PII was viewed, not a second copy of it.

- [ ] **Step 4: Wire the pages.**
  - `src/app/dashboard/analytics/page.tsx` — after `requireMenuPermission()` and before/after loading the financial figures, call `recordFinancialView(tenantId, await actionAudit(ctx))`. (This page surfaces `getRevenueTrend` + `getAverageOrderValue`; those are the financial figures. The operational counts on the same page do not by themselves trigger a second event.)
  - `src/app/dashboard/orders/[id]/page.tsx` — after resolving the order for a staff/manager/owner viewer, call `recordCustomerPiiView(tenantId, orderId, await actionAudit(ctx))`. The storefront customer's own-order view (`getOrderByToken`) is **not** wired — own data does not qualify.

- [ ] **Step 5: Note the forward-references in code + allowlist.** Add a comment in `read-events.ts` naming the two forward emissions: `report.cross_cashier_sales_viewed` (Spec 3 sales history / Spec 10 X-Z reports) and `data.exported` (Spec 10 export). No surface exists for them today; Task 10's allowlist records them as "forward — lands with Spec 3/10".

- [ ] **Step 6: Run + typecheck + lint + commit.**

```bash
npx vitest run src/server/audit/emission-reads.test.ts && npx tsc --noEmit && npx eslint src/server/audit src/app/dashboard/analytics src/app/dashboard/orders
git add src/server/audit/read-events.ts src/server/audit/emission-reads.test.ts src/app/dashboard/analytics src/app/dashboard/orders
git commit -m "feat(audit): emit sensitive reads — report.financial_viewed + customer.pii_viewed"
```

---

## Task 10: Coverage guardrail — enumerate mutating surfaces, assert emission or allowlist

Coverage is an invariant, so a test makes it fail-closed. It enumerates the exported functions of every domain service module, classifies each as mutating (its body performs a DB write), and asserts each mutating function either references `recordAuditEvent` **or** is in a committed, commented `AUDIT_ALLOWLIST`. Anything else fails. When Specs 3/8/9/11 add refund/inventory/PO/ETA mutations, this test goes red until they emit — that is the enforcement.

**Files:**
- Create: `src/server/audit/coverage.ts`
- Test: `src/server/audit/coverage.test.ts`

**Interfaces:**
- Produces:
  - `const AUDITED_SERVICE_FILES: string[]` — the domain service modules to scan.
  - `type MutatingSymbol = { file: string; name: string }`
  - `function enumerateMutatingSymbols(): MutatingSymbol[]` — static scan.
  - `const AUDIT_ALLOWLIST: Record<string, string>` — `"<file-basename>.<symbol>" → justification`.

- [ ] **Step 1: Write the failing test.** Create `src/server/audit/coverage.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { enumerateMutatingSymbols, AUDIT_ALLOWLIST } from "./coverage";

describe("audit coverage guardrail", () => {
  it("every mutating service function emits an audit event (or is allowlisted)", () => {
    const gaps: string[] = [];
    for (const sym of enumerateMutatingSymbols()) {
      const src = readFileSync(sym.file, "utf8");
      const body = extractFunctionBody(src, sym.name); // helper below
      const emits = /recordAuditEvent\s*\(|recordAuthEvent\s*\(|recordFinancialView\s*\(|recordCustomerPiiView\s*\(/.test(body);
      const key = `${basename(sym.file)}.${sym.name}`;
      if (!emits && !(key in AUDIT_ALLOWLIST)) gaps.push(key);
    }
    expect(gaps, `Mutating functions with no audit emission and no allowlist entry:\n${gaps.join("\n")}`).toEqual([]);
  });

  it("has no stale allowlist entries", () => {
    const live = new Set(enumerateMutatingSymbols().map((s) => `${basename(s.file)}.${s.name}`));
    for (const key of Object.keys(AUDIT_ALLOWLIST)) {
      // allow forward-reference sentinels (Spec 3/8/9/11) that name a not-yet-existing symbol
      if (key.startsWith("forward:")) continue;
      expect(live.has(key), `stale allowlist entry: ${key}`).toBe(true);
    }
  });

  it("goes red when an emission is removed (self-check)", () => {
    // Sanity: the allowlist is non-empty and the enumerator finds the known
    // mutating surface (guards against the scan silently returning []).
    expect(enumerateMutatingSymbols().length).toBeGreaterThan(20);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npx vitest run src/server/audit/coverage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the enumerator + allowlist.** Create `src/server/audit/coverage.ts`. The enumerator globs the service files, and for each `export (async )?function <name>` whose body contains a write (`.insert(`, `.update(`, `.delete(`, or a `tx.execute(`/`db.execute(` carrying `insert|update|delete`) records `{file, name}`; pure reads (only `.select(`) are skipped. Provide a small `extractFunctionBody(src, name)` (brace-matching from the function's opening `{`) and `basename` helper, exported for the test. Seed `AUDITED_SERVICE_FILES` with the real modules:

```ts
export const AUDITED_SERVICE_FILES = [
  "src/server/ordering/service.ts",
  "src/server/pos/record-sale.ts",
  "src/server/pos/cashier.ts",
  "src/server/pos/held-tickets.ts",
  "src/server/pos/service.ts",
  "src/server/catalog/service.ts",
  "src/server/catalog/variants.ts",
  "src/server/branches/service.ts",
  "src/server/tenancy/settings.ts",
  "src/server/tenancy/service.ts",
  "src/server/auth/staff.ts",
  "src/server/auth/session.ts",
  "src/server/banners/service.ts",
  "src/server/subscription/service.ts",
  "src/server/onboarding/service.ts",
];
```

Populate `AUDIT_ALLOWLIST` with the genuinely non-auditable writers, each justified — e.g.:

```ts
export const AUDIT_ALLOWLIST: Record<string, string> = {
  // Password/session primitives are not domain actions; auth.* is emitted at the action boundary.
  "password.hashPassword": "primitive; no domain event",
  "session.createSession": "auth.login emitted by loginAction/registerAction",
  "session.invalidateSession": "auth.logout emitted by signOutAction",
  "session.validateSession": "read; no mutation of tenant data",
  // Low-level tax setters are composed by updateTaxSettings, which emits.
  "settings.setVatRate": "composed by updateTaxSettings (emits)",
  "settings.setVatEnabled": "composed by updateTaxSettings (emits)",
  "settings.setPricesIncludeVat": "composed by updateTaxSettings (emits)",
  "settings.setServiceChargeRate": "composed by updateTaxSettings (emits)",
  // POS in-memory grant store; authz.manager_granted is emitted at the authorize route.
  "grants.issueGrant": "in-memory; authz.manager_granted emitted at /api/pos/v1/authorize",
  "grants.consumeGrant": "in-memory; spent at the gated write, which emits",
  // Forward references — land with later specs; guardrail enforces they emit then.
  "forward:refund.*": "Spec 3 refunds must emit refund.* against recordAuditEvent",
  "forward:inventory.*": "Spec 8 ledger/lot/count must emit inventory.*",
  "forward:purchase-order.*": "Spec 9 PO lifecycle must emit po.*",
  "forward:eta.*": "Spec 11 fiscal submissions must emit eta.*",
};
```

Tune the allowlist so the test passes with exactly the emissions wired in Tasks 6–9 and no more. If the enumerator flags a function you did wire, confirm its body literally calls one of the emit helpers; if it flags one that should be exempt, add a justified allowlist entry — never loosen the regex to hide a real gap.

- [ ] **Step 4: Run to verify it passes, and prove it fails-closed.**

Run: `npx vitest run src/server/audit/coverage.test.ts && npx tsc --noEmit`
Expected: PASS. Then temporarily delete one `recordAuditEvent(...)` call (e.g. in `createBanner`) and re-run — the guardrail must report `banners-service.createBanner` as a gap. Restore the call.

- [ ] **Step 5: Commit.**

```bash
git add src/server/audit/coverage.ts src/server/audit/coverage.test.ts
git commit -m "test(audit): coverage guardrail — every mutating service emits or is allowlisted"
```

---

## Task 11: Dashboard read route + minimal audit-log view

Reads resolve the tenant from the web session, assert `audit:view`, and query through `withTenant`. **No HTTP endpoint ever inserts** into `audit_events` — an audit row you can POST is an audit row an attacker can forge. Filters now include `actorType` (system-wide coverage means the log spans users, customers, devices, and system).

**Files:**
- Create: `src/server/audit/read.ts`
- Create: `src/app/dashboard/audit-permission.ts`
- Create: `src/app/api/audit/events/route.ts`
- Create: `src/app/api/audit/chain/status/route.ts`
- Create: `src/app/dashboard/audit/page.tsx`
- Test: `src/server/audit/read.test.ts`

**Interfaces:**
- Consumes: `requireDashboardUser` + `DashboardContext` (`@/server/auth/dashboard-context`), `authorize` (`@/server/rbac/authorize`), `withTenant`, `auditEvents` (Task 1), `verifyChain` + `getChainStatus` helpers.
- Produces:
  - `type AuditEventFilters = { action?: string; entityType?: string; entityId?: string; actorUserId?: string; actorType?: string; from?: Date; to?: Date; limit?: number }`
  - `function listAuditEvents(tenantId: string, filters: AuditEventFilters): Promise<AuditEvent[]>`
  - `function getChainStatus(tenantId: string): Promise<{ head: { seq: number; headHash: string } | null; verification: ChainStatus }>`
  - `function requireAuditPermission(): Promise<DashboardContext>`

- [ ] **Step 1: Write the failing read tests.** Create `src/server/audit/read.test.ts` — seed a chain via `recordAuditEvent`, then assert:
  - `listAuditEvents` filters by `action`, by `entityType`/`entityId`, and by `actorType`, orders newest-first (`desc(seq)`), respects `limit`.
  - `getChainStatus` returns the head `{seq, headHash}` and `verification: { ok: true }` for a clean chain.
  - RLS: `listAuditEvents(tenantA)` never returns tenant B's rows.

Follow the seeding shape from `src/server/audit/service.test.ts`.

- [ ] **Step 2: Run to verify it fails.**

Run: `npx vitest run src/server/audit/read.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the reads.** Create `src/server/audit/read.ts`:

```ts
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { auditEvents, auditChainHeads, type AuditEvent } from "./schema";
import { verifyChain, type ChainStatus } from "./verifier";

export type AuditEventFilters = {
  action?: string; entityType?: string; entityId?: string; actorUserId?: string; actorType?: string;
  from?: Date; to?: Date; limit?: number;
};

export async function listAuditEvents(tenantId: string, filters: AuditEventFilters): Promise<AuditEvent[]> {
  return withTenant(tenantId, (tx) => {
    const conds = [];
    if (filters.action) conds.push(eq(auditEvents.action, filters.action));
    if (filters.entityType) conds.push(eq(auditEvents.entityType, filters.entityType));
    if (filters.entityId) conds.push(eq(auditEvents.entityId, filters.entityId));
    if (filters.actorUserId) conds.push(eq(auditEvents.actorUserId, filters.actorUserId));
    if (filters.actorType) conds.push(eq(auditEvents.actorType, filters.actorType as never));
    if (filters.from) conds.push(gte(auditEvents.createdAt, filters.from));
    if (filters.to) conds.push(lte(auditEvents.createdAt, filters.to));
    const base = tx.select().from(auditEvents);
    const q = conds.length > 0 ? base.where(and(...conds)) : base;
    return q.orderBy(desc(auditEvents.seq)).limit(Math.min(filters.limit ?? 100, 200));
  });
}

export async function getChainStatus(tenantId: string): Promise<{ head: { seq: number; headHash: string } | null; verification: ChainStatus }> {
  const head = await withTenant(tenantId, (tx) =>
    tx.select().from(auditChainHeads).where(eq(auditChainHeads.tenantId, tenantId)).limit(1));
  return {
    head: head[0] ? { seq: head[0].seq, headHash: head[0].headHash } : null,
    verification: await verifyChain(tenantId),
  };
}
```

- [ ] **Step 4: Implement the permission guard.** Create `src/app/dashboard/audit-permission.ts` (mirror `src/app/dashboard/orders-permission.ts`):

```ts
import { requireDashboardUser, type DashboardContext } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";

export async function requireAuditPermission(): Promise<DashboardContext> {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "audit:view");
  return ctx;
}
```

- [ ] **Step 5: Implement the routes.** Create `src/app/api/audit/events/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireAuditPermission } from "@/app/dashboard/audit-permission";
import { UnauthorizedError } from "@/server/rbac/authorize";
import { listAuditEvents } from "@/server/audit/read";

export async function GET(req: NextRequest) {
  let ctx;
  try {
    ctx = await requireAuditPermission();
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    throw e; // requireDashboardUser redirects unauthenticated users
  }
  const p = req.nextUrl.searchParams;
  const events = await listAuditEvents(ctx.tenantId, {
    action: p.get("action") ?? undefined,
    entityType: p.get("entityType") ?? undefined,
    entityId: p.get("entityId") ?? undefined,
    actorUserId: p.get("actorUserId") ?? undefined,
    actorType: p.get("actorType") ?? undefined,
    from: p.get("from") ? new Date(p.get("from")!) : undefined,
    to: p.get("to") ? new Date(p.get("to")!) : undefined,
    limit: p.get("limit") ? Number(p.get("limit")) : undefined,
  });
  return NextResponse.json(events);
}
```

Create `src/app/api/audit/chain/status/route.ts` — same guard, returns `getChainStatus(ctx.tenantId)`.

- [ ] **Step 6: Add a `403 for staff` guard test.** In `src/server/audit/read.test.ts` (or a route test alongside it), assert that a `staff` role fails `authorize(roleKeys, "audit:view")` with `UnauthorizedError` — the same assertion the route maps to 403.

- [ ] **Step 7: Build the minimal view.** Create `src/app/dashboard/audit/page.tsx` — a server component that calls `requireAuditPermission()`, then `listAuditEvents` (default page) and `getChainStatus`. Render:
  - A **chain-status banner**: green "Chain OK — N events" when `verification.ok`, red "Tamper detected at seq X" otherwise.
  - A table: `createdAt`, `action`, `entityType`/`entityId`, actor (name/`actorType`), `summary`, and the fingerprint's `appVersion`/`ip`. Follow the styling of an existing dashboard list page (e.g. `src/app/dashboard/orders`). Filters (`action`, `entityType`, `actorType`, date range) are query-param driven against the same `listAuditEvents`.

- [ ] **Step 8: Run tests + typecheck + lint.**

Run: `npx vitest run src/server/audit/read.test.ts && npx tsc --noEmit && npx eslint src/server/audit src/app/api/audit src/app/dashboard/audit`
Expected: PASS, clean.

- [ ] **Step 9: Commit.**

```bash
git add src/server/audit/read.ts src/server/audit/read.test.ts src/app/dashboard/audit-permission.ts src/app/api/audit src/app/dashboard/audit
git commit -m "feat(audit): audit:view-gated read API + chain-status banner and minimal log view"
```

---

## Task 12: Full-suite verification and manual acceptance

**Files:** none — this task changes nothing. It proves the spec.

- [ ] **Step 1: Run everything.**

```bash
npm test
npx tsc --noEmit
npx eslint src
```

Expected: all PASS, all clean — including the coverage guardrail (Task 10). Fix anything that is not before continuing.

- [ ] **Step 2: Walk the spec's acceptance path.** With `npm run dev` and `npm run pos:dev` up, on a tenant paired to a POS device:

- [ ] Ring a POS sale. In the DB, confirm an `audit_events` row `action = 'sale.recorded'` whose `fingerprint` JSON contains a `deviceTokenHash` (64 hex chars, **not** the raw token) and the `X-POS-App-Version` value the POS sent.
- [ ] Send a request **without** `X-POS-App-Version` (older build); confirm the sale still records and the row has `appVersion: null`.
- [ ] Change a menu price, flip the VAT rate, and escalate a staff member's role from the dashboard → three rows: `catalog.product.price_changed`, `settings.vat_changed`, `staff.role_changed`, each with `metadata.before`/`after` and `actorType: 'user'` + `metadata.roleKey`.
- [ ] Open a customer's order-detail page → a `customer.pii_viewed` row; open `/dashboard/analytics` → a `report.financial_viewed` row.
- [ ] Attempt a wrong-password login → an `auth.login_failed` row with null `actorUserId` and the attempted email in metadata; sign out → `auth.logout`.
- [ ] In `psql`, run `UPDATE audit_events SET summary = 'x' WHERE seq = 1;` inside the tenant context → the `audit_events_append_only` trigger raises. Same for `DELETE`.
- [ ] Open `/dashboard/audit` as owner → the chain-status banner reads **OK**; as a `staff` user, the route returns **403**.
- [ ] Simulate a DB-admin tamper: `ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only;`, edit one row, re-enable, reload `/dashboard/audit` → the banner reports the first broken `seq`.

- [ ] **Step 3: Open the PR.**

```bash
git push -u origin HEAD
gh pr create --title "feat(audit): system-wide append-only, hash-chained, fingerprinted tenant audit log" --body "$(cat <<'EOF'
Implements docs/ailab/specs/2026-07-24-audit-and-fingerprint-log-design.md (Spec 4, decision D1).

- `audit_events` (append-only, FORCE RLS, no-mutate trigger) + `audit_chain_heads`
  (one row/tenant). `recordAuditEvent(ctx, event, tx)` appends inside the caller's
  transaction, serialized per-tenant with pg_advisory_xact_lock — the same lock
  pattern placeOrder uses for order numbers.
- SHA-256 hash chain: entryHash = sha256(canonical(prevHash, seq, tenant, actor,
  action, entity, metadata, createdAt)); genesis prevHash = 64 zeros. One canonical
  serializer shared by writer and verifier.
- Device/session fingerprint captured at the boundary (new X-POS-App-Version header;
  web/action session + UA + IP). The device token is stored only as a sha256 hash.
- SYSTEM-WIDE coverage: every mutation across ordering, POS, catalog, branches,
  settings/tenancy, staff/RBAC, banners, subscription, and onboarding; auth events
  (login/logout/failed login); and sensitive reads (customer PII, financial reports).
  All actor types (staff/manager/owner = user, customer, system, device).
- A coverage-guardrail test fails CI if a mutating service ships without an emission,
  with an explicit justified allowlist. A chain verifier reports the first broken seq;
  reads gated behind audit:view (owner + manager) via withTenant.

The platform audit_logs table is untouched — it continues to serve super-admin
actions; the new system covers tenant + user + customer + system actions only.
Refund, inventory, PO, ETA, and reconciliation emission points attach to the same
helper in Specs 3/8/9/11/7 and are enforced by the guardrail.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- *Data model* — `audit_events` + `audit_chain_heads`, FORCE RLS, unique `(tenantId, seq)`, read indexes incl. `(tenantId, action)`, append-only trigger → **Task 1**.
- *Hash* — `entryHash = sha256(canonical(...))`, genesis `prevHash` = 64 zeros, one shared serializer → **Task 2**.
- *`recordAuditEvent` / atomicity / serialization / genesis* — advisory-locked read-then-advance on the caller's `tx`, rolls back with the mutation, monotonic seq under concurrency → **Task 3**.
- *Fingerprint + actor at the boundary* — `X-POS-App-Version`, hashed device token, web/action UA/IP, `actionAudit` for dashboard actors, `null` when missing → **Task 4**.
- *Authorization* + *tamper-evidence verifier* — `audit:view` (owner + manager), `verifyChain` reporting the first broken `seq` → **Task 5**.
- *Coverage (system-wide) — emission points* — **Task 6** (ordering + POS), **Task 7** (catalog), **Task 8** (auth + staff + settings + branches + banners + subscription + onboarding), **Task 9** (sensitive reads/exports). Every grounded action in the spec's domain→actions table has a home.
- *Coverage guardrail* — enumerate mutating service functions, assert emission or justified allowlist, fail-closed → **Task 10**.
- *API / read surface* — `GET /api/audit/events` (paginated, filterable incl. `actorType`), `GET /api/audit/chain/status`, minimal view; writes never exposed → **Task 11**.
- *Testing* (unit / server / per-group emission / guardrail / renderer / manual acceptance) — every task, plus **Task 12**.

**Coverage is now system-wide and enforced.** The previous version of this plan wired only `placeOrder`/`recordSale`/`transitionStatus`/discounts/`markPaid` and *deliberately deferred* staff/menu/settings emission to "the owning services' next touch". **That deferral is removed.** Per locked decision D1 (see `docs/ROADMAP.md`), coverage now spans every mutating service in every domain, all auth events, and the qualifying sensitive reads — and Task 10's guardrail fails CI if any mutating surface regresses to no-emission. The only things not emitted here are entities that do not yet exist (refunds, inventory, POs, ETA submissions, reconciliation close); those ship with Specs 3/8/9/11/7 and the guardrail will fail those PRs if they add a mutation without an emission. The platform super-admin `audit_logs` table (`src/server/platform/audit.schema.ts`) stays **separate** and is out of scope for this system.

**Grounded symbols.** Every emission point names a real exported function verified in the codebase: ordering `placeOrder:59`/`transitionStatus:380`/`markPaid:400`/`cancelOrderByToken:301`; POS `recordSale:51`/`addTender:195`/`signInCashier:41`/`holdTicket:6`/`discardHeldTicket:40`/`createPairingCode:33`/`redeemPairingCode:47`/`revokeDevice:162`/`loginForPos:90`; catalog `createProduct:117`…`setBranchAvailability:225` + variants `upsertVariant:31`…`setProductStock:65`; branches `createBranch:24`…`deleteDeliveryArea:94`; settings `setVatRate:43`…`requestPlanUpgrade:97` + `updateTenantProfile:24`; staff `createStaff:36`/`setStaffRole:63`/`deactivateStaff:73`; auth `createSession:8`/`invalidateSession:29` via `loginAction`/`registerAction`/`signOutAction`; banners `createBanner:15`…`deleteBanner:30`; subscription `startTrial:17`/`transition:28`; onboarding `registerTenant:25`; sensitive reads `getRevenueTrend:13`/`getAverageOrderValue:76` + order-detail PII. `analytics/platform.ts` is **out of scope** (platform stays separate).

**Type consistency:** `AuditContext`, `AuditFingerprint`, `AuditActorInput`, `AuditEventInput` (Task 3) are the parameter types used unchanged in Tasks 4 (`PosCashierContext.fingerprint`, `actionAudit`), 6–9 (every emission builds an `AuditContext`; every mutating service accepts `audit?: AuditActorInput`), and 11. `CanonicalInput`/`entryHash`/`ZERO_HASH` (Task 2) are consumed by both `recordAuditEvent` (Task 3) and `verifyChain` (Task 5) — the single-serializer guarantee. `ChainStatus` (Task 5) is what both `verifyChain` and `getChainStatus` (Task 11) return. `emptyFingerprint()` (Task 4) is the default every optional-`audit` path falls back to, so an un-fingerprinted mutation still produces a valid chain row rather than throwing. `AUDIT_ALLOWLIST` + `enumerateMutatingSymbols` (Task 10) close the loop by making "a mutating function with no emission" a red test.
