import { sql, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";

async function getTenantTimezone(tenantId: string): Promise<string> {
  const [t] = await db.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return t?.timezone ?? "Africa/Cairo";
}

/**
 * The status filter every revenue measure carries. Cancelled and rejected
 * orders are not revenue; everything else — including in-flight orders —
 * counts as committed demand. getOrdersByStatus and getPeakHours deliberately
 * do NOT use this: one reports cancellations, the other measures demand
 * timing. Definitions: docs/ailab/specs/reporting-metrics.md.
 */
const SOLD = sql`status NOT IN ('cancelled', 'rejected')`;
const SOLD_O = sql`o.status NOT IN ('cancelled', 'rejected')`;

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
      WHERE placed_at >= ${since} AND ${SOLD}
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
      WHERE o.placed_at >= ${since} AND ${SOLD_O}
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
      SELECT fulfillment_type, COUNT(*) AS count FROM orders WHERE placed_at >= ${since} AND ${SOLD} GROUP BY fulfillment_type
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
      tx.execute<{ avg: string }>(sql`SELECT COALESCE(AVG(total), 0) AS avg FROM orders WHERE placed_at >= ${since} AND ${SOLD}`),
      tx.execute<{ avg: string }>(sql`SELECT COALESCE(AVG(total), 0) AS avg FROM orders WHERE placed_at >= ${previousSince} AND placed_at < ${since} AND ${SOLD}`),
    ]);
    return { current: Number(currentRows[0]?.avg ?? 0), previous: Number(previousRows[0]?.avg ?? 0) };
  });
}

// ---------------------------------------------------------------------------
// Cross-channel breakdowns (Spec 10). Cross-channel is a union over ONE table:
// orders.channel already distinguishes web from pos, so a combined report
// ignores channel and a sliced one groups by it. Money definitions:
// docs/ailab/specs/reporting-metrics.md.
// ---------------------------------------------------------------------------

export type SalesByChannelRow = { channel: "web" | "pos"; revenue: number; orderCount: number; averageOrderValue: number };

export async function getSalesByChannel(tenantId: string, days: number): Promise<SalesByChannelRow[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return withTenant(tenantId, async (tx) => {
    const { rows } = await tx.execute<{ channel: string; revenue: string; order_count: string }>(sql`
      SELECT channel, COALESCE(SUM(total), 0) AS revenue, COUNT(*) AS order_count
      FROM orders
      WHERE placed_at >= ${since} AND ${SOLD}
      GROUP BY channel
      ORDER BY channel
    `);
    return rows.map((r) => {
      const revenue = Number(r.revenue);
      const orderCount = Number(r.order_count);
      return {
        channel: r.channel as "web" | "pos",
        revenue,
        orderCount,
        averageOrderValue: orderCount ? revenue / orderCount : 0,
      };
    });
  });
}

export type SalesByBranchRow = { branchId: string; branchName: string; revenue: number; orderCount: number };

export async function getSalesByBranch(tenantId: string, days: number): Promise<SalesByBranchRow[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return withTenant(tenantId, async (tx) => {
    const { rows } = await tx.execute<{ branch_id: string; branch_name: string; revenue: string; order_count: string }>(sql`
      SELECT o.branch_id, b.name AS branch_name,
             COALESCE(SUM(o.total), 0) AS revenue, COUNT(*) AS order_count
      FROM orders o
      JOIN branches b ON b.id = o.branch_id
      WHERE o.placed_at >= ${since} AND ${SOLD_O}
      GROUP BY o.branch_id, b.name
      ORDER BY revenue DESC
    `);
    return rows.map((r) => ({
      branchId: r.branch_id, branchName: r.branch_name,
      revenue: Number(r.revenue), orderCount: Number(r.order_count),
    }));
  });
}

export type SalesByCashierRow = { cashierUserId: string | null; cashierName: string | null; revenue: number; orderCount: number };

/** The NULL-cashier bucket is the web/online row — an order nobody rang up. */
export async function getSalesByCashier(tenantId: string, days: number): Promise<SalesByCashierRow[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return withTenant(tenantId, async (tx) => {
    const { rows } = await tx.execute<{ cashier_user_id: string | null; cashier_name: string | null; revenue: string; order_count: string }>(sql`
      SELECT o.cashier_user_id, u.name AS cashier_name,
             COALESCE(SUM(o.total), 0) AS revenue, COUNT(*) AS order_count
      FROM orders o
      LEFT JOIN users u ON u.id = o.cashier_user_id
      WHERE o.placed_at >= ${since} AND ${SOLD_O}
      GROUP BY o.cashier_user_id, u.name
      ORDER BY revenue DESC
    `);
    return rows.map((r) => ({
      cashierUserId: r.cashier_user_id, cashierName: r.cashier_name,
      revenue: Number(r.revenue), orderCount: Number(r.order_count),
    }));
  });
}

export type SalesByPaymentMethodRow = { method: "cash" | "card" | "other"; amount: number; count: number };

