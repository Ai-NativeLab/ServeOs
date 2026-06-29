import type { RoleKey, Permission } from "@/server/rbac/permissions";
import { can } from "@/server/rbac/authorize";

export type NavItem = { label: string; href: string; icon: string };

export function dashboardNavItems(roleKeys: RoleKey[]): NavItem[] {
  const has = (p: Permission) => can(roleKeys, p);
  const items: NavItem[] = [];

  // Home is setup-focused → owners/managers only (staff go straight to Orders).
  if (has("menu:manage") || has("fulfillment:manage")) items.push({ label: "Home", href: "/dashboard", icon: "home" });
  if (has("orders:manage")) items.push({ label: "Orders", href: "/dashboard/orders", icon: "receipt" });
  if (has("menu:manage")) items.push({ label: "Menu", href: "/dashboard/menu", icon: "utensils" });
  if (has("menu:manage")) items.push({ label: "Branches", href: "/dashboard/branches", icon: "store" });
  if (has("menu:manage")) items.push({ label: "Banners", href: "/dashboard/banners", icon: "image" });
  if (has("fulfillment:manage")) items.push({ label: "Settings", href: "/dashboard/fulfillment", icon: "settings" });

  return items;
}
