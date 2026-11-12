import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { orders, orderItems } from "@/server/ordering/schema";
import { auditEvents } from "@/server/audit/schema";
import { notifications } from "@/server/notifications/schema";
import { etaSubmissions } from "@/server/fiscal/schema";
import { isEtaActivated, isFiscalEnabled } from "@/server/fiscal/enqueue";
import { orderFiscalView } from "@/app/order/[token]/order-fiscal";
import { activateFiscal, openShiftForCtx, seedPosContext } from "./test-helpers";
import { recordSale, type RecordSaleInput } from "./record-sale";
import { issueRefund, type RefundActor } from "./refund";
import type { PosCashierContext } from "./require-cashier";
import { getCheckoutPricing } from "@/server/tenancy/settings";
import { computeCartTotals } from "@/lib/order-totals";

/**
 * The fiscal gate end to end on the POS money paths: country EG AND ETA
 * activation `active` (`isFiscalEnabled`), and what a refund owes ETA depending
 * on the family its sale was filed under.
 */

const actorFrom = (ctx: PosCashierContext): RefundActor => ({
  tenantId: ctx.tenantId, branchId: ctx.branchId, actorUserId: ctx.cashierUserId, permissions: [...ctx.permissions],
});

const BUYER: NonNullable<RecordSaleInput["buyer"]> = {
  rin: "123456789",
  name: "Nile Trading Co.",
  address: { country: "EG", governate: "Cairo", regionCity: "Maadi", street: "Road 9", buildingNumber: "12" },
};

let n = 0;
async function sell(s: Awaited<ReturnType<typeof seedPosContext>>, extra: Partial<RecordSaleInput> = {}) {
  const id = `gate-${n++}`;
  return recordSale(s.ctx, {
    clientOrderId: id,
    lines: [{ productId: s.productId, quantity: 1, selectedOptionIds: [] }],
    expectedTotal: s.total,
    payments: [{ clientPaymentId: `${id}-p`, method: "cash", amount: s.total, tenderedAmount: s.total }],
    ...extra,
  });
}

async function fullRefund(s: Awaited<ReturnType<typeof seedPosContext>>, orderId: string) {
  return issueRefund(actorFrom(s.ctx), {
    orderId, kind: "full", lines: [], payments: [{ method: "cash", amount: s.total }],
    reasonCode: "customer_changed_mind", clientRefundId: `r-${n++}`,
  });
}

async function rowsOf(tenantId: string) {
  return withTenant(tenantId, (tx) => tx.select().from(etaSubmissions).where(eq(etaSubmissions.tenantId, tenantId)));
}

async function seeded() {
  const s = await seedPosContext("owner");
  await openShiftForCtx(s.ctx);
  return s;
}

describe("isFiscalEnabled — country EG AND activation active", () => {
  it("is false for an EG tenant with no config, or one not (yet / any longer) active", async () => {
    const s = await seedPosContext("owner");
    expect(await isFiscalEnabled(s.tenantId)).toBe(false);
    for (const status of ["not_configured", "pending", "suspended"] as const) {
      await activateFiscal(s.tenantId, status);
      expect(await isFiscalEnabled(s.tenantId), status).toBe(false);
      expect(await isEtaActivated(s.tenantId), status).toBe(false);
    }
    await activateFiscal(s.tenantId);
    expect(await isFiscalEnabled(s.tenantId)).toBe(true);
  });

  it("is false for a non-EG tenant even with an active config row", async () => {
    const s = await seedPosContext("owner");
    await activateFiscal(s.tenantId);
    await db.update(tenants).set({ country: "SA" }).where(eq(tenants.id, s.tenantId));
    expect(await isFiscalEnabled(s.tenantId)).toBe(false);
  });
});

describe("an EG tenant that is NOT activated with ETA", () => {
  it("enqueues nothing for a sale or its refund, and its storefront shows no fiscal block", async () => {
    const s = await seeded();
    await activateFiscal(s.tenantId, "pending");
    const receipt = await sell(s);
    await fullRefund(s, receipt.orderId);
    expect(await rowsOf(s.tenantId)).toHaveLength(0);

    // The status page's gate is `country === "EG" && isEtaActivated(...)`; with
    // it false the view renders nothing — not even a "pending" line.
    const fiscalEnabled = (await isEtaActivated(s.tenantId));
    expect(fiscalEnabled).toBe(false);
    expect(orderFiscalView({ fiscalEnabled, fiscal: null })).toBeNull();
  });

  it("also takes no B2B invoice from the till", async () => {
    const s = await seeded();
    await sell(s, { buyer: BUYER });
    expect(await rowsOf(s.tenantId)).toHaveLength(0);
  });
});

