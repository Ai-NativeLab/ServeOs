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
