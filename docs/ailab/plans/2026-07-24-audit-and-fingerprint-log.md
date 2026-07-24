# Audit & Fingerprint Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use mo-ai:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every tenant an **append-only, hash-chained (tamper-evident)** operational audit trail. Each mutating write appends one `audit_events` row **inside its own transaction**, linked to its predecessor by a SHA-256 chain, carrying a device/session **fingerprint** (`{deviceId, deviceTokenHash, appVersion, ip, userAgent}`). A DB trigger makes `UPDATE`/`DELETE` fail; a verifier walks each chain and reports the first broken link; reads are gated behind a new `audit:view` permission. Implements `docs/ailab/specs/2026-07-24-audit-and-fingerprint-log-design.md` (Spec 4, decision **D1**).

**Architecture:** One writer, one chain per tenant. `recordAuditEvent(ctx, event, tx)` (`src/server/audit/service.ts`) is a synchronous step *inside* the caller's existing `withTenant` transaction — the same block that writes the order, tender, or status change. It reuses `placeOrder`'s serialization discipline exactly (`src/server/ordering/service.ts:230`): `SELECT pg_advisory_xact_lock(hashtext(tenantId)::bigint)`, read `audit_chain_heads`, compute `entryHash = sha256(canonical(...))`, insert the row, advance the head. Canonical serialization lives in **one** module (`src/server/audit/canonical.ts`) imported by both the writer and the verifier — there must be exactly one implementation, or the verifier "detects" tamper that is only encoding drift. The platform `audit_logs` table (`src/server/platform/audit.schema.ts`) is untouched and continues to serve super-admin actions; `audit_events` is a **separate**, tenant-scoped, FORCE-RLS log alongside it.

**Tech Stack:** Next.js (App Router), Drizzle ORM + Postgres (RLS via `withTenant`), `node:crypto` (`createHash('sha256')` — no new dependency), Vitest against a remote Supabase Postgres.

## Global Constraints

- **No new runtime dependencies.** SHA-256 comes from `node:crypto`, already available.
- **Tenant-scoped tables are behind RLS.** `audit_events` and `audit_chain_heads` are `ENABLE` + `FORCE ROW LEVEL SECURITY` with the house isolation policy: `USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)` and the same `WITH CHECK`. Every read/write goes through `withTenant(tenantId, tx => …)`.
- **Append-only is an invariant, not a convention.** No code path ever `UPDATE`s or `DELETE`s an `audit_events` row. A DB trigger enforces it. `audit_chain_heads` is the one mutable pointer (it *is* upserted); its integrity is proven by re-walking the chain, never by trusting the head.
- **The audit write shares the mutation's transaction.** `recordAuditEvent` **must** receive the caller's `tx` handle and must never open its own. If the mutation throws, the audit row rolls back with it — no orphan audit, no lost audit.
- **Never store raw device tokens.** The fingerprint carries `deviceTokenHash = sha256(deviceToken)`, never the token. A leaked `audit_events` dump must not be replayable to authenticate.
- **A missing fingerprint field never blocks a mutation.** An older POS build without `X-POS-App-Version` records `appVersion: null` and still audits. Losing the sale to protect the log is the wrong trade.
- **The chain hash covers exactly the nine fields the spec names** (`prevHash, seq, tenantId, actorUserId, action, entityType, entityId, metadata, createdAt`). The fingerprint is stored but **not** hashed.
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
- Create: `src/server/audit/service.ts` — `recordAuditEvent`, `AuditContext`, `AuditFingerprint`, `AuditEventInput`.
- Create: `src/server/audit/service.test.ts`.
- Create: `src/server/audit/verifier.ts` — `verifyChain`, `ChainStatus`.
- Create: `src/server/audit/verifier.test.ts`.

**Fingerprint capture**
- Create: `src/server/audit/fingerprint.ts` — `webFingerprint`, `headersFingerprint`, `emptyFingerprint`.
- Modify: `src/server/pos/require-cashier.ts` — `PosCashierContext` gains `fingerprint`; read `X-POS-App-Version` + hash the bearer token.
- Modify: `src/server/pos/test-helpers.ts` — `seedPosContext` attaches a synthetic fingerprint.

