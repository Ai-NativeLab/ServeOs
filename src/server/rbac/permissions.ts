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
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type RoleKey = "owner" | "manager" | "staff" | "super_admin";

export const ROLE_PERMISSIONS: Record<RoleKey, Permission[]> = {
  owner: ["tenant:manage", "staff:invite", "plan:view", "plan:change", "billing:manage", "menu:manage", "orders:manage", "fulfillment:manage"],
  manager: ["staff:invite", "plan:view", "menu:manage", "orders:manage", "fulfillment:manage"],
  staff: ["plan:view", "orders:manage"],
  super_admin: ["platform:approve_tenant", "platform:suspend_tenant", "platform:view_revenue"],
};
