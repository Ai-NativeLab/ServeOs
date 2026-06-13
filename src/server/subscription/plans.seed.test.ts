import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { plans } from "./schema";
import { seedDefaultPlans, DEFAULT_PLANS } from "./plans.seed";

describe("seedDefaultPlans", () => {
  it("is idempotent and inserts the three tiers", async () => {
    await seedDefaultPlans();
    await seedDefaultPlans(); // second run must not duplicate
    const rows = await db.select().from(plans);
    expect(rows).toHaveLength(DEFAULT_PLANS.length);
    expect(rows.map((r) => r.key).sort()).toEqual(["basic", "enterprise", "pro"]);
  });
});
