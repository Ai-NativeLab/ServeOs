import { Plus } from "lucide-react";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { listBanners } from "@/server/banners/service";
import { createBannerAction, toggleBannerAction, deleteBannerAction } from "./actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { ConfirmActionButton } from "@/components/dashboard/ConfirmActionButton";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default async function BannersPage() {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  const banners = await listBanners(ctx.tenantId);

  return (
    <>
      <PageHeader
        eyebrow="Storefront"
        title="Banners"
        description="Promotional images shown at the top of your storefront."
      />

      {banners.length === 0 ? (
        <EmptyState
          title="No banners yet"
          description="Add a promotional image below — it appears at the top of your storefront."
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 mb-6">
          {banners.map((b) => (
            <Card key={b.id} className="p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={b.imageUrl} alt={b.titleEn ?? ""} className="w-full h-32 rounded-lg object-cover mb-3" />
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-ink truncate">{b.titleEn ?? "Untitled banner"}</div>
                  <span className={b.isActive
                    ? "inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium bg-status-ready/15 text-status-ready-fg ring-1 ring-status-ready/30"
                    : "inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium bg-secondary text-muted-foreground"}>
                    {b.isActive ? "Active" : "Inactive"}
                  </span>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <ToastForm
                    action={toggleBannerAction.bind(null, b.id, !b.isActive)}
                    successMessage={b.isActive ? "Banner deactivated" : "Banner activated"}
                  >
                    <SubmitButton variant="outline" size="sm">{b.isActive ? "Deactivate" : "Activate"}</SubmitButton>
                  </ToastForm>
                  <ConfirmActionButton
                    action={deleteBannerAction.bind(null, b.id)}
                    label="Delete"
                    size="sm"
                    title="Delete this banner?"
                    description="It will be removed from your storefront immediately."
                    successMessage="Banner deleted"
                  />
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Card className="p-5 max-w-2xl">
        <h2 className="eyebrow text-primary mb-3">Add banner</h2>
        <ToastForm action={createBannerAction} successMessage="Banner added" className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="imageUrl">Image URL</Label>
            <Input id="imageUrl" name="imageUrl" required />
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="titleEn">Title (EN)</Label>
              <Input id="titleEn" name="titleEn" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="titleAr">Title (AR)</Label>
              <Input id="titleAr" name="titleAr" dir="rtl" />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="linkUrl">Link URL (optional)</Label>
            <Input id="linkUrl" name="linkUrl" />
          </div>
          <div><SubmitButton><Plus className="size-4" />Add banner</SubmitButton></div>
        </ToastForm>
      </Card>
    </>
  );
}
