import type { RoleKey } from "@/server/rbac";
import { ForbiddenError } from "./errors";

export function assertSuperAdmin(roleKeys: RoleKey[]): void {
  if (!roleKeys.includes("super_admin")) throw new ForbiddenError();
}
