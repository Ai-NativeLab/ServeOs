import { DomainError, type Locale } from "@/shared/errors";

export class CapabilityNotEnabledError extends DomainError {
  readonly code = "capability_not_enabled";
  constructor(readonly capability: string) {
    super(`Capability not enabled: ${capability}`);
    this.name = "CapabilityNotEnabledError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "هذه الميزة غير متاحة لنوع نشاطك" : "This feature is not available for your business type";
  }
}
