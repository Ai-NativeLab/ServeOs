import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { requireFeature, incrementUsage } from "@/server/entitlements/service";
import { getCheckoutPricing, getAllowNegativeStock } from "@/server/tenancy/settings";
import { deductForOrderLine, reverseOrderDeductions } from "@/server/inventory/service";
import { computeOrderTotals, computeLineTotal } from "@/lib/order-totals";
import { computeDimensionalUnitPrice } from "@/server/catalog/dimensional-pricing";
import { isDimensionalUom } from "@/server/catalog/uom";
import { customers } from "@/server/customers/schema";
import { prescriptions } from "@/server/prescriptions/schema";
import { isBranchOrderableAt, isWithinSchedulingHorizon, MIN_LEAD_MINUTES } from "@/server/branches/slots";
import { getTenantById } from "@/server/tenancy";
import { branches, deliveryAreas } from "@/server/branches/schema";
import { products, modifierGroups, modifierOptions, branchProductAvailability, productVariants } from "@/server/catalog/schema";
import { InvalidVariantError } from "@/server/catalog/errors";
import { getCapabilities, type VerticalId } from "@/server/verticals";
import { isMethodEnabled } from "@/server/payments/offline/methods";
import { PaymentMethodNotEnabledError, InvalidProofError, PaymentAlreadyResolvedError } from "@/server/payments/offline";
import { sanitizeHttpUrl } from "@/lib/safe-url";
import { orders, orderItems, orderStatusEvents, type SelectedModifier, type Order, type OrderWithItems, type OrderDetail, type OrderStatus } from "./schema";
import { canTransition } from "./state-machine";
// OutOfStockError is no longer thrown here — the inventory service raises it
// from the FIFO deduction, on this same transaction, so the order still rolls back.
import { OrderValidationError, BranchNotAcceptingOrdersError, AreaNotDeliverableError, MinimumOrderNotMetError, OrderNotFoundError, InvalidTransitionError, InvalidScheduleError, TotalMismatchError } from "./errors";
import { recordAuditEvent, type AuditFingerprint } from "@/server/audit/service";
import { publishTenantEvent } from "@/server/realtime/publish";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { enqueueStatusUpdate } from "@/server/whatsapp/status-updates";
import type { AuditActorType } from "@/server/audit/canonical";

export type PlaceOrderLine = {
  productId: string;
  variantId?: string;
  quantity: number;
  selectedOptionIds: string[];
  discountAmount?: number;
  discountReason?: string;
  note?: string;
  /** P4: required when the product is dimensional (unitOfMeasure set),
   *  rejected when it isn't — never silently ignored either way. */
  dimensions?: { lengthMm?: number; widthMm?: number; thicknessMm?: number };
};
/** One modifier selection as the till itself recorded it — ids AND names,
 *  because a replayed line may resolve against a catalog where the id no
 *  longer exists but the name is still what the receipt must show. */
export type LineSnapshotModifier = {
  groupId: string;
  optionId: string;
  groupNameEn: string;
  groupNameAr: string;
  optionNameEn: string;
  optionNameAr: string;
  priceDelta: number;
};

/**
 * The till's own record of what a line was worth, carried by a replayed sale
 * event (`PlaceOrderInput.replay`). This is the fallback source of truth per
 * the offline-sync design: when live-catalog resolution fails (product
 * unpublished/deleted, variant/option missing) or the live price disagrees
 * with what's here, the order records THESE names/prices instead of the live
 * ones. `unitPrice` is the effective per-unit price the till charged —
 * post-modifiers/post-variant, the same quantity `computeLineTotal` would
 * multiply — not the bare product base price.
 */
export type LineSnapshot = {
  productId: string;
  productNameEn: string;
  productNameAr: string;
  variantId?: string;
  variantNameEn?: string;
  variantNameAr?: string;
  modifiers?: LineSnapshotModifier[];
  unitPrice: number;
  quantity: number;
  lineTotal: number;
  discountAmount?: number;
};

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
  channel?: "web" | "pos" | "whatsapp";
  cashierUserId?: string;
  /** Server-resolved from the customer session — NEVER accepted from a client body. */
  customerId?: string;
  orderDiscountAmount?: number;
  orderDiscountReason?: string;
  /** What the client displayed. Compared, never trusted. */
  expectedTotal?: number;
  audit?: { fingerprint: AuditFingerprint; actorUserId?: string | null; actorType?: AuditActorType };
  /**
   * Till-wins replay (offline-sync design doc): the device is the authority
   * for what actually happened at its till while it was offline — the server
   * may flag, never veto. When set: `occurredAt` becomes `now` for the
   * orderability/scheduling check AND the order's `placedAt` (a till
   * reconnecting at 8:30am replaying last night's sales must not be refused
   * because the branch "isn't open yet"); the `expectedTotal`/TOTAL_MISMATCH
   * 409 is skipped entirely; and any line whose live resolution fails or
   * whose live price disagrees with `lineSnapshots[i]` is built from that
   * snapshot instead of throwing. `catalogVersion` (if known) travels into
   * the resulting `pos.replay.price_drift` audit event for diagnosis only.
   */
  replay?: { occurredAt: Date; lineSnapshots: LineSnapshot[]; catalogVersion?: number };
  /** Runs inside the SAME transaction after the order is written. POS uses this
   *  to make tenders + receipt atomic with the order. Throwing rolls everything back. */
  onPlaced?: (tx: Parameters<Parameters<typeof withTenant>[1]>[0], placed: PlaceOrderResult) => Promise<void>;
};
export type PlaceOrderResult = {
  orderId: string;
  orderNumber: number;
  statusToken: string;
  total: number;
  /** Index-aligned with input.lines. */
  itemIds: string[];
};

