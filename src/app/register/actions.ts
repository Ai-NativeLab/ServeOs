"use server";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { registerTenant } from "@/server/onboarding";
import { VERTICAL_IDS } from "@/server/verticals";
import { createSession } from "@/server/auth/session";
import { SESSION_COOKIE } from "@/server/auth/current-user";
import { recordAuthEvent } from "@/server/audit/auth-events";
import { headersFingerprint } from "@/server/audit/fingerprint";
import { emailField, nameField, parseForm, passwordField, slugField } from "@/lib/validation";

export type RegisterState = { error?: string; fieldErrors?: Record<string, string> };

const registerSchema = z.object({
  restaurantName: nameField,
  slug: slugField,
  // Anything else is a tampered form, not a user mistake — the select offers
  // exactly these two. Same for the vertical, which is a hidden input.
  country: z.enum(["EG", "SA"]),
  ownerName: nameField,
  email: emailField,
  password: passwordField,
  vertical: z.enum(VERTICAL_IDS),
});

export async function registerAction(_prev: RegisterState | undefined, formData: FormData): Promise<RegisterState> {
  const parsed = parseForm(registerSchema, formData);
  if (!parsed.ok) return { error: parsed.error, fieldErrors: parsed.fieldErrors };

  let result: Awaited<ReturnType<typeof registerTenant>>;
  try {
    result = await registerTenant(parsed.data);
  } catch (e) {
    // A taken subdomain is the overwhelmingly common failure and it arrives as
    // a unique-violation from Postgres, not as a typed error. Reported against
    // the slug field rather than as a crash, which is what happened before.
    const message = e instanceof Error ? e.message : "";
    if (/duplicate key|unique/i.test(message)) {
      return { error: "That subdomain is already taken.", fieldErrors: { slug: "Already taken." } };
    }
    if (/Default plans not seeded/i.test(message)) {
      return { error: "Sign-up is temporarily unavailable. Please try again shortly." };
    }
    throw e;
  }

  const token = await createSession(result.ownerUserId, "dashboard");
  // tenant.registered (genesis) already came from registerTenant; this records the
  // owner's first sign-in.
  await recordAuthEvent(result.tenantId, "auth.login", { actorUserId: result.ownerUserId, fingerprint: headersFingerprint(await headers()) });
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/" });
  redirect("/dashboard");
}
