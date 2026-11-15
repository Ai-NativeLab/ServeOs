import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { users, roles, userRoles } from "@/server/auth/schema";
import { hashPassword } from "@/server/auth/password";
import { plans, subscriptions } from "@/server/subscription/schema";
import { recordAuditEvent } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { onboardingApplications } from "./schema";
import { isDemoSlug } from "@/server/demo/entry";
import { VERTICAL_IDS, type VerticalId } from "@/server/verticals";
import { isValidSlug } from "./slug";

export type RegisterInput = {
  restaurantName: string;
  slug: string;
  country: "EG" | "SA";
  ownerName: string;
  email: string;
  password: string;
  vertical: VerticalId;
  /**
   * Opt out of the reserved-slug guard. ONLY the demo seed script sets this —
   * it is the thing that legitimately creates `demo-*` tenants. Public
   * registration must never pass it.
   */
  allowReservedSlug?: boolean;
};

export type RegisterResult = { tenantId: string; ownerUserId: string };

const TRIAL_DAYS = 14;

export type RegistrationErrorCode = "invalid_slug" | "reserved_slug" | "slug_taken";

/**
 * A rejection the person filling the register form can act on. The register
 * action turns it into a field error; anything else thrown here is a real
 * fault and stays a 500.
 */
export class RegistrationError extends Error {
  override readonly name = "RegistrationError";
  constructor(
    readonly code: RegistrationErrorCode,
    readonly field: "slug",
    message: string,
  ) {
    super(message);
  }
}

/**
 * True when the insert lost on tenants.slug — someone already has that
 * subdomain, possibly registered a moment ago. Checked on the error rather
 * than with a SELECT first, which would race. `.cause` because drizzle wraps
 * the pg error.
 */
function isSlugTaken(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; constraint?: unknown; cause?: { code?: unknown; constraint?: unknown } };
  return (e.code ?? e.cause?.code) === "23505" && (e.constraint ?? e.cause?.constraint) === "tenants_slug_unique";
}

export async function registerTenant(input: RegisterInput): Promise<RegisterResult> {
  if (!(VERTICAL_IDS as readonly string[]).includes(input.vertical))
    throw new Error(`Invalid vertical: ${input.vertical}`);
  if (!isValidSlug(input.slug))
    throw new RegistrationError("invalid_slug", "slug", `Invalid slug: ${input.slug}`);
  // The demo prefix is reserved. /api/demo/login will sign ANYONE into a slug
  // this predicate accepts, so a self-registered `demo-*` tenant would hand
  // strangers an owner session on it. The subscribe fork now leans on the same
  // predicate to tell a prospect from a customer, which makes it load-bearing
  // twice over. The demo seeder is the one caller that may opt out.
  if (!input.allowReservedSlug && isDemoSlug(input.slug)) {
    throw new RegistrationError("reserved_slug", "slug", `Reserved slug: ${input.slug}`);
  }

  const passwordHash = await hashPassword(input.password);

  return db.transaction(async (tx) => {
    const currency = input.country === "SA" ? "SAR" : "EGP";
    const timezone = input.country === "SA" ? "Asia/Riyadh" : "Africa/Cairo";

    const [tenant] = await tx
      .insert(tenants)
      .values({ slug: input.slug, name: input.restaurantName, country: input.country, currency, timezone, status: "trial", vertical: input.vertical })
      .returning()
      .catch((err: unknown) => {
        if (isSlugTaken(err)) throw new RegistrationError("slug_taken", "slug", `Slug taken: ${input.slug}`);
        throw err;
      });

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
