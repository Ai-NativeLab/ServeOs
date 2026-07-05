import { redirect } from "next/navigation";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { visibleSettingsTabs } from "./tabs";

export default async function SettingsIndexPage() {
  const { roleKeys } = await requireDashboardUser();
  const [firstTab] = visibleSettingsTabs(roleKeys);
  redirect(firstTab?.href ?? "/dashboard/orders");
}
