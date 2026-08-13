"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createSession } from "@/server/auth/session";
import { SESSION_COOKIE } from "@/server/auth/current-user";
import { authenticatePlatformAdmin } from "@/server/auth/admin-login";
import { z } from "zod";
import { emailField, loginPasswordField, parseForm } from "@/lib/validation";

const adminLoginSchema = z.object({ email: emailField, password: loginPasswordField });

export async function adminLoginAction(formData: FormData) {
  // Shape only — the policy belongs where a password is chosen, and every
  // failure funnels to the same generic error to avoid enumerating admins.
  const parsed = parseForm(adminLoginSchema, formData);
  if (!parsed.ok) redirect("/admin/login?error=1");
  const { email, password } = parsed.data;

  // Authorization is checked here, before any session exists. Issuing a cookie
  // to someone without `super_admin` produces an account that signs in and is
  // then refused by every /admin page — an endless bounce back to a clean login
  // form, which is how the production outage disguised itself.
  const result = await authenticatePlatformAdmin(email, password);
  if (!result.ok) {
    redirect(result.reason === "not_admin" ? "/admin/login?error=not_admin" : "/admin/login?error=1");
  }

  const token = await createSession(result.user.id, "admin");
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/" });
  redirect("/admin");
}
