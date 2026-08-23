import type { Locale } from "@/shared/errors";

/**
 * Field ceilings.
 *
 * The action previously only trimmed and checked non-empty, so one unauthenticated
 * request could write megabytes into the table and into the sales email. These are
 * generous for real Egyptian business names and E.164 numbers with punctuation;
 * 254 is the RFC 5321 maximum for an address.
 */
export const FIELD_LIMITS = { name: 120, businessName: 160, phone: 40, email: 254 } as const;

/**
 * Deliberately permissive: this exists to reject input the provider will refuse,
 * not to adjudicate what a valid address looks like. A malformed address made
 * Resend reject the whole send, which left the lead sitting `unsent` even though
 * the visitor was told it had gone through.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export type RawEnquiryFields = {
  plan?: string;
  name?: string;
  businessName?: string;
  phone?: string;
  email?: string;
  locale?: string;
  /** The honeypot. Hidden from people, irresistible to bots. */
  company?: string;
};

export type EnquiryFields = {
  planKey: string;
  name: string;
  businessName: string;
  phone: string;
  email: string;
  locale: Locale;
};

export type ParsedEnquiry =
  /** Honeypot tripped: answer as though it worked, write nothing. */
  | { kind: "ignore" }
  | { kind: "invalid" }
  | { kind: "ok"; fields: EnquiryFields };

/**
 * Everything the enquiry action decides before it touches the database.
 *
 * Pure, and separated from the action for the same reason subscribeDestination()
 * was separated from the page: these branches are the entire security surface of
 * a public endpoint that causes email, and a server action can only be exercised
 * through a browser.
 */
export function parseEnquiry(
  raw: RawEnquiryFields,
  knownPlanKeys: readonly string[],
): ParsedEnquiry {
  if (String(raw.company ?? "").trim()) return { kind: "ignore" };

  const planKey = String(raw.plan ?? "");
  // Never trust the key from the form — it decides what we tell sales.
  if (!knownPlanKeys.includes(planKey)) return { kind: "invalid" };

  const name = String(raw.name ?? "").trim();
  const businessName = String(raw.businessName ?? "").trim();
  const phone = String(raw.phone ?? "").trim();
  const email = String(raw.email ?? "").trim();

  if (!name || !businessName || !phone || !email) return { kind: "invalid" };
  if (name.length > FIELD_LIMITS.name) return { kind: "invalid" };
  if (businessName.length > FIELD_LIMITS.businessName) return { kind: "invalid" };
  if (phone.length > FIELD_LIMITS.phone) return { kind: "invalid" };
  if (email.length > FIELD_LIMITS.email) return { kind: "invalid" };
  if (!EMAIL_RE.test(email)) return { kind: "invalid" };

  const locale: Locale = raw.locale === "en" ? "en" : "ar";
  return { kind: "ok", fields: { planKey, name, businessName, phone, email, locale } };
}

/**
 * The submitter's address, for the per-IP cap.
 *
 * x-forwarded-for is a list appended to by each hop; the first entry is the
 * client as the closest trusted proxy saw it. Returns null rather than a
 * guess when no header is present — an unattributable row is simply not
 * rate-limited, which is better than capping everyone behind one bad key.
 */
export function clientIp(forwardedFor: string | null, realIp: string | null): string | null {
  const first = (forwardedFor ?? "").split(",")[0]?.trim();
  if (first) return first;
  const direct = (realIp ?? "").trim();
  return direct || null;
}
