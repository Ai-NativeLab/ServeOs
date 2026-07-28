import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { users } from "@/server/auth/schema";
import { auditEvents } from "./schema";
import { verifyChain } from "./verifier";
import { recordFinancialView, recordCustomerPiiView } from "./read-events";
import type { AuditActorInput } from "./service";

const fp = () => ({ deviceId: null, deviceTokenHash: null, appVersion: null, ip: null, userAgent: null });

async function eventsFor(tenantId: string, action: string) {
  return withTenant(tenantId, (tx) =>
    tx.select().from(auditEvents).where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.action, action))));
}

let n = 0;
async function seed() {
  const [t] = await db.insert(tenants).values({ slug: `audit-reads-${n++}`, name: "T", country: "EG" }).returning();
  const [u] = await db.insert(users).values({ tenantId: t.id, name: "Owner", email: `reads-${n}@x.com`, status: "active" }).returning();
  const actor: AuditActorInput = { actorUserId: u.id, actorType: "user", roleKey: "owner", fingerprint: fp() };
  return { tenantId: t.id, actor };
}

describe("sensitive read emission", () => {
  it("recordFinancialView writes one report.financial_viewed as a user", async () => {
    const { tenantId, actor } = await seed();
    await recordFinancialView(tenantId, actor);
    const [row] = await eventsFor(tenantId, "report.financial_viewed");
    expect(row).toBeDefined();
    expect(row.actorType).toBe("user");
    expect((await verifyChain(tenantId)).ok).toBe(true);
  });

  it("recordCustomerPiiView writes one customer.pii_viewed naming the fields (not values)", async () => {
    const { tenantId, actor } = await seed();
    await recordCustomerPiiView(tenantId, "order-123", actor);
    const [row] = await eventsFor(tenantId, "customer.pii_viewed");
    expect(row.entityId).toBe("order-123");
    expect(row.metadata).toMatchObject({ fields: ["customerName", "customerPhone", "addressText"] });
    expect((await verifyChain(tenantId)).ok).toBe(true);
  });
});
