import type { OfflineMethodType } from "./types";
import { isValidCustomerPhone, normalizePhone } from "@/lib/phone";

/**
 * Vodafone Cash: a Vodafone Egypt mobile (010…) in any dialable form the
 * customer-phone rule accepts — national 010XXXXXXXX, or +20 / 0020 followed
 * by 10XXXXXXXX. The bare country-code (2010…) and zero-less (10…) forms are
 * refused, exactly as EG_PHONE_RE refuses them (#187 review).
 */
const VODAFONE_CASH_RE = /^(?:010|(?:\+20|0020)10)\d{8}$/;

/**
 * InstaPay: handle (@instapay / @ipa or general handle e.g. user@domain) or mobile number (01[0125]XXXXXXXX).
 */
const INSTAPAY_HANDLE_RE = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+$/;

export function validatePayToDetail(
  type: OfflineMethodType,
  payToDetail: string | null | undefined,
  country: string = "EG"
): boolean {
  if (type === "cash") {
    return true;
  }

  if (!payToDetail || typeof payToDetail !== "string") {
    return false;
  }

  const clean = payToDetail.trim();
  if (!clean) return false;

  if (type === "vodafone_cash") {
    // Same normalisation the mobile_wallet branch gets via
    // isValidCustomerPhone: formatted input is the same number.
    return VODAFONE_CASH_RE.test(normalizePhone(clean));
  }

  if (type === "mobile_wallet") {
    return isValidCustomerPhone(clean, country);
  }

  if (type === "instapay") {
    if (INSTAPAY_HANDLE_RE.test(clean)) return true;
    if (isValidCustomerPhone(clean, country)) return true;
    return false;
  }

  if (type === "bank") {
    return clean.length >= 4;
  }

  return true;
}

export function getPayToDetailHint(
  type: OfflineMethodType,
  country: string = "EG",
  locale: "en" | "ar" = "en"
): string {
  switch (type) {
    case "vodafone_cash":
      return locale === "ar" ? "رقم فودافون كاش (مثال: 010XXXXXXXX)" : "Vodafone Cash number (e.g. 010XXXXXXXX)";
    case "mobile_wallet":
      return country === "SA"
        ? locale === "ar" ? "رقم الجوال (مثال: 05XXXXXXXX)" : "Mobile number (e.g. 05XXXXXXXX)"
        : locale === "ar" ? "رقم المحفظة (مثال: 01XXXXXXXXX)" : "Wallet mobile number (e.g. 01XXXXXXXXX)";
    case "instapay":
      return locale === "ar" ? "عنوان إنستاباي أو رقم هاتف (مثال: username@instapay)" : "InstaPay address or phone (e.g. username@instapay)";
    case "bank":
      return locale === "ar" ? "رقم الحساب أو الآيبان" : "Account number or IBAN";
    default:
      return "";
  }
}