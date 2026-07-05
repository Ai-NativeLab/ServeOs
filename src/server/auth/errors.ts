import { DomainError, type Locale } from "@/shared/errors";

export class StaffContactTakenError extends DomainError {
  readonly code = "staff_contact_taken";
  constructor(public readonly contact: string) {
    super(`Email or phone already in use: ${contact}`);
    this.name = "StaffContactTakenError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar"
      ? "البريد الإلكتروني أو رقم الهاتف مستخدم بالفعل"
      : "That email or phone is already in use by another account";
  }
}
