import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Receipt, type ReceiptData, type ReceiptFiscal } from "./Receipt";

/**
 * The receipt renders to a string with `react-dom/server` — the renderer has no
 * DOM harness (SyncBadge.test.ts says as much), and static markup is both the
 * strongest and the cheapest assertion available here: it makes "renders exactly
 * as it did before ETA existed" an exact string comparison rather than a hunt
 * for absent selectors.
 */

const QR = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg";
const UUID = "5b2c1f0e8a7d4c3b9e6f10a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6";

const SALE: ReceiptData = {
  orderNumber: "1042",
  lines: [
    { productId: "p1", name: "Flat white", quantity: 2, selectedOptionIds: [], unitPrice: 45 },
    { productId: "p2", name: "Croissant", quantity: 1, selectedOptionIds: [], unitPrice: 35.4 },
  ],
  subtotal: 125.4,
  discountAmount: 0,
  serviceChargeAmount: 12.54,
  vatAmount: 19.31,
  total: 157.25,
  tenders: [{ method: "cash", amount: 200 }],
  changeAmount: 42.75,
  cashierName: "Nadia",
  timestamp: "2026-08-31T09:15:00.000Z",
  synced: true,
};

const fiscal = (over: Partial<ReceiptFiscal> = {}): ReceiptFiscal => ({
  status: "pending",
  etaUuid: UUID,
  qrImageDataUrl: QR,
  ...over,
});

/** The receipt as it printed before this task — the `fiscal` prop is not passed
 *  at all, which is exactly how every screen called it. */
const baseline = renderToStaticMarkup(
  <Receipt data={SALE} onPrint={() => {}} onNewOrder={() => {}} />,
);

const render = (f: ReceiptFiscal | null) =>
  renderToStaticMarkup(<Receipt data={SALE} fiscal={f} onPrint={() => {}} onNewOrder={() => {}} />);

/** Strips the fiscal block — which contains no nested `div` — so the rest of the
 *  receipt can be compared against the baseline character for character. */
const withoutFooter = (html: string) =>
  html.replace(/<div class="mt-4 border-t border-dashed border-border pt-3 text-center">.*?<\/div>/, "");

describe("no fiscal record", () => {
  it("renders the receipt exactly as it did before ETA — the country gate's guarantee", () => {
    // `null` is the endpoint's ORDINARY answer: every non-EG tenant, and every
    // EG sale in the moment before its enqueue lands.
    expect(render(null)).toBe(baseline);
    expect(baseline).not.toContain("ETA");
    expect(baseline).not.toContain("Fiscal receipt");
    expect(baseline).not.toContain("<img");
  });
});

describe("the QR prints as soon as it exists", () => {
  it("shows the QR and the uuid at `pending` — the customer copy carries the code at issuance", () => {
    // The row is finalized inline at sale time, so the QR exists long before
    // ETA has an opinion. Gating it on `accepted` would hand the customer a
    // receipt with no code on it.
    const html = render(fiscal({ status: "pending" }));
    expect(html).toContain(`<img src="${QR}"`);
    expect(html).toContain(`ETA UUID: ${UUID}`);
    expect(html).not.toContain("Fiscal receipt pending");
    expect(withoutFooter(html)).toBe(baseline);
  });

  it("shows the same block at `submitted` and at `accepted`", () => {
    for (const status of ["submitted", "accepted"] as const) {
      const html = render(fiscal({ status }));
      expect(html).toContain(`<img src="${QR}"`);
      expect(html).toContain(`ETA UUID: ${UUID}`);
      expect(withoutFooter(html)).toBe(baseline);
    }
  });

  it("says so when the row exists but has not been finalized yet", () => {
    const html = render(fiscal({ status: "pending", etaUuid: null, qrImageDataUrl: null }));
    expect(html).toContain("Fiscal receipt pending");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("ETA UUID");
    expect(withoutFooter(html)).toBe(baseline);
  });
});

describe("rejected", () => {
  it("keeps the QR and uuid and adds a non-blocking note — the sale stands", () => {
    const html = render(fiscal({ status: "rejected" }));
    expect(html).toContain(`<img src="${QR}"`);
    expect(html).toContain(`ETA UUID: ${UUID}`);
    expect(html).toContain("Fiscal receipt rejected — correction pending");
    // Nothing about the sale itself changes: totals, tenders and change are
    // character-for-character what they were.
    expect(withoutFooter(html)).toBe(baseline);
  });

  it("falls back to the pending line when there is no QR to keep", () => {
    const html = render(fiscal({ status: "rejected", etaUuid: null, qrImageDataUrl: null }));
    expect(html).toContain("Fiscal receipt pending");
    expect(html).toContain("Fiscal receipt rejected — correction pending");
    expect(html).not.toContain("<img");
  });
});

describe("failed", () => {
  it("prints the code like any other in-flight state — the worker is still retrying", () => {
    const html = render(fiscal({ status: "failed" }));
    expect(html).toContain(`<img src="${QR}"`);
    expect(html).not.toContain("rejected");
    expect(withoutFooter(html)).toBe(baseline);
  });
});