/** Round to 2 decimals and format as a numeric string for Postgres. */
export function money(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/** Only http(s) URLs are safe to persist/render as an href — a customer-supplied
 * `javascript:`/`data:` proof URL would be stored XSS the first time a merchant
 * clicks "View screenshot" in the payments queue. Anything else is dropped (stored
 * as null) rather than trusted; the reference/screenshot are informational only
 * per the manual-payments spec, never authoritative. */
const sanitizeProofUrl = sanitizeHttpUrl;

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
    paymentProofUrl = sanitizeProofUrl(input.paymentProofUrl);
  }

  await requireFeature(tenantId, "online_ordering");
  const pricing = await getCheckoutPricing(tenantId);
  // Replay: every time-dependent check evaluates as of the till's own clock,
  // not whenever the reconnect happens to land.
  const now = input.replay?.occurredAt ?? input.now ?? new Date();

  const tenant = await getTenantById(tenantId);
  if (!tenant) throw new OrderValidationError("unknown tenant");
  const tz = tenant.timezone;
  const caps = getCapabilities(tenant.vertical as VerticalId);
  // Resolved outside the transaction: it is a tenant policy, not per-line state.
  // Restaurants default to true so a kitchen is never blocked at the till;
  // retail defaults to false so a shortfall still refuses the sale.
  const allowNegative = caps.inventory ? await getAllowNegativeStock(tenantId) : false;

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
    // P3: does this cart contain anything prescription-only? Only meaningful
    // where the vertical actually reviews scripts — a retail tenant with a
    // stray flag is untouched. Only ever set from a LIVE product row — a line
    // that fell back to its replay snapshot has no live row to ask, so Rx
    // gating can't see it; out of scope for till-wins (no replayed cart is
    // expected to carry prescription items today).
    let hasRxLine = false;
    const itemsToInsert: Array<{ productId: string; variantId: string | null; variantNameEn: string | null; variantNameAr: string | null; nameEn: string; nameAr: string; unitBasePrice: string; quantity: number; lineTotal: string; discountAmount: string; selectedModifiers: SelectedModifier[]; dimensions: PlaceOrderLine["dimensions"] | null }> = [];
    // Till-wins bookkeeping (replay only, stays empty on a live order): every
    // line whose live resolution failed outright — unpublished/deleted
    // product, missing variant/option. Price-only disagreement (live
    // resolved fine, just to a different number) is NOT an entity miss, so
    // it doesn't appear here — see anyDrift for that half of the picture.
    const missingEntities: Array<{ lineIndex: number; productId: string; variantId?: string; reason: string }> = [];
    let anyDrift = false;

    /** Resolves ONE line against the live catalog — unchanged from the
     *  pre-replay behavior. Throws OrderValidationError/InvalidVariantError
     *  for anything the catalog can't stand behind right now; the caller
     *  below decides whether that's fatal (a live order) or a fallback to
     *  the till's own snapshot (replay). */
    const resolveLiveLine = async (line: PlaceOrderLine) => {
      const [product] = await tx.select().from(products).where(and(eq(products.id, line.productId), eq(products.isPublished, true))).limit(1);
      if (!product) throw new OrderValidationError("product unavailable");

      const [avail] = await tx.select().from(branchProductAvailability)
        .where(and(eq(branchProductAvailability.branchId, input.branchId), eq(branchProductAvailability.productId, product.id))).limit(1);
      if (avail && !avail.isAvailable) throw new OrderValidationError("product unavailable at branch");
      const effectiveBase = avail?.priceOverride ?? product.basePrice;

      const requiresRxReview = Boolean(product.requiresPrescription && caps.pharmacistReview);

      let unit: number;
      let selected: Array<typeof modifierOptions.$inferSelect> = [];
      let groups: Array<typeof modifierGroups.$inferSelect> = [];
      let variantId: string | null = null;
      let variantNameEn: string | null = null;
      let variantNameAr: string | null = null;

      if (product.unitOfMeasure && isDimensionalUom(product.unitOfMeasure)) {
        // Dimensional product (P4): basePrice is price-per-unit-of-measure
        // (decision T2), never a fixed each-price — variants/modifiers don't
        // apply to a cut-list line in v1.
        if (line.variantId || line.selectedOptionIds.length > 0) {
          throw new OrderValidationError("variants/modifiers not supported on a dimensional line");
        }
        if (!line.dimensions) throw new OrderValidationError("dimensions required for this product");
        try {
          unit = computeDimensionalUnitPrice(Number(effectiveBase), product.unitOfMeasure, line.dimensions);
        } catch (e) {
          throw new OrderValidationError(e instanceof Error ? e.message : "invalid dimensions");
        }
      } else if (line.dimensions) {
        // Never silently ignore dimensions on a product that isn't priced by them.
        throw new OrderValidationError("dimensions not applicable to this product");
      } else if (line.variantId) {
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

      // Stock is no longer decremented here. The flat integer counter is replaced
      // by the append-only ledger, and deduction happens in one pass after the
      // order items exist (below) so each movement can cite its order-item id.

      const lineDiscount = Math.min(
        Math.max(0, line.discountAmount ?? 0),
        Math.round(unit * line.quantity * 100) / 100,
      );
      const lineTotal = computeLineTotal({ unitPrice: unit, quantity: line.quantity, discountAmount: lineDiscount });

      const snapshot: SelectedModifier[] = selected.map((o) => {
        const g = groups.find((gg) => gg.id === o.modifierGroupId)!;
        return { groupNameEn: g.nameEn, groupNameAr: g.nameAr, optionNameEn: o.nameEn, optionNameAr: o.nameAr, priceDelta: o.priceDelta };
      });

      const row = {
        productId: product.id, variantId, variantNameEn, variantNameAr, nameEn: product.nameEn, nameAr: product.nameAr,
        // A dimensional line has no separate modifier breakdown to show — like a
        // variant, its computed per-piece price IS the unit price, not the raw
        // per-UoM rate. Non-dimensional/non-variant lines keep storing the base
        // (modifiers appear separately in selectedModifiers).
        unitBasePrice: (variantId || product.unitOfMeasure) ? String(unit) : String(effectiveBase),
        quantity: line.quantity, lineTotal: money(lineTotal),
        discountAmount: money(lineDiscount), selectedModifiers: variantId ? [] : snapshot,
        dimensions: product.unitOfMeasure ? (line.dimensions ?? null) : null,
      };
      return { row, unit, lineTotal, requiresRxReview };
    };

    /** Builds the item-insert row straight from the till's own record of the
     *  line — the fallback source of truth on replay. Trusted wholesale:
     *  names, unit price, quantity, and line total all come from the
     *  snapshot, never from whatever (possibly missing, possibly repriced)
     *  live row exists. */
    const lineFromSnapshot = (snap: LineSnapshot) => ({
      productId: snap.productId, variantId: snap.variantId ?? null,
      variantNameEn: snap.variantNameEn ?? null, variantNameAr: snap.variantNameAr ?? null,
      nameEn: snap.productNameEn, nameAr: snap.productNameAr,
      unitBasePrice: String(snap.unitPrice),
      quantity: snap.quantity, lineTotal: money(snap.lineTotal),
      discountAmount: money(snap.discountAmount ?? 0),
      selectedModifiers: (snap.modifiers ?? []).map((m) => ({
        groupNameEn: m.groupNameEn, groupNameAr: m.groupNameAr,
        optionNameEn: m.optionNameEn, optionNameAr: m.optionNameAr, priceDelta: String(m.priceDelta),
      })),
      dimensions: null,
    });

    for (let i = 0; i < input.lines.length; i++) {
      const line = input.lines[i];
      if (!Number.isInteger(line.quantity) || line.quantity < 1) throw new OrderValidationError("bad quantity");

      const snap = input.replay?.lineSnapshots[i];
      let live: Awaited<ReturnType<typeof resolveLiveLine>> | null = null;
      let missingReason: string | null = null;
      try {
        live = await resolveLiveLine(line);
      } catch (err) {
        // Live order (no replay): a catalog rejection is fatal, exactly as
        // before. Replay with no snapshot to fall back to is also fatal —
        // that is an ingestion-payload defect, not catalog drift, and
        // silently fabricating a line with no data would be worse than
        // refusing it.
        if (input.replay && snap && err instanceof OrderValidationError) {
          missingReason = err.detail;
        } else if (input.replay && snap && err instanceof InvalidVariantError) {
          missingReason = err.code;
        } else {
          throw err;
        }
      }

      const priceDrifted = live !== null && snap !== undefined && Math.abs(live.unit - snap.unitPrice) > 0.001;
      if (live && !priceDrifted) {
        itemsToInsert.push(live.row);
        subtotal += live.lineTotal;
        if (live.requiresRxReview) hasRxLine = true;
        continue;
      }

      // Till-wins: live resolution failed outright (missingReason set) or
      // succeeded but disagreed on price (priceDrifted). Either way `snap` is
      // guaranteed here — the catch above only sets missingReason when a
      // snapshot exists, and priceDrifted's own definition requires one.
      itemsToInsert.push(lineFromSnapshot(snap!));
      subtotal += snap!.lineTotal;
      anyDrift = true;
      if (missingReason) {
        missingEntities.push({ lineIndex: i, productId: line.productId, variantId: line.variantId, reason: missingReason });
      }
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

    // 3b. Trade-account discount (P4, decision T5) — a flat % off the gross
    // subtotal, folded into the SAME orderDiscountAmount slot rather than a
    // new pipeline. Capability-gated: a trade-approved customer on a
    // non-timber tenant gets nothing, and a guest (no customerId) never does.
    let tradeDiscountAmount = 0;
    if (input.customerId && caps.tradeAccounts) {
      const [customer] = await tx.select({
        tradeApproved: customers.tradeApproved,
        tradeDiscountPercent: customers.tradeDiscountPercent,
      }).from(customers).where(eq(customers.id, input.customerId)).limit(1);
      if (customer?.tradeApproved && customer.tradeDiscountPercent) {
        tradeDiscountAmount = Math.round(subtotal * (Number(customer.tradeDiscountPercent) / 100) * 100) / 100;
      }
    }

    // 4. Totals — single source of money math (src/lib/order-totals.ts).
    // Each line was already reduced by its own discount via computeLineTotal
    // above, so `subtotal` here is the line-discounted total. The order-level
    // discount further reduces that before computeOrderTotals — called
    // exactly once — applies the service charge and VAT to the final base.
    const orderDiscount = Math.min(Math.max(0, (input.orderDiscountAmount ?? 0) + tradeDiscountAmount), subtotal);
    const totals = computeOrderTotals(pricing, subtotal - orderDiscount, deliveryFee);

    // The register must never quietly charge a different amount than the one
    // shown to the customer. A stale cached catalog lands here.
    // Replay is the one exception: till-wins already resolved every line
    // (live or snapshot) above, and re-litigating the total here would be
    // exactly the 409-that-cannot-happen the design doc rules out — a device
    // reconnecting to flush an outage must never be refused.
    if (!input.replay && input.expectedTotal !== undefined && Math.abs(input.expectedTotal - totals.total) > 0.001) {
      throw new TotalMismatchError(input.expectedTotal, totals.total);
    }

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
    // P3: an Rx cart needs an owner for the compliance trail (decision R3) and
    // a script on file before it can be placed at all.
    let pendingRxId: string | null = null;
    if (hasRxLine) {
      if (!input.customerId) {
        throw new OrderValidationError("prescription items require a signed-in customer account");
      }
      const [pendingRx] = await tx.select({ id: prescriptions.id }).from(prescriptions)
        .where(and(
          eq(prescriptions.tenantId, tenantId),
          eq(prescriptions.customerId, input.customerId),
          eq(prescriptions.status, "pending"),
          isNull(prescriptions.orderId),
        ))
        .orderBy(desc(prescriptions.createdAt))
        .limit(1);
      if (!pendingRx) throw new OrderValidationError("a prescription must be uploaded before ordering these items");
      pendingRxId = pendingRx.id;
    }

    const [order] = await tx.insert(orders).values({
      tenantId, branchId: input.branchId, orderNumber,
      fulfillmentType: input.fulfillmentType, status: "pending",
      rxReviewStatus: hasRxLine ? "pending" : "not_required",
      paymentMethod,
      paymentStatus,
      paymentReference,
      paymentProofUrl,
      channel: input.channel ?? "web",
      cashierUserId: input.cashierUserId ?? null,
      customerId: input.customerId ?? null,
      customerName: input.customerName.trim(), customerPhone: input.customerPhone.trim(), notes: input.notes?.trim() || null,
      deliveryAreaId, deliveryAreaNameSnapshot: deliveryAreaName, deliveryAddressText: deliveryAddress,
      subtotal: money(totals.subtotal),
      vatRateSnapshot: money(totals.vatRate),
      vatAmount: money(totals.vatAmount),
      serviceChargeAmount: totals.serviceChargeAmount > 0 ? money(totals.serviceChargeAmount) : null,
      deliveryFee: money(totals.deliveryFee),
      discountAmount: money(orderDiscount),
      discountReason: input.orderDiscountReason ?? null,
      total: money(totals.total),
      statusToken,
      scheduledFor,
      // Replay: the till's own clock, not whenever the reconnect happened to
      // flush this event — see the `replay` field's doc comment.
      ...(input.replay ? { placedAt: input.replay.occurredAt } : {}),
    }).returning();

    // Bind the script to the order it cleared for — the review decision then
    // moves this exact order's gate, never a later unrelated one.
    if (pendingRxId) {
      await tx.update(prescriptions).set({ orderId: order.id }).where(eq(prescriptions.id, pendingRxId));
    }

    // Inserted one line at a time so each id is unambiguously paired with the
    // line it came from. Postgres does not promise a multi-row INSERT ...
    // RETURNING yields rows in VALUES order, and pairing by index on that
    // assumption would make every sale_deduction cite the wrong order item — a
    // cancel, or a per-line refund, would then restock the wrong product.
    const inserted: { id: string }[] = [];
    for (const i of itemsToInsert) {
      const [row] = await tx.insert(orderItems)
        .values({ ...i, tenantId, orderId: order.id })
        .returning({ id: orderItems.id });
      inserted.push(row);
    }
    await tx.insert(orderStatusEvents).values({ tenantId, orderId: order.id, fromStatus: null, toStatus: "pending" });

    // Inventory deduction — atomic with the order because it runs on THIS tx. A
    // retail shortfall throws OutOfStockError and rolls the whole order back, so
    // no order exists, exactly as the flat-integer guard behaved. A sellable with
    // no product_inventory_links row deducts nothing, which is what lets an
    // untracked product (and a restaurant that has not built recipes yet) sell
    // freely. Deduction is deliberately after the items insert so every
    // sale_deduction row can cite the order-item it came from.
    if (caps.inventory) {
      for (let i = 0; i < itemsToInsert.length; i++) {
        const line = itemsToInsert[i];
        await deductForOrderLine(tx, {
          tenantId, branchId: input.branchId,
          productId: line.productId, variantId: line.variantId,
          quantity: line.quantity, orderItemId: inserted[i].id,
          allowNegative, byUserId: input.cashierUserId ?? null,
          productNameEn: line.nameEn, productNameAr: line.nameAr,
          // Cut-to-size: the length actually cut drives what stock is consumed,
          // so a 2.4m cut takes a board and returns the offcut rather than
          // silently retiring a whole one.
          cutLengthMm: line.dimensions?.lengthMm ?? null,
        });
      }
    }

    await recordAuditEvent(
      {
        tenantId, branchId: input.branchId,
        actorUserId: input.audit?.actorUserId ?? input.cashierUserId ?? null,
        fingerprint: input.audit?.fingerprint ?? emptyFingerprint(),
      },
      {
        action: "order.placed", entityType: "order", entityId: order.id,
        summary: `Order #${orderNumber} placed (${input.channel ?? "web"})`,
        metadata: { orderNumber, channel: input.channel ?? "web", total: money(totals.total) },
        actorType: input.audit?.actorType ?? (input.cashierUserId ? "user" : "customer"),
      },
      tx,
    );

    // Till-wins, flagged: the device is never refused for this, but the
    // cloud's system-of-record still needs to know it happened. One event
    // per order covers every line that drifted — a per-line event would just
    // make the same fact harder to review.
    if (anyDrift) {
      const expectedTotal = input.expectedTotal ?? totals.total;
      await recordAuditEvent(
        {
          tenantId, branchId: input.branchId,
          actorUserId: input.audit?.actorUserId ?? input.cashierUserId ?? null,
          fingerprint: input.audit?.fingerprint ?? emptyFingerprint(),
        },
        {
          action: "pos.replay.price_drift", entityType: "order", entityId: order.id,
          summary: `Order #${orderNumber} replayed with till-wins pricing (${missingEntities.length} missing entit${missingEntities.length === 1 ? "y" : "ies"})`,
          metadata: {
            expectedTotal: money(expectedTotal),
            serverTotal: money(totals.total),
            catalogVersion: input.replay?.catalogVersion ?? null,
            missingEntities,
          },
          actorType: input.audit?.actorType ?? (input.cashierUserId ? "user" : "customer"),
        },
        tx,
      );
    }

    const placed: PlaceOrderResult = { orderId: order.id, orderNumber, statusToken, total: totals.total, itemIds: inserted.map((i) => i.id) };
    // Last statement before the transaction returns: a throw here rolls back
    // the order, its items, the stock deduction, and order.placed together.
    await input.onPlaced?.(tx, placed);
    return placed;
  });

  // Meter usage (control table, outside the tenant tx). By design (spec §2)
  // there is NO hard cap in v1 — orders/month is recorded for visibility only,
  // so checkUsage is intentionally not enforced at placement.
  await incrementUsage(tenantId, "orders");
  // Outside the transaction, after it commits: a broadcast for an order that
  // then rolled back would send every subscriber to refetch a row that never
  // existed. A replayed sale is silent here — its batch publishes once, in
  // ingestEvents, instead of once per event on the flush path.
  if (!input.replay) {
    await publishTenantEvent(tenantId, { type: "orders.changed", entityIds: [result.orderId] });
  }
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

