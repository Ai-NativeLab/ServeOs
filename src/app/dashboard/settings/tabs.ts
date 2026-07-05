import type { RoleKey, Permission } from "@/server/rbac/permissions";
import { can } from "@/server/rbac/authorize";

export type SettingsTab = { label: string; href: string; permission: Permission };

export const SETTINGS_TABS: SettingsTab[] = [
  { label: "Business Profile", href: "/dashboard/settings/profile", permission: "tenant:manage" },
  { label: "WhatsApp", href: "/dashboard/settings/whatsapp", permission: "fulfillment:manage" },
  { label: "Fulfillment", href: "/dashboard/settings/fulfillment", permission: "fulfillment:manage" },
  { label: "Staff", href: "/dashboard/settings/staff", permission: "staff:invite" },
  { label: "Billing", href: "/dashboard/settings/billing", permission: "billing:manage" },
];

export function visibleSettingsTabs(roleKeys: RoleKey[]): SettingsTab[] {
  return SETTINGS_TABS.filter((tab) => can(roleKeys, tab.permission));
}
