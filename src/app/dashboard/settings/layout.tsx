import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { SettingsTabs } from "./SettingsTabs";
import { visibleSettingsTabs } from "./tabs";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const { roleKeys } = await requireDashboardUser();
  const tabs = visibleSettingsTabs(roleKeys);

  return (
    <>
      <SettingsTabs tabs={tabs} />
      {children}
    </>
  );
}
