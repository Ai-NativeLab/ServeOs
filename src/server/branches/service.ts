import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { checkQuota } from "@/server/entitlements/service";
import { branches, deliveryAreas, type Branch, type NewBranch, type DeliveryArea, type OpeningHours } from "./schema";
import { BranchNotFoundError } from "./errors";

export type CreateBranchInput = Pick<NewBranch, "name" | "address" | "phone" | "sortOrder">;
export type UpdateBranchInput = Partial<CreateBranchInput>;

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

export async function createBranch(tenantId: string, input: CreateBranchInput): Promise<Branch> {
  const current = await withTenant(tenantId, (tx) =>
    tx.select().from(branches).where(eq(branches.isActive, true)),
  );
  await checkQuota(tenantId, "branches", current.length);
  const [row] = await withTenant(tenantId, (tx) =>
    tx.insert(branches).values({ ...input, tenantId }).returning(),
  );
  return row;
}

export async function updateBranch(tenantId: string, branchId: string, input: UpdateBranchInput): Promise<Branch> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.update(branches).set(input).where(and(eq(branches.id, branchId), eq(branches.tenantId, tenantId))).returning(),
  );
  if (!row) throw new BranchNotFoundError();
  return row;
}

export async function deleteBranch(tenantId: string, branchId: string): Promise<void> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.update(branches).set({ isActive: false }).where(and(eq(branches.id, branchId), eq(branches.tenantId, tenantId))).returning({ id: branches.id }),
  );
  if (!row) throw new BranchNotFoundError();
}

export type UpdateBranchOrderingInput = { acceptingOrders?: boolean; openingHours?: OpeningHours };

export async function updateBranchOrdering(tenantId: string, branchId: string, input: UpdateBranchOrderingInput): Promise<Branch> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.update(branches).set(input).where(and(eq(branches.id, branchId), eq(branches.tenantId, tenantId))).returning(),
  );
  if (!row) throw new BranchNotFoundError();
  return row;
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

export async function createDeliveryArea(tenantId: string, branchId: string, input: CreateDeliveryAreaInput): Promise<DeliveryArea> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.insert(deliveryAreas).values({ ...input, tenantId, branchId }).returning(),
  );
  return row;
}

export async function updateDeliveryArea(tenantId: string, areaId: string, input: UpdateDeliveryAreaInput): Promise<DeliveryArea> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.update(deliveryAreas).set(input).where(and(eq(deliveryAreas.id, areaId), eq(deliveryAreas.tenantId, tenantId))).returning(),
  );
  if (!row) throw new BranchNotFoundError();
  return row;
}

export async function deleteDeliveryArea(tenantId: string, areaId: string): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.delete(deliveryAreas).where(and(eq(deliveryAreas.id, areaId), eq(deliveryAreas.tenantId, tenantId))),
  );
}
