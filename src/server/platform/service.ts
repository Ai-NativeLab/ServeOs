import { eq, and, or, ilike, desc, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { onboardingApplications } from "@/server/onboarding/schema";
import { auditLogs } from "./audit.schema";
import { subscriptions, plans, type Plan, type Subscription } from "@/server/subscription/schema";
import { getPlanForTenant } from "@/server/subscription/service";
import { branches } from "@/server/branches/schema";
import { products } from "@/server/catalog/schema";
import { orders } from "@/server/ordering/schema";
import { invoices } from "@/server/billing/schema";

export async function listPendingApplications() {
  return db
    .select({
      applicationId: onboardingApplications.id,
      tenantId: tenants.id,
      tenantName: tenants.name,
      slug: tenants.slug,
      submittedAt: onboardingApplications.submittedAt,
    })
    .from(onboardingApplications)
    .innerJoin(tenants, eq(tenants.id, onboardingApplications.tenantId))
    .where(eq(onboardingApplications.status, "pending"));
}

export async function approveTenant(tenantId: string, adminUserId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [t] = await tx.update(tenants).set({ status: "active" }).where(eq(tenants.id, tenantId)).returning();
    if (!t) throw new Error("Tenant not found");
    await tx
      .update(onboardingApplications)
      .set({ status: "approved", reviewedBy: adminUserId })
      .where(eq(onboardingApplications.tenantId, tenantId));
    await tx.insert(auditLogs).values({
      tenantId,
      actorUserId: adminUserId,
      action: "tenant.approved",
      target: tenantId,
    });
  });
}

export async function rejectTenant(tenantId: string, adminUserId: string, notes: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [t] = await tx.update(tenants).set({ status: "rejected" }).where(eq(tenants.id, tenantId)).returning();
    if (!t) throw new Error("Tenant not found");
    await tx
      .update(onboardingApplications)
      .set({ status: "rejected", reviewedBy: adminUserId, reviewNotes: notes })
      .where(eq(onboardingApplications.tenantId, tenantId));
    await tx.insert(auditLogs).values({
      tenantId,
      actorUserId: adminUserId,
      action: "tenant.rejected",
      target: tenantId,
      metadata: { notes },
    });
  });
}

export async function suspendTenant(tenantId: string, adminUserId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [t] = await tx.update(tenants).set({ status: "suspended" }).where(eq(tenants.id, tenantId)).returning();
    if (!t) throw new Error("Tenant not found");
    await tx.insert(auditLogs).values({ tenantId, actorUserId: adminUserId, action: "tenant.suspended", target: tenantId });
  });
}

export type TenantRow = {
  id: string; slug: string; name: string; status: string; vertical: string;
  country: string; currency: string; createdAt: Date;
  planKey: string | null; planName: string | null; subscriptionStatus: string | null;
};

export async function listTenants(opts: { status?: string; search?: string } = {}): Promise<TenantRow[]> {
  const conditions = [];
  if (opts.status) conditions.push(sql`${tenants.status} = ${opts.status}`);
  if (opts.search) conditions.push(or(ilike(tenants.name, `%${opts.search}%`), ilike(tenants.slug, `%${opts.search}%`)));
  return db
    .select({
      id: tenants.id, slug: tenants.slug, name: tenants.name, status: tenants.status,
      vertical: tenants.vertical, country: tenants.country, currency: tenants.currency,
      createdAt: tenants.createdAt, planKey: plans.key, planName: plans.name,
      subscriptionStatus: subscriptions.status,
    })
    .from(tenants)
    .leftJoin(subscriptions, eq(subscriptions.tenantId, tenants.id))
    .leftJoin(plans, eq(plans.id, subscriptions.planId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(tenants.createdAt));
}

export type TenantDetail = {
  tenant: typeof tenants.$inferSelect;
  subscription: Subscription | null;
  plan: Plan | null;
  branchCount: number;
  productCount: number;
  publishedProductCount: number;
  orderCount: number;
};

export async function getTenantDetail(tenantId: string): Promise<TenantDetail | null> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) return null;
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.tenantId, tenantId)).limit(1);
  const plan = sub ? await getPlanForTenant(tenantId) : null;
  const [b] = await db.select({ count: sql<number>`count(*)::int` }).from(branches).where(eq(branches.tenantId, tenantId));
  const [p] = await db.select({ count: sql<number>`count(*)::int` }).from(products).where(eq(products.tenantId, tenantId));
  const [pp] = await db.select({ count: sql<number>`count(*)::int` }).from(products).where(and(eq(products.tenantId, tenantId), eq(products.isPublished, true)));
  const [o] = await db.select({ count: sql<number>`count(*)::int` }).from(orders).where(eq(orders.tenantId, tenantId));
  return {
    tenant, subscription: sub ?? null, plan,
    branchCount: b?.count ?? 0, productCount: p?.count ?? 0,
    publishedProductCount: pp?.count ?? 0, orderCount: o?.count ?? 0,
  };
}

