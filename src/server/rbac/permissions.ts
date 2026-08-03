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
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type RoleKey = "owner" | "manager" | "staff" | "super_admin";

export const ROLE_PERMISSIONS: Record<RoleKey, Permission[]> = {
  owner: ["tenant:manage", "staff:invite", "plan:view", "plan:change", "billing:manage", "menu:manage", "orders:manage", "fulfillment:manage", "payments:confirm", "pos:sell", "pos:discount", "pos:void", "pos:refund", "audit:view", "reconciliation:manage", "reports:view", "reports:financial", "customers:manage"],
  manager: ["staff:invite", "plan:view", "menu:manage", "orders:manage", "fulfillment:manage", "payments:confirm", "pos:sell", "pos:discount", "pos:void", "pos:refund", "audit:view", "reconciliation:manage", "reports:view", "reports:financial", "customers:manage"],
  staff: ["plan:view", "orders:manage", "pos:sell"],
  super_admin: ["platform:approve_tenant", "platform:suspend_tenant", "platform:view_revenue"],
};
