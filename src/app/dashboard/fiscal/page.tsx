import { requireFiscalPermission } from "../fiscal-permission";
import { UnauthorizedError } from "@/server/rbac/authorize";
import { getTenantById } from "@/server/tenancy";
import {
  getFiscalConfig,
  listDeviceCredentials,
  listFiscalDevices,
  listProductTaxCodes,
} from "@/server/fiscal/config-service";
import { listSubmissions, getSubmissionStatusCounts } from "@/server/fiscal/read-model";
import {
  etaActivationStatusEnum,
  etaCodeSourceEnum,
  etaEnvironmentEnum,
  etaPosCredentialStatusEnum,
  type EtaFeeLineConfig,
} from "@/server/fiscal/schema";
import {
  saveFiscalConfigAction,
  saveDeviceCredentialAction,
  saveProductTaxCodeAction,
  resubmitAction,
} from "./actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FiscalCredentialsTable } from "@/components/dashboard/FiscalCredentialsTable";
import { FiscalSubmissionsTable } from "@/components/dashboard/FiscalSubmissionsTable";
import { FiscalTaxCodesTable } from "@/components/dashboard/FiscalTaxCodesTable";

const selectCls = "rounded-md border bg-background px-3 py-1.5 text-sm h-9";

/** One page of the submission feed. Passed to the table too, so the "showing
 *  the N most recent" line cannot drift from the query that produced them. */
const SUBMISSIONS_PAGE_SIZE = 25;

function Field({
  name, label, defaultValue, hint, placeholder, required,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  hint?: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} defaultValue={defaultValue ?? ""} placeholder={placeholder} required={required} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * A credential REFERENCE input. Write-only by design: the stored value is never
 * sent to the browser, so the box is always blank and a blank box means "keep
 * what is stored". The `configured` chip is the only feedback there can be —
 * and it is OMITTED where the page cannot honestly answer the question (the
 * device form's till is chosen client-side, so a server-rendered chip there
 * would be a guess; the credentials table above says which till holds what).
 */
function RefField({ name, label, configured }: { name: string; label: string; configured?: boolean }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={name}>
        {label}{" "}
        {configured !== undefined && (
          <span className={configured ? "text-green-700 dark:text-green-400" : "text-muted-foreground"}>
            {configured ? "· configured" : "· not set"}
          </span>
        )}
      </Label>
      <Input id={name} name={name} placeholder="env://ETA_CLIENT_SECRET_ACME" autoComplete="off" className="font-mono" />
      <p className="text-xs text-muted-foreground">
        An <code>env://</code> reference naming the environment key that holds the credential — never the credential
        itself. Leave blank to keep the stored one.
      </p>
    </div>
  );
}

function FeeLineFields({ prefix, label, value }: { prefix: string; label: string; value?: EtaFeeLineConfig }) {
  return (
    <div className="grid gap-3 rounded-md border p-3">
      <p className="text-sm font-medium">{label}</p>
      <p className="text-xs text-muted-foreground">
        Receipt v1.2 accepts only zero in its own fees slot, so a charge ships as its own receipt line and needs item
        and tax codes exactly like a product. Leave the item code blank if this fee is never charged.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field name={`${prefix}ItemCode`} label="Item code" defaultValue={value?.itemCode} />
        <div className="grid gap-1.5">
          <Label htmlFor={`${prefix}CodeSource`}>Code source</Label>
          <select id={`${prefix}CodeSource`} name={`${prefix}CodeSource`} defaultValue={value?.codeSource ?? "gs1"} className={selectCls}>
            {etaCodeSourceEnum.enumValues.map((v) => (
              <option key={v} value={v}>{v.toUpperCase()}</option>
            ))}
          </select>
        </div>
        <Field name={`${prefix}TaxType`} label="Tax type" defaultValue={value?.taxType} placeholder="T1" />
        <Field name={`${prefix}TaxSubType`} label="Tax sub-type" defaultValue={value?.taxSubType ?? ""} placeholder="V009" />
        <Field name={`${prefix}UnitType`} label="Unit type" defaultValue={value?.unitType} placeholder="EA" />
        <Field name={`${prefix}InternalCode`} label="Internal code" defaultValue={value?.internalCode} />
      </div>
      <Field name={`${prefix}Description`} label="Description" defaultValue={value?.description} />
    </div>
  );
}

