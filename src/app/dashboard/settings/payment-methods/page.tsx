import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { listOfflineMethods } from "@/server/payments/offline/methods";
import { saveOfflineMethodAction, deleteOfflineMethodAction, ORDER_METHOD_TYPES } from "./actions";
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
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "fulfillment:manage");
  const methods = await listOfflineMethods(ctx.tenantId);

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Payment methods"
        description="Configure the offline pay-to channels customers can choose at checkout. Cash on delivery is always available and isn't configured here."
      />

      {methods.length === 0 ? (
        <EmptyState
          title="No payment methods yet"
          description="Add a Vodafone Cash, InstaPay, or mobile wallet method below so customers can pay offline at checkout."
        />
      ) : (
        <div className="grid gap-4 mb-6 max-w-2xl">
          {methods.map((m) => (
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
                <div className="grid md:grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor={`label-${m.id}`}>Label</Label>
                    <Input id={`label-${m.id}`} name="label" defaultValue={m.label} required />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor={`payToDetail-${m.id}`}>Pay-to detail</Label>
                    <Input
                      id={`payToDetail-${m.id}`}
                      name="payToDetail"
                      defaultValue={m.payToDetail ?? ""}
                      placeholder="Phone number / IBAN / address"
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
          ))}
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
