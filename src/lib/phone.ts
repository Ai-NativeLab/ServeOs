export type CountryCode = "EG" | "SA" | string;

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
 * Supports Egypt (EG) and Saudi Arabia (SA), and recognizes the POS walk-in sentinel ("000000000").
 */
export function isValidCustomerPhone(phone: string | null | undefined, country: CountryCode | null | undefined): boolean {
  if (!phone || typeof phone !== "string") return false;
  const clean = phone.trim().replace(/[\s-]/g, "");
  if (!clean) return false;

  // POS walk-in / anonymous sentinel
  if (clean === "000000000") return true;

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
