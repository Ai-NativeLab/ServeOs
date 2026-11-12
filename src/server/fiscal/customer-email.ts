import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { activeEmailProvider } from "@/server/email";
import { defaultSender } from "@/server/email/sender";
import type { EmailProvider } from "@/server/email/provider";
import { tenants } from "@/server/tenancy/schema";
import { orders } from "@/server/ordering/schema";
import { customers } from "@/server/customers/schema";
import { etaSubmissions } from "./schema";

/**
 * THE CUSTOMER'S OWN COPY OF THEIR FISCAL DOCUMENT — and for an ONLINE order
 * this is the PRIMARY delivery channel, not a convenience.
 *
 * WHY IT IS PRIMARY, which is a fact about the sweep rather than a preference.
 * An online order is fiscalised by `reconcileMissingReceipts`, so its
 * `eta_submissions` row is written 5-20 minutes after payment (addendum §6) —
 * long after the customer closed the status page. The storefront's fiscal block
 * (round 2, Task 6) therefore shows the pending line to almost everyone who
 * looks, and its own rationale says so in terms: it is what a REVISIT shows,
 * and it defers the reliable copy to this email. Nothing pushes that page —
 * `StatusPoller` sets its own state and never calls `router.refresh()`, and the
 * worker publishes no realtime event when it writes a fiscal row — so there is
 * no version of that block that reaches a customer who has left. This email is
 * the only thing that does.
 *
 * ---------------------------------------------------------------------------
 * IT SENDS DIRECTLY THROUGH THE PROVIDER, AND THAT IS A DIVERGENCE FROM BOTH
 * HOUSE PATTERNS — stated here rather than discovered.
 *
 * `notify()` is not usable at all: its targets are `{userId}` or `{role}`, so
 * it addresses STAFF, and the customer is neither. That much is forced.
 *
 * The interesting divergence is from the OTHER house pattern — `sendPurchaseOrder`
 * (`@/server/purchasing/send`) mails an external supplier by inserting a
 * `notification_outbox` row and letting `drainOutbox` deliver it, which buys
 * retries, exponential backoff, an audit event and a critical alert on
 * exhaustion. All of that is genuinely better than what this module does, and
 * it was still not chosen, for one reason: THE OUTBOX MAKES THE OUTCOME
 * ASYNCHRONOUS, and the outcome is the deliverable here. A queued row can only
 * ever stamp `customer_emailed_at` as "handed off"; the send's real verdict
 * lands minutes later in `notification_outbox.last_error`, on a row keyed by
 * nothing the fiscal dashboard reads, and `eta_submissions.customer_email_error`
 * would be a column no code path could ever populate. The visible-failure
 * requirement is a correctness gate, not a feature, and a failure surface that
 * cannot observe the failure does not satisfy it.
 *
 * WHAT THAT COSTS, HONESTLY: one attempt, no backoff. A transient provider blip
 * loses that customer's email permanently — there is no retry ladder and this
 * module does not invent one. What replaces it is VISIBILITY: the row carries
 * the reason, the dashboard's submissions table renders it, and a human decides.
 * That trade is the right one only because the fiscal obligation is already
 * discharged — ETA has the document, the sale is declared, and the customer's
 * copy is a courtesy that must never be confused with compliance. If retries are
 * wanted later, the honest shape is an outbox row PLUS a callback that stamps
 * these columns, not a silent second send path.
 *
 * PROVIDER-SIDE DEDUPE STILL APPLIES. `idempotencyKey` carries the submission
 * row id, exactly as `drainOutbox` carries the outbox row id, so even a send
 * repeated across a crash window cannot become a second email in the customer's
 * inbox. `customer_emailed_at` is the first guard; that key is the second.
 *
 * ---------------------------------------------------------------------------
 * THE INLINE-QR FINDING, AND WHAT SHIPPED INSTEAD.
 *
 * The task asked for the QR image inline. IT IS NOT POSSIBLE THROUGH THIS
 * PROVIDER SURFACE, and the constraint is in the interface rather than in the
 * vendor: `EmailMessage` (`@/server/email/provider`) is exactly
 * `{from, replyTo, to, subject, html, idempotencyKey}` — no attachments array,
 * no content-id map — and `ResendEmailProvider` forwards precisely those fields
 * and no others. A CID inline image needs an attachment with a content id, so
 * supporting one means widening a shared interface and both implementations,
 * which is a change to the email subsystem rather than to the fiscal one.
 *
 * The remaining trick — `<img src="data:image/png;base64,…">` off the same data
 * URL the status page renders — was deliberately NOT taken. Gmail and Outlook
 * strip `data:` image sources, so it renders as a broken-image icon for most
 * recipients, which is worse than no image: it looks like the receipt itself
 * failed. A quiet failure that looks like a broken document is the exact
 * outcome this task exists to prevent.
 *
 * SO THE PORTAL LINK IS THE QR DELIVERY. `qr_payload` is not an internal
 * encoding — it is a public ETA portal URL
 * (`{portal}/receipts/search/{uuid}/share/{date}#Total:…,IssuerRIN:…`, see
 * `buildQrUrl`), and it is the exact string the printed QR encodes. Scanning the
 * QR and clicking this link land on the same page, so the customer loses the
 * convenience of the camera and nothing else. It is also the only shape that
 * works in a plain-text reading of the mail.
 *
 * ---------------------------------------------------------------------------
 * FAMILY-AWARE ON THE SAME AXES `orderFiscalView` SPLITS ON
 * (`@/app/order/[token]/order-fiscal`), and for the same reasons — the two
 * cannot import each other (server module vs. page module), so the split is
 * restated rather than shared:
 *
 *   `e_receipt`  the QR's portal link + ETA's uuid. The consumer document.
 *   `e_invoice`  tax-invoice wording + ETA's long id, and NO QR EVER — not
 *                "no QR yet". ETA publishes no invoice QR template, so
 *                `qr_payload` is null for an invoice's whole life (addendum §6)
 *                and there is nothing that could later fill it.
 *
 * NO URL IS INVENTED FOR AN INVOICE. An invoice links to nothing rather than to
 * a guessed portal path: `qr_payload` is reused for receipts ONLY, and a
 * plausible-looking URL that 404s is a worse thing to send a business buyer than
 * a document number they can look up themselves.
 *
 * ---------------------------------------------------------------------------
 * THE WIDEST AUDIENCE IN THE SUBSYSTEM. `/order/[token]` answers to whoever
 * holds a link; a forwarded EMAIL answers to whoever holds the email, which is
 * that set plus everyone downstream of a forward, minus any expiry. So the
 * rendered subject and body are walked at `TOKEN_FORBIDDEN` in
 * `config-service.test.ts`'s masking walk — the strict set, including bare env
 * key names, which `FORBIDDEN` deliberately permits for the owner-only surfaces.
 * Nothing here reads `last_error`, `customer_email_error` or any `*_ref` column;
 * the walk is what keeps it that way when someone adds a "why is this pending?"
 * line to the body.
 */

