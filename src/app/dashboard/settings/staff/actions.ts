"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireStaffPermission } from "../staff-permission";
import { createStaff, setStaffRole, deactivateStaff, type StaffRoleKey } from "@/server/auth/staff";
import { actionAudit } from "@/server/audit/action-context";
import { StaffContactTakenError } from "@/server/auth/errors";
import { nameField, optionalEmailField, optionalPhoneField, parseForm, passwordField } from "@/lib/validation";

const createStaffSchema = z
  .object({
    name: nameField,
    email: optionalEmailField,
    phone: optionalPhoneField,
    password: passwordField,
    roleKey: z.enum(["manager", "staff"]),
  })
  // createStaff enforces this too, but as a raw Error — which ToastForm can
  // only render as "Something went wrong". Neither input is marked required,
  // so leaving both blank is an easy mistake to make.
  .refine((d) => d.email !== undefined || d.phone !== undefined, {
    message: "Give the staff member an email or a phone number.",
    path: ["email"],
  });

export async function createStaffAction(formData: FormData): Promise<{ error: string } | void> {
  const ctx = await requireStaffPermission();
  const parsed = parseForm(createStaffSchema, formData);
  if (!parsed.ok) return { error: parsed.error };

  try {
    await createStaff(ctx.tenantId, parsed.data, await actionAudit(ctx));
  } catch (e) {
    // A DomainError does not survive the RSC boundary as itself, so its
    // message has to be returned rather than rethrown.
    if (e instanceof StaffContactTakenError) return { error: e.messageFor("en") };
    throw e;
  }
  revalidatePath("/dashboard/settings/staff");
}

export async function setStaffRoleAction(userId: string, roleKey: StaffRoleKey) {
  const ctx = await requireStaffPermission();
  await setStaffRole(ctx.tenantId, userId, roleKey, await actionAudit(ctx));
  revalidatePath("/dashboard/settings/staff");
}

export async function deactivateStaffAction(userId: string) {
  const ctx = await requireStaffPermission();
  await deactivateStaff(ctx.tenantId, userId, await actionAudit(ctx));
  revalidatePath("/dashboard/settings/staff");
}
