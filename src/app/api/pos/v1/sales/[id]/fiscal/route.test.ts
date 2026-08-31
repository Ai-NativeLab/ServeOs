import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { withTenant } from "@/db/with-tenant";
import { seedPosContext, openShiftForCtx } from "@/server/pos/test-helpers";
import { recordSale } from "@/server/pos/record-sale";
import { PosAuthError, PosCashierError } from "@/server/pos/errors";
import { etaTenantConfig, etaPosCredentials, productTaxCodes, type EtaWireContextConfig } from "@/server/fiscal/schema";
import type { PosCashierContext } from "@/server/pos/require-cashier";

/**
 * The exact HTTP ladder Task 7's receipt screen codes against, pinned so the
 * client can be written from this file rather than from a reading of the
 * handler.
 *
 * Only `requirePosCashier` is faked — the one seam that needs a live device
 * token and cashier token on a real request. `assertPermission` is the REAL
 * one (via `importOriginal`), so the 403 case exercises the actual permission
 * check rather than a mock agreeing with itself, and everything below the
 * handler — `getSaleFiscalStatus`, RLS, the QR render — runs for real against
 * a sale rung through `recordSale`.
 */
vi.mock("@/server/pos/require-cashier", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/pos/require-cashier")>()),
  requirePosCashier: vi.fn(),
}));

import { requirePosCashier } from "@/server/pos/require-cashier";
import { GET } from "./route";

const SECRET_KEYS = {
  erp: "ZZ_POSROUTE_ETA_ERP",
  secret1: "ZZ_POSROUTE_ETA_S1",
  secret2: "ZZ_POSROUTE_ETA_S2",
} as const;

beforeAll(() => {
  for (const key of Object.values(SECRET_KEYS)) process.env[key] = `${key}-value`;
});

afterAll(() => {
  for (const key of Object.values(SECRET_KEYS)) delete process.env[key];
  vi.restoreAllMocks();
});

const WIRE_CONTEXT: EtaWireContextConfig = {
  sellerName: "Fiscal Co",
  activityCode: "5610",
  branchCode: "0",
  branchAddress: {
    country: "EG", governate: "Cairo", regionCity: "Nasr City",
    street: "Test Street", buildingNumber: "12",
  },
};

let n = 0;

const req = () => new NextRequest("http://localhost/api/pos/v1/sales/x/fiscal");
const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** An EG tenant configured for ETA with one paid cash sale, so the submission
 *  row is finalized inline and carries its uuid + QR (the production path). */
async function seedFiscalSale() {
  const s = await seedPosContext("owner");
  await openShiftForCtx(s.ctx);
  await withTenant(s.tenantId, (tx) =>
    tx.insert(productTaxCodes).values({
      tenantId: s.tenantId, productId: s.productId, codeSource: "gs1",
      itemCode: "1234567890123", taxType: "T1", taxSubType: "V009", unitType: "EA",
    }),
  );
  await withTenant(s.tenantId, (tx) =>
    tx.insert(etaTenantConfig).values({
      tenantId: s.tenantId, registrationNumber: "200173707", clientId: "erp-client",
      clientSecretRef: SECRET_KEYS.erp, environment: "preprod",
      activationStatus: "active", wireContextJson: WIRE_CONTEXT,
    }),
  );
  await withTenant(s.tenantId, (tx) =>
    tx.insert(etaPosCredentials).values({
      tenantId: s.tenantId, deviceId: s.ctx.deviceId, etaSerial: "POS-001",
      clientId: "device-client", clientSecret1Ref: SECRET_KEYS.secret1,
      clientSecret2Ref: SECRET_KEYS.secret2, status: "active",
    }),
  );
  const receipt = await recordSale(s.ctx, {
    clientOrderId: `pos-fiscal-${n++}`,
    lines: [{ productId: s.productId, quantity: 1, selectedOptionIds: [] }],
    expectedTotal: s.total,
    payments: [{ clientPaymentId: "p-1", method: "cash", amount: s.total, tenderedAmount: s.total }],
  });
  return { ...s, receipt };
}

function signedIn(ctx: PosCashierContext, permissions: PosCashierContext["permissions"]) {
  vi.mocked(requirePosCashier).mockResolvedValue({ ...ctx, permissions });
}

describe("GET /api/pos/v1/sales/[id]/fiscal", () => {
  it("401s a bad device token and a signed-out cashier", async () => {
    for (const error of [new PosAuthError(), new PosCashierError()]) {
      vi.mocked(requirePosCashier).mockRejectedValue(error);
      const res = await GET(req(), params("00000000-0000-4000-8000-000000000000"));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Unauthorized" });
    }
  });

  it("403s a cashier without pos:sell", async () => {
    const s = await seedFiscalSale();
    // The real `assertPermission` decides this — reading a sale's fiscal state
    // is part of issuing its receipt, so it rides the same permission as
    // ringing one.
    signedIn(s.ctx, ["pos:refund"]);
    const res = await GET(req(), params(s.receipt.orderId));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("pos:sell");
  });

  it("returns a literal null body with 200 when the order has no submission", async () => {
    const s = await seedPosContext("owner");
    signedIn(s.ctx, ["pos:sell"]);

    const res = await GET(req(), params("00000000-0000-4000-8000-000000000000"));
    // 200 + null, NOT 404: an absent fiscal block is the ordinary state of a
    // non-EG tenant and of an EG sale in the seconds before its enqueue lands.
    // A 404 would make the POS treat a normal receipt as an error. Asserted on
    // the raw body text as well as the parsed value, because `null` and an
    // empty body are indistinguishable after `.json()` in some clients.
    expect(res.status).toBe(200);
    expect(await res.clone().text()).toBe("null");
    expect(await res.json()).toBeNull();
  });

  it("returns status, uuid and a rendered QR for a finalized sale", async () => {
    const s = await seedFiscalSale();
    signedIn(s.ctx, ["pos:sell"]);

    const res = await GET(req(), params(s.receipt.orderId));
    expect(res.status).toBe(200);
    const body = await res.json();

    // Finalized inline at sale time (addendum C5), so the printed customer copy
    // carries the QR before ETA has seen the document — status is still
    // `pending` and the QR is already there. Task 7 must not gate the QR on
    // `accepted`.
    expect(body.status).toBe("pending");
    expect(body.etaUuid).toMatch(/^[0-9a-f]{64}$/);
    expect(body.qrImageDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(body.qrPayload).toContain(body.etaUuid);
  });

  it("is tenant-scoped — another tenant's order id reads as null, not as data", async () => {
    const mine = await seedPosContext("owner");
    const theirs = await seedFiscalSale();
    signedIn(mine.ctx, ["pos:sell"]);

    const res = await GET(req(), params(theirs.receipt.orderId));
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });
});
