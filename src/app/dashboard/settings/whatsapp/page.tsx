import { requireFulfillmentPermission } from "../fulfillment-permission";
import { getWhatsappNumber } from "@/server/tenancy/settings";
import { whatsappChatLink, buildOrderWhatsappMessage } from "@/lib/whatsapp";
import { setWhatsappNumberAction } from "./actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default async function WhatsAppSettingsPage() {
  const { tenantId } = await requireFulfillmentPermission();
  const number = await getWhatsappNumber(tenantId);
  const previewLink = number
    ? whatsappChatLink(
        number,
        buildOrderWhatsappMessage({
          orderNumber: 1024, fulfillmentType: "pickup",
          items: [{ quantity: 2, nameEn: "Margherita" }], total: "178.00",
        }),
      )
    : null;

  return (
    <>
      <PageHeader
        title="WhatsApp"
        description="Customers get a pre-filled WhatsApp message to send you after checkout."
      />
      <Card className="p-5 max-w-lg">
        <ToastForm action={setWhatsappNumberAction} successMessage="WhatsApp number saved" className="space-y-3">
          <div className="grid gap-1.5">
            <Label htmlFor="whatsappNumber">WhatsApp number</Label>
            <Input
              id="whatsappNumber" name="whatsappNumber" placeholder="+201234567890"
              defaultValue={number ?? ""} className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              International format — e.g. +20 for Egypt, +966 for Saudi Arabia. Leave blank to disable.
            </p>
          </div>
          <SubmitButton>Save</SubmitButton>
        </ToastForm>
        {previewLink && (
          <a
            href={previewLink} target="_blank" rel="noopener noreferrer"
            className="mt-4 inline-block text-sm text-primary underline"
          >
            Send test message →
          </a>
        )}
      </Card>
    </>
  );
}
