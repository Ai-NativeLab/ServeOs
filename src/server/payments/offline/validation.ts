import type { OfflineMethodType } from "./types";
import { isValidCustomerPhone, normalizePhone } from "@/lib/phone";

/**
 * Vodafone Cash: exactly 11 digits starting with 010.
 */
const VODAFONE_CASH_RE = /^010\d{8}$/;

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
    // isValidCustomerPhone (#187 review): formatted input is the same number,
    // and an Egyptian international prefix (+20 / 0020 / 20) collapses to the
    // national 010… form.
    return VODAFONE_CASH_RE.test((() => {
      const n = normalizePhone(clean).replace(/^\+?(?:0020|20)/, "");
      return n.startsWith("0") ? n : "0" + n;
    })());
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