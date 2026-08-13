"use server";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { users } from "@/server/auth/schema";
import { getTenantBySlug } from "@/server/tenancy";
import { verifyPassword } from "@/server/auth/password";
import { createSession } from "@/server/auth/session";
import { SESSION_COOKIE } from "@/server/auth/current-user";
import { recordAuthEvent } from "@/server/audit/auth-events";
import { headersFingerprint } from "@/server/audit/fingerprint";
import { emailField, loginPasswordField, parseForm } from "@/lib/validation";

/**
 * Sign-in validates shape, not policy.
 *
 * - loginPasswordField checks presence only. Applying the password rules here
 *   would lock out every account created before the rules existed.
 * - Every failure funnels to the same generic ?error=1. Telling the visitor
 *   which of restaurant / email / password was wrong is account enumeration,
 *   and that was already this form's deliberate design.
 */
const loginSchema = z.object({
  slug: z.string().trim().toLowerCase().min(1),
  email: emailField,
  password: loginPasswordField,
});

export async function loginAction(formData: FormData) {
  const parsed = parseForm(loginSchema, formData);
  if (!parsed.ok) redirect("/login?error=1");
  const { slug, email, password } = parsed.data;

  const tenant = await getTenantBySlug(slug);
  if (!tenant) redirect("/login?error=1");

  // Case-insensitive on the stored side too, not just the submitted side.
  // emailField lowercases what the user typed, but rows written before it did
  // may hold "Owner@Roma.com" — an exact match would strand those accounts.
  // Scoped by tenantId, which is indexed, so this scans one tenant's staff.
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.tenantId, tenant!.id), sql`lower(${users.email}) = ${email}`))
    .limit(1);
  if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
    await recordAuthEvent(tenant!.id, "auth.login_failed", { actorUserId: null, email, fingerprint: headersFingerprint(await headers()) });
    redirect("/login?error=1");
  }
  const token = await createSession(user.id, "dashboard");
  await recordAuthEvent(tenant!.id, "auth.login", { actorUserId: user.id, fingerprint: headersFingerprint(await headers()) });
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/" });
  redirect("/dashboard");
}