/**
 * Returns a cancelled order's stock by REVERSING the ledger, not by adding an
 * integer back: each `sale_deduction` gets a matching `refund_restock` row
 * against the same lot, so FIFO cost layers stay honest instead of a returned
 * item re-entering stock at the wrong cost. Appending rather than editing is
 * also the only option — the ledger is append-only.
 *
 * Idempotent: reverseOrderDeductions skips a deduction that already has a
 * reversal, so a re-entrant cancel cannot double-restock.
 */
async function restockOrderItems(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string, orderId: string, caps: { inventory: boolean },
): Promise<void> {
  if (!caps.inventory) return;
  await reverseOrderDeductions(tx, { tenantId, orderId });
}

/**
 * Returns specific order-item quantities to stock for a refund. Line- and
 * quantity-scoped (unlike restockOrderItems, which restocks a whole order).
 * FORWARD DEP (Spec 8): when the stock_ledger exists, replace the integer
 * add-back with a `refund_restock` ledger row reversing the original
 * sale_deduction on the same lot (per the inventory spec's restock-on-refund
 * path). Until then this is the integer fallback; a no-op for verticals with
 * stockTracking off (e.g. restaurant).
 */
export async function restockRefundedLines(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  lines: { orderItemId: string; quantity: number; restock: boolean }[],
): Promise<void> {
  const toRestock = lines.filter((l) => l.restock && l.quantity > 0);
  if (toRestock.length === 0) return;
  const tenant = await getTenantById(tenantId);
  const caps = getCapabilities((tenant?.vertical ?? "restaurant") as VerticalId);
  if (!caps.stockTracking) return;
  for (const l of toRestock) {
    const [item] = await tx.select().from(orderItems).where(eq(orderItems.id, l.orderItemId)).limit(1);
    if (!item) continue;
    if (item.variantId) {
      await tx.update(productVariants)
        .set({ stockQuantity: sql`${productVariants.stockQuantity} + ${l.quantity}` })
        .where(eq(productVariants.id, item.variantId));
    } else {
      await tx.update(products)
        .set({ stockQuantity: sql`${products.stockQuantity} + ${l.quantity}` })
        .where(and(eq(products.id, item.productId), eq(products.trackStock, true)));
    }
  }
}

