import type { SaleFiscalStatus } from "@/server/fiscal/read-model";

/**
 * What the online order-status page shows about the ETA document filed for this
 * sale — the state ladder, lifted out of the page so it can be asserted.
 *
 * WHY A MODULE AND NOT AN INLINE TERNARY IN `page.tsx`. The root suite runs
 * `environment: "node"` and its `include` glob matches `.test.ts` only — no
 * jsdom, no `.tsx` — so a React server component is not renderable by any
 * harness this repo has. Pure logic in a `.ts` beside its page, tested as a
 * `.ts`, is the
 * house pattern for exactly that gap (`src/app/login/safe-next.ts`,
 * `src/app/subscribe/destination.ts`). It is also what makes the non-EG
 * guarantee below a PINNED property rather than a claim about JSX.
 *
 * ---------------------------------------------------------------------------
 * THE LADDER MIRRORS THE TILL'S (`apps/pos/src/screens/Receipt.tsx`,
 * `ReceiptFiscalFooter`) — same split, same reasons, restated here because the
 * two files cannot import each other across the app/POS boundary.
 *
 * `e_receipt` — THE QR SHOWS AS SOON AS IT EXISTS, at `pending` and not only at
 * `accepted`. ETA e-receipts are post-clearance: the uuid is self-computed and
 * the QR payload written at finalization, while the verdict lands minutes to
 * hours later. Gating the image on `accepted` would show a blank block on nearly
 * every visit.
 *
 * `e_invoice` — NEVER A QR, in any state. ETA assigns a tax invoice's identity
 * when it is submitted, so there is nothing to encode at issuance and nothing to
 * encode later; the long id IS the surface.
 *
 * THE SPLIT IS ON `docType`, NOT ON "is there a QR". An `e_receipt` whose row
 * exists but has not been finalized has no QR either, so reading the family off
 * that absence would show tax-invoice wording on an ordinary consumer order.
 * That is the whole reason `SaleFiscalStatus` carries `docType` at all.
 *
 * ---------------------------------------------------------------------------
 * ONE DELIBERATE DIVERGENCE FROM THE TILL: NO REJECTION NOTICE. The receipt
 * footer adds "Fiscal receipt rejected — correction pending" for the cashier.
 * This page does not, and it is a decision rather than an omission. A rejection
 * is a back-office fact: the sale stands, the money is taken, and the fix is a
 * dashboard resubmission nobody holding this link can perform. Telling a
 * customer their tax document was rejected alarms them about something they
 * cannot act on. A rejected receipt keeps showing its QR (the document exists
 * and the code is the one that was issued); a rejected invoice reads as pending,
 * which is true of its ETA number — it has none and the correction will carry a
 * new one.
 *
 * REVERSING THAT DECISION IS CHEAP, AND KNOWING THE PRICE IS THE POINT — it is
 * a product call (does a customer want to be told?), so it should not be
 * re-litigated as an architecture one. The cost is exactly TWO NEW KINDS on the
 * union below — `receipt-rejected` and `invoice-rejected`, one per family,
 * because the two rejections read differently — plus ONE BRANCH EACH in
 * `page.tsx`, and nothing else: no new query (`SaleFiscalStatus.status` already
 * carries `"rejected"`), no new column, no change to the token surface. The
 * `else`-shaped fallback in that page means a kind added here and not yet given
 * a branch degrades to the honest pending line rather than to an empty block,
 * so the two halves can even land separately.
 */
export type OrderFiscalView =
  /** The consumer case: a scannable QR, plus ETA's uuid once the row carries one. */
  | { kind: "receipt"; qrImageDataUrl: string; etaUuid: string | null }
  /** EG, but there is nothing to show yet — no row, or a row not yet finalized. */
  | { kind: "receipt-pending" }
  /** B2B, accepted, and ETA has named the document. */
  | { kind: "invoice"; etaLongId: string }
  /** B2B, filed, but ETA has not answered with a number yet. */
  | { kind: "invoice-pending" };

/**
 * `null` means RENDER NOTHING — and it is the byte-identical-page guarantee for
 * every tenant outside Egypt, which is the country gate's promise (F1/F2).
 *
 * `fiscalEnabled` is the caller's `country === "EG"` AND ETA activation
 * `active` — the same gate `@/server/fiscal/enqueue`'s `isFiscalEnabled`
 * applies. Passed in rather than read here so this function stays pure.
 *
 * IT IS ALSO WHAT SEPARATES THE TWO MEANINGS OF `null` FISCAL DATA. The read
 * model returns `null` both for "this tenant files nothing" and for "this EG
 * sale has no row yet", and those need opposite renderings — nothing at all
 * versus an honest "pending" line. Only the caller knows which, so the gate is
 * a parameter and not an inference.
 *
 * WHY "PENDING" IS THE COMMON CASE HERE AND NOT AN EDGE ONE: an online order is
 * fiscalised by `reconcileMissingReceipts`, not inline at checkout, so it is
 * enqueued roughly 5-20 minutes after payment (addendum §6). A customer opening
 * this page straight from checkout will see the pending line, and it is telling
 * the truth — the document is owed and not yet written.
 */
export function orderFiscalView(input: {
  fiscalEnabled: boolean;
  fiscal: SaleFiscalStatus | null;
}): OrderFiscalView | null {
  if (!input.fiscalEnabled) return null;

  const fiscal = input.fiscal;
  if (fiscal === null) return { kind: "receipt-pending" };

  if (fiscal.docType === "e_invoice") {
    // Both halves are required: an `accepted` invoice ETA has not yet named a
    // number for has nothing to print, and a number on a non-accepted row would
    // be one we invented.
    return fiscal.status === "accepted" && fiscal.etaLongId
      ? { kind: "invoice", etaLongId: fiscal.etaLongId }
      : { kind: "invoice-pending" };
  }

  return fiscal.qrImageDataUrl
    ? { kind: "receipt", qrImageDataUrl: fiscal.qrImageDataUrl, etaUuid: fiscal.etaUuid }
    : { kind: "receipt-pending" };
}
