"use server";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { registerTenant } from "@/server/onboarding";
import { listPlans } from "@/server/subscription";
import { postRegisterHref } from "./plan-redirect";
import type { VerticalId } from "@/server/verticals";
import { createSession } from "@/server/auth/session";
import { SESSION_COOKIE } from "@/server/auth/current-user";
import { recordAuthEvent } from "@/server/audit/auth-events";
import { headersFingerprint } from "@/server/audit/fingerprint";

export async function registerAction(formData: FormData) {
  const vertical = String(formData.get("vertical") || "restaurant");
  const result = await registerTenant({
    restaurantName: String(formData.get("restaurantName")),
    slug: String(formData.get("slug")),
    country: String(formData.get("country")) === "SA" ? "SA" : "EG",
    ownerName: String(formData.get("ownerName")),
    email: String(formData.get("email")),
    password: String(formData.get("password")),
    vertical: vertical as VerticalId,
  });
  const token = await createSession(result.ownerUserId, "dashboard");
  // tenant.registered (genesis) already came from registerTenant; this records the
  // owner's first sign-in.
  await recordAuthEvent(result.tenantId, "auth.login", { actorUserId: result.ownerUserId, fingerprint: headersFingerprint(await headers()) });
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/" });
  // Carried from the pricing flow, so the plan they chose is waiting for them
  // on billing. Nothing is invoiced — that stays an explicit act there.
  const planKey = String(formData.get("plan") || "") || undefined;
  const planExists = planKey ? (await listPlans()).some((p) => p.key === planKey) : false;
  redirect(postRegisterHref(planKey, planExists));
}
