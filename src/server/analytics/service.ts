import { sql, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";

async function getTenantTimezone(tenantId: string): Promise<string> {
  const [t] = await db.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return t?.timezone ?? "Africa/Cairo";
}

export type RevenueTrendPoint = { day: string; revenue: number; orderCount: number };

export async function getRevenueTrend(tenantId: string, days: number): Promise<RevenueTrendPoint[]> {
  const timezone = await getTenantTimezone(tenantId);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return withTenant(tenantId, async (tx) => {
    const { rows } = await tx.execute<{ day: string; revenue: string; order_count: string }>(sql`
      SELECT (placed_at AT TIME ZONE ${timezone})::date AS day,
             COALESCE(SUM(total), 0) AS revenue,
             COUNT(*) AS order_count
      FROM orders
      WHERE placed_at >= ${since}
      GROUP BY day
      ORDER BY day
    `);
    return rows.map((r) => ({ day: r.day, revenue: Number(r.revenue), orderCount: Number(r.order_count) }));
  });
}

export type TopProduct = { productId: string; nameEn: string; quantity: number; revenue: number };

export async function getTopProducts(tenantId: string, days: number, limit = 10): Promise<TopProduct[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return withTenant(tenantId, async (tx) => {
    const { rows } = await tx.execute<{ product_id: string; name_en: string; quantity: string; revenue: string }>(sql`
      SELECT oi.product_id, oi.name_en,
             SUM(oi.quantity) AS quantity,
             SUM(oi.line_total) AS revenue
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.placed_at >= ${since}
      GROUP BY oi.product_id, oi.name_en
      ORDER BY revenue DESC
      LIMIT ${limit}
    `);
    return rows.map((r) => ({ productId: r.product_id, nameEn: r.name_en, quantity: Number(r.quantity), revenue: Number(r.revenue) }));
  });
}

export type StatusCount = { status: string; count: number };

export async function getOrdersByStatus(tenantId: string, days: number): Promise<StatusCount[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return withTenant(tenantId, async (tx) => {
    const { rows } = await tx.execute<{ status: string; count: string }>(sql`
      SELECT status, COUNT(*) AS count FROM orders WHERE placed_at >= ${since} GROUP BY status
    `);
    return rows.map((r) => ({ status: r.status, count: Number(r.count) }));
  });
}

export type FulfillmentCount = { fulfillmentType: string; count: number };

export async function getFulfillmentSplit(tenantId: string, days: number): Promise<FulfillmentCount[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return withTenant(tenantId, async (tx) => {
    const { rows } = await tx.execute<{ fulfillment_type: string; count: string }>(sql`
      SELECT fulfillment_type, COUNT(*) AS count FROM orders WHERE placed_at >= ${since} GROUP BY fulfillment_type
    `);
    return rows.map((r) => ({ fulfillmentType: r.fulfillment_type, count: Number(r.count) }));
  });
}

export type AverageOrderValue = { current: number; previous: number };

export async function getAverageOrderValue(tenantId: string, days: number): Promise<AverageOrderValue> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const previousSince = new Date(since.getTime() - days * 24 * 60 * 60 * 1000);
  return withTenant(tenantId, async (tx) => {
    const [{ rows: currentRows }, { rows: previousRows }] = await Promise.all([
      tx.execute<{ avg: string }>(sql`SELECT COALESCE(AVG(total), 0) AS avg FROM orders WHERE placed_at >= ${since}`),
      tx.execute<{ avg: string }>(sql`SELECT COALESCE(AVG(total), 0) AS avg FROM orders WHERE placed_at >= ${previousSince} AND placed_at < ${since}`),
    ]);
    return { current: Number(currentRows[0]?.avg ?? 0), previous: Number(previousRows[0]?.avg ?? 0) };
  });
}

export type PeakHourCell = { dayOfWeek: number; hour: number; count: number };

export async function getPeakHours(tenantId: string, days: number): Promise<PeakHourCell[]> {
  const timezone = await getTenantTimezone(tenantId);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return withTenant(tenantId, async (tx) => {
    const { rows } = await tx.execute<{ day_of_week: string; hour: string; count: string }>(sql`
      SELECT EXTRACT(DOW FROM (placed_at AT TIME ZONE ${timezone}))::int AS day_of_week,
             EXTRACT(HOUR FROM (placed_at AT TIME ZONE ${timezone}))::int AS hour,
             COUNT(*) AS count
      FROM orders
      WHERE placed_at >= ${since}
      GROUP BY day_of_week, hour
    `);
    return rows.map((r) => ({ dayOfWeek: Number(r.day_of_week), hour: Number(r.hour), count: Number(r.count) }));
  });
}
