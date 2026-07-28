import { headers } from "next/headers";
import type { DashboardContext } from "@/server/auth/dashboard-context";
import { headersFingerprint } from "./fingerprint";
import type { AuditActorInput } from "./service";

/**
 * The audit actor for a dashboard server action: the signed-in user
 * (staff/manager/owner all record as `user`, role in metadata) + a fingerprint
 * derived from the request headers. Pass the result as the service's `audit?` arg.
 */
export async function actionAudit(ctx: DashboardContext): Promise<AuditActorInput> {
  return {
    actorUserId: ctx.user.id,
    actorType: "user",
    roleKey: ctx.roleKeys[0] ?? null,
    fingerprint: headersFingerprint(await headers()),
  };
}
