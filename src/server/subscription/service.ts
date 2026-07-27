import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { plans, subscriptions, type Subscription } from "./schema";

const TRIAL_DAYS = 14;

type Status = Subscription["status"];

const ALLOWED: Record<Status, Status[]> = {
  trialing: ["active", "past_due", "canceled"],
  active: ["past_due", "canceled"],
  past_due: ["active", "suspended", "canceled"],
  suspended: ["active", "canceled"],
  canceled: [],
};

export async function startTrial(tenantId: string, planKey: string): Promise<Subscription> {
  const [plan] = await db.select().from(plans).where(eq(plans.key, planKey)).limit(1);
  if (!plan) throw new Error(`Unknown plan: ${planKey}`);
  const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
  const [sub] = await db
    .insert(subscriptions)
    .values({ tenantId, planId: plan.id, status: "trialing", trialEndsAt })
    .returning();
  return sub;
}

export async function transition(subscriptionId: string, next: Status): Promise<Subscription> {
  const [current] = await db.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId)).limit(1);
  if (!current) throw new Error("Subscription not found");
  if (!ALLOWED[current.status].includes(next)) {
    throw new Error(`Invalid transition: ${current.status} -> ${next}`);
  }
  const [updated] = await db
    .update(subscriptions)
    .set({ status: next })
    .where(eq(subscriptions.id, subscriptionId))
    .returning();
  return updated;
}

export async function getActiveSubscription(tenantId: string): Promise<Subscription | null> {
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.tenantId, tenantId))
    .limit(1);
  return sub ?? null;
}

export async function getPlanForTenant(tenantId: string) {
  const [row] = await db
    .select({ plan: plans })
    .from(subscriptions)
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .where(eq(subscriptions.tenantId, tenantId))
    .limit(1);
  return row?.plan ?? null;
}

export async function listPlans() {
  return db.select().from(plans).orderBy(plans.priceMonthly);
}

/** Set the tenant's subscription active on a plan for a 1-month period (manual confirm). */
export async function activateSubscriptionForPlan(tenantId: string, planId: string): Promise<void> {
  const now = new Date();
  const end = new Date(now); end.setMonth(end.getMonth() + 1);
  await db.update(subscriptions)
    .set({ planId, status: "active", currentPeriodStart: now, currentPeriodEnd: end })
    .where(eq(subscriptions.tenantId, tenantId));
}
