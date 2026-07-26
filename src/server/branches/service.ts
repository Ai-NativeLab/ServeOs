import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { checkQuota } from "@/server/entitlements/service";
import { recordAuditEvent, type AuditActorInput } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { branches, deliveryAreas, type Branch, type NewBranch, type DeliveryArea, type OpeningHours } from "./schema";
import { BranchNotFoundError } from "./errors";

export type CreateBranchInput = Pick<NewBranch, "name" | "address" | "phone" | "sortOrder">;
export type UpdateBranchInput = Partial<CreateBranchInput>;

function auditCtx(tenantId: string, branchId: string | null, audit?: AuditActorInput) {
  return { tenantId, branchId, actorUserId: audit?.actorUserId ?? null, fingerprint: audit?.fingerprint ?? emptyFingerprint() };
}
function auditMeta(audit: AuditActorInput | undefined, extra: Record<string, unknown> = {}) {
  return { roleKey: audit?.roleKey ?? null, ...extra };
}

export async function listBranches(tenantId: string): Promise<Branch[]> {
  return withTenant(tenantId, (tx) =>
    tx.select().from(branches).where(eq(branches.isActive, true)).orderBy(branches.sortOrder),
  );
}

export async function getBranch(tenantId: string, branchId: string): Promise<Branch> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select().from(branches).where(eq(branches.id, branchId)).limit(1),
  );
  if (!row) throw new BranchNotFoundError();
  return row;
}

export async function createBranch(tenantId: string, input: CreateBranchInput, audit?: AuditActorInput): Promise<Branch> {
  const current = await withTenant(tenantId, (tx) =>
    tx.select().from(branches).where(eq(branches.isActive, true)),
  );
  await checkQuota(tenantId, "branches", current.length);
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.insert(branches).values({ ...input, tenantId }).returning();
    await recordAuditEvent(auditCtx(tenantId, row.id, audit), {
      action: "branch.created", entityType: "branch", entityId: row.id,
      summary: `Branch "${row.name}" created`, metadata: auditMeta(audit), actorType: audit?.actorType,
    }, tx);
    return row;
  });
}

export async function updateBranch(tenantId: string, branchId: string, input: UpdateBranchInput, audit?: AuditActorInput): Promise<Branch> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.update(branches).set(input).where(and(eq(branches.id, branchId), eq(branches.tenantId, tenantId))).returning();
    if (!row) throw new BranchNotFoundError();
    await recordAuditEvent(auditCtx(tenantId, branchId, audit), {
      action: "branch.updated", entityType: "branch", entityId: branchId,
      summary: `Branch "${row.name}" updated`, metadata: auditMeta(audit), actorType: audit?.actorType,
    }, tx);
    return row;
  });
}

export async function deleteBranch(tenantId: string, branchId: string, audit?: AuditActorInput): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [row] = await tx.update(branches).set({ isActive: false }).where(and(eq(branches.id, branchId), eq(branches.tenantId, tenantId))).returning({ id: branches.id });
    if (!row) throw new BranchNotFoundError();
    await recordAuditEvent(auditCtx(tenantId, branchId, audit), {
      action: "branch.deleted", entityType: "branch", entityId: branchId,
      summary: `Branch deactivated`, metadata: auditMeta(audit), actorType: audit?.actorType,
    }, tx);
  });
}

export type UpdateBranchOrderingInput = { acceptingOrders?: boolean; openingHours?: OpeningHours };

export async function updateBranchOrdering(tenantId: string, branchId: string, input: UpdateBranchOrderingInput, audit?: AuditActorInput): Promise<Branch> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.update(branches).set(input).where(and(eq(branches.id, branchId), eq(branches.tenantId, tenantId))).returning();
    if (!row) throw new BranchNotFoundError();
    await recordAuditEvent(auditCtx(tenantId, branchId, audit), {
      action: "branch.ordering_changed", entityType: "branch", entityId: branchId,
      summary: `Branch ordering settings changed`,
      metadata: auditMeta(audit, { acceptingOrders: input.acceptingOrders ?? null }), actorType: audit?.actorType,
    }, tx);
    return row;
  });
}

export type CreateDeliveryAreaInput = {
  nameEn: string; nameAr: string; deliveryFee: string; minOrderAmount: string; etaMinutes?: number | null; sortOrder?: number;
};
export type UpdateDeliveryAreaInput = Partial<CreateDeliveryAreaInput & { isActive: boolean }>;

export async function listDeliveryAreas(tenantId: string, branchId: string): Promise<DeliveryArea[]> {
  return withTenant(tenantId, (tx) =>
    tx.select().from(deliveryAreas).where(eq(deliveryAreas.branchId, branchId)).orderBy(deliveryAreas.sortOrder),
  );
}

/** All of a tenant's delivery areas across every branch, in one query (avoids an
 * N+1 when a page needs areas grouped by branch). RLS scopes rows to the tenant. */
export async function listDeliveryAreasForTenant(tenantId: string): Promise<DeliveryArea[]> {
  return withTenant(tenantId, (tx) =>
    tx.select().from(deliveryAreas).orderBy(deliveryAreas.branchId, deliveryAreas.sortOrder),
  );
}

export async function createDeliveryArea(tenantId: string, branchId: string, input: CreateDeliveryAreaInput, audit?: AuditActorInput): Promise<DeliveryArea> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.insert(deliveryAreas).values({ ...input, tenantId, branchId }).returning();
    await recordAuditEvent(auditCtx(tenantId, branchId, audit), {
      action: "branch.delivery_area.created", entityType: "delivery_area", entityId: row.id,
      summary: `Delivery area "${row.nameEn}" created`, metadata: auditMeta(audit, { branchId }), actorType: audit?.actorType,
    }, tx);
    return row;
  });
}

export async function updateDeliveryArea(tenantId: string, areaId: string, input: UpdateDeliveryAreaInput, audit?: AuditActorInput): Promise<DeliveryArea> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.update(deliveryAreas).set(input).where(and(eq(deliveryAreas.id, areaId), eq(deliveryAreas.tenantId, tenantId))).returning();
    if (!row) throw new BranchNotFoundError();
    await recordAuditEvent(auditCtx(tenantId, row.branchId, audit), {
      action: "branch.delivery_area.updated", entityType: "delivery_area", entityId: areaId,
      summary: `Delivery area "${row.nameEn}" updated`, metadata: auditMeta(audit), actorType: audit?.actorType,
    }, tx);
    return row;
  });
}

export async function deleteDeliveryArea(tenantId: string, areaId: string, audit?: AuditActorInput): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.delete(deliveryAreas).where(and(eq(deliveryAreas.id, areaId), eq(deliveryAreas.tenantId, tenantId)));
    await recordAuditEvent(auditCtx(tenantId, null, audit), {
      action: "branch.delivery_area.deleted", entityType: "delivery_area", entityId: areaId,
      summary: `Delivery area deleted`, metadata: auditMeta(audit), actorType: audit?.actorType,
    }, tx);
  });
}
