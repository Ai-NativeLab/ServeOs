import { sql, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { tableExists } from "./deps";

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

export type RefundsAndVoids = {
  voids: { type: string; amount: number; count: number }[];
  /** null = Spec 3 not shipped — hide the sub-section rather than claiming "zero refunds". */
  refunds: { amount: number; count: number; byReason: { reasonCode: string; amount: number; count: number }[] } | null;
};

export async function getRefundsAndVoids(tenantId: string, days: number): Promise<RefundsAndVoids> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return withTenant(tenantId, async (tx) => {
    const { rows: voidRows } = await tx.execute<{ type: string; amount: string; count: string }>(sql`
      SELECT e.type, COALESCE(SUM(e.amount), 0) AS amount, COUNT(*) AS count
      FROM pos_adjustment_events e
      JOIN orders o ON o.id = e.order_id
      WHERE e.type IN ('line_void', 'order_void') AND o.placed_at >= ${since}
      GROUP BY e.type
      ORDER BY e.type
    `);
    const voids = voidRows.map((r) => ({ type: r.type, amount: Number(r.amount), count: Number(r.count) }));

    if (!(await tableExists(tx, "refunds"))) return { voids, refunds: null };

    // Spec 3 shape: refunds(id, order_id, total_amount, created_at, reason_code)
    // with one reason per refund (header); refund_lines carry the per-item amounts.
    const [{ rows: totals }, { rows: reasons }] = await Promise.all([
      tx.execute<{ amount: string; count: string }>(sql`
        SELECT COALESCE(SUM(r.total_amount), 0) AS amount, COUNT(*) AS count
        FROM refunds r WHERE r.created_at >= ${since}
      `),
      tx.execute<{ reason_code: string; amount: string; count: string }>(sql`
        SELECT r.reason_code, COALESCE(SUM(rl.amount), 0) AS amount, COUNT(*) AS count
        FROM refund_lines rl
        JOIN refunds r ON r.id = rl.refund_id
        WHERE r.created_at >= ${since}
        GROUP BY r.reason_code
        ORDER BY amount DESC
      `),
    ]);
    return {
      voids,
      refunds: {
        amount: Number(totals[0]?.amount ?? 0),
        count: Number(totals[0]?.count ?? 0),
        byReason: reasons.map((r) => ({ reasonCode: r.reason_code, amount: Number(r.amount), count: Number(r.count) })),
      },
    };
  });
}

export type ReconciliationSummaryRow = {
  day: string;
  expectedCash: number;
  countedCash: number;
  variance: number;
  matchedSettlementLines: number;
  unmatchedSettlementLines: number;
  fees: number;
};

/**
 * Financial (reports:financial). cash_counts (Spec 2) and settlement_batches
 * (Spec 6) FEED reconciliation runs; this report only reads the runs (Spec 7).
 * Returns [] until reconciliation_runs migrates.
 */
export async function getReconciliationSummary(tenantId: string, days: number): Promise<ReconciliationSummaryRow[]> {
  const timezone = await getTenantTimezone(tenantId);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return withTenant(tenantId, async (tx) => {
    if (!(await tableExists(tx, "reconciliation_runs"))) return [];
    const { rows } = await tx.execute<{
      day: string; expected_cash: string; counted_cash: string; variance: string;
      matched: string; unmatched: string; fees: string;
    }>(sql`
      SELECT (rr.run_for AT TIME ZONE ${timezone})::date AS day,
             COALESCE(SUM(rr.expected_cash), 0) AS expected_cash,
             COALESCE(SUM(rr.counted_cash), 0) AS counted_cash,
             COALESCE(SUM(rr.counted_cash - rr.expected_cash), 0) AS variance,
             COALESCE(SUM(rr.matched_settlement_lines), 0) AS matched,
             COALESCE(SUM(rr.unmatched_settlement_lines), 0) AS unmatched,
             COALESCE(SUM(rr.fees), 0) AS fees
      FROM reconciliation_runs rr
      WHERE rr.run_for >= ${since}
      GROUP BY day
      ORDER BY day
    `);
    return rows.map((r) => ({
      day: r.day,
      expectedCash: Number(r.expected_cash),
      countedCash: Number(r.counted_cash),
      variance: Number(r.variance),
      matchedSettlementLines: Number(r.matched),
      unmatchedSettlementLines: Number(r.unmatched),
      fees: Number(r.fees),
    }));
  });
}

