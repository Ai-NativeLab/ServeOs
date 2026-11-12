import { requireFulfillmentPermission } from "../fulfillment-permission";
import { listOfflineMethods } from "@/server/payments/offline/methods";
import { validatePayToDetail, getPayToDetailHint } from "@/server/payments/offline/validation";
import type { OfflineMethodType } from "@/server/payments/offline/types";
import { getTenantById } from "@/server/tenancy";
import { saveOfflineMethodAction, deleteOfflineMethodAction } from "./actions";
import { ORDER_METHOD_TYPES } from "./method-types";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { ConfirmActionButton } from "@/components/dashboard/ConfirmActionButton";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const METHOD_LABELS: Record<(typeof ORDER_METHOD_TYPES)[number], string> = {
  instapay: "InstaPay",
  vodafone_cash: "Vodafone Cash",
  mobile_wallet: "Mobile Wallet",
};

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

export default async function PaymentMethodsSettingsPage() {
  const ctx = await requireFulfillmentPermission();
  const [methods, tenant] = await Promise.all([
    listOfflineMethods(ctx.tenantId),
    getTenantById(ctx.tenantId),
  ]);
  const country = tenant?.country ?? "EG";

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Payment methods"
        description="Configure the offline pay-to channels customers can choose at checkout. Cash on delivery is always available and isn't configured here."
      />

      {methods.length === 0 ? (
        <div className="mb-6">
          <EmptyState
            title="No payment methods yet"
            description="Add a Vodafone Cash, InstaPay, or mobile wallet method below so customers can pay offline at checkout."
          />
        </div>
      ) : (
        <div className="grid gap-4 mb-6 max-w-2xl">
          {methods.map((m) => {
            const isValid = validatePayToDetail(m.type as OfflineMethodType, m.payToDetail, country);
            const hint = getPayToDetailHint(m.type as OfflineMethodType, country);
            return (
              <Card key={m.id} className="p-5">
                <ToastForm action={saveOfflineMethodAction} successMessage="Payment method saved" className="grid gap-3">
                  <input type="hidden" name="id" value={m.id} />
                  <input type="hidden" name="type" value={m.type} />
                  <div className="flex items-center justify-between gap-4">
                    <span className="eyebrow text-primary">
                      {METHOD_LABELS[m.type as (typeof ORDER_METHOD_TYPES)[number]] ?? m.type}
                    </span>
                    <ConfirmActionButton
                      action={deleteOfflineMethodAction.bind(null, m.id)}
                      label="Delete"
                      size="sm"
                      variant="ghost"
                      title={`Delete ${m.label}?`}
                      description="Customers will no longer see this option at checkout."
                      successMessage="Payment method deleted"
                    />
                  </div>
                  {!isValid && (
                    <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
                      ⚠️ Current payment detail does not match the required format for {METHOD_LABELS[m.type as (typeof ORDER_METHOD_TYPES)[number]] ?? m.type}. Please update it ({hint}).
                    </div>
                  )}
                  <div className="grid md:grid-cols-2 gap-3">
                    <div className="grid gap-1.5">
                      <Label htmlFor={`label-${m.id}`}>Label</Label>
                      <Input id={`label-${m.id}`} name="label" defaultValue={m.label} required />
                    </div>
                    <div className="grid gap-1.5">
                      <div className="flex items-center justify-between">
                        <Label htmlFor={`payToDetail-${m.id}`}>Pay-to detail</Label>
                        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
                      </div>
                      <Input
                        id={`payToDetail-${m.id}`}
                        name="payToDetail"
                        defaultValue={m.payToDetail ?? ""}
                        placeholder={hint || "Phone number / IBAN / address"}
                      />
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="enabled"
                      value="true"
                      defaultChecked={m.enabled}
                      className="size-4 accent-(--color-primary)"
                    />
                    Show at checkout
                  </label>
                  <div>
                    <SubmitButton size="sm">Save</SubmitButton>
                  </div>
                </ToastForm>
              </Card>
            );
          })}
        </div>
      )}

      <Card className="p-5 max-w-2xl">
        <h2 className="eyebrow text-primary mb-3">Add payment method</h2>
        <ToastForm action={saveOfflineMethodAction} successMessage="Payment method added" className="grid gap-3">
          <div className="grid md:grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="type">Type</Label>
              <select id="type" name="type" defaultValue={ORDER_METHOD_TYPES[0]} className={selectClass}>
                {ORDER_METHOD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {METHOD_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="label">Label</Label>
              <Input id="label" name="label" required placeholder="e.g. Vodafone Cash" />
            </div>
          </div>
          <div className="grid gap-1.5 max-w-sm">
            <Label htmlFor="payToDetail">Pay-to detail</Label>
            <Input id="payToDetail" name="payToDetail" placeholder="Phone number / IBAN / address" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="enabled" value="true" defaultChecked className="size-4 accent-(--color-primary)" />
            Show at checkout
          </label>
          <div>
            <SubmitButton>Add method</SubmitButton>
          </div>
        </ToastForm>
      </Card>
    </>
  );
}
