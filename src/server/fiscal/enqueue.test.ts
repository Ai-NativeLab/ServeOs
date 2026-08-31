import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { etaSubmissions } from "./schema";
import { isFiscalEnabled, enqueueFiscalDocument, enqueueCorrectedResubmission } from "./enqueue";
import { seedPosContext, openShiftForCtx } from "@/server/pos/test-helpers";
import { recordSale } from "@/server/pos/record-sale";
import { issueRefund, type RefundActor } from "@/server/pos/refund";
import type { PosCashierContext } from "@/server/pos/require-cashier";
import { getCheckoutPricing } from "@/server/tenancy/settings";
import { computeCartTotals } from "@/lib/order-totals";

/**
 * Runs against the real test Postgres — the house pattern (config.test.ts):
 * rows are seeded through the real service functions (`seedPosContext`,
 * `recordSale`, `issueRefund`) rather than hand-inserted, so RLS and the
 * `eta_submissions` FKs (order_id/refund_id reference real rows, ON DELETE
 * RESTRICT) are exercised for real.
 *
 * `seedPosContext` (src/server/pos/test-helpers.ts) always seeds an `"EG"`
 * tenant, so it doubles as the EG fixture everywhere below; the non-EG cases
 * flip `tenants.country` directly (a plain, non-RLS control-plane table —
 * see config.test.ts's own `makeTenant`) after seeding.
 */

const actorFrom = (ctx: PosCashierContext): RefundActor => ({
  tenantId: ctx.tenantId,
  branchId: ctx.branchId,
  actorUserId: ctx.cashierUserId,
  permissions: [...ctx.permissions],
});

async function setCountry(tenantId: string, country: "EG" | "SA") {
  await db.update(tenants).set({ country }).where(eq(tenants.id, tenantId));
}

async function submissionsByOrder(tenantId: string, orderId: string) {
  return withTenant(tenantId, (tx) =>
    tx.select().from(etaSubmissions).where(and(eq(etaSubmissions.tenantId, tenantId), eq(etaSubmissions.orderId, orderId))));
}

async function submissionsByRefund(tenantId: string, refundId: string) {
  return withTenant(tenantId, (tx) =>
    tx.select().from(etaSubmissions).where(and(eq(etaSubmissions.tenantId, tenantId), eq(etaSubmissions.refundId, refundId))));
}

/** A completed, fully-paid cash sale on an EG tenant (seedPosContext's default) — no change due. */
async function seedPaidSale() {
  const s = await seedPosContext("owner");
  await openShiftForCtx(s.ctx);
  const receipt = await recordSale(s.ctx, {
    clientOrderId: "sale-1",
    lines: [{ productId: s.productId, quantity: 1, selectedOptionIds: [] }],
    expectedTotal: s.total,
    payments: [{ clientPaymentId: "p-1", method: "cash", amount: s.total, tenderedAmount: s.total }],
  });
  return { ...s, receipt };
}

describe("isFiscalEnabled", () => {
  it("is true for an EG tenant", async () => {
    const { tenantId } = await seedPosContext("owner");
    expect(await isFiscalEnabled(tenantId)).toBe(true);
  });

  it("is false for a non-EG tenant", async () => {
    const { tenantId } = await seedPosContext("owner");
    await setCountry(tenantId, "SA");
    expect(await isFiscalEnabled(tenantId)).toBe(false);
  });
});

describe("recordSale — fiscal enqueue (country gate)", () => {
  it("an EG sale enqueues exactly one pending e_receipt row for its orderId", async () => {
    const s = await seedPaidSale();
    const rows = await submissionsByOrder(s.tenantId, s.receipt.orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      docType: "e_receipt",
      status: "pending",
      attempts: 0,
      requestJson: {},
      refundId: null,
    });
  });

  it("a non-EG sale enqueues nothing and leaves the sale receipt payload unchanged", async () => {
    const { ctx, tenantId, productId } = await seedPosContext("owner");
    await setCountry(tenantId, "SA");
    await openShiftForCtx(ctx);

    // Recomputed AFTER the country flip: country drives the default VAT rate
    // (defaultVatRate, tenancy/settings.ts — 14% EG vs 15% SA), so the total
    // seedPosContext returned (EG-priced) would no longer match what
    // placeOrder computes server-side for this now-SA tenant.
    const pricing = await getCheckoutPricing(tenantId);
    const total = computeCartTotals(pricing, [{ unitPrice: 100, quantity: 1 }], 0).total;

    const receipt = await recordSale(ctx, {
      clientOrderId: "sale-non-eg",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p-1", method: "cash", amount: total, tenderedAmount: total }],
    });

    // The country gate must be invisible on the SaleReceipt itself.
    expect(receipt).toMatchObject({
      total,
      paidAmount: total,
      changeAmount: 0,
      paymentStatus: "paid",
      idempotent: false,
    });
    expect(receipt.orderId).toEqual(expect.any(String));

    const rows = await submissionsByOrder(tenantId, receipt.orderId);
    expect(rows).toHaveLength(0);
  });
});

