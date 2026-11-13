import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users, type User } from "./schema";
import { emailMatches } from "./email";

/**
 * The dashboard login's user lookup: the tenant's member with this email,
 * ignoring case and surrounding spaces. Registration stores the email
 * lowercased (#204), but accounts made before that kept whatever casing was
 * typed, so the comparison lowercases both sides rather than only the input.
 */
export async function findTenantUserByEmail(tenantId: string, email: string): Promise<User | undefined> {
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.tenantId, tenantId), emailMatches(users.email, email)))
    .limit(1);
  return user;
}
