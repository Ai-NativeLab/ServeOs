import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { SettingsTabs } from "./SettingsTabs";
import { visibleSettingsTabs } from "./tabs";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  // A suspended tenant must reach BILLING (the recovery path), so this chrome
  // layer lets them through; enforcement stays at page level — every settings
  // page's own permission wrapper default-denies blocked statuses except
  // billing's `allowSuspended`. Non-billing pages bounce a suspended user to
  // the lockout exactly as before (#164).
  const { roleKeys } = await requireDashboardUser({ allowStatus: ["suspended"] });
  const tabs = visibleSettingsTabs(roleKeys);

  return (
    <>
      <SettingsTabs tabs={tabs} />
      {children}
    </>
  );
}
