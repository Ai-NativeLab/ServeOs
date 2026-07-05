import { Plus } from "lucide-react";
import { requireFulfillmentPermission } from "../fulfillment-permission";
import { listBranches, listDeliveryAreasForTenant } from "@/server/branches/service";
import { getVatRate } from "@/server/tenancy/settings";
import { setAcceptingOrdersAction, setOpeningHoursAction, addAreaAction, deleteAreaAction, setVatAction } from "./actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { ConfirmActionButton } from "@/components/dashboard/ConfirmActionButton";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default async function FulfillmentPage() {
  const { tenantId } = await requireFulfillmentPermission();
  const [branches, vatRate, allAreas] = await Promise.all([
    listBranches(tenantId),
    getVatRate(tenantId),
    listDeliveryAreasForTenant(tenantId),
  ]);
  const areasByBranch = allAreas.reduce<Record<string, typeof allAreas>>((acc, a) => {
    (acc[a.branchId] ??= []).push(a);
    return acc;
  }, {});

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Ordering settings"
        description="VAT, opening hours, and delivery areas per branch."
      />

      <Card className="p-5 max-w-2xl mb-6">
        <h2 className="eyebrow text-primary mb-3">VAT</h2>
        <ToastForm action={setVatAction} successMessage="VAT rate saved" className="flex items-end gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor="vatRate">Rate (%)</Label>
            <Input id="vatRate" name="vatRate" type="number" step="0.1" min="0" defaultValue={vatRate} className="w-28" />
          </div>
          <SubmitButton variant="outline">Save</SubmitButton>
        </ToastForm>
      </Card>

      <div className="space-y-6">
        {branches.map((b) => {
          const hours = b.openingHours ?? [];
          const byDay = (d: number) => hours.find((h) => h.day === d);
          return (
            <Card key={b.id} className="p-5">
              <div className="flex items-center justify-between gap-3 mb-4">
                <h2 className="font-display text-lg font-bold text-ink">{b.name}</h2>
                <ToastForm
                  action={setAcceptingOrdersAction.bind(null, b.id, !b.acceptingOrders)}
                  successMessage={b.acceptingOrders ? "Orders paused" : "You're live — accepting orders"}
                >
                  <SubmitButton variant={b.acceptingOrders ? "outline" : "default"}>
                    <span className={`size-2 rounded-full ${b.acceptingOrders ? "bg-status-ready" : "bg-status-danger"}`} />
                    {b.acceptingOrders ? "Accepting orders — pause" : "Paused — go live"}
                  </SubmitButton>
                </ToastForm>
              </div>

              <Tabs defaultValue="hours">
                <TabsList>
                  <TabsTrigger value="hours">Hours</TabsTrigger>
                  <TabsTrigger value="areas">Delivery areas</TabsTrigger>
                </TabsList>

                <TabsContent value="hours" className="pt-3">
                  <ToastForm action={setOpeningHoursAction.bind(null, b.id)} successMessage="Hours saved">
                    <div className="grid gap-1.5">
                      {DAYS.map((name, d) => {
                        const e = byDay(d);
                        return (
                          <div key={d} className="flex items-center gap-3 text-sm">
                            <span className="eyebrow w-10">{name}</span>
                            <label className="flex items-center gap-1.5 w-20">
                              <input type="checkbox" name={`closed-${d}`} defaultChecked={e?.closed ?? false} className="size-4 accent-(--color-primary)" /> Closed
                            </label>
                            <Input type="time" name={`open-${d}`} defaultValue={e?.open ?? "10:00"} className="w-28 font-mono" />
                            <span className="text-muted-foreground">–</span>
                            <Input type="time" name={`close-${d}`} defaultValue={e?.close ?? "23:00"} className="w-28 font-mono" />
                          </div>
                        );
                      })}
                    </div>
                    <SubmitButton variant="outline" className="mt-3">Save hours</SubmitButton>
                  </ToastForm>
                </TabsContent>

                <TabsContent value="areas" className="pt-3">
                  <ul className="divide-y text-sm mb-3">
                    {(areasByBranch[b.id] ?? []).map((a) => (
                      <li key={a.id} className="py-2 flex items-center justify-between gap-2">
                        <span>
                          {a.nameEn}
                          <span className="text-muted-foreground"> — fee <span className="font-mono">{Number(a.deliveryFee).toFixed(2)}</span> · min <span className="font-mono">{Number(a.minOrderAmount).toFixed(2)}</span>{a.etaMinutes ? ` · ${a.etaMinutes}m` : ""}</span>
                        </span>
                        <ConfirmActionButton
                          action={deleteAreaAction.bind(null, a.id)}
                          label="Delete"
                          size="sm"
                          variant="ghost"
                          title={`Delete "${a.nameEn}"?`}
                          description="Customers in this area will no longer see delivery for this branch."
                          successMessage="Area deleted"
                        />
                      </li>
                    ))}
                    {(areasByBranch[b.id] ?? []).length === 0 && (
                      <li className="py-2 text-muted-foreground">No delivery areas yet — add one below.</li>
                    )}
                  </ul>
                  <ToastForm action={addAreaAction.bind(null, b.id)} successMessage="Area added" className="flex flex-wrap items-end gap-2">
                    <Input name="nameEn" placeholder="Area (EN)" required className="w-36" />
                    <Input name="nameAr" placeholder="Area (AR)" dir="rtl" required className="w-36" />
                    <Input name="deliveryFee" type="number" step="0.01" placeholder="Fee" className="w-24" />
                    <Input name="minOrderAmount" type="number" step="0.01" placeholder="Min order" className="w-28" />
                    <Input name="etaMinutes" type="number" placeholder="ETA (min)" className="w-24" />
                    <SubmitButton variant="outline" size="sm"><Plus className="size-4" />Add area</SubmitButton>
                  </ToastForm>
                </TabsContent>
              </Tabs>
            </Card>
          );
        })}
      </div>
    </>
  );
}
