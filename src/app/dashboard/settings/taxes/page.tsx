import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { getTenantById, getCheckoutPricing } from "@/server/tenancy";
import { getCapabilities, selectStorefrontTemplate, type VerticalId } from "@/server/verticals";
import { saveTaxSettingsAction } from "./actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default async function TaxesSettingsPage() {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "fulfillment:manage");
  const tenant = await getTenantById(ctx.tenantId);
  const caps = getCapabilities(selectStorefrontTemplate(tenant?.vertical as VerticalId));
  const pricing = await getCheckoutPricing(ctx.tenantId);

  return (
    <>
      <PageHeader eyebrow="Settings" title="Taxes & charges" />
      <Card className="p-5 max-w-2xl">
        <ToastForm action={saveTaxSettingsAction} successMessage="Tax settings saved" className="grid gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="vatEnabled" value="true" defaultChecked={pricing.vatEnabled} className="size-4 accent-(--color-primary)" />
            Charge VAT on orders
          </label>
          <div className="grid gap-1.5 max-w-32">
            <Label htmlFor="vatRate">VAT rate (%)</Label>
            <Input id="vatRate" name="vatRate" type="number" step="0.5" min="0" max="100" defaultValue={pricing.vatRate} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="pricesIncludeVat" value="true" defaultChecked={pricing.pricesIncludeVat} className="size-4 accent-(--color-primary)" />
            My prices already include VAT (VAT shown as an informational line)
          </label>
          {caps.serviceCharge && (
            <div className="grid gap-1.5 max-w-32">
              <Label htmlFor="serviceChargeRate">Service charge (%)</Label>
              <Input id="serviceChargeRate" name="serviceChargeRate" type="number" step="0.5" min="0" max="100" defaultValue={pricing.serviceChargeRate || ""} placeholder="Off" />
            </div>
          )}
          <div><SubmitButton>Save</SubmitButton></div>
        </ToastForm>
      </Card>
    </>
  );
}
