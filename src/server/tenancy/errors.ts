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

export class InvalidCatalogDisplaySettingsError extends DomainError {
  readonly code = "invalid_catalog_display_settings";
  constructor(public readonly detail: string) {
    super(`Invalid catalog display settings: ${detail}`);
    this.name = "InvalidCatalogDisplaySettingsError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "إعدادات عرض الكتالوج غير صالحة" : "Invalid catalog display settings";
  }
}
