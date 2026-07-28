import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { tenantOfflineMethods } from "./methods.schema";

async function makeTenant(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG" }).returning();
  return t;
}

describe("tenant_offline_methods RLS", () => {
  it("isolates methods per tenant and fails closed with no app.tenant_id", async () => {
    const a = await makeTenant("om-a");
    const b = await makeTenant("om-b");
    await withTenant(a.id, (tx) =>
      tx.insert(tenantOfflineMethods).values({ tenantId: a.id, type: "vodafone_cash", label: "Vodafone Cash", payToDetail: "0100" }),
    );
    const mine = await withTenant(a.id, (tx) => tx.select().from(tenantOfflineMethods));
    const theirs = await withTenant(b.id, (tx) => tx.select().from(tenantOfflineMethods));
    const bare = await db.select().from(tenantOfflineMethods);
    expect(mine.length).toBe(1);
    expect(theirs.length).toBe(0);
    expect(bare.length).toBe(0);
  });
});
