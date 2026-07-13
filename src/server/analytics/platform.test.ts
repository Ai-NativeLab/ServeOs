// src/server/analytics/platform.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "@/server/subscription";
import { registerTenant } from "@/server/onboarding/service";
import {
  getPlatformSignups, getTenantsByStatus, getPlatformMrr, getTrialsEndingSoon,
} from "./platform";

describe("platform analytics", () => {
  it("aggregates tenants by status and counts signups + mrr", async () => {
    await seedDefaultPlans();
    await registerTenant({ restaurantName: "Stats Co", slug: "stats-co", country: "EG", ownerName: "S", email: "s@stats.com", password: "x", vertical: "restaurant" });

    const byStatus = await getTenantsByStatus();
    expect(byStatus.find((r) => r.status === "trial")!.count).toBeGreaterThanOrEqual(1);

    const signups = await getPlatformSignups(30);
    expect(signups.length).toBeGreaterThan(0);

    const mrr = await getPlatformMrr();
    expect(mrr).toBeGreaterThanOrEqual(0);

    const ending = await getTrialsEndingSoon(30);
    expect(ending).toBeGreaterThanOrEqual(0);
  });
});
