import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { usageCounters } from "@/server/subscription/schema";
import { seedDefaultPlans, startTrial } from "@/server/subscription";
import { checkQuota, hasFeature, requireFeature, checkUsage } from "./service";
import { QuotaExceededError, FeatureNotAvailableError } from "./errors";

async function basicTenant() {
  await seedDefaultPlans();
  const [t] = await db.insert(tenants).values({ slug: "t", name: "T", country: "EG" }).returning();
  await startTrial(t.id, "basic");
  return t;
}

describe("entitlements", () => {
  it("allows a quota under the limit and throws over it", async () => {
    const t = await basicTenant(); // basic: branches = 1
    await expect(checkQuota(t.id, "branches", 0)).resolves.toBeUndefined();
    await expect(checkQuota(t.id, "branches", 1)).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it("reports feature flags from the plan and requireFeature throws when absent", async () => {
    const t = await basicTenant();
    expect(await hasFeature(t.id, "whatsapp")).toBe(false);
    await expect(requireFeature(t.id, "whatsapp")).rejects.toBeInstanceOf(FeatureNotAvailableError);
  });

  it("enforces monthly usage caps", async () => {
    const t = await basicTenant(); // orders_per_month = 200
    await db.insert(usageCounters).values({
      tenantId: t.id,
      metric: "orders",
      periodStart: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
      count: 200,
    });
    await expect(checkUsage(t.id, "orders")).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it("localizes error messages in English and Arabic", async () => {
    const err = new QuotaExceededError("branches", 1, 1);
    expect(err.messageFor("en")).toMatch(/branches/i);
    expect(err.messageFor("ar")).toMatch(/باق/); // Arabic word for plan/package
  });
});
