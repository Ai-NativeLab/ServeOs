"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { registerTenant } from "@/server/onboarding";
import type { VerticalId } from "@/server/verticals";
import { createSession } from "@/server/auth/session";
import { SESSION_COOKIE } from "@/server/auth/current-user";

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
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/" });
  redirect("/dashboard");
}