/** The four-entity escape, kept local for the same reason `./purchasing/render`
 *  keeps its own: a pure renderer must not depend on another module's escaping
 *  when both guard interpolated HTML. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * How much of a failure reason `customer_email_error` keeps.
 *
 * Long enough for a provider's own message plus its class name, short enough
 * that a pathological error cannot turn a dashboard cell into a wall of text or
 * a fiscal row into a large one.
 *
 * A DIVERGENCE FROM `last_error`, WHICH IS UNCAPPED — deliberate, and the
 * difference is WHOSE error text lands in the column. `last_error` is written
 * from this codebase's own error classes (`FiscalDocumentError`,
 * `EtaConfigError`, `EtaTransportError`), whose messages are bounded by
 * construction, so a cap there would be arithmetic nobody needs. THIS column
 * takes a THIRD PARTY's error, and an HTTP client's message can legitimately
 * embed a page-sized HTML error document or an echoed request body. Truncating
 * is what keeps both the column and the dashboard's email cell sane without
 * depending on a vendor's discretion. See `failTransiently` in `./worker` for
 * the other half of this note.
 */
const EMAIL_ERROR_MAX = 500;

/** What the email needs from the submission row. Structural, not the drizzle
 *  row type: the caller has already narrowed `docType` to the two families that
 *  carry an `order_id`. */
export type FiscalEmailDocument = {
  id: string;
  docType: "e_receipt" | "e_invoice";
  etaUuid: string | null;
  etaLongId: string | null;
  /** Receipts only, and null for an invoice forever — see the header. */
  qrPayload: string | null;
};

