import type { RoleKey, Permission } from "@/server/rbac/permissions";
import { can } from "@/server/rbac/authorize";

export type NavItem = { label: string; href: string; icon: string };

/**
 * @param country the tenant's ISO country, which gates the ETA fiscal screen.
 * E-invoicing is an Egypt-specific obligation (the same F1/F2 gate
 * `resolveFiscalProvider` applies), so showing the item to a UAE owner would
 * advertise a setup screen that can never do anything. Optional and defaulting
 * to hidden: a caller with no tenant in hand gets the pre-fiscal nav unchanged.
 */
export function dashboardNavItems(roleKeys: RoleKey[], catalogLabel = "Menu", country?: string | null): NavItem[] {
  const has = (p: Permission) => can(roleKeys, p);
  const items: NavItem[] = [];

  // Home is setup-focused → owners/managers only (staff go straight to Orders).
  if (has("menu:manage") || has("fulfillment:manage")) items.push({ label: "Home", href: "/dashboard", icon: "home" });
  if (has("menu:manage")) items.push({ label: "Analytics", href: "/dashboard/analytics", icon: "analytics" });
  if (has("orders:manage")) items.push({ label: "Orders", href: "/dashboard/orders", icon: "receipt" });
  if (has("orders:manage")) items.push({ label: "Sales history", href: "/dashboard/orders/history", icon: "history" });
  if (has("payments:confirm")) items.push({ label: "Payments", href: "/dashboard/payments", icon: "receipt" });
  if (has("menu:manage")) items.push({ label: catalogLabel, href: "/dashboard/menu", icon: "utensils" });
  // Staff hold inventory:view + inventory:count, so they reach the stock screen
  // to count shelves even though they cannot manage items.
  if (has("inventory:view")) items.push({ label: "Inventory", href: "/dashboard/inventory", icon: "inventory" });
  if (has("purchasing:manage")) items.push({ label: "Purchasing", href: "/dashboard/purchase-orders", icon: "receipt" });
  if (has("suppliers:manage")) items.push({ label: "Suppliers", href: "/dashboard/suppliers", icon: "store" });
  if (has("menu:manage")) items.push({ label: "Branches", href: "/dashboard/branches", icon: "store" });
  if (has("menu:manage")) items.push({ label: "Banners", href: "/dashboard/banners", icon: "image" });
  if (has("fulfillment:manage")) items.push({ label: "Settings", href: "/dashboard/settings", icon: "settings" });
  // Audit log is an oversight surface — owner + manager (audit:view), never staff.
  if (has("audit:view")) items.push({ label: "Audit", href: "/dashboard/audit", icon: "audit" });
  // ETA setup: owner only (fiscal:manage) AND Egypt only. Both halves matter —
  // the permission is narrower than every other admin screen because this one
  // names the taxpayer, and the country gate keeps it out of a nav where it
  // could never be used.
  if (country === "EG" && has("fiscal:manage")) items.push({ label: "Fiscal", href: "/dashboard/fiscal", icon: "fiscal" });
  if (has("customers:manage")) items.push({ label: "Customers", href: "/dashboard/customers", icon: "customers" });
  // Pharmacy only in practice — the permission exists nowhere else.
  if (has("rx:review")) items.push({ label: "Prescriptions", href: "/dashboard/prescriptions", icon: "prescriptions" });

  return items;
}
