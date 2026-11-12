import { DomainError, type Locale } from "@/shared/errors";

export class OrderValidationError extends DomainError {
  readonly code = "order_validation";
  constructor(public readonly detail: string) {
    super(`Order validation failed: ${detail}`);
    this.name = "OrderValidationError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "تعذّر إتمام الطلب، يرجى مراجعة عناصر السلة" : "We couldn't place the order — please review your cart";
  }
}

/**
 * P3/#185: prescription refusals must say what to DO — the generic
 * OrderValidationError copy ("review your cart") names neither prescriptions
 * nor a remedy, which left customers at a dead end (#187 review). The reason
 * also reaches the client as part of a distinct `code` so checkout can react
 * (show the upload field, clear a consumed upload id).
 */
export class PrescriptionRequiredError extends DomainError {
  readonly code = "rx_required";
  constructor(public readonly reason: "sign_in" | "upload" | "reupload") {
    super(`Prescription required: ${reason}`);
    this.name = "PrescriptionRequiredError";
  }
  messageFor(locale: Locale): string {
    switch (this.reason) {
      case "sign_in":
        return locale === "ar"
          ? "سلتك تحتوي على أدوية بوصفة طبية — يرجى تسجيل الدخول أولاً ثم رفع صورة الوصفة"
          : "Your cart contains prescription items — please sign in, then upload a photo of your prescription";
      case "reupload":
        return locale === "ar"
          ? "لم تعد هذه الوصفة صالحة للاستخدام — يرجى رفع صورة جديدة منها والمحاولة مرة أخرى"
          : "That prescription can no longer be used — please upload a new photo of it and try again";
      case "upload":
        return locale === "ar"
          ? "سلتك تحتوي على أدوية بوصفة طبية — يرجى رفع صورة الوصفة لإتمام الطلب"
          : "Your cart contains prescription items — please upload a photo of your prescription to place the order";
    }
  }
}

export class InvalidPhoneError extends DomainError {
  readonly code = "invalid_phone";
  constructor(public readonly country: string) {
    super(`Invalid mobile phone number for country: ${country}`);
    this.name = "InvalidPhoneError";
  }
  messageFor(locale: Locale): string {
    if (this.country === "SA") {
      return locale === "ar"
        ? "يرجى إدخال رقم جوال سعودي صحيح (مثال: 05XXXXXXXX)"
        : "Please enter a valid Saudi mobile number (e.g. 05XXXXXXXX)";
    }
    return locale === "ar"
      ? "يرجى إدخال رقم هاتف مصري صحيح (مثال: 01XXXXXXXXX)"
      : "Please enter a valid Egyptian mobile number (e.g. 01XXXXXXXXX)";
  }
}

export class BranchNotAcceptingOrdersError extends DomainError {
  readonly code = "branch_not_accepting_orders";
  constructor() { super("Branch is not accepting orders"); this.name = "BranchNotAcceptingOrdersError"; }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "هذا الفرع لا يستقبل الطلب حالياً" : "This branch isn't accepting orders right now";
  }
}

export class AreaNotDeliverableError extends DomainError {
  readonly code = "area_not_deliverable";
  constructor() { super("Delivery area not available"); this.name = "AreaNotDeliverableError"; }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "منطقة التوصيل غير متاحة" : "This delivery area isn't available";
  }
}

export class MinimumOrderNotMetError extends DomainError {
  readonly code = "minimum_order_not_met";
  constructor(public readonly minimum: string) { super(`Minimum order is ${minimum}`); this.name = "MinimumOrderNotMetError"; }
  messageFor(locale: Locale): string {
    return locale === "ar" ? `الحد الأدنى للطلب هو ${this.minimum}` : `The minimum order for this area is ${this.minimum}`;
  }
}

export class InvalidTransitionError extends DomainError {
  readonly code = "invalid_transition";
  constructor(public readonly from: string, public readonly to: string) {
    super(`Invalid transition ${from} → ${to}`); this.name = "InvalidTransitionError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar" ? `لا يمكن تغيير الحالة من ${this.from} إلى ${this.to}` : `Can't change status from ${this.from} to ${this.to}`;
  }
}

/**
 * The transition itself is legal — the money isn't. An offline payment still
 * awaiting verification must not hand over goods: the order may enter the
 * kitchen, but ready/out_for_delivery/completed are refused until the payment
 * is resolved in the payments queue (#165). Distinct from InvalidTransitionError
 * so the UI can say "resolve the payment" instead of "impossible move".
 */
export class PaymentNotVerifiedError extends DomainError {
  readonly code = "payment_not_verified";
  constructor(public readonly attemptedStatus: string) {
    super(`Payment unverified — order cannot advance to ${attemptedStatus}`);
    this.name = "PaymentNotVerifiedError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar"
      ? "لم يتم تأكيد الدفع بعد — راجع قائمة المدفوعات قبل تسليم الطلب"
      : "Payment unverified — resolve it in the payments queue before handing over";
  }
}

export class OrderNotFoundError extends DomainError {
  readonly code = "order_not_found";
  constructor() { super("Order not found"); this.name = "OrderNotFoundError"; }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "الطلب غير موجود" : "Order not found";
  }
}

export class InvalidScheduleError extends DomainError {
  readonly code = "invalid_schedule";
  constructor(public readonly detail: "unparseable" | "too_soon" | "too_far" | "closed_at_time") {
    super(`Invalid schedule: ${detail}`);
    this.name = "InvalidScheduleError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar"
      ? "هذا الموعد غير متاح — يرجى اختيار وقت آخر"
      : "That time isn't available — please pick another time";
  }
}

export class OutOfStockError extends DomainError {
  readonly code = "out_of_stock";
  constructor(readonly productNameEn: string, readonly productNameAr: string) {
    super(`Out of stock: ${productNameEn}`);
    this.name = "OutOfStockError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar" ? `"${this.productNameAr}" غير متوفر بالكمية المطلوبة` : `"${this.productNameEn}" doesn't have enough stock`;
  }
}

/**
 * The client displayed a total that does not match what the server computes
 * from live prices. A register must fail loudly rather than quietly charge a
 * different amount, so this aborts the sale.
 */
export class TotalMismatchError extends Error {
  constructor(public readonly expected: number, public readonly actual: number) {
    super(`Total mismatch: client showed ${expected}, server computed ${actual}`);
    this.name = "TotalMismatchError";
  }
}
