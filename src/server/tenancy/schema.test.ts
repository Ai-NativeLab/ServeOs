import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "./schema";

describe("tenants schema", () => {
  it("inserts a tenant and enforces unique slug", async () => {
    await db.insert(tenants).values({ slug: "pizzaroma", name: "Pizza Roma", country: "EG" });
    const rows = await db.select().from(tenants);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("onboarding");
    await expect(
      db.insert(tenants).values({ slug: "pizzaroma", name: "Dup", country: "EG" }),
    ).rejects.toThrow();
  });
});
