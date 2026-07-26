import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { users } from "@/server/auth/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { auditEvents } from "./schema";
import { verifyChain } from "./verifier";
import type { AuditActorInput } from "./service";
import { createCategory, createProduct, updateProduct, deleteProduct, setBranchAvailability } from "@/server/catalog/service";
import { upsertVariant, setProductStock } from "@/server/catalog/variants";
import { createBranch } from "@/server/branches/service";

async function eventsFor(tenantId: string, action: string) {
  return withTenant(tenantId, (tx) =>
    tx.select().from(auditEvents).where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.action, action))));
}

let n = 0;
async function setup(vertical: "restaurant" | "retail" = "restaurant") {
  const [t] = await db.insert(tenants).values({ slug: `audit-cat-${n++}`, name: "T", country: "EG", vertical }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro");
  const [u] = await db.insert(users).values({ tenantId: t.id, name: "Owner", email: `cat-${n}@x.com`, status: "active" }).returning();
  const audit: AuditActorInput = {
    actorUserId: u.id, actorType: "user", roleKey: "owner",
    fingerprint: { deviceId: null, deviceTokenHash: null, appVersion: null, ip: null, userAgent: null },
  };
  return { tenantId: t.id, audit };
}

describe("audit emission — catalog", () => {
  it("createProduct/deleteProduct emit created/deleted and keep a valid chain", async () => {
    const { tenantId, audit } = await setup();
    const cat = await createCategory(tenantId, { nameEn: "C", nameAr: "ج" }, audit);
    const p = await createProduct(tenantId, { nameEn: "P", nameAr: "ب", basePrice: "10", categoryId: cat.id }, audit);
    await deleteProduct(tenantId, p.id, audit);
    expect(await eventsFor(tenantId, "catalog.product.created")).toHaveLength(1);
    expect(await eventsFor(tenantId, "catalog.product.deleted")).toHaveLength(1);
    expect((await verifyChain(tenantId)).ok).toBe(true);
  });

  it("updateProduct that changes price emits both updated and price_changed", async () => {
    const { tenantId, audit } = await setup();
    const cat = await createCategory(tenantId, { nameEn: "C", nameAr: "ج" }, audit);
    const p = await createProduct(tenantId, { nameEn: "P", nameAr: "ب", basePrice: "10", categoryId: cat.id }, audit);
    await updateProduct(tenantId, p.id, { basePrice: "20" }, audit);
    expect(await eventsFor(tenantId, "catalog.product.updated")).toHaveLength(1);
    const [priceRow] = await eventsFor(tenantId, "catalog.product.price_changed");
    expect(priceRow).toBeDefined();
    expect(priceRow.metadata.before).not.toBe(priceRow.metadata.after);
  });

  it("createCategory records a user actor with roleKey in metadata", async () => {
    const { tenantId, audit } = await setup();
    await createCategory(tenantId, { nameEn: "C", nameAr: "ج" }, audit);
    const [row] = await eventsFor(tenantId, "catalog.category.created");
    expect(row.actorType).toBe("user");
    expect(row.metadata).toMatchObject({ roleKey: "owner" });
  });

  it("setBranchAvailability emits catalog.branch_availability.changed", async () => {
    const { tenantId, audit } = await setup();
    const cat = await createCategory(tenantId, { nameEn: "C", nameAr: "ج" }, audit);
    const p = await createProduct(tenantId, { nameEn: "P", nameAr: "ب", basePrice: "10", categoryId: cat.id }, audit);
    const branch = await createBranch(tenantId, { name: "Main" });
    await setBranchAvailability(tenantId, branch.id, p.id, false, undefined, audit);
    expect(await eventsFor(tenantId, "catalog.branch_availability.changed")).toHaveLength(1);
  });

  it("upsertVariant emits variant.upserted and setProductStock emits stock.set with before/after", async () => {
    const { tenantId, audit } = await setup("retail");
    const cat = await createCategory(tenantId, { nameEn: "C", nameAr: "ج" }, audit);
    const p = await createProduct(tenantId, { nameEn: "P", nameAr: "ب", basePrice: "10", categoryId: cat.id }, audit);
    await upsertVariant(tenantId, p.id, { nameEn: "S", nameAr: "س", price: "12" }, audit);
    expect(await eventsFor(tenantId, "catalog.variant.upserted")).toHaveLength(1);
    await setProductStock(tenantId, p.id, 7, audit);
    const [stockRow] = await eventsFor(tenantId, "catalog.stock.set");
    expect(stockRow.metadata).toMatchObject({ after: 7 });
    expect((await verifyChain(tenantId)).ok).toBe(true);
  });
});