/** What the email needs from the order. `customerEmail`/`customerId` are the
 *  first two rungs of the recipient ladder. */
export type FiscalEmailOrder = {
  id: string;
  orderNumber: number;
  total: string;
  customerName: string;
  customerEmail: string | null;
  customerId: string | null;
};

export type FiscalEmailTenant = {
  id: string;
  name: string;
  currency: string;
  contactEmail: string | null;
};

/**
 * WHO GETS IT — three rungs, and the third is "nobody", which is a legitimate
 * answer rather than a failure.
 *
 *   1. `orders.customer_email` — what THIS order captured at checkout. First
 *      because it is a snapshot of what the buyer asked for at the time, and a
 *      guest who typed one has no account row to fall back to.
 *   2. `customers.email` via `orders.customer_id` — a signed-in customer who
 *      left the optional field blank. The column is `notNull` on that table, so
 *      reaching this rung always produces an address.
 *   3. NONE. No send, no error, both columns left null, and the dashboard shows
 *      an em-dash. This is the state EVERY POS SALE is in: the till captures no
 *      email anywhere in its flow, which is recorded scope rather than a gap to
 *      be worked around. It is also where a guest who skipped the field lands.
 *
 * Rung 1 beats rung 2 deliberately. A signed-in customer who types a different
 * address at checkout — a work address for a work order — is expressing a
 * preference about THIS document, and silently overriding it with their account
 * address would be the system knowing better.
 */
export async function resolveFiscalEmailRecipient(
  tenantId: string,
  order: Pick<FiscalEmailOrder, "customerEmail" | "customerId">,
): Promise<string | null> {
  const captured = order.customerEmail?.trim();
  if (captured) return captured;
  if (!order.customerId) return null;

  const [account] = await withTenant(tenantId, (tx) =>
    tx.select({ email: customers.email })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.id, order.customerId!)))
      .limit(1));
  return account?.email?.trim() || null;
}

/**
 * The message, as data. Pure — no db, no provider, no clock — so the family
 * split and the never-a-QR-on-an-invoice rule are assertable without a send.
 *
 * PLAIN-TEXT-FIRST, per the house email style (`renderTemplate`,
 * `@/server/notifications/worker`): the same neutral card shell, and inside it
 * prose plus a short labelled list. No logo, no button, no tracking pixel, no
 * marketing furniture — this is a tax document notice, and it is sent under a
 * column whose contract forbids it being anything else. Every interpolation is
 * escaped, so a hostile customer name or tenant name cannot inject markup into
 * a mail that will be forwarded.
 */
export function renderFiscalDocumentEmail(
  doc: FiscalEmailDocument,
  order: FiscalEmailOrder,
  tenant: FiscalEmailTenant,
): { subject: string; html: string } {
  const isInvoice = doc.docType === "e_invoice";
  const label = isInvoice ? "tax invoice" : "tax receipt";
  const total = `${Number(order.total).toFixed(2)} ${tenant.currency}`;

  const subject = `Your ${label} from ${tenant.name} — order #${order.orderNumber}`;

  // The identity line, and it is the WHOLE family split: an invoice shows the
  // number ETA assigned it, a receipt shows the uuid the document hashes to.
  // Each is null in exactly one legitimate state, so each is conditional.
  const identity = isInvoice
    ? (doc.etaLongId ? [["ETA document number", doc.etaLongId]] : [])
    : (doc.etaUuid ? [["ETA UUID", doc.etaUuid]] : []);

  const rows = [["Order", `#${order.orderNumber}`], ["Total", total], ...identity]
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#6E6459;">${escapeHtml(k)}</td>`
      + `<td style="padding:4px 0;color:#1A0F0A;">${escapeHtml(v)}</td></tr>`)
    .join("");

  // RECEIPTS ONLY. `qrPayload` is null for every invoice forever, so this is
  // guarded on the payload rather than on the family — but the family is what
  // makes the guard total, and the invoice branch below says so instead of
  // linking anywhere.
  const portal = !isInvoice && doc.qrPayload
    ? `<p style="margin:16px 0 0;color:#1A0F0A;">The same page your receipt's QR code opens:<br>`
      + `<a href="${escapeHtml(doc.qrPayload)}" style="color:#1A0F0A;word-break:break-all;">${escapeHtml(doc.qrPayload)}</a></p>`
    : "";

  const intro = isInvoice
    ? `${tenant.name} has filed a tax invoice for your order with the Egyptian Tax Authority. `
      + "Your copy is the document number below — a tax invoice carries no QR code."
    : `${tenant.name} has filed a tax receipt for your order with the Egyptian Tax Authority. `
      + "You can verify it on the Authority's own portal using the link below.";

  const html = `<!doctype html><html><body style="font-family:sans-serif;background:#FBF7F2;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#FFFFFF;border:1px solid #E9E0D6;border-radius:12px;padding:24px;">
    <h2 style="margin:0 0 12px;color:#1A0F0A;">Your ${escapeHtml(label)}</h2>
    <p style="margin:0 0 12px;color:#1A0F0A;">Hello ${escapeHtml(order.customerName)},</p>
    <p style="margin:0 0 16px;color:#1A0F0A;">${escapeHtml(intro)}</p>
    <table style="border-collapse:collapse;font-size:14px;">${rows}</table>${portal}
    <p style="margin:20px 0 0;color:#6E6459;font-size:12px;">Sent by ${escapeHtml(tenant.name)} because you gave an address for your ${escapeHtml(label)}. This is a one-off message about this order.</p>
  </div></body></html>`;

  return { subject, html };
}

