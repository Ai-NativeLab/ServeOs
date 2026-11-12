import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { orders } from "@/server/ordering/schema";
import { getCheckoutPricing } from "@/server/tenancy/settings";
import { computeCartTotals } from "@/lib/order-totals";
import { tenants } from "@/server/tenancy/schema";
import { getOrder, placeOrder, cancelOrderByToken } from "@/server/ordering/service";
import { products } from "@/server/catalog/schema";
import { orderPayments } from "./tender-schema";
import { refunds, refundLines, refundPayments } from "./refund-schema";
import { auditEvents } from "@/server/audit/schema";
import { verifyChain } from "@/server/audit/verifier";
import { PosForbiddenError, PosRefundError } from "./errors";
import { issueGrant } from "./grants";
import { recordSale } from "./record-sale";
import { seedPosContext, openShiftForCtx } from "./test-helpers";
import { issueRefund, type RefundActor, type RefundInput } from "./refund";
import type { PosCashierContext } from "./require-cashier";

const actorFrom = (ctx: PosCashierContext): RefundActor => ({
  tenantId: ctx.tenantId,
  branchId: ctx.branchId,
  actorUserId: ctx.cashierUserId,
  permissions: [...ctx.permissions],
});

async function eventsFor(tenantId: string, action: string) {
  return withTenant(tenantId, (tx) =>
    tx.select().from(auditEvents).where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.action, action))));
}

/**
 * A completed, fully-paid sale of `quantity` units. `paidAmount` equals the
 * server's total for that quantity, derived from the fixture pricing (VAT /
 * service-charge defaults) — never hardcoded.
 */
async function seedPaidSale(role: "owner" | "manager" | "staff" = "owner", quantity = 1) {
  const s = await seedPosContext(role);
  await openShiftForCtx(s.ctx);
  const pricing = await getCheckoutPricing(s.tenantId);
  const total = computeCartTotals(pricing, [{ unitPrice: 100, quantity }], 0).total;
  const receipt = await recordSale(s.ctx, {
    clientOrderId: "sale-1",
    lines: [{ productId: s.productId, quantity, selectedOptionIds: [] }],
    expectedTotal: total,
    payments: [{ clientPaymentId: "pay-1", method: "cash", amount: total, tenderedAmount: total }],
  });
  return { ...s, receipt, total };
}

/**
 * A paid sale on a STOCK-TRACKED tenant (retail vertical, product trackStock
 * on). The sale itself decrements stock (placeOrder's guarded UPDATE), so the
 * product's stock after the sale is `stock − quantity` — exactly what a refund
 * with restock=true must add back.
 */
async function seedStockedPaidSale(quantity = 1, stock = 10) {
  const s = await seedPosContext("owner", { vertical: "retail", trackStock: true, stockQuantity: stock });
  await openShiftForCtx(s.ctx);
  const pricing = await getCheckoutPricing(s.tenantId);
  const total = computeCartTotals(pricing, [{ unitPrice: 100, quantity }], 0).total;
  const receipt = await recordSale(s.ctx, {
    clientOrderId: "sale-1",
    lines: [{ productId: s.productId, quantity, selectedOptionIds: [] }],
    expectedTotal: total,
    payments: [{ clientPaymentId: "pay-1", method: "cash", amount: total, tenderedAmount: total }],
  });
  const [stockRow] = await withTenant(s.tenantId, (tx) =>
    tx.select({ stockQuantity: products.stockQuantity }).from(products).where(eq(products.id, s.productId)));
  return { ...s, receipt, total, stockAfterSale: stockRow.stockQuantity };
}

/** The money one unit is worth in a `quantity`-unit fixture sale (for 1-of-n line refunds). */
const perUnit = (paidAmount: number, quantity: number) => Math.round((paidAmount / quantity) * 100) / 100;
const round2 = (n: number) => Math.round(n * 100) / 100;