describe("enqueueFiscalDocument — idempotency (regression pin)", () => {
  it("a duplicate enqueue for the same (orderId, docType) is a no-op — row count stays 1", async () => {
    const s = await seedPaidSale(); // recordSale already enqueued the original row
    await enqueueFiscalDocument({ tenantId: s.tenantId }, { docType: "e_receipt", orderId: s.receipt.orderId });

    const rows = await submissionsByOrder(s.tenantId, s.receipt.orderId);
    expect(rows).toHaveLength(1); // onConflictDoNothing against the partial index actually held
  });

  it("a rejected original is STILL a no-op on a blind re-enqueue", async () => {
    const s = await seedPaidSale();
    await withTenant(s.tenantId, (tx) =>
      tx.update(etaSubmissions).set({ status: "rejected" }).where(eq(etaSubmissions.orderId, s.receipt.orderId)));

    await enqueueFiscalDocument({ tenantId: s.tenantId }, { docType: "e_receipt", orderId: s.receipt.orderId });

    // The ORIGINAL index (eta_submissions_order_original) ignores status —
    // accidental duplicates stay impossible. A deliberate corrected
    // resubmission is a NEW row carrying referenceOldUuid (Task 5), which
    // this function never writes.
    const rows = await submissionsByOrder(s.tenantId, s.receipt.orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("rejected");
  });
});

describe("enqueueFiscalDocument — refund-path atomicity", () => {
  it("enqueuing inside a transaction that then throws leaves no row", async () => {
    const s = await seedPaidSale();
    // Issue the refund on a non-EG tenant so issueRefund's OWN gate stays
    // closed and this refund starts with zero fiscal rows — isolating the
    // assertion below to enqueueFiscalDocument's own rollback behaviour
    // rather than issueRefund's.
    await setCountry(s.tenantId, "SA");
    const refund = await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "full",
      lines: [],
      payments: [{ method: "cash", amount: s.receipt.paidAmount }],
      reasonCode: "other",
      clientRefundId: "r-atomic",
    });
    await setCountry(s.tenantId, "EG");

    await expect(
      withTenant(s.tenantId, async (tx) => {
        await enqueueFiscalDocument({ tenantId: s.tenantId }, { docType: "return_receipt", refundId: refund.refundId }, tx);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const rows = await submissionsByRefund(s.tenantId, refund.refundId);
    expect(rows).toHaveLength(0);
  });
});

describe("issueRefund — fiscal enqueue (country gate)", () => {
  it("an EG refund enqueues exactly one pending return_receipt row atomically with the refund", async () => {
    const s = await seedPaidSale();
    const refund = await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "full",
      lines: [],
      payments: [{ method: "cash", amount: s.receipt.paidAmount }],
      reasonCode: "other",
      clientRefundId: "r-eg",
    });

    const rows = await submissionsByRefund(s.tenantId, refund.refundId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      docType: "return_receipt",
      status: "pending",
      attempts: 0,
      requestJson: {},
      orderId: null,
    });
  });

  it("a non-EG refund enqueues nothing", async () => {
    const s = await seedPaidSale();
    await setCountry(s.tenantId, "SA");

    const refund = await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "full",
      lines: [],
      payments: [{ method: "cash", amount: s.receipt.paidAmount }],
      reasonCode: "other",
      clientRefundId: "r-non-eg",
    });

    const rows = await submissionsByRefund(s.tenantId, refund.refundId);
    expect(rows).toHaveLength(0);
  });
});

