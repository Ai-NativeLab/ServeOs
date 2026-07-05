import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { SettingsTabs } from "./SettingsTabs";
import { visibleSettingsTabs } from "./tabs";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const { roleKeys } = await requireDashboardUser();
  const tabs = visibleSettingsTabs(roleKeys);

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Settings"
        description="Business profile, WhatsApp, fulfillment, staff, and billing."
      />
      <SettingsTabs tabs={tabs} />
      {children}
    </>
  );
}
