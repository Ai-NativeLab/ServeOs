import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

// Route-level pins for the re-review R4 regression: with resolvePurchasingActor
// faking an authorized manager and postReceipt stubbed to capture its parsed
// lines, the handler must return a 400 for NaN/negative/missing line fields and
// must COERCE string quantities ("5") to numbers — never pass them through to
// the service as strings, and never leak a 500 for a body-validation problem.
vi.mock("@/app/dashboard/purchasing-permission", () => ({
  resolvePurchasingContext: vi.fn(async () => ({ ctx: { tenantId: "t" }, denied: null })),
  resolvePurchasingActor: vi.fn(async () =>
    ({ tenantId: "t", branchId: "b", actorUserId: "u", vertical: "restaurant" } as const)),
}));

vi.mock("@/server/purchasing/receiving", () => ({
  postReceipt: vi.fn(async () => ({ receiptId: "r", status: "received" as const })),
}));

import { POST } from "./route";
import { postReceipt } from "@/server/purchasing/receiving";

const req = (body: unknown) =>
  new NextRequest("http://localhost/api/purchase-orders/po-1/receipts", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
const params = { params: Promise.resolve({ id: "11111111-1111-1111-1111-111111111111" }) };
const line = (over = {}) => ({ poLineId: "l", receivedQty: 1, uom: "each", unitCost: 1, ...over });

describe("POST [id]/receipts route validation", () => {
  it('coerces a string receivedQty/unitCost to numbers before calling postReceipt (R4)', async () => {
    const res = await POST(req({ lines: [line({ receivedQty: "5", unitCost: "2.50" })] }), params);
    expect(res.status).toBe(201);
    expect(postReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: "u" }),
      "11111111-1111-1111-1111-111111111111",
      expect.objectContaining({
        lines: [expect.objectContaining({ receivedQty: 5, unitCost: 2.5 })],
      }),
    );
  });

  it("maps NaN, negative, and missing line fields to a 400, not a 500", async () => {
    for (const bad of [line({ receivedQty: NaN }), line({ receivedQty: -1 }), line({ receivedQty: undefined }), line({ unitCost: "x" })]) {
      vi.mocked(postReceipt).mockClear();
      const res = await POST(req({ lines: [bad] }), params);
      expect(res.status).toBe(400);
      expect(postReceipt).not.toHaveBeenCalled();
    }
  });

  it("rejects an empty or missing lines array with 400", async () => {
    for (const body of [{ lines: [] }, {}, { lines: "nope" }]) {
      const res = await POST(req(body), params);
      expect(res.status).toBe(400);
    }
  });

  it("rejects invalid JSON with 400", async () => {
    const res = await POST(new NextRequest("http://localhost/x", {
      method: "POST",
      body: "{not json",
      headers: { "content-type": "application/json" },
    }), params);
    expect(res.status).toBe(400);
  });
});