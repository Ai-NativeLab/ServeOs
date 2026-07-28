import type { NavItem } from "@/components/dashboard/nav-items";

export function adminNavItems(): NavItem[] {
  return [
    { label: "Overview", href: "/admin", icon: "overview" },
    { label: "Approvals", href: "/admin/approvals", icon: "approvals" },
    { label: "Billing", href: "/admin/billing", icon: "billing" },
    { label: "Tenants", href: "/admin/tenants", icon: "tenants" },
    { label: "Audit log", href: "/admin/audit", icon: "audit" },
  ];
}