/**
 * A rejected document, as ETA would leave it: refused, but carrying the
 * self-computed uuid it was refused under — which is the only thing a
 * correction can reference. Written directly rather than driven through the
 * worker, so these assertions are about `enqueueCorrectedResubmission` alone.
 */
async function rejectOriginal(tenantId: string, orderId: string, etaUuid = "a".repeat(64)) {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.update(etaSubmissions).set({ status: "rejected", etaUuid })
      .where(and(eq(etaSubmissions.tenantId, tenantId), eq(etaSubmissions.orderId, orderId)))
      .returning());
  return row;
}

describe("enqueueCorrectedResubmission", () => {
  it("adds a NEW row referencing the rejected document, leaving the original untouched", async () => {
    const s = await seedPaidSale();
    const original = await rejectOriginal(s.tenantId, s.receipt.orderId);

    const correctionId = await enqueueCorrectedResubmission({ tenantId: s.tenantId }, original.id);
    expect(correctionId).not.toBeNull();

    const rows = await submissionsByOrder(s.tenantId, s.receipt.orderId);
    expect(rows).toHaveLength(2);

    const correction = rows.find((row) => row.id === correctionId)!;
    expect(correction).toMatchObject({
      docType: "e_receipt",
      status: "pending",
      attempts: 0,
      orderId: s.receipt.orderId,
      refundId: null,
      // The rejected document's uuid — ETA's referenceOldUUID (addendum C3).
      referenceOldUuid: original.etaUuid,
      // Its OWN uuid does not exist yet: a correction is a new document and
      // gets a new hash at finalization.
      etaUuid: null,
    });

    // The rejected row is a retained fiscal record, not something to mutate.
    const untouched = rows.find((row) => row.id === original.id)!;
    expect(untouched.status).toBe("rejected");
    expect(untouched.etaUuid).toBe(original.etaUuid);
  });

  it("refuses a second LIVE correction for the same sale", async () => {
    const s = await seedPaidSale();
    const original = await rejectOriginal(s.tenantId, s.receipt.orderId);

    expect(await enqueueCorrectedResubmission({ tenantId: s.tenantId }, original.id)).not.toBeNull();
    // The live partial index (status <> 'rejected') is the arbiter: two live
    // documents for one sale would let ETA accept the same sale twice.
    expect(await enqueueCorrectedResubmission({ tenantId: s.tenantId }, original.id)).toBeNull();

    expect(await submissionsByOrder(s.tenantId, s.receipt.orderId)).toHaveLength(2);
  });

  it("allows a correction of the correction once THAT one is rejected too", async () => {
    const s = await seedPaidSale();
    const original = await rejectOriginal(s.tenantId, s.receipt.orderId);
    const firstCorrection = await enqueueCorrectedResubmission({ tenantId: s.tenantId }, original.id);

    await withTenant(s.tenantId, (tx) => tx.update(etaSubmissions)
      .set({ status: "rejected", etaUuid: "b".repeat(64) })
      .where(and(eq(etaSubmissions.tenantId, s.tenantId), eq(etaSubmissions.id, firstCorrection!))));

    const second = await enqueueCorrectedResubmission({ tenantId: s.tenantId }, firstCorrection!);
    expect(second).not.toBeNull();

    const rows = await submissionsByOrder(s.tenantId, s.receipt.orderId);
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.id === second)!.referenceOldUuid).toBe("b".repeat(64));
  });

  it("refuses to correct a document ETA has not rejected", async () => {
    const s = await seedPaidSale();
    const [pending] = await submissionsByOrder(s.tenantId, s.receipt.orderId);

    await expect(enqueueCorrectedResubmission({ tenantId: s.tenantId }, pending.id))
      .rejects.toThrow(/is pending, not rejected/);
  });

  it("refuses to correct a rejection that never reached ETA", async () => {
    const s = await seedPaidSale();
    // Rejected with no etaUuid: there is no document to reference, so
    // re-enqueueing the original is the right move, not a correction.
    const [row] = await withTenant(s.tenantId, (tx) =>
      tx.update(etaSubmissions).set({ status: "rejected" })
        .where(and(eq(etaSubmissions.tenantId, s.tenantId), eq(etaSubmissions.orderId, s.receipt.orderId)))
        .returning());

    await expect(enqueueCorrectedResubmission({ tenantId: s.tenantId }, row.id))
      .rejects.toThrow(/rejected without an etaUuid/);
  });
});
