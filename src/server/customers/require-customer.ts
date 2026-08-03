import { cookies } from "next/headers";
import { validateCustomerSession } from "./service";
import type { Customer } from "./schema";

/** Separate lane from the staff cookie (C4) — a customer token can never open
 *  the dashboard, and validateSession's staff lane never sees this cookie. */
export const CUSTOMER_COOKIE = "serveos_customer";

/** The signed-in customer for THIS storefront's tenant, or null. The tenant
 *  always comes from the host header upstream — never from the cookie. */
export async function currentCustomer(tenantId: string): Promise<Customer | null> {
  const token = (await cookies()).get(CUSTOMER_COOKIE)?.value;
  if (!token) return null;
  const session = await validateCustomerSession(tenantId, token);
  return session?.customer ?? null;
}