// ---------------------------------------------------------------------------
// Inventory (Spec 8) + purchasing (Spec 9) reports.
//
// Spec 8 has now migrated, so the inventory queries below run for real against
// empty tables (returning [] on no data rather than on a missing table). They
// were originally written against GUESSED column names, and every guess was
// wrong once the canonical schema landed — remaining_qty/qty_remaining,
// name/name_en, quantity/qty, movement_type/type, expected_qty/system_qty,
// stock_count_id/count_id, created_at/started_at. Corrected against
// drizzle/0033 + src/server/inventory/schema.ts. The public row shapes are
// unchanged (still `name`), so Spec 10's consumers were not touched.
//
// Purchasing (suppliers / purchase_orders) is still Spec 9 and still guarded.
// FORWARD (Spec 8/9): fixtures seeding real stock_ledger/PO rows + aggregation
// assertions land with the reporting spec; today only the empty case is covered.
// ---------------------------------------------------------------------------

export type InventoryValuationRow = { itemId: string; name: string; onHand: number; unitCost: number; value: number };

export async function getInventoryValuation(tenantId: string): Promise<InventoryValuationRow[]> {
  return withTenant(tenantId, async (tx) => {
    if (!(await tableExists(tx, "inventory_lots"))) return [];
    const { rows } = await tx.execute<{ item_id: string; name: string; on_hand: string; unit_cost: string; value: string }>(sql`
      SELECT l.item_id, i.name_en AS name,
             SUM(l.qty_remaining) AS on_hand,
             AVG(l.unit_cost) AS unit_cost,
             SUM(l.qty_remaining * l.unit_cost) AS value
      FROM inventory_lots l JOIN inventory_items i ON i.id = l.item_id
      GROUP BY l.item_id, i.name_en ORDER BY value DESC
    `);
    return rows.map((r) => ({ itemId: r.item_id, name: r.name, onHand: Number(r.on_hand), unitCost: Number(r.unit_cost), value: Number(r.value) }));
  });
}

export type InventoryMovementRow = { itemId: string; name: string; quantity: number };

async function sumStockMovement(tenantId: string, days: number, movementType: string): Promise<InventoryMovementRow[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return withTenant(tenantId, async (tx) => {
    if (!(await tableExists(tx, "stock_ledger"))) return [];
    const { rows } = await tx.execute<{ item_id: string; name: string; quantity: string }>(sql`
      SELECT sl.item_id, i.name_en AS name, SUM(ABS(sl.qty)) AS quantity
      FROM stock_ledger sl JOIN inventory_items i ON i.id = sl.item_id
      WHERE sl.type = ${movementType}::stock_ledger_type AND sl.created_at >= ${since}
      GROUP BY sl.item_id, i.name_en ORDER BY quantity DESC
    `);
    return rows.map((r) => ({ itemId: r.item_id, name: r.name, quantity: Number(r.quantity) }));
  });
}

export type InventoryConsumptionRow = { itemId: string; name: string; consumed: number };

export async function getInventoryConsumption(tenantId: string, days: number): Promise<InventoryConsumptionRow[]> {
  const rows = await sumStockMovement(tenantId, days, "sale_deduction");
  return rows.map((r) => ({ itemId: r.itemId, name: r.name, consumed: r.quantity }));
}

export type InventoryWastageRow = { itemId: string; name: string; wasted: number };

export async function getInventoryWastage(tenantId: string, days: number): Promise<InventoryWastageRow[]> {
  const rows = await sumStockMovement(tenantId, days, "waste");
  return rows.map((r) => ({ itemId: r.itemId, name: r.name, wasted: r.quantity }));
}

export type CountVarianceRow = { countId: string; itemId: string; name: string; counted: number; expected: number; variance: number };

export async function getCountVariance(tenantId: string, days: number): Promise<CountVarianceRow[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return withTenant(tenantId, async (tx) => {
    if (!(await tableExists(tx, "stock_counts"))) return [];
    const { rows } = await tx.execute<{ count_id: string; item_id: string; name: string; counted: string; expected: string }>(sql`
      SELECT sc.id AS count_id, scl.item_id, i.name_en AS name, scl.counted_qty AS counted, scl.system_qty AS expected
      FROM stock_count_lines scl
      JOIN stock_counts sc ON sc.id = scl.count_id
      JOIN inventory_items i ON i.id = scl.item_id
      WHERE sc.started_at >= ${since}
      ORDER BY sc.started_at DESC
    `);
    return rows.map((r) => ({
      countId: r.count_id, itemId: r.item_id, name: r.name,
      counted: Number(r.counted), expected: Number(r.expected),
      variance: Number(r.counted) - Number(r.expected),
    }));
  });
}

