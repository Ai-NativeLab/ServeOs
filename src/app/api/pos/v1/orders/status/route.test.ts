import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { withTenant } from "@/db/with-tenant";
import { orders } from "@/server/ordering/schema";
import { recordSale } from "@/server/pos/record-sale";
import { seedPosContext } from "@/server/pos/test-helpers";
import { POST } from "./route";

/**
 * #187 review: the till's order-queue route let transitionStatus' domain
 * refusals escape as 500s, so a cashier pressing "Mark ready" on an order with
 * an unverified offline payment saw nothing at all. Every refusal must come
 * back as a status + `{ error, code }` the till can show.
 */
async function orderInState(status: "preparing" | "completed", paymentStatus: "pending_verification" | "paid") {
  const seeded = await seedPosContext("owner");
  const sale = await recordSale(seeded.ctx, {
    clientOrderId: crypto.randomUUID(),
    lines: [{ productId: seeded.productId, quantity: 1, selectedOptionIds: [] }],
    expectedTotal: seeded.total,
    payments: [{ clientPaymentId: "p-1", method: "card", amount: seeded.total }],
  });
  await withTenant(seeded.tenantId, (tx) =>
    tx.update(orders).set({ status, paymentStatus }).where(eq(orders.id, sale.orderId)));
  return { ...seeded, orderId: sale.orderId };
}

const advance = (deviceToken: string, body: unknown) =>
  POST(new NextRequest("http://localhost/api/pos/v1/orders/status", {
    method: "POST",
    headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

describe("POST /api/pos/v1/orders/status — domain refusals", () => {
  it("answers 422 payment_not_verified when an unverified order is marked ready", async () => {
    const { deviceToken, orderId } = await orderInState("preparing", "pending_verification");

    const res = await advance(deviceToken, { orderId, toStatus: "ready" });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("payment_not_verified");
    expect(body.error).toMatch(/payments queue/i);
  });

  it("answers 422 invalid_transition for a move the state machine forbids", async () => {
    const { deviceToken, orderId } = await orderInState("completed", "paid");

    const res = await advance(deviceToken, { orderId, toStatus: "confirmed" });

    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("invalid_transition");
  });

  it("answers 404 for an order this tenant does not have, and 400 for a malformed id", async () => {
    const { deviceToken } = await seedPosContext("owner");

    const missing = await advance(deviceToken, { orderId: crypto.randomUUID(), toStatus: "ready" });
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe("order_not_found");

    const malformed = await advance(deviceToken, { orderId: "not-a-uuid", toStatus: "ready" });
    expect(malformed.status).toBe(400);
  });

  it("still advances a legal transition", async () => {
    const { deviceToken, orderId } = await orderInState("preparing", "paid");

    const res = await advance(deviceToken, { orderId, toStatus: "ready" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: orderId, status: "ready" });
  });
});
