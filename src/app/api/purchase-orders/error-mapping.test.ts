import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { InvalidPoInputError, NoBranchError, PoNotFoundError } from "@/server/purchasing/errors";

/**
 * #125's acceptance criteria: "malformed body → 400 never 500", and error
 * mapping "in every route". Six of the PO routes map the domain errors; the
 * CREATE route — the entry point of the whole flow — caught everything into a
 * 500 "Something went wrong", so a cross-tenant supplierId (which the service
 * reports as InvalidPoInputError) looked like a server fault, and a tenant with
 * no branch 500'd instead of telling the caller to create one.
 *
 * The permission gate is stubbed OPEN here; route.test.ts covers it closed.
 */
vi.mock("@/app/dashboard/purchasing-permission", () => ({
  resolvePurchasingContext: vi.fn(async () => ({
    ctx: { tenantId: "t", user: { id: "u" }, roleKeys: ["owner"] },
    denied: null,
  })),
  resolvePurchasingActor: vi.fn(async () => ({
    tenantId: "t", branchId: "b", actorUserId: "u", vertical: "restaurant",
  })),
}));

const createDraftPo = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const listPurchaseOrders = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => []);
vi.mock("@/server/purchasing/service", () => ({
  createDraftPo: (...a: unknown[]) => createDraftPo(...a),
  listPurchaseOrders: (...a: unknown[]) => listPurchaseOrders(...a),
}));

const post = (body: unknown) =>
  new NextRequest("http://localhost/api/purchase-orders", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

const okBody = {
  supplierId: "11111111-1111-1111-1111-111111111111",
  branchId: "22222222-2222-2222-2222-222222222222",
  lines: [{ itemId: "33333333-3333-3333-3333-333333333333", qtyOrdered: 1, uom: "each", unitCost: 1 }],
};

describe("POST /api/purchase-orders maps domain errors instead of blanket-500", () => {
  it("InvalidPoInputError → 400 with the reason, not 500", async () => {
    createDraftPo.mockRejectedValueOnce(
      new InvalidPoInputError("supplierId 1111 is not a supplier of this tenant"),
    );
    const { POST } = await import("./route");
    const res = await POST(post(okBody));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("not a supplier of this tenant"),
    });
  });

  it("NoBranchError → 409, so a zero-branch tenant is told what to fix", async () => {
    createDraftPo.mockRejectedValueOnce(new NoBranchError());
    const { POST } = await import("./route");
    const res = await POST(post(okBody));
    expect(res.status).toBe(409);
  });

  it("PoNotFoundError → 404", async () => {
    createDraftPo.mockRejectedValueOnce(new PoNotFoundError());
    const { POST } = await import("./route");
    const res = await POST(post(okBody));
    expect(res.status).toBe(404);
  });

  it("an unrecognised failure still does not leak internals", async () => {
    createDraftPo.mockRejectedValueOnce(new Error("connection terminated: host=db-primary"));
    const { POST } = await import("./route");
    const res = await POST(post(okBody));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("db-primary");
  });
});
