"use server";
import { headers, cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { getTenantBySlug, isTenantServable } from "@/server/tenancy";
import { isValidCustomerPhone, getPhoneFormatHint } from "@/lib/phone";
import {
  registerCustomer, authenticateCustomer, createCustomerSession,
  invalidateCustomerSession, CustomerAuthError,
} from "@/server/customers/service";
import { CUSTOMER_COOKIE, currentCustomer } from "@/server/customers/require-customer";
import { withTenant } from "@/db/with-tenant";
import { customers } from "@/server/customers/schema";
import { eq, and } from "drizzle-orm";

/** Tenant always resolves from the storefront host — never from a form field. */
async function storefrontTenant() {
  const h = await headers();
  if (h.get("x-surface") !== "storefront") return null;
  const slug = h.get("x-tenant-slug");
  if (!slug) return null;
  const tenant = await getTenantBySlug(slug);
  return tenant && isTenantServable(tenant) ? tenant : null;
}

async function storefrontTenantId(): Promise<string | null> {
  return (await storefrontTenant())?.id ?? null;
}

/** Phone validation against the tenant's country, with a localized hint (#187 review). */
async function validateCustomerPhone(phone: string): Promise<string | null> {
  const tenant = await storefrontTenant();
  if (!isValidCustomerPhone(phone, tenant?.country)) {
    return `Please enter a valid mobile number (${getPhoneFormatHint(tenant?.country)}).`;
  }
  return null;
}

async function setSessionCookie(token: string): Promise<void> {
  (await cookies()).set(CUSTOMER_COOKIE, token, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
    path: "/", maxAge: 30 * 24 * 60 * 60,
  });
}

export async function customerRegisterAction(
  _prev: { error?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string }> {
  const tenantId = await storefrontTenantId();
  if (!tenantId) return { error: "This page only works on a shop's own site." };
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const phone = String(formData.get("phone") ?? "").trim();
  if (!name || !email) return { error: "Name and email are required." };
  if (password.length < 8) return { error: "Password must be at least 8 characters." };
  if (phone) {
    const phoneError = await validateCustomerPhone(phone);
    if (phoneError) return { error: phoneError };
  }

  try {
    const customer = await registerCustomer(tenantId, { name, email, password, phone: phone || undefined });
    const h = await headers();
    await setSessionCookie(await createCustomerSession(tenantId, customer.id, h.get("user-agent") ?? undefined));
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Registration failed." };
  }
  revalidatePath("/account");
  return {};
}

export async function customerLoginAction(
  _prev: { error?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string }> {
  const tenantId = await storefrontTenantId();
  if (!tenantId) return { error: "This page only works on a shop's own site." };
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  try {
    const customer = await authenticateCustomer(tenantId, email, password);
    const h = await headers();
    await setSessionCookie(await createCustomerSession(tenantId, customer.id, h.get("user-agent") ?? undefined));
  } catch (e) {
    if (e instanceof CustomerAuthError) return { error: e.message };
    throw e;
  }
  revalidatePath("/account");
  return {};
}

export async function customerSignOutAction(): Promise<void> {
  const tenantId = await storefrontTenantId();
  const jar = await cookies();
  const token = jar.get(CUSTOMER_COOKIE)?.value;
  if (tenantId && token) await invalidateCustomerSession(tenantId, token);
  jar.delete(CUSTOMER_COOKIE);
  revalidatePath("/account");
}

export async function customerUpdateProfileAction(
  _prev: { error?: string; saved?: boolean } | undefined,
  formData: FormData,
): Promise<{ error?: string; saved?: boolean }> {
  const tenantId = await storefrontTenantId();
  if (!tenantId) return { error: "This page only works on a shop's own site." };
  const me = await currentCustomer(tenantId);
  if (!me) return { error: "Please sign in first." };

  const name = String(formData.get("name") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const defaultAddressText = String(formData.get("defaultAddressText") ?? "").trim();
  if (!name) return { error: "Name is required." };
  if (phone) {
    const phoneError = await validateCustomerPhone(phone);
    if (phoneError) return { error: phoneError };
  }

  await withTenant(tenantId, (tx) => tx.update(customers)
    .set({ name, phone: phone || null, defaultAddressText: defaultAddressText || null })
    .where(and(eq(customers.id, me.id), eq(customers.tenantId, tenantId))));
  revalidatePath("/account");
  return { saved: true };
}
