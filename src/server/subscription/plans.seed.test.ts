import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { plans } from "./schema";
import { seedDefaultPlans, DEFAULT_PLANS } from "./plans.seed";

describe("seedDefaultPlans", () => {
  it("is idempotent and inserts the four tiers", async () => {
    await seedDefaultPlans();
    await seedDefaultPlans(); // second run must not duplicate
    const rows = await db.select().from(plans);
    expect(rows).toHaveLength(DEFAULT_PLANS.length);
    // Keys are deliberately unchanged from the three-tier era: subscriptions
    // point at these rows, so renaming basic → free would orphan live
    // subscriptions and leave a fifth plan for the pricing page to display.
    expect(rows.map((r) => r.key).sort()).toEqual(["basic", "enterprise", "growth", "pro"]);
  });

  it("sells no tier on a feature that does not exist", async () => {
    // `reservations` is a flag with no domain behind it. True on any tier and
    // the pricing page advertises something the product cannot do.
    expect(DEFAULT_PLANS.every((p) => p.features.reservations === false)).toBe(true);
  });

  it("prices the four tiers at 0 / 499 / 699 / 1099", async () => {
    const byPrice = [...DEFAULT_PLANS].sort((a, b) => Number(a.priceMonthly) - Number(b.priceMonthly));
    expect(byPrice.map((p) => p.priceMonthly)).toEqual(["0", "499", "699", "1099"]);
  });
});
