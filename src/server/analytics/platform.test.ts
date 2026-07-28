// src/server/analytics/platform.test.ts
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { plans, subscriptions } from "@/server/subscription/schema";
import { seedDefaultPlans } from "@/server/subscription";
import { registerTenant } from "@/server/onboarding/service";
import {
  getPlatformSignups, getTenantsByStatus, getPlatformMrr, getTrialsEndingSoon,
  getPlatformMrrTrend,
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

  // This query is what the admin overview page crashed on: it joins
  // subscriptions on a created_at column the table never had, so the whole
  // page threw. Nothing exercised it, so the suite stayed green.
  it("builds an MRR trend series across the requested window", async () => {
    await seedDefaultPlans();
    await registerTenant({ restaurantName: "Trend Co", slug: "trend-co", country: "EG", ownerName: "T", email: "t@trend.com", password: "x", vertical: "restaurant" });

    const trend = await getPlatformMrrTrend(30);

    expect(trend.length).toBeGreaterThan(0);
    expect(trend.every((p) => Number.isFinite(p.mrr) && p.mrr >= 0)).toBe(true);
    // Ordered oldest → newest, so the series can be plotted directly.
    const days = trend.map((p) => new Date(p.day).getTime());
    expect(days).toEqual([...days].sort((a, b) => a - b));
  });

  it("counts a subscription only from the day it was created", async () => {
    await seedDefaultPlans();
    const { tenantId } = await registerTenant({ restaurantName: "Backdated Co", slug: "backdated-co", country: "EG", ownerName: "B", email: "b@backdated.com", password: "x", vertical: "restaurant" });

    const [pro] = await db.select().from(plans).where(eq(plans.key, "pro")).limit(1);
    expect(Number(pro.priceMonthly)).toBeGreaterThan(0);

    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await db
      .update(subscriptions)
      .set({ status: "active", planId: pro.id, createdAt: tenDaysAgo })
      .where(eq(subscriptions.tenantId, tenantId));

    const trend = await getPlatformMrrTrend(30);

    // 30 days back predates the subscription; today includes it. Guards against
    // the trend being rewired to a column that is not the start date.
    expect(trend[0].mrr).toBe(0);
    expect(trend.at(-1)!.mrr).toBe(Number(pro.priceMonthly));
  });
});
