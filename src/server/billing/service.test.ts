import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { ManualBillingProvider } from "./manual-provider";
import { listInvoicesForTenant } from "./service";

describe("listInvoicesForTenant", () => {
  it("returns invoices for a tenant, newest first", async () => {
    const [t] = await db.insert(tenants).values({ slug: "bill-1", name: "T", country: "EG" }).returning();
    await seedDefaultPlans();
    const sub = await startTrial(t.id, "basic");
    const provider = new ManualBillingProvider();
    const first = await provider.createInvoice({ tenantId: t.id, subscriptionId: sub.id, amount: "100", currency: "EGP" });
    // Settle the first invoice before opening a second one — a tenant can have
    // at most one outstanding (open/pending_verification) invoice at a time,
    // enforced by the invoices_one_outstanding_per_tenant partial unique index.
    await provider.settleInvoice(first.id, "manual");
    await new Promise((r) => setTimeout(r, 10));
    const second = await provider.createInvoice({ tenantId: t.id, subscriptionId: sub.id, amount: "200", currency: "EGP" });

    const invoices = await listInvoicesForTenant(t.id);
    expect(invoices.map((i) => i.id)).toEqual([second.id, first.id]);
  });

  it("returns an empty array for a tenant with no invoices", async () => {
    const [t] = await db.insert(tenants).values({ slug: "bill-2", name: "T", country: "EG" }).returning();
    expect(await listInvoicesForTenant(t.id)).toEqual([]);
  });
});
