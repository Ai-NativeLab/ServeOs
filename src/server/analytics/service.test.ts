import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { withTenant } from "@/db/with-tenant";
import { orders } from "@/server/ordering/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { createBranch, updateBranchOrdering, createDeliveryArea } from "@/server/branches/service";
import { createCategory, createProduct, updateProduct } from "@/server/catalog/service";
import { placeOrder, transitionStatus } from "@/server/ordering/service";
import {
  getRevenueTrend, getTopProducts, getOrdersByStatus, getFulfillmentSplit,
  getAverageOrderValue, getPeakHours,
} from "./service";

const TZ = "Africa/Cairo";

/** placeOrder's `now` option only drives orderability checks; placed_at is
 *  defaultNow(). To backdate an order for range-window tests we set placed_at
 *  explicitly inside the tenant transaction. */
async function backdate(tenantId: string, orderId: string, placedAt: Date): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.update(orders).set({ placedAt }).where(eq(orders.id, orderId)),
  );
}

/** Postgres EXTRACT(DOW ...): 0=Sunday..6=Saturday, and HOUR 0..23, computed
 *  in the tenant's local timezone — mirrors what the service's AT TIME ZONE
 *  clause produces, but derived independently via Intl so the test is a real
 *  cross-check of the SQL timezone conversion. */
function localDowHour(d: Date, tz: string): { dayOfWeek: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", hour: "2-digit", hour12: false,
  }).formatToParts(d);
  const wd = parts.find((p) => p.type === "weekday")!.value;
  let hr = Number(parts.find((p) => p.type === "hour")!.value);
  if (hr === 24) hr = 0; // Intl can emit "24" at midnight; PG EXTRACT(HOUR) gives 0.
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { dayOfWeek: map[wd], hour: hr };
}

async function setup(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG", timezone: TZ }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro");
  const branch = await createBranch(t.id, { name: "Main" });
  await updateBranchOrdering(t.id, branch.id, { acceptingOrders: true });
  const area = await createDeliveryArea(t.id, branch.id, { nameEn: "Nearby", nameAr: "قريب", deliveryFee: "0", minOrderAmount: "0" });
  const cat = await createCategory(t.id, { nameEn: "P", nameAr: "ب" });
  const prod = await createProduct(t.id, { nameEn: "Pie", nameAr: "فطيرة", basePrice: "100", categoryId: cat.id });
  await updateProduct(t.id, prod.id, { isPublished: true });
  return { t, branch, area, prod };
}

const DAY = 24 * 60 * 60 * 1000;

describe("analytics service", () => {
  it("aggregates revenue, top products, status, fulfillment, AOV and peak hours, excluding out-of-range orders", async () => {
    const { t, branch, area, prod } = await setup("a1");

    const nowA = new Date(Date.now() - 2 * 3600 * 1000); // today, 2h ago — in range
    const nowB = new Date(Date.now() - 3 * DAY);          // 3 days ago — in range
    const nowC = new Date(Date.now() - 10 * DAY);         // 10 days ago — OUT of 7-day range

    // Order A: pickup, qty 2, → completed (walk the pickup state machine)
    const a = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup",
      customerName: "A", customerPhone: "1",
      lines: [{ productId: prod.id, quantity: 2, selectedOptionIds: [] }],
      now: nowA,
    });
    await backdate(t.id, a.orderId, nowA);
    for (const to of ["confirmed", "preparing", "ready", "completed"] as const) {
      await transitionStatus(t.id, a.orderId, to, "00000000-0000-0000-0000-000000000001");
    }

    // Order B: delivery, qty 1, pending
    const b = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "delivery", areaId: area.id, addressText: "x",
      customerName: "B", customerPhone: "2",
      lines: [{ productId: prod.id, quantity: 1, selectedOptionIds: [] }],
      now: nowB,
    });
    await backdate(t.id, b.orderId, nowB);

    // Order C: 10 days ago — must be excluded from the 7-day window
    const c = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup",
      customerName: "C", customerPhone: "3",
      lines: [{ productId: prod.id, quantity: 1, selectedOptionIds: [] }],
      now: nowC,
    });
    await backdate(t.id, c.orderId, nowC);

    const days = 7;

    // 1. Revenue trend — only A + B in range.
    const trend = await getRevenueTrend(t.id, days);
    expect(trend.length).toBeGreaterThan(0);
    const totalRevenue = trend.reduce((s, p) => s + p.revenue, 0);
    const totalOrders = trend.reduce((s, p) => s + p.orderCount, 0);
    // A.total = 100*2 + 14% VAT = 228; B.total = 100 + 14% VAT + 0 delivery = 114
    expect(totalRevenue).toBeCloseTo(342, 1);
    expect(totalOrders).toBe(2);

    // 2. Top products — single product aggregated across in-range orders.
    const top = await getTopProducts(t.id, days);
    expect(top).toHaveLength(1);
    expect(top[0].productId).toBe(prod.id);
    expect(top[0].nameEn).toBe("Pie");
    expect(top[0].quantity).toBe(3);              // 2 (A) + 1 (B)
    expect(top[0].revenue).toBeCloseTo(300, 1);   // 2*100 + 1*100 (line totals, no VAT)

    // 3. Orders by status — A=completed, B=pending (C excluded).
    const byStatus = await getOrdersByStatus(t.id, days);
    const map = Object.fromEntries(byStatus.map((s) => [s.status, s.count]));
    expect(map.completed).toBe(1);
    expect(map.pending).toBe(1);
    expect(byStatus.reduce((s, r) => s + r.count, 0)).toBe(2);

    // 4. Fulfillment split — A=pickup, B=delivery (C excluded).
    const split = await getFulfillmentSplit(t.id, days);
    const fmap = Object.fromEntries(split.map((s) => [s.fulfillmentType, s.count]));
    expect(fmap.pickup).toBe(1);
    expect(fmap.delivery).toBe(1);
    expect(split.reduce((s, r) => s + r.count, 0)).toBe(2);

    // 5. AOV — current window covers A+B; previous window (7..14 days ago) covers C only.
    const aov = await getAverageOrderValue(t.id, days);
    expect(aov.current).toBeCloseTo((228 + 114) / 2, 1); // 171
    expect(aov.previous).toBeCloseTo(114, 1);

    // 6. Peak hours — sum of all cell counts equals in-range order count (2),
    //    and order A's local-time cell is present with count >= 1.
    const peak = await getPeakHours(t.id, days);
    expect(peak.reduce((s, c) => s + c.count, 0)).toBe(2);
    const expected = localDowHour(nowA, TZ);
    const aCell = peak.find((c) => c.dayOfWeek === expected.dayOfWeek && c.hour === expected.hour);
    expect(aCell).toBeTruthy();
    expect(aCell!.count).toBeGreaterThanOrEqual(1);
  });

  it("returns empty/zero results when no orders exist in range", async () => {
    const { t } = await setup("a2");
    const days = 7;
    expect(await getRevenueTrend(t.id, days)).toEqual([]);
    expect(await getTopProducts(t.id, days)).toEqual([]);
    expect(await getOrdersByStatus(t.id, days)).toEqual([]);
    expect(await getFulfillmentSplit(t.id, days)).toEqual([]);
    const aov = await getAverageOrderValue(t.id, days);
    expect(aov.current).toBe(0);
    expect(aov.previous).toBe(0);
    expect(await getPeakHours(t.id, days)).toEqual([]);
  });
});