**Authorization + read surface**
- Modify: `src/server/rbac/permissions.ts` — add `audit:view` (owner + manager).
- Create: `src/server/audit/read.ts` — `listAuditEvents`, `getChainStatus`.
- Create: `src/app/dashboard/audit-permission.ts` — `requireAuditPermission`.
- Create: `src/app/api/audit/events/route.ts`, `src/app/api/audit/chain/status/route.ts`.
- Create: `src/app/dashboard/audit/page.tsx` — minimal read-only view.

**Emission wiring**
- Modify: `src/server/ordering/service.ts` — `placeOrder`, `transitionStatus`, `markPaid` emit.
- Modify: `src/server/pos/record-sale.ts` — `recordSale` emits `sale.recorded` + `discount.*`.
- Modify: `src/app/api/orders/route.ts`, `src/app/dashboard/orders/[id]/actions.ts`, `src/app/api/pos/v1/orders/status/route.ts` — thread the fingerprint from the boundary.

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
 * Append-only, tenant-scoped, hash-chained. One row per mutating action.
 * Never updated, never deleted — the audit_events_append_only trigger enforces
 * it. `seq`/`prevHash`/`entryHash` are set by recordAuditEvent under the
 * per-tenant advisory lock; `createdAt` is captured from the DB clock inside
 * the tx and is part of the hash, so it cannot be back-dated after the fact.
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

Expected: a new `drizzle/00XX_*.sql` creating enum `audit_actor_type`, both tables, the FKs, and the three indexes. It will **not** contain RLS or the trigger.

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
  //    as placeOrder's order-number step (src/server/ordering/service.ts:230).
  //    Re-acquiring the lock a transaction already holds is a no-op, so this is
  //    safe even when placeOrder itself is the caller.
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

## Task 4: Fingerprint capture at the API boundary

The fingerprint is assembled where the request enters and threaded through `ctx`. POS reads the new `X-POS-App-Version` header and hashes the device bearer token; web derives `{appVersion, ip, userAgent}` from the request, with `deviceId`/`deviceTokenHash` null.

**Files:**
- Create: `src/server/audit/fingerprint.ts`
- Modify: `src/server/pos/require-cashier.ts`
- Modify: `src/server/pos/test-helpers.ts`
- Test: `src/server/audit/fingerprint.test.ts`

**Interfaces:**
- Consumes: `sha256Hex` (Task 2), `AuditFingerprint` (Task 3).
- Produces:
  - `function emptyFingerprint(): AuditFingerprint` — all null (system/backfill actor).
  - `function webFingerprint(req: Request): AuditFingerprint`
  - `function headersFingerprint(h: Headers): AuditFingerprint` — for server actions that hold `await headers()` rather than a `Request`.
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

- [ ] **Step 4: Extend `requirePosCashier`.** In `src/server/pos/require-cashier.ts`, add `fingerprint` to the context type and build it. Add the import:

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

- [ ] **Step 5: Fix the test fixture.** `PosCashierContext` now requires `fingerprint`, so `seedPosContext` (`src/server/pos/test-helpers.ts`) no longer type-checks. Add a synthetic fingerprint to the returned `ctx`:

```ts
      permissions: session.permissions,
      fingerprint: {
        deviceId: device.deviceId, deviceTokenHash: "test-token-hash",
        appVersion: "test-1.0.0", ip: "127.0.0.1", userAgent: "vitest",
      },
```

- [ ] **Step 6: Run tests + typecheck.**

Run: `npx vitest run src/server/audit/fingerprint.test.ts && npx tsc --noEmit && npx eslint src/server/audit src/server/pos`
Expected: PASS, clean. Existing `record-sale.test.ts` still passes because `seedPosContext` now supplies the field.

- [ ] **Step 7: Commit.**

```bash
git add src/server/audit/fingerprint.ts src/server/audit/fingerprint.test.ts src/server/pos/require-cashier.ts src/server/pos/test-helpers.ts
git commit -m "feat(audit): capture device/session fingerprint at the API boundary (X-POS-App-Version, hashed device token)"
```

---

