import { DomainError, type Locale } from "@/shared/errors";

export class QuotaExceededError extends DomainError {
  readonly code = "quota_exceeded";
  constructor(public resource: string, public limit: number, public current: number) {
    super(`Quota exceeded for ${resource} (${current}/${limit})`);
    this.name = "QuotaExceededError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar"
      ? `لقد وصلت إلى الحد الأقصى لـ ${this.resource}. يرجى ترقية باقتك.`
      : `You've reached your ${this.resource} limit. Please upgrade your plan.`;
  }
}

export class FeatureNotAvailableError extends DomainError {
  readonly code = "feature_unavailable";
  constructor(public feature: string) {
    super(`Feature not available: ${feature}`);
    this.name = "FeatureNotAvailableError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar"
      ? `هذه الميزة (${this.feature}) غير متاحة في باقتك الحالية.`
      : `The ${this.feature} feature isn't available on your current plan.`;
  }
}
