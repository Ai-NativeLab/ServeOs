import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { auditEvents } from "@/server/audit/schema";
import { customers } from "./schema";
import {
  registerCustomer, authenticateCustomer,
  createCustomerSession, validateCustomerSession, invalidateCustomerSession,
  CustomerAuthError,
} from "./service";

async function seed(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG", vertical: "restaurant" }).returning();
  return t.id;
}

describe("customer auth", () => {
  it("register → login round-trip, with audit rows as actorType customer", async () => {
    const tenantId = await seed("ca-1");
    const created = await registerCustomer(tenantId, {
      name: "Ahmed", email: "Ahmed@X.com", password: "secret123", phone: "+2011",
    });
    expect(created.email).toBe("ahmed@x.com"); // stored lowercased

    const ok = await authenticateCustomer(tenantId, "AHMED@x.com", "secret123");
    expect(ok.id).toBe(created.id);

    const audits = await withTenant(tenantId, (tx) => tx.select().from(auditEvents));
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("customer.registered");
    expect(actions).toContain("customer.login");
    expect(audits.every((a) => a.actorType === "customer")).toBe(true);
  });

  it("wrong password and unknown email fail with the SAME generic error, and the failure is audited", async () => {
    const tenantId = await seed("ca-2");
    await registerCustomer(tenantId, { name: "A", email: "a@x.com", password: "secret123" });

    const wrongPw = await authenticateCustomer(tenantId, "a@x.com", "nope-nope").catch((e) => e);
    const unknown = await authenticateCustomer(tenantId, "ghost@x.com", "whatever").catch((e) => e);
    expect(wrongPw).toBeInstanceOf(CustomerAuthError);
    expect(unknown).toBeInstanceOf(CustomerAuthError);
    expect(wrongPw.message).toBe(unknown.message); // no account-existence oracle

    const audits = await withTenant(tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, "customer.login_failed")));
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it("a disabled customer cannot log in", async () => {
    const tenantId = await seed("ca-3");
    const c = await registerCustomer(tenantId, { name: "A", email: "a@x.com", password: "secret123" });
    await withTenant(tenantId, (tx) => tx.update(customers).set({ status: "disabled" }).where(eq(customers.id, c.id)));
    await expect(authenticateCustomer(tenantId, "a@x.com", "secret123")).rejects.toThrow(CustomerAuthError);
  });

  it("refuses a duplicate registration at the same shop with a friendly error", async () => {
    const tenantId = await seed("ca-4");
    await registerCustomer(tenantId, { name: "A", email: "a@x.com", password: "secret123" });
    await expect(registerCustomer(tenantId, { name: "A2", email: "A@X.com", password: "other456" }))
      .rejects.toThrow(/already/i);
  });
});

describe("customer sessions", () => {
  it("creates, validates, and invalidates — and the raw token is never stored", async () => {
    const tenantId = await seed("ca-5");
    const c = await registerCustomer(tenantId, { name: "A", email: "a@x.com", password: "secret123" });

    const token = await createCustomerSession(tenantId, c.id, "vitest");
    expect(token.length).toBeGreaterThan(30);

    const valid = await validateCustomerSession(tenantId, token);
    expect(valid?.customer.id).toBe(c.id);

    // The DB carries a hash, not the token.
    const { customerSessions } = await import("./schema");
    const [row] = await withTenant(tenantId, (tx) => tx.select().from(customerSessions));
    expect(row.tokenHash).not.toBe(token);

    await invalidateCustomerSession(tenantId, token);
    expect(await validateCustomerSession(tenantId, token)).toBeNull();
  });

  it("rejects an expired session and a token presented at the wrong tenant", async () => {
    const a = await seed("ca-6");
    const b = await seed("ca-7");
    const c = await registerCustomer(a, { name: "A", email: "a@x.com", password: "secret123" });
    const token = await createCustomerSession(a, c.id, undefined, new Date(Date.now() - 1000));
    expect(await validateCustomerSession(a, token)).toBeNull(); // expired
    const fresh = await createCustomerSession(a, c.id);
    expect(await validateCustomerSession(b, fresh)).toBeNull(); // wrong shop
  });
});
