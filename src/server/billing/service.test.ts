import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { users } from "@/server/auth/schema";
import { plans } from "@/server/subscription/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { getPlanForTenant, startTrial } from "@/server/subscription/service";
import { PaymentAlreadyResolvedError } from "@/server/payments/offline";
import { ManualBillingProvider } from "./manual-provider";
import {
  confirmInvoice,
  createPlanInvoice,
  listInvoicesForTenant,
  listInvoicesNeedingAction,
  listInvoicesPendingVerification,
  rejectInvoice,
  submitInvoiceProof,
} from "./service";

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

describe("listInvoicesNeedingAction", () => {
  // The queue a human works from. `open` used to be invisible here, which was
  // survivable while a tenant could self-serve — and is not, now that a rep
  // closing the sale by phone IS the flow.
  it("includes plan requests as well as submitted payments", async () => {
    const [t1] = await db.insert(tenants).values({ slug: "act-1", name: "Asks Only", country: "EG" }).returning();
    const [t2] = await db.insert(tenants).values({ slug: "act-2", name: "Says Paid", country: "EG" }).returning();
    await seedDefaultPlans();
    const sub1 = await startTrial(t1.id, "basic");
    const sub2 = await startTrial(t2.id, "basic");
    const provider = new ManualBillingProvider();

    const open = await provider.createInvoice({ tenantId: t1.id, subscriptionId: sub1.id, amount: "499", currency: "EGP" });
    const claimed = await provider.createInvoice({ tenantId: t2.id, subscriptionId: sub2.id, amount: "699", currency: "EGP" });
    await submitInvoiceProof(t2.id, claimed.id, { reference: "REF", screenshotUrl: null });

    const rows = await listInvoicesNeedingAction();
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(open.id)?.status).toBe("open");
    expect(byId.get(claimed.id)?.status).toBe("pending_verification");
  });

  it("drops an invoice once it is resolved", async () => {
    const [t] = await db.insert(tenants).values({ slug: "act-3", name: "Done", country: "EG" }).returning();
    await seedDefaultPlans();
    const sub = await startTrial(t.id, "basic");
    const provider = new ManualBillingProvider();
    const inv = await provider.createInvoice({ tenantId: t.id, subscriptionId: sub.id, amount: "499", currency: "EGP" });

    await provider.settleInvoice(inv.id, "manual");

    expect((await listInvoicesNeedingAction()).map((r) => r.id)).not.toContain(inv.id);
  });
});

describe("confirmInvoice on a plan request", () => {
  async function planInvoice(slug: string) {
    const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG" }).returning();
    await seedDefaultPlans();
    await startTrial(t.id, "basic");
    const [target] = await db.select().from(plans).where(eq(plans.key, "pro")).limit(1);
    const inv = await createPlanInvoice(t.id, target.id);
    const [admin] = await db.insert(users).values({ tenantId: null, name: "Admin", email: `${slug}@serveos.com` }).returning();
    return { t, target, inv, admin };
  }

  // A rep takes payment on the phone, so the invoice never passes through the
  // proof step. Guarding confirm on pending_verification would strand it.
  it("activates the plan straight from open, without a proof step", async () => {
    const { t, target, inv, admin } = await planInvoice("conf-1");

    const confirmed = await confirmInvoice(t.id, inv.id, admin.id);

    expect(confirmed.status).toBe("paid");
    // The point of the whole flow: the subscription actually moves onto the
    // requested plan, off the trial's basic.
    expect((await getPlanForTenant(t.id))?.key).toBe(target.key);
    expect(target.key).toBe("pro");
  });

  it("refuses a second confirm, so two admins clicking cannot double-activate", async () => {
    const { t, inv, admin } = await planInvoice("conf-2");
    await confirmInvoice(t.id, inv.id, admin.id);

    await expect(confirmInvoice(t.id, inv.id, admin.id)).rejects.toThrow(PaymentAlreadyResolvedError);
  });

  // Voiding clears the partial unique index, so a dead request does not block
  // the tenant from ever asking again.
  it("lets the tenant ask again after a request is dropped", async () => {
    const { t, target, inv } = await planInvoice("conf-3");

    await rejectInvoice(t.id, inv.id);

    const second = await createPlanInvoice(t.id, target.id);
    expect(second.status).toBe("open");
  });
});
