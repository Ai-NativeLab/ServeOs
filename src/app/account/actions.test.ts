import { describe, it, expect, vi, beforeEach } from "vitest";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { customers } from "@/server/customers/schema";
import { eq } from "drizzle-orm";
import { customerRegisterAction, customerUpdateProfileAction } from "./actions";

// #187 review: registration and profile were the two write paths that accepted
// any string as a phone — which then prefilled checkout and made every order
// attempt fail. These tests pin the tenant-country validation on both.

const mockState = vi.hoisted(() => ({
  headers: new Map<string, string>(),
  cookies: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
  headers: async () => ({ get: (k: string) => mockState.headers.get(k.toLowerCase()) ?? null }),
  cookies: async () => ({
    get: (k: string) => (mockState.cookies.has(k) ? { name: k, value: mockState.cookies.get(k)! } : undefined),
    set: (k: string, v: string) => { mockState.cookies.set(k, v); },
    delete: (k: string) => { mockState.cookies.delete(k); },
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

async function seedTenant(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "Acct Test", country: "EG", vertical: "restaurant", status: "active" }).returning();
  mockState.headers.set("x-surface", "storefront");
  mockState.headers.set("x-tenant-slug", slug);
  return t.id;
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

describe("customer account phone validation (#187 review)", () => {
  beforeEach(() => {
    mockState.headers.clear();
    mockState.cookies.clear();
  });

  it("registration refuses a junk phone with a hint naming the expected format", async () => {
    await seedTenant("acct-junk");
    const res = await customerRegisterAction(undefined, form({
      name: "C", email: "c@x.com", password: "secret123", phone: "123",
    }));
    expect(res.error).toMatch(/valid mobile number/i);
    expect(res.error).toMatch(/01/); // the EG format hint
  });

  it("registration accepts a formatted EG number and stores it", async () => {
    const tenantId = await seedTenant("acct-ok");
    const res = await customerRegisterAction(undefined, form({
      name: "C", email: "ok@x.com", password: "secret123", phone: "(010) 1234-5678",
    }));
    expect(res.error).toBeUndefined();
    const [row] = await withTenant(tenantId, (tx) =>
      tx.select().from(customers).where(eq(customers.email, "ok@x.com")));
    expect(row?.phone).toBeTruthy();
  });

  it("profile update refuses a junk phone and keeps the stored one", async () => {
    const tenantId = await seedTenant("acct-prof");
    // Register (valid phone) — the action sets the session cookie the profile
    // update authenticates with.
    const reg = await customerRegisterAction(undefined, form({
      name: "C", email: "prof@x.com", password: "secret123", phone: "01012345678",
    }));
    expect(reg.error).toBeUndefined();

    const bad = await customerUpdateProfileAction(undefined, form({ name: "C", phone: "not-a-phone" }));
    expect(bad.error).toMatch(/valid mobile number/i);

    const [row] = await withTenant(tenantId, (tx) =>
      tx.select().from(customers).where(eq(customers.email, "prof@x.com")));
    expect(row?.phone).toBe("01012345678");

    const good = await customerUpdateProfileAction(undefined, form({ name: "C", phone: "01098765432" }));
    expect(good.saved).toBe(true);
  });
});
