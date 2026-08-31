import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { placeOrder, money, type PlaceOrderLine, type LineSnapshot } from "@/server/ordering/service";
import { orders } from "@/server/ordering/schema";
import { users } from "@/server/auth/schema";
import type { Permission } from "@/server/rbac/permissions";
import { posOrderReceipts, posSyncEventReceipts } from "./schema";
import { orderPayments, posAdjustmentEvents } from "./tender-schema";
import { posShifts, type PosShift } from "./shift-schema";
import { findOpenShift } from "./shifts";
import { resolveAuthorizer } from "./grants";
import type { SyncReceipt } from "./sync-receipt";
import { NoOpenShiftError, PosForbiddenError, PosSaleError } from "./errors";
import type { PosCashierContext } from "./require-cashier";
import { recordAuditEvent } from "@/server/audit/service";
import { isFiscalEnabled, enqueueFiscalDocument } from "@/server/fiscal/enqueue";

export const REASON_CODES = [
  "staff_meal", "comp_service", "promo", "manager_discretion",
  "wrong_item", "customer_changed_mind", "other",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export type TenderInput = {
  clientPaymentId: string;
  method: "cash" | "card" | "other";
  amount: number;
  tipAmount?: number;
  tenderedAmount?: number;
  reference?: string;
};

export type RecordSaleInput = {
  clientOrderId: string;
  lines: PlaceOrderLine[];
  orderDiscountAmount?: number;
  orderDiscountReason?: ReasonCode;
  expectedTotal: number;
  payments: TenderInput[];
  grants?: { permission: Permission; token: string }[];
  notes?: string;
  /** Replay-only shift resolution: the id the device minted while opening the
   *  drawer offline. When set, the drawer is resolved by (deviceId,
   *  clientShiftId) instead of "whichever shift is open" — see
   *  resolveReplayShift. Ignored (findOpenShift governs) when absent. */
  clientShiftId?: string;
  /** Replay-only: the server shiftId, for a sale replaying against a shift
   *  that was opened online (so it never had a clientShiftId). */
  shiftId?: string;
  /** Till-wins replay (offline-sync design doc). Forwarded verbatim into
   *  placeOrder's own `replay` input — see PlaceOrderInput.replay for what
   *  it does to line validation, `now`, and the TOTAL_MISMATCH check. */
  replay?: { occurredAt: Date; lineSnapshots: LineSnapshot[]; catalogVersion?: number };
  /**
   * Replay-only substitute for a live grant token: a live cashier/grant token
   * cannot exist after the outage that produced this event, so a synced
   * discount names its manager directly. Validated in-tenant below; ignored
   * unless `replay` is set — recordSale is the enforcement point, so even a
   * caller upstream that forgets to strip this from live input can't use it
   * to forge an authorizer.
   */
  authorizedByUserId?: string;
  /** Sync-ingest bookkeeping only (Task 6b) — recordSale's own idempotency is
   *  clientOrderId (below), never this. Written atomically with the sale so
   *  (a) a concurrent duplicate ingest has something to race on beyond
   *  pos_order_receipts_device_client, and (b) lastReceiptSeq's ordering-gap
   *  watermark advances for sale events the same as every other synced type. */
  syncReceipt?: SyncReceipt;
};

export type SaleReceipt = {
  orderId: string;
  orderNumber: string;
  total: number;
  paidAmount: number;
  changeAmount: number;
  paymentStatus: "paid" | "partially_paid";
  idempotent: boolean;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Resolves the drawer a replayed sale stamps its tenders against: by the
 * client-minted shift id if the shift was opened offline, or by the server
 * id if it was opened online. Unlike findOpenShift, this does not filter on
 * status = 'open' — a shift the device closed before this event's turn to
 * replay is still the right drawer, just closed (see shiftClosedAtReplay).
 */
async function resolveReplayShift(
  tenantId: string,
  deviceId: string,
  ref: { clientShiftId?: string; shiftId?: string },
): Promise<PosShift | null> {
  return withTenant(tenantId, async (tx) => {
    if (ref.clientShiftId) {
      const [s] = await tx.select().from(posShifts)
        .where(and(eq(posShifts.deviceId, deviceId), eq(posShifts.clientShiftId, ref.clientShiftId)))
        .limit(1);
      if (s) return s;
    }
    if (ref.shiftId) {
      const [s] = await tx.select().from(posShifts)
        .where(and(eq(posShifts.deviceId, deviceId), eq(posShifts.id, ref.shiftId)))
        .limit(1);
      if (s) return s;
    }
    return null;
  });
}

export async function recordSale(ctx: PosCashierContext, input: RecordSaleInput): Promise<SaleReceipt> {
  // Idempotency: a retried submit returns the original sale rather than
  // charging the customer twice. `pos_order_receipts` has no RLS.
  const [existing] = await db
    .select()
    .from(posOrderReceipts)
    .where(and(
      eq(posOrderReceipts.deviceId, ctx.deviceId),
      eq(posOrderReceipts.clientOrderId, input.clientOrderId),
    ))
    .limit(1);

  if (existing) {
    const [order] = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(orders).where(eq(orders.id, existing.orderId)).limit(1),
    );
    const tenders = await db.select().from(orderPayments).where(eq(orderPayments.orderId, existing.orderId));
    const paidAmount = round2(tenders.reduce((s, t) => s + Number(t.amount), 0));
    return {
      orderId: existing.orderId,
      orderNumber: existing.orderNumber,
      total: Number(order.total),
      paidAmount,
      changeAmount: round2(tenders.reduce((s, t) => s + Number(t.changeAmount ?? 0), 0)),
      paymentStatus: order.paymentStatus === "paid" ? "paid" : "partially_paid",
      idempotent: true,
    };
  }

  // Cash must land in an accounted drawer. Resolve the device's shift once,
  // before placeOrder, so a refusal leaves no orphan order behind. Card/other
  // tenders are allowed with no shift and simply carry a null shiftId.
  //
  // A replayed sale names its own drawer (clientShiftId, or shiftId if that
  // drawer was opened online) instead of asking "whichever shift is open" —
  // by the time the queue drains, the device may have opened a new one, or
  // this one may have since closed. Live sales are unaffected: none of these
  // fields is ever set outside the replay path.
  //
  // Replay is what the CALLER declares (`replay`/`syncReceipt`), not what the
  // input happens to reference: keyed off the shift reference alone, a
  // replayed sale that carried no reference fell through to findOpenShift and
  // landed in whichever drawer happened to be open at ingest time.
  const isReplay = Boolean(input.replay || input.syncReceipt);
  const namesShift = Boolean(input.clientShiftId || input.shiftId);
  const byName = isReplay || namesShift;
  const shift = byName
    ? await resolveReplayShift(ctx.tenantId, ctx.deviceId, input)
    : await findOpenShift(ctx.tenantId, ctx.deviceId);
  // Live, this is the guard that keeps cash out of an unaccounted drawer. On
  // replay it must NOT fire: the cash is already in a physical drawer and the
  // sale is a fact being reported, so refusing it here would veto the till and
  // — because the halt is sticky — freeze every event queued behind it. The
  // unresolved drawer is flagged instead (shiftUnresolvedAtReplay below).
  if (!isReplay && !shift && input.payments.some((p) => p.method === "cash")) {
    throw new NoOpenShiftError();
  }
  // Tolerated, not refused: the drawer this sale belongs to may have closed
  // before its turn to replay. The tender still lands against it; the flag
  // below tells the audit trail (and Spec 7 reconciliation) it arrived late.
  const shiftClosedAtReplay = byName && shift?.status === "closed";
  // The drawer this sale names does not exist on this device — the
  // shift.opened never landed, or the device re-paired. The sale is still
  // recorded (till-wins), but a null shiftId silently drops it from the
  // Z-report, so it is flagged rather than left to be noticed at close.
  const shiftUnresolvedAtReplay = byName && !shift;

  // Authorize every discount BEFORE writing anything. resolveAuthorizer throws
  // PosForbiddenError when the cashier lacks the permission and has no grant.
  const grantFor = (p: Permission) => input.grants?.find((g) => g.permission === p)?.token;
  const hasLineDiscount = input.lines.some((l) => (l.discountAmount ?? 0) > 0);
  const hasOrderDiscount = (input.orderDiscountAmount ?? 0) > 0;
  let discountAuthorizer: string | null = null;
  // True only when the replay authorizer resolved below turns out to be a
  // manager deactivated sometime between the sale and this ingest — the
  // authorization stands (it was valid at the till, when it happened), but
  // the audit trail carries the flag rather than staying silent about it.
  let discountAuthorizerDeactivated = false;
  if (hasLineDiscount || hasOrderDiscount) {
    if (input.replay && input.authorizedByUserId) {
      const [authorizer] = await db.select({ id: users.id, status: users.status }).from(users)
        .where(and(eq(users.id, input.authorizedByUserId), eq(users.tenantId, ctx.tenantId)))
        .limit(1);
      if (!authorizer) throw new PosForbiddenError("pos:discount");
      discountAuthorizer = authorizer.id;
      discountAuthorizerDeactivated = authorizer.status !== "active";
    } else {
      discountAuthorizer = await resolveAuthorizer(ctx, "pos:discount", grantFor("pos:discount"));
    }
  }

  // Validate tenders before touching the DB.
  for (const p of input.payments) {
    if (!(p.amount > 0)) throw new PosSaleError("A tender must be a positive amount");
    if (p.method !== "cash" && p.tenderedAmount !== undefined && p.tenderedAmount !== p.amount) {
      throw new PosSaleError("Only a cash tender can give change");
    }
  }

  // Paid/change math is a pure function of the tenders — no dependency on the
  // placed order — so it can run before placeOrder. Whether that paid amount
  // is WITHIN the amount due needs placed.total, so that guard (and every
  // write it gates: tenders, adjustments, paymentStatus, audit chain, receipt)
  // runs inside onPlaced, on the order's own tx — a throw there rolls back the
  // order together with the sale, instead of leaving an orphan behind it.
  const paidAmount = round2(input.payments.reduce((s, p) => s + p.amount, 0));
  let changeAmount = 0;
  const tenderData = input.payments.map((p) => {
    const change = p.method === "cash" && p.tenderedAmount !== undefined
      ? Math.max(0, round2(p.tenderedAmount - p.amount))
      : 0;
    changeAmount = round2(changeAmount + change);
    return {
      tenantId: ctx.tenantId,
      method: p.method,
      amount: money(p.amount),
      tipAmount: money(p.tipAmount ?? 0),
      tenderedAmount: p.tenderedAmount !== undefined ? money(p.tenderedAmount) : null,
      changeAmount: p.method === "cash" ? money(change) : null,
      reference: p.reference ?? null,
      takenByUserId: ctx.cashierUserId,
      shiftId: shift?.id ?? null,
      clientPaymentId: p.clientPaymentId,
    };
  });
  const paymentStatusFor = (total: number): "paid" | "partially_paid" =>
    paidAmount >= total - 0.001 ? "paid" : "partially_paid";

  let committedReceipt: SaleReceipt | null = null;
  const placed = await placeOrder(ctx.tenantId, {
    branchId: ctx.branchId,
    fulfillmentType: "pickup",
    customerName: "Walk-in",
    customerPhone: "000000000",
    notes: input.notes,
    lines: input.lines,
    channel: "pos",
    cashierUserId: ctx.cashierUserId,
    orderDiscountAmount: input.orderDiscountAmount,
    orderDiscountReason: input.orderDiscountReason,
    expectedTotal: input.expectedTotal,
    audit: { fingerprint: ctx.fingerprint, actorUserId: ctx.cashierUserId, actorType: "user" },
    replay: input.replay,
    onPlaced: async (tx, placed) => {
      // Live: the register must never take more than the amount due. Replay:
      // the money already changed hands at the till, and the server's total
      // can differ purely because tenant pricing moved during the outage —
      // VAT, service charge and pricesIncludeVat are re-read live, so the
      // line snapshots cannot hold them. "Flag, never veto": the overage is
      // recorded on sale.recorded instead of failing the event and freezing
      // every queued sale behind it.
      const overpaidAtReplay = paidAmount > placed.total + 0.001 ? round2(paidAmount - placed.total) : 0;
      if (overpaidAtReplay > 0 && !isReplay) {
        throw new PosSaleError("Tenders exceed the amount due");
      }

      const tenderRows = tenderData.map((t) => ({ ...t, orderId: placed.orderId }));
      if (tenderRows.length > 0) await tx.insert(orderPayments).values(tenderRows);

      const events = [];
      input.lines.forEach((line, i) => {
        if ((line.discountAmount ?? 0) > 0) {
          events.push({
            tenantId: ctx.tenantId,
            orderId: placed.orderId,
            orderItemId: placed.itemIds[i],
            type: "line_discount" as const,
            amount: money(line.discountAmount!),
            reasonCode: line.discountReason ?? "other",
            byUserId: ctx.cashierUserId,
            authorizedByUserId: discountAuthorizer!,
          });
        }
      });
      if (hasOrderDiscount) {
        events.push({
          tenantId: ctx.tenantId,
          orderId: placed.orderId,
          orderItemId: null,
          type: "order_discount" as const,
          amount: money(input.orderDiscountAmount!),
          reasonCode: input.orderDiscountReason ?? "other",
          byUserId: ctx.cashierUserId,
          authorizedByUserId: discountAuthorizer!,
        });
      }
      if (events.length > 0) await tx.insert(posAdjustmentEvents).values(events);

      const paymentStatus = paymentStatusFor(placed.total);
      await tx.update(orders).set({ paymentStatus, updatedAt: new Date() }).where(eq(orders.id, placed.orderId));

      // Emit the audit chain for this sale on the SAME tx. order.placed was already
      // appended by placeOrder above; discount.* rows come next, and sale.recorded
      // last so it is the tip. Forward emission points (void.line, void.order,
      // refund.*, inventory/PO/ETA events) attach to this same helper in
      // Specs 3/8/9/11 — no chain change.
      const auditCtx = { tenantId: ctx.tenantId, branchId: ctx.branchId, actorUserId: ctx.cashierUserId, fingerprint: ctx.fingerprint };
      for (let i = 0; i < input.lines.length; i++) {
        const line = input.lines[i];
        if ((line.discountAmount ?? 0) > 0) {
          await recordAuditEvent(auditCtx, {
            action: "discount.line_applied", entityType: "order", entityId: placed.orderId,
            summary: `Line discount ${money(line.discountAmount!)}`,
            metadata: {
              orderItemId: placed.itemIds[i], amount: money(line.discountAmount!), reasonCode: line.discountReason ?? "other",
              byUserId: ctx.cashierUserId, authorizedByUserId: discountAuthorizer,
              ...(discountAuthorizerDeactivated ? { authorizerDeactivated: true } : {}),
            },
            actorType: "user",
          }, tx);
        }
      }
      if (hasOrderDiscount) {
        await recordAuditEvent(auditCtx, {
          action: "discount.order_applied", entityType: "order", entityId: placed.orderId,
          summary: `Order discount ${money(input.orderDiscountAmount!)}`,
          metadata: {
            amount: money(input.orderDiscountAmount!), reasonCode: input.orderDiscountReason ?? "other",
            byUserId: ctx.cashierUserId, authorizedByUserId: discountAuthorizer,
            ...(discountAuthorizerDeactivated ? { authorizerDeactivated: true } : {}),
          },
          actorType: "user",
        }, tx);
      }
      await recordAuditEvent(auditCtx, {
        action: "sale.recorded", entityType: "order", entityId: placed.orderId,
        summary: `Sale #${placed.orderNumber} — ${paymentStatus}`,
        metadata: {
          orderNumber: String(placed.orderNumber), total: money(placed.total), paymentStatus,
          tenders: input.payments.map((p) => ({ method: p.method, amount: money(p.amount) })),
          ...(shiftClosedAtReplay ? { shiftClosedAtReplay: true } : {}),
          ...(shiftUnresolvedAtReplay ? { shiftUnresolvedAtReplay: true } : {}),
          ...(overpaidAtReplay > 0 ? { overpaidAtReplay: money(overpaidAtReplay) } : {}),
        }, actorType: "user",
      }, tx);

      // No RLS on pos_order_receipts (by design — it's the idempotency lookup,
      // queried before a tenant tx exists), but the insert itself still runs
      // fine on this tenant tx: it commits with the sale instead of racing it.
      await tx.insert(posOrderReceipts).values({
        deviceId: ctx.deviceId,
        clientOrderId: input.clientOrderId,
        orderId: placed.orderId,
        orderNumber: String(placed.orderNumber),
      });

      // Built once, here, so the row sync-ingest reads back on a duplicate
      // ingest is byte-identical to what a fresh apply returns below — no
      // separate recomputation to drift out of sync with it.
      committedReceipt = {
        orderId: placed.orderId,
        orderNumber: String(placed.orderNumber),
        total: placed.total,
        paidAmount,
        changeAmount,
        paymentStatus,
        idempotent: false,
      };
      if (input.syncReceipt) {
        await tx.insert(posSyncEventReceipts).values({ ...input.syncReceipt, resultJson: committedReceipt });
      }
    },
  });

  // Fiscal (Spec 11): the sale is committed and returned regardless — the
  // sale is authoritative and must never be blocked or rolled back by fiscal
  // logic. This runs strictly AFTER placeOrder's own transaction has
  // committed (never from inside onPlaced, which is still mid-transaction),
  // so enqueueFiscalDocument opens its OWN withTenant here rather than
  // reusing one. `!existing` is always true on this path (an idempotent
  // replay returns early above, well before placeOrder is even called) —
  // kept explicit anyway so the guard reads as an invariant rather than an
  // assumption. EG tenants enqueue a pending e_receipt; the worker (Task 5)
  // submits it to ETA asynchronously. A non-EG tenant enqueues nothing
  // (country gate, F2) — no behavioural change. Caught and logged, never
  // rethrown: unlike the refund path below (whose enqueue runs INSIDE the
  // refund's own transaction for atomicity — see enqueueFiscalDocument's
  // doc comment), a fiscal failure here must not undo money already taken
  // and a receipt already printed.
  try {
    if (!existing && (await isFiscalEnabled(ctx.tenantId))) {
      await enqueueFiscalDocument({ tenantId: ctx.tenantId }, { docType: "e_receipt", orderId: placed.orderId });
    }
  } catch (err) {
    // Identifiers, not a bare message: this is the ONLY trace a failure here
    // leaves (no row, no audit event — see the plan's Task 5 Step 0
    // reconciliation-sweep note), so tenant/order must be readable straight
    // off the log line. Plain console.error, not notify(): notify writes to
    // the DB, which is exactly the failure mode already in play here, and an
    // awaited call inside this catch would itself risk the iron rule (the
    // sale must never be blocked by fiscal logic).
    console.error(`[fiscal] enqueue failed for tenant ${ctx.tenantId} order ${placed.orderId} (sale unaffected)`, err);
  }

  // onPlaced always runs to completion before placeOrder resolves — see its
  // doc comment — so committedReceipt is set whenever we reach here.
  return committedReceipt!;
}

/** Adds a tender to an existing (typically partially_paid) sale. Idempotent on clientPaymentId. */
export async function addTender(
  ctx: PosCashierContext,
  orderId: string,
  tender: TenderInput,
): Promise<SaleReceipt> {
  if (!(tender.amount > 0)) throw new PosSaleError("A tender must be a positive amount");
  if (tender.method !== "cash" && tender.tenderedAmount !== undefined && tender.tenderedAmount !== tender.amount) {
    throw new PosSaleError("Only a cash tender can give change");
  }

  return withTenant(ctx.tenantId, async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new PosSaleError("Unknown order");

    const existingTenders = await tx.select().from(orderPayments).where(eq(orderPayments.orderId, orderId));
    const already = existingTenders.find((t) => t.clientPaymentId === tender.clientPaymentId);

    const paidBefore = round2(existingTenders.reduce((s, t) => s + Number(t.amount), 0));
    const total = Number(order.total);

    if (!already) {
      if (paidBefore + tender.amount > total + 0.001) {
        throw new PosSaleError("Tender exceeds the amount due");
      }
      // Resolved on this tx so the stamp and the tender commit together. Only a
      // genuinely new tender needs a drawer — a retry of one already recorded
      // must stay idempotent even if that shift has since closed.
      const [shift] = await tx.select().from(posShifts)
        .where(and(eq(posShifts.deviceId, ctx.deviceId), eq(posShifts.status, "open")))
        .limit(1);
      if (tender.method === "cash" && !shift) throw new NoOpenShiftError();

      const change = tender.method === "cash" && tender.tenderedAmount !== undefined
        ? Math.max(0, round2(tender.tenderedAmount - tender.amount))
        : 0;
      await tx.insert(orderPayments).values({
        tenantId: ctx.tenantId,
        orderId,
        method: tender.method,
        amount: money(tender.amount),
        tipAmount: money(tender.tipAmount ?? 0),
        tenderedAmount: tender.tenderedAmount !== undefined ? money(tender.tenderedAmount) : null,
        changeAmount: tender.method === "cash" ? money(change) : null,
        reference: tender.reference ?? null,
        takenByUserId: ctx.cashierUserId,
        shiftId: shift?.id ?? null,
        clientPaymentId: tender.clientPaymentId,
      });
    }

    const after = await tx.select().from(orderPayments).where(eq(orderPayments.orderId, orderId));
    const paidAmount = round2(after.reduce((s, t) => s + Number(t.amount), 0));
    const paymentStatus: "paid" | "partially_paid" =
      paidAmount >= total - 0.001 ? "paid" : "partially_paid";

    await tx.update(orders).set({ paymentStatus, updatedAt: new Date() }).where(eq(orders.id, orderId));

    // Only a genuinely new tender advances the chain — a retried clientPaymentId
    // is idempotent and must not append a second audit row.
    if (!already) {
      await recordAuditEvent(
        { tenantId: ctx.tenantId, branchId: ctx.branchId, actorUserId: ctx.cashierUserId, fingerprint: ctx.fingerprint },
        { action: "payment.tender_added", entityType: "order", entityId: orderId,
          summary: `Tender ${tender.method} ${money(tender.amount)}`,
          metadata: { method: tender.method, amount: money(tender.amount), paymentStatus }, actorType: "user" },
        tx,
      );
    }

    return {
      orderId,
      orderNumber: String(order.orderNumber),
      total,
      paidAmount,
      changeAmount: round2(after.reduce((s, t) => s + Number(t.changeAmount ?? 0), 0)),
      paymentStatus,
      idempotent: Boolean(already),
    };
  });
}
