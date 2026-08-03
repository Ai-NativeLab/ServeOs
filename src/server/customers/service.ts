import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { recordAuditEvent, type AuditActorInput } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { customers, customerSessions, type Customer } from "./schema";

/** One generic message for every auth failure — no account-existence oracle. */
export class CustomerAuthError extends Error {
  constructor() { super("Invalid email or password"); }
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const auditCtx = (tenantId: string) =>
  ({ tenantId, actorUserId: null, fingerprint: emptyFingerprint() });

const normalizeEmail = (email: string) => email.trim().toLowerCase();

export async function registerCustomer(
  tenantId: string,
  input: { name: string; email: string; password: string; phone?: string },
): Promise<Customer> {
  const email = normalizeEmail(input.email);
  const passwordHash = await hashPassword(input.password);

  return withTenant(tenantId, async (tx) => {
    const [existing] = await tx.select({ id: customers.id }).from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.email, email))).limit(1);
    if (existing) throw new Error("An account with this email already exists");

    const [customer] = await tx.insert(customers).values({
      tenantId, name: input.name.trim(), email, phone: input.phone ?? null, passwordHash,
    }).returning();

    await recordAuditEvent(auditCtx(tenantId), {
      action: "customer.registered",
      entityType: "customer",
      entityId: customer.id,
      summary: `Customer ${customer.name} registered`,
      actorType: "customer",
    }, tx);

    return customer;
  });
}

export async function authenticateCustomer(tenantId: string, email: string, password: string): Promise<Customer> {
  const normalized = normalizeEmail(email);
  const result = await withTenant(tenantId, async (tx) => {
    const [customer] = await tx.select().from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.email, normalized))).limit(1);

    const ok = customer
      && customer.status === "active"
      && (await verifyPassword(password, customer.passwordHash));
    if (!ok) return { customer: null, failedId: customer?.id ?? normalized };

    await recordAuditEvent(auditCtx(tenantId), {
      action: "customer.login",
      entityType: "customer",
      entityId: customer.id,
      summary: `Customer ${customer.name} signed in`,
      actorType: "customer",
    }, tx);
    return { customer, failedId: null };
  });

  if (!result.customer) {
    // Audited per D1 — failed customer logins are auth events too. Recorded in
    // its OWN transaction: throwing inside the check's tx would roll the audit
    // row back with it. Entity id is the email tried when no row exists.
    await withTenant(tenantId, (tx) => recordAuditEvent(auditCtx(tenantId), {
      action: "customer.login_failed",
      entityType: "customer",
      entityId: result.failedId!,
      summary: `Failed customer login for ${normalized}`,
      actorType: "customer",
    }, tx));
    throw new CustomerAuthError();
  }

  return result.customer;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Returns the RAW token for the cookie; only its sha256 touches the database. */
export async function createCustomerSession(
  tenantId: string,
  customerId: string,
  userAgent?: string,
  expiresAt?: Date,
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await withTenant(tenantId, (tx) => tx.insert(customerSessions).values({
    tenantId, customerId,
    tokenHash: sha256(token),
    userAgent: userAgent ?? null,
    expiresAt: expiresAt ?? new Date(Date.now() + SESSION_TTL_MS),
  }));
  return token;
}

export async function validateCustomerSession(
  tenantId: string,
  token: string,
): Promise<{ customer: Customer } | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.select({ customer: customers })
      .from(customerSessions)
      .innerJoin(customers, eq(customers.id, customerSessions.customerId))
      .where(and(
        eq(customerSessions.tenantId, tenantId),
        eq(customerSessions.tokenHash, sha256(token)),
        gt(customerSessions.expiresAt, new Date()),
      ))
      .limit(1);
    if (!row || row.customer.status !== "active") return null;
    return { customer: row.customer };
  });
}

export async function invalidateCustomerSession(tenantId: string, token: string): Promise<void> {
  await withTenant(tenantId, (tx) => tx.delete(customerSessions)
    .where(and(eq(customerSessions.tenantId, tenantId), eq(customerSessions.tokenHash, sha256(token)))));
}

/** The customer's own storefront orders, newest first — powering /account. */
export async function listCustomerOrders(tenantId: string, customerId: string, limit = 20) {
  const { orders } = await import("@/server/ordering/schema");
  const { desc } = await import("drizzle-orm");
  return withTenant(tenantId, (tx) =>
    tx.select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      total: orders.total,
      fulfillmentType: orders.fulfillmentType,
      placedAt: orders.placedAt,
      statusToken: orders.statusToken,
    }).from(orders)
      .where(and(eq(orders.tenantId, tenantId), eq(orders.customerId, customerId)))
      .orderBy(desc(orders.placedAt))
      .limit(limit));
}

export async function listCustomers(tenantId: string, limit = 100): Promise<Customer[]> {
  const { desc } = await import("drizzle-orm");
  return withTenant(tenantId, (tx) =>
    tx.select().from(customers).where(eq(customers.tenantId, tenantId))
      .orderBy(desc(customers.createdAt)).limit(limit));
}

/**
 * Staff-only trade-account toggle (decision T5) — there is no client-writable
 * path to either column; only this function, called from the dashboard action,
 * sets them. Revoking clears the percent so a later re-approval never
 * inherits a stale number.
 */
export async function setTradeApproval(
  tenantId: string,
  customerId: string,
  input: { approved: boolean; discountPercent?: number },
  audit?: AuditActorInput,
): Promise<Customer> {
  if (input.approved) {
    const pct = input.discountPercent ?? 0;
    if (!(pct >= 0 && pct <= 100)) throw new Error("Discount percent must be between 0 and 100");
  }

  return withTenant(tenantId, async (tx) => {
    const [updated] = await tx.update(customers)
      .set({
        tradeApproved: input.approved,
        tradeDiscountPercent: input.approved ? String(input.discountPercent ?? 0) : null,
      })
      .where(and(eq(customers.id, customerId), eq(customers.tenantId, tenantId)))
      .returning();
    if (!updated) throw new Error("Customer not found");

    await recordAuditEvent(
      { tenantId, actorUserId: audit?.actorUserId ?? null, fingerprint: audit?.fingerprint ?? emptyFingerprint() },
      {
        action: input.approved ? "customer.trade_approved" : "customer.trade_revoked",
        entityType: "customer",
        entityId: customerId,
        summary: input.approved
          ? `Trade account approved for ${updated.name} (${input.discountPercent ?? 0}% off)`
          : `Trade account revoked for ${updated.name}`,
        actorType: audit?.actorType ?? "user",
      },
      tx,
    );

    return updated;
  });
}
