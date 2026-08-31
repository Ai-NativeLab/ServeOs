"use server";
import { revalidatePath } from "next/cache";
import { requireFiscalPermission } from "../../fiscal-permission";
import { actionAudit } from "@/server/audit/action-context";
import {
  FiscalConfigInputError,
  requestB2bInvoice,
  type RequestB2bInvoiceBuyer,
} from "@/server/fiscal/config-service";

/**
 * The order screen's B2B tax-invoice trigger.
 *
 * PERMISSION: `requireFiscalPermission` (owner-only `fiscal:manage`), NOT the
 * page's own `orders:*`. Same split `refund-actions.ts` makes with `pos:refund`
 * — the order detail page hosts actions from several domains and each one is
 * gated by its own permission rather than by the page's.
 *
 * ONE IMPLEMENTATION, TWO CALLERS. Everything that matters — the buyer zod, the
 * tenant-ownership check, the already-invoiced ladder, the audit event and the
 * best-effort finalize — is `requestB2bInvoice`'s, shared verbatim with
 * `api/dashboard/fiscal/orders/[id]/invoice`. This action is the form shape of
 * it and nothing else. (The `resubmit.ts` precedent needed a module of its own
 * only because `enqueueCorrectedResubmission` emits no audit event; this service
 * function does, so there is nothing left to duplicate.)
 *
 * RETURNS `{ error }` rather than throwing, for both refusal families: a thrown
 * `FiscalConfigInputError` does not survive the RSC boundary (the class is lost
 * and production redacts the message), and the 404/409 outcomes are already
 * values. See `dashboard/fiscal/actions.ts`'s header for the rule.
 */
export async function requestB2bInvoiceAction(
  orderId: string,
  formData: FormData,
): Promise<void | { error: string }> {
  const ctx = await requireFiscalPermission();
  const text = (name: string): string => String(formData.get(name) ?? "").trim();
  /** A blank optional address box is stored as absent rather than as "". */
  const optional = (name: string): string | undefined => text(name) || undefined;

  const buyer: RequestB2bInvoiceBuyer = {
    rin: text("buyerRin"),
    name: text("buyerName"),
    address: {
      country: text("buyerAddrCountry"),
      governate: text("buyerAddrGovernate"),
      regionCity: text("buyerAddrRegionCity"),
      street: text("buyerAddrStreet"),
      buildingNumber: text("buyerAddrBuildingNumber"),
      postalCode: optional("buyerAddrPostalCode"),
    },
  };

  try {
    const outcome = await requestB2bInvoice(ctx.tenantId, orderId, buyer, await actionAudit(ctx));
    if (!outcome.ok) return { error: outcome.error };
  } catch (e) {
    if (e instanceof FiscalConfigInputError) return { error: e.message };
    throw e;
  }
  revalidatePath(`/dashboard/orders/${orderId}`);
}
