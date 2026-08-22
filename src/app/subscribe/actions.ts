"use server";
import { headers } from "next/headers";
import { listPlans } from "@/server/subscription";
import { createEnquiry, recentlyEnquired, tooManyFromIp } from "@/server/enquiries/service";
import { clientIp, parseEnquiry, type RawEnquiryFields } from "./enquiry-input";

export type EnquiryState = { ok: boolean; error?: "failed" | "tooSoon" };

/**
 * Takes a paid-plan enquiry from the public pricing flow.
 *
 * A public form that causes an email needs a guard and this codebase has no rate
 * limiter. Three that fail closed: a honeypot field a human never sees, a
 * duplicate check on (email, plan), and a per-IP hourly cap — the honeypot and
 * the email check are both trivially defeated on their own, since a script can
 * omit the hidden field and vary the address at will.
 *
 * A delivery failure is deliberately NOT reported as failure — createEnquiry
 * commits the lead before it tries to send, so the enquiry is captured either
 * way and telling the visitor to try again would only duplicate it.
 *
 * Thin on purpose: every branch it takes is decided by parseEnquiry(), which is
 * pure and unit-tested.
 */
export async function submitEnquiryAction(
  _prev: EnquiryState | null,
  formData: FormData,
): Promise<EnquiryState> {
  const raw: RawEnquiryFields = {
    plan: String(formData.get("plan") ?? ""),
    name: String(formData.get("name") ?? ""),
    businessName: String(formData.get("businessName") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    email: String(formData.get("email") ?? ""),
    locale: String(formData.get("locale") ?? ""),
    company: String(formData.get("company") ?? ""),
  };

  const parsed = parseEnquiry(raw, (await listPlans()).map((p) => p.key));
  if (parsed.kind === "ignore") return { ok: true };
  if (parsed.kind === "invalid") return { ok: false, error: "failed" };
  const { fields } = parsed;

  const h = await headers();
  const ip = clientIp(h.get("x-forwarded-for"), h.get("x-real-ip"));

  if (await tooManyFromIp(ip)) {
    // Same message as a duplicate: the visitor need not learn they tripped a
    // rate limit, and saying so only tells an abuser what to work around. The
    // distinction that matters is for whoever reads the logs.
    console.warn(`[enquiries] per-IP hourly cap reached for ${ip}`);
    return { ok: false, error: "tooSoon" };
  }
  if (await recentlyEnquired(fields.email, fields.planKey)) return { ok: false, error: "tooSoon" };

  await createEnquiry({ ...fields, ip });
  return { ok: true };
}
