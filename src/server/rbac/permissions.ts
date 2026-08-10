export const PERMISSIONS = [
  "tenant:manage",
  "staff:invite",
  "plan:view",
  "plan:change",
  "billing:manage",
  "platform:approve_tenant",
  "platform:suspend_tenant",
  "platform:view_revenue",
  "menu:manage",
  "orders:manage",
  "fulfillment:manage",
  "payments:confirm",
  "pos:sell",
  "pos:discount",
  "pos:void",
  "pos:refund",
  "audit:view",
  "reconciliation:manage",
  "reports:view",
  "reports:financial",
  "customers:manage",
  "rx:review",
  "inventory:view",
  "inventory:manage",
  "inventory:count",
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type RoleKey = "owner" | "manager" | "staff" | "pharmacist" | "super_admin";

export const ROLE_PERMISSIONS: Record<RoleKey, Permission[]> = {
  owner: ["tenant:manage", "staff:invite", "plan:view", "plan:change", "billing:manage", "menu:manage", "orders:manage", "fulfillment:manage", "payments:confirm", "pos:sell", "pos:discount", "pos:void", "pos:refund", "audit:view", "reconciliation:manage", "reports:view", "reports:financial", "customers:manage", "rx:review", "inventory:view", "inventory:manage", "inventory:count"],
  manager: ["staff:invite", "plan:view", "menu:manage", "orders:manage", "fulfillment:manage", "payments:confirm", "pos:sell", "pos:discount", "pos:void", "pos:refund", "audit:view", "reconciliation:manage", "reports:view", "reports:financial", "customers:manage", "inventory:view", "inventory:manage", "inventory:count"],
  staff: ["plan:view", "orders:manage", "pos:sell", "inventory:view", "inventory:count"],
  // A licensed reviewer: the shop floor plus rx:review, and nothing
  // administrative — the compliance trail names a pharmacist, not "a manager".
  pharmacist: ["plan:view", "orders:manage", "fulfillment:manage", "pos:sell", "rx:review"],
  super_admin: ["platform:approve_tenant", "platform:suspend_tenant", "platform:view_revenue"],
};
