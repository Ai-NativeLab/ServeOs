import { DomainError, type Locale } from "@/shared/errors";

export class InvalidWhatsappNumberError extends DomainError {
  readonly code = "invalid_whatsapp_number";
  constructor(public readonly value: string) {
    super(`Invalid WhatsApp number: ${value}`);
    this.name = "InvalidWhatsappNumberError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar"
      ? "رقم واتساب غير صالح — استخدم الصيغة الدولية، مثال: ‎+201234567890"
      : "Invalid WhatsApp number — use international format, e.g. +201234567890";
  }
}
