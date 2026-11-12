import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { getCatalogDisplaySettings } from "@/server/tenancy/settings";
import { updateCatalogDisplayAction } from "./actions";
import { CatalogDisplaySettingsCard } from "@/components/dashboard/CatalogDisplaySettingsCard";
import { PageHeader } from "@/components/dashboard/PageHeader";

export default async function MenuDisplaySettingsPage() {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  const displaySettings = await getCatalogDisplaySettings(ctx.tenantId);

  return (
    <>
      <Link
        href="/dashboard/menu"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4"
      >
        <ArrowLeft className="size-4" strokeWidth={1.5} /> Menu
      </Link>
      <PageHeader
        eyebrow="Catalog"
        title="Storefront Display Layout"
        description="Configure how your products are displayed to customers on your public storefront."
      />
      <CatalogDisplaySettingsCard
        initialMode={displaySettings.catalogDisplayMode}
        initialItemsPerPage={displaySettings.itemsPerPage}
        action={updateCatalogDisplayAction}
      />
    </>
  );
}