describe("issueRefund", () => {
  it("full refund of a paid sale flips payment_status paid → refunded, leaving the order's tenders intact", async () => {
    const s = await seedPaidSale("owner");
    const res = await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "full",
      lines: [],
      payments: [{ method: "cash", amount: s.receipt.paidAmount }],
      reasonCode: "customer_changed_mind",
      clientRefundId: "r1",
    });
    expect(res.paymentStatus).toBe("refunded");
    expect(res.idempotent).toBe(false);
    expect(res.totalAmount).toBe(s.receipt.paidAmount);

    const [o] = await withTenant(s.tenantId, (tx) =>
      tx.select().from(orders).where(eq(orders.id, s.receipt.orderId)));
    expect(o.paymentStatus).toBe("refunded");

    // The original order is never mutated beyond the derived status.
    const tenders = await withTenant(s.tenantId, (tx) =>
      tx.select().from(orderPayments).where(eq(orderPayments.orderId, s.receipt.orderId)));
    expect(tenders).toHaveLength(1);
    expect(Number(tenders[0].amount)).toBe(s.receipt.paidAmount);
  });

  it("partial refund of 1 of a 2-qty line → partially_refunded, Σ lines == Σ payments", async () => {
    const s = await seedPaidSale("owner", 2);
    const item = (await getOrder(s.tenantId, s.receipt.orderId)).items[0];
    const unit = perUnit(s.receipt.paidAmount, 2);

    const res = await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "partial",
      lines: [{ orderItemId: item.id, quantity: 1, amount: unit, restock: false }],
      payments: [{ method: "cash", amount: unit }],
      reasonCode: "wrong_item",
      clientRefundId: "r1",
    });
    expect(res.paymentStatus).toBe("partially_refunded");

    const [r] = await withTenant(s.tenantId, (tx) => tx.select().from(refunds));
    expect(Number(r.totalAmount)).toBe(unit);
    const lines = await withTenant(s.tenantId, (tx) => tx.select().from(refundLines));
    const pays = await withTenant(s.tenantId, (tx) => tx.select().from(refundPayments));
    expect(lines.reduce((sum, l) => sum + Number(l.amount), 0)).toBe(pays.reduce((sum, p) => sum + Number(p.amount), 0));

    const [o] = await withTenant(s.tenantId, (tx) =>
      tx.select().from(orders).where(eq(orders.id, s.receipt.orderId)));
    expect(o.paymentStatus).toBe("partially_refunded");
  });

  it("rejects an over-refund — Σ payments may never exceed net-paid, writing nothing", async () => {
    const s = await seedPaidSale("owner");
    await expect(issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "full",
      lines: [],
      payments: [{ method: "cash", amount: s.receipt.paidAmount + 1 }],
      reasonCode: "other",
      clientRefundId: "r1",
    })).rejects.toThrow(PosRefundError);

    const written = await withTenant(s.tenantId, (tx) => tx.select().from(refunds));
    expect(written).toHaveLength(0);
  });

  it("rejects a line over-refund — qty may not exceed ordered − already refunded", async () => {
    const s = await seedPaidSale("owner", 2);
    const item = (await getOrder(s.tenantId, s.receipt.orderId)).items[0];
    const unit = perUnit(s.receipt.paidAmount, 2);

    await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "partial",
      lines: [{ orderItemId: item.id, quantity: 1, amount: unit, restock: false }],
      payments: [{ method: "cash", amount: unit }],
      reasonCode: "wrong_item",
      clientRefundId: "r1",
    });

    // Amount fits the remaining net-paid (unit ≤ unit), but qty 2 > the 1 left.
    await expect(issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "partial",
      lines: [{ orderItemId: item.id, quantity: 2, amount: unit, restock: false }],
      payments: [{ method: "cash", amount: unit }],
      reasonCode: "wrong_item",
      clientRefundId: "r2",
    })).rejects.toThrow(PosRefundError);
  });

  it("rejects refunding an unpaid order", async () => {
    const s = await seedPosContext("owner");
    const placed = await placeOrder(s.tenantId, {
      branchId: s.branchId,
      fulfillmentType: "pickup",
      customerName: "Walk-in",
      customerPhone: "000000000",
      lines: [{ productId: s.productId, quantity: 1, selectedOptionIds: [] }],
      paymentMethod: "cash",
      channel: "pos",
    });
    await expect(issueRefund(actorFrom(s.ctx), {
      orderId: placed.orderId,
      kind: "full",
      lines: [],
      payments: [{ method: "cash", amount: 1 }],
      reasonCode: "other",
      clientRefundId: "r1",
    })).rejects.toThrow(PosRefundError);
  });

  it("rejects refunding a cancelled (voided) order", async () => {
    const s = await seedPosContext("owner");
    const placed = await placeOrder(s.tenantId, {
      branchId: s.branchId,
      fulfillmentType: "pickup",
      customerName: "Walk-in",
      customerPhone: "000000000",
      lines: [{ productId: s.productId, quantity: 1, selectedOptionIds: [] }],
      paymentMethod: "cash",
      channel: "pos",
    });
    await cancelOrderByToken(s.tenantId, placed.statusToken);
    await expect(issueRefund(actorFrom(s.ctx), {
      orderId: placed.orderId,
      kind: "full",
      lines: [],
      payments: [{ method: "cash", amount: 1 }],
      reasonCode: "other",
      clientRefundId: "r1",
    })).rejects.toThrow(PosRefundError);
  });

  it("is idempotent on (orderId, clientRefundId) — exactly one refund row", async () => {
    const s = await seedPaidSale("owner");
    const input: RefundInput = {
      orderId: s.receipt.orderId,
      kind: "full",
      lines: [],
      payments: [{ method: "cash", amount: s.receipt.paidAmount }],
      reasonCode: "other",
      clientRefundId: "dup",
    };
    const a = await issueRefund(actorFrom(s.ctx), input);
    const b = await issueRefund(actorFrom(s.ctx), input);
    expect(b.idempotent).toBe(true);
    expect(b.refundId).toBe(a.refundId);

    const rows = await withTenant(s.tenantId, (tx) => tx.select().from(refunds));
    expect(rows).toHaveLength(1);
  });

  it("serializes concurrent refunds on the same order — exactly one wins, no double refund (FOR UPDATE)", async () => {
    // Two full-refund attempts for the FULL paid amount, fired at the same
    // moment with DIFFERENT clientRefundIds, so both pass idempotency. Without
    // the order-row lock both would read the same net-paid, both pass the
    // ceiling, and both commit — refunding twice the money. With `FOR UPDATE`
    // (step 1 of issueRefund) the loser blocks, re-reads net-paid after the
    // winner commits (now 0), and rejects: never a silent over-refund.
    const s = await seedPaidSale("owner");
    const attempt = (clientRefundId: string) =>
      issueRefund(actorFrom(s.ctx), {
        orderId: s.receipt.orderId,
        kind: "full",
        lines: [],
        payments: [{ method: "cash", amount: s.receipt.paidAmount }],
        reasonCode: "other",
        clientRefundId,
      });

    const results = await Promise.allSettled([attempt("race-a"), attempt("race-b")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(PosRefundError);

    const rows = await withTenant(s.tenantId, (tx) => tx.select().from(refunds));
    expect(rows).toHaveLength(1);
  });

  it("rejects a refund when the actor's branch belongs to another tenant (server-side attribution)", async () => {
    const a = await seedPaidSale("owner");
    const foreign = await seedPosContext("owner");
    await expect(
      issueRefund(
        { ...actorFrom(a.ctx), branchId: foreign.branchId },
        {
          orderId: a.receipt.orderId,
          kind: "full",
          lines: [],
          payments: [{ method: "cash", amount: a.receipt.paidAmount }],
          reasonCode: "other",
          clientRefundId: "r1",
        },
      ),
    ).rejects.toThrow(PosRefundError);

    const rows = await withTenant(a.tenantId, (tx) => tx.select().from(refunds));
    expect(rows).toHaveLength(0);
  });

  it("forbids a pos:sell-only cashier refunding without a manager grant", async () => {
    const s = await seedPaidSale("staff");
    await expect(issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "full",
      lines: [],
      payments: [{ method: "cash", amount: s.receipt.paidAmount }],
      reasonCode: "other",
      clientRefundId: "r1",
    })).rejects.toThrow(PosForbiddenError);
  });

  it("lets a pos:sell cashier refund with a manager grant, capturing authorizedByUserId", async () => {
    const s = await seedPaidSale("staff");
    const token = await issueGrant(s.tenantId, "pos:refund", s.managerId);
    const res = await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "full",
      lines: [],
      payments: [{ method: "cash", amount: s.receipt.paidAmount }],
      reasonCode: "other",
      clientRefundId: "r1",
      grantToken: token,
    });

    const [r] = await withTenant(s.tenantId, (tx) => tx.select().from(refunds).where(eq(refunds.id, res.refundId)));
    expect(r.authorizedByUserId).toBe(s.managerId);
    expect(r.byUserId).toBe(s.ctx.cashierUserId);
  });

  it("isolates refunds by tenant — tenant B never sees tenant A's refund (RLS)", async () => {
    const a = await seedPaidSale("owner");
    await issueRefund(actorFrom(a.ctx), {
      orderId: a.receipt.orderId,
      kind: "full",
      lines: [],
      payments: [{ method: "cash", amount: a.receipt.paidAmount }],
      reasonCode: "other",
      clientRefundId: "r1",
    });

    const [bTenant] = await db.insert(tenants).values({
      slug: `rls-b-${Date.now()}`,
      name: "B",
      country: "EG",
      vertical: "restaurant",
    }).returning();
    const seen = await withTenant(bTenant.id, (tx) => tx.select().from(refunds));
    expect(seen).toHaveLength(0);
  });
});

