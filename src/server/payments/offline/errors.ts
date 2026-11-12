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

export class InvalidPayToDetailError extends DomainError {
  readonly code = "invalid_pay_to_detail";
  constructor(readonly methodType: string, readonly requirement: string = "") {
    super(`Invalid pay-to detail for ${methodType}${requirement ? `: ${requirement}` : ""}`);
    this.name = "InvalidPayToDetailError";
  }
  messageFor(locale: Locale): string {
    if (this.methodType === "vodafone_cash") {
      return locale === "ar"
        ? "يرجى إدخال رقم فودافون كاش مصري صحيح مكون من 11 رقم يبدأ بـ 010 (مثال: 01012345678)"
        : "Please enter a valid 11-digit Vodafone Cash number starting with 010 (e.g. 01012345678)";
    }
    if (this.methodType === "mobile_wallet") {
      return locale === "ar"
        ? "يرجى إدخال رقم محفظة إلكترونية صحيح"
        : "Please enter a valid mobile wallet number";
    }
    if (this.methodType === "instapay") {
      return locale === "ar"
        ? "يرجى إدخال عنوان إنستاباي صحيح (مثال: username@instapay أو رقم هاتف)"
        : "Please enter a valid InstaPay address (e.g. username@instapay or phone number)";
    }
    return locale === "ar" ? "بيانات الدفع غير صحيحة" : "Invalid payment details";
  }
}
