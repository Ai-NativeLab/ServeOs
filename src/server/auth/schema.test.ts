import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { users } from "./schema";

describe("users schema", () => {
  it("allows the same email across different tenants but not within one", async () => {
    const [a] = await db.insert(tenants).values({ slug: "a", name: "A", country: "EG" }).returning();
    const [b] = await db.insert(tenants).values({ slug: "b", name: "B", country: "EG" }).returning();
    await db.insert(users).values({ tenantId: a.id, name: "Owner", email: "o@x.com" });
    await db.insert(users).values({ tenantId: b.id, name: "Owner", email: "o@x.com" }); // ok
    await expect(
      db.insert(users).values({ tenantId: a.id, name: "Dup", email: "o@x.com" }),
    ).rejects.toThrow();
  });

  it("permits a platform super-admin with null tenant", async () => {
    const [u] = await db.insert(users).values({ tenantId: null, name: "Root", email: "root@serveos.com" }).returning();
    expect(u.tenantId).toBeNull();
  });
});
