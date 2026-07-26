import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { recordAuditEvent, type AuditActorInput } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
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

export async function startTrial(tenantId: string, planKey: string, audit?: AuditActorInput): Promise<Subscription> {
  const [plan] = await db.select().from(plans).where(eq(plans.key, planKey)).limit(1);
  if (!plan) throw new Error(`Unknown plan: ${planKey}`);
  const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
  // subscriptions has no RLS; the withTenant wrap is for the audit insert's app.tenant_id.
  return withTenant(tenantId, async (tx) => {
    const [sub] = await tx
      .insert(subscriptions)
      .values({ tenantId, planId: plan.id, status: "trialing", trialEndsAt })
      .returning();
    await recordAuditEvent(
      { tenantId, actorUserId: audit?.actorUserId ?? null, fingerprint: audit?.fingerprint ?? emptyFingerprint() },
      { action: "subscription.trial_started", entityType: "subscription", entityId: sub.id,
        summary: `Trial started on ${planKey}`, metadata: { planKey, roleKey: audit?.roleKey ?? null }, actorType: audit?.actorType },
      tx,
    );
    return sub;
  });
}

export async function transition(subscriptionId: string, next: Status, audit?: AuditActorInput): Promise<Subscription> {
  const [current] = await db.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId)).limit(1);
  if (!current) throw new Error("Subscription not found");
  if (!ALLOWED[current.status].includes(next)) {
    throw new Error(`Invalid transition: ${current.status} -> ${next}`);
  }
  return withTenant(current.tenantId, async (tx) => {
    const [updated] = await tx
      .update(subscriptions)
      .set({ status: next })
      .where(eq(subscriptions.id, subscriptionId))
      .returning();
    // A job-driven transition (no audit actor) records as `system`.
    await recordAuditEvent(
      { tenantId: current.tenantId, actorUserId: audit?.actorUserId ?? null, fingerprint: audit?.fingerprint ?? emptyFingerprint() },
      { action: "subscription.status_changed", entityType: "subscription", entityId: subscriptionId,
        summary: `Subscription ${current.status} → ${next}`,
        metadata: { before: current.status, after: next, roleKey: audit?.roleKey ?? null }, actorType: audit?.actorType ?? "system" },
      tx,
    );
    return updated;
  });
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
