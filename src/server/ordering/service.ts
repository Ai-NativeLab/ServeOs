import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { requireFeature, incrementUsage } from "@/server/entitlements/service";
import { getCheckoutPricing } from "@/server/tenancy/settings";
import { computeOrderTotals } from "@/lib/order-totals";
import { isBranchOrderableAt, isWithinSchedulingHorizon, MIN_LEAD_MINUTES } from "@/server/branches/slots";
import { getTenantById } from "@/server/tenancy";
import { branches, deliveryAreas } from "@/server/branches/schema";
import { products, modifierGroups, modifierOptions, branchProductAvailability, productVariants } from "@/server/catalog/schema";
import { InvalidVariantError } from "@/server/catalog/errors";
import { getCapabilities, type VerticalId } from "@/server/verticals";
import { isMethodEnabled } from "@/server/payments/offline/methods";
import { PaymentMethodNotEnabledError, InvalidProofError, PaymentAlreadyResolvedError } from "@/server/payments/offline";
import { orders, orderItems, orderStatusEvents, type SelectedModifier, type Order, type OrderWithItems, type OrderDetail, type OrderStatus } from "./schema";
import { canTransition } from "./state-machine";
import { OrderValidationError, BranchNotAcceptingOrdersError, AreaNotDeliverableError, MinimumOrderNotMetError, OrderNotFoundError, InvalidTransitionError, InvalidScheduleError, OutOfStockError } from "./errors";

export type PlaceOrderLine = { productId: string; variantId?: string; quantity: number; selectedOptionIds: string[] };
export type PlaceOrderInput = {
  branchId: string;
  fulfillmentType: "pickup" | "delivery";
  customerName: string;
  customerPhone: string;
  notes?: string;
  areaId?: string;
  addressText?: string;
  /** ISO 8601. Absent/undefined = ASAP. */
  scheduledFor?: string;
  lines: PlaceOrderLine[];
  now?: Date;
  paymentMethod?: "cash" | "instapay" | "vodafone_cash" | "mobile_wallet";
  paymentReference?: string;
  paymentProofUrl?: string;
};
export type PlaceOrderResult = { orderId: string; orderNumber: number; statusToken: string };

