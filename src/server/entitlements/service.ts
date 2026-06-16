import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { usageCounters } from "@/server/subscription/schema";
import { getPlanForTenant } from "@/server/subscription/service";
import type { PlanLimits, PlanFeatures } from "@/server/subscription/schema";
import { QuotaExceededError, FeatureNotAvailableError } from "./errors";

async function planOrThrow(tenantId: string) {
  const plan = await getPlanForTenant(tenantId);
  if (!plan) throw new Error(`No plan for tenant ${tenantId}`);
  return plan;
}

/** Throws QuotaExceededError if adding one more would exceed the plan limit. */
export async function checkQuota(tenantId: string, resource: keyof PlanLimits, currentCount: number): Promise<void> {
  const plan = await planOrThrow(tenantId);
  const limit = plan.limits[resource];
  if (currentCount >= limit) throw new QuotaExceededError(resource, limit, currentCount);
}

export async function hasFeature(tenantId: string, feature: keyof PlanFeatures): Promise<boolean> {
  const plan = await planOrThrow(tenantId);
  return Boolean(plan.features[feature]);
}

export async function requireFeature(tenantId: string, feature: keyof PlanFeatures): Promise<void> {
  if (!(await hasFeature(tenantId, feature))) throw new FeatureNotAvailableError(feature);
}

const METRIC_LIMIT: Record<string, keyof PlanLimits> = {
  orders: "orders_per_month",
  messages: "messages_per_month",
};

export async function checkUsage(tenantId: string, metric: "orders" | "messages"): Promise<void> {
  const plan = await planOrThrow(tenantId);
  const limit = plan.limits[METRIC_LIMIT[metric]];
  // Scope to the current billing period (first day of this month). Usage writers
  // (added in a later sub-project) must increment the row keyed by this periodStart.
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const [row] = await db
    .select()
    .from(usageCounters)
    .where(
      and(
        eq(usageCounters.tenantId, tenantId),
        eq(usageCounters.metric, metric),
        eq(usageCounters.periodStart, periodStart),
      ),
    )
    .limit(1);
  const used = row?.count ?? 0;
  if (used >= limit) throw new QuotaExceededError(metric, limit, used);
}

/**
 * Increments the usage counter for the current billing period (first day of the
 * month, matching checkUsage). usage_counters is a control table (not RLS-backed),
 * so this uses the plain db client. Read-then-write avoids needing a unique
 * constraint; a rare double-increment race is acceptable for non-critical metering.
 */
export async function incrementUsage(tenantId: string, metric: "orders" | "messages", by = 1): Promise<void> {
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const [row] = await db
    .select()
    .from(usageCounters)
    .where(
      and(
        eq(usageCounters.tenantId, tenantId),
        eq(usageCounters.metric, metric),
        eq(usageCounters.periodStart, periodStart),
      ),
    )
    .limit(1);
  if (row) {
    await db.update(usageCounters).set({ count: row.count + by }).where(eq(usageCounters.id, row.id));
  } else {
    await db.insert(usageCounters).values({ tenantId, metric, periodStart, count: by });
  }
}
