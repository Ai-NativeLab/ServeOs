import { requireTenantManagePermission } from "../profile-permission";
import { getTenantById } from "@/server/tenancy";
import { updateTenantProfileAction } from "./actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { ImageInput } from "@/components/dashboard/ImageInput";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

export default async function BusinessProfilePage() {
  const { tenantId } = await requireTenantManagePermission();
  const tenant = await getTenantById(tenantId);
  if (!tenant) throw new Error(`Tenant not found: ${tenantId}`);

  return (
    <>
      <PageHeader title="Business Profile" description="Restaurant name, logo, brand color, locale, and timezone." />
      <Card className="p-5 max-w-xl mb-6">
        <ToastForm action={updateTenantProfileAction} successMessage="Profile saved" className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="name">Restaurant name</Label>
            <Input id="name" name="name" defaultValue={tenant.name} required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="tagline">Tagline</Label>
            <Input id="tagline" name="tagline" defaultValue={tenant.tagline ?? ""} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cuisine">Cuisine</Label>
            <Input id="cuisine" name="cuisine" defaultValue={tenant.cuisine ?? ""} />
          </div>
          <div className="grid gap-1.5">
            <Label>Logo</Label>
            <ImageInput name="logoUrl" type="logo" defaultValue={tenant.logoUrl} aspect="square" />
          </div>
          <div className="grid gap-1.5">
            <Label>Cover photo</Label>
            <ImageInput name="coverImageUrl" type="cover" defaultValue={tenant.coverImageUrl} aspect="wide" />
            <p className="text-xs text-muted-foreground">Shown as the banner image at the top of your storefront.</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="primaryColor">Primary color</Label>
            <div className="flex items-center gap-2">
              <input
                id="primaryColor" name="primaryColor" type="color" defaultValue={tenant.primaryColor}
                className="size-9 rounded border border-input p-0.5"
              />
              <span className="font-mono text-sm text-muted-foreground">{tenant.primaryColor}</span>
            </div>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="defaultLocale">Default locale</Label>
              <select id="defaultLocale" name="defaultLocale" defaultValue={tenant.defaultLocale} className={selectClass}>
                <option value="en">English</option>
                <option value="ar">Arabic</option>
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="timezone">Timezone</Label>
              <select id="timezone" name="timezone" defaultValue={tenant.timezone} className={selectClass}>
                <option value="Africa/Cairo">Africa/Cairo</option>
                <option value="Asia/Riyadh">Asia/Riyadh</option>
              </select>
            </div>
          </div>
          <SubmitButton className="w-fit">Save</SubmitButton>
        </ToastForm>
      </Card>

      <Card className="p-5 max-w-xl bg-muted/30">
        <h2 className="eyebrow text-muted-foreground mb-3">Locked</h2>
        <dl className="text-sm space-y-1.5">
          <div className="flex justify-between"><dt className="text-muted-foreground">Slug (storefront URL)</dt><dd className="font-mono">{tenant.slug}</dd></div>
          <div className="flex justify-between"><dt className="text-muted-foreground">Country</dt><dd>{tenant.country}</dd></div>
          <div className="flex justify-between"><dt className="text-muted-foreground">Currency</dt><dd>{tenant.currency}</dd></div>
        </dl>
        <p className="text-xs text-muted-foreground mt-3">
          These affect your live storefront URL and billing/VAT — contact support to change them.
        </p>
      </Card>
    </>
  );
}
