import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { registerCustomer } from "@/server/customers/service";
import { prescriptions } from "./schema";

async function seed(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG", vertical: "pharmacy" }).returning();
  const c = await registerCustomer(t.id, { name: "Patient", email: `p-${slug}@x.com`, password: "secret123" });
  return { tenantId: t.id, customerId: c.id };
}

describe("prescriptions schema", () => {
  it("is invisible outside its tenant (FORCE RLS) — medical data never leaks across shops", async () => {
    const a = await seed("rx-a");
    const b = await seed("rx-b");
    await withTenant(a.tenantId, (tx) => tx.insert(prescriptions).values({
      tenantId: a.tenantId, customerId: a.customerId, imagePath: "rx/a/script.jpg",
    }));
    expect(await withTenant(b.tenantId, (tx) => tx.select().from(prescriptions))).toHaveLength(0);
    expect(await withTenant(a.tenantId, (tx) => tx.select().from(prescriptions))).toHaveLength(1);
  });

  it("defaults to pending review with no reviewer recorded", async () => {
    const { tenantId, customerId } = await seed("rx-c");
    const [row] = await withTenant(tenantId, (tx) => tx.insert(prescriptions).values({
      tenantId, customerId, imagePath: "rx/c/script.jpg",
    }).returning());
    expect(row.status).toBe("pending");
    expect(row.reviewedByUserId).toBeNull();
    expect(row.reviewedAt).toBeNull();
    // The stored value is a PATH, never a public URL (decision R4).
    expect(row.imagePath).not.toMatch(/^https?:/);
  });
});
