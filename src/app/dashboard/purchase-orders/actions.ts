"use server";

import { revalidatePath } from "next/cache";
import { requirePurchasingPermission, resolvePurchasingActor } from "../purchasing-permission";
import { createDraftPo, updateDraftPo, type DraftPoLineInput } from "@/server/purchasing/service";
import type { UnitOfMeasure } from "@/server/catalog/uom";

export type CreatePoLineData = {
  itemId: string;
  qtyOrdered: number;
  uom: UnitOfMeasure;
  unitCost: number;
  taxRate?: number;
};

export type CreatePoData = {
  supplierId: string;
  expectedAt?: string | null;
  lines: CreatePoLineData[];
};

export async function createDraftPoAction(
  data: CreatePoData,
): Promise<{ error: string } | { success: true; poId: string; poNumber: number }> {
  try {
    const ctx = await requirePurchasingPermission("purchasing:manage");
    if (!data.supplierId?.trim()) {
      return { error: "Supplier is required" };
    }
    if (!data.lines || data.lines.length === 0) {
      return { error: "At least one line item is required" };
    }

    for (let i = 0; i < data.lines.length; i++) {
      const line = data.lines[i];
      if (!line.itemId) return { error: `Line ${i + 1}: item is required` };
      if (typeof line.qtyOrdered !== "number" || isNaN(line.qtyOrdered) || line.qtyOrdered <= 0) {
        return { error: `Line ${i + 1}: quantity must be greater than 0` };
      }
      if (typeof line.unitCost !== "number" || isNaN(line.unitCost) || line.unitCost < 0) {
        return { error: `Line ${i + 1}: unit cost must be 0 or greater` };
      }
      if (line.taxRate !== undefined && (isNaN(line.taxRate) || line.taxRate < 0 || line.taxRate > 1)) {
        return { error: `Line ${i + 1}: tax rate must be between 0 and 1 (e.g. 0.14 for 14%)` };
      }
    }

    const actor = await resolvePurchasingActor(ctx);
    const parsedLines: DraftPoLineInput[] = data.lines.map((l) => ({
      itemId: l.itemId,
      qtyOrdered: l.qtyOrdered,
      uom: l.uom,
      unitCost: l.unitCost,
      taxRate: l.taxRate,
    }));

    const result = await createDraftPo(actor, {
      supplierId: data.supplierId,
      branchId: actor.branchId,
      expectedAt: data.expectedAt ? new Date(data.expectedAt) : null,
      lines: parsedLines,
    });

    revalidatePath("/dashboard/purchase-orders");
    return { success: true, poId: result.poId, poNumber: result.poNumber };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to create purchase order" };
  }
}

export async function updateDraftPoAction(
  poId: string,
  data: CreatePoData,
): Promise<{ error: string } | { success: true }> {
  try {
    const ctx = await requirePurchasingPermission("purchasing:manage");
    if (!data.supplierId?.trim()) {
      return { error: "Supplier is required" };
    }
    if (!data.lines || data.lines.length === 0) {
      return { error: "At least one line item is required" };
    }

    for (let i = 0; i < data.lines.length; i++) {
      const line = data.lines[i];
      if (!line.itemId) return { error: `Line ${i + 1}: item is required` };
      if (typeof line.qtyOrdered !== "number" || isNaN(line.qtyOrdered) || line.qtyOrdered <= 0) {
        return { error: `Line ${i + 1}: quantity must be greater than 0` };
      }
      if (typeof line.unitCost !== "number" || isNaN(line.unitCost) || line.unitCost < 0) {
        return { error: `Line ${i + 1}: unit cost must be 0 or greater` };
      }
      if (line.taxRate !== undefined && (isNaN(line.taxRate) || line.taxRate < 0 || line.taxRate > 1)) {
        return { error: `Line ${i + 1}: tax rate must be between 0 and 1 (e.g. 0.14 for 14%)` };
      }
    }

    const actor = await resolvePurchasingActor(ctx);
    const parsedLines: DraftPoLineInput[] = data.lines.map((l) => ({
      itemId: l.itemId,
      qtyOrdered: l.qtyOrdered,
      uom: l.uom,
      unitCost: l.unitCost,
      taxRate: l.taxRate,
    }));

    await updateDraftPo(actor, poId, {
      supplierId: data.supplierId,
      branchId: actor.branchId,
      expectedAt: data.expectedAt ? new Date(data.expectedAt) : null,
      lines: parsedLines,
    });

    revalidatePath("/dashboard/purchase-orders");
    revalidatePath(`/dashboard/purchase-orders/${poId}`);
    return { success: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to update purchase order" };
  }
}
