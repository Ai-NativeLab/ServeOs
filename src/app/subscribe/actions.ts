"use server";
import { listPlans } from "@/server/subscription";
import { createEnquiry, recentlyEnquired } from "@/server/enquiries/service";

export type EnquiryState = { ok: boolean; error?: "failed" | "tooSoon" };

/**
 * Takes a paid-plan enquiry from the public pricing flow.
 *
 * A public form that causes an email needs a guard and this codebase has no
 * rate limiter. Two cheap ones that fail closed: a honeypot field a human never
 * sees, and a throttle read off the enquiries table itself.
 *
 * A delivery failure is deliberately NOT reported as failure — createEnquiry
 * commits the lead before it tries to send, so the enquiry is captured either
 * way and telling the visitor to try again would only duplicate it.
 */
export async function submitEnquiryAction(
  _prev: EnquiryState | null,
  formData: FormData,
): Promise<EnquiryState> {
  // Bots fill every field; this one is hidden from people.
  if (String(formData.get("company") || "")) return { ok: true };

  const planKey = String(formData.get("plan") || "");
  const name = String(formData.get("name") || "").trim();
  const businessName = String(formData.get("businessName") || "").trim();
  const phone = String(formData.get("phone") || "").trim();
  const email = String(formData.get("email") || "").trim();
  const locale = String(formData.get("locale") || "en") === "ar" ? "ar" : "en";

  if (!name || !businessName || !phone || !email) return { ok: false, error: "failed" };

  // Never trust the key from the form — it decides what we tell sales.
  const plans = await listPlans();
  if (!plans.some((p) => p.key === planKey)) return { ok: false, error: "failed" };

  if (await recentlyEnquired(email)) return { ok: false, error: "tooSoon" };

  await createEnquiry({ planKey, name, businessName, phone, email, locale });
  return { ok: true };
}
