import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "@/db/client";
import { activeEmailProvider, type EmailProvider } from "@/server/email";
import { defaultSender } from "@/server/notifications/worker";
import { planEnquiries } from "./schema";

export type NewEnquiry = {
  planKey: string;
  name: string;
  businessName: string;
  phone: string;
  email: string;
  locale: "ar" | "en";
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
  }).returning();

  const to = process.env.SALES_INBOX_EMAIL;
  if (!to) {
    await db.update(planEnquiries)
      .set({ lastError: "SALES_INBOX_EMAIL is not set" })
      .where(eq(planEnquiries.id, row.id));
    return { id: row.id, emailed: false };
  }

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
    await db.update(planEnquiries)
      .set({ lastError: e instanceof Error ? e.message : "unknown" })
      .where(eq(planEnquiries.id, row.id));
    return { id: row.id, emailed: false };
  }
}

/**
 * Throttle source: the enquiries table itself, so a public form that causes
 * email gets a guard without any new infrastructure.
 */
export async function recentlyEnquired(email: string, withinMinutes = 5): Promise<boolean> {
  const since = new Date(Date.now() - withinMinutes * 60_000);
  const [recent] = await db.select({ id: planEnquiries.id })
    .from(planEnquiries)
    .where(and(eq(planEnquiries.email, email), gt(planEnquiries.createdAt, since)))
    .orderBy(desc(planEnquiries.createdAt))
    .limit(1);
  return Boolean(recent);
}
