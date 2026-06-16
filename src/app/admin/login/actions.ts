"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isNull, eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/server/auth/schema";
import { verifyPassword } from "@/server/auth/password";
import { createSession } from "@/server/auth/session";
import { SESSION_COOKIE } from "@/server/auth/current-user";

export async function adminLoginAction(formData: FormData) {
  const email = String(formData.get("email"));
  const password = String(formData.get("password"));

  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.email, email), isNull(users.tenantId)))
    .limit(1);

  if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
    redirect("/admin/login?error=1");
  }

  const token = await createSession(user.id, "admin");
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/" });
  redirect("/admin");
}