/** Round to 2 decimals and format as a numeric string for Postgres. */
export function money(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

export async function placeOrder(tenantId: string, input: PlaceOrderInput): Promise<PlaceOrderResult> {
  if (!input.lines || input.lines.length === 0) throw new OrderValidationError("empty cart");
  if (!input.customerName.trim() || !input.customerPhone.trim()) throw new OrderValidationError("missing customer details");

  const paymentMethod = input.paymentMethod ?? "cash";
  let paymentStatus: "unpaid" | "pending_verification" = "unpaid";
  let paymentReference: string | null = null;
  let paymentProofUrl: string | null = null;
  if (paymentMethod !== "cash") {
    if (!(await isMethodEnabled(tenantId, paymentMethod))) throw new PaymentMethodNotEnabledError(paymentMethod);
    if (!input.paymentReference?.trim()) throw new InvalidProofError();
    paymentStatus = "pending_verification";
    paymentReference = input.paymentReference.trim();
    paymentProofUrl = input.paymentProofUrl?.trim() || null;
  }

  await requireFeature(tenantId, "online_ordering");
  const pricing = await getCheckoutPricing(tenantId);
  const now = input.now ?? new Date();

  const tenant = await getTenantById(tenantId);
  if (!tenant) throw new OrderValidationError("unknown tenant");
  const tz = tenant.timezone;
  const caps = getCapabilities(tenant.vertical as VerticalId);

  let scheduledFor: Date | null = null;
  if (input.scheduledFor !== undefined) {
    const at = new Date(input.scheduledFor);
    if (Number.isNaN(at.getTime())) throw new InvalidScheduleError("unparseable");
    if (at.getTime() < now.getTime() + MIN_LEAD_MINUTES * 60_000) throw new InvalidScheduleError("too_soon");
    if (!isWithinSchedulingHorizon(tz, now, at)) throw new InvalidScheduleError("too_far");
    scheduledFor = at;
  }

  const result = await withTenant(tenantId, async (tx) => {
    // 1. Branch + orderability
    const [branch] = await tx.select().from(branches).where(eq(branches.id, input.branchId)).limit(1);
    if (!branch) throw new OrderValidationError("unknown branch");
    if (scheduledFor) {
      if (!isBranchOrderableAt(branch, tz, scheduledFor)) throw new InvalidScheduleError("closed_at_time");
    } else if (!isBranchOrderableAt(branch, tz, now)) {
      throw new BranchNotAcceptingOrdersError();
    }

    // 2. Validate each line against the catalog; build snapshots.
    let subtotal = 0;
    const itemsToInsert: Array<{ productId: string; variantId: string | null; variantNameEn: string | null; variantNameAr: string | null; nameEn: string; nameAr: string; unitBasePrice: string; quantity: number; lineTotal: string; selectedModifiers: SelectedModifier[] }> = [];

    for (const line of input.lines) {
      if (!Number.isInteger(line.quantity) || line.quantity < 1) throw new OrderValidationError("bad quantity");

      const [product] = await tx.select().from(products).where(and(eq(products.id, line.productId), eq(products.isPublished, true))).limit(1);
      if (!product) throw new OrderValidationError("product unavailable");

      const [avail] = await tx.select().from(branchProductAvailability)
        .where(and(eq(branchProductAvailability.branchId, input.branchId), eq(branchProductAvailability.productId, product.id))).limit(1);
      if (avail && !avail.isAvailable) throw new OrderValidationError("product unavailable at branch");
      const effectiveBase = avail?.priceOverride ?? product.basePrice;

      let unit: number;
      let selected: Array<typeof modifierOptions.$inferSelect> = [];
      let groups: Array<typeof modifierGroups.$inferSelect> = [];
      let variantId: string | null = null;
      let variantNameEn: string | null = null;
      let variantNameAr: string | null = null;

      if (line.variantId) {
        if (line.selectedOptionIds.length > 0) throw new OrderValidationError("modifiers not allowed on variant lines");
        const [variant] = await tx.select().from(productVariants)
          .where(and(eq(productVariants.id, line.variantId), eq(productVariants.productId, product.id), eq(productVariants.isActive, true)))
          .limit(1);
        if (!variant) throw new InvalidVariantError();
        unit = Number(variant.price);
        variantId = variant.id;
        variantNameEn = variant.nameEn;
        variantNameAr = variant.nameAr;
      } else {
        groups = await tx.select().from(modifierGroups).where(eq(modifierGroups.productId, product.id));
        const groupIds = groups.map((g) => g.id);
        const opts = groupIds.length > 0
          ? await tx.select().from(modifierOptions).where(inArray(modifierOptions.modifierGroupId, groupIds))
          : [];
        const optById = new Map(opts.map((o) => [o.id, o]));

        // Dedupe first: a crafted request could repeat an option id to inflate the
        // per-group count (bypassing maxSelections) and double-charge its priceDelta.
        selected = [...new Set(line.selectedOptionIds)].map((id) => {
          const o = optById.get(id);
          if (!o) throw new OrderValidationError("invalid modifier selection");
          return o;
        });
        for (const g of groups) {
          const count = selected.filter((o) => o.modifierGroupId === g.id).length;
          if (g.required && count < Math.max(1, g.minSelections)) throw new OrderValidationError("required modifier missing");
          // minSelections only binds once the (optional) group has at least one
          // pick; an untouched optional group is allowed.
          if (count > 0 && count < g.minSelections) throw new OrderValidationError("too few modifier selections");
          if (count > g.maxSelections) throw new OrderValidationError("too many modifier selections");
        }

        const modifiersTotal = selected.reduce((s, o) => s + Number(o.priceDelta), 0);
        unit = Number(effectiveBase) + modifiersTotal;
      }

      // Stock decrement — guarded UPDATE makes the WHERE the serialization point:
      // under READ COMMITTED the second concurrent writer re-evaluates the WHERE
      // against the latest committed row after the first commits, so exactly one
      // order gets the last unit. NULL stock (untracked) always passes via isNull.
      if (caps.stockTracking) {
        if (variantId) {
          const hit = await tx.update(productVariants)
            .set({ stockQuantity: sql`${productVariants.stockQuantity} - ${line.quantity}` })
            .where(and(
              eq(productVariants.id, variantId),
              or(isNull(productVariants.stockQuantity), gte(productVariants.stockQuantity, line.quantity)),
            ))
            .returning({ id: productVariants.id });
          if (hit.length === 0) throw new OutOfStockError(product.nameEn, product.nameAr);
        } else if (product.trackStock) {
          const hit = await tx.update(products)
            .set({ stockQuantity: sql`${products.stockQuantity} - ${line.quantity}` })
            .where(and(eq(products.id, product.id), gte(products.stockQuantity, line.quantity)))
            .returning({ id: products.id });
          if (hit.length === 0) throw new OutOfStockError(product.nameEn, product.nameAr);
        }
      }

      const lineTotal = unit * line.quantity;
      subtotal += lineTotal;

      const snapshot: SelectedModifier[] = selected.map((o) => {
        const g = groups.find((gg) => gg.id === o.modifierGroupId)!;
        return { groupNameEn: g.nameEn, groupNameAr: g.nameAr, optionNameEn: o.nameEn, optionNameAr: o.nameAr, priceDelta: o.priceDelta };
      });

      itemsToInsert.push({
        productId: product.id, variantId, variantNameEn, variantNameAr, nameEn: product.nameEn, nameAr: product.nameAr,
        unitBasePrice: variantId ? String(unit) : String(effectiveBase), quantity: line.quantity, lineTotal: money(lineTotal), selectedModifiers: variantId ? [] : snapshot,
      });
    }

    // 3. Fulfillment: delivery fee + area, or pickup.
    let deliveryFee = 0;
    let deliveryAreaId: string | null = null;
    let deliveryAreaName: string | null = null;
    let deliveryAddress: string | null = null;
    if (input.fulfillmentType === "delivery") {
      if (!input.areaId) throw new AreaNotDeliverableError();
      if (!input.addressText?.trim()) throw new OrderValidationError("missing delivery address");
      const [area] = await tx.select().from(deliveryAreas)
        .where(and(eq(deliveryAreas.id, input.areaId), eq(deliveryAreas.branchId, input.branchId), eq(deliveryAreas.isActive, true))).limit(1);
      if (!area) throw new AreaNotDeliverableError();
      if (subtotal < Number(area.minOrderAmount)) throw new MinimumOrderNotMetError(money(Number(area.minOrderAmount)));
      deliveryFee = Number(area.deliveryFee);
      deliveryAreaId = area.id;
      deliveryAreaName = area.nameEn;
      deliveryAddress = input.addressText.trim();
    }

    // 4. Totals — single source of money math (src/lib/order-totals.ts)
    const totals = computeOrderTotals(pricing, subtotal, deliveryFee);

    // 5. Order number (per-tenant max+1). Acquire the per-tenant advisory lock
    // only now — after all validation I/O — so concurrent checkouts serialize
    // for just the read-max-then-insert window, not the whole transaction. No
    // explicit tenant filter needed: FORCE RLS scopes this MAX to the tenant
    // via app.tenant_id (set by withTenant), same as every other query here.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId})::bigint)`);
    const [{ next }] = await tx.select({ next: sql<number>`COALESCE(MAX(${orders.orderNumber}), 0) + 1` }).from(orders);
    const orderNumber = Number(next);
    const statusToken = randomUUID();

    // 6. Insert order + items + initial status event
    const [order] = await tx.insert(orders).values({
      tenantId, branchId: input.branchId, orderNumber,
      fulfillmentType: input.fulfillmentType, status: "pending",
      paymentMethod,
      paymentStatus,
      paymentReference,
      paymentProofUrl,
      customerName: input.customerName.trim(), customerPhone: input.customerPhone.trim(), notes: input.notes?.trim() || null,
      deliveryAreaId, deliveryAreaNameSnapshot: deliveryAreaName, deliveryAddressText: deliveryAddress,
      subtotal: money(totals.subtotal),
      vatRateSnapshot: money(totals.vatRate),
      vatAmount: money(totals.vatAmount),
      serviceChargeAmount: totals.serviceChargeAmount > 0 ? money(totals.serviceChargeAmount) : null,
      deliveryFee: money(totals.deliveryFee),
      total: money(totals.total),
      statusToken,
      scheduledFor,
    }).returning();

    await tx.insert(orderItems).values(itemsToInsert.map((i) => ({ ...i, tenantId, orderId: order.id })));
    await tx.insert(orderStatusEvents).values({ tenantId, orderId: order.id, fromStatus: null, toStatus: "pending" });

    return { orderId: order.id, orderNumber, statusToken };
  });

  // Meter usage (control table, outside the tenant tx). By design (spec §2)
  // there is NO hard cap in v1 — orders/month is recorded for visibility only,
  // so checkUsage is intentionally not enforced at placement.
  await incrementUsage(tenantId, "orders");
  return result;
}

export async function getOrderByToken(tenantId: string, token: string): Promise<OrderWithItems | null> {
  return withTenant(tenantId, async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.statusToken, token)).limit(1);
    if (!order) return null;
    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    return { ...order, items };
  });
}

