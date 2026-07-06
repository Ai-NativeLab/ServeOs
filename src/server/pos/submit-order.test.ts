import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { users } from "@/server/auth/schema";
import { createBranch, updateBranchOrdering } from "@/server/branches/service";
import { createCategory, createProduct, updateProduct } from "@/server/catalog/service";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { createPairingCode, redeemPairingCode, resolveDevice } from "./service";
import { submitPosOrder } from "./submit-order";

let n = 0;

async function seedDeviceAndProduct() {
  const slug = `pos-submit-${n++}`;
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG" }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro");
  const branch = await createBranch(t.id, { name: "Main" });
  await updateBranchOrdering(t.id, branch.id, { acceptingOrders: true, openingHours: [] });
  const cat = await createCategory(t.id, { nameEn: "Pizza", nameAr: "بيتزا" });
  const prod = await createProduct(t.id, {
    nameEn: "Margherita",
    nameAr: "مارجريتا",
    basePrice: "100",
    categoryId: cat.id,
  });
  await updateProduct(t.id, prod.id, { isPublished: true });
  const [user] = await db.insert(users).values({ tenantId: t.id, name: "Owner" }).returning();
  const { code } = await createPairingCode(t.id, branch.id, "counter", user.id);
  const { deviceToken } = await redeemPairingCode(code);
  const device = await resolveDevice(deviceToken);
  return { device: { ...device!, createdByUserId: user.id }, productId: prod.id };
}

describe("submitPosOrder", () => {
  it("places a cash order and marks it paid", async () => {
    const { device, productId } = await seedDeviceAndProduct();
    const res = await submitPosOrder(device, {
      clientOrderId: "c-1",
      lines: [{ productId, quantity: 2, selectedOptionIds: [] }],
    });
    expect(res.orderNumber).toBeTruthy();
    expect(res.idempotent).toBe(false);
  });

  it("is idempotent on the same clientOrderId", async () => {
    const { device, productId } = await seedDeviceAndProduct();
    const a = await submitPosOrder(device, {
      clientOrderId: "dup",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
    });
    const b = await submitPosOrder(device, {
      clientOrderId: "dup",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
    });
    expect(b.idempotent).toBe(true);
    expect(b.orderId).toBe(a.orderId);
    expect(b.orderNumber).toBe(a.orderNumber);
  });
});
