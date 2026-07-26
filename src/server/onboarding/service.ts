import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { users, roles, userRoles } from "@/server/auth/schema";
import { hashPassword } from "@/server/auth/password";
import { plans, subscriptions } from "@/server/subscription/schema";
import { recordAuditEvent } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { onboardingApplications } from "./schema";
import { VERTICAL_IDS, type VerticalId } from "@/server/verticals";

export type RegisterInput = {
  restaurantName: string;
  slug: string;
  country: "EG" | "SA";
  ownerName: string;
  email: string;
  password: string;
  vertical: VerticalId;
};

export type RegisterResult = { tenantId: string; ownerUserId: string };

const TRIAL_DAYS = 14;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

export async function registerTenant(input: RegisterInput): Promise<RegisterResult> {
  if (!(VERTICAL_IDS as readonly string[]).includes(input.vertical))
    throw new Error(`Invalid vertical: ${input.vertical}`);
  if (!SLUG_RE.test(input.slug)) throw new Error(`Invalid slug: ${input.slug}`);

  const passwordHash = await hashPassword(input.password);

  return db.transaction(async (tx) => {
    const currency = input.country === "SA" ? "SAR" : "EGP";
    const timezone = input.country === "SA" ? "Asia/Riyadh" : "Africa/Cairo";

    const [tenant] = await tx
      .insert(tenants)
      .values({ slug: input.slug, name: input.restaurantName, country: input.country, currency, timezone, status: "trial", vertical: input.vertical })
      .returning();

    const [owner] = await tx
      .insert(users)
      .values({ tenantId: tenant.id, name: input.ownerName, email: input.email, passwordHash })
      .returning();

    const [ownerRole] = await tx
      .insert(roles)
      .values({ tenantId: tenant.id, key: "owner", name: "Owner" })
      .returning();
    await tx.insert(userRoles).values({ userId: owner.id, roleId: ownerRole.id });

    const [basic] = await tx.select().from(plans).where(eq(plans.key, "basic")).limit(1);
    if (!basic) throw new Error("Default plans not seeded");
    await tx.insert(subscriptions).values({
      tenantId: tenant.id,
      planId: basic.id,
      status: "trialing",
      trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000),
    });

    await tx.insert(onboardingApplications).values({ tenantId: tenant.id });

    // The tenant's genesis audit row. registerTenant uses a raw db.transaction,
    // so set app.tenant_id here (as withTenant would) for the RLS insert to pass.
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenant.id}, true)`);
    await recordAuditEvent(
      { tenantId: tenant.id, actorUserId: owner.id, fingerprint: emptyFingerprint() },
      { action: "tenant.registered", entityType: "tenant", entityId: tenant.id,
        summary: `Tenant "${input.restaurantName}" registered`,
        metadata: { slug: input.slug, vertical: input.vertical }, actorType: "user" },
      tx,
    );

    return { tenantId: tenant.id, ownerUserId: owner.id };
  });
}
