"use server";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { invalidateSession } from "@/server/auth";
import { validateSession } from "@/server/auth/session";
import { SESSION_COOKIE } from "@/server/auth/current-user";
import { recordAuthEvent } from "@/server/audit/auth-events";
import { headersFingerprint } from "@/server/audit/fingerprint";

export async function signOutAction() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    // Resolve the actor before invalidating so auth.logout names the user.
    const session = await validateSession(token);
    if (session?.user.tenantId) {
      await recordAuthEvent(session.user.tenantId, "auth.logout", { actorUserId: session.user.id, fingerprint: headersFingerprint(await headers()) });
    }
    await invalidateSession(token);
  }
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}
