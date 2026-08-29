import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { users } from "@/server/auth/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { createCategory, createProduct, updateProduct } from "@/server/catalog/service";
import { getCatalogVersion } from "@/server/catalog/version";
import { setWhatsappNumber, setVatRate } from "@/server/tenancy/settings";
import { tenantSettings } from "@/server/tenancy/schema";
import { GET as getCatalog } from "@/app/api/pos/v1/catalog/route";
import { posDevices, posSyncEventReceipts } from "./schema";

async function seedDeviceTenant(slug: string) {
  const [tenant] = await db.insert(tenants).values({ status: "active", slug, name: "T", country: "EG" }).returning();
  await seedDefaultPlans();
  await startTrial(tenant.id, "basic");
  const [branch] = await withTenant(tenant.id, (tx) => tx.insert(branches).values({ tenantId: tenant.id, name: "Main" }).returning());
  const [user] = await withTenant(tenant.id, (tx) => tx.insert(users).values({ tenantId: tenant.id, name: "Owner" }).returning());
  const token = `${slug}-token`;
  const [device] = await withTenant(tenant.id, (tx) =>
    tx.insert(posDevices).values({ tenantId: tenant.id, branchId: branch.id, token, label: "Till 1", createdByUserId: user.id }).returning(),
  );
  return { tenant, device, token };
}

describe("pos_sync_event_receipts", () => {
  it("rejects a duplicate insert on (deviceId, eventId) — no RLS, reachable with a bare db handle", async () => {
    const { device } = await seedDeviceTenant("sync-receipt");
    const row = {
      deviceId: device.id,
      eventId: "11111111-1111-1111-1111-111111111111",
      type: "shift.opened",
      resultJson: { ok: true },
      occurredAt: new Date(),
    };
    await db.insert(posSyncEventReceipts).values(row);
    await expect(db.insert(posSyncEventReceipts).values(row)).rejects.toThrow();
  });
});

describe("catalog version", () => {
  it("the catalog route returns a numeric catalogVersion that increases after a product update", async () => {
    const { tenant, token } = await seedDeviceTenant("catalog-version");
    const category = await createCategory(tenant.id, { nameEn: "Drinks", nameAr: "مشروبات" });
    const product = await createProduct(tenant.id, { nameEn: "Cola", nameAr: "كولا", basePrice: "10", categoryId: category.id });

    const req1 = new NextRequest("http://localhost/api/pos/v1/catalog", { headers: { authorization: `Bearer ${token}` } });
    const body1 = await (await getCatalog(req1)).json();
    expect(typeof body1.catalogVersion).toBe("number");

    await updateProduct(tenant.id, product.id, { basePrice: "12" });

    const req2 = new NextRequest("http://localhost/api/pos/v1/catalog", { headers: { authorization: `Bearer ${token}` } });
    const body2 = await (await getCatalog(req2)).json();
    expect(body2.catalogVersion).toBeGreaterThan(body1.catalogVersion);
  });

  it("a settings patch that only touches an unrelated key (WhatsApp number) does not bump the version", async () => {
    const { tenant } = await seedDeviceTenant("catalog-version-unrelated");
    const category = await createCategory(tenant.id, { nameEn: "Drinks", nameAr: "مشروبات" });
    await createProduct(tenant.id, { nameEn: "Cola", nameAr: "كولا", basePrice: "10", categoryId: category.id });
    const before = await getCatalogVersion(tenant.id);

    await setWhatsappNumber(tenant.id, "+201234567890");

    expect(await getCatalogVersion(tenant.id)).toBe(before);
  });

  it("a VAT settings change bumps the catalog version", async () => {
    const { tenant } = await seedDeviceTenant("catalog-version-vat");
    const before = await getCatalogVersion(tenant.id);

    await setVatRate(tenant.id, 15);

    expect(await getCatalogVersion(tenant.id)).toBe(before + 1);
  });
});

// Part B fold-in: the till has no other way to learn the branch's cash-
// movement policy, so it rides the catalog response the sync engine already
// pulls on reconnect and on every online tick (Task 10).
describe("catalog route — shift policy", () => {
  it("defaults to no payout threshold and an open close, same as getShiftPolicy", async () => {
    const { token } = await seedDeviceTenant("catalog-shift-policy-default");
    const req = new NextRequest("http://localhost/api/pos/v1/catalog", { headers: { authorization: `Bearer ${token}` } });
    const body = await (await getCatalog(req)).json();
    expect(body.shiftPolicy).toEqual({ blindClose: false, payoutThreshold: 0, varianceThreshold: 0 });
  });

  it("reflects a configured payout threshold and blind close", async () => {
    const { tenant, token } = await seedDeviceTenant("catalog-shift-policy-set");
    await withTenant(tenant.id, (tx) =>
      tx.insert(tenantSettings).values({
        tenantId: tenant.id,
        data: { shiftPolicy: { blindClose: true, payoutThreshold: 500, varianceThreshold: 20 } },
      }),
    );

    const req = new NextRequest("http://localhost/api/pos/v1/catalog", { headers: { authorization: `Bearer ${token}` } });
    const body = await (await getCatalog(req)).json();
    expect(body.shiftPolicy).toEqual({ blindClose: true, payoutThreshold: 500, varianceThreshold: 20 });
  });
});