export type AuditRow = {
  id: string; action: string; target: string | null; tenantId: string | null;
  tenantName: string | null; actorUserId: string | null; createdAt: Date;
  metadata: Record<string, unknown>;
};

export async function listAuditLogs(opts: { action?: string; tenantId?: string; limit?: number } = {}): Promise<AuditRow[]> {
  const conditions = [];
  if (opts.action) conditions.push(eq(auditLogs.action, opts.action));
  if (opts.tenantId) conditions.push(eq(auditLogs.tenantId, opts.tenantId));
  return db
    .select({
      id: auditLogs.id, action: auditLogs.action, target: auditLogs.target,
      tenantId: auditLogs.tenantId, tenantName: tenants.name,
      actorUserId: auditLogs.actorUserId, createdAt: auditLogs.createdAt,
      metadata: auditLogs.metadata,
    })
    .from(auditLogs)
    .leftJoin(tenants, eq(tenants.id, auditLogs.tenantId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(auditLogs.createdAt))
    .limit(opts.limit ?? 50);
}

async function setSubscriptionStatus(tenantId: string, status: Subscription["status"], adminUserId: string, action: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [sub] = await tx.update(subscriptions).set({ status }).where(eq(subscriptions.tenantId, tenantId)).returning();
    if (!sub) throw new Error("Subscription not found");
    await tx.insert(auditLogs).values({ tenantId, actorUserId: adminUserId, action, target: sub.id });
  });
}

export async function activateTenant(tenantId: string, adminUserId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [t] = await tx.update(tenants).set({ status: "active" }).where(eq(tenants.id, tenantId)).returning();
    if (!t) throw new Error("Tenant not found");
    await tx.insert(auditLogs).values({ tenantId, actorUserId: adminUserId, action: "tenant.activated", target: tenantId });
  });
}

export async function cancelSubscription(tenantId: string, adminUserId: string): Promise<void> {
  await setSubscriptionStatus(tenantId, "canceled", adminUserId, "tenant.subscription.canceled");
}

export async function forceSubscriptionActive(tenantId: string, adminUserId: string): Promise<void> {
  await setSubscriptionStatus(tenantId, "active", adminUserId, "tenant.subscription.forced_active");
}

export async function markSubscriptionPaid(tenantId: string, adminUserId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [inv] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.status, "open")))
      .orderBy(desc(invoices.createdAt))
      .limit(1);
    if (inv) {
      await tx.update(invoices).set({ status: "paid", method: "admin", markedBy: adminUserId, paidAt: new Date() }).where(eq(invoices.id, inv.id));
    }
    const [sub] = await tx.update(subscriptions).set({ status: "active" }).where(eq(subscriptions.tenantId, tenantId)).returning();
    if (!sub) throw new Error("Subscription not found");
    await tx.insert(auditLogs).values({ tenantId, actorUserId: adminUserId, action: "tenant.subscription.marked_paid", target: sub.id });
  });
}
