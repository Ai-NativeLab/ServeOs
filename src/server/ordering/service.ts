import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { requireFeature, incrementUsage } from "@/server/entitlements/service";
import { getVatRate } from "@/server/tenancy/settings";
import { isBranchOrderable } from "@/server/branches/orderability";
import { branches, deliveryAreas } from "@/server/branches/schema";
import { products, modifierGroups, modifierOptions, branchProductAvailability } from "@/server/catalog/schema";
import { orders, orderItems, orderStatusEvents, type SelectedModifier } from "./schema";
import { OrderValidationError, BranchNotAcceptingOrdersError, AreaNotDeliverableError, MinimumOrderNotMetError } from "./errors";

export type PlaceOrderLine = { productId: string; quantity: number; selectedOptionIds: string[] };
export type PlaceOrderInput = {
  branchId: string;
  fulfillmentType: "pickup" | "delivery";
  customerName: string;
  customerPhone: string;
  notes?: string;
  areaId?: string;
  addressText?: string;
  lines: PlaceOrderLine[];
  now?: Date;
};
export type PlaceOrderResult = { orderId: string; orderNumber: number; statusToken: string };

/** Round to 2 decimals and format as a numeric string for Postgres. */
export function money(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

export async function placeOrder(tenantId: string, input: PlaceOrderInput): Promise<PlaceOrderResult> {
  if (!input.lines || input.lines.length === 0) throw new OrderValidationError("empty cart");
  if (!input.customerName.trim() || !input.customerPhone.trim()) throw new OrderValidationError("missing customer details");

  await requireFeature(tenantId, "online_ordering");
  const vatRate = await getVatRate(tenantId);
  const now = input.now ?? new Date();

  const result = await withTenant(tenantId, async (tx) => {
    // Serialize order-number generation per tenant.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId})::bigint)`);

    // 1. Branch + orderability
    const [branch] = await tx.select().from(branches).where(eq(branches.id, input.branchId)).limit(1);
    if (!branch) throw new OrderValidationError("unknown branch");
    if (!isBranchOrderable(branch, now)) throw new BranchNotAcceptingOrdersError();

    // 2. Validate each line against the catalog; build snapshots.
    let subtotal = 0;
    const itemsToInsert: Array<{ productId: string; nameEn: string; nameAr: string; unitBasePrice: string; quantity: number; lineTotal: string; selectedModifiers: SelectedModifier[] }> = [];

    for (const line of input.lines) {
      if (!Number.isInteger(line.quantity) || line.quantity < 1) throw new OrderValidationError("bad quantity");

      const [product] = await tx.select().from(products).where(and(eq(products.id, line.productId), eq(products.isPublished, true))).limit(1);
      if (!product) throw new OrderValidationError("product unavailable");

      const [avail] = await tx.select().from(branchProductAvailability)
        .where(and(eq(branchProductAvailability.branchId, input.branchId), eq(branchProductAvailability.productId, product.id))).limit(1);
      if (avail && !avail.isAvailable) throw new OrderValidationError("product unavailable at branch");
      const effectiveBase = avail?.priceOverride ?? product.basePrice;

      const groups = await tx.select().from(modifierGroups).where(eq(modifierGroups.productId, product.id));
      const groupIds = groups.map((g) => g.id);
      const opts = groupIds.length > 0
        ? await tx.select().from(modifierOptions).where(inArray(modifierOptions.modifierGroupId, groupIds))
        : [];
      const optById = new Map(opts.map((o) => [o.id, o]));

      const selected = line.selectedOptionIds.map((id) => {
        const o = optById.get(id);
        if (!o) throw new OrderValidationError("invalid modifier selection");
        return o;
      });
      for (const g of groups) {
        const count = selected.filter((o) => o.modifierGroupId === g.id).length;
        if (g.required && count < Math.max(1, g.minSelections)) throw new OrderValidationError("required modifier missing");
        if (count < g.minSelections) throw new OrderValidationError("too few modifier selections");
        if (count > g.maxSelections) throw new OrderValidationError("too many modifier selections");
      }

      const modifiersTotal = selected.reduce((s, o) => s + Number(o.priceDelta), 0);
      const unit = Number(effectiveBase) + modifiersTotal;
      const lineTotal = unit * line.quantity;
      subtotal += lineTotal;

      const snapshot: SelectedModifier[] = selected.map((o) => {
        const g = groups.find((gg) => gg.id === o.modifierGroupId)!;
        return { groupNameEn: g.nameEn, groupNameAr: g.nameAr, optionNameEn: o.nameEn, optionNameAr: o.nameAr, priceDelta: o.priceDelta };
      });

      itemsToInsert.push({
        productId: product.id, nameEn: product.nameEn, nameAr: product.nameAr,
        unitBasePrice: String(effectiveBase), quantity: line.quantity, lineTotal: money(lineTotal), selectedModifiers: snapshot,
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

    // 4. Totals
    const vatAmount = subtotal * (vatRate / 100);
    const total = subtotal + vatAmount + deliveryFee;

    // 5. Order number (per-tenant max+1, under the advisory lock above)
    const [{ next }] = await tx.select({ next: sql<number>`COALESCE(MAX(${orders.orderNumber}), 0) + 1` }).from(orders);
    const orderNumber = Number(next);
    const statusToken = randomUUID();

    // 6. Insert order + items + initial status event
    const [order] = await tx.insert(orders).values({
      tenantId, branchId: input.branchId, orderNumber,
      fulfillmentType: input.fulfillmentType, status: "pending",
      customerName: input.customerName.trim(), customerPhone: input.customerPhone.trim(), notes: input.notes?.trim() || null,
      deliveryAreaId, deliveryAreaNameSnapshot: deliveryAreaName, deliveryAddressText: deliveryAddress,
      subtotal: money(subtotal), vatRateSnapshot: money(vatRate), vatAmount: money(vatAmount), deliveryFee: money(deliveryFee), total: money(total),
      statusToken,
    }).returning();

    await tx.insert(orderItems).values(itemsToInsert.map((i) => ({ ...i, tenantId, orderId: order.id })));
    await tx.insert(orderStatusEvents).values({ tenantId, orderId: order.id, fromStatus: null, toStatus: "pending" });

    return { orderId: order.id, orderNumber, statusToken };
  });

  // Meter usage (control table, outside the tenant tx). No hard cap in v1.
  await incrementUsage(tenantId, "orders");
  return result;
}
