import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { eq } from "drizzle-orm";
import { tenants } from "@/server/tenancy/schema";
import { users } from "@/server/auth/schema";
import { plans, subscriptions } from "@/server/subscription/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { createPlanInvoice, submitInvoiceProof, confirmInvoice } from "./service";
import { OutstandingInvoiceExistsError } from "./errors";
import { InvalidProofError } from "@/server/payments/offline";

// invoices.marked_by is FK-enforced against users.id (see platform/service.test.ts
// for the same pattern), so admin actions in tests need a real user row.
async function adminUser() {
  const [a] = await db.insert(users).values({ tenantId: null, name: "Root", email: `root-${crypto.randomUUID()}@serveos.com` }).returning();
  return a;
}

async function setup(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG" }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "basic");
  const [pro] = await db.select().from(plans).where(eq(plans.key, "pro")).limit(1);
  return { t, pro };
}

describe("manual subscription billing", () => {
  it("create invoice → submit proof → confirm → subscription active on the plan", async () => {
    const { t, pro } = await setup("msub1");
    const inv = await createPlanInvoice(t.id, pro.id);
    expect(inv.status).toBe("open");
    expect(inv.amount).toBe(Number(pro.priceMonthly).toFixed(2));
    const pending = await submitInvoiceProof(t.id, inv.id, { reference: "INSTA-777", screenshotUrl: null });
    expect(pending.status).toBe("pending_verification");
    const admin = await adminUser();
    const paid = await confirmInvoice(t.id, inv.id, admin.id);
    expect(paid.status).toBe("paid");
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.tenantId, t.id)).limit(1);
    expect(sub.status).toBe("active");
    expect(sub.planId).toBe(pro.id);
    expect(sub.currentPeriodEnd).toBeTruthy();
  });

  it("double-confirm is rejected", async () => {
    const { t, pro } = await setup("msub2");
    const inv = await createPlanInvoice(t.id, pro.id);
    await submitInvoiceProof(t.id, inv.id, { reference: "X", screenshotUrl: null });
    const admin = await adminUser();
    await confirmInvoice(t.id, inv.id, admin.id);
    const { PaymentAlreadyResolvedError } = await import("@/server/payments/offline");
    await expect(confirmInvoice(t.id, inv.id, admin.id))
      .rejects.toThrow(PaymentAlreadyResolvedError);
  });

  it("creating a second plan invoice while one is already open is rejected by the DB backstop", async () => {
    const { t, pro } = await setup("msub3");
    await createPlanInvoice(t.id, pro.id);
    await expect(createPlanInvoice(t.id, pro.id)).rejects.toThrow(OutstandingInvoiceExistsError);
  });

  it("submitInvoiceProof rejects empty proof and accepts a reference", async () => {
    const { t, pro } = await setup("msub4");
    const inv = await createPlanInvoice(t.id, pro.id);
    await expect(submitInvoiceProof(t.id, inv.id, { reference: null, screenshotUrl: null }))
      .rejects.toThrow(InvalidProofError);
    const pending = await submitInvoiceProof(t.id, inv.id, { reference: "REF-1", screenshotUrl: null });
    expect(pending.status).toBe("pending_verification");
  });

  it("submitInvoiceProof sanitizes a javascript: screenshotUrl to null and treats it as no proof", async () => {
    const { t, pro } = await setup("msub5");
    const inv = await createPlanInvoice(t.id, pro.id);
    await expect(submitInvoiceProof(t.id, inv.id, { reference: null, screenshotUrl: "javascript:alert(1)" }))
      .rejects.toThrow(InvalidProofError);
  });

  it("submitInvoiceProof accepts and stores a well-formed http(s) screenshotUrl", async () => {
    const { t, pro } = await setup("msub6");
    const inv = await createPlanInvoice(t.id, pro.id);
    const pending = await submitInvoiceProof(t.id, inv.id, { reference: null, screenshotUrl: "https://x/y.png" });
    expect(pending.status).toBe("pending_verification");
    expect(pending.paymentProofUrl).toBe("https://x/y.png");
  });
});
