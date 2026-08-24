import { describe, it, expect, vi } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { users, userRoles } from "@/server/auth/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { createBranch, updateBranchOrdering } from "@/server/branches/service";
import { createCategory, createProduct, updateProduct } from "@/server/catalog/service";
import { placeOrder, transitionStatus, getOrder } from "@/server/ordering/service";
import { upsertOfflineMethod } from "@/server/payments/offline/methods";
import { confirmOrderPaymentAction, rejectOrderPaymentAction } from "./actions";

// Mock requireDashboardUser to return our test user and tenant
let currentMockUser: { tenantId: string; user: { id: string }; roleKeys: string[] } | null = null;

vi.mock("@/server/auth/dashboard-context", () => ({
  requireDashboardUser: async () => {
    if (!currentMockUser) throw new Error("No mock user set");
    return currentMockUser;
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

async function seed(slug: string) {
  const [t] = await db.insert(tenants).values({
    slug, name: "Pay Test", country: "EG", vertical: "restaurant",
  }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro");
  const branch = await createBranch(t.id, { name: "Main" });
  await updateBranchOrdering(t.id, branch.id, { acceptingOrders: true });
  await upsertOfflineMethod(t.id, { type: "vodafone_cash", label: "Vodafone Cash", enabled: true, payToDetail: "01000000000" });
  const cat = await createCategory(t.id, { nameEn: "Food", nameAr: "طعام" });
  const prod = await createProduct(t.id, { nameEn: "Pizza", nameAr: "بيتزا", basePrice: "100.00", categoryId: cat.id });
  await updateProduct(t.id, prod.id, { isPublished: true });
  const [staff] = await db.insert(users).values({ tenantId: t.id, name: "Staff", email: `staff-${slug}@test.com`, status: "active" }).returning();

  return { tenantId: t.id, branchId: branch.id, productId: prod.id, userId: staff.id };
}

describe("payments actions error handling (Issue #171)", () => {
  it("rejectOrderPaymentAction returns domain error object instead of throwing when order is completed", async () => {
    const { tenantId, branchId, productId, userId } = await seed("act-1");
    currentMockUser = { tenantId, user: { id: userId }, roleKeys: ["owner"] };

    const res = await placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "Test", customerPhone: "+2010",
      paymentMethod: "vodafone_cash", paymentReference: "VF-12345",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
    });

    // Advance order to completed
    await transitionStatus(tenantId, res.orderId, "confirmed", userId);
    await transitionStatus(tenantId, res.orderId, "preparing", userId);
    await transitionStatus(tenantId, res.orderId, "ready", userId);
    await transitionStatus(tenantId, res.orderId, "completed", userId);

    const fd = new FormData();
    fd.append("reason", "no transfer found");

    // Must NOT throw; must return error object for ToastForm
    const actionResult = await rejectOrderPaymentAction(res.orderId, fd);
    expect(actionResult).toBeDefined();
    expect(actionResult?.error).toBeDefined();
    expect(typeof actionResult?.error).toBe("string");
    expect(actionResult?.error.length).toBeGreaterThan(0);

    const order = await getOrder(tenantId, res.orderId);
    expect(order?.status).toBe("completed");
    expect(order?.paymentStatus).toBe("pending_verification");
  });

  it("confirmOrderPaymentAction succeeds on pending payment and updates paymentStatus", async () => {
    const { tenantId, branchId, productId, userId } = await seed("act-2");
    currentMockUser = { tenantId, user: { id: userId }, roleKeys: ["owner"] };

    const res = await placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup", customerName: "Test", customerPhone: "+2010",
      paymentMethod: "vodafone_cash", paymentReference: "VF-12345",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
    });

    const actionResult = await confirmOrderPaymentAction(res.orderId);
    expect(actionResult).toBeUndefined();

    const order = await getOrder(tenantId, res.orderId);
    expect(order?.paymentStatus).toBe("paid");
  });
});
