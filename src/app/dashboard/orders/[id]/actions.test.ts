import { describe, it, expect, vi } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { users } from "@/server/auth/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { createBranch, updateBranchOrdering } from "@/server/branches/service";
import { createCategory, createProduct, updateProduct } from "@/server/catalog/service";
import { placeOrder, transitionStatus, getOrder } from "@/server/ordering/service";
import { upsertOfflineMethod } from "@/server/payments/offline/methods";
import { transitionOrderAction } from "./actions";

// #187 C5 regression pin: the server-side #165 gate is tested elsewhere — THIS
// file pins that the ACTION converts the domain throw into `{error}` for
// ToastForm. Deleting the try/catch in actions.ts reintroduces the production
// crash toast while every service-level test stays green.

let currentMockUser: { tenantId: string; user: { id: string } } | null = null;

vi.mock("../../orders-permission", () => ({
  requireOrdersPermission: async () => {
    if (!currentMockUser) throw new Error("No mock user set");
    return currentMockUser;
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "vitest" }),
}));

async function seed(slug: string) {
  const [t] = await db.insert(tenants).values({
    slug, name: "C5 Test", country: "EG", vertical: "restaurant",
  }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro");
  const branch = await createBranch(t.id, { name: "Main" });
  await updateBranchOrdering(t.id, branch.id, { acceptingOrders: true, openingHours: [] });
  await upsertOfflineMethod(t.id, { type: "vodafone_cash", label: "Vodafone Cash", enabled: true, payToDetail: "01000000000" });
  const cat = await createCategory(t.id, { nameEn: "Food", nameAr: "طعام" });
  const prod = await createProduct(t.id, { nameEn: "Pizza", nameAr: "بيتزا", basePrice: "100.00", categoryId: cat.id });
  await updateProduct(t.id, prod.id, { isPublished: true });
  const [staff] = await db.insert(users).values({ tenantId: t.id, name: "Staff", email: `staff-${slug}@test.com`, status: "active" }).returning();
  return { tenantId: t.id, branchId: branch.id, productId: prod.id, userId: staff.id };
}

describe("transitionOrderAction refusal shape (#187 C5)", () => {
  it("returns the #165 refusal as {error}, leaves the order untouched, and still allows cancel", async () => {
    const { tenantId, branchId, productId, userId } = await seed("c5-act");
    currentMockUser = { tenantId, user: { id: userId } };

    const res = await placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "T", customerPhone: "01012345678",
      paymentMethod: "vodafone_cash", paymentReference: "VF-999",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
    });
    await transitionStatus(tenantId, res.orderId, "confirmed", userId);
    await transitionStatus(tenantId, res.orderId, "preparing", userId);

    const blocked = await transitionOrderAction(res.orderId, "ready");
    expect(blocked).toEqual({ error: expect.stringMatching(/payment unverified/i) });
    expect((await getOrder(tenantId, res.orderId)).status).toBe("preparing");

    // The refusal must not trap the ticket: cancel stays open through the action.
    const cancelled = await transitionOrderAction(res.orderId, "cancelled", "unverified payment");
    expect(cancelled).toBeUndefined();
    expect((await getOrder(tenantId, res.orderId)).status).toBe("cancelled");
  });

  it("returns other domain refusals as {error} too — an unknown order is not a crash", async () => {
    const { tenantId, userId } = await seed("c5-nf");
    currentMockUser = { tenantId, user: { id: userId } };

    const result = await transitionOrderAction("00000000-0000-0000-0000-000000000000", "confirmed");
    expect(result).toEqual({ error: expect.stringMatching(/not found/i) });
  });
});