describe("issueRefund — what a fiscal tenant's refund owes ETA", () => {
  it("an e-receipted sale gets a return_receipt", async () => {
    const s = await seeded();
    await activateFiscal(s.tenantId);
    const receipt = await sell(s);
    const refund = await fullRefund(s, receipt.orderId);
    const rows = await rowsOf(s.tenantId);
    expect(rows.find((r) => r.refundId === refund.refundId)).toMatchObject({ docType: "return_receipt", status: "pending" });
  });

  it("a B2B-invoiced sale gets a VISIBLE credit-note-required record — never a return_receipt that cannot resolve", async () => {
    const s = await seeded();
    await activateFiscal(s.tenantId);
    const receipt = await sell(s, { buyer: BUYER });
    expect((await rowsOf(s.tenantId)).map((r) => r.docType)).toEqual(["e_invoice"]);

    const refund = await fullRefund(s, receipt.orderId);
    const forRefund = (await rowsOf(s.tenantId)).filter((r) => r.refundId === refund.refundId);
    expect(forRefund).toHaveLength(1);
    expect(forRefund[0]).toMatchObject({ docType: "credit_note", status: "pending" });

    // The owner is told, and the audit trail says which consequence it had.
    const alerts = await withTenant(s.tenantId, (tx) =>
      tx.select().from(notifications).where(and(eq(notifications.tenantId, s.tenantId), eq(notifications.entityId, refund.refundId))));
    expect(alerts.map((a) => a.title)).toContain("Credit note required");
    const [issued] = await withTenant(s.tenantId, (tx) =>
      tx.select().from(auditEvents).where(and(eq(auditEvents.action, "refund.issued"), eq(auditEvents.entityId, refund.refundId))));
    expect(issued.metadata).toMatchObject({ fiscalFollowUp: "credit_note_required" });
  });

  it("a sale rung BEFORE fiscal was activated has no document to reverse — nothing is queued", async () => {
    const s = await seeded();
    const receipt = await sell(s);
    await activateFiscal(s.tenantId);
    const refund = await fullRefund(s, receipt.orderId);
    expect(refund.idempotent).toBe(false);
    expect(await rowsOf(s.tenantId)).toHaveLength(0);
  });
});

describe("a NON-EG tenant's refunds are untouched by the VAT ceiling", () => {
  it("itemising units after a goodwill refund succeeds (capped VAT), as it did before refund VAT existed", async () => {
    const s = await seeded();
    await db.update(tenants).set({ country: "SA" }).where(eq(tenants.id, s.tenantId));
    // Priced AFTER the flip: country drives the default VAT rate (15% SA).
    const total2 = computeCartTotals(await getCheckoutPricing(s.tenantId), [{ unitPrice: 100, quantity: 2 }], 0).total;
    const receipt = await recordSale(s.ctx, {
      clientOrderId: `gate-sa-${n++}`,
      lines: [{ productId: s.productId, quantity: 2, selectedOptionIds: [] }],
      expectedTotal: total2,
      payments: [{ clientPaymentId: `sa-p-${n++}`, method: "cash", amount: total2, tenderedAmount: total2 }],
    });
    const [order] = await withTenant(s.tenantId, (tx) => tx.select().from(orders).where(eq(orders.id, receipt.orderId)));
    // Non-vacuity: the order carries VAT for the ceiling to bite on.
    expect(Number(order.vatAmount)).toBeGreaterThan(0);

    // A goodwill (headerless) full refund of half the money takes half the VAT…
    const half = Math.round((total2 / 2) * 100) / 100;
    await issueRefund(actorFrom(s.ctx), {
      orderId: receipt.orderId, kind: "full", lines: [], payments: [{ method: "cash", amount: half }],
      reasonCode: "customer_changed_mind", clientRefundId: `sa-goodwill-${n++}`,
    });
    // …then both units are itemised back for the rest. Their unit VAT would
    // re-claim what the goodwill refund already took: this used to be REFUSED.
    const items = await withTenant(s.tenantId, (tx) =>
      tx.select().from(orderItems).where(eq(orderItems.orderId, receipt.orderId)));
    const rest = Math.round((total2 - half) * 100) / 100;
    const res = await issueRefund(actorFrom(s.ctx), {
      orderId: receipt.orderId, kind: "partial",
      lines: [{ orderItemId: items[0].id, quantity: 2, amount: rest, restock: false }],
      payments: [{ method: "cash", amount: rest }],
      reasonCode: "customer_changed_mind", clientRefundId: `sa-items-${n++}`,
    });
    expect(res.paymentStatus).toBe("refunded");
    // And nothing fiscal happened for a non-EG tenant.
    expect(await rowsOf(s.tenantId)).toHaveLength(0);
  });
});
