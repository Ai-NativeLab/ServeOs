"use server";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/server/auth/schema";
import { getTenantBySlug } from "@/server/tenancy";
import { verifyPassword } from "@/server/auth/password";
import { createSession } from "@/server/auth/session";
import { SESSION_COOKIE } from "@/server/auth/current-user";
import { recordAuthEvent } from "@/server/audit/auth-events";
import { headersFingerprint } from "@/server/audit/fingerprint";

export async function loginAction(formData: FormData) {
  const slug = String(formData.get("slug")).trim().toLowerCase();
  const email = String(formData.get("email"));
  const password = String(formData.get("password"));

  const tenant = await getTenantBySlug(slug);
  if (!tenant) redirect("/login?error=1");

  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.tenantId, tenant!.id), eq(users.email, email)))
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
