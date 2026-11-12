import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { orders } from "@/server/ordering/schema";
import { getCheckoutPricing } from "@/server/tenancy/settings";
import { computeCartTotals } from "@/lib/order-totals";
import { orderPayments, posAdjustmentEvents } from "./tender-schema";
import { posOrderReceipts } from "./schema";
import { NextRequest } from "next/server";
import { NoOpenShiftError, PaymentNeedsVerificationError, PosForbiddenError, PosSaleError } from "./errors";
import { TotalMismatchError } from "@/server/ordering/errors";
import { issueGrant } from "./grants";
import { recordSale, addTender } from "./record-sale";
import { seedPosContext, openShiftForCtx } from "./test-helpers";

describe("recordSale", () => {
  it("records a cash sale with change and marks it paid", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
    await openShiftForCtx(ctx);
    const res = await recordSale(ctx, {
      clientOrderId: "s-1",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p-1", method: "cash", amount: total, tenderedAmount: total + 50 }],
    });
    expect(res.paymentStatus).toBe("paid");
    expect(res.changeAmount).toBe(50);

    const tenders = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(orderPayments).where(eq(orderPayments.orderId, res.orderId)));
    expect(tenders).toHaveLength(1);
    expect(Number(tenders[0].changeAmount)).toBe(50);
  });

  it("records a split payment across two tenders", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
    await openShiftForCtx(ctx);
    const half = Math.round((total / 2) * 100) / 100;
    const res = await recordSale(ctx, {
      clientOrderId: "s-2",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [
        { clientPaymentId: "p-a", method: "cash", amount: half, tenderedAmount: half },
        { clientPaymentId: "p-b", method: "card", amount: total - half, reference: "4242" },
      ],
    });
    expect(res.paymentStatus).toBe("paid");
    const tenders = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(orderPayments).where(eq(orderPayments.orderId, res.orderId)));
    expect(tenders).toHaveLength(2);
  });

  it("leaves an underpaid sale partially_paid", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
    const res = await recordSale(ctx, {
      clientOrderId: "s-3",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p-1", method: "card", amount: 1 }],
    });
    expect(res.paymentStatus).toBe("partially_paid");
    const [order] = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(orders).where(eq(orders.id, res.orderId)));
    expect(order.paymentStatus).toBe("partially_paid");
  });

  it("rejects an overpaying card tender — only cash yields change", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
    await expect(recordSale(ctx, {
      clientOrderId: "s-4",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p-1", method: "card", amount: total + 10 }],
    })).rejects.toThrow(/exceed|change/i);
  });

  it("rolls back the order when the in-transaction total check fails (single transaction)", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
    await openShiftForCtx(ctx);
    // Cash (not card) so the pre-placeOrder tender validation lets this through —
    // the overpayment is only caught by the paid-exceeds-total guard that now
    // runs inside placeOrder's onPlaced, on the order's own transaction.
    await expect(recordSale(ctx, {
      clientOrderId: "s-atomic",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p-1", method: "cash", amount: total + 500, tenderedAmount: total + 500 }],
    })).rejects.toThrow(PosSaleError);

    const allOrders = await withTenant(ctx.tenantId, (tx) => tx.select().from(orders));
    expect(allOrders).toHaveLength(0); // no orphan order, no stock deducted, no receipt row
    const tenders = await withTenant(ctx.tenantId, (tx) => tx.select().from(orderPayments));
    expect(tenders).toHaveLength(0);
    const receipts = await db.select().from(posOrderReceipts)
      .where(eq(posOrderReceipts.clientOrderId, "s-atomic"));
    expect(receipts).toHaveLength(0);
  });

  it("is idempotent on clientOrderId", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
    await openShiftForCtx(ctx);
    const input = {
      clientOrderId: "dup",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p-1", method: "cash" as const, amount: total, tenderedAmount: total }],
    };
    const a = await recordSale(ctx, input);
    const b = await recordSale(ctx, input);
    expect(b.idempotent).toBe(true);
    expect(b.orderId).toBe(a.orderId);
    const tenders = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(orderPayments).where(eq(orderPayments.orderId, a.orderId)));
    expect(tenders).toHaveLength(1); // the retry must not double-charge
  });

  it("rejects a stale total and creates nothing", async () => {
    const { ctx, productId } = await seedPosContext("owner");
    await openShiftForCtx(ctx);
    await expect(recordSale(ctx, {
      clientOrderId: "s-5",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: 1,
      payments: [{ clientPaymentId: "p-1", method: "cash", amount: 1, tenderedAmount: 1 }],
    })).rejects.toThrow(TotalMismatchError);
  });

  it("forbids a staff discount without a manager grant", async () => {
    const { ctx, productId } = await seedPosContext("staff");
    await expect(recordSale(ctx, {
      clientOrderId: "s-6",
      lines: [{ productId, quantity: 1, selectedOptionIds: [], discountAmount: 10, discountReason: "promo" }],
      expectedTotal: 0,
      payments: [],
    })).rejects.toThrow(PosForbiddenError);
  });

  it("records the manager as authorizer when staff spends a grant", async () => {
    const { ctx, productId, managerId, tenantId } = await seedPosContext("staff");
    const grant = await issueGrant(tenantId, "pos:discount", managerId);
    // Derive the discounted total from the shared money math so the assertion
    // does not drift with the tenant's VAT/service-charge defaults.
    const pricing = await getCheckoutPricing(tenantId);
    const expectedTotal = computeCartTotals(pricing, [{ unitPrice: 100, quantity: 1, discountAmount: 10 }], 0).total;
    const res = await recordSale(ctx, {
      clientOrderId: "s-7",
      lines: [{ productId, quantity: 1, selectedOptionIds: [], discountAmount: 10, discountReason: "promo" }],
      expectedTotal,
      payments: [],
      grants: [{ permission: "pos:discount", token: grant }],
    });
    const [ev] = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(posAdjustmentEvents).where(eq(posAdjustmentEvents.orderId, res.orderId)));
    expect(ev.type).toBe("line_discount");
    expect(ev.authorizedByUserId).toBe(managerId);
    expect(ev.byUserId).toBe(ctx.cashierUserId);
  });
});

