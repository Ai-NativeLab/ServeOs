"use server";
import { headers, cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { getTenantBySlug, isTenantServable } from "@/server/tenancy";
import {
  registerCustomer, authenticateCustomer, createCustomerSession,
  invalidateCustomerSession, CustomerAuthError,
} from "@/server/customers/service";
import { CUSTOMER_COOKIE, currentCustomer } from "@/server/customers/require-customer";
import { withTenant } from "@/db/with-tenant";
import { customers } from "@/server/customers/schema";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import {
  emailField,
  loginPasswordField,
  nameField,
  optionalPhoneField,
  parseForm,
  passwordField,
  shortText,
} from "@/lib/validation";

const customerRegisterSchema = z.object({
  name: nameField,
  email: emailField,
  password: passwordField,
  phone: optionalPhoneField,
});

/** Shape only — see loginPasswordField on why the policy never runs at sign-in. */
const customerLoginSchema = z.object({ email: emailField, password: loginPasswordField });

const customerProfileSchema = z.object({
  name: nameField,
  phone: optionalPhoneField,
  // A delivery address, not an essay. Uncapped before this.
  defaultAddressText: shortText(500),
});

/** Tenant always resolves from the storefront host — never from a form field. */
async function storefrontTenantId(): Promise<string | null> {
  const h = await headers();
  if (h.get("x-surface") !== "storefront") return null;
  const slug = h.get("x-tenant-slug");
  if (!slug) return null;
  const tenant = await getTenantBySlug(slug);
  return tenant && isTenantServable(tenant) ? tenant.id : null;
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
  const parsed = parseForm(customerRegisterSchema, formData);
  if (!parsed.ok) return { error: parsed.error };
  const { name, email, password, phone } = parsed.data;

  try {
    const customer = await registerCustomer(tenantId, { name, email, password, phone });
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
  const parsed = parseForm(customerLoginSchema, formData);
  if (!parsed.ok) return { error: "Invalid email or password." };
  const { email, password } = parsed.data;

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

  const parsed = parseForm(customerProfileSchema, formData);
  if (!parsed.ok) return { error: parsed.error };
  const { name, phone, defaultAddressText } = parsed.data;

  await withTenant(tenantId, (tx) => tx.update(customers)
    .set({ name, phone: phone ?? null, defaultAddressText: defaultAddressText || null })
    .where(and(eq(customers.id, me.id), eq(customers.tenantId, tenantId))));
  revalidatePath("/account");
  return { saved: true };
}
