import { describe, it, expect } from "vitest";
import { NoopFiscalProvider } from "./noop-provider";
import { EtaFiscalProvider } from "./eta-provider";
import { resolveFiscalProvider } from "./index";
import type {
  FiscalProvider,
  FiscalDocument,
  FiscalSaleInput,
  FiscalRefundInput,
  FiscalSubmitResult,
  EtaConfig,
} from "./provider";

/** 64-hex, shaped like the self-computed SHA-256 uuid a real receipt would carry. */
const RECEIPT_UUID = "a".repeat(64);
const RETURN_UUID = "b".repeat(64);

/** A fake provider proving the FiscalProvider contract with zero ETA detail
 *  — every method returns a canned, shape-correct fixture. The `implements`
 *  clause below is itself the main contract check: this class only compiles
 *  if its methods satisfy FiscalProvider exactly. */
class FakeFiscalProvider implements FiscalProvider {
  readonly name = "fake";

  buildReceipt(): FiscalDocument {
    return {
      docType: "e_receipt",
      uuid: RECEIPT_UUID,
      previousUuid: "",
      referenceUuid: null,
      referenceOldUuid: null,
      buyer: null,
      lines: [],
      total: "0.00",
      currency: "EGP",
      issuedAt: "2026-07-24T00:00:00.000Z",
    };
  }

  buildReturnReceipt(): FiscalDocument {
    return {
      docType: "return_receipt",
      uuid: RETURN_UUID,
      previousUuid: "",
      referenceUuid: "PARENT-UUID",
      referenceOldUuid: null,
      buyer: null,
      lines: [],
      total: "0.00",
      currency: "EGP",
      issuedAt: "2026-07-24T00:00:00.000Z",
    };
  }

  async submit(): Promise<FiscalSubmitResult> {
    return { status: "accepted", etaUuid: RECEIPT_UUID, qrPayload: "QR", responseJson: {} };
  }

  async poll(): Promise<FiscalSubmitResult> {
    return { status: "accepted", etaUuid: RECEIPT_UUID, responseJson: {} };
  }
}

describe("resolveFiscalProvider", () => {
  it("returns the ETA provider for an EG tenant", () => {
    expect(resolveFiscalProvider({ country: "EG" }).name).toBe("eta");
  });

  it("returns the no-op provider for a non-EG tenant", () => {
    expect(resolveFiscalProvider({ country: "SA" }).name).toBe("noop");
  });
});

describe("NoopFiscalProvider", () => {
  it("submit returns skipped and writes nothing", async () => {
    const res = await new NoopFiscalProvider().submit({} as FiscalDocument, {} as EtaConfig);
    expect(res).toEqual({ status: "skipped", responseJson: {} });
  });

  it("poll returns skipped and writes nothing", async () => {
    const res = await new NoopFiscalProvider().poll("some-submission-uuid", {} as EtaConfig);
    expect(res).toEqual({ status: "skipped", responseJson: {} });
  });

  it("buildReceipt and buildReturnReceipt throw — non-EG tenants never build fiscal documents", () => {
    const noop = new NoopFiscalProvider();
    expect(() => noop.buildReceipt({} as FiscalSaleInput)).toThrow();
    expect(() => noop.buildReturnReceipt({} as FiscalRefundInput)).toThrow();
  });
});

describe("EtaFiscalProvider (Task 2 stub)", () => {
  it("is named eta", () => {
    expect(new EtaFiscalProvider().name).toBe("eta");
  });

  it("every method throws not implemented", async () => {
    const eta = new EtaFiscalProvider();
    expect(() => eta.buildReceipt({} as FiscalSaleInput)).toThrow("not implemented");
    expect(() => eta.buildReturnReceipt({} as FiscalRefundInput)).toThrow("not implemented");
    await expect(eta.submit({} as FiscalDocument, {} as EtaConfig)).rejects.toThrow("not implemented");
    await expect(eta.poll("submission-uuid", {} as EtaConfig)).rejects.toThrow("not implemented");
  });
});

describe("FiscalProvider contract (fake)", () => {
  const p = new FakeFiscalProvider();

  it("builds a receipt with a self-computed uuid and an empty chain head", () => {
    const doc = p.buildReceipt();
    expect(doc.docType).toBe("e_receipt");
    expect(doc.uuid).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.previousUuid).toBe("");
    expect(doc.referenceUuid).toBeNull();
  });

  it("builds a return receipt referencing the original document's uuid", () => {
    const doc = p.buildReturnReceipt();
    expect(doc.docType).toBe("return_receipt");
    expect(doc.referenceUuid).toBe("PARENT-UUID");
  });

  it("submits and polls, round-tripping a FiscalSubmitResult", async () => {
    const submitRes = await p.submit();
    expect(submitRes.status).toBe("accepted");
    expect(submitRes.responseJson).toEqual({});

    const pollRes = await p.poll();
    expect(pollRes.status).toBe("accepted");
  });
});
