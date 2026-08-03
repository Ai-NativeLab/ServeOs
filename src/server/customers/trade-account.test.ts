import { describe, it, expect } from "vitest";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { db } from "@/db/client";
import { auditEvents } from "@/server/audit/schema";
import { eq } from "drizzle-orm";
import { registerCustomer, setTradeApproval, listCustomers } from "./service";

async function seed(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG", vertical: "timber" }).returning();
  return t.id;
}

describe("setTradeApproval", () => {
  it("approves a customer with a discount percent and audits it", async () => {
    const tenantId = await seed("trade-svc-1");
    const c = await registerCustomer(tenantId, { name: "Yard Co", email: "y@x.com", password: "secret123" });

    const updated = await setTradeApproval(tenantId, c.id, { approved: true, discountPercent: 12 });
    expect(updated.tradeApproved).toBe(true);
    expect(Number(updated.tradeDiscountPercent)).toBe(12);

    const audits = await withTenant(tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, "customer.trade_approved")));
    expect(audits).toHaveLength(1);
  });

  it("revokes approval, clearing the discount", async () => {
    const tenantId = await seed("trade-svc-2");
    const c = await registerCustomer(tenantId, { name: "Yard Co", email: "y@x.com", password: "secret123" });
    await setTradeApproval(tenantId, c.id, { approved: true, discountPercent: 10 });

    const revoked = await setTradeApproval(tenantId, c.id, { approved: false });
    expect(revoked.tradeApproved).toBe(false);
    expect(revoked.tradeDiscountPercent).toBeNull();
  });

  it("rejects an out-of-range discount percent", async () => {
    const tenantId = await seed("trade-svc-3");
    const c = await registerCustomer(tenantId, { name: "Y", email: "y@x.com", password: "secret123" });
    await expect(setTradeApproval(tenantId, c.id, { approved: true, discountPercent: 150 })).rejects.toThrow();
    await expect(setTradeApproval(tenantId, c.id, { approved: true, discountPercent: -5 })).rejects.toThrow();
  });
});

describe("listCustomers", () => {
  it("lists this tenant's customers only, newest first", async () => {
    const a = await seed("trade-svc-4");
    const b = await seed("trade-svc-5");
    await registerCustomer(a, { name: "First", email: "f@x.com", password: "secret123" });
    await registerCustomer(a, { name: "Second", email: "s@x.com", password: "secret123" });
    await registerCustomer(b, { name: "Other", email: "o@x.com", password: "secret123" });

    const rows = await listCustomers(a);
    expect(rows.map((r) => r.name)).toEqual(["Second", "First"]);
  });
});
