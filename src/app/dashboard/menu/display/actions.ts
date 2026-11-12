"use server";
import { revalidatePath } from "next/cache";
import { requireMenuPermission } from "../../menu-permission";
import { setCatalogDisplaySettings } from "@/server/tenancy/settings";
import { actionAudit } from "@/server/audit/action-context";
import { domainErrorValue } from "../../action-errors";
import { parseCatalogDisplayFormData } from "./display-form";

/** menu:manage, like the page that renders it: managers run the catalog, so
 *  they choose how it is laid out. Returns { error } for ToastForm. */
export async function updateCatalogDisplayAction(formData: FormData): Promise<void | { error: string }> {
  const ctx = await requireMenuPermission();
  const parsed = parseCatalogDisplayFormData(formData);
  if (!parsed.ok) return { error: parsed.error };
  try {
    await setCatalogDisplaySettings(ctx.tenantId, parsed.value, await actionAudit(ctx));
  } catch (e) {
    return domainErrorValue(e);
  }
  revalidatePath("/dashboard/menu/display");
  revalidatePath("/dashboard/menu");
  revalidatePath("/dashboard/settings/profile");
  revalidatePath("/");
}
