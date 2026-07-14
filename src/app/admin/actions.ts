"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { invalidateSession } from "@/server/auth";
import { SESSION_COOKIE } from "@/server/auth/current-user";

export async function adminSignOutAction() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await invalidateSession(token);
  jar.delete(SESSION_COOKIE);
  redirect("/admin/login");
}