/** Customer-initiated cancel, authorised by possession of the status token.
 * Policy: only while still `pending` — once the restaurant confirms, the
 * customer escalates via phone/WhatsApp instead. Dashboard cancels keep their
 * wider state-machine rights via transitionStatus. */
export async function cancelOrderByToken(tenantId: string, token: string, audit?: { fingerprint: AuditFingerprint }): Promise<Order> {
  const tenant = await getTenantById(tenantId);
  const caps = getCapabilities((tenant?.vertical ?? "restaurant") as VerticalId);
  const cancelled = await withTenant(tenantId, async (tx) => {
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
    await restockOrderItems(tx, tenantId, order.id, caps);
    await tx.insert(orderStatusEvents).values({
      tenantId, orderId: order.id, fromStatus: order.status, toStatus: "cancelled",
      changedByUserId: null, reason: "cancelled_by_customer",
    });
    await recordAuditEvent(
      { tenantId, branchId: updated.branchId, actorUserId: null, fingerprint: audit?.fingerprint ?? emptyFingerprint() },
      { action: "order.cancelled", entityType: "order", entityId: order.id,
        summary: `Order cancelled by customer`, metadata: { reason: "cancelled_by_customer" }, actorType: "customer" },
      tx,
    );
    return updated;
  });
  // Post-commit (see placeOrder). A customer walking away must reach the
  // kitchen as fast as any other status change — the relaxed poll is not
  // where staff should learn about it.
  await publishTenantEvent(tenantId, { type: "orders.changed", entityIds: [cancelled.id] });
  return cancelled;
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

/** Orders sitting in the merchant's manual-payment review queue (offline transfer proof pending), newest first. */
export async function listAwaitingPaymentOrders(tenantId: string): Promise<Order[]> {
  return withTenant(tenantId, (tx) =>
    tx.select().from(orders).where(eq(orders.paymentStatus, "pending_verification")).orderBy(desc(orders.placedAt)),
  );
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

export async function transitionStatus(tenantId: string, orderId: string, to: OrderStatus, userId: string, reason?: string, audit?: { fingerprint: AuditFingerprint }): Promise<Order> {
  const tenant = await getTenantById(tenantId);
  const caps = getCapabilities((tenant?.vertical ?? "restaurant") as VerticalId);
  const updated = await withTenant(tenantId, async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new OrderNotFoundError();
    if (!canTransition(order.status, to, order.fulfillmentType)) throw new InvalidTransitionError(order.status, to);
    // P3: a script still awaiting (or refused by) a pharmacist blocks release
    // into fulfilment. Cancelling/rejecting stays available — a blocked order
    // must never be stuck.
    if (order.rxReviewStatus === "pending" && to !== "cancelled" && to !== "rejected") {
      throw new InvalidTransitionError(order.status, to);
    }
    const setCancel = (to === "cancelled" || to === "rejected") && reason ? { cancelReason: reason } : {};
    // Guarded UPDATE serializes against concurrent writers (see cancelOrderByToken).
    const [updated] = await tx.update(orders)
      .set({ status: to, updatedAt: new Date(), ...setCancel })
      .where(and(eq(orders.id, orderId), eq(orders.status, order.status)))
      .returning();
    if (!updated) throw new InvalidTransitionError(order.status, to);
    if (to === "cancelled" || to === "rejected") await restockOrderItems(tx, tenantId, orderId, caps);
    // WhatsApp orders announce confirmed/ready/out_for_delivery back into the
    // chat — enqueued here so the row commits with the transition, sent later
    // by the scheduled worker (Phase 3, D7).
    await enqueueStatusUpdate(tx, updated, to);
    await tx.insert(orderStatusEvents).values({ tenantId, orderId, fromStatus: order.status, toStatus: to, changedByUserId: userId, reason: reason ?? null });
    await recordAuditEvent(
      { tenantId, branchId: updated.branchId, actorUserId: userId, fingerprint: audit?.fingerprint ?? emptyFingerprint() },
      { action: "order.status_changed", entityType: "order", entityId: orderId,
        summary: `Order status ${order.status} → ${to}`,
        metadata: { before: order.status, after: to, reason: reason ?? null }, actorType: "user" },
      tx,
    );
    return updated;
  });
  // Post-commit (see placeOrder): the queue screens the customer and the till
  // are watching refetch on this, so a status the dashboard just set is on the
  // storefront within a second instead of on the next poll.
  await publishTenantEvent(tenantId, { type: "orders.changed", entityIds: [orderId] });
  return updated;
}

export async function markPaid(tenantId: string, orderId: string, userId: string, audit?: { fingerprint: AuditFingerprint }): Promise<Order> {
  const paid = await withTenant(tenantId, async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new OrderNotFoundError();
    // A rejected/cancelled order can't be paid — guard the terminal-failure states.
    if (order.status === "cancelled" || order.status === "rejected") {
      throw new InvalidTransitionError(order.status, "paid");
    }
    // An offline payment awaiting verification must be resolved via
    // confirmOrderPayment/the payments queue (owner/manager-gated), not this
    // cash mark-paid path (staff-gated on orders:manage) — otherwise staff
    // could side-step the payments:confirm authorization boundary.
    if (order.paymentStatus === "pending_verification") {
      throw new InvalidTransitionError(order.paymentStatus, "paid");
    }
    const [updated] = await tx.update(orders)
      .set({ paymentStatus: "paid", updatedAt: new Date() })
      .where(eq(orders.id, orderId)).returning();
    await recordAuditEvent(
      { tenantId, branchId: updated.branchId, actorUserId: userId, fingerprint: audit?.fingerprint ?? emptyFingerprint() },
      { action: "order.marked_paid", entityType: "order", entityId: orderId,
        summary: `Order marked paid`, metadata: { total: updated.total }, actorType: "user" },
      tx,
    );
    return updated;
  });
  // Post-commit (see placeOrder).
  await publishTenantEvent(tenantId, { type: "orders.changed", entityIds: [orderId] });
  return paid;
}

