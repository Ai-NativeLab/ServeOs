"use server";
import { revalidatePath } from "next/cache";
import { requireFiscalPermission } from "../fiscal-permission";
import { actionAudit } from "@/server/audit/action-context";
import {
  FiscalConfigInputError,
  updateFiscalConfig,
  upsertDeviceCredential,
  type UpdateFiscalConfigInput,
  type UpsertDeviceCredentialInput,
} from "@/server/fiscal/config-service";
import type { EtaWireContextConfig, EtaFeeLineConfig, EtaCodeSource } from "@/server/fiscal/schema";
import { requestResubmission } from "./resubmit";

const PATH = "/dashboard/fiscal";

/**
 * Server actions for the fiscal config screen.
 *
 * A thrown `FiscalConfigInputError` does not survive the RSC boundary (the
 * class is lost and production redacts the message), so each action RETURNS
 * `{ error }` for it — the same rule `domainErrorValue` documents for
 * `DomainError`, applied to this service's one input error. Anything else
 * rethrows to the error boundary: those are bugs, not operator feedback.
 *
 * WRITE-ONLY REFERENCE FIELDS. A blank `*Ref` input means "leave whatever is
 * stored" (the form cannot show a reference, so a blank box is not a request to
 * erase one) and is sent as `undefined`. Clearing the e-seal reference is a
 * deliberate, separate checkbox that sends `null`, because that is a real state
 * a receipt-only tenant wants and the blank-means-keep rule would otherwise make
 * unreachable.
 */

const text = (form: FormData, name: string): string => String(form.get(name) ?? "").trim();

/** A blank reference box is "keep what is stored", never "erase it". */
const ref = (form: FormData, name: string): string | undefined => text(form, name) || undefined;

/** A blank optional text field is stored as absent rather than as "". */
const optional = (form: FormData, name: string): string | undefined => text(form, name) || undefined;

/** One fee line, or `undefined` when the operator left the block empty. Keyed
 *  off the item code because that is the field ETA cannot do without. */
function feeLine(form: FormData, prefix: string): EtaFeeLineConfig | undefined {
  if (!text(form, `${prefix}ItemCode`)) return undefined;
  return {
    itemCode: text(form, `${prefix}ItemCode`),
    codeSource: (text(form, `${prefix}CodeSource`) || "gs1") as EtaCodeSource,
    taxType: text(form, `${prefix}TaxType`),
    // Empty means "this tax genuinely has no sub-type", which the column models
    // as null rather than "".
    taxSubType: text(form, `${prefix}TaxSubType`) || null,
    unitType: text(form, `${prefix}UnitType`),
    description: text(form, `${prefix}Description`),
    internalCode: text(form, `${prefix}InternalCode`),
  };
}

function wireContextFrom(form: FormData): EtaWireContextConfig {
  const serviceCharge = feeLine(form, "feeServiceCharge");
  const delivery = feeLine(form, "feeDelivery");
  return {
    sellerName: text(form, "sellerName"),
    activityCode: text(form, "activityCode"),
    branchCode: text(form, "branchCode"),
    branchAddress: {
      country: text(form, "addrCountry"),
      governate: text(form, "addrGovernate"),
      regionCity: text(form, "addrRegionCity"),
      street: text(form, "addrStreet"),
      buildingNumber: text(form, "addrBuildingNumber"),
      postalCode: optional(form, "addrPostalCode"),
      floor: optional(form, "addrFloor"),
      room: optional(form, "addrRoom"),
      landmark: optional(form, "addrLandmark"),
      additionalInformation: optional(form, "addrAdditionalInformation"),
    },
    syndicateLicenseNumber: optional(form, "syndicateLicenseNumber"),
    ...(serviceCharge || delivery ? { feeLines: { serviceCharge, delivery } } : {}),
    buyerIdThreshold: optional(form, "buyerIdThreshold"),
  };
}

export async function saveFiscalConfigAction(formData: FormData): Promise<void | { error: string }> {
  const ctx = await requireFiscalPermission();
  const input: UpdateFiscalConfigInput = {
    rin: text(formData, "rin"),
    clientId: text(formData, "clientId"),
    clientSecretRef: ref(formData, "clientSecretRef"),
    // Explicit clear beats blank-means-clear: see this file's header.
    signingKeyRef: formData.get("clearSigningKey") === "true" ? null : ref(formData, "signingKeyRef"),
    environment: text(formData, "environment") as UpdateFiscalConfigInput["environment"],
    activationStatus: text(formData, "activationStatus") as UpdateFiscalConfigInput["activationStatus"],
    onlineDeviceId: text(formData, "onlineDeviceId") || null,
    wireContext: wireContextFrom(formData),
  };

  try {
    await updateFiscalConfig(ctx.tenantId, input, await actionAudit(ctx));
  } catch (e) {
    if (e instanceof FiscalConfigInputError) return { error: e.message };
    throw e;
  }
  revalidatePath(PATH);
}

export async function saveDeviceCredentialAction(formData: FormData): Promise<void | { error: string }> {
  const ctx = await requireFiscalPermission();
  const deviceId = text(formData, "deviceId");
  const status = text(formData, "status");
  const input: UpsertDeviceCredentialInput = {
    etaSerial: text(formData, "etaSerial"),
    clientId: text(formData, "deviceClientId"),
    clientSecret1Ref: ref(formData, "clientSecret1Ref"),
    clientSecret2Ref: ref(formData, "clientSecret2Ref"),
    presharedKeyRef: ref(formData, "presharedKeyRef"),
    posOsVersion: optional(formData, "posOsVersion") ?? null,
    posModelFramework: optional(formData, "posModelFramework") ?? null,
    ...(status ? { status: status as UpsertDeviceCredentialInput["status"] } : {}),
  };

  try {
    await upsertDeviceCredential(ctx.tenantId, deviceId, input, await actionAudit(ctx));
  } catch (e) {
    if (e instanceof FiscalConfigInputError) return { error: e.message };
    throw e;
  }
  revalidatePath(PATH);
}

/** Queues a correction for a rejected document. The audit event that names who
 *  asked for it is emitted by `requestResubmission`, which the API route shares
 *  — see that module for why the two callers must not each emit their own. */
export async function resubmitAction(formData: FormData): Promise<void | { error: string }> {
  const ctx = await requireFiscalPermission();
  const outcome = await requestResubmission(ctx, text(formData, "submissionId"));
  if (!outcome.ok) return { error: outcome.error };
  revalidatePath(PATH);
}