## Task 5: `audit:view` permission + the chain verifier

Two independent additions. The permission gates every read (Task 7). The verifier walks a tenant's chain, recomputes each hash, and reports the first `seq` that no longer reconciles — it never mutates or "repairs".

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

## Task 6: Wire emission into the mutating writes

Every mutating write threads `ctx` and calls `recordAuditEvent` inside its own transaction. `placeOrder` always emits `order.placed`; when no fingerprint is supplied (existing web-order tests, backfill) it defaults to `emptyFingerprint()` so the chain still advances. `recordSale` adds `sale.recorded` + one `discount.*` row per adjustment; `transitionStatus` emits `order.status.changed` with `{before, after}`; `markPaid` emits `payment.marked_paid`.

**Files:**
- Modify: `src/server/ordering/service.ts`
- Modify: `src/server/pos/record-sale.ts`
- Modify: `src/app/api/orders/route.ts`, `src/app/dashboard/orders/[id]/actions.ts`, `src/app/api/pos/v1/orders/status/route.ts`
- Test: `src/server/audit/emission.test.ts`

**Interfaces:**
- Consumes: `recordAuditEvent`, `AuditContext`, `AuditFingerprint` (Task 3); `emptyFingerprint`, `webFingerprint`, `headersFingerprint` (Task 4); `verifyChain` (Task 5).
- Produces:
  - `PlaceOrderInput` gains `audit?: { fingerprint: AuditFingerprint; actorUserId?: string | null; actorType?: AuditActorType }`.
  - `transitionStatus(tenantId, orderId, to, userId, reason?, audit?: { fingerprint: AuditFingerprint })`.
  - `markPaid(tenantId, orderId, userId, audit?: { fingerprint: AuditFingerprint })`.

- [ ] **Step 1: Write the failing emission tests.** Create `src/server/audit/emission.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { auditEvents } from "./schema";
import { verifyChain } from "./verifier";
import { placeOrder, transitionStatus, markPaid } from "@/server/ordering/service";
import { recordSale } from "@/server/pos/record-sale";
import { seedPosContext } from "@/server/pos/test-helpers";

async function eventsFor(tenantId: string, action: string) {
  return withTenant(tenantId, (tx) =>
    tx.select().from(auditEvents).where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.action, action))));
}

describe("audit emission", () => {
  it("placeOrder emits order.placed and keeps a valid chain", async () => {
    const { ctx, tenantId, branchId, productId } = await seedPosContext("owner");
    await placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "Walk-in", customerPhone: "000000000",
      channel: "pos", cashierUserId: ctx.cashierUserId,
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      audit: { fingerprint: ctx.fingerprint, actorUserId: ctx.cashierUserId, actorType: "user" },
    });
    expect(await eventsFor(tenantId, "order.placed")).toHaveLength(1);
    expect((await verifyChain(tenantId)).ok).toBe(true);
  });

  it("recordSale emits sale.recorded (and discount.* when discounted), chain valid", async () => {
    const { ctx, tenantId, productId, total } = await seedPosContext("owner");
    await recordSale(ctx, {
      clientOrderId: "c1",
      lines: [{ productId, quantity: 1, selectedOptionIds: [], discountAmount: 10, discountReason: "promo" }],
      expectedTotal: total, // recompute in the test if the discount changes it; see helper note
      payments: [{ clientPaymentId: "p1", method: "cash", amount: total }],
    } as never);
    expect(await eventsFor(tenantId, "sale.recorded")).toHaveLength(1);
    expect((await eventsFor(tenantId, "discount.applied")).length).toBeGreaterThan(0);
    expect((await verifyChain(tenantId)).ok).toBe(true);
  });

  it("transitionStatus emits order.status.changed with before/after", async () => {
    const { ctx, tenantId, branchId, productId } = await seedPosContext("owner");
    const res = await placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "Walk-in", customerPhone: "000000000",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      audit: { fingerprint: ctx.fingerprint },
    });
    await transitionStatus(tenantId, res.orderId, "confirmed", ctx.cashierUserId, undefined, { fingerprint: ctx.fingerprint });
    const [row] = await eventsFor(tenantId, "order.status.changed");
    expect(row.metadata).toMatchObject({ before: "pending", after: "confirmed" });
  });

  it("markPaid emits payment.marked_paid", async () => {
    const { ctx, tenantId, branchId, productId } = await seedPosContext("owner");
    const res = await placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "Walk-in", customerPhone: "000000000",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      audit: { fingerprint: ctx.fingerprint },
    });
    await markPaid(tenantId, res.orderId, ctx.cashierUserId, { fingerprint: ctx.fingerprint });
    expect(await eventsFor(tenantId, "payment.marked_paid")).toHaveLength(1);
  });
});
```

