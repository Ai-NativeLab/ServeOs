import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { orders } from "@/server/ordering/schema";
import { getCheckoutPricing } from "@/server/tenancy/settings";
import { computeCartTotals } from "@/lib/order-totals";
import { orderPayments, posAdjustmentEvents } from "./tender-schema";
import { PosForbiddenError, PosSaleError } from "./errors";
import { TotalMismatchError } from "@/server/ordering/errors";
import { issueGrant } from "./grants";
import { recordSale, addTender } from "./record-sale";
import { seedPosContext } from "./test-helpers";

describe("recordSale", () => {
  it("records a cash sale with change and marks it paid", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
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

  it("is idempotent on clientOrderId", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
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
    const grant = issueGrant(tenantId, "pos:discount", managerId);
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

describe("addTender", () => {
  it("tops up a partially paid sale to paid", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
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
});
