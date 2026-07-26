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
    const tenantId = await seedChain(0);
    expect((await verifyChain(tenantId)).ok).toBe(true);
  });

  it("reports the first broken seq after a hand-corrupted row", async () => {
    const tenantId = await seedChain(4);
    // The trigger blocks UPDATE, so disable it to simulate a DB-admin tamper.
    await db.execute(sql`ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only`);
    try {
      await withTenant(tenantId, (tx) =>
        tx.execute(sql`UPDATE audit_events SET metadata = '{"tampered":true}'::jsonb WHERE seq = 2`));
    } finally {
      await db.execute(sql`ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only`);
    }

    const status = await verifyChain(tenantId);
    expect(status).toEqual({ ok: false, brokenSeq: 2 });
  });
});