export type LowStockRow = { itemId: string; name: string; locationId: string; onHand: number; reorderPoint: number };

/**
 * Guarded on `reorder_rules`, NOT on the inventory tables: the reorder point is
 * per item per location and lives in that table (spec Part D), which Spec 9
 * builds — it is deliberately not a column on inventory_items. Spec 8 landing
 * must therefore not switch this report on, or it would query a column that
 * does not exist. An item with a rule but no lots is low stock (on-hand 0), so
 * the join to lots is a LEFT JOIN. "At or below" the point triggers, per spec.
 *
 * FORWARD (Spec 9): this query is written from the spec but cannot be executed
 * until reorder_rules exists — verify it against the real table then.
 */
export async function getLowStock(tenantId: string): Promise<LowStockRow[]> {
  return withTenant(tenantId, async (tx) => {
    if (!(await tableExists(tx, "reorder_rules"))) return [];
    const { rows } = await tx.execute<{ item_id: string; name: string; location_id: string; on_hand: string; reorder_point: string }>(sql`
      SELECT rr.item_id, i.name_en AS name, rr.location_id,
             COALESCE(SUM(l.qty_remaining), 0) AS on_hand, rr.reorder_point
      FROM reorder_rules rr
      JOIN inventory_items i ON i.id = rr.item_id
      LEFT JOIN inventory_lots l ON l.item_id = rr.item_id AND l.location_id = rr.location_id
      WHERE rr.is_active
      GROUP BY rr.item_id, i.name_en, rr.location_id, rr.reorder_point
      HAVING COALESCE(SUM(l.qty_remaining), 0) <= rr.reorder_point
      ORDER BY on_hand
    `);
    return rows.map((r) => ({
      itemId: r.item_id, name: r.name, locationId: r.location_id,
      onHand: Number(r.on_hand), reorderPoint: Number(r.reorder_point),
    }));
  });
}

export type SpendBySupplierRow = { supplierId: string; name: string; poCount: number; spend: number };

export async function getSpendBySupplier(tenantId: string, days: number): Promise<SpendBySupplierRow[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return withTenant(tenantId, async (tx) => {
    if (!(await tableExists(tx, "purchase_orders"))) return [];
    const { rows } = await tx.execute<{ supplier_id: string; name: string; po_count: string; spend: string }>(sql`
      SELECT po.supplier_id, s.name, COUNT(*) AS po_count, COALESCE(SUM(po.total), 0) AS spend
      FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
      WHERE po.created_at >= ${since} AND po.status != 'cancelled'
      GROUP BY po.supplier_id, s.name ORDER BY spend DESC
    `);
    return rows.map((r) => ({ supplierId: r.supplier_id, name: r.name, poCount: Number(r.po_count), spend: Number(r.spend) }));
  });
}

export type ReceivedVsInvoicedRow = { poId: string; poNumber: string; ordered: number; received: number; invoiced: number; variance: number };

export async function getReceivedVsInvoiced(tenantId: string, days: number): Promise<ReceivedVsInvoicedRow[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return withTenant(tenantId, async (tx) => {
    if (!(await tableExists(tx, "po_receipts"))) return [];
    // Invoice entry is ONE header figure on the PO (the supplier's actual
    // invoice), not a per-receipt-line amount — so the "invoiced" side reads
    // po.invoice_total, never a SUM over receipt lines. The shipped stub's
    // per-line `invoiced_amount` column was deliberately never created; the
    // query was aligned to the real schema in the same PR (PR #116 precedent).
    const { rows } = await tx.execute<{ po_id: string; po_number: string; ordered: string; received: string; invoiced: string }>(sql`
      SELECT po.id AS po_id, po.po_number,
             COALESCE(po.total, 0) AS ordered,
             COALESCE(SUM(prl.received_qty * prl.unit_cost), 0) AS received,
             COALESCE(po.invoice_total, 0) AS invoiced
      FROM purchase_orders po
      JOIN po_receipts pr ON pr.purchase_order_id = po.id
      JOIN po_receipt_lines prl ON prl.po_receipt_id = pr.id
      WHERE po.created_at >= ${since}
      GROUP BY po.id, po.po_number, po.invoice_total
      ORDER BY MAX(po.created_at) DESC
    `);
    return rows.map((r) => ({
      poId: r.po_id, poNumber: r.po_number,
      ordered: Number(r.ordered), received: Number(r.received), invoiced: Number(r.invoiced),
      variance: Number(r.received) - Number(r.invoiced),
    }));
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
