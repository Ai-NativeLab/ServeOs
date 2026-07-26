import { describe, it, expect } from "vitest";
import { asc, sql } from "drizzle-orm";
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

/**
 * Assert `run` rejects AND the append-only trigger's message ("… is append-only
 * …") appears on the thrown error or anywhere on its `cause` chain. Drizzle
 * (node-postgres) wraps the Postgres error in a DrizzleQueryError, so the
 * trigger's RAISE lands on `.cause`, not the top-level `.message` that
 * `toThrow(/…/)` inspects. This preserves the exact /append-only/ guarantee.
 */
async function expectAppendOnlyRejection(run: () => Promise<unknown>) {
  const err = await run().then(() => null, (e: unknown) => e);
  expect(err, "expected the write to be rejected by the append-only trigger").not.toBeNull();
  let chain = "";
  for (let cur: unknown = err; cur; cur = (cur as { cause?: unknown }).cause) {
    chain += String((cur as { message?: unknown }).message ?? "");
  }
  expect(chain).toMatch(/append-only/);
}

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

  it("appends multiple rows in a single tx, chained", async () => {
    const tenantId = await seedTenant();
    await withTenant(tenantId, async (tx) => {
      await recordAuditEvent(ctxFor(tenantId), ev("a"), tx);
      await recordAuditEvent(ctxFor(tenantId), ev("b"), tx);
    });
    const rows = await withTenant(tenantId, (tx) =>
      tx.select().from(auditEvents).orderBy(asc(auditEvents.seq)));
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(rows[1].prevHash).toBe(rows[0].entryHash);
  });

  it("recomputes the hash from the DB-read row with non-trivial metadata (jsonb round-trip)", async () => {
    const tenantId = await seedTenant();
    await withTenant(tenantId, (tx) => recordAuditEvent(ctxFor(tenantId), {
      action: "test.event", entityType: "test", entityId: "m1", summary: "s", actorType: "system",
      metadata: { z: 1, a: { nested: true }, arr: [3, 1, 2], s: "x" },
    }, tx));
    const [row] = await withTenant(tenantId, (tx) => tx.select().from(auditEvents));
    expect(row.entryHash).toBe(entryHash({
      prevHash: row.prevHash, seq: row.seq, tenantId, actorUserId: row.actorUserId,
      action: row.action, entityType: row.entityType, entityId: row.entityId,
      metadata: row.metadata, createdAt: row.createdAt.toISOString(),
    }));
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
    await expectAppendOnlyRejection(() =>
      withTenant(tenantId, (tx) => tx.execute(sql`UPDATE audit_events SET action = 'tampered'`)));
    await expectAppendOnlyRejection(() =>
      withTenant(tenantId, (tx) => tx.execute(sql`DELETE FROM audit_events`)));
  });
});
