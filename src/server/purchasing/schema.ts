import { pgTable, uuid, text, timestamp, numeric, integer, boolean, pgEnum, uniqueIndex, index } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { users } from "@/server/auth/schema";
import { unitOfMeasureEnum } from "@/server/catalog/uom";
import { inventoryItems } from "@/server/inventory/schema";

export const poStatusEnum = pgEnum("po_status", [
  "draft", "sent", "partially_received", "received", "closed", "cancelled",
]);

export const suppliers = pgTable("suppliers", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  contactName: text("contact_name"),
  email: text("email"),
  phone: text("phone"),
  paymentTerms: text("payment_terms"),
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("suppliers_tenant").on(t.tenantId)]);

export const supplierItems = pgTable("supplier_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  supplierId: uuid("supplier_id").notNull().references(() => suppliers.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => inventoryItems.id, { onDelete: "cascade" }),
  supplierSku: text("supplier_sku"),
  lastUnitCost: numeric("last_unit_cost"),
  packUom: unitOfMeasureEnum("pack_uom"),
}, (t) => [uniqueIndex("supplier_items_supplier_item").on(t.supplierId, t.itemId)]);

export const purchaseOrders = pgTable("purchase_orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
  supplierId: uuid("supplier_id").notNull().references(() => suppliers.id),
  poNumber: integer("po_number").notNull(),
  status: poStatusEnum("status").notNull().default("draft"),
  total: numeric("total").notNull().default("0"),
  invoiceTotal: numeric("invoice_total"),
  currency: text("currency").notNull().default("EGP"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  expectedAt: timestamp("expected_at", { withTimezone: true }),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("purchase_orders_tenant_number").on(t.tenantId, t.poNumber),
  index("purchase_orders_tenant_status").on(t.tenantId, t.status),
]);

export const purchaseOrderLines = pgTable("purchase_order_lines", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  poId: uuid("po_id").notNull().references(() => purchaseOrders.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => inventoryItems.id),
  qtyOrdered: numeric("qty_ordered").notNull(),
  uom: unitOfMeasureEnum("uom").notNull(),
  unitCost: numeric("unit_cost").notNull(),
  taxRate: numeric("tax_rate"),
  qtyReceived: numeric("qty_received").notNull().default("0"),
}, (t) => [index("purchase_order_lines_po").on(t.poId)]);

export const poReceipts = pgTable("po_receipts", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  purchaseOrderId: uuid("purchase_order_id").notNull()
    .references(() => purchaseOrders.id, { onDelete: "cascade" }),
  receivedByUserId: uuid("received_by_user_id").references(() => users.id),
  supplierDeliveryNote: text("supplier_delivery_note"),
  note: text("note"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("po_receipts_po").on(t.purchaseOrderId)]);

export const poReceiptLines = pgTable("po_receipt_lines", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  poReceiptId: uuid("po_receipt_id").notNull()
    .references(() => poReceipts.id, { onDelete: "cascade" }),
  poLineId: uuid("po_line_id").notNull().references(() => purchaseOrderLines.id),
  itemId: uuid("item_id").notNull().references(() => inventoryItems.id),
  receivedQty: numeric("received_qty").notNull(),
  uom: unitOfMeasureEnum("uom").notNull(),
  unitCost: numeric("unit_cost").notNull(),
  lotCode: text("lot_code"),
  expiryAt: timestamp("expiry_at", { withTimezone: true }),
}, (t) => [index("po_receipt_lines_receipt").on(t.poReceiptId)]);

export type Supplier = typeof suppliers.$inferSelect;
export type SupplierItem = typeof supplierItems.$inferSelect;
export type PurchaseOrder = typeof purchaseOrders.$inferSelect;
export type PurchaseOrderLine = typeof purchaseOrderLines.$inferSelect;
export type PoReceipt = typeof poReceipts.$inferSelect;
export type PoReceiptLine = typeof poReceiptLines.$inferSelect;
