import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { orders } from "@/server/ordering/schema";
import {
  getCheckoutPricing,
  setPricesIncludeVat,
  setServiceChargeRate,
  setVatEnabled,
} from "@/server/tenancy/settings";
import { computeCartTotals } from "@/lib/order-totals";
import { tenants } from "@/server/tenancy/schema";
import { getOrder, placeOrder, cancelOrderByToken } from "@/server/ordering/service";
import { products } from "@/server/catalog/schema";
import { createProduct, updateProduct } from "@/server/catalog/service";
import { sumDecimal } from "@/server/fiscal/decimal";
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

  /**
   * THE REFUND TRANSACTION TAKES EXACTLY ONE POOL CONNECTION (round 2 Task 10a),
   * and this is the honest account of how that was verified — including what the
   * verification cannot do.
   *
   * THE HAZARD. `withTenant` holds ONE pool connection for the whole transaction.
   * Any read through the global `db` from inside it takes a SECOND. pg-pool is
   * configured `max=10` with `connectionTimeoutMillis=0` (wait forever), so ten
   * concurrent refunds each holding a tx connection while blocking on a second
   * one deadlock the pool permanently — not slowly, and not recoverably. Round 1
   * closed this for `isFiscalEnabled`; the same read survived one call deeper,
   * where nothing in `refund.ts` looked like a database call.
   *
   * WHY GREP DID NOT FIND IT AND CANNOT PROVE IT GONE. `grep 'db\.'` over
   * `refund.ts` was clean before this fix and is clean after — the read was two
   * calls away, in another module, behind a function whose name says "restock".
   * A textual search sees one frame; the hazard lives in the transitive closure.
   * So the closure is enumerated BY HAND below, and each node says how it was
   * checked. This list is the verification. It is only as good as its next
   * reader's willingness to extend it when a call is added inside the tx.
   *
   *   issueRefund (pos/refund.ts)
   *     ├─ resolveAuthorizer .............. BEFORE the tx (round 1 hoist)
   *     ├─ isFiscalEnabled ................ BEFORE the tx (round 1 hoist)
   *     ├─ resolveRestockCapabilities ..... BEFORE the tx (THIS task's hoist)
   *     │     └─ getTenantById → db.select   ← the former in-tx read, now outside
   *     └─ withTenant(tx) ═══ TX BOUNDARY: one connection from here down ═══
   *          ├─ tx.select / tx.update / tx.insert ......... on the tx ✓
   *          ├─ restockRefundedLines(tx, lines, caps) ..... ordering/service.ts
   *          │     ├─ getCapabilities .................... REMOVED from this
   *          │     │                                       frame; `caps` is now a
   *          │     │                                       parameter. (Pure
   *          │     │                                       in-memory registry
   *          │     │                                       lookup either way —
   *          │     │                                       verticals/registry.ts
   *          │     │                                       indexes a const.)
   *          │     ├─ getTenantById ...................... REMOVED — was the bug
   *          │     └─ tx.select / tx.update .............. on the tx ✓
   *          ├─ computeRefundVat ......................... pure arithmetic, read
   *          │                                             (pos/refund-vat.ts)
   *          ├─ recordAuditEvent(ctx, event, tx) ......... audit/service.ts —
   *          │                                             imports `db` ONLY for
   *          │                                             its `Tx` type alias;
   *          │                                             every statement in it
   *          │                                             runs on the passed tx,
   *          │                                             read line by line ✓
   *          └─ enqueueFiscalDocument(ctx, input, tx) .... fiscal/enqueue.ts —
   *               `if (tx) { await run(tx); return; }` before the `withTenant`
   *               fallback, so the tx-passed path never opens a connection ✓
   *     ══ TX BOUNDARY CLOSES ══
   *     └─ publishTenantEvent ×2 ....................... AFTER the commit, and
   *          outside the transaction entirely — a sibling of `withTenant`, not a
   *          child of it. Gated on `!result.idempotent`, so a replayed refund
   *          announces nothing. No database access in any case: it is an HTTP
   *          POST to Supabase (realtime/publish.ts) ✓
   *
   * A CORRECTION WORTH LEAVING VISIBLE. The first version of this trace put
   * `publishTenantEvent` INSIDE the transaction and raised it as a finding —
   * "an HTTP call holding a tx open across a third party's latency". That was
   * WRONG: the calls sit after the closing `});`, which the first reading did
   * not check, and the code comment beside them already says "Post-commit, and
   * only for a refund that actually happened". The lesson is the one this whole
   * comment is about — a call's position in a FILE is not its position in a
   * CALL TREE, and reading a window of lines is not reading the structure. It is
   * recorded rather than quietly deleted because the risk now runs the other
   * way: a future reader who half-remembers "the publish is in the transaction"
   * might "fix" correct code by moving it.
   */
  it("keeps the tenant read out of the refund transaction — the hoist, pinned structurally", async () => {
    const { readFileSync } = await import("node:fs");
    const service = readFileSync("src/server/ordering/service.ts", "utf8");
    const body = service.slice(service.indexOf("export async function restockRefundedLines"));
    const fn = body.slice(0, body.indexOf("\n}\n") + 3);

    // NARROW AND HONEST: this proves the ONE frame that carried the bug no
    // longer reads the tenant, and nothing more. It is not a proof about the
    // closure above — a helper called from here could reintroduce the read and
    // this assertion would still pass. It is here because re-inlining the read
    // into this exact function is the specific regression the fix invites: the
    // `caps` parameter looks like ceremony until you know why it exists.
    expect(fn).not.toContain("getTenantById");
    expect(fn).toContain("caps.stockTracking");
    // And the caller really does resolve it before opening the transaction —
    // the assertion that would fail if someone "tidied" the hoist back inside.
    const refundSrc = readFileSync("src/server/pos/refund.ts", "utf8");
    expect(refundSrc.indexOf("resolveRestockCapabilities(actor.tenantId)"))
      .toBeLessThan(refundSrc.indexOf("await withTenant(actor.tenantId"));
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

/**
 * A paid sale under PINNED pricing (VAT on/off, inclusive/exclusive, service
 * charge) with one or more product lines at chosen prices.
 *
 * The VAT-persistence assertions below are string-exact, so the pricing that
 * produced `orders.vatAmount` has to be stated rather than inherited from the
 * fixture defaults, and more than one line at different prices is what makes
 * the largest-remainder split observable at all.
 */
async function seedPricedPaidSale(opts: {
  vatEnabled?: boolean;
  pricesIncludeVat?: boolean;
  serviceChargeRate?: number;
  lines: { basePrice: string; quantity: number }[];
}) {
  const s = await seedPosContext("owner");
  await openShiftForCtx(s.ctx);
  if (opts.vatEnabled !== undefined) await setVatEnabled(s.tenantId, opts.vatEnabled);
  if (opts.pricesIncludeVat !== undefined) await setPricesIncludeVat(s.tenantId, opts.pricesIncludeVat);
  if (opts.serviceChargeRate !== undefined) await setServiceChargeRate(s.tenantId, opts.serviceChargeRate);

  const [fixture] = await withTenant(s.tenantId, (tx) =>
    tx.select().from(products).where(eq(products.id, s.productId)));

  const productIds: string[] = [];
  for (const [i, line] of opts.lines.entries()) {
    if (i === 0 && line.basePrice === fixture.basePrice) {
      productIds.push(s.productId);
      continue;
    }
    const p = await createProduct(s.tenantId, {
      nameEn: `Extra ${i}`, nameAr: `إضافي ${i}`,
      basePrice: line.basePrice, categoryId: fixture.categoryId,
    });
    await updateProduct(s.tenantId, p.id, { isPublished: true });
    productIds.push(p.id);
  }

  const pricing = await getCheckoutPricing(s.tenantId);
  const total = computeCartTotals(
    pricing,
    opts.lines.map((l) => ({ unitPrice: Number(l.basePrice), quantity: l.quantity })),
    0,
  ).total;
  const receipt = await recordSale(s.ctx, {
    clientOrderId: "sale-1",
    lines: opts.lines.map((l, i) => ({ productId: productIds[i], quantity: l.quantity, selectedOptionIds: [] })),
    expectedTotal: total,
    payments: [{ clientPaymentId: "pay-1", method: "cash", amount: total, tenderedAmount: total }],
  });

  return { ...s, productIds, receipt, total };
}

const refundRows = (tenantId: string) =>
  withTenant(tenantId, (tx) => tx.select().from(refunds).orderBy(refunds.createdAt));
const refundLineRows = (tenantId: string, refundId: string) =>
  withTenant(tenantId, (tx) =>
    tx.select().from(refundLines).where(eq(refundLines.refundId, refundId)).orderBy(refundLines.orderItemId));
const orderRow = (tenantId: string, orderId: string) =>
  withTenant(tenantId, async (tx) => (await tx.select().from(orders).where(eq(orders.id, orderId)))[0]);

/**
 * Every number here is asserted as a STRING. `refunds.vatAmount` exists so the
 * fiscal layer can reverse exactly what the sale declared; a float comparison
 * would hide the very cent-level drift the largest-remainder allocation is
 * there to prevent.
 */
describe("issueRefund VAT persistence", () => {
  it("itemised partial refunds carry each line's largest-remainder share of the order's VAT, summing to it exactly", async () => {
    // 100.00 + 33.33 VAT-INCLUSIVE at 14% → taxable 133.33, VAT 16.37, which
    // splits 12.28 / 4.09 across the two lines (the odd cent goes to the larger
    // remainder, i.e. the 100.00 line).
    const s = await seedPricedPaidSale({
      pricesIncludeVat: true,
      lines: [{ basePrice: "100", quantity: 1 }, { basePrice: "33.33", quantity: 1 }],
    });
    const order = await getOrder(s.tenantId, s.receipt.orderId);
    expect(order.vatAmount).toBe("16.37");
    const big = order.items.find((i) => i.productId === s.productIds[0])!;
    const small = order.items.find((i) => i.productId === s.productIds[1])!;

    const first = await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "partial",
      lines: [{ orderItemId: big.id, quantity: 1, amount: 100, restock: false }],
      payments: [{ method: "cash", amount: 100 }],
      reasonCode: "wrong_item",
      clientRefundId: "r1",
    });
    const firstLines = await refundLineRows(s.tenantId, first.refundId);
    expect(firstLines.map((l) => l.vatAmount)).toEqual(["12.28"]);

    const second = await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "partial",
      lines: [{ orderItemId: small.id, quantity: 1, amount: 33.33, restock: false }],
      payments: [{ method: "cash", amount: 33.33 }],
      reasonCode: "wrong_item",
      clientRefundId: "r2",
    });
    const secondLines = await refundLineRows(s.tenantId, second.refundId);
    expect(secondLines.map((l) => l.vatAmount)).toEqual(["4.09"]);

    const rows = await refundRows(s.tenantId);
    expect(rows.map((r) => r.vatAmount)).toEqual(["12.28", "4.09"]);
    // The whole order returned ⇒ the whole order's VAT reversed, to the cent.
    expect(sumDecimal("refund vat", rows.map((r) => r.vatAmount))).toBe(order.vatAmount);
  });

  it("splits a line's VAT across its units so repeated 1-of-n refunds never over-allocate", async () => {
    // 33.33 × 2 VAT-inclusive → VAT 8.19 on the line, which is an ODD number of
    // cents over two units: 4.10 + 4.09. A naive `lineVat × qty/orderQty`
    // half-up would store 4.10 twice and reverse 8.20 — a cent more VAT than
    // the sale ever declared.
    const s = await seedPricedPaidSale({
      pricesIncludeVat: true,
      lines: [{ basePrice: "33.33", quantity: 2 }],
    });
    const order = await getOrder(s.tenantId, s.receipt.orderId);
    expect(order.vatAmount).toBe("8.19");
    const item = order.items[0];

    const a = await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "partial",
      lines: [{ orderItemId: item.id, quantity: 1, amount: 33.33, restock: false }],
      payments: [{ method: "cash", amount: 33.33 }],
      reasonCode: "wrong_item",
      clientRefundId: "r1",
    });
    const b = await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "partial",
      lines: [{ orderItemId: item.id, quantity: 1, amount: 33.33, restock: false }],
      payments: [{ method: "cash", amount: 33.33 }],
      reasonCode: "wrong_item",
      clientRefundId: "r2",
    });

    expect((await refundLineRows(s.tenantId, a.refundId))[0].vatAmount).toBe("4.10");
    expect((await refundLineRows(s.tenantId, b.refundId))[0].vatAmount).toBe("4.09");
    const rows = await refundRows(s.tenantId);
    expect(sumDecimal("refund vat", rows.map((r) => r.vatAmount))).toBe("8.19");
  });

  it("a headerless full refund stores the order's whole VAT", async () => {
    // Fixture default: VAT-exclusive 14% on 100.00 → VAT 14.00, total 114.00.
    const s = await seedPaidSale("owner");
    const order = await orderRow(s.tenantId, s.receipt.orderId);
    expect(order.vatAmount).toBe("14.00");

    const res = await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "full",
      lines: [],
      payments: [{ method: "cash", amount: s.receipt.paidAmount }],
      reasonCode: "customer_changed_mind",
      clientRefundId: "r1",
    });

    const [r] = await refundRows(s.tenantId);
    expect(r.vatAmount).toBe("14.00");
    expect(await refundLineRows(s.tenantId, res.refundId)).toHaveLength(0);
  });

  it("a headerless full refund after a partial one stores only the VAT still un-reversed", async () => {
    const s = await seedPricedPaidSale({
      pricesIncludeVat: true,
      lines: [{ basePrice: "100", quantity: 2 }],
    });
    const order = await getOrder(s.tenantId, s.receipt.orderId);
    expect(order.vatAmount).toBe("24.56");

    await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "partial",
      lines: [{ orderItemId: order.items[0].id, quantity: 1, amount: 100, restock: false }],
      payments: [{ method: "cash", amount: 100 }],
      reasonCode: "wrong_item",
      clientRefundId: "r1",
    });
    await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "full",
      lines: [],
      payments: [{ method: "cash", amount: 100 }],
      reasonCode: "customer_changed_mind",
      clientRefundId: "r2",
    });

    const rows = await refundRows(s.tenantId);
    expect(rows.map((r) => r.vatAmount)).toEqual(["12.28", "12.28"]);
    expect(sumDecimal("refund vat", rows.map((r) => r.vatAmount))).toBe(order.vatAmount);
  });

  it("a goodwill full refund of part of the balance scales the remaining VAT, half-up at 2dp", async () => {
    // 14.00 VAT on a 114.00 balance, 45.00 handed back → 14.00 × 45 / 114 =
    // 5.5263…, which is 5.53 half-up (5.52 if it were truncated).
    const s = await seedPaidSale("owner");
    const res = await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "full",
      lines: [],
      payments: [{ method: "cash", amount: 45 }],
      reasonCode: "other",
      clientRefundId: "r1",
    });

    const [r] = await refundRows(s.tenantId);
    expect(r.totalAmount).toBe("45.00");
    expect(r.vatAmount).toBe("5.53");
    expect(await refundLineRows(s.tenantId, res.refundId)).toHaveLength(0);
  });

  it("the service charge's VAT share is withheld from item lines and only returned by a full refund", async () => {
    // 100.00 + a 10% service charge, VAT-inclusive 14% → taxable 110.00, VAT
    // 13.51, of which 12.28 sits on the item and 1.23 on the service charge.
    // Returning the item reverses 12.28 — exactly the VAT inside the 100.00
    // handed back — and the service charge's 1.23 stays declared until the
    // balance itself is refunded.
    const s = await seedPricedPaidSale({
      pricesIncludeVat: true,
      serviceChargeRate: 10,
      lines: [{ basePrice: "100", quantity: 1 }],
    });
    const order = await getOrder(s.tenantId, s.receipt.orderId);
    expect(order.serviceChargeAmount).toBe("10.00");
    expect(order.vatAmount).toBe("13.51");

    const itemised = await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "partial",
      lines: [{ orderItemId: order.items[0].id, quantity: 1, amount: 100, restock: false }],
      payments: [{ method: "cash", amount: 100 }],
      reasonCode: "wrong_item",
      clientRefundId: "r1",
    });
    expect((await refundLineRows(s.tenantId, itemised.refundId))[0].vatAmount).toBe("12.28");

    // The 10.00 service charge is the only balance left; refunding it reverses
    // the VAT share the item lines deliberately never claimed.
    await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "full",
      lines: [],
      payments: [{ method: "cash", amount: 10 }],
      reasonCode: "other",
      clientRefundId: "r2",
    });

    const rows = await refundRows(s.tenantId);
    expect(rows.map((r) => r.vatAmount)).toEqual(["12.28", "1.23"]);
    expect(sumDecimal("refund vat", rows.map((r) => r.vatAmount))).toBe(order.vatAmount);
  });

  it("an itemised FULL refund of the whole balance tops its lines up to the order's whole VAT", async () => {
    // Same 100.00 item under a 10% service charge as above: 12.28 of the 13.51
    // VAT sits on the item, 1.23 on the service charge. Handing back the whole
    // 110.00 returns the service charge too, so its VAT belongs in the stored
    // figures — and there is no balance left for a later refund to recover it.
    const s = await seedPricedPaidSale({
      pricesIncludeVat: true,
      serviceChargeRate: 10,
      lines: [{ basePrice: "100", quantity: 1 }],
    });
    const order = await getOrder(s.tenantId, s.receipt.orderId);
    expect(order.vatAmount).toBe("13.51");

    const res = await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "full",
      lines: [{ orderItemId: order.items[0].id, quantity: 1, amount: 110, restock: false }],
      payments: [{ method: "cash", amount: 110 }],
      reasonCode: "customer_changed_mind",
      clientRefundId: "r1",
    });

    // 12.28 from the item bucket + the 1.23 top-up = the order's whole VAT.
    expect((await refundLineRows(s.tenantId, res.refundId))[0].vatAmount).toBe("13.51");
    const [r] = await refundRows(s.tenantId);
    expect(r.vatAmount).toBe("13.51");
  });

  it("an itemised FULL refund after a partial one tops up only to the VAT still un-reversed", async () => {
    // 100.00 + 33.33 under a 10% service charge (13.33), VAT-inclusive 14% on
    // the 146.66 taxable → 18.01, split 12.28 / 4.09 across the items and 1.64
    // onto the service charge. The 33.33 line goes back first (4.09), then the
    // rest of the balance is refunded itemised: 18.01 − 4.09 = 13.92, i.e. the
    // 100.00 line's 12.28 topped up by the service charge's whole 1.64.
    const s = await seedPricedPaidSale({
      pricesIncludeVat: true,
      serviceChargeRate: 10,
      lines: [{ basePrice: "100", quantity: 1 }, { basePrice: "33.33", quantity: 1 }],
    });
    const order = await getOrder(s.tenantId, s.receipt.orderId);
    expect(order.serviceChargeAmount).toBe("13.33");
    expect(order.vatAmount).toBe("18.01");
    const big = order.items.find((i) => i.productId === s.productIds[0])!;
    const small = order.items.find((i) => i.productId === s.productIds[1])!;

    await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "partial",
      lines: [{ orderItemId: small.id, quantity: 1, amount: 33.33, restock: false }],
      payments: [{ method: "cash", amount: 33.33 }],
      reasonCode: "wrong_item",
      clientRefundId: "r1",
    });
    const rest = await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "full",
      lines: [{ orderItemId: big.id, quantity: 1, amount: 113.33, restock: false }],
      payments: [{ method: "cash", amount: 113.33 }],
      reasonCode: "customer_changed_mind",
      clientRefundId: "r2",
    });

    expect((await refundLineRows(s.tenantId, rest.refundId))[0].vatAmount).toBe("13.92");
    const rows = await refundRows(s.tenantId);
    expect(rows.map((r) => r.vatAmount)).toEqual(["4.09", "13.92"]);
    expect(sumDecimal("refund vat", rows.map((r) => r.vatAmount))).toBe(order.vatAmount);
  });

  it("an itemised FULL refund after a goodwill one scales its lines DOWN to the VAT still un-reversed", async () => {
    // The mirror image of the top-up: a goodwill refund took 12.28 of the 24.56
    // without naming items, so itemising both units afterwards must store 12.28,
    // not the 24.56 the units are worth. (The same shapes as a `partial` refund
    // is refused by the invariant — a full refund of the balance is exactly the
    // remedy its message names.)
    const s = await seedPricedPaidSale({
      pricesIncludeVat: true,
      lines: [{ basePrice: "100", quantity: 2 }],
    });
    const order = await getOrder(s.tenantId, s.receipt.orderId);
    expect(order.vatAmount).toBe("24.56");

    await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "full",
      lines: [],
      payments: [{ method: "cash", amount: 100 }],
      reasonCode: "other",
      clientRefundId: "goodwill",
    });
    const rest = await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "full",
      lines: [{ orderItemId: order.items[0].id, quantity: 2, amount: 100, restock: false }],
      payments: [{ method: "cash", amount: 100 }],
      reasonCode: "customer_changed_mind",
      clientRefundId: "rest",
    });

    expect((await refundLineRows(s.tenantId, rest.refundId))[0].vatAmount).toBe("12.28");
    const rows = await refundRows(s.tenantId);
    expect(rows.map((r) => r.vatAmount)).toEqual(["12.28", "12.28"]);
    expect(sumDecimal("refund vat", rows.map((r) => r.vatAmount))).toBe(order.vatAmount);
  });

  it("floors a scaled-down line at zero rather than storing negative VAT, keeping Σ lines == header", async () => {
    // The pathological shape: a full refund's line amounts are never validated
    // against its tenders, so they can point the OPPOSITE way to the VAT the
    // items carry — 190.00/10.00 items returned as 10.00/190.00 lines. With a
    // prior goodwill refund having taken 24.00 of the 24.56 unattributed, the
    // pro-rata scale-down lands on 22.13 / −21.57. A negative
    // `refund_lines.vatAmount` is an invented input tax credit on the return
    // document, so the offender floors at 0.00 and the line still holding VAT
    // absorbs what it could not: 0.56 / 0.00, summing to the 0.56 header.
    const s = await seedPricedPaidSale({
      pricesIncludeVat: true,
      lines: [{ basePrice: "190", quantity: 1 }, { basePrice: "10", quantity: 1 }],
    });
    const order = await getOrder(s.tenantId, s.receipt.orderId);
    expect(order.vatAmount).toBe("24.56");
    const big = order.items.find((i) => i.productId === s.productIds[0])!;   // 190.00 → 23.33 of VAT
    const small = order.items.find((i) => i.productId === s.productIds[1])!; // 10.00 → 1.23 of VAT

    await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "full",
      lines: [],
      payments: [{ method: "cash", amount: 195.44 }],
      reasonCode: "other",
      clientRefundId: "goodwill",
    });
    const rows0 = await refundRows(s.tenantId);
    expect(rows0[0].vatAmount).toBe("24.00");

    const rest = await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "full",
      lines: [
        { orderItemId: big.id, quantity: 1, amount: 10, restock: false },
        { orderItemId: small.id, quantity: 1, amount: 190, restock: false },
      ],
      payments: [{ method: "cash", amount: 4.56 }],
      reasonCode: "customer_changed_mind",
      clientRefundId: "rest",
    });

    const stored = new Map(
      (await refundLineRows(s.tenantId, rest.refundId)).map((l) => [l.orderItemId, l.vatAmount]),
    );
    expect(stored.get(big.id)).toBe("0.56");
    expect(stored.get(small.id)).toBe("0.00");
    const rows = await refundRows(s.tenantId);
    expect(rows.map((r) => r.vatAmount)).toEqual(["24.00", "0.56"]);
    expect(sumDecimal("refund vat", rows.map((r) => r.vatAmount))).toBe(order.vatAmount);
  });

  it("tops up over line QUANTITIES when a full refund's lines carry no amounts — never 'every weight is zero'", async () => {
    // A full refund's lines need not carry money at all (only a partial must
    // equal its tenders). Weighting the top-up by those zero amounts would make
    // `allocateLargestRemainder` throw "cannot allocate … every weight is zero";
    // the quantities, which every line has, are the fallback.
    const s = await seedPricedPaidSale({
      pricesIncludeVat: true,
      serviceChargeRate: 10,
      lines: [{ basePrice: "100", quantity: 1 }],
    });
    const order = await getOrder(s.tenantId, s.receipt.orderId);
    expect(order.vatAmount).toBe("13.51");

    const res = await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "full",
      lines: [{ orderItemId: order.items[0].id, quantity: 1, amount: 0, restock: false }],
      payments: [{ method: "cash", amount: 110 }],
      reasonCode: "customer_changed_mind",
      clientRefundId: "r1",
    });

    const [line] = await refundLineRows(s.tenantId, res.refundId);
    expect(line.amount).toBe("0.00");
    expect(line.vatAmount).toBe("13.51"); // 12.28 + the 1.23 service-charge top-up
    expect((await refundRows(s.tenantId))[0].vatAmount).toBe("13.51");
  });

  it("a zero-VAT order stores zeros on both the header and its lines", async () => {
    const s = await seedPricedPaidSale({
      vatEnabled: false,
      lines: [{ basePrice: "100", quantity: 2 }],
    });
    const order = await getOrder(s.tenantId, s.receipt.orderId);
    expect(order.vatAmount).toBe("0.00");

    const itemised = await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "partial",
      lines: [{ orderItemId: order.items[0].id, quantity: 1, amount: 100, restock: false }],
      payments: [{ method: "cash", amount: 100 }],
      reasonCode: "wrong_item",
      clientRefundId: "r1",
    });
    expect((await refundLineRows(s.tenantId, itemised.refundId))[0].vatAmount).toBe("0.00");

    await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "full",
      lines: [],
      payments: [{ method: "cash", amount: 100 }],
      reasonCode: "other",
      clientRefundId: "r2",
    });
    const rows = await refundRows(s.tenantId);
    expect(rows.map((r) => r.vatAmount)).toEqual(["0.00", "0.00"]);
  });

  it("CAPS (never refuses) a refund whose VAT would push the order's reversed VAT above what it charged", async () => {
    // A goodwill full refund takes a scaled share of the remaining VAT without
    // naming items; itemising the SAME units afterwards would reverse their VAT
    // a second time. The refund goes through — refusing would block a refund,
    // for every tenant, over a tax figure — and its VAT is capped at what is
    // left unreversed, so the order's declared VAT stays the ceiling.
    const s = await seedPricedPaidSale({
      pricesIncludeVat: true,
      lines: [{ basePrice: "100", quantity: 2 }],
    });
    const order = await getOrder(s.tenantId, s.receipt.orderId);

    await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "full",
      lines: [],
      payments: [{ method: "cash", amount: 100 }],
      reasonCode: "other",
      clientRefundId: "goodwill",
    });

    const res = await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "partial",
      lines: [{ orderItemId: order.items[0].id, quantity: 2, amount: 100, restock: false }],
      payments: [{ method: "cash", amount: 100 }],
      reasonCode: "wrong_item",
      clientRefundId: "over",
    });
    expect(res.idempotent).toBe(false);

    const rows = await refundRows(s.tenantId);
    expect(rows).toHaveLength(2);
    // 12.28 + 12.28 = the order's 24.56 — never more.
    expect(rows.map((r) => r.vatAmount).sort()).toEqual(["12.28", "12.28"]);
    expect(await withTenant(s.tenantId, (tx) => tx.select().from(refundPayments))).toHaveLength(2);
  });

  it("an idempotent replay returns the stored refund without doubling its VAT", async () => {
    const s = await seedPaidSale("owner", 2);
    const item = (await getOrder(s.tenantId, s.receipt.orderId)).items[0];
    const unit = perUnit(s.receipt.paidAmount, 2);
    const input: RefundInput = {
      orderId: s.receipt.orderId,
      kind: "partial",
      lines: [{ orderItemId: item.id, quantity: 1, amount: unit, restock: false }],
      payments: [{ method: "cash", amount: unit }],
      reasonCode: "wrong_item",
      clientRefundId: "dup",
    };

    const a = await issueRefund(actorFrom(s.ctx), input);
    const b = await issueRefund(actorFrom(s.ctx), input);
    expect(b.idempotent).toBe(true);
    expect(b.refundId).toBe(a.refundId);

    const rows = await refundRows(s.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0].vatAmount).toBe("14.00"); // half of the 28.00 VAT on the 2-unit sale
    const lines = await refundLineRows(s.tenantId, a.refundId);
    expect(lines).toHaveLength(1);
    expect(lines[0].vatAmount).toBe("14.00");
  });
});