describe("recordSale — shift stamping", () => {
  it("stamps every tender with the device's open shift", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
    const shift = await openShiftForCtx(ctx);
    const half = Math.round((total / 2) * 100) / 100;

    const res = await recordSale(ctx, {
      clientOrderId: "stamp-1",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [
        { clientPaymentId: "p-a", method: "cash", amount: half, tenderedAmount: half },
        { clientPaymentId: "p-b", method: "card", amount: total - half },
      ],
    });

    const tenders = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(orderPayments).where(eq(orderPayments.orderId, res.orderId)));
    expect(tenders).toHaveLength(2);
    expect(tenders.map((t) => t.shiftId)).toEqual([shift.id, shift.id]);
  });

  it("refuses a cash sale with no open shift, writing no order, tender, or receipt", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");

    await expect(recordSale(ctx, {
      clientOrderId: "no-shift",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p-1", method: "cash", amount: total, tenderedAmount: total }],
    })).rejects.toBeInstanceOf(NoOpenShiftError);

    // Refused before placeOrder, so there is no orphan order to reconcile later.
    const written = await withTenant(ctx.tenantId, (tx) => tx.select().from(orders));
    expect(written).toHaveLength(0);
    const tenders = await withTenant(ctx.tenantId, (tx) => tx.select().from(orderPayments));
    expect(tenders).toHaveLength(0);
    const receipts = await db.select().from(posOrderReceipts)
      .where(eq(posOrderReceipts.clientOrderId, "no-shift"));
    expect(receipts).toHaveLength(0);
  });

  it("allows a card-only sale with no open shift, leaving shiftId null", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");

    const res = await recordSale(ctx, {
      clientOrderId: "card-no-shift",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p-1", method: "card", amount: total }],
    });

    const tenders = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(orderPayments).where(eq(orderPayments.orderId, res.orderId)));
    expect(tenders[0].shiftId).toBeNull();
  });
});

