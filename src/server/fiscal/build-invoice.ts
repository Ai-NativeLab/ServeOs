import type { FiscalDocument, FiscalInvoiceInput } from "./provider";
import { buildSaleLines, aggregateTaxTotals, feesTotalOf, toEtaUtc, paymentMethodCode } from "./build-document";
import { BuyerIdRequiredError } from "./errors";

/**
 * THE B2B INVOICE BUILDER: a completed sale plus a business buyer, as an ETA
 * invoice v1.0 `FiscalDocument`. Pure — no HTTP, no DB, no config.
 *
 *   Invoice v1.0      https://sdk.invoicing.eta.gov.eg/documents/invoice-v1-0/
 *   Invoice v0.9      https://sdk.invoicing.eta.gov.eg/documents/invoice-v0-9/
 *   Main Calculations https://sdk.invoicing.eta.gov.eg/main-calculations/
 *
 * `./eta-invoice-wire` turns the result into invoice JSON; `./eta-provider`
 * submits it under the ERP credential. Nothing in between hashes it — see
 * IDENTITY below.
 *
 * ---------------------------------------------------------------------------
 * THE MONEY IS THE RECEIPT'S MONEY, LINE FOR LINE.
 *
 * `buildSaleLines` (./build-document) is called verbatim — the same drafts, the
 * same order-discount push-down, the same largest-remainder split of
 * `orders.vatAmount`, the same VAT-inclusive/exclusive `netSale` derivation, the
 * same fee lines with the same `FeeLineConfigMissingError`. Not "the same
 * approach": the same function. An invoice and an e-receipt for one sale must
 * report one figure for that sale's output VAT, and the only way to guarantee
 * that is for one piece of code to compute it.
 *
 * WHICH EQUATIONS MATCH, since the two document families spell their totals
 * differently. Every one that the shared pipeline produces, verified field by
 * field against the fetched invoice v1.0 page:
 *
 *   invoice v1.0                       receipt v1.2      shared derivation
 *   ------------                       ------------      -----------------
 *   salesTotal  "considering quantity   totalSale        netSale + discounts
 *               and unit price in EGP"
 *   netTotal    "after applying         netSale          `lineTotal`
 *               discount"
 *   total       "after adding all       total            netSale + Σ taxes
 *               pricing items, taxes,
 *               removing discounts"
 *   taxableItems[] (taxType, amount,    taxableItems[]   `taxes`
 *               subType, rate)
 *   unitValue.amountEGP                 unitPrice        `unitPrice`
 *
 * and at document level `netAmount = TotalSales – TotalDiscount` is the same
 * quantity as the receipt's `netAmount = Sum(itemData.netSale)`, because
 * Σ salesTotal − Σ discount IS Σ netTotal line by line. The one genuinely
 * different identity is `totalAmount`, which invoice v1.0 states as "NetAmount +
 * Totals of tax amounts" where the receipt states it as
 * "Sum(itemData.total) − extraReceiptDiscountData + adjustment"; with no
 * document-level extra discount the two agree, and `./eta-invoice-wire` asserts
 * the invoice's own form rather than borrowing the receipt's.
 *
 * ---------------------------------------------------------------------------
 * IDENTITY: THERE IS NONE TO COMPUTE.
 *
 * `uuid` is null and stays null until ETA answers. An e-receipt's uuid is the
 * SHA-256 of its own serialized bytes because ETA's post-clearance receipt model
 * needs an identifier at issuance for the printed QR (addendum C2/C5); the
 * B2B invoice model is the opposite — the document is submitted, ETA validates
 * it, and ETA assigns both `uuid` and `longId` in its response ("Unique document
 * ID in eInvoicing system"; "Unique long temporary Id that can be used to query
 * document data anonymously"). Computing one here would invent an identifier
 * that competes with the real one.
 *
 * `previousUuid` is null for the same reason: chaining is a per-POS-device
 * receipt property, and invoice v1.0 has no slot for a predecessor at all.
 * `referenceUuid` is null because a B2B correction is a CREDIT NOTE, a separate
 * document type that is still deferred.
 *
 * AND THEREFORE NO QR. `buildQrUrl` builds the portal url out of the
 * self-computed uuid, which does not exist here, and ETA publishes no QR
 * template for invoices. `qr_payload` stays null on the submission row for the
 * document's whole life; the read surfaces show the ETA-assigned `longId` as
 * text.
 *
 * ---------------------------------------------------------------------------
 * THE RECEIVER, and every field of it that ServeOS cannot supply.
 *
 * Invoice v1.0 marks `receiver.id`, `receiver.name` and `receiver.address`
 * Conditional — "Optional if person buyer and invoice amount less than threshold
 * limit defined" — so for the type-`B` receiver a B2B invoice exists to name,
 * all three are Mandatory, and Receiver Address makes `country`, `governate`,
 * `regionCity`, `street` and `buildingNumber` Mandatory within it. `orders`
 * stores a `customerName` and a `customerPhone`; it stores no registration
 * number and no structured address, and `deliveryAddressText` is one free-text
 * line that cannot be decomposed into five components without guessing.
 *
 * So all seven are captured as `FiscalInvoiceInput["buyer"]` and validated by
 * the trigger (round 2 Task 4's zod), never invented here. What this builder
 * does is refuse the document if any of them arrived empty — `BuyerIdRequiredError`,
 * the same error receipt v1.2's type-B rule already raises — because a
 * half-filled receiver is a rejected invoice, and finding that out from ETA
 * hours later is strictly worse than finding it out now.
 *
 * TYPE IS ALWAYS "B". Invoice v1.0 supports "B for business in Egypt, P for
 * natural person, F for foreigner"; ServeOS's B2B trigger captures an Egyptian
 * registration number, and a `P` receiver would need a 14-digit national ID and
 * an `F` a foreign VAT ID — different validation, different capture, not this
 * document.
 */