Note: the `recordSale` assertion line above is written to fail first; when you implement, tidy it to a plain `expect(...).toHaveLength(1)` / `.toBeGreaterThan(0)` and compute `expectedTotal` from the discounted cart with the fixture's `computeCartTotals`, exactly as `record-sale.test.ts` already does — read that file first and copy its total-derivation, do not hardcode.

- [ ] **Step 2: Run to verify they fail.**

Run: `npx vitest run src/server/audit/emission.test.ts`
Expected: FAIL — `audit` is not a known input / no rows emitted.

- [ ] **Step 3: Wire `placeOrder`.** In `src/server/ordering/service.ts`:

Add imports:

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

- [ ] **Step 4: Wire `transitionStatus` and `markPaid`.** In the same file, extend the signatures and emit inside their existing `withTenant` blocks:

```ts
export async function transitionStatus(tenantId: string, orderId: string, to: OrderStatus, userId: string, reason?: string, audit?: { fingerprint: AuditFingerprint }): Promise<Order> {
```

After the `orderStatusEvents` insert, before `return updated;`:

```ts
    await recordAuditEvent(
      { tenantId, branchId: updated.branchId, actorUserId: userId, fingerprint: audit?.fingerprint ?? emptyFingerprint() },
      { action: "order.status.changed", entityType: "order", entityId: orderId,
        summary: `Order status ${order.status} → ${to}`,
        metadata: { before: order.status, after: to, reason: reason ?? null }, actorType: "user" },
      tx,
    );
```

```ts
export async function markPaid(tenantId: string, orderId: string, userId: string, audit?: { fingerprint: AuditFingerprint }): Promise<Order> {
```

After the update, before `return updated;`:

```ts
    await recordAuditEvent(
      { tenantId, branchId: updated.branchId, actorUserId: userId, fingerprint: audit?.fingerprint ?? emptyFingerprint() },
      { action: "payment.marked_paid", entityType: "order", entityId: orderId,
        summary: `Order marked paid`, metadata: { total: updated.total }, actorType: "user" },
      tx,
    );
```

(`_userId` becomes `userId` — it is now used.)

- [ ] **Step 5: Wire `recordSale`.** In `src/server/pos/record-sale.ts`, import `recordAuditEvent`, then inside the existing `withTenant(ctx.tenantId, async (tx) => { … })` block (the one that writes tenders + adjustments), after the adjustment-event insert, emit one `discount.applied`/`discount.order.applied` per adjustment and a `sale.recorded` summarizing tenders. Build the `AuditContext` once from `ctx`:

```ts
    const auditCtx = { tenantId: ctx.tenantId, branchId: ctx.branchId, actorUserId: ctx.cashierUserId, fingerprint: ctx.fingerprint };
    input.lines.forEach((line, i) => {
      if ((line.discountAmount ?? 0) > 0) {
        void recordAuditEvent(auditCtx, {
          action: "discount.applied", entityType: "order", entityId: placed.orderId,
          summary: `Line discount ${money(line.discountAmount!)}`,
          metadata: { orderItemId: placed.itemIds[i], amount: money(line.discountAmount!), reasonCode: line.discountReason ?? "other", byUserId: ctx.cashierUserId, authorizedByUserId: discountAuthorizer }, actorType: "user",
        }, tx);
      }
    });
```

Await each emission (turn the `void` into an awaited loop — the `forEach`/`void` above is a sketch; use a `for` loop so the tx sees each insert before the next append). Then the order-discount `discount.order.applied` (when `hasOrderDiscount`) and finally:

