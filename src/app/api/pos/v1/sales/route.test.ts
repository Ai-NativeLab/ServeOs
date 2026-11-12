import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { orders } from "@/server/ordering/schema";
import { orderPayments } from "@/server/pos/tender-schema";
import { recordSale } from "@/server/pos/record-sale";
import { seedPosContext, openShiftForCtx } from "@/server/pos/test-helpers";
import { GET, POST } from "./route";
import { POST as POST_PAYMENT } from "./[id]/payments/route";

/**
 * JSON has no Infinity literal, but `1e999` parses to it — so an ordinary
 * request body can carry one past a `typeof x === "number"` check. These pin
 * that the POS sales routes answer such a body with a 400, not a 500 from
 * money()'s non-finite floor.
 */
function req(url: string, auth: { deviceToken: string; cashierToken: string }, rawBody?: string) {
  return new NextRequest(url, {
    method: rawBody === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${auth.deviceToken}`,
      "X-POS-Cashier": auth.cashierToken,
      ...(rawBody === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: rawBody,
  });
}

describe("POS sales routes refuse non-finite amounts with a 400", () => {
  it("POST /sales with a tender tipAmount of 1e999", async () => {
    const seeded = await seedPosContext("owner");
    await openShiftForCtx(seeded.ctx);
    const body = `{"clientOrderId":"wire-inf","expectedTotal":${seeded.total},`
      + `"lines":[{"productId":"${seeded.productId}","quantity":1,"selectedOptionIds":[]}],`
      + `"payments":[{"clientPaymentId":"p-1","method":"cash","amount":${seeded.total},"tipAmount":1e999}]}`;

    const res = await POST(req("http://x/api/pos/v1/sales", seeded, body));

    expect(res.status).toBe(400);
    expect(await withTenant(seeded.tenantId, (tx) => tx.select().from(orders))).toHaveLength(0);
  });

  it("POST /sales/:id/payments with a tipAmount of 1e999", async () => {
    const seeded = await seedPosContext("owner");
    await openShiftForCtx(seeded.ctx);
    const sale = await recordSale(seeded.ctx, {
      clientOrderId: "wire-top",
      lines: [{ productId: seeded.productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: seeded.total,
      payments: [{ clientPaymentId: "p-1", method: "card", amount: 1 }],
    });

    const res = await POST_PAYMENT(
      req(`http://x/api/pos/v1/sales/${sale.orderId}/payments`, seeded,
        '{"clientPaymentId":"p-2","method":"cash","amount":1,"tipAmount":1e999}'),
      { params: Promise.resolve({ id: sale.orderId }) },
    );

    expect(res.status).toBe(400);
    const tenders = await withTenant(seeded.tenantId, (tx) =>
      tx.select().from(orderPayments).where(eq(orderPayments.orderId, sale.orderId)));
    expect(tenders).toHaveLength(1);
  });

  it.each(["amount=Infinity", "orderNumber=Infinity", "page=Infinity"])(
    "GET /sales?%s",
    async (query) => {
      const seeded = await seedPosContext("owner");
      const res = await GET(req(`http://x/api/pos/v1/sales?${query}`, seeded));
      expect(res.status).toBe(400);
    },
  );
});
