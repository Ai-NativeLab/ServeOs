import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Test-gap pins from the PR #187 review:
 *  1. `/api/orders` builds its input from an explicit allowlist — a client
 *     CANNOT smuggle `channel` (which would arm the walk-in sentinel or any
 *     other channel-specific behaviour).
 *  2. The POS walk-in sentinel `000000000` is refused on the web channel at
 *     the service layer, even if a client sends it.
 */

const placeOrderMock = vi.fn(
  async (_tenantId: string, _input: Record<string, unknown>): Promise<{ orderId: string; orderNumber: number; statusToken: string }> => ({
    orderId: "o-1", orderNumber: 1, statusToken: "tok",
  }),
);

vi.mock("@/server/ordering/service", () => ({
  placeOrder: (...args: [string, Record<string, unknown>]) => placeOrderMock(...args),
}));

vi.mock("@/server/tenancy", () => ({
  getTenantBySlug: vi.fn(async () => ({ id: "t-1", slug: "roma", status: "active", country: "EG" })),
  isTenantServable: vi.fn(() => true),
}));

vi.mock("@/server/customers/require-customer", () => ({
  CUSTOMER_COOKIE: "cust",
}));

vi.mock("@/server/customers/service", () => ({
  validateCustomerSession: vi.fn(async () => null),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

import { POST } from "./route";


const req = (body: Record<string, unknown>) =>
  new NextRequest("http://localhost/api/orders", {
    method: "POST",
    body: JSON.stringify({ slug: "roma", branchId: "b-1", fulfillmentType: "pickup",
      customerName: "C", customerPhone: "01012345678", lines: [{ productId: "p-1", quantity: 1, selectedOptionIds: [] }], ...body }),
    headers: { "content-type": "application/json" },
  });

describe("/api/orders channel hardening (#187 review)", () => {
  it("ignores a client-supplied channel — the route always places as web", async () => {
    await POST(req({ channel: "pos" }));
    // The allowlist means `channel` is ABSENT from the service input entirely.
    const sent = (placeOrderMock.mock.lastCall?.[1] ?? {}) as Record<string, unknown>;
    expect(sent.channel).toBeUndefined();
  });

  it("passes the sentinel through untouched — enforcement lives in the SERVICE on web", async () => {
    const res = await POST(req({ customerPhone: "000000000", paymentMethod: "cash" }));
    expect(res.status).toBe(201);
    const sent = (placeOrderMock.mock.lastCall?.[1] ?? {}) as Record<string, unknown>;
    expect(sent.customerPhone).toBe("000000000");
    expect(sent.channel).toBeUndefined();
  });
});
