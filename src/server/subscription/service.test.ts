import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "./plans.seed";
import { startTrial, transition, getActiveSubscription, listPlans } from "./service";

async function tenant() {
  const [t] = await db.insert(tenants).values({ slug: "t", name: "T", country: "EG" }).returning();
  return t;
}

describe("subscription service", () => {
  it("starts a 14-day trial on the basic plan", async () => {
    await seedDefaultPlans();
    const t = await tenant();
    const sub = await startTrial(t.id, "basic");
    expect(sub.status).toBe("trialing");
    expect(sub.trialEndsAt).toBeInstanceOf(Date);
  });

  it("allows trialing -> active but rejects active -> trialing", async () => {
    await seedDefaultPlans();
    const t = await tenant();
    const sub = await startTrial(t.id, "basic");
    const active = await transition(sub.id, "active");
    expect(active.status).toBe("active");
    await expect(transition(sub.id, "trialing")).rejects.toThrow(/invalid transition/i);
  });

  it("returns the active subscription for a tenant", async () => {
    await seedDefaultPlans();
    const t = await tenant();
    await startTrial(t.id, "basic");
    expect((await getActiveSubscription(t.id))?.tenantId).toBe(t.id);
  });

  it("listPlans returns all seeded plans ordered by price", async () => {
    await seedDefaultPlans();
    const all = await listPlans();
    expect(all.map((p) => p.key)).toEqual(["basic", "pro", "enterprise"]);
  });
});