describe("addTender", () => {
  it("tops up a partially paid sale to paid", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
    await openShiftForCtx(ctx);
    const sale = await recordSale(ctx, {
      clientOrderId: "top-1",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p-1", method: "card", amount: 1 }],
    });
    expect(sale.paymentStatus).toBe("partially_paid");

    const res = await addTender(ctx, sale.orderId, {
      clientPaymentId: "p-2", method: "cash", amount: total - 1, tenderedAmount: total - 1,
    });
    expect(res.paymentStatus).toBe("paid");
    expect(res.paidAmount).toBe(total);
  });

  it("is idempotent on clientPaymentId", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
    await openShiftForCtx(ctx);
    const sale = await recordSale(ctx, {
      clientOrderId: "top-2",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p-1", method: "card", amount: 1 }],
    });
    const tender = { clientPaymentId: "p-2", method: "cash" as const, amount: 1 };
    await addTender(ctx, sale.orderId, tender);
    await addTender(ctx, sale.orderId, tender);
    const tenders = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(orderPayments).where(eq(orderPayments.orderId, sale.orderId)));
    expect(tenders).toHaveLength(2); // the original + one, not two
  });

  it("refuses a tender larger than what remains", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
    const sale = await recordSale(ctx, {
      clientOrderId: "top-3",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p-1", method: "card", amount: 1 }],
    });
    await expect(addTender(ctx, sale.orderId, {
      clientPaymentId: "p-2", method: "card", amount: total,
    })).rejects.toThrow(PosSaleError);
  });

  it("stamps the top-up tender with the open shift", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
    const shift = await openShiftForCtx(ctx);
    const sale = await recordSale(ctx, {
      clientOrderId: "top-4",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p-1", method: "card", amount: 1 }],
    });

    await addTender(ctx, sale.orderId, {
      clientPaymentId: "p-2", method: "cash", amount: total - 1, tenderedAmount: total - 1,
    });

    const tenders = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(orderPayments).where(eq(orderPayments.orderId, sale.orderId)));
    const topUp = tenders.find((t) => t.clientPaymentId === "p-2")!;
    expect(topUp.shiftId).toBe(shift.id);
  });

  it("refuses a cash top-up with no open shift", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
    const sale = await recordSale(ctx, {
      clientOrderId: "top-5",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p-1", method: "card", amount: 1 }],
    });

    await expect(addTender(ctx, sale.orderId, {
      clientPaymentId: "p-2", method: "cash", amount: 1,
    })).rejects.toBeInstanceOf(NoOpenShiftError);

    const tenders = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(orderPayments).where(eq(orderPayments.orderId, sale.orderId)));
    expect(tenders).toHaveLength(1); // only the original card tender
  });

  // #165 x POS tender (#187 review): an order whose offline payment is still
  // unverified is resolved in the payments queue (payments:confirm), never by
  // the till. A cashier holding only pos:sell must not be able to settle it —
  // neither a partial tender (which used to flip it to partially_paid) nor a
  // full one (which flipped it to paid and disarmed the fulfilment gate).
  async function pendingVerificationSale(clientOrderId: string) {
    const seeded = await seedPosContext("owner");
    await openShiftForCtx(seeded.ctx);
    const sale = await recordSale(seeded.ctx, {
      clientOrderId,
      lines: [{ productId: seeded.productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: seeded.total,
      payments: [{ clientPaymentId: "p-1", method: "card", amount: 1 }],
    });
    // Stands in for an offline (InstaPay / wallet) order awaiting verification.
    await withTenant(seeded.ctx.tenantId, (tx) =>
      tx.update(orders).set({ paymentStatus: "pending_verification" }).where(eq(orders.id, sale.orderId)));
    return { ...seeded, sale };
  }

  it("refuses a partial tender on a pending_verification order and records nothing", async () => {
    const { ctx, sale } = await pendingVerificationSale("top-6");

    await expect(addTender(ctx, sale.orderId, {
      clientPaymentId: "p-2", method: "card", amount: 1,
    })).rejects.toMatchObject({ code: "payment_needs_verification" });

    const [orderRow] = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(orders).where(eq(orders.id, sale.orderId)).limit(1));
    expect(orderRow.paymentStatus).toBe("pending_verification");
    const tenders = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(orderPayments).where(eq(orderPayments.orderId, sale.orderId)));
    expect(tenders).toHaveLength(1);
  });

  it("refuses a full tender that would settle a pending_verification order", async () => {
    const { ctx, sale, total } = await pendingVerificationSale("top-7");

    await expect(addTender(ctx, sale.orderId, {
      clientPaymentId: "p-2", method: "cash", amount: total - 1, tenderedAmount: total - 1,
    })).rejects.toBeInstanceOf(PaymentNeedsVerificationError);

    const [orderRow] = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(orders).where(eq(orders.id, sale.orderId)).limit(1));
    expect(orderRow.paymentStatus).toBe("pending_verification");
  });

  it("the tender route answers 422 payment_needs_verification, telling the cashier where to resolve it", async () => {
    const { sale, deviceToken, cashierToken } = await pendingVerificationSale("top-8");
    const { POST } = await import("@/app/api/pos/v1/sales/[id]/payments/route");

    const res = await POST(
      new NextRequest(`http://localhost/api/pos/v1/sales/${sale.orderId}/payments`, {
        method: "POST",
        headers: { authorization: `Bearer ${deviceToken}`, "x-pos-cashier": cashierToken, "content-type": "application/json" },
        body: JSON.stringify({ clientPaymentId: "p-2", method: "card", amount: 1 }),
      }),
      { params: Promise.resolve({ id: sale.orderId }) },
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("payment_needs_verification");
    expect(body.error).toMatch(/payments queue/i);
  });
});