describe("issueRefund restock", () => {
  const readStock = async (tenantId: string, productId: string) => {
    const [row] = await withTenant(tenantId, (tx) =>
      tx.select({ stockQuantity: products.stockQuantity }).from(products).where(eq(products.id, productId)));
    return row.stockQuantity;
  };

  it("restock=true on a stock-tracked line adds the refunded quantity back to products.stockQuantity", async () => {
    const s = await seedStockedPaidSale(1, 10);
    expect(s.stockAfterSale).toBe(9); // the sale itself decremented 10 → 9
    const item = (await getOrder(s.tenantId, s.receipt.orderId)).items[0];

    await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "full",
      lines: [{ orderItemId: item.id, quantity: 1, amount: s.receipt.paidAmount, restock: true }],
      payments: [{ method: "cash", amount: s.receipt.paidAmount }],
      reasonCode: "wrong_item",
      clientRefundId: "r1",
    });

    expect(await readStock(s.tenantId, s.productId)).toBe(10);
  });

  it("restock=false returns the money but leaves stockQuantity unchanged", async () => {
    const s = await seedStockedPaidSale(1, 10);
    expect(s.stockAfterSale).toBe(9);
    const item = (await getOrder(s.tenantId, s.receipt.orderId)).items[0];

    await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "full",
      lines: [{ orderItemId: item.id, quantity: 1, amount: s.receipt.paidAmount, restock: false }],
      payments: [{ method: "cash", amount: s.receipt.paidAmount }],
      reasonCode: "wrong_item",
      clientRefundId: "r1",
    });

    expect(await readStock(s.tenantId, s.productId)).toBe(9);
  });

  it("a partial refund of 1 of a 2-qty line restocks exactly 1, not 2 (line+qty scoping)", async () => {
    const s = await seedStockedPaidSale(2, 10);
    expect(s.stockAfterSale).toBe(8); // 10 − 2 sold
    const item = (await getOrder(s.tenantId, s.receipt.orderId)).items[0];
    const unit = perUnit(s.receipt.paidAmount, 2);

    await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "partial",
      lines: [{ orderItemId: item.id, quantity: 1, amount: unit, restock: true }],
      payments: [{ method: "cash", amount: unit }],
      reasonCode: "wrong_item",
      clientRefundId: "r1",
    });

    // Exactly the returned unit comes back — a whole-order restock would have
    // added 2 (the bug restockRefundedLines' line+qty scope exists to prevent).
    expect(await readStock(s.tenantId, s.productId)).toBe(9);
  });

  it("restock on a restaurant tenant (stockTracking off) is a no-op — stock stays untouched", async () => {
    const s = await seedPaidSale("owner", 1);
    const item = (await getOrder(s.tenantId, s.receipt.orderId)).items[0];

    await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "full",
      lines: [{ orderItemId: item.id, quantity: 1, amount: s.receipt.paidAmount, restock: true }],
      payments: [{ method: "cash", amount: s.receipt.paidAmount }],
      reasonCode: "wrong_item",
      clientRefundId: "r1",
    });

    // Restaurant products are never trackStock'd; the restock gate short-circuits.
    expect(await readStock(s.tenantId, s.productId)).toBeNull();
  });

  // FORWARD DEP (Spec 8): when the stock_ledger exists, restockRefundedLines
  // stops doing the integer add-back asserted above and instead writes a
  // `refund_restock` stock_ledger row reversing the original sale_deduction on
  // the same lot (per the inventory spec's restock-on-refund path). The tests
  // above pin the integer fallback that must be rewired — no issueRefund change.
  it("documents the Spec 8 forward path: integer add-back will become a refund_restock ledger row", () => {
    expect(true).toBe(true);
  });

  describe("refund.issued audit (direct recordAuditEvent)", () => {
    it("emits refund.issued in the same transaction with the issuer and authorizer metadata", async () => {
      const s = await seedPaidSale("owner");
      await issueRefund(actorFrom(s.ctx), {
        orderId: s.receipt.orderId,
        kind: "full",
        lines: [{ orderItemId: (await getOrder(s.tenantId, s.receipt.orderId)).items[0].id, quantity: 1, amount: s.receipt.paidAmount, restock: false }],
        payments: [{ method: "cash", amount: s.receipt.paidAmount }],
        reasonCode: "wrong_item",
        clientRefundId: "r1",
      });

      const [ev] = await eventsFor(s.tenantId, "refund.issued");
      expect(ev).toBeDefined();
      expect(ev.entityType).toBe("refund");
      expect(ev.actorUserId).toBe(s.ctx.cashierUserId);
      expect(ev.actorType).toBe("user");
      expect(ev.metadata).toMatchObject({
        orderId: s.receipt.orderId,
        kind: "full",
        totalAmount: String(s.receipt.paidAmount.toFixed(2)),
        reasonCode: "wrong_item",
        paymentStatus: "refunded",
        byUserId: s.ctx.cashierUserId,
        authorizedByUserId: null,
      });
      // No device fingerprint is attributed to a refund (canonical empty).
      expect(ev.fingerprint).toEqual({ deviceId: null, deviceTokenHash: null, appVersion: null, ip: null, userAgent: null });
      expect((await verifyChain(s.tenantId)).ok).toBe(true);
    });

    it("a failed refund writes neither a refund row nor a refund.issued row (atomicity)", async () => {
      const s = await seedPaidSale("owner");
      await expect(
        issueRefund(actorFrom(s.ctx), {
          orderId: s.receipt.orderId,
          kind: "full",
          lines: [],
          payments: [{ method: "cash", amount: s.receipt.paidAmount * 2 }],
          reasonCode: "wrong_item",
          clientRefundId: "r1",
        }),
      ).rejects.toBeInstanceOf(PosRefundError);
      expect(await eventsFor(s.tenantId, "refund.issued")).toHaveLength(0);
      expect(await withTenant(s.tenantId, (tx) => tx.select().from(refunds))).toHaveLength(0);
    });
  });

  describe("reconciliation money-OUT contract", () => {
    it("a cash refund nets against the day's cash takings: Σ order_payments − Σ refund_payments = net, cash OUT reported", async () => {
      const s = await seedPaidSale("owner", 2);
      const gross = s.total;
      const unit = perUnit(s.receipt.paidAmount, 2);

      await issueRefund(actorFrom(s.ctx), {
        orderId: s.receipt.orderId,
        kind: "partial",
        lines: [{ orderItemId: (await getOrder(s.tenantId, s.receipt.orderId)).items[0].id, quantity: 1, amount: unit, restock: false }],
        payments: [{ method: "cash", amount: unit }],
        reasonCode: "wrong_item",
        clientRefundId: "r1",
      });

      const { paidIn, paidOut, net } = await withTenant(s.tenantId, async (tx) => {
        const tenders = await tx.select().from(orderPayments);
        const back = await tx.select().from(refundPayments);
        const paidIn = round2(tenders.reduce((x, t) => x + Number(t.amount), 0));
        const paidOut = round2(back.reduce((x, p) => x + Number(p.amount), 0));
        return { paidIn, paidOut, net: round2(paidIn - paidOut) };
      });

      // Gross IN (the 2-unit sale) minus the cash OUT (the 1-unit refund).
      expect(paidIn).toBe(gross);
      expect(paidOut).toBe(unit);
      expect(net).toBe(round2(gross - unit));
    });
  });
});
