import { and, count, desc, eq, gt, isNotNull } from "drizzle-orm";
import { db } from "@/db/client";
import { activeEmailProvider, type EmailProvider } from "@/server/email";
import { defaultSender } from "@/server/email/sender";
import { planEnquiries } from "./schema";

export type NewEnquiry = {
  planKey: string;
  name: string;
  businessName: string;
  phone: string;
  email: string;
  locale: "ar" | "en";
  /** Null when no proxy header was present; such a row cannot be rate-limited. */
  ip: string | null;
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Records interest in a paid plan, then notifies the sales inbox.
 *
 * The row is committed BEFORE the provider is called, deliberately. Email is
 * the fragile half — a missing RESEND_API_KEY, an unverified sending domain, a
 * provider outage — and a lead that exists only inside an email is a lead you
 * lose without ever knowing someone wanted to buy. Delivery failure is recorded
 * on the row and never thrown at the visitor.
 *
 * Sends directly rather than through notify(): that path requires a tenant (a
 * prospect has none) and its worker is drained by a once-daily cron, which
 * would leave a sales lead sitting unsent for up to 24 hours.
 */
export async function createEnquiry(
  input: NewEnquiry,
  // Injected the same way drainOutbox() takes one, so a test can assert on the
  // message without reaching into module state.
  provider: EmailProvider = activeEmailProvider(),
): Promise<{ id: string; emailed: boolean }> {
  const [row] = await db.insert(planEnquiries).values({
    planKey: input.planKey,
    name: input.name,
    businessName: input.businessName,
    phone: input.phone,
    email: input.email,
    locale: input.locale,
    ip: input.ip,
  }).returning();

  const to = process.env.SALES_INBOX_EMAIL;
  if (!to) return undelivered(row.id, "SALES_INBOX_EMAIL is not set");

  try {
    await provider.send({
      from: defaultSender(),
      to,
      // Replying to the notification reaches the prospect directly.
      replyTo: input.email,
      subject: `Plan enquiry: ${input.planKey} — ${input.businessName}`,
      html:
        `<p><strong>${escapeHtml(input.name)}</strong> (${escapeHtml(input.businessName)}) ` +
        `wants the <strong>${escapeHtml(input.planKey)}</strong> plan.</p>` +
        `<p>Phone: ${escapeHtml(input.phone)}<br/>` +
        `Email: ${escapeHtml(input.email)}<br/>` +
        `Reading in: ${escapeHtml(input.locale)}</p>`,
      idempotencyKey: row.id,
    });
    await db.update(planEnquiries)
      .set({ status: "sent", sentAt: new Date() })
      .where(eq(planEnquiries.id, row.id));
    return { id: row.id, emailed: true };
  } catch (e) {
    return undelivered(row.id, e instanceof Error ? e.message : "unknown");
  }
}

/**
 * Records why a lead was not delivered, and says so out loud.
 *
 * The row alone is not an operator surface: the visitor is told "we'll be in
 * touch" either way, so without this line a missing SALES_INBOX_EMAIL is
 * completely silent — sales hears nothing and nobody is watching the table.
 * console.error reaches Vercel's runtime logs, which is where alerting looks.
 */
async function undelivered(id: string, reason: string): Promise<{ id: string; emailed: boolean }> {
  await db.update(planEnquiries).set({ lastError: reason }).where(eq(planEnquiries.id, id));
  console.error(`[enquiries] lead ${id} captured but NOT delivered to sales: ${reason}`);
  return { id, emailed: false };
}

/** Leads that never reached sales, newest first — what an operator queries
 *  after seeing the log line above, and what a retry job would drain. */
export async function unsentEnquiries(limit = 100) {
  return db.select().from(planEnquiries)
    .where(eq(planEnquiries.status, "unsent"))
    .orderBy(desc(planEnquiries.createdAt))
    .limit(limit);
}

/**
 * A duplicate of the enquiry being submitted: the same address asking about the
 * same plan, moments ago.
 *
 * Keyed on plan as well as email deliberately. Keyed on email alone, a prospect
 * comparing tiers — enquire about pro, then about enterprise two minutes later —
 * was told "we already have your request" and sales never learned they had
 * changed their mind, which for a lead-capture feature is the expensive failure.
 */
export async function recentlyEnquired(
  email: string,
  planKey: string,
  withinMinutes = 5,
): Promise<boolean> {
  const since = new Date(Date.now() - withinMinutes * 60_000);
  const [recent] = await db.select({ id: planEnquiries.id })
    .from(planEnquiries)
    .where(and(
      eq(planEnquiries.email, email),
      eq(planEnquiries.planKey, planKey),
      gt(planEnquiries.createdAt, since),
    ))
    .orderBy(desc(planEnquiries.createdAt))
    .limit(1);
  return Boolean(recent);
}

/** Enquiries one address may submit per hour, whatever email it puts in the form. */
export const IP_HOURLY_LIMIT = 5;

/**
 * The cap the per-email check cannot provide.
 *
 * The design called for throttling "the same email OR IP" and only the email
 * half shipped, which left the guard trivially defeated: vary the address and
 * every submission is a database write plus a live provider call, on the same
 * Resend credentials and sending domain that carry customer transactional mail.
 * Exhausting that quota degrades real tenants' email, so the cap is per-address
 * rather than per-identity-the-submitter-chooses.
 *
 * A null ip is never counted — it cannot be attributed to anyone.
 */
export async function tooManyFromIp(
  ip: string | null,
  withinMinutes = 60,
  limit = IP_HOURLY_LIMIT,
): Promise<boolean> {
  if (!ip) return false;
  const since = new Date(Date.now() - withinMinutes * 60_000);
  const [row] = await db.select({ n: count() })
    .from(planEnquiries)
    .where(and(
      isNotNull(planEnquiries.ip),
      eq(planEnquiries.ip, ip),
      gt(planEnquiries.createdAt, since),
    ));
  return (row?.n ?? 0) >= limit;
}
