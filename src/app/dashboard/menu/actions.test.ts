import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { users } from "@/server/auth/schema";
import { auditEvents } from "@/server/audit/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { createBranch } from "@/server/branches/service";
import { createCategory, createProduct, getProduct, setBranchAvailability } from "@/server/catalog/service";
import { computeEffectivePrice } from "@/server/catalog/pricing";
import type { DashboardContext } from "@/server/auth/dashboard-context";

// Server-action plumbing: the dashboard session, the request headers the
// audit fingerprint reads, and Next's cache/redirect.
const session = vi.hoisted(() => ({ ctx: null as unknown as DashboardContext }));
// Only the session is stubbed: the real authorizeDashboardOrRedirect still
// judges the role, and its redirect lands on the mocked next/navigation below.
vi.mock("@/server/auth/dashboard-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/dashboard-context")>()),
  requireDashboardUser: async () => session.ctx,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath }));
class RedirectSignal extends Error {
  constructor(public readonly url: string) { super(`redirect ${url}`); }
}
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new RedirectSignal(url); } }));

const { createProductAction, updateProductAction } = await import("./products/actions");

async function setup(slug: string, roleKey = "owner") {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG" }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro");
  const [user] = await db.insert(users).values({ tenantId: t.id, name: "Owner" }).returning();
  session.ctx = { tenantId: t.id, user, roleKeys: [roleKey] } as unknown as DashboardContext;
  const cat = await createCategory(t.id, { nameEn: "Pizza", nameAr: "بيتزا" });
  const product = await createProduct(t.id, { nameEn: "Margherita", nameAr: "مارجريتا", basePrice: "100", categoryId: cat.id });
  return { t, cat, product };
}

function productForm(fields: Record<string, string>): FormData {
  const fd = new FormData();
  const base = { nameEn: "Margherita", nameAr: "مارجريتا", basePrice: "100", ...fields };
  for (const [k, v] of Object.entries(base)) fd.set(k, v);
  return fd;
}

async function expectRedirect(p: Promise<unknown>, url: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof RedirectSignal && e.url === url);
}

beforeEach(() => revalidatePath.mockClear());

