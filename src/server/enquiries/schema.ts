import { pgTable, text, uuid, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Interest in a paid plan, captured from the public pricing page.
 *
 * CONTROL-PLANE — there is no tenant, because a prospect has not signed up yet.
 * That is precisely why this cannot live in notification_outbox: its tenant_id
 * is NOT NULL with an FK to tenants, and notify() wraps every write in
 * withTenant() for RLS. Follows the `tenants` precedent — a control table with
 * no row-level security.
 *
 * The row is committed BEFORE delivery is attempted. Email is the fragile half
 * (a missing key, an unverified domain, a provider outage) and a lead that
 * exists only inside an email is a lead you lose.
 */
export const planEnquiries = pgTable("plan_enquiries", {
  id: uuid("id").defaultRandom().primaryKey(),
  planKey: text("plan_key").notNull(),
  name: text("name").notNull(),
  businessName: text("business_name").notNull(),
  phone: text("phone").notNull(),
  email: text("email").notNull(),
  /** Which language they were reading when they asked. */
  locale: text("locale").notNull(),
  /** "sent" once the provider accepted it; "unsent" until then. */
  status: text("status").notNull().default("unsent"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
}, (t) => [
  // The throttle reads by email, newest first.
  index("plan_enquiries_email_created").on(t.email, t.createdAt),
]);

export type PlanEnquiry = typeof planEnquiries.$inferSelect;
