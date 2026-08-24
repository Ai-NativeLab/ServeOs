export type CountryCode = "EG" | "SA" | string;

export type PhoneValidationOptions = {
  /**
   * Accept the POS walk-in sentinel ("000000000"). POS-ONLY: the till sells to
   * anonymous customers, but a storefront/WhatsApp buyer submitting all-zeros
   * is precisely the unreachable order #173 closes — so web surfaces must never
   * pass this flag.
   */
  allowWalkInSentinel?: boolean;
};

/**
 * Egyptian mobile format:
 * 010, 011, 012, 015 followed by 8 digits (11 digits total).
 * Accepts international prefix (+20, 0020, 20).
 */
const EG_PHONE_RE = /^(?:\+20|0020|20)?0?1([0125]\d{8})$/;

/**
 * Saudi mobile format:
 * 05 followed by 8 digits (10 digits total).
 * Accepts international prefix (+966, 00966, 966).
 */
const SA_PHONE_RE = /^(?:\+966|00966|966)?0?5(\d{8})$/;

/**
 * Validates a customer phone number according to the tenant's country.
 * Supports Egypt (EG) and Saudi Arabia (SA). The POS walk-in sentinel
 * ("000000000") is accepted ONLY when `allowWalkInSentinel` is set by the
 * till's own path (#173 review).
 */
export function isValidCustomerPhone(
  phone: string | null | undefined,
  country: CountryCode | null | undefined,
  options?: PhoneValidationOptions,
): boolean {
  if (!phone || typeof phone !== "string") return false;
  const clean = phone.trim().replace(/[\s-]/g, "");
  if (!clean) return false;

  // POS walk-in / anonymous sentinel — opt-in only (see PhoneValidationOptions).
  if (clean === "000000000") return options?.allowWalkInSentinel === true;

  if (country === "SA") {
    return SA_PHONE_RE.test(clean);
  }

  if (country === "SA") {
    return SA_PHONE_RE.test(clean);
  }

  // Default to Egypt
  return EG_PHONE_RE.test(clean);
}

/**
 * Returns localized format helper text for the customer phone input.
 */
export function getPhoneFormatHint(country: CountryCode | null | undefined, locale: "en" | "ar" = "en"): string {
  if (country === "SA") {
    return locale === "ar"
      ? "مثال: 05XXXXXXXX"
      : "e.g. 05XXXXXXXX";
  }
  return locale === "ar"
    ? "مثال: 01XXXXXXXXX"
    : "e.g. 01XXXXXXXXX";
}
