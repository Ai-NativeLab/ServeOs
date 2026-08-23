import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { bumpCatalogVersion } from "./version";
import { catalogVersions } from "./schema";

/**
 * This table's RLS is hand-appended to its migration: drizzle-kit does not
 * emit ENABLE/FORCE ROW LEVEL SECURITY or CREATE POLICY, so every migration
 * regeneration silently drops it — twice already during this feature's
 * merges with main. Regenerating is routine and the loss is invisible in the
 * diff, so the guard has to be a test rather than a review habit.
 */
async function seedTenant(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG", vertical: "retail" }).returning();
  return t;
}

describe("catalog_versions RLS", () => {
  it("isolates versions per tenant and fails closed outside withTenant", async () => {
    const a = await seedTenant("cvrls-a");
    const b = await seedTenant("cvrls-b");

    await withTenant(a.id, (tx) => bumpCatalogVersion(a.id, tx));

    const mine = await withTenant(a.id, (tx) => tx.select().from(catalogVersions));
    const theirs = await withTenant(b.id, (tx) => tx.select().from(catalogVersions));
    const bare = await db.select().from(catalogVersions);

    expect(mine.length).toBe(1);
    expect(theirs.length).toBe(0);
    expect(bare.length).toBe(0); // FORCE RLS fails closed without app.tenant_id
  });
});
