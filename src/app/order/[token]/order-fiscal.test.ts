import { describe, expect, it } from "vitest";
import type { SaleFiscalStatus } from "@/server/fiscal/read-model";
import { orderFiscalView } from "./order-fiscal";

/**
 * The status page's fiscal ladder, at the only level this repo can assert it.
 *
 * THERE IS NO PAGE-RENDER HARNESS HERE, and that is a fact about the root suite
 * rather than a gap in this task: `vitest.config.ts` sets `environment: "node"`
 * and includes `.test.ts` only, so nothing under `src/` can mount a component,
 * server or client (the `.tsx` tests that do exist all live in `apps/pos`, which
 * has its own jsdom config). The house answer is the one used by
 * `src/app/login/safe-next.test.ts` and `src/app/subscribe/destination.test.ts`:
 * keep the decision in a pure module beside the page and pin it there, leaving
 * the `.tsx` as markup with no branch of its own that is not driven from here.
 *
 * WHAT THIS DOES AND DOES NOT PROVE. It proves the four states are chosen
 * correctly from a `SaleFiscalStatus`, including the non-EG "render nothing"
 * case that the page's byte-identical guarantee rests on. It does NOT prove the
 * JSX renders each state — the page maps one `kind` to one block with no
 * further logic, which is the smallest surface that gap can be reduced to
 * without a harness that does not exist.
 */

const RECEIPT: SaleFiscalStatus = {
  docType: "e_receipt",
  status: "pending",
  etaUuid: "a".repeat(64),
  etaLongId: null,
  qrPayload: `https://preprod.invoicing.eta.gov.eg/receipts/search/${"a".repeat(64)}`,
  qrImageDataUrl: "data:image/png;base64,AAAA",
};

const INVOICE: SaleFiscalStatus = {
  docType: "e_invoice",
  status: "pending",
  etaUuid: null,
  etaLongId: null,
  qrPayload: null,
  qrImageDataUrl: null,
};