export function buildInvoice(input: FiscalInvoiceInput): FiscalDocument {
  const { order, buyer } = input;
  assertReceiverComplete(buyer.rin, buyer.name, buyer.address);

  const lines = buildSaleLines(input);

  return {
    docType: "e_invoice",
    // ETA assigns both of these. See IDENTITY above.
    uuid: null,
    // Invoices do not chain; `null` rather than `""`, which is the receipt
    // chain's genesis marker and would be a claim about a chain that does not
    // exist.
    previousUuid: null,
    referenceUuid: null,
    // A corrected resubmission still carries the rejected document's uuid, and
    // `./finalize` writes it in exactly as it does for a receipt.
    referenceOldUuid: null,
    buyer: { type: "B", id: buyer.rin, name: buyer.name, address: buyer.address },
    lines,
    subtotal: order.subtotal,
    // The order-level discount rides on the lines (`buildLineDrafts`), so
    // invoice v1.0's `extraDiscountAmount` — "Additional discount amount applied
    // at the level of the overall document, not individual lines" — is zero, for
    // the same reason the receipt's `extraReceiptDiscountData` is empty: ETA
    // subtracts a document-level discount AFTER tax, and ServeOS discounts
    // before VAT, so reporting it there would misstate the tax base.
    discountTotal: "0.00",
    feesTotal: feesTotalOf(order),
    taxTotals: aggregateTaxTotals(lines),
    total: order.total,
    // Carried on the contract, NOT emitted: invoice v1.0 has no `paymentMethod`
    // field — its `payment` structure is the issuer's bank details ("bankName",
    // "bankAccountIBAN", "terms"), which is a different thing entirely and which
    // ServeOS does not store. `toWireInvoice` omits the whole optional structure
    // rather than half-filling it. The code is kept here because the contract
    // declares it non-optional and because a tenant's own reporting can use it.
    paymentMethodCode: paymentMethodCode(order, input.payments),
    currency: "EGP",
    issuedAt: toEtaUtc(order.placedAt),
  };
}

/**
 * Refuses a receiver ETA would refuse, naming every empty field at once.
 *
 * `BuyerIdRequiredError` rather than a new error class: it already means
 * "this buyer type requires identification it does not have", it already
 * carries the missing-field list, and the worker already maps it to a permanent
 * failure with an owner-actionable alert. Its message speaks of receipt v1.2
 * because that is where the rule was first met; the rule is the same one.
 *
 * The threshold argument is "0" — a business receiver's fields are Mandatory
 * unconditionally, not above some amount.
 */
function assertReceiverComplete(rin: string, name: string, address: FiscalInvoiceAddressLike): void {
  const missing: string[] = [];
  if (!rin.trim()) missing.push("id");
  if (!name.trim()) missing.push("name");
  for (const field of ["country", "governate", "regionCity", "street", "buildingNumber"] as const) {
    if (!address?.[field]?.trim()) missing.push(`address.${field}`);
  }
  if (missing.length > 0) throw new BuyerIdRequiredError("B", "0", "0", missing);
}

/** The Mandatory half of `FiscalAddress`, read defensively: this value crosses
 *  a trigger boundary and Task 4's zod is what makes it well-typed, so the
 *  builder treats a missing component as missing rather than trusting the type. */
type FiscalInvoiceAddressLike = Partial<Record<"country" | "governate" | "regionCity" | "street" | "buildingNumber", string>>;