```ts
    await recordAuditEvent(auditCtx, {
      action: "sale.recorded", entityType: "order", entityId: placed.orderId,
      summary: `Sale #${placed.orderNumber} — ${paymentStatus}`,
      metadata: {
        orderNumber: String(placed.orderNumber), total: money(placed.total), paymentStatus,
        tenders: input.payments.map((p) => ({ method: p.method, amount: money(p.amount) })),
      }, actorType: "user",
    }, tx);
```

Emit `sale.recorded` **last** so it is the tip after the discounts, and note in a code comment: forward emission points (`line.voided`, `order.voided`, `refund.*`, inventory/PO events) attach to this same helper in Specs 3/8/9 — no chain change.

- [ ] **Step 6: Thread the fingerprint from the boundaries.**
  - `src/app/api/orders/route.ts` — add `audit: { fingerprint: webFingerprint(req) }` to the `input` object (import `webFingerprint`). Web orders keep `actorType: "customer"` by default.
  - `src/app/dashboard/orders/[id]/actions.ts` — these are server actions; import `headers` from `next/headers` and `headersFingerprint`, then pass `{ fingerprint: headersFingerprint(await headers()) }` as the new trailing arg to `transitionStatus` / `markPaid`.
  - `src/app/api/pos/v1/orders/status/route.ts` — resolve the POS cashier ctx (it already does) and pass `{ fingerprint: ctx.fingerprint }` to `transitionStatus`.

- [ ] **Step 7: Run the emission tests, then the full suite.**

Run: `npx vitest run src/server/audit/emission.test.ts && npm test`
Expected: emission tests PASS; full suite PASS. Existing `placeOrder`/`recordSale` tests still pass — every new arg is optional and defaults to `emptyFingerprint()`, and each mutation simply gains one audit row.

- [ ] **Step 8: Typecheck + lint + commit.**

```bash
npx tsc --noEmit && npx eslint src/server/ordering src/server/pos src/server/audit src/app/api/orders src/app/dashboard/orders src/app/api/pos/v1/orders
git add src/server/ordering/service.ts src/server/pos/record-sale.ts src/app/api/orders/route.ts src/app/dashboard/orders src/app/api/pos/v1/orders src/server/audit/emission.test.ts
git commit -m "feat(audit): emit order.placed, sale.recorded, discount.*, order.status.changed, payment.marked_paid"
```

---

## Task 7: Dashboard read route + minimal audit-log view

Reads resolve the tenant from the web session, assert `audit:view`, and query through `withTenant`. **No HTTP endpoint ever inserts** into `audit_events` — an audit row you can POST is an audit row an attacker can forge.

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
  - `type AuditEventFilters = { action?: string; entityType?: string; entityId?: string; actorUserId?: string; from?: Date; to?: Date; limit?: number; before?: string }`
  - `function listAuditEvents(tenantId: string, filters: AuditEventFilters): Promise<AuditEvent[]>`
  - `function getChainStatus(tenantId: string): Promise<{ head: { seq: number; headHash: string } | null; verification: ChainStatus }>`
  - `function requireAuditPermission(): Promise<DashboardContext>`

- [ ] **Step 1: Write the failing read tests.** Create `src/server/audit/read.test.ts` — seed a chain via `recordAuditEvent`, then assert:
  - `listAuditEvents` filters by `action` and by `entityType`/`entityId`, orders newest-first, respects `limit`.
  - `getChainStatus` returns the head `{seq, headHash}` and `verification: { ok: true }` for a clean chain.
  - RLS: `listAuditEvents(tenantA)` never returns tenant B's rows.

Follow the seeding shape from `src/server/audit/service.test.ts`.

- [ ] **Step 2: Run to verify it fails.**

Run: `npx vitest run src/server/audit/read.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the reads.** Create `src/server/audit/read.ts`:

