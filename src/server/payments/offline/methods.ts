import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { tenantOfflineMethods, type TenantOfflineMethod } from "./methods.schema";
import type { OfflineMethodType } from "./types";

export type OfflineMethodInput = {
  id?: string;
  type: OfflineMethodType;
  label: string;
  payToDetail?: string | null;
  enabled?: boolean;
  sortOrder?: number;
};

export async function listOfflineMethods(tenantId: string): Promise<TenantOfflineMethod[]> {
  return withTenant(tenantId, (tx) =>
    tx.select().from(tenantOfflineMethods).orderBy(tenantOfflineMethods.sortOrder),
  );
}

export async function listEnabledOfflineMethods(tenantId: string): Promise<TenantOfflineMethod[]> {
  return withTenant(tenantId, (tx) =>
    tx.select().from(tenantOfflineMethods).where(eq(tenantOfflineMethods.enabled, true)).orderBy(tenantOfflineMethods.sortOrder),
  );
}

export async function isMethodEnabled(tenantId: string, type: OfflineMethodType): Promise<boolean> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select().from(tenantOfflineMethods).where(and(eq(tenantOfflineMethods.type, type), eq(tenantOfflineMethods.enabled, true))).limit(1),
  );
  return !!row;
}

export async function upsertOfflineMethod(tenantId: string, input: OfflineMethodInput): Promise<TenantOfflineMethod> {
  if (input.id) {
    const [row] = await withTenant(tenantId, (tx) =>
      tx.update(tenantOfflineMethods)
        .set({ type: input.type, label: input.label, payToDetail: input.payToDetail ?? null, enabled: input.enabled ?? true, sortOrder: input.sortOrder ?? 0 })
        .where(eq(tenantOfflineMethods.id, input.id!))
        .returning(),
    );
    if (!row) throw new Error("Offline method not found");
    return row;
  }
  const [row] = await withTenant(tenantId, (tx) =>
    tx.insert(tenantOfflineMethods)
      .values({ tenantId, type: input.type, label: input.label, payToDetail: input.payToDetail ?? null, enabled: input.enabled ?? true, sortOrder: input.sortOrder ?? 0 })
      .onConflictDoUpdate({
        target: [tenantOfflineMethods.tenantId, tenantOfflineMethods.type],
        set: {
          label: input.label,
          payToDetail: input.payToDetail ?? null,
          enabled: input.enabled ?? true,
          sortOrder: input.sortOrder ?? 0,
        },
      })
      .returning(),
  );
  return row;
}

export async function deleteOfflineMethod(tenantId: string, id: string): Promise<void> {
  await withTenant(tenantId, (tx) => tx.delete(tenantOfflineMethods).where(eq(tenantOfflineMethods.id, id)));
}
