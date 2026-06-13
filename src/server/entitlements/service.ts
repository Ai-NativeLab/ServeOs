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
  const [row] = await db
    .select()
    .from(usageCounters)
    .where(and(eq(usageCounters.tenantId, tenantId), eq(usageCounters.metric, metric)))
    .limit(1);
  const used = row?.count ?? 0;
  if (used >= limit) throw new QuotaExceededError(metric, limit, used);
}
