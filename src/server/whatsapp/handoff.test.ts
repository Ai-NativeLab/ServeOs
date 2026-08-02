import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { mintHandoff, redeemHandoff } from "./handoff";

async function seed(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG", vertical: "restaurant" }).returning();
  return t.id;
}

describe("cart handoff", () => {
  it("redeems once and refuses the second attempt", async () => {
    const tenantId = await seed("wa-hand-1");
    const token = await mintHandoff(tenantId, "2011", null, [{ productId: "p1", quantity: 2 }]);
    const first = await redeemHandoff(tenantId, token);
    expect(first?.cart).toEqual([{ productId: "p1", quantity: 2 }]);
    expect(await redeemHandoff(tenantId, token)).toBeNull();
  });

  it("is invisible to another tenant, so a cross-tenant replay fails closed", async () => {
    const a = await seed("wa-hand-2");
    const b = await seed("wa-hand-3");
    const token = await mintHandoff(a, "2011", null, [{ productId: "p1", quantity: 1 }]);
    expect(await redeemHandoff(b, token)).toBeNull();
  });

  it("refuses an expired token", async () => {
    const tenantId = await seed("wa-hand-4");
    const token = await mintHandoff(tenantId, "2011", null, [{ productId: "p1", quantity: 1 }], -1);
    expect(await redeemHandoff(tenantId, token)).toBeNull();
  });
});