export async function getSalesByPaymentMethod(tenantId: string, days: number): Promise<SalesByPaymentMethodRow[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return withTenant(tenantId, async (tx) => {
    const { rows } = await tx.execute<{ method: string; amount: string; count: string }>(sql`
      SELECT op.method, COALESCE(SUM(op.amount), 0) AS amount, COUNT(*) AS count
      FROM order_payments op
      JOIN orders o ON o.id = op.order_id
      WHERE o.placed_at >= ${since} AND ${SOLD_O}
      GROUP BY op.method
      ORDER BY amount DESC
    `);
    return rows.map((r) => ({
      method: r.method as "cash" | "card" | "other",
      amount: Number(r.amount), count: Number(r.count),
    }));
  });
}

export type DiscountsGiven = {
  total: number;
  byReason: { reasonCode: string; amount: number; count: number }[];
  byCashier: { cashierUserId: string; cashierName: string | null; amount: number; count: number }[];
};

/**
 * POS discounts come from the append-only pos_adjustment_events trail. A POS
 * order-level discount ALSO lands in orders.discount_amount, so summing both
 * would double-count it — the scalar term therefore only picks up web orders'
 * discount_amount, where no adjustment event exists.
 */
export async function getDiscountsGiven(tenantId: string, days: number): Promise<DiscountsGiven> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return withTenant(tenantId, async (tx) => {
    const [byReason, byCashier, scalars] = await Promise.all([
      tx.execute<{ reason_code: string; amount: string; count: string }>(sql`
        SELECT e.reason_code, COALESCE(SUM(e.amount), 0) AS amount, COUNT(*) AS count
        FROM pos_adjustment_events e
        JOIN orders o ON o.id = e.order_id
        WHERE e.type IN ('line_discount', 'order_discount')
          AND o.placed_at >= ${since} AND ${SOLD_O}
        GROUP BY e.reason_code
        ORDER BY amount DESC
      `),
      tx.execute<{ by_user_id: string; cashier_name: string | null; amount: string; count: string }>(sql`
        SELECT e.by_user_id, u.name AS cashier_name, COALESCE(SUM(e.amount), 0) AS amount, COUNT(*) AS count
        FROM pos_adjustment_events e
        JOIN orders o ON o.id = e.order_id
        LEFT JOIN users u ON u.id = e.by_user_id
        WHERE e.type IN ('line_discount', 'order_discount')
          AND o.placed_at >= ${since} AND ${SOLD_O}
        GROUP BY e.by_user_id, u.name
        ORDER BY amount DESC
      `),
      tx.execute<{ web_discounts: string }>(sql`
        SELECT COALESCE(SUM(discount_amount), 0) AS web_discounts
        FROM orders
        WHERE placed_at >= ${since} AND ${SOLD} AND channel = 'web'
      `),
    ]);
    const eventTotal = byReason.rows.reduce((s, r) => s + Number(r.amount), 0);
    return {
      total: eventTotal + Number(scalars.rows[0]?.web_discounts ?? 0),
      byReason: byReason.rows.map((r) => ({ reasonCode: r.reason_code, amount: Number(r.amount), count: Number(r.count) })),
      byCashier: byCashier.rows.map((r) => ({
        cashierUserId: r.by_user_id, cashierName: r.cashier_name,
        amount: Number(r.amount), count: Number(r.count),
      })),
    };
  });
}

export type TendersAndTips = {
  byMethod: { method: string; amount: number; count: number }[];
  tips: number;
  cashTendered: number;
  cashChange: number;
};

/** Financial (reports:financial) — tips ride tenders and are not revenue. */
export async function getTendersAndTips(tenantId: string, days: number): Promise<TendersAndTips> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return withTenant(tenantId, async (tx) => {
    const [byMethod, scalars] = await Promise.all([
      tx.execute<{ method: string; amount: string; count: string }>(sql`
        SELECT op.method, COALESCE(SUM(op.amount), 0) AS amount, COUNT(*) AS count
        FROM order_payments op
        JOIN orders o ON o.id = op.order_id
        WHERE o.placed_at >= ${since} AND ${SOLD_O}
        GROUP BY op.method
        ORDER BY amount DESC
      `),
      tx.execute<{ tips: string; cash_tendered: string; cash_change: string }>(sql`
        SELECT COALESCE(SUM(op.tip_amount), 0) AS tips,
               COALESCE(SUM(op.tendered_amount) FILTER (WHERE op.method = 'cash'), 0) AS cash_tendered,
               COALESCE(SUM(op.change_amount) FILTER (WHERE op.method = 'cash'), 0) AS cash_change
        FROM order_payments op
        JOIN orders o ON o.id = op.order_id
        WHERE o.placed_at >= ${since} AND ${SOLD_O}
      `),
    ]);
    const s = scalars.rows[0];
    return {
      byMethod: byMethod.rows.map((r) => ({ method: r.method, amount: Number(r.amount), count: Number(r.count) })),
      tips: Number(s?.tips ?? 0),
      cashTendered: Number(s?.cash_tendered ?? 0),
      cashChange: Number(s?.cash_change ?? 0),
    };
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
