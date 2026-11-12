import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants, tenantSettings } from "@/server/tenancy/schema";
import { users } from "@/server/auth/schema";
import { auditEvents } from "@/server/audit/schema";
import { UnauthorizedError } from "@/server/rbac/authorize";
import { getCatalogDisplaySettings } from "@/server/tenancy/settings";
import type { DashboardContext } from "@/server/auth/dashboard-context";

const session = vi.hoisted(() => ({ ctx: null as unknown as DashboardContext }));
vi.mock("@/server/auth/dashboard-context", () => ({ requireDashboardUser: async () => session.ctx }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath }));

const { updateCatalogDisplayAction } = await import("./actions");

async function signIn(slug: string, roleKey: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG" }).returning();
  const [user] = await db.insert(users).values({ tenantId: t.id, name: roleKey }).returning();
  session.ctx = { tenantId: t.id, user, roleKeys: [roleKey] } as unknown as DashboardContext;
  return t;
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => revalidatePath.mockClear());

describe("updateCatalogDisplayAction (#195)", () => {
  it.each(["owner", "manager"])("lets a %s save the layout (menu:manage)", async (role) => {
    const t = await signIn(`cda-${role}`, role);
    expect(await updateCatalogDisplayAction(form({ catalogDisplayMode: "paginated", itemsPerPage: "24" }))).toBeUndefined();
    expect(await getCatalogDisplaySettings(t.id)).toEqual({ catalogDisplayMode: "paginated", itemsPerPage: 24 });
  });

  it("refuses staff (no menu:manage) and writes nothing", async () => {
    const t = await signIn("cda-staff", "staff");
    await expect(updateCatalogDisplayAction(form({ catalogDisplayMode: "paginated", itemsPerPage: "24" })))
      .rejects.toBeInstanceOf(UnauthorizedError);
    expect(await getCatalogDisplaySettings(t.id)).toEqual({ catalogDisplayMode: "sections", itemsPerPage: 12 });
  });

  it("persists into tenantSettings.data for the signed-in tenant only", async () => {
    const other = await signIn("cda-other", "owner");
    const t = await signIn("cda-mine", "owner");
    await updateCatalogDisplayAction(form({ catalogDisplayMode: "category_grid" }));
    const [row] = await withTenant(t.id, (tx) => tx.select().from(tenantSettings).where(eq(tenantSettings.tenantId, t.id)));
    expect(row.data).toMatchObject({ catalogDisplayMode: "category_grid" });
    expect(await getCatalogDisplaySettings(other.id)).toEqual({ catalogDisplayMode: "sections", itemsPerPage: 12 });
  });

  it("keeps the stored page size when saving a mode without the picker", async () => {
    const t = await signIn("cda-keep", "owner");
    await updateCatalogDisplayAction(form({ catalogDisplayMode: "paginated", itemsPerPage: "48" }));
    await updateCatalogDisplayAction(form({ catalogDisplayMode: "sections" }));
    expect(await getCatalogDisplaySettings(t.id)).toEqual({ catalogDisplayMode: "sections", itemsPerPage: 48 });
  });

  it.each([["2.5"], ["1000"], ["abc"]])("returns an error for itemsPerPage %s and writes nothing", async (n) => {
    const t = await signIn(`cda-bad-${n.replace(/\W/g, "_")}`, "owner");
    const result = await updateCatalogDisplayAction(form({ catalogDisplayMode: "paginated", itemsPerPage: n }));
    expect(result).toEqual({ error: expect.any(String) });
    expect(await getCatalogDisplaySettings(t.id)).toEqual({ catalogDisplayMode: "sections", itemsPerPage: 12 });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("records an audit event with before/after and revalidates the storefront and dashboard", async () => {
    const t = await signIn("cda-audit", "manager");
    await updateCatalogDisplayAction(form({ catalogDisplayMode: "paginated", itemsPerPage: "24" }));
    const [event] = await withTenant(t.id, (tx) => tx.select().from(auditEvents)
      .where(and(eq(auditEvents.tenantId, t.id), eq(auditEvents.action, "settings.catalog_display_changed"))));
    expect(event.metadata).toMatchObject({
      before: { catalogDisplayMode: "sections", itemsPerPage: 12 },
      after: { catalogDisplayMode: "paginated", itemsPerPage: 24 },
      roleKey: "manager",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/");
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/menu/display");
  });
});