describe("updateProductAction — promotional pricing (#193)", () => {
  it("saves a percent discount as percent only, redirects, and revalidates the menu", async () => {
    const { t, product } = await setup("dpa1");
    await expectRedirect(
      updateProductAction(product.id, undefined, productForm({ discountActive: "true", discountType: "percent", discountPercent: "25" })),
      `/dashboard/menu/products/${product.id}`,
    );
    const saved = await getProduct(t.id, product.id);
    expect(saved.discountActive).toBe(true);
    expect(saved.discountPercent).toBe(25);
    expect(saved.salePrice).toBeNull();
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/menu");
  });

  it("a percent discount follows a branch price override (base 100, override 150, 25% off -> 112.50)", async () => {
    const { t, product } = await setup("dpa2");
    const branch = await createBranch(t.id, { name: "Main" });
    await setBranchAvailability(t.id, branch.id, product.id, true, 150);
    await expectRedirect(
      updateProductAction(product.id, undefined, productForm({ discountActive: "true", discountType: "percent", discountPercent: "25" })),
      `/dashboard/menu/products/${product.id}`,
    );
    const saved = await getProduct(t.id, product.id);
    const priced = computeEffectivePrice({ ...saved, basePrice: 150 });
    expect(priced.effectivePrice).toBe(112.5);
  });

  it("saves a fixed sale price as sale price only", async () => {
    const { t, product } = await setup("dpa3");
    await expectRedirect(
      updateProductAction(product.id, undefined, productForm({ discountActive: "true", discountType: "sale_price", salePrice: "80" })),
      `/dashboard/menu/products/${product.id}`,
    );
    const saved = await getProduct(t.id, product.id);
    expect(Number(saved.salePrice)).toBe(80);
    expect(saved.discountPercent).toBeNull();
  });

  it("stores the submitted UTC instants unchanged", async () => {
    const { t, product } = await setup("dpa4");
    await expectRedirect(
      updateProductAction(product.id, undefined, productForm({
        discountActive: "true", discountType: "percent", discountPercent: "10",
        // 09:00 in Cairo (UTC+2 in winter), as the browser converts it.
        discountStartsAt: "2026-12-01T07:00:00.000Z", discountEndsAt: "2026-12-05T20:00:00.000Z",
      })),
      `/dashboard/menu/products/${product.id}`,
    );
    const saved = await getProduct(t.id, product.id);
    expect(saved.discountStartsAt?.toISOString()).toBe("2026-12-01T07:00:00.000Z");
    expect(saved.discountEndsAt?.toISOString()).toBe("2026-12-05T20:00:00.000Z");
  });

  it.each([
    ["percent out of range", { discountType: "percent", discountPercent: "150" }],
    ["fractional percent", { discountType: "percent", discountPercent: "12.5" }],
    ["sale price not below base", { discountType: "sale_price", salePrice: "100" }],
    ["end before start", { discountType: "percent", discountPercent: "10", discountStartsAt: "2026-12-05T00:00:00.000Z", discountEndsAt: "2026-12-01T00:00:00.000Z" }],
  ])("returns an error and leaves the existing discount untouched: %s", async (_label, bad) => {
    const { t, product } = await setup(`dpa5-${_label.replace(/\W+/g, "-")}`);
    await expectRedirect(
      updateProductAction(product.id, undefined, productForm({ discountActive: "true", discountType: "percent", discountPercent: "20" })),
      `/dashboard/menu/products/${product.id}`,
    );
    const result = await updateProductAction(product.id, undefined, productForm({ discountActive: "true", nameEn: "Renamed", ...bad }));
    expect(result).toEqual({ error: expect.any(String) });
    const saved = await getProduct(t.id, product.id);
    expect(saved.discountPercent).toBe(20); // not cleared
    expect(saved.nameEn).toBe("Margherita"); // nothing else written either
  });

  it("records an audit event when the discount changes", async () => {
    const { t, product } = await setup("dpa6");
    await expectRedirect(
      updateProductAction(product.id, undefined, productForm({ discountActive: "true", discountType: "percent", discountPercent: "15" })),
      `/dashboard/menu/products/${product.id}`,
    );
    const rows = await withTenant(t.id, (tx) => tx.select().from(auditEvents)
      .where(and(eq(auditEvents.action, "catalog.product.discount_changed"), eq(auditEvents.entityId, product.id))));
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ after: { discountActive: true, discountPercent: 15 } });
  });

  it("refuses a role without menu:manage, and leaves the product untouched", async () => {
    const { t, product } = await setup("dpa7", "staff");
    await expectRedirect(
      updateProductAction(product.id, undefined, productForm({ discountActive: "true", discountType: "percent", discountPercent: "25" })),
      "/dashboard/denied?permission=menu%3Amanage",
    );
    const after = await getProduct(t.id, product.id);
    expect(after?.discountActive).toBe(false);
    expect(after?.discountPercent).toBeNull();
  });
});

describe("createProductAction — promotional pricing (#193)", () => {
  it("creates a product with a discount", async () => {
    const { t, cat } = await setup("dpc1");
    await expectRedirect(
      createProductAction(undefined, productForm({ categoryId: cat.id, nameEn: "Diavola", discountActive: "true", discountType: "percent", discountPercent: "30" })),
      "/dashboard/menu",
    );
    const { listProducts } = await import("@/server/catalog/service");
    const created = (await listProducts(t.id)).find((p) => p.nameEn === "Diavola");
    expect(created?.discountPercent).toBe(30);
  });

  it("returns an error and creates nothing for an invalid discount", async () => {
    const { t, cat } = await setup("dpc2");
    const result = await createProductAction(undefined, productForm({ categoryId: cat.id, nameEn: "Diavola", discountActive: "true", discountType: "percent", discountPercent: "0" }));
    expect(result).toEqual({ error: expect.any(String) });
    const { listProducts } = await import("@/server/catalog/service");
    expect((await listProducts(t.id)).some((p) => p.nameEn === "Diavola")).toBe(false);
  });
});