export default async function FiscalPage() {
  let ctx;
  try {
    ctx = await requireFiscalPermission();
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return (
        <>
          <PageHeader eyebrow="Fiscal" title="ETA e-invoicing" />
          <EmptyState
            title="Not authorized"
            description="ETA setup needs the fiscal:manage permission, which only the account owner holds. It names the taxpayer and points at the credential store, so it is deliberately narrower than every other admin screen."
          />
        </>
      );
    }
    throw e; // requireDashboardUser redirects unauthenticated users
  }

  const [config, devices, credentials, taxCodes, submissions, statusCounts, tenant] = await Promise.all([
    getFiscalConfig(ctx.tenantId),
    listFiscalDevices(ctx.tenantId),
    listDeviceCredentials(ctx.tenantId),
    listProductTaxCodes(ctx.tenantId),
    listSubmissions(ctx.tenantId, { limit: SUBMISSIONS_PAGE_SIZE }),
    getSubmissionStatusCounts(ctx.tenantId),
    getTenantById(ctx.tenantId),
  ]);
  const tz = tenant?.timezone ?? "UTC";
  const wire = config?.wireContext ?? null;
  const address = wire?.branchAddress;
  const credentialFor = new Map(credentials.map((c) => [c.deviceId, c]));

  return (
    <>
      <PageHeader
        eyebrow="Fiscal"
        title="ETA e-invoicing"
        description="Egypt Tax Authority setup: the taxpayer identity every receipt files under, the credential each till submits with, and the state of every document sent."
      />

      {tenant?.country !== "EG" && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400 mb-4">
          This tenant&apos;s country is {tenant?.country ?? "unset"}, not EG. ETA submission is gated on country, so
          nothing here will be sent until the business profile says Egypt.
        </div>
      )}

      {config && !config.wireContextConfigured && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400 mb-4">
          Seller details incomplete — missing {config.wireContextMissing.join(", ")}. Every one of these is mandatory in
          receipt v1.2, so submission fails until they are filled in.
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      <h2 className="eyebrow text-muted-foreground mb-3">Taxpayer &amp; credentials</h2>
      <Card className="p-5 mb-8">
        <ToastForm action={saveFiscalConfigAction} successMessage="ETA configuration saved" className="grid gap-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              name="rin" label="Registration number (RIN)" required
              defaultValue={config?.rin} placeholder="200173707"
              hint="Exactly 9 digits, as registered with ETA."
            />
            <Field name="clientId" label="ERP client id" required defaultValue={config?.clientId} />
            <RefField name="clientSecretRef" label="ERP client secret reference" configured={config?.hasSecret ?? false} />
            <div className="grid gap-3">
              <RefField name="signingKeyRef" label="E-seal signing key reference" configured={config?.hasSigningKey ?? false} />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="clearSigningKey" value="true" className="size-4 accent-(--color-primary)" />
                Clear the e-seal reference (receipt-only tenants need none)
              </label>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="environment">Environment</Label>
              <select id="environment" name="environment" defaultValue={config?.environment ?? "preprod"} className={selectCls}>
                {etaEnvironmentEnum.enumValues.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="activationStatus">Activation status</Label>
              <select id="activationStatus" name="activationStatus" defaultValue={config?.activationStatus ?? "not_configured"} className={selectCls}>
                {etaActivationStatusEnum.enumValues.map((v) => (
                  <option key={v} value={v}>{v.replace(/_/g, " ")}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Only <code>active</code> submits. Anything else skips submission entirely rather than spraying documents
                ETA will refuse.
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="onlineDeviceId">Device for online orders</Label>
              <select id="onlineDeviceId" name="onlineDeviceId" defaultValue={config?.onlineDeviceId ?? ""} className={selectCls}>
                <option value="">None — till sales only</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>{d.label}{d.revoked ? " (revoked)" : ""}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                A web or WhatsApp order was rung on no device, but ETA scopes the receipt chain to one. This till carries
                those sales.
              </p>
            </div>
          </div>

          <div className="border-t pt-5 grid gap-4">
            <p className="text-sm font-medium">Seller details (receipt v1.2)</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field name="sellerName" label="Trade name" required defaultValue={wire?.sellerName} />
              <Field name="activityCode" label="Activity code" required defaultValue={wire?.activityCode} />
              <Field name="branchCode" label="Branch code" required defaultValue={wire?.branchCode} />
              <Field name="syndicateLicenseNumber" label="Syndicate licence number" defaultValue={wire?.syndicateLicenseNumber} placeholder="C" />
              <Field
                name="buyerIdThreshold" label="Buyer-identification threshold"
                defaultValue={wire?.buyerIdThreshold} placeholder="150000.00"
                hint="Blank uses ETA's published 150,000 EGP. A plain decimal amount."
              />
            </div>
            <p className="text-sm font-medium mt-2">Branch address</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field name="addrCountry" label="Country" required defaultValue={address?.country} placeholder="EG" />
              <Field name="addrGovernate" label="Governate" required defaultValue={address?.governate} />
              <Field name="addrRegionCity" label="Region / city" required defaultValue={address?.regionCity} />
              <Field name="addrStreet" label="Street" required defaultValue={address?.street} />
              <Field name="addrBuildingNumber" label="Building number" required defaultValue={address?.buildingNumber} />
              <Field name="addrPostalCode" label="Postal code" defaultValue={address?.postalCode} />
              <Field name="addrFloor" label="Floor" defaultValue={address?.floor} />
              <Field name="addrRoom" label="Room" defaultValue={address?.room} />
              <Field name="addrLandmark" label="Landmark" defaultValue={address?.landmark} />
              <Field name="addrAdditionalInformation" label="Additional information" defaultValue={address?.additionalInformation} />
            </div>
          </div>

          <div className="border-t pt-5 grid gap-4">
            <p className="text-sm font-medium">Fee lines</p>
            <FeeLineFields prefix="feeServiceCharge" label="Service charge" value={wire?.feeLines?.serviceCharge} />
            <FeeLineFields prefix="feeDelivery" label="Delivery fee" value={wire?.feeLines?.delivery} />
          </div>

          <div><SubmitButton>Save configuration</SubmitButton></div>
        </ToastForm>
      </Card>

      {/* ------------------------------------------------------------------ */}
      <h2 className="eyebrow text-muted-foreground mb-3">Device credentials</h2>
      <FiscalCredentialsTable credentials={credentials} timezone={tz} />

      <Card className="p-5 mb-8 max-w-2xl">
        {devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Pair a POS device first — ETA issues credentials per registered till.
          </p>
        ) : (
          <ToastForm action={saveDeviceCredentialAction} successMessage="Device credential saved" className="grid gap-4">
            <p className="text-sm font-medium">Record a till&apos;s ETA credential</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="deviceId">Till</Label>
                <select id="deviceId" name="deviceId" className={selectCls} required defaultValue="">
                  <option value="" disabled>Select a till</option>
                  {devices.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label}
                      {credentialFor.has(d.id) ? " · registered" : ""}
                      {d.revoked ? " (revoked)" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <Field
                name="etaSerial" label="ETA serial" required
                hint="As registered at pos.eta.gov.eg — at most 100 characters, and part of every receipt this till issues."
              />
              <Field name="deviceClientId" label="Device client id" required />
              <div className="grid gap-1.5">
                <Label htmlFor="status">Status</Label>
                <select id="status" name="status" className={selectCls} defaultValue="">
                  <option value="">Leave unchanged</option>
                  {etaPosCredentialStatusEnum.enumValues.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Only <code>active</code> may submit. <code>retired</code> is final — the receipt chain is keyed on the
                  till.
                </p>
              </div>
              <RefField name="clientSecret1Ref" label="Client secret 1 reference" />
              <RefField name="clientSecret2Ref" label="Client secret 2 reference" />
              <RefField name="presharedKeyRef" label="Pre-shared key reference" />
              <Field name="posOsVersion" label="POS OS version" placeholder="IOS" />
              <Field name="posModelFramework" label="POS model framework" placeholder="1" />
            </div>
            <div><SubmitButton>Save credential</SubmitButton></div>
          </ToastForm>
        )}
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* ------------------------------------------------------------------ */}
      <h2 className="eyebrow text-muted-foreground mb-3">Tax codes</h2>
      <FiscalTaxCodesTable classified={taxCodes.classified} unclassified={taxCodes.unclassified} />

      <Card className="p-5 mb-8 max-w-2xl">
        {taxCodes.classified.length + taxCodes.unclassified.length === 0 ? (
          <p className="text-sm text-muted-foreground">Add a product to the menu first.</p>
        ) : (
          <ToastForm action={saveProductTaxCodeAction} successMessage="Product classified" className="grid gap-4">
            <p className="text-sm font-medium">Classify a product</p>
            <p className="text-xs text-muted-foreground">
              ETA needs an item code, a tax type and a unit of measure for every receipt line. Saving again for the
              same product replaces its classification.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="productId">Product</Label>
                <select id="productId" name="productId" className={selectCls} required defaultValue="">
                  <option value="" disabled>Select a product</option>
                  {/* Unclassified first: those are the ones whose receipts fail
                      today, so they should not be buried under the finished ones. */}
                  {taxCodes.unclassified.map((p) => (
                    <option key={p.productId} value={p.productId}>{p.productName} · not classified</option>
                  ))}
                  {taxCodes.classified.map((c) => (
                    <option key={c.productId} value={c.productId}>{c.productName}</option>
                  ))}
                </select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="codeSource">Code source</Label>
                <select id="codeSource" name="codeSource" className={selectCls} defaultValue="gs1">
                  {etaCodeSourceEnum.enumValues.map((v) => (
                    <option key={v} value={v}>{v.toUpperCase()}</option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  GS1 codes are usable straight away. EGS codes must be approved by ETA before use.
                </p>
              </div>
              <Field name="itemCode" label="Item code" required placeholder="1234567890123" />
              <Field
                name="egsApprovalStatus" label="EGS approval status"
                hint="Leave blank for GS1 codes."
              />
              <Field name="taxType" label="Tax type" required placeholder="T1" />
              <Field name="taxSubType" label="Tax sub-type" placeholder="V009" />
              <Field name="unitType" label="Unit type" required placeholder="EA" />
            </div>
            <div><SubmitButton>Save classification</SubmitButton></div>
          </ToastForm>
        )}
      </Card>

      {/* ------------------------------------------------------------------ */}
      <h2 className="eyebrow text-muted-foreground mb-3">Submissions</h2>
      <FiscalSubmissionsTable
        rows={submissions.rows}
        hasMore={submissions.hasMore}
        counts={statusCounts}
        timezone={tz}
        resubmitAction={resubmitAction}
        pageSize={SUBMISSIONS_PAGE_SIZE}
      />
    </>
  );
}
