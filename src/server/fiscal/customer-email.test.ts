import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { orders } from "@/server/ordering/schema";
import { customers } from "@/server/customers/schema";
import { FakeEmailProvider } from "@/server/email/fake-provider";
import {
  resolveFiscalEmailRecipient,
  renderFiscalDocumentEmail,
  sendFiscalDocumentEmail,
  type FiscalEmailDocument,
  type FiscalEmailOrder,
  type FiscalEmailTenant,
} from "./customer-email";

/**
 * The customer's copy of their fiscal document — the ONLINE channel's primary
 * QR delivery (Task 6's storefront block is revisit-only, because the sweep
 * writes the fiscal row 5-20 minutes after payment).
 *
 * WHAT IS TESTED HERE vs. IN `worker.test.ts`: this file owns the RECIPIENT
 * LADDER and the FAMILY SPLIT, both of which are properties of the module and
 * need no ETA at all. The worker file owns the HOOK — that acceptance triggers
 * a send exactly once and that a failing send cannot disturb acceptance —
 * because those are properties of where the call sits in the drain.
 */

let n = 0;

async function makeTenant(over: Partial<typeof tenants.$inferInsert> = {}) {
  const [tenant] = await db.insert(tenants)
    .values({ slug: `fiscal-email-${n++}`, name: "Koshary Co", country: "EG", ...over })
    .returning();
  return tenant;
}

async function makeOrder(tenantId: string, over: Partial<typeof orders.$inferInsert> = {}) {
  const i = n++;
  const [branch] = await withTenant(tenantId, (tx) =>
    tx.insert(branches).values({ tenantId, name: "Main" }).returning());
  const [order] = await withTenant(tenantId, (tx) =>
    tx.insert(orders).values({
      tenantId, branchId: branch.id, orderNumber: 4000 + i,
      fulfillmentType: "pickup", customerName: "Nadia", customerPhone: "+201000000000",
      subtotal: "100.00", vatRateSnapshot: "14", vatAmount: "14.00", total: "114.00",
      statusToken: `tok-email-${tenantId}-${i}`,
      ...over,
    }).returning());
  return order;
}

async function makeCustomer(tenantId: string, email: string) {
  const [customer] = await withTenant(tenantId, (tx) =>
    tx.insert(customers).values({
      tenantId, name: "Nadia", email, passwordHash: "x",
    }).returning());
  return customer;
}

const QR_URL =
  "https://preprod.invoicing.eta.gov.eg/receipts/search/" + "a".repeat(64) + "/share/2026-08-31T10:00:00Z#Total:114.00,IssuerRIN:200173707";

const receiptDoc: FiscalEmailDocument = {
  id: "11111111-1111-4111-8111-111111111111",
  docType: "e_receipt",
  etaUuid: "a".repeat(64),
  etaLongId: "LONG-RECEIPT",
  qrPayload: QR_URL,
};

/**
 * The SAME document, differing in `docType` and in the two fields the families
 * genuinely do not share. Kept beside its twin so the family assertions below
 * are comparisons rather than two independent snapshots — see the non-vacuity
 * note on the family test.
 */
const invoiceDoc: FiscalEmailDocument = {
  id: "22222222-2222-4222-8222-222222222222",
  docType: "e_invoice",
  // Null for an invoice until ETA answers, and there is never a QR payload:
  // ETA publishes no invoice QR template (addendum §6).
  etaUuid: null,
  etaLongId: "EG-LONG-0001",
  qrPayload: null,
};

const anOrder = (over: Partial<FiscalEmailOrder> = {}): FiscalEmailOrder => ({
  id: "33333333-3333-4333-8333-333333333333",
  orderNumber: 4242,
  total: "114.00",
  customerName: "Nadia",
  customerEmail: "nadia@example.test",
  customerId: null,
  ...over,
});

const aTenant = (over: Partial<FiscalEmailTenant> = {}): FiscalEmailTenant => ({
  id: "44444444-4444-4444-8444-444444444444",
  name: "Koshary Co",
  currency: "EGP",
  contactEmail: "hello@koshary.test",
  ...over,
});

