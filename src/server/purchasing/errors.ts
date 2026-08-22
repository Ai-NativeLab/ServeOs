import { DomainError, type Locale } from "@/shared/errors";
import type { PoStatus } from "./status";

export class InvalidPoTransitionError extends DomainError {
  readonly code = "invalid_po_transition";
  constructor(public from: PoStatus, public to: PoStatus) {
    super(`Illegal PO transition ${from} → ${to}`);
    this.name = "InvalidPoTransitionError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar"
      ? `لا يمكن تغيير حالة أمر الشراء من ${this.from} إلى ${this.to}`
      : `Cannot change purchase order status from ${this.from} to ${this.to}`;
  }
}

export class SupplierEmailMissingError extends DomainError {
  readonly code = "supplier_email_missing";
  constructor(public supplierId: string) {
    super(`Supplier ${supplierId} has no email — add one before sending`);
    this.name = "SupplierEmailMissingError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar"
      ? "المورد ليس لديه بريد إلكتروني — يرجى إضافة بريد قبل الإرسال"
      : "This supplier has no email address — add one before sending";
  }
}

export class PoNotFoundError extends DomainError {
  readonly code = "po_not_found";
  constructor() {
    super("Purchase order not found");
    this.name = "PoNotFoundError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "أمر الشراء غير موجود" : "Purchase order not found";
  }
}

export class InvalidPoInputError extends DomainError {
  readonly code = "invalid_po_input";
  constructor(public detail: string) {
    super(`Invalid purchase input: ${detail}`);
    this.name = "InvalidPoInputError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar" ? `بيانات أمر الشراء غير صالحة: ${this.detail}` : `Invalid purchase input: ${this.detail}`;
  }
}

export class NoBranchError extends DomainError {
  readonly code = "no_branch";
  constructor() {
    super("This tenant has no branch — create a branch before using purchasing");
    this.name = "NoBranchError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar"
      ? "لا يوجد فرع لهذا الحساب — يرجى إنشاء فرع أولاً"
      : "No branch found — please create a branch before using purchasing";
  }
}

export class ReceiptUomMismatchError extends DomainError {
  readonly code = "receipt_uom_mismatch";
  constructor(public poLineId: string, public ordered: string, public got: string) {
    super(`Receipt line for PO line ${poLineId} is in ${got}, but the order line was in ${ordered}`);
    this.name = "ReceiptUomMismatchError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar"
      ? `وحدة قياس الاستلام (${this.got}) تختلف عن وحدة قياس الطلب (${this.ordered})`
      : `Receipt unit (${this.got}) does not match order unit (${this.ordered})`;
  }
}