/** Merchant confirms an offline payment: pending_verification → paid. Guarded + idempotent.
 * No orderStatusEvents row: that table's toStatus tracks order.status (the fulfillment
 * state machine), not paymentStatus, and there's no unchanged-status audit row to write —
 * the guarded UPDATE (WHERE paymentStatus = 'pending_verification') is itself the audit
 * trail / idempotency source of truth.
 *
 * The guard also excludes terminal order states (cancelled/rejected) so a confirm can
 * never land on an order that's already been rejected: rejectOrderPayment claims
 * paymentStatus → 'unpaid' before it cancels, so the paymentStatus half of the guard
 * already blocks confirm-after-reject; the status exclusion here is defense in depth
 * against any other path that could cancel/reject an order without first resolving
 * its pending_verification payment. */
/**
 * `userId` is the human who accepted the money, or null when a provider
 * callback resolved it — a webhook has no person behind it, and recording a
 * synthetic id as though it were one would put a lie in the audit chain.
 */
export async function confirmOrderPayment(
  tenantId: string,
  orderId: string,
  userId: string | null,
  audit?: { fingerprint: AuditFingerprint },
): Promise<Order> {
  const confirmed = await withTenant(tenantId, async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new OrderNotFoundError();
    if (order.paymentStatus !== "pending_verification") throw new PaymentAlreadyResolvedError();
    // Mirrors markPaid's terminal-state guard: a cancelled/rejected order can't be paid.
    if (order.status === "cancelled" || order.status === "rejected") throw new PaymentAlreadyResolvedError();
    // Guarded UPDATE serializes against concurrent writers (see cancelOrderByToken).
    const [updated] = await tx.update(orders)
      .set({ paymentStatus: "paid", updatedAt: new Date() })
      .where(and(
        eq(orders.id, orderId),
        eq(orders.paymentStatus, "pending_verification"),
        notInArray(orders.status, ["cancelled", "rejected"]),
      ))
      .returning();
    if (!updated) throw new PaymentAlreadyResolvedError();

    // Accepting money is a financial state change with a named actor, so it
    // belongs in the chain (D1). The rejection path is audited too, via the
    // cancellation it delegates to.
    await recordAuditEvent(
      {
        tenantId,
        branchId: updated.branchId,
        actorUserId: userId,
        fingerprint: audit?.fingerprint ?? emptyFingerprint(),
      },
      {
        action: "payment.confirmed",
        entityType: "order",
        entityId: orderId,
        summary: `Offline payment confirmed for order #${updated.orderNumber}`,
        metadata: {
          paymentMethod: updated.paymentMethod,
          paymentReference: updated.paymentReference ?? null,
          total: updated.total,
        },
        actorType: userId ? "user" : "system",
      },
      tx,
    );
    return updated;
  });
  // Post-commit (see placeOrder). The payments queue is a shared work list —
  // a colleague's confirmation should drop the row off everyone's screen.
  await publishTenantEvent(tenantId, { type: "orders.changed", entityIds: [orderId] });
  return confirmed;
}

