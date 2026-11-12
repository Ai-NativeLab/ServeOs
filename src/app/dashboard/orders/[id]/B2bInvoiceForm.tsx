import { ToastForm } from "@/components/dashboard/ToastForm";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requestB2bInvoiceAction } from "./fiscal-actions";

/**
 * "Issue B2B tax invoice" — the buyer capture for one order.
 *
 * A SERVER component inside `ToastForm`, mirroring the fiscal config screen's
 * forms rather than the `RefundForm` sibling next door. RefundForm is a client
 * component because it composes lines and tenders and has to keep them in
 * balance while the operator types; this form has no derived state at all —
 * seven boxes, one submit — so a plain `<form action>` is the smaller, more
 * accessible shape, and the toast/error handling is `ToastForm`'s job either way.
 *
 * SEVEN MANDATORY FIELDS, and they are marked `required` here purely so the
 * browser catches an empty box before the round trip. The authority is
 * `requestB2bInvoice`'s zod, which is what a curl or a stale page hits; its
 * refusal comes back as an error toast naming the field.
 *
 * WHY THE BUYER IS TYPED IN AT ALL: ServeOS stores nothing about a customer's
 * tax identity, and invoice v1.0 makes the receiver Mandatory for a business
 * buyer. There is nothing to prefill from.
 *
 * FOUR OPTIONAL ADDRESS FIELDS ARE DELIBERATELY NOT OFFERED HERE — `floor`,
 * `room`, `landmark` and `additionalInformation` — while `postalCode` is. The
 * SERVICE accepts all five (`buyerSchema` carries them for the same reason the
 * seller's address does: a field the form cannot set is a field the tenant
 * cannot comply with), so the API and a future richer form can send them and
 * they reach the wire verbatim. The difference is that the seller's address is
 * typed ONCE at setup, where eleven boxes are proportionate, whereas this form
 * is filled per sale with a customer waiting — so it offers the five Mandatory
 * components plus the one optional field an Egyptian business address is
 * routinely written with, and leaves the rest to the API rather than making
 * every operator scroll past four boxes they will not use.
 */
export function B2bInvoiceForm({ orderId }: { orderId: string }) {
  return (
    <Card className="p-5 mt-4">
      <h2 className="eyebrow text-primary mb-1">Issue B2B tax invoice</h2>
      <p className="text-xs text-muted-foreground mb-3">
        Files an ETA e-invoice for this sale under the buyer&apos;s own registration number. Unlike a receipt it carries
        no QR — ETA assigns the invoice its number, which appears in the fiscal dashboard once accepted.
      </p>

      <ToastForm
        action={requestB2bInvoiceAction.bind(null, orderId)}
        successMessage="Tax invoice queued for ETA"
        className="grid gap-4"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            name="buyerRin"
            label="Buyer registration number (TRN)"
            placeholder="200173707"
            hint="Exactly 9 digits, as registered with ETA."
            required
          />
          <Field name="buyerName" label="Registered name" required />
        </div>

        <p className="text-sm font-medium mt-1">Buyer address</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field name="buyerAddrCountry" label="Country" placeholder="EG" required />
          <Field name="buyerAddrGovernate" label="Governate" required />
          <Field name="buyerAddrRegionCity" label="Region / city" required />
          <Field name="buyerAddrStreet" label="Street" required />
          <Field name="buyerAddrBuildingNumber" label="Building number" required />
          <Field name="buyerAddrPostalCode" label="Postal code" />
        </div>

        <div><SubmitButton>Issue tax invoice</SubmitButton></div>
      </ToastForm>
    </Card>
  );
}

/** The same field shape the fiscal config screen uses — kept local rather than
 *  shared, because that one is a private helper on a page and hoisting it into
 *  `components/` for a second caller is a bigger change than a nine-line copy. */
function Field({
  name, label, hint, placeholder, required,
}: {
  name: string;
  label: string;
  hint?: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} placeholder={placeholder} required={required} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