```ts
import { and, desc, eq, gte, lte, lt } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { auditEvents, auditChainHeads, type AuditEvent } from "./schema";
import { verifyChain, type ChainStatus } from "./verifier";

export type AuditEventFilters = {
  action?: string; entityType?: string; entityId?: string; actorUserId?: string;
  from?: Date; to?: Date; limit?: number;
};

export async function listAuditEvents(tenantId: string, filters: AuditEventFilters): Promise<AuditEvent[]> {
  return withTenant(tenantId, (tx) => {
    const conds = [];
    if (filters.action) conds.push(eq(auditEvents.action, filters.action));
    if (filters.entityType) conds.push(eq(auditEvents.entityType, filters.entityType));
    if (filters.entityId) conds.push(eq(auditEvents.entityId, filters.entityId));
    if (filters.actorUserId) conds.push(eq(auditEvents.actorUserId, filters.actorUserId));
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
    from: p.get("from") ? new Date(p.get("from")!) : undefined,
    to: p.get("to") ? new Date(p.get("to")!) : undefined,
    limit: p.get("limit") ? Number(p.get("limit")) : undefined,
  });
  return NextResponse.json(events);
}
```

Create `src/app/api/audit/chain/status/route.ts` — same guard, returns `getChainStatus(ctx.tenantId)`.

- [ ] **Step 6: Add a `403 for staff` route test.** In `src/server/audit/read.test.ts` (or a route test alongside it), assert that a `staff` role fails `authorize(roleKeys, "audit:view")` with `UnauthorizedError` — the same assertion the route maps to 403. (A full HTTP test needs a session cookie; asserting the guard is the load-bearing check.)

- [ ] **Step 7: Build the minimal view.** Create `src/app/dashboard/audit/page.tsx` — a server component that calls `requireAuditPermission()`, then `listAuditEvents` (default page) and `getChainStatus`. Render:
  - A **chain-status banner**: green "Chain OK — N events" when `verification.ok`, red "Tamper detected at seq X" otherwise.
  - A table: `createdAt`, `action`, `entityType`/`entityId`, actor, `summary`, and the fingerprint's `appVersion`/`ip`. Follow the styling of an existing dashboard list page (e.g. `src/app/dashboard/orders`). Filters (`action`, `entityType`, date range) are query-param driven against the same `listAuditEvents`.

- [ ] **Step 8: Run tests + typecheck + lint.**

Run: `npx vitest run src/server/audit/read.test.ts && npx tsc --noEmit && npx eslint src/server/audit src/app/api/audit src/app/dashboard/audit`
Expected: PASS, clean.

- [ ] **Step 9: Commit.**

```bash
git add src/server/audit/read.ts src/server/audit/read.test.ts src/app/dashboard/audit-permission.ts src/app/api/audit src/app/dashboard/audit
git commit -m "feat(audit): audit:view-gated read API + chain-status banner and minimal log view"
```

---

## Task 8: Full-suite verification and manual acceptance

**Files:** none — this task changes nothing. It proves the spec.

- [ ] **Step 1: Run everything.**

```bash
npm test
npx tsc --noEmit
npx eslint src
```

Expected: all PASS, all clean. Fix anything that is not before continuing.

- [ ] **Step 2: Walk the spec's acceptance path.** With `npm run dev` and `npm run pos:dev` up, on a tenant paired to a POS device:

- [ ] Ring a POS sale. In the DB, confirm an `audit_events` row `action = 'sale.recorded'` whose `fingerprint` JSON contains a `deviceTokenHash` (64 hex chars, **not** the raw token) and the `X-POS-App-Version` value the POS sent.
- [ ] Send a request **without** `X-POS-App-Version` (older build); confirm the sale still records and the row has `appVersion: null`.
- [ ] In `psql`, run `UPDATE audit_events SET summary = 'x' WHERE seq = 1;` inside the tenant context → the `audit_events_append_only` trigger raises. Same for `DELETE`.
- [ ] Open `/dashboard/audit` as owner → the chain-status banner reads **OK**; as a `staff` user, the route returns **403**.
- [ ] Simulate a DB-admin tamper: `ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only;`, edit one row, re-enable, reload `/dashboard/audit` → the banner reports the first broken `seq`.

- [ ] **Step 3: Open the PR.**