/** Returns order-item quantities to stock. No-op for verticals without stockTracking.
 * NULL stock (untracked) is left NULL; `sql`x + n`` on NULL stays NULL, so no guard needed. */
async function restockOrderItems(tx: Parameters<Parameters<typeof withTenant>[1]>[0], orderId: string, caps: { stockTracking: boolean }): Promise<void> {
  if (!caps.stockTracking) return;
  const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  for (const item of items) {
    if (item.variantId) {
      await tx.update(productVariants)
        .set({ stockQuantity: sql`${productVariants.stockQuantity} + ${item.quantity}` })
        .where(eq(productVariants.id, item.variantId));
    } else {
      await tx.update(products)
        .set({ stockQuantity: sql`${products.stockQuantity} + ${item.quantity}` })
        .where(and(eq(products.id, item.productId), eq(products.trackStock, true)));
    }
  }
}

/** Customer-initiated cancel, authorised by possession of the status token.
 * Policy: only while still `pending` — once the restaurant confirms, the
 * customer escalates via phone/WhatsApp instead. Dashboard cancels keep their
 * wider state-machine rights via transitionStatus. */
export async function cancelOrderByToken(tenantId: string, token: string): Promise<Order> {
  const tenant = await getTenantById(tenantId);
  const caps = getCapabilities((tenant?.vertical ?? "restaurant") as VerticalId);
  return withTenant(tenantId, async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.statusToken, token)).limit(1);
    if (!order) throw new OrderNotFoundError();
    if (order.status !== "pending" || !canTransition(order.status, "cancelled", order.fulfillmentType)) {
      throw new InvalidTransitionError(order.status, "cancelled");
    }
    // The status guard in the WHERE makes the UPDATE itself the serialization
    // point: under READ COMMITTED it re-evaluates against the latest committed
    // row version after any blocking writer commits, so exactly one concurrent
    // writer wins and the loser sees no row.
    const [updated] = await tx.update(orders)
      .set({ status: "cancelled", cancelReason: "cancelled_by_customer", updatedAt: new Date() })
      .where(and(eq(orders.id, order.id), eq(orders.status, "pending")))
      .returning();
    if (!updated) throw new InvalidTransitionError(order.status, "cancelled");
    await restockOrderItems(tx, order.id, caps);
    await tx.insert(orderStatusEvents).values({
      tenantId, orderId: order.id, fromStatus: order.status, toStatus: "cancelled",
      changedByUserId: null, reason: "cancelled_by_customer",
    });
    return updated;
  });
}

