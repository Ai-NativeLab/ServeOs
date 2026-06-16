import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { plans } from "./schema";

describe("plans schema", () => {
  it("stores limits and features as JSON", async () => {
    const [p] = await db
      .insert(plans)
      .values({
        key: "basic",
        name: "Basic",
        priceMonthly: "0",
        currency: "EGP",
        limits: { branches: 1, staff: 2, products: 50, whatsapp_numbers: 1, orders_per_month: 200, messages_per_month: 0 },
        features: { whatsapp: false, custom_domain: false, custom_theme: false, reservations: false, advanced_analytics: false, online_ordering: false },
      })
      .returning();
    expect(p.limits.branches).toBe(1);
    expect(p.features.whatsapp).toBe(false);
  });
});