/** Merchant rejects an offline payment: cancel the order + restock.
 * Before touching anything, we verify the downstream cancel would actually succeed
 * (canTransition(order.status, "cancelled", ...)) — if the order is already in a
 * terminal/non-cancellable status this throws InvalidTransitionError immediately,
 * with zero mutation. Without this pre-check, a half-applied write was possible:
 * the claim below would flip paymentStatus to 'unpaid' (dropping the order out of
 * the awaiting-payment queue) and only then would transitionStatus discover the
 * cancel is invalid and throw — leaving the order stuck as unpaid with no cancel
 * and no restock. This pre-check makes reject all-or-nothing for that case.
 *
 * Once the pre-check passes, we atomically CLAIM the payment (guarded UPDATE
 * paymentStatus 'pending_verification' → 'unpaid') in its own withTenant
 * transaction — this is the serialization point: it moves paymentStatus off
 * pending_verification so a racing confirmOrderPayment can no longer win (its
 * guard requires paymentStatus = 'pending_verification'). Only once the claim
 * succeeds do we cancel + restock, reusing the dashboard cancel path (guarded
 * UPDATE + restock + status-event audit row) already in transitionStatus, so
 * cancelling for a bad/missing payment looks identical to any other dashboard
 * cancel in the order's history. */
export async function rejectOrderPayment(tenantId: string, orderId: string, userId: string, reason?: string): Promise<Order> {
  await withTenant(tenantId, async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new OrderNotFoundError();
    if (!canTransition(order.status, "cancelled", order.fulfillmentType)) {
      throw new InvalidTransitionError(order.status, "cancelled");
    }
    const [claimed] = await tx.update(orders)
      .set({ paymentStatus: "unpaid", updatedAt: new Date() })
      .where(and(eq(orders.id, orderId), eq(orders.paymentStatus, "pending_verification")))
      .returning();
    if (!claimed) throw new PaymentAlreadyResolvedError();
  });
  return transitionStatus(tenantId, orderId, "cancelled", userId, reason ?? "offline_payment_rejected");
}
