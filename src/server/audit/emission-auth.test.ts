import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { users } from "@/server/auth/schema";
import { auditEvents } from "./schema";
import { verifyChain } from "./verifier";
import { recordAuthEvent } from "./auth-events";

const fp = () => ({ deviceId: null, deviceTokenHash: null, appVersion: null, ip: null, userAgent: null });

async function eventsFor(tenantId: string, action: string) {
  return withTenant(tenantId, (tx) =>
    tx.select().from(auditEvents).where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.action, action))));
}

let n = 0;
async function seed() {
  const [t] = await db.insert(tenants).values({ slug: `audit-auth-${n++}`, name: "T", country: "EG" }).returning();
  const [u] = await db.insert(users).values({ tenantId: t.id, name: "U", email: `auth-${n}@x.com`, status: "active" }).returning();
  return { tenantId: t.id, userId: u.id };
}

describe("recordAuthEvent", () => {
  it("auth.login records the user actor", async () => {
    const { tenantId, userId } = await seed();
    await recordAuthEvent(tenantId, "auth.login", { actorUserId: userId, fingerprint: fp() });
    const [row] = await eventsFor(tenantId, "auth.login");
    expect(row.actorUserId).toBe(userId);
    expect(row.actorType).toBe("user");
    expect((await verifyChain(tenantId)).ok).toBe(true);
  });

  it("auth.login_failed has a null actor and the attempted email in metadata", async () => {
    const { tenantId } = await seed();
    await recordAuthEvent(tenantId, "auth.login_failed", { actorUserId: null, email: "nope@x.com", fingerprint: fp() });
    const [row] = await eventsFor(tenantId, "auth.login_failed");
    expect(row.actorUserId).toBeNull();
    expect(row.metadata).toMatchObject({ email: "nope@x.com" });
  });

  it("auth.logout records the user", async () => {
    const { tenantId, userId } = await seed();
    await recordAuthEvent(tenantId, "auth.logout", { actorUserId: userId, fingerprint: fp() });
    expect(await eventsFor(tenantId, "auth.logout")).toHaveLength(1);
  });
});
