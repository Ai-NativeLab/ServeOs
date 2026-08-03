import { pgTable, uuid, text, timestamp, pgEnum, index } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";
import { customers } from "@/server/customers/schema";
import { users } from "@/server/auth/schema";
import { orders } from "@/server/ordering/schema";

export const prescriptionStatusEnum = pgEnum("prescription_status", ["pending", "approved", "rejected"]);

/**
 * A customer-submitted prescription awaiting (or having had) pharmacist review.
 *
 * imagePath is a STORAGE PATH into a private bucket, never a public URL
 * (decision R4) — a prescription is medical data, and the product-image route's
 * public object URLs are not an acceptable store for it. Staff read it through
 * a short-lived signed URL minted on demand.
 */
export const prescriptions = pgTable("prescriptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  /** Set once the script is attached to a placed order. */
  orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
  imagePath: text("image_path").notNull(),
  status: prescriptionStatusEnum("status").notNull().default("pending"),
  reviewedByUserId: uuid("reviewed_by_user_id").references(() => users.id),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  rejectionReason: text("rejection_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("prescriptions_tenant_status").on(t.tenantId, t.status),
  index("prescriptions_customer").on(t.customerId),
]);

export type Prescription = typeof prescriptions.$inferSelect;
export type PrescriptionStatus = (typeof prescriptionStatusEnum.enumValues)[number];
