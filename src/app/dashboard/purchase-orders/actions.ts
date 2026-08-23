"use server";

import { revalidatePath } from "next/cache";
import { requirePurchasingPermission, resolvePurchasingActor } from "../purchasing-permission";
import { domainErrorValue } from "../action-errors";
import { createDraftPo, updateDraftPo, type DraftPoLineInput } from "@/server/purchasing/service";
import { roundQty, QTY_SCALE } from "@/server/inventory/uom";
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

function validatePoData(data: CreatePoData): string | null {
  if (!data.supplierId?.trim()) {
    return "Supplier is required";
  }
  if (!data.lines || data.lines.length === 0) {
    return "At least one line item is required";
  }

  for (let i = 0; i < data.lines.length; i++) {
    const line = data.lines[i];
    if (!line.itemId) return `Line ${i + 1}: item is required`;
    // `Number.isFinite`, not `isNaN`: `isNaN(Infinity)` is false, so Infinity
    // walked past this layer and surfaced as a thrown domain error from
    // assertLineNumbers instead of the friendly per-line message. Kept in step
    // with the service floor and with the two supplier-cost guards.
    if (typeof line.qtyOrdered !== "number" || !Number.isFinite(line.qtyOrdered) || line.qtyOrdered <= 0) {
      return `Line ${i + 1}: quantity must be greater than 0`;
    }
    if (roundQty(line.qtyOrdered) <= 0) {
      return `Line ${i + 1}: quantity must be at least ${1 / 10 ** QTY_SCALE}`;
    }
    if (typeof line.unitCost !== "number" || !Number.isFinite(line.unitCost) || line.unitCost < 0) {
      return `Line ${i + 1}: unit cost must be 0 or greater`;
    }
    if (line.taxRate !== undefined && (!Number.isFinite(line.taxRate) || line.taxRate < 0 || line.taxRate > 1)) {
      return `Line ${i + 1}: tax rate must be between 0 and 1 (e.g. 0.14 for 14%)`;
    }
  }
  return null;
}

function parseExpectedDate(dateStr?: string | null): Date | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

export async function createDraftPoAction(
  data: CreatePoData,
): Promise<{ error: string } | { success: true; poId: string; poNumber: number }> {
  try {
    const ctx = await requirePurchasingPermission("purchasing:manage");
    const valError = validatePoData(data);
    if (valError) return { error: valError };

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
      expectedAt: parseExpectedDate(data.expectedAt),
      lines: parsedLines,
    });

    revalidatePath("/dashboard/purchase-orders");
    return { success: true, poId: result.poId, poNumber: result.poNumber };
  } catch (e) {
    return domainErrorValue(e);
  }
}

export async function updateDraftPoAction(
  poId: string,
  data: CreatePoData,
): Promise<{ error: string } | { success: true }> {
  try {
    const ctx = await requirePurchasingPermission("purchasing:manage");
    const valError = validatePoData(data);
    if (valError) return { error: valError };

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
      expectedAt: parseExpectedDate(data.expectedAt),
      lines: parsedLines,
    });

    revalidatePath("/dashboard/purchase-orders");
    revalidatePath(`/dashboard/purchase-orders/${poId}`);
    return { success: true };
  } catch (e) {
    return domainErrorValue(e);
  }
}
