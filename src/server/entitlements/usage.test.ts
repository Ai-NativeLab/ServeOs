import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { usageCounters } from "@/server/subscription/schema";
import { and, eq } from "drizzle-orm";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { hasFeature } from "@/server/entitlements/service";
import { incrementUsage } from "@/server/entitlements/service";

async function makeTenant(slug = "u1") {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG" }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "basic");
  return t;
}

describe("entitlements usage + online_ordering", () => {
  it("basic plan has online_ordering feature", async () => {
    const t = await makeTenant("u1");
    expect(await hasFeature(t.id, "online_ordering")).toBe(true);
  });

  it("incrementUsage creates then increments the period counter", async () => {
    const t = await makeTenant("u2");
    await incrementUsage(t.id, "orders");
    await incrementUsage(t.id, "orders");
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [row] = await db
      .select()
      .from(usageCounters)
      .where(and(eq(usageCounters.tenantId, t.id), eq(usageCounters.metric, "orders"), eq(usageCounters.periodStart, periodStart)))
      .limit(1);
    expect(row.count).toBe(2);
  });
});
