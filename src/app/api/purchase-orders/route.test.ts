import { describe, it, expect, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { authorize, UnauthorizedError } from "@/server/rbac/authorize";

// Guard-level sanity: the exact gate that maps staff requests to 403. The full
// handler tests below prove every route actually CALLS that gate (a deleted
// resolvePurchasingContext line would otherwise slip past silently).
describe("purchasing permission ladder", () => {
  it("staff may neither manage purchasing nor suppliers", () => {
    expect(() => authorize(["staff"], "purchasing:manage")).toThrow(UnauthorizedError);
    expect(() => authorize(["staff"], "suppliers:manage")).toThrow(UnauthorizedError);
  });

  it("owner and manager pass both purchasing:manage and suppliers:manage", () => {
    for (const role of ["owner", "manager"] as const) {
      expect(() => authorize([role], "purchasing:manage")).not.toThrow();
      expect(() => authorize([role], "suppliers:manage")).not.toThrow();
    }
  });
});

// Exercise the actual route handlers. Every purchasing/suppliers/reorder route
// starts with `resolvePurchasingContext(...)`; we stub that seam to return the
// same 403 it would produce for a staff session, then assert the handler really
// honors it. Importing the handler is what catches a route that dropped its gate.
vi.mock("@/app/dashboard/purchasing-permission", () => {
  const denied = NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return {
    resolvePurchasingContext: vi.fn(async () => ({ ctx: null, denied })),
    resolvePurchasingActor: vi.fn(),
  };
});

const req = (body: unknown = {}) =>
  new NextRequest("http://localhost/api/x", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
const params = { params: Promise.resolve({ id: "11111111-1111-1111-1111-111111111111" }) };
const okBody = { supplierId: "s", branchId: "b", lines: [{ itemId: "i", qtyOrdered: 1, uom: "each", unitCost: 1 }] };

describe("purchase-orders route handlers return 403 when purchasing:manage is denied", () => {
  it("POST /api/purchase-orders", async () => {
    const { POST } = await import("./route");
    const res = await POST(req(okBody));
    expect(res.status).toBe(403);
  });

  it("GET /api/purchase-orders", async () => {
    const { GET } = await import("./route");
    const res = await GET(new NextRequest("http://localhost/api/purchase-orders"));
    expect(res.status).toBe(403);
  });

  it("PATCH /api/purchase-orders/[id]", async () => {
    const { PATCH } = await import("./[id]/route");
    const res = await PATCH(req(okBody), params);
    expect(res.status).toBe(403);
  });

  it("GET /api/purchase-orders/[id]", async () => {
    const { GET } = await import("./[id]/route");
    const res = await GET(new NextRequest("http://localhost/api/purchase-orders/id"), params);
    expect(res.status).toBe(403);
  });

  it("POST /api/purchase-orders/[id]/receipts", async () => {
    const { POST } = await import("./[id]/receipts/route");
    const res = await POST(req({ lines: [{ poLineId: "l", receivedQty: 1, uom: "each", unitCost: 1 }] }), params);
    expect(res.status).toBe(403);
  });

  it("POST /api/purchase-orders/[id]/send", async () => {
    const { POST } = await import("./[id]/send/route");
    const res = await POST(req(), params);
    expect(res.status).toBe(403);
  });

  it("POST /api/purchase-orders/[id]/cancel", async () => {
    const { POST } = await import("./[id]/cancel/route");
    const res = await POST(req(), params);
    expect(res.status).toBe(403);
  });

  it("PATCH /api/purchase-orders/[id]/invoice", async () => {
    const { PATCH } = await import("./[id]/invoice/route");
    const res = await PATCH(req({ invoiceTotal: 1 }), params);
    expect(res.status).toBe(403);
  });

  it("POST /api/purchase-orders/[id]/close", async () => {
    const { POST } = await import("./[id]/close/route");
    const res = await POST(req(), params);
    expect(res.status).toBe(403);
  });

  it("GET /api/purchase-orders/[id]/variance", async () => {
    const { GET } = await import("./[id]/variance/route");
    const res = await GET(new NextRequest("http://localhost/api/variance"), params);
    expect(res.status).toBe(403);
  });
});

describe("suppliers route handlers return 403 when suppliers:manage is denied", () => {
  it("POST /api/suppliers", async () => {
    const { POST } = await import("../suppliers/route");
    const res = await POST(req({ name: "Sup" }));
    expect(res.status).toBe(403);
  });

  it("GET /api/suppliers", async () => {
    const { GET } = await import("../suppliers/route");
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("PATCH /api/suppliers/[id]", async () => {
    const { PATCH } = await import("../suppliers/[id]/route");
    const res = await PATCH(req({ name: "Sup" }), params);
    expect(res.status).toBe(403);
  });

  it("GET + POST /api/suppliers/[id]/items (suppliers:manage)", async () => {
    const { GET, POST } = await import("../suppliers/[id]/items/route");
    expect((await GET(new NextRequest("http://localhost/api/items"), params)).status).toBe(403);
    expect((await POST(req({ itemId: "i" }), params)).status).toBe(403);
  });
});

describe("reorder route handlers return 403 when purchasing:manage is denied", () => {
  it("POST /api/inventory/reorder/check", async () => {
    const { POST } = await import("../inventory/reorder/check/route");
    const res = await POST();
    expect(res.status).toBe(403);
  });

  it("GET + PUT /api/inventory/reorder-rules", async () => {
    const { GET, PUT } = await import("../inventory/reorder-rules/route");
    expect((await GET()).status).toBe(403);
    expect((await PUT(req({ itemId: "i", locationId: "l", reorderPoint: 1, reorderQty: 1 }))).status).toBe(403);
  });
});