import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { customers } from "./schema";

async function seed(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG", vertical: "restaurant" }).returning();
  return t.id;
}

describe("customers schema", () => {
  it("is invisible outside its tenant (FORCE RLS)", async () => {
    const a = await seed("cust-a");
    const b = await seed("cust-b");
    await withTenant(a, (tx) => tx.insert(customers).values({
      tenantId: a, name: "Ahmed", email: "ahmed@x.com", passwordHash: "h",
    }));
    expect(await withTenant(b, (tx) => tx.select().from(customers))).toHaveLength(0);
    expect(await withTenant(a, (tx) => tx.select().from(customers))).toHaveLength(1);
  });

  it("enforces one email per tenant but allows the same email at another shop", async () => {
    const a = await seed("cust-c");
    const b = await seed("cust-d");
    await withTenant(a, (tx) => tx.insert(customers).values({
      tenantId: a, name: "A", email: "same@x.com", passwordHash: "h",
    }));
    await expect(withTenant(a, (tx) => tx.insert(customers).values({
      tenantId: a, name: "A2", email: "same@x.com", passwordHash: "h",
    }))).rejects.toThrow();
    // The identical email registers cleanly at a different tenant (C1).
    await expect(withTenant(b, (tx) => tx.insert(customers).values({
      tenantId: b, name: "B", email: "same@x.com", passwordHash: "h",
    }))).resolves.toBeDefined();
  });
});
