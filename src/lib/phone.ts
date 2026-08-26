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
 * national `010|011|012|015` + 8 digits, or international `+20`/`0020`
 * followed by the subscriber number WITHOUT the national leading zero
 * (`1[0125]` + 8 digits). A bare country-code form (`2012…`) is not dialable
 * and is rejected (#187 review).
 */
const EG_PHONE_RE = /^(?:01[0125]|(?:\+20|0020)1[0125])\d{8}$/;

/**
 * Saudi mobile format:
 * national `05` + 8 digits, or international `+966`/`00966` + `5` + 8 digits.
 */
const SA_PHONE_RE = /^(?:05|(?:\+966|00966)5)\d{8}$/;

/**
 * Canonicalises any human-typed phone into `<optional +><ASCII digits>`:
 *  • Arabic-Indic digits (٠-٩ / ۰-۹) → ASCII
 *  • Bidi controls and zero-width marks (routine in RTL pastes) → stripped
 *  • Every other separator (spaces, hyphens, dots, parentheses, slashes) → stripped
 * A single leading "+" survives so international prefixes stay recognisable.
 */
export function normalizePhone(raw: string): string {
  const withoutMarks = raw.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
  const asciiDigits = withoutMarks.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  const plus = /^\s*\+/.test(asciiDigits) ? "+" : "";
  return plus + asciiDigits.replace(/\+/g, "").replace(/\D/g, "");
}

/**
 * Validates a customer phone number according to the tenant's country.
 * Supports Egypt (EG) and Saudi Arabia (SA). The POS walk-in sentinel
 * ("000000000") is accepted ONLY when `allowWalkInSentinel` is set by the
 * till's own path (#173 review). Input is normalised first (#187 review):
 * punctuation, grouping, bidi marks and Arabic-Indic digits all resolve.
 */
export function isValidCustomerPhone(
  phone: string | null | undefined,
  country: CountryCode | null | undefined,
  options?: PhoneValidationOptions,
): boolean {
  if (!phone || typeof phone !== "string") return false;
  const clean = normalizePhone(phone);
  if (!clean || clean === "+") return false;

  // POS walk-in / anonymous sentinel — opt-in only (see PhoneValidationOptions).
  if (clean === "000000000") return options?.allowWalkInSentinel === true;

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
