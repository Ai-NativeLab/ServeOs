import { DomainError, type Locale } from "@/shared/errors";

/** Thrown when a tenant tries to start a new plan invoice while one is still
 * open or pending_verification — prevents an admin from later confirming an
 * out-of-order invoice and mis-setting the plan. */
export class OutstandingInvoiceExistsError extends DomainError {
  readonly code = "outstanding_invoice_exists";
  constructor() {
    super("Tenant already has an outstanding invoice");
    this.name = "OutstandingInvoiceExistsError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar"
      ? "لديك بالفعل دفعة معلّقة بانتظار التأكيد"
      : "You already have a pending payment awaiting confirmation";
  }
}
