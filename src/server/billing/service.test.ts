import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { ManualBillingProvider } from "./manual-provider";
import { listInvoicesForTenant, listInvoicesPendingVerification, submitInvoiceProof } from "./service";

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

describe("listInvoicesPendingVerification", () => {
  it("returns only pending_verification invoices, joined with tenant name, newest first", async () => {
    const [t1] = await db.insert(tenants).values({ slug: "bill-3", name: "Alpha Eats", country: "EG" }).returning();
    const [t2] = await db.insert(tenants).values({ slug: "bill-4", name: "Beta Bites", country: "EG" }).returning();
    const [t3] = await db.insert(tenants).values({ slug: "bill-5", name: "Gamma Grill", country: "EG" }).returning();
    await seedDefaultPlans();
    const sub1 = await startTrial(t1.id, "basic");
    const sub2 = await startTrial(t2.id, "basic");
    const sub3 = await startTrial(t3.id, "basic");
    const provider = new ManualBillingProvider();

    // t1: open (never submitted) → should be excluded.
    await provider.createInvoice({ tenantId: t1.id, subscriptionId: sub1.id, amount: "100", currency: "EGP" });

    // t2: submitted proof → pending_verification → included (older).
    const inv2 = await provider.createInvoice({ tenantId: t2.id, subscriptionId: sub2.id, amount: "200", currency: "EGP" });
    await submitInvoiceProof(t2.id, inv2.id, { reference: "REF-2", screenshotUrl: null });
    await new Promise((r) => setTimeout(r, 10));

    // t3: submitted proof → pending_verification → included (newer).
    const inv3 = await provider.createInvoice({ tenantId: t3.id, subscriptionId: sub3.id, amount: "300", currency: "EGP" });
    await submitInvoiceProof(t3.id, inv3.id, { reference: "REF-3", screenshotUrl: null });

    const pending = await listInvoicesPendingVerification();
    expect(pending.map((i) => i.id)).toEqual([inv3.id, inv2.id]);
    expect(pending.find((i) => i.id === inv3.id)?.tenantName).toBe("Gamma Grill");
    expect(pending.find((i) => i.id === inv2.id)?.tenantName).toBe("Beta Bites");
  });
});