export type FiscalEmailOutcome =
  /** Nobody to email — both columns stay null, and the dashboard shows a dash. */
  | { kind: "no-recipient" }
  | { kind: "sent"; to: string }
  | { kind: "already-sent" };

/**
 * Resolve, compose, send. THROWS on a provider failure — the caller owns what a
 * failure means, because the caller is the one holding a fiscal row to record it
 * on. Returning a failure variant here would let a call site ignore it by
 * forgetting a branch; a throw cannot be forgotten silently.
 */
export async function sendFiscalDocumentEmail(
  doc: FiscalEmailDocument,
  order: FiscalEmailOrder,
  tenant: FiscalEmailTenant,
  provider: EmailProvider = activeEmailProvider(),
): Promise<FiscalEmailOutcome> {
  const to = await resolveFiscalEmailRecipient(tenant.id, order);
  if (!to) return { kind: "no-recipient" };

  const { subject, html } = renderFiscalDocumentEmail(doc, order, tenant);
  await provider.send({
    from: defaultSender(),
    // The tenant, not ServeOS: a customer replying about their own receipt is
    // asking the restaurant, and the same fallback chain the PO mail uses.
    ...(tenant.contactEmail ? { replyTo: tenant.contactEmail } : {}),
    to,
    subject,
    html,
    // The submission row id — see the header's dedupe note.
    idempotencyKey: doc.id,
  });
  return { kind: "sent", to };
}

/**
 * THE WORKER'S ENTRY POINT: everything between "ETA accepted this document" and
 * "the two columns say what happened". Loads, guards idempotency, sends, stamps.
 *
 * IT NEVER THROWS. Acceptance is already committed by the time this runs, and no
 * failure to email a courtesy copy may be allowed to look like a failure to file
 * a tax document. Every path out of here is a stamped column or a log line.
 *
 * THE JOIN IS WHAT SCOPES IT TO THE TWO ORDER-CARRYING FAMILIES. A
 * `return_receipt` or `credit_note` row has `refund_id` set and `order_id` null
 * (`eta_submissions_parent_xor`), so the inner join finds nothing and the answer
 * is "no recipient" without a docType predicate to keep in step. Emailing a
 * customer their return receipt is a real idea and deliberately not this task's.
 */
