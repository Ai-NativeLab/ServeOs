"use server";

import { revalidatePath } from "next/cache";
import { requirePurchasingPermission, resolvePurchasingActor } from "../../purchasing-permission";
import { domainErrorValue } from "../../action-errors";
import { sendPurchaseOrder } from "@/server/purchasing/send";
import { cancelPurchaseOrder } from "@/server/purchasing/service";
import { postReceipt, type PostReceiptLineInput } from "@/server/purchasing/receiving";
import { enterInvoiceTotal, closePurchaseOrder } from "@/server/purchasing/variance";
import type { UnitOfMeasure } from "@/server/catalog/uom";

export async function sendPoAction(
  poId: string,
): Promise<{ error: string } | { success: true }> {
  try {
    const ctx = await requirePurchasingPermission("purchasing:manage");
    const actor = await resolvePurchasingActor(ctx);
    await sendPurchaseOrder(actor, poId);

    revalidatePath(`/dashboard/purchase-orders/${poId}`);
    revalidatePath("/dashboard/purchase-orders");
    return { success: true };
  } catch (e) {
    return domainErrorValue(e);
  }
}

export async function cancelPoAction(
  poId: string,
): Promise<{ error: string } | { success: true }> {
  try {
    const ctx = await requirePurchasingPermission("purchasing:manage");
    const actor = await resolvePurchasingActor(ctx);
    await cancelPurchaseOrder(actor, poId);

    revalidatePath(`/dashboard/purchase-orders/${poId}`);
    revalidatePath("/dashboard/purchase-orders");
    return { success: true };
  } catch (e) {
    return domainErrorValue(e);
  }
}

export async function closePoAction(
  poId: string,
): Promise<{ error: string } | { success: true }> {
  try {
    const ctx = await requirePurchasingPermission("purchasing:manage");
    const actor = await resolvePurchasingActor(ctx);
    await closePurchaseOrder(actor, poId);

    revalidatePath(`/dashboard/purchase-orders/${poId}`);
    revalidatePath("/dashboard/purchase-orders");
    return { success: true };
  } catch (e) {
    return domainErrorValue(e);
  }
}

export async function enterInvoiceAction(
  poId: string,
  invoiceTotal: number,
): Promise<{ error: string } | { success: true }> {
  try {
    const ctx = await requirePurchasingPermission("purchasing:manage");
    if (typeof invoiceTotal !== "number" || isNaN(invoiceTotal) || invoiceTotal < 0) {
      return { error: "Invoice total must be a valid non-negative number" };
    }
    const actor = await resolvePurchasingActor(ctx);
    await enterInvoiceTotal(actor, poId, invoiceTotal);

    revalidatePath(`/dashboard/purchase-orders/${poId}`);
    revalidatePath("/dashboard/purchase-orders");
    return { success: true };
  } catch (e) {
    return domainErrorValue(e);
  }
}

export type ReceiveLinePayload = {
  poLineId: string;
  receivedQty: number;
  uom: UnitOfMeasure;
  unitCost: number;
  lotCode?: string;
  expiryAt?: string | null;
};

export async function postReceiptAction(
  poId: string,
  data: {
    supplierDeliveryNote?: string;
    note?: string;
    lines: ReceiveLinePayload[];
  },
): Promise<{ error: string } | { success: true; status: string; receiptId: string }> {
  try {
    const ctx = await requirePurchasingPermission("purchasing:manage");
    if (!data.lines || data.lines.length === 0) {
      return { error: "At least one received line item is required" };
    }

    const validLines = data.lines.filter((l) => l.receivedQty > 0);
    if (validLines.length === 0) {
      return { error: "Enter received quantities greater than 0" };
    }

    const parsedLines: PostReceiptLineInput[] = validLines.map((l) => ({
      poLineId: l.poLineId,
      receivedQty: Number(l.receivedQty),
      uom: l.uom,
      unitCost: Number(l.unitCost),
      lotCode: l.lotCode?.trim() || undefined,
      expiryAt: l.expiryAt && !isNaN(new Date(l.expiryAt).getTime()) ? new Date(l.expiryAt) : null,
    }));

    const actor = await resolvePurchasingActor(ctx);
    const result = await postReceipt(actor, poId, {
      supplierDeliveryNote: data.supplierDeliveryNote?.trim() || undefined,
      note: data.note?.trim() || undefined,
      lines: parsedLines,
    });

    revalidatePath(`/dashboard/purchase-orders/${poId}`);
    revalidatePath("/dashboard/purchase-orders");
    return { success: true, status: result.status, receiptId: result.receiptId };
  } catch (e) {
    return domainErrorValue(e);
  }
}
