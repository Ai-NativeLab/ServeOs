"use server";
import { revalidatePath } from "next/cache";
import { requireRxReviewPermission } from "../rx-permission";
import { actionAudit } from "@/server/audit/action-context";
import { reviewPrescription } from "@/server/prescriptions/service";

export async function reviewPrescriptionAction(
  _prev: { error?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string }> {
  const ctx = await requireRxReviewPermission();
  const prescriptionId = String(formData.get("prescriptionId") ?? "");
  const approved = formData.get("approved") === "true";
  const reason = String(formData.get("reason") ?? "").trim();

  try {
    await reviewPrescription(
      ctx.tenantId, prescriptionId,
      { approved, reason: reason || undefined },
      await actionAudit(ctx),
    );
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not record the review." };
  }
  revalidatePath("/dashboard/prescriptions");
  return {};
}
