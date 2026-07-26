import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { authorize, UnauthorizedError } from "@/server/rbac/authorize";
import { recordAuditEvent, type AuditContext, type AuditEventInput } from "./service";
import { listAuditEvents, getChainStatus } from "./read";

let n = 0;
async function seedTenant() {
  const [t] = await db.insert(tenants).values({ slug: `audit-read-${n++}`, name: "T", country: "EG", vertical: "restaurant" }).returning();
  return t.id;
}
const ctxFor = (tenantId: string): AuditContext => ({
  tenantId,
  fingerprint: { deviceId: null, deviceTokenHash: null, appVersion: null, ip: null, userAgent: null },
});
const ev = (action: string, entityType: string, entityId: string, actorType: AuditEventInput["actorType"]): AuditEventInput =>
  ({ action, entityType, entityId, summary: "s", actorType });

describe("listAuditEvents", () => {
  it("filters by action, entity, and actorType, and orders newest-first, respecting limit", async () => {
    const tenantId = await seedTenant();
    await withTenant(tenantId, (tx) => recordAuditEvent(ctxFor(tenantId), ev("order.placed", "order", "o1", "system"), tx));
    await withTenant(tenantId, (tx) => recordAuditEvent(ctxFor(tenantId), ev("sale.recorded", "order", "o1", "device"), tx));
    await withTenant(tenantId, (tx) => recordAuditEvent(ctxFor(tenantId), ev("order.placed", "order", "o2", "customer"), tx));

    const byAction = await listAuditEvents(tenantId, { action: "order.placed" });
    expect(byAction).toHaveLength(2);
    expect(byAction[0].seq).toBeGreaterThan(byAction[1].seq); // newest-first

    const byEntity = await listAuditEvents(tenantId, { entityType: "order", entityId: "o1" });
    expect(byEntity).toHaveLength(2);

    const byActor = await listAuditEvents(tenantId, { actorType: "device" });
    expect(byActor).toHaveLength(1);
    expect(byActor[0].action).toBe("sale.recorded");

    expect(await listAuditEvents(tenantId, { limit: 1 })).toHaveLength(1);
  });

  it("getChainStatus returns the head and an ok verification for a clean chain", async () => {
    const tenantId = await seedTenant();
    await withTenant(tenantId, (tx) => recordAuditEvent(ctxFor(tenantId), ev("a", "x", "1", "system"), tx));
    const status = await getChainStatus(tenantId);
    expect(status.head?.seq).toBe(1);
    expect(status.verification.ok).toBe(true);
  });

  it("never returns another tenant's rows (RLS)", async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    await withTenant(a, (tx) => recordAuditEvent(ctxFor(a), ev("only.a", "x", "1", "system"), tx));
    expect(await listAuditEvents(b, {})).toHaveLength(0);
  });

  it("a staff role fails the audit:view check (what the route maps to 403)", () => {
    expect(() => authorize(["staff"], "audit:view")).toThrow(UnauthorizedError);
    expect(() => authorize(["owner"], "audit:view")).not.toThrow();
    expect(() => authorize(["manager"], "audit:view")).not.toThrow();
  });
});