```bash
git push -u origin HEAD
gh pr create --title "feat(audit): append-only, hash-chained, fingerprinted tenant audit log" --body "$(cat <<'EOF'
Implements docs/ailab/specs/2026-07-24-audit-and-fingerprint-log-design.md (Spec 4, decision D1).

- `audit_events` (append-only, FORCE RLS, no-mutate trigger) + `audit_chain_heads`
  (one row/tenant). `recordAuditEvent(ctx, event, tx)` appends inside the caller's
  transaction, serialized per-tenant with pg_advisory_xact_lock — the same lock
  pattern placeOrder uses for order numbers.
- SHA-256 hash chain: entryHash = sha256(canonical(prevHash, seq, tenant, actor,
  action, entity, metadata, createdAt)); genesis prevHash = 64 zeros. One canonical
  serializer shared by writer and verifier.
- Device/session fingerprint captured at the boundary (new X-POS-App-Version header;
  web session + UA + IP). The device token is stored only as a sha256 hash.
- Wired into placeOrder, recordSale, transitionStatus, discounts, and markPaid; a
  chain verifier reports the first broken seq; reads gated behind audit:view (owner
  + manager) via withTenant.

The platform audit_logs table is untouched — it continues to serve super-admin
actions. Void, refund, inventory, and PO emission points attach to the same helper
in Specs 3/8/9 with no chain changes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- *Data model* — `audit_events` + `audit_chain_heads`, FORCE RLS, unique `(tenantId, seq)`, read indexes, append-only trigger → **Task 1**.
- *Hash* — `entryHash = sha256(canonical(...))`, genesis `prevHash` = 64 zeros, one shared serializer → **Task 2**.
- *`recordAuditEvent` / atomicity / serialization / genesis* — advisory-locked read-then-advance on the caller's `tx`, rolls back with the mutation, monotonic seq under concurrency → **Task 3**.
- *Fingerprint at the boundary* — `X-POS-App-Version`, hashed device token, web UA/IP, `null` when missing → **Task 4**.
- *Authorization* + *tamper-evidence verifier* — `audit:view` (owner + manager), `verifyChain` reporting the first broken `seq` → **Task 5**.
- *Emission points* — `order.placed`, `sale.recorded`, `discount.applied`/`discount.order.applied`, `order.status.changed` `{before, after}`, `payment.marked_paid` → **Task 6**.
- *API* — `GET /api/audit/events` (paginated, filterable), `GET /api/audit/chain/status`, minimal view; writes never exposed → **Task 7**.
- *Testing* (unit / server / renderer / manual acceptance) — every task, plus **Task 8**.

**One deliberate deviation from the spec:** the spec's emission list includes **voids** (`line.voided`, `order.voided`) and **staff/menu/settings** changes. This plan wires the emission points that have a live mutation to attach to today — `placeOrder`, `recordSale`, `transitionStatus`, discounts, `markPaid` — and deliberately stops there. Voids after payment are refunds (Spec 3, per this repo's own Sale & Tender Self-Review, which left the void *flow* to Spec 3); a `line.voided` row for a pre-payment cart edit would record an event about an order that does not exist. Staff/menu/settings emission is a one-line `recordAuditEvent` call per service and is **called out here but left to the owning services' next touch** rather than reaching across five more modules in this PR — the helper, chain, and permission are ready for them with zero further change, exactly as the spec's "forward references" section intends. If broader coverage is wanted in this PR, add one emission call per service following the Task 6 pattern; nothing structural changes.

**Type consistency:** `AuditContext`, `AuditFingerprint`, `AuditEventInput` (Task 3) are the parameter types used unchanged in Tasks 4 (fingerprint attaches to `PosCashierContext.fingerprint`), 6 (every emission builds an `AuditContext`), and 7. `CanonicalInput`/`entryHash`/`ZERO_HASH` (Task 2) are consumed by both `recordAuditEvent` (Task 3) and `verifyChain` (Task 5) — the single-serializer guarantee. `ChainStatus` (Task 5) is what both `verifyChain` and `getChainStatus` (Task 7) return. `emptyFingerprint()` (Task 4) is the default every optional-`audit` path in Task 6 falls back to, so an un-fingerprinted mutation still produces a valid chain row rather than throwing.
