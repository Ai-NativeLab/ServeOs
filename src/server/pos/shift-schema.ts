import { pgTable, uuid, text, timestamp, numeric, jsonb, pgEnum, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { users } from "@/server/auth/schema";
import { posDevices } from "./schema";

export const posShiftStatusEnum = pgEnum("pos_shift_status", ["open", "closed"]);
export const cashCountKindEnum = pgEnum("cash_count_kind", ["opening", "closing", "mid_shift"]);
export const cashMovementTypeEnum = pgEnum("cash_movement_type", ["pay_in", "pay_out", "safe_drop", "no_sale"]);

/** A cashier's session at one device/drawer. At most one `open` per device. */
export const posShifts = pgTable("pos_shifts", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
  deviceId: uuid("device_id").notNull().references(() => posDevices.id, { onDelete: "cascade" }),
  openedByUserId: uuid("opened_by_user_id").notNull().references(() => users.id),
  closedByUserId: uuid("closed_by_user_id").references(() => users.id),
  status: posShiftStatusEnum("status").notNull().default("open"),
  openingFloat: numeric("opening_float").notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
}, (t) => [
  // The hard guarantee: one open shift per drawer. Verify the WHERE predicate
  // survives generation (Step 4) — it is what makes this a *partial* unique.
  uniqueIndex("pos_shifts_device_open").on(t.deviceId).where(sql`status = 'open'`),
  index("pos_shifts_tenant_branch_status").on(t.tenantId, t.branchId, t.status),
  index("pos_shifts_device_status").on(t.deviceId, t.status),
]);

/** Cash entering/leaving the drawer outside a sale — the physical-drawer audit trail. */
export const cashMovements = pgTable("cash_movements", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  shiftId: uuid("shift_id").notNull().references(() => posShifts.id, { onDelete: "cascade" }),
  type: cashMovementTypeEnum("type").notNull(),
  // Signed by type: pay_in > 0; pay_out & safe_drop < 0; no_sale = 0. Enforced
  // by the cash_movements_amount_sign CHECK hand-appended in Step 4.
  amount: numeric("amount").notNull(),
  reasonCode: text("reason_code").notNull(),
  reasonText: text("reason_text"),
  byUserId: uuid("by_user_id").notNull().references(() => users.id),
  authorizedByUserId: uuid("authorized_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("cash_movements_shift_type").on(t.shiftId, t.type)]);

/** A physical count of the drawer and the variance it implies. */
export const cashCounts = pgTable("cash_counts", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  shiftId: uuid("shift_id").notNull().references(() => posShifts.id, { onDelete: "cascade" }),
  kind: cashCountKindEnum("kind").notNull(),
  countedTotal: numeric("counted_total").notNull(),
  denominations: jsonb("denominations").$type<Record<string, number>>(),
  expectedTotal: numeric("expected_total").notNull(),
  variance: numeric("variance").notNull(),
  byUserId: uuid("by_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("cash_counts_shift_kind").on(t.shiftId, t.kind)]);

export type PosShift = typeof posShifts.$inferSelect;
export type CashMovement = typeof cashMovements.$inferSelect;
export type CashCount = typeof cashCounts.$inferSelect;
export type CashMovementType = (typeof cashMovementTypeEnum.enumValues)[number];
