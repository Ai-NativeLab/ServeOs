import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { users } from "@/server/auth/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { createBranch, updateBranchOrdering } from "@/server/branches/service";
import { createCategory, createProduct, updateProduct } from "@/server/catalog/service";
import { products } from "@/server/catalog/schema";
import { registerCustomer } from "@/server/customers/service";
import { submitPrescription, reviewPrescription } from "@/server/prescriptions/service";
import { placeOrder, transitionStatus } from "./service";
import { orders } from "./schema";
import { OrderValidationError, InvalidTransitionError } from "./errors";

async function seed(slug: string, opts: { rx?: boolean; vertical?: "pharmacy" | "retail" } = {}) {
  const [t] = await db.insert(tenants).values({
    slug, name: "T", country: "EG", vertical: opts.vertical ?? "pharmacy",
  }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro");
  const branch = await createBranch(t.id, { name: "Main" });
  await updateBranchOrdering(t.id, branch.id, { acceptingOrders: true });
  const cat = await createCategory(t.id, { nameEn: "Meds", nameAr: "أدوية" });
  const prod = await createProduct(t.id, { nameEn: "Amoxil", nameAr: "أموكسيل", basePrice: "100.00", categoryId: cat.id });
  if (opts.rx) {
    await withTenant(t.id, (tx) => tx.update(products).set({ requiresPrescription: true }).where(eq(products.id, prod.id)));
  }
  await updateProduct(t.id, prod.id, { isPublished: true });
  const [staff] = await db.insert(users).values({ tenantId: t.id, name: "Rx", email: `rx-${slug}@x.com`, status: "active" }).returning();
  return { tenantId: t.id, branchId: branch.id, productId: prod.id, staffId: staff.id };
}

const line = (productId: string) => [{ productId, quantity: 1, selectedOptionIds: [] }];
const audit = (userId: string) => ({
  actorUserId: userId,
  fingerprint: { deviceId: null, deviceTokenHash: null, appVersion: null, ip: null, userAgent: null },
});

describe("Rx order gate", () => {
  it("refuses an Rx order placed as a guest — a script needs an owner (decision R3)", async () => {
    const { tenantId, branchId, productId } = await seed("rxg-1", { rx: true });
    await expect(placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "G", customerPhone: "+2011",
      lines: line(productId),
    })).rejects.toThrow(OrderValidationError);
  });

  it("refuses an Rx order from a signed-in customer with no prescription on file", async () => {
    const { tenantId, branchId, productId } = await seed("rxg-2", { rx: true });
    const me = await registerCustomer(tenantId, { name: "P", email: "p@x.com", password: "secret123" });
    await expect(placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "P", customerPhone: "+2011",
      customerId: me.id, lines: line(productId),
    })).rejects.toThrow(OrderValidationError);
  });

  it("accepts an Rx order with a pending script, marks it awaiting review, and links the script", async () => {
    const { tenantId, branchId, productId } = await seed("rxg-3", { rx: true });
    const me = await registerCustomer(tenantId, { name: "P", email: "p@x.com", password: "secret123" });
    const rx = await submitPrescription(tenantId, me.id, "rx/3.jpg");

    const res = await placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "P", customerPhone: "+2011",
      customerId: me.id, lines: line(productId),
    });

    const [order] = await withTenant(tenantId, (tx) => tx.select().from(orders).where(eq(orders.id, res.orderId)));
    expect(order.rxReviewStatus).toBe("pending");
    const { prescriptions } = await import("@/server/prescriptions/schema");
    const [linked] = await withTenant(tenantId, (tx) =>
      tx.select().from(prescriptions).where(eq(prescriptions.id, rx.id)));
    expect(linked.orderId).toBe(res.orderId);
  });

  it("blocks confirmation until a pharmacist approves, then allows it", async () => {
    const { tenantId, branchId, productId, staffId } = await seed("rxg-4", { rx: true });
    const me = await registerCustomer(tenantId, { name: "P", email: "p@x.com", password: "secret123" });
    const rx = await submitPrescription(tenantId, me.id, "rx/4.jpg");
    const res = await placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "P", customerPhone: "+2011",
      customerId: me.id, lines: line(productId),
    });

    // Un-reviewed: the kitchen/counter cannot start on it.
    await expect(transitionStatus(tenantId, res.orderId, "confirmed", staffId))
      .rejects.toThrow(InvalidTransitionError);

    await reviewPrescription(tenantId, rx.id, { approved: true }, audit(staffId));
    const confirmed = await transitionStatus(tenantId, res.orderId, "confirmed", staffId);
    expect(confirmed.status).toBe("confirmed");
  });

  it("an OTC-only guest order is provably unaffected (regression)", async () => {
    const { tenantId, branchId, productId, staffId } = await seed("rxg-5"); // not Rx
    const res = await placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "G", customerPhone: "+2011",
      lines: line(productId),
    });
    const [order] = await withTenant(tenantId, (tx) => tx.select().from(orders).where(eq(orders.id, res.orderId)));
    expect(order.rxReviewStatus).toBe("not_required");
    const confirmed = await transitionStatus(tenantId, res.orderId, "confirmed", staffId);
    expect(confirmed.status).toBe("confirmed");
  });

  it("a retail tenant is untouched even if a product carries the flag (capability-gated)", async () => {
    const { tenantId, branchId, productId } = await seed("rxg-6", { rx: true, vertical: "retail" });
    // No pharmacistReview capability -> no gate, no account requirement.
    const res = await placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "G", customerPhone: "+2011",
      lines: line(productId),
    });
    const [order] = await withTenant(tenantId, (tx) => tx.select().from(orders).where(eq(orders.id, res.orderId)));
    expect(order.rxReviewStatus).toBe("not_required");
  });
});