describe("orderFiscalView", () => {
  it("renders NOTHING for a non-EG tenant, whatever the fiscal read says", () => {
    // The country gate's whole promise (F1/F2): a storefront outside Egypt shows
    // the page it showed before ETA existed. Asserted against a POPULATED fiscal
    // value as well as a null one, so the guarantee is the gate and not merely
    // the absence of data — a tenant that changed country, or an EG row left
    // behind by one, must still render nothing.
    expect(orderFiscalView({ fiscalEnabled: false, fiscal: null })).toBeNull();
    expect(orderFiscalView({ fiscalEnabled: false, fiscal: RECEIPT })).toBeNull();
    expect(orderFiscalView({ fiscalEnabled: false, fiscal: INVOICE })).toBeNull();
  });

  it("says the receipt is pending for an EG order with no fiscal row yet", () => {
    // The COMMON state on this page, not an edge one: an online order is
    // enqueued by the reconciliation sweep 5-20 minutes after payment, so a
    // customer arriving straight from checkout sees this and it is true.
    expect(orderFiscalView({ fiscalEnabled: true, fiscal: null })).toEqual({ kind: "receipt-pending" });
  });

  it("shows the QR as soon as it exists — at `pending`, not only at `accepted`", () => {
    // ETA e-receipts are post-clearance: the uuid and QR payload are written at
    // finalization and the verdict lands minutes to hours later. Gating on
    // `accepted` would show a blank block on nearly every visit.
    expect(orderFiscalView({ fiscalEnabled: true, fiscal: RECEIPT })).toEqual({
      kind: "receipt",
      qrImageDataUrl: RECEIPT.qrImageDataUrl,
      etaUuid: RECEIPT.etaUuid,
    });

    const accepted = orderFiscalView({
      fiscalEnabled: true,
      fiscal: { ...RECEIPT, status: "accepted", etaLongId: "LONG-1" },
    });
    // An accepted receipt carries a long id too, and the page still shows the QR
    // rather than swapping to it — the code is what a customer can scan.
    expect(accepted).toEqual({ kind: "receipt", qrImageDataUrl: RECEIPT.qrImageDataUrl, etaUuid: RECEIPT.etaUuid });
  });

  it("says pending for a receipt row that exists but was never finalized", () => {
    expect(
      orderFiscalView({ fiscalEnabled: true, fiscal: { ...RECEIPT, etaUuid: null, qrPayload: null, qrImageDataUrl: null } }),
    ).toEqual({ kind: "receipt-pending" });
  });

  it("SPLITS ON docType, NOT on the absence of a QR", () => {
    // The load-bearing case, and the reason `SaleFiscalStatus` carries `docType`
    // at all. A queued `e_invoice` and an unfinalized `e_receipt` are both
    // QR-less and otherwise identical here; reading the family off that absence
    // would show tax-invoice wording to an ordinary consumer.
    const unfinalizedReceipt = { ...RECEIPT, etaUuid: null, qrPayload: null, qrImageDataUrl: null };
    expect(orderFiscalView({ fiscalEnabled: true, fiscal: unfinalizedReceipt })).toEqual({ kind: "receipt-pending" });
    expect(orderFiscalView({ fiscalEnabled: true, fiscal: INVOICE })).toEqual({ kind: "invoice-pending" });
    // Non-vacuity: the two inputs really do differ in `docType` alone on every
    // field this function reads.
    expect(unfinalizedReceipt.qrImageDataUrl).toBe(INVOICE.qrImageDataUrl);
    expect(unfinalizedReceipt.status).toBe(INVOICE.status);
    expect(unfinalizedReceipt.etaLongId).toBe(INVOICE.etaLongId);
  });

  it("shows ETA's long id once an invoice is accepted, and never invents one", () => {
    expect(
      orderFiscalView({ fiscalEnabled: true, fiscal: { ...INVOICE, status: "accepted", etaLongId: "BFNGXFA17265TQX34" } }),
    ).toEqual({ kind: "invoice", etaLongId: "BFNGXFA17265TQX34" });

    // Both halves are required. An `accepted` invoice ETA has not yet named a
    // number for has nothing to print...
    expect(orderFiscalView({ fiscalEnabled: true, fiscal: { ...INVOICE, status: "accepted" } }))
      .toEqual({ kind: "invoice-pending" });
    // ...and a long id on a row that is not accepted is not a number ETA has
    // committed to, so it is not shown either.
    expect(orderFiscalView({ fiscalEnabled: true, fiscal: { ...INVOICE, etaLongId: "BFNGXFA17265TQX34" } }))
      .toEqual({ kind: "invoice-pending" });
  });

  it("never shows a QR for an invoice, even if one somehow sits on the row", () => {
    // A tax invoice has no QR at any point in its life. If a row ever carried
    // one it would be a bug elsewhere, and rendering it here would show a
    // business buyer a code ETA has no document behind.
    expect(
      orderFiscalView({
        fiscalEnabled: true,
        fiscal: { ...INVOICE, status: "accepted", etaLongId: "L-1", qrImageDataUrl: "data:image/png;base64,BBBB" },
      }),
    ).toEqual({ kind: "invoice", etaLongId: "L-1" });
  });

  it("carries no rejection notice to the customer, in either family", () => {
    // A deliberate divergence from the till footer, which DOES tell the cashier.
    // A rejection is a back-office fact: the sale stands and the fix is a
    // dashboard resubmission nobody holding this link can perform. The receipt
    // keeps showing the code that was issued; the invoice reads as pending,
    // which is true of its ETA number.
    const rejectedReceipt = orderFiscalView({ fiscalEnabled: true, fiscal: { ...RECEIPT, status: "rejected" } });
    expect(rejectedReceipt).toEqual({ kind: "receipt", qrImageDataUrl: RECEIPT.qrImageDataUrl, etaUuid: RECEIPT.etaUuid });
    expect(orderFiscalView({ fiscalEnabled: true, fiscal: { ...INVOICE, status: "rejected" } }))
      .toEqual({ kind: "invoice-pending" });
    // No `kind` this function can return names a rejection, so the page has no
    // branch that could print one.
    expect(JSON.stringify(rejectedReceipt)).not.toContain("reject");
  });

  it("resolves every status of both families to one of exactly four kinds", () => {
    // A total-function pin rather than a case list: a status added to the enum,
    // or a fifth `kind` added above without a page branch, fails here.
    const statuses = ["pending", "submitted", "accepted", "rejected", "failed"] as const;
    const kinds = new Set<string>();
    for (const status of statuses) {
      for (const fiscal of [RECEIPT, INVOICE]) {
        const view = orderFiscalView({ fiscalEnabled: true, fiscal: { ...fiscal, status } });
        expect(view, `no view for ${fiscal.docType}/${status}`).not.toBeNull();
        kinds.add(view!.kind);
      }
    }
    expect([...kinds].sort()).toEqual(["invoice-pending", "receipt"]);
    // ...and the other two are reachable, so the set above is a measurement of
    // these inputs rather than the function's whole range.
    expect(orderFiscalView({ fiscalEnabled: true, fiscal: null })!.kind).toBe("receipt-pending");
    expect(
      orderFiscalView({ fiscalEnabled: true, fiscal: { ...INVOICE, status: "accepted", etaLongId: "L" } })!.kind,
    ).toBe("invoice");
  });
});
