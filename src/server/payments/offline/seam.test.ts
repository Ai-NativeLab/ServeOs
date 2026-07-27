import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { createBranch, updateBranchOrdering } from "@/server/branches/service";
import { createCategory, createProduct, updateProduct } from "@/server/catalog/service";
import { upsertOfflineMethod } from "@/server/payments/offline/methods";
import { PaymentAlreadyResolvedError } from "@/server/payments/offline";
import { placeOrder, confirmOrderPayment, getOrder } from "@/server/ordering/service";

/**
 * Seam proof (spec §3, §11): confirmOrderPayment (src/server/ordering/service.ts)
 * is the ONE place a manual offline payment ever gets marked "paid" — the human
 * dashboard action (src/app/dashboard/payments/actions.ts's
 * confirmOrderPaymentAction) calls it directly with the signed-in user's id:
 *
 *   await confirmOrderPayment(tenantId, orderId, user.id);
 *
 * A future Paymob/Level-Sync webhook handler is not built yet (reserved seam —
 * see the provider columns on orders/invoices from Task 2), but when it lands it
 * will do its own provider-specific work (HMAC/signature verification, mapping
 * the provider's transaction id to our orderId) and then land on this exact same
 * call — not a parallel "provider confirm" code path. That's what this test
 * proves: a stand-in "provider" wrapper that calls nothing but
 * confirmOrderPayment reaches paymentStatus "paid" from a real
 * pending_verification order, and is guarded by the identical idempotency rule
 * (PaymentAlreadyResolvedError on a second call) that protects the human path
 * today (see place-order.test.ts's "confirms an offline order payment → paid,
 * idempotently"). If someone later special-cased providers with a second
 * "confirm" implementation, this test would still pass, but a review diff would
 * make that split obvious — the real guard against drift is that there is only
 * one exported confirm* function in ordering/service.ts for providers or humans
 * to call.
 */
async function setup(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG" }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro");
  const branch = await createBranch(t.id, { name: "Main" });
  await updateBranchOrdering(t.id, branch.id, { acceptingOrders: true, openingHours: [] });
  const cat = await createCategory(t.id, { nameEn: "Pizza", nameAr: "بيتزا" });
  const pizza = await createProduct(t.id, { nameEn: "Margherita", nameAr: "مارجريتا", basePrice: "100", categoryId: cat.id });
  await updateProduct(t.id, pizza.id, { isPublished: true });
  return { t, branch, pizza };
}

/** Stand-in for a future Paymob/LS webhook handler: whatever provider-specific
 * verification it does happens before this line, then it calls the exact same
 * seam a human dashboard click calls — no provider-only bypass. The
 * "0000...aa" id is a stand-in for a system/provider actor, distinct from the
 * human `user.id` the dashboard action passes, to show the seam doesn't care
 * who the caller is. */
const PROVIDER_SYSTEM_USER_ID = "00000000-0000-0000-0000-0000000000aa";
async function providerWebhookConfirm(tenantId: string, orderId: string) {
  return confirmOrderPayment(tenantId, orderId, PROVIDER_SYSTEM_USER_ID);
}

describe("confirm-seam is provider-agnostic", () => {
  it("a fake provider callback reaches paymentStatus=paid via the identical confirm seam a human dashboard confirm uses, guarded by the same idempotency rule", async () => {
    const { t, branch, pizza } = await setup("seam1");
    await upsertOfflineMethod(t.id, { type: "instapay", label: "InstaPay", payToDetail: "a@instapay" });

    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      paymentMethod: "instapay", paymentReference: "IP-SEAM-1",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });

    // Precondition: a real order sitting in pending_verification, exactly what
    // a merchant sees in /dashboard/payments today and what a provider webhook
    // would need to resolve tomorrow.
    expect((await getOrder(t.id, res.orderId)).paymentStatus).toBe("pending_verification");

    const confirmed = await providerWebhookConfirm(t.id, res.orderId);
    expect(confirmed.paymentStatus).toBe("paid");

    // Same guard the human path relies on (place-order.test.ts) rejects a
    // second callback identically — a duplicate webhook delivery is exactly
    // as safe as a merchant double-clicking "Confirm".
    await expect(providerWebhookConfirm(t.id, res.orderId)).rejects.toThrow(PaymentAlreadyResolvedError);
  });
});
