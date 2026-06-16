import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { createBranch, updateBranchOrdering, createDeliveryArea, listDeliveryAreas, updateDeliveryArea, deleteDeliveryArea } from "./service";

async function makeTenant(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG" }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "basic");
  return t;
}

describe("branches fulfillment config", () => {
  it("updateBranchOrdering sets toggle + hours", async () => {
    const t = await makeTenant("f1");
    const b = await createBranch(t.id, { name: "Main" });
    const updated = await updateBranchOrdering(t.id, b.id, {
      acceptingOrders: false,
      openingHours: [{ day: 2, open: "10:00", close: "23:00", closed: false }],
    });
    expect(updated.acceptingOrders).toBe(false);
    expect(updated.openingHours).toHaveLength(1);
  });

  it("delivery areas CRUD within a branch", async () => {
    const t = await makeTenant("f2");
    const b = await createBranch(t.id, { name: "Main" });
    const a = await createDeliveryArea(t.id, b.id, { nameEn: "Maadi", nameAr: "المعادي", deliveryFee: "25", minOrderAmount: "100", etaMinutes: 35 });
    expect(a.nameEn).toBe("Maadi");
    let list = await listDeliveryAreas(t.id, b.id);
    expect(list).toHaveLength(1);
    await updateDeliveryArea(t.id, a.id, { deliveryFee: "30" });
    await deleteDeliveryArea(t.id, a.id);
    list = await listDeliveryAreas(t.id, b.id);
    expect(list).toHaveLength(0);
  });

  it("RLS: tenant B cannot see tenant A delivery areas", async () => {
    const a = await makeTenant("f-a");
    const b = await makeTenant("f-b");
    const br = await createBranch(a.id, { name: "A" });
    await createDeliveryArea(a.id, br.id, { nameEn: "X", nameAr: "س", deliveryFee: "10", minOrderAmount: "0" });
    expect(await listDeliveryAreas(b.id, br.id)).toHaveLength(0);
  });
});