export async function getOrder(tenantId: string, orderId: string): Promise<OrderDetail> {
  return withTenant(tenantId, async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new OrderNotFoundError();
    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    const events = await tx.select().from(orderStatusEvents).where(eq(orderStatusEvents.orderId, orderId)).orderBy(orderStatusEvents.createdAt);
    return { ...order, items, events };
  });
}

export type ListOrdersOpts = { branchId?: string; status?: OrderStatus; limit?: number };

export async function listOrders(tenantId: string, opts: ListOrdersOpts): Promise<Order[]> {
  return withTenant(tenantId, (tx) => {
    const conds = [];
    if (opts.branchId) conds.push(eq(orders.branchId, opts.branchId));
    if (opts.status) conds.push(eq(orders.status, opts.status));
    const base = tx.select().from(orders);
    const q = conds.length > 0 ? base.where(and(...conds)) : base;
    return q.orderBy(desc(orders.placedAt)).limit(opts.limit ?? 100);
  });
}

/** The compact order shape the dashboard list (SSR + polling endpoint) renders. */
export type OrderRow = Pick<Order, "id" | "orderNumber" | "customerName" | "fulfillmentType" | "total" | "status" | "paymentStatus"> & {
  scheduledFor: string | null;
};

export function toOrderRow(o: Order): OrderRow {
  const { id, orderNumber, customerName, fulfillmentType, total, status, paymentStatus } = o;
  return {
    id, orderNumber, customerName, fulfillmentType, total, status, paymentStatus,
    scheduledFor: o.scheduledFor ? o.scheduledFor.toISOString() : null,
  };
}

