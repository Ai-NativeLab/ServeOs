import { DomainError, type Locale } from "@/shared/errors";

export class PaymentAlreadyResolvedError extends DomainError {
  readonly code = "payment_already_resolved";
  constructor() { super("Payment already resolved"); this.name = "PaymentAlreadyResolvedError"; }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "تم حسم هذه الدفعة بالفعل" : "This payment has already been resolved";
  }
}

export class InvalidProofError extends DomainError {
  readonly code = "invalid_proof";
  constructor() { super("A payment reference is required"); this.name = "InvalidProofError"; }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "الرجاء إدخال رقم مرجع الدفعة" : "Please enter your payment reference";
  }
}

export class PaymentMethodNotEnabledError extends DomainError {
  readonly code = "payment_method_not_enabled";
  constructor(readonly method: string) { super(`Method not enabled: ${method}`); this.name = "PaymentMethodNotEnabledError"; }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "طريقة الدفع غير متاحة" : "That payment method isn't available";
  }
}
