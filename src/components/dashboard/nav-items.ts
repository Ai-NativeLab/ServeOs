import type { RoleKey, Permission } from "@/server/rbac/permissions";
import { can } from "@/server/rbac/authorize";

export type NavItem = { label: string; href: string; icon: string };

export function dashboardNavItems(roleKeys: RoleKey[], catalogLabel = "Menu"): NavItem[] {
  const has = (p: Permission) => can(roleKeys, p);
  const items: NavItem[] = [];

  // Home is setup-focused → owners/managers only (staff go straight to Orders).
  if (has("menu:manage") || has("fulfillment:manage")) items.push({ label: "Home", href: "/dashboard", icon: "home" });
  if (has("menu:manage")) items.push({ label: "Analytics", href: "/dashboard/analytics", icon: "analytics" });
  if (has("orders:manage")) items.push({ label: "Orders", href: "/dashboard/orders", icon: "receipt" });
  if (has("orders:manage")) items.push({ label: "Sales history", href: "/dashboard/orders/history", icon: "history" });
  if (has("payments:confirm")) items.push({ label: "Payments", href: "/dashboard/payments", icon: "receipt" });
  if (has("menu:manage")) items.push({ label: catalogLabel, href: "/dashboard/menu", icon: "utensils" });
  if (has("menu:manage")) items.push({ label: "Branches", href: "/dashboard/branches", icon: "store" });
  if (has("menu:manage")) items.push({ label: "Banners", href: "/dashboard/banners", icon: "image" });
  if (has("fulfillment:manage")) items.push({ label: "Settings", href: "/dashboard/settings", icon: "settings" });
  // Audit log is an oversight surface — owner + manager (audit:view), never staff.
  if (has("audit:view")) items.push({ label: "Audit", href: "/dashboard/audit", icon: "audit" });
  if (has("customers:manage")) items.push({ label: "Customers", href: "/dashboard/customers", icon: "customers" });
  // Pharmacy only in practice — the permission exists nowhere else.
  if (has("rx:review")) items.push({ label: "Prescriptions", href: "/dashboard/prescriptions", icon: "prescriptions" });

  return items;
}