export async function deliverFiscalDocumentEmail(
  tenantId: string,
  submissionId: string,
  now: () => Date,
  provider?: EmailProvider,
): Promise<FiscalEmailOutcome | { kind: "failed"; error: string }> {
  try {
    const [ctx] = await withTenant(tenantId, (tx) =>
      tx.select({
        docType: etaSubmissions.docType,
        etaUuid: etaSubmissions.etaUuid,
        etaLongId: etaSubmissions.etaLongId,
        qrPayload: etaSubmissions.qrPayload,
        customerEmailedAt: etaSubmissions.customerEmailedAt,
        orderId: orders.id,
        orderNumber: orders.orderNumber,
        total: orders.total,
        customerName: orders.customerName,
        customerEmail: orders.customerEmail,
        customerId: orders.customerId,
      })
        .from(etaSubmissions)
        .innerJoin(orders, eq(orders.id, etaSubmissions.orderId))
        .where(and(eq(etaSubmissions.tenantId, tenantId), eq(etaSubmissions.id, submissionId)))
        .limit(1));

    if (!ctx) return { kind: "no-recipient" };
    // THE IDEMPOTENCY GUARD. `persistAccepted` is reached from the submit path
    // AND the poll path, and an expired claim lease can put two drains on one
    // row — so "accepted" is not a once-only event and this check is what makes
    // the email one. Read-then-write rather than a CAS because the loser of that
    // race is a duplicate the PROVIDER refuses (same `idempotencyKey`), not a
    // duplicate in the inbox: the cheap guard is enough, and the expensive one
    // would still not be a guarantee on its own.
    if (ctx.customerEmailedAt) return { kind: "already-sent" };
    if (ctx.docType !== "e_receipt" && ctx.docType !== "e_invoice") return { kind: "no-recipient" };

    const [tenant] = await db.select({
      id: tenants.id, name: tenants.name, currency: tenants.currency, contactEmail: tenants.contactEmail,
    }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!tenant) return { kind: "no-recipient" };

    const outcome = await sendFiscalDocumentEmail(
      { id: submissionId, docType: ctx.docType, etaUuid: ctx.etaUuid, etaLongId: ctx.etaLongId, qrPayload: ctx.qrPayload },
      {
        id: ctx.orderId, orderNumber: ctx.orderNumber, total: ctx.total,
        customerName: ctx.customerName, customerEmail: ctx.customerEmail, customerId: ctx.customerId,
      },
      tenant,
      provider,
    );

    // NO RECIPIENT WRITES NOTHING — not an empty string, not a "skipped" marker.
    // Two null columns IS the third state (see the schema note); writing
    // anything here would make "nobody to email" indistinguishable from a send
    // that half-happened.
    if (outcome.kind !== "sent") return outcome;

    await withTenant(tenantId, (tx) => tx.update(etaSubmissions)
      .set({ customerEmailedAt: now(), customerEmailError: null })
      .where(and(eq(etaSubmissions.tenantId, tenantId), eq(etaSubmissions.id, submissionId))));
    return outcome;
  } catch (e) {
    const error = emailFailureSummary(e);
    // Logged WITH ids as well as stamped: the column is what an owner sees, the
    // log line is what an engineer greps, and neither is a substitute for the
    // other when the failure is systemic (a wrong EMAIL_FROM fails every send
    // on the deployment, which is one dashboard cell per row and one obvious
    // pattern in the logs).
    console.error("[fiscal] customer email failed", { tenantId, submissionId, error });
    try {
      await withTenant(tenantId, (tx) => tx.update(etaSubmissions)
        .set({ customerEmailError: error })
        .where(and(eq(etaSubmissions.tenantId, tenantId), eq(etaSubmissions.id, submissionId))));
    } catch (stampFailure) {
      // The database is the thing that just failed, so there is nowhere to
      // record that recording failed. Acceptance still stands.
      console.error("[fiscal] could not record customer email failure", {
        tenantId, submissionId, error: emailFailureSummary(stampFailure),
      });
    }
    return { kind: "failed", error };
  }
}

/**
 * A storable reason, following `last_error`'s stance exactly (see the column's
 * JSDoc) rather than inventing a second one: class name plus message, truncated.
 *
 * An env KEY may legitimately appear — "RESEND_API_KEY is not set" is the most
 * useful sentence this column can hold, and the key name is not the secret. A
 * VALUE may not, which is why the provider's own discipline is not relied upon
 * as the only guard: `redactedCause`'s rule (never log a raw error on a fiscal
 * path, because drizzle puts query PARAMETERS in `error.message`) is the reason
 * the truncation is here and not left to the caller.
 */
function emailFailureSummary(e: unknown): string {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return raw.length > EMAIL_ERROR_MAX ? `${raw.slice(0, EMAIL_ERROR_MAX - 1)}…` : raw;
}