// ---------------------------------------------------------------------------
// The recipient ladder
// ---------------------------------------------------------------------------

describe("resolveFiscalEmailRecipient — three rungs, and the third is nobody", () => {
  it("prefers the address captured on THIS order over the account's", async () => {
    const t = await makeTenant();
    const account = await makeCustomer(t.id, "account@example.test");
    const order = await makeOrder(t.id, { customerEmail: "typed-at-checkout@example.test", customerId: account.id });

    // Rung 1 beats rung 2 on purpose: a signed-in customer who types a
    // different address for this order is expressing a preference about THIS
    // document, and overriding it would be the system knowing better.
    expect(await resolveFiscalEmailRecipient(t.id, order)).toBe("typed-at-checkout@example.test");
  });

  it("falls back to the signed-in customer's account address", async () => {
    const t = await makeTenant();
    const account = await makeCustomer(t.id, "account@example.test");
    const order = await makeOrder(t.id, { customerEmail: null, customerId: account.id });

    expect(await resolveFiscalEmailRecipient(t.id, order)).toBe("account@example.test");
  });

  it("resolves to nobody for a guest who left the field blank — and that is not an error", async () => {
    const t = await makeTenant();
    const order = await makeOrder(t.id, { customerEmail: null, customerId: null });

    expect(await resolveFiscalEmailRecipient(t.id, order)).toBeNull();
  });

  it("resolves to nobody for a POS sale, which is the whole till's state", async () => {
    // The till captures no email at ANY point in its flow — this is recorded
    // scope for Task 7, not a gap. A walk-in sale therefore lands exactly where
    // a blank-field guest does: no send, no error, two null columns.
    const t = await makeTenant();
    const order = await makeOrder(t.id, { channel: "pos", customerName: "Walk-in", customerEmail: null, customerId: null });

    expect(await resolveFiscalEmailRecipient(t.id, order)).toBeNull();
  });

  it("treats a whitespace-only captured address as absent rather than as a recipient", async () => {
    const t = await makeTenant();
    const account = await makeCustomer(t.id, "account@example.test");
    const order = await makeOrder(t.id, { customerEmail: "   ", customerId: account.id });

    // Trimmed-to-empty must not shadow the account rung, and must never reach
    // the provider as a blank `to`.
    expect(await resolveFiscalEmailRecipient(t.id, order)).toBe("account@example.test");
  });

  it("does not read another tenant's customer row for the same id", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const theirs = await makeCustomer(b.id, "theirs@example.test");
    // A cross-tenant customerId (the column carries no FK, by design) must
    // resolve to nothing rather than to another tenant's address. RLS inside
    // `withTenant` is what refuses it, not a predicate this function could
    // forget to write.
    const order = await makeOrder(a.id, { customerEmail: null, customerId: theirs.id });

    expect(await resolveFiscalEmailRecipient(a.id, order)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The family split
// ---------------------------------------------------------------------------

describe("renderFiscalDocumentEmail — family-aware on the same axes as orderFiscalView", () => {
  it("a receipt carries the QR's portal link and ETA's uuid", () => {
    const { subject, html } = renderFiscalDocumentEmail(receiptDoc, anOrder(), aTenant());

    expect(subject).toBe("Your tax receipt from Koshary Co — order #4242");
    expect(html).toContain(QR_URL);
    expect(html).toContain("a".repeat(64));
    expect(html).toContain("ETA UUID");
    expect(html).toContain("114.00 EGP");
    expect(html).toContain("#4242");
  });

  it("an invoice carries ETA's long id and NO QR — not 'no QR yet'", () => {
    const { subject, html } = renderFiscalDocumentEmail(invoiceDoc, anOrder(), aTenant());

    expect(subject).toBe("Your tax invoice from Koshary Co — order #4242");
    expect(html).toContain("EG-LONG-0001");
    expect(html).toContain("ETA document number");
    // THE LOAD-BEARING ABSENCE, asserted as "no link at all" rather than as
    // "no QR": an invoice has no QR at issuance and never acquires one, and no
    // invoice portal URL is INVENTED to stand in for it — a plausible path that
    // 404s is worse to send a business buyer than a number they can look up.
    expect(html).not.toContain("receipts/search");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("ETA UUID");
    // It says WHY there is no code, rather than silently omitting one and
    // leaving the buyer to wonder whether the mail is broken.
    expect(html).toContain("carries no QR code");
  });

  it("NON-VACUITY: the two differ ONLY in the family, not in the fixture", () => {
    // Same order, same tenant, same call — so every difference asserted above
    // is attributable to `docType` and to the fields the families genuinely do
    // not share. Without this the two tests could both be passing against two
    // unrelated fixtures.
    const order = anOrder();
    const tenant = aTenant();
    const receipt = renderFiscalDocumentEmail(receiptDoc, order, tenant);
    const invoice = renderFiscalDocumentEmail(invoiceDoc, order, tenant);

    expect(receipt.subject).not.toBe(invoice.subject);
    expect(receipt.html).not.toBe(invoice.html);
    // Both are about the SAME sale, and say so identically.
    expect(receipt.html).toContain("#4242");
    expect(invoice.html).toContain("#4242");
    expect(receipt.html).toContain("114.00 EGP");
    expect(invoice.html).toContain("114.00 EGP");
  });

  it("omits the identity line rather than printing a blank one when ETA has not answered", () => {
    // An accepted invoice ETA has not yet numbered has nothing to print, and a
    // number on a document that has none would be one we invented — the same
    // both-halves-required rule `orderFiscalView` applies.
    const { html } = renderFiscalDocumentEmail({ ...invoiceDoc, etaLongId: null }, anOrder(), aTenant());
    expect(html).not.toContain("ETA document number");
    expect(html).toContain("#4242");
  });

  it("escapes every interpolation — this mail gets forwarded", () => {
    const { subject, html } = renderFiscalDocumentEmail(
      receiptDoc,
      anOrder({ customerName: '<script>alert("x")</script>' }),
      aTenant({ name: "Bob & Sons <b>" }),
    );

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Bob &amp; Sons &lt;b&gt;");
    // The subject is not HTML and is not escaped — asserted so the asymmetry is
    // deliberate rather than an oversight.
    expect(subject).toContain("Bob & Sons <b>");
  });
});

// ---------------------------------------------------------------------------
// The send
// ---------------------------------------------------------------------------

describe("sendFiscalDocumentEmail", () => {
  it("sends to the resolved recipient, keyed for provider-side dedupe", async () => {
    const t = await makeTenant();
    const order = await makeOrder(t.id, { customerEmail: "nadia@example.test" });
    const provider = new FakeEmailProvider();

    const outcome = await sendFiscalDocumentEmail(
      receiptDoc,
      { ...anOrder(), id: order.id, customerEmail: order.customerEmail, customerId: order.customerId },
      aTenant({ id: t.id }),
      provider,
    );

    expect(outcome).toEqual({ kind: "sent", to: "nadia@example.test" });
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].to).toBe("nadia@example.test");
    // The submission row id, exactly as `drainOutbox` carries the outbox row
    // id — so a send repeated across a crash window is refused by the provider
    // even if our own column guard were bypassed.
    expect(provider.sent[0].idempotencyKey).toBe(receiptDoc.id);
    // Replies go to the restaurant, not to ServeOS.
    expect(provider.sent[0].replyTo).toBe("hello@koshary.test");
  });

  it("sends NOTHING when there is no recipient", async () => {
    const t = await makeTenant();
    const provider = new FakeEmailProvider();

    const outcome = await sendFiscalDocumentEmail(
      receiptDoc,
      { ...anOrder(), customerEmail: null, customerId: null },
      aTenant({ id: t.id }),
      provider,
    );

    expect(outcome).toEqual({ kind: "no-recipient" });
    expect(provider.sent).toHaveLength(0);
  });

  it("throws on a provider failure so the caller must record it", async () => {
    const t = await makeTenant();
    const provider = new FakeEmailProvider();
    provider.failNext = new Error("Resend send failed: 503");

    await expect(sendFiscalDocumentEmail(
      receiptDoc,
      anOrder(),
      aTenant({ id: t.id }),
      provider,
    )).rejects.toThrow("Resend send failed: 503");
  });
});
