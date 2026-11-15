"use server";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { registerTenant, RegistrationError } from "@/server/onboarding";
import { listPlans } from "@/server/subscription";
import { isFreePrice } from "@/shared/plans";
import { postRegisterHref } from "./plan-redirect";
import { parseRegistration, SLUG_ERROR_MESSAGES, type RegisterState } from "./registration-form";
import { createSession } from "@/server/auth/session";
import { SESSION_COOKIE } from "@/server/auth/current-user";
import { recordAuthEvent } from "@/server/audit/auth-events";
import { headersFingerprint } from "@/server/audit/fingerprint";

/**
 * Anything the visitor can fix comes back as RegisterState for the form to
 * show beside the field (#204). Only a genuine fault is thrown — a throw here
 * is Next's "This page couldn't load" with the form wiped.
 */
export async function registerAction(_prev: RegisterState | null, formData: FormData): Promise<RegisterState> {
  const parsed = parseRegistration(formData);
  if (!parsed.ok) return parsed.state;

  let result: Awaited<ReturnType<typeof registerTenant>>;
  try {
    result = await registerTenant(parsed.input);
  } catch (err) {
    if (err instanceof RegistrationError) {
      return { values: parsed.values, errors: { [err.field]: SLUG_ERROR_MESSAGES[err.code] } };
    }
    throw err;
  }

  const token = await createSession(result.ownerUserId, "dashboard");
  // tenant.registered (genesis) already came from registerTenant; this records the
  // owner's first sign-in.
  await recordAuthEvent(result.tenantId, "auth.login", { actorUserId: result.ownerUserId, fingerprint: headersFingerprint(await headers()) });
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/" });
  // Carried from the pricing flow, so the plan they chose is waiting for them
  // on billing. Nothing is invoiced — that stays an explicit act there.
  const planKey = String(formData.get("plan") || "") || undefined;
  const chosen = planKey ? (await listPlans()).find((p) => p.key === planKey) : undefined;
  redirect(postRegisterHref({
    planKey,
    planExists: Boolean(chosen),
    planIsFree: Boolean(chosen && isFreePrice(chosen.priceMonthly)),
  }));
}