export async function pendingOrderCount(tenantId: string): Promise<number> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select({ c: sql<number>`COUNT(*)` }).from(orders).where(eq(orders.status, "pending")),
  );
  return Number(row.c);
}

export async function ordersThisMonthCount(tenantId: string): Promise<number> {
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select({ c: sql<number>`COUNT(*)` }).from(orders).where(gte(orders.placedAt, periodStart)),
  );
  return Number(row.c);
}

export async function transitionStatus(tenantId: string, orderId: string, to: OrderStatus, userId: string, reason?: string): Promise<Order> {
  const tenant = await getTenantById(tenantId);
  const caps = getCapabilities((tenant?.vertical ?? "restaurant") as VerticalId);
  return withTenant(tenantId, async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new OrderNotFoundError();
    if (!canTransition(order.status, to, order.fulfillmentType)) throw new InvalidTransitionError(order.status, to);
    const setCancel = (to === "cancelled" || to === "rejected") && reason ? { cancelReason: reason } : {};
    // Guarded UPDATE serializes against concurrent writers (see cancelOrderByToken).
    const [updated] = await tx.update(orders)
      .set({ status: to, updatedAt: new Date(), ...setCancel })
      .where(and(eq(orders.id, orderId), eq(orders.status, order.status)))
      .returning();
    if (!updated) throw new InvalidTransitionError(order.status, to);
    if (to === "cancelled" || to === "rejected") await restockOrderItems(tx, orderId, caps);
    await tx.insert(orderStatusEvents).values({ tenantId, orderId, fromStatus: order.status, toStatus: to, changedByUserId: userId, reason: reason ?? null });
    return updated;
  });
}

export async function markPaid(tenantId: string, orderId: string, _userId: string): Promise<Order> {
  return withTenant(tenantId, async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new OrderNotFoundError();
    // A rejected/cancelled order can't be paid — guard the terminal-failure states.
    if (order.status === "cancelled" || order.status === "rejected") {
      throw new InvalidTransitionError(order.status, "paid");
    }
    const [updated] = await tx.update(orders)
      .set({ paymentStatus: "paid", updatedAt: new Date() })
      .where(eq(orders.id, orderId)).returning();
    return updated;
  });
}

/** Merchant confirms an offline payment: pending_verification → paid. Guarded + idempotent.
 * No orderStatusEvents row: that table's toStatus tracks order.status (the fulfillment
 * state machine), not paymentStatus, and there's no unchanged-status audit row to write —
 * the guarded UPDATE (WHERE paymentStatus = 'pending_verification') is itself the audit
 * trail / idempotency source of truth. */
export async function confirmOrderPayment(tenantId: string, orderId: string, _userId: string): Promise<Order> {
  return withTenant(tenantId, async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new OrderNotFoundError();
    if (order.paymentStatus !== "pending_verification") throw new PaymentAlreadyResolvedError();
    // Guarded UPDATE serializes against concurrent writers (see cancelOrderByToken).
    const [updated] = await tx.update(orders)
      .set({ paymentStatus: "paid", updatedAt: new Date() })
      .where(and(eq(orders.id, orderId), eq(orders.paymentStatus, "pending_verification")))
      .returning();
    if (!updated) throw new PaymentAlreadyResolvedError();
    return updated;
  });
}

/** Merchant rejects an offline payment: cancel the order + restock.
 * Reuses the dashboard cancel path (guarded UPDATE + restock + status-event audit row)
 * already in transitionStatus, so cancelling for a bad/missing payment looks identical
 * to any other dashboard cancel in the order's history. */
export async function rejectOrderPayment(tenantId: string, orderId: string, userId: string, reason?: string): Promise<Order> {
  const [order] = await withTenant(tenantId, (tx) => tx.select().from(orders).where(eq(orders.id, orderId)).limit(1));
  if (!order) throw new OrderNotFoundError();
  if (order.paymentStatus !== "pending_verification") throw new PaymentAlreadyResolvedError();
  return transitionStatus(tenantId, orderId, "cancelled", userId, reason ?? "offline_payment_rejected");
}
