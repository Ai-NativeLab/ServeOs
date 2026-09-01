import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { orders } from "@/server/ordering/schema";
import { users } from "@/server/auth/schema";
import { posDevices } from "@/server/pos/schema";
import { auditEvents } from "@/server/audit/schema";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { seedPosContext, openShiftForCtx } from "@/server/pos/test-helpers";
import { recordSale } from "@/server/pos/record-sale";
import {
  etaSubmissions,
  etaTenantConfig,
  etaPosCredentials,
  productTaxCodes,
  type EtaWireContextConfig,
} from "./schema";
import { renderFiscalDocumentEmail } from "./customer-email";
import { enqueueCorrectedResubmission } from "./enqueue";
import { resolveEtaConfig } from "./config";
import {
  FiscalConfigInputError,
  getDeviceCredential,
  getFiscalConfig,
  listDeviceCredentials,
  listFiscalDevices,
  listProductTaxCodes,
  requestB2bInvoice,
  updateFiscalConfig,
  upsertProductTaxCode,
  upsertDeviceCredential,
  type RequestB2bInvoiceBuyer,
  type UpdateFiscalConfigInput,
  type UpsertDeviceCredentialInput,
  type UpsertProductTaxCodeInput,
} from "./config-service";
// The READ surfaces live next door (`./read-model`, split along the permission
// seam) but are tested from HERE on purpose — see this file's header: the
// masking walk has to cover both modules from one place or it becomes two half
// guarantees that can drift apart.
import {
  getSaleFiscalStatus,
  getSaleFiscalStatusByToken,
  getSubmissionById,
  getSubmissionStatusCounts,
  listSubmissions,
} from "./read-model";

/**
 * Runs against the real test Postgres, seeding through `withTenant` and the
 * real POS service functions — so RLS, the FKs and the partial unique indexes
 * are exercised on the way in as well as out.
 *
 * COVERS TWO MODULES ON PURPOSE: `./config-service` (the owner-only write and
 * config surface) and `./read-model` (the cashier-reachable reads, split out
 * along the permission seam). They are one fiscal API from a caller's point of
 * view and, more to the point, one SECRETS guarantee — split the walk below
 * across two test files and it becomes two half-guarantees that drift.
 *
 * THE LOAD-BEARING TEST IN THIS FILE IS THE MASKING ONE. Every `*Ref` column
 * holds a distinctive sentinel string, and `expectNoRefValues` walks every
 * string in a return value (or an audit row) looking for one. Not `toEqual` on
 * a hand-written shape: a field ADDED to a view later would slip past that, and
 * the guarantee this service exists to keep is "no reference ever leaves",
 * which is a statement about values, not about keys.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The strings stored in the `*_ref` columns. Deliberately unlike any field
 *  NAME the service is allowed to emit ("clientSecretRef" in `changedFields` is
 *  fine; the value below is not), so the deep scan cannot false-positive. */
const REFS = {
  erp: "env://ZZ_ETA_ERP_SECRET_SENTINEL",
  signing: "env://ZZ_ETA_SIGNING_SENTINEL",
  secret1: "env://ZZ_ETA_DEVICE_S1_SENTINEL",
  secret2: "env://ZZ_ETA_DEVICE_S2_SENTINEL",
  psk: "env://ZZ_ETA_DEVICE_PSK_SENTINEL",
} as const;

/** The secrets those references resolve to. Present in `process.env` so
 *  `resolveEtaConfig` can be asked, at the end of this file, to prove the refs
 *  really do point at live credentials the masked views never showed. */
const SECRET_VALUES = {
  "ZZ_ETA_ERP_SECRET_SENTINEL": "erp-secret-value-zzz",
  "ZZ_ETA_SIGNING_SENTINEL": "signing-key-value-zzz",
  "ZZ_ETA_DEVICE_S1_SENTINEL": "device-secret-1-value-zzz",
  "ZZ_ETA_DEVICE_S2_SENTINEL": "device-secret-2-value-zzz",
  "ZZ_ETA_DEVICE_PSK_SENTINEL": "device-psk-value-zzz",
} as const;

/** Everything that must never appear in a response: the references AND the
 *  secrets behind them. */
const FORBIDDEN = [...Object.values(REFS), ...Object.values(SECRET_VALUES)];

/**
 * THE STRICTER SET, applied to the UNAUTHENTICATED surface alone — and the
 * difference between the two sets is the AUDIENCE, not an inconsistency.
 *
 * `FORBIDDEN` above deliberately excludes the bare env KEY name: a ref is stored
 * `env://KEY`, so `"env://ZZ_ETA_ERP_SECRET_SENTINEL"` does not substring-match
 * a message that says `"...points at env key ZZ_ETA_ERP_SECRET_SENTINEL..."`,
 * and that pass is intentional. `resolveSecretRef` names the key on purpose
 * ("the ENV KEY, which is not itself a secret, and never the value") because an
 * owner staring at a failed receipt needs to know which variable is unset. The
 * long note in the read-surfaces walk below records that stance, and this set
 * does not overturn it — every dashboard surface is still walked with
 * `FORBIDDEN`, and `getSubmissionById`'s `lastError` still asserts the key IS
 * present.
 *
 * `getSaleFiscalStatusByToken` backs `/order/[token]`, which has no permission
 * gate of any kind: its audience is whoever holds a link the customer may have
 * forwarded, screenshotted or left open. A deployment's env-var NAMES are an
 * operator-facing detail there, not a customer-facing one, so the same string
 * that is acceptable at `fiscal:manage` is not acceptable here — the bare keys
 * join the set for this surface and no other.
 *
 * NOTHING THIS SURFACE RETURNS CAN CARRY ONE TODAY: it delegates to
 * `getSaleFiscalStatus`, whose select list has no `lastError` column in it. That
 * is what makes the assertion cheap, and it is precisely why it is worth having
 * — it is what fails if someone later widens `SaleFiscalStatus` with a "why is
 * it stuck?" field, which is the obvious next request for this page.
 */
const TOKEN_FORBIDDEN = [...FORBIDDEN, ...Object.keys(SECRET_VALUES)];

beforeAll(() => {
  for (const [key, value] of Object.entries(SECRET_VALUES)) process.env[key] = value;
});

afterAll(() => {
  for (const key of Object.keys(SECRET_VALUES)) delete process.env[key];
});

const WIRE_CONTEXT: EtaWireContextConfig = {
  sellerName: "Fiscal Co",
  activityCode: "5610",
  branchCode: "0",
  branchAddress: {
    country: "EG",
    governate: "Cairo",
    regionCity: "Nasr City",
    street: "Test Street",
    buildingNumber: "12",
  },
};

let n = 0;

async function makeTenant(country = "EG") {
  const [tenant] = await db
    .insert(tenants)
    .values({ slug: `fiscal-cfg-${n++}`, name: "Fiscal Co", country })
    .returning();
  return tenant;
}

async function makeBranch(tenantId: string) {
  const [branch] = await withTenant(tenantId, (tx) =>
    tx.insert(branches).values({ tenantId, name: "Main" }).returning(),
  );
  return branch;
}

/**
 * A minimal completed order, so a submission row can satisfy
 * `eta_submissions_parent_xor` (an `e_receipt` MUST carry an order id).
 *
 * Inserted directly rather than rung through `recordSale`: these fixtures exist
 * to exercise the list/lookup queries, and a real sale per row would make them
 * an order of magnitude slower while proving nothing extra. The tests that
 * actually depend on a sale's fiscal identity use `seedSale`, which does go
 * through the real POS path.
 */
async function makeOrder(tenantId: string, branchId: string) {
  const i = n++;
  const [order] = await withTenant(tenantId, (tx) =>
    tx.insert(orders).values({
      tenantId,
      branchId,
      orderNumber: 1000 + i,
      fulfillmentType: "pickup",
      customerName: "Walk-in",
      customerPhone: "+201000000000",
      subtotal: "100.00",
      vatRateSnapshot: "14",
      vatAmount: "14.00",
      total: "114.00",
      statusToken: `tok-order-${tenantId}-${i}`,
    }).returning(),
  );
  return order;
}

/** A paired POS device. `branches` is RLS-backed so its insert goes through
 *  `withTenant`; `users`/`pos_devices` are control-plane tables without RLS. */
async function makeDevice(tenantId: string, label: string) {
  const branch = await makeBranch(tenantId);
  const [user] = await db
    .insert(users)
    .values({ tenantId, name: "Owner", email: `${label}-${n++}@example.test` })
    .returning();
  const [device] = await db
    .insert(posDevices)
    .values({ tenantId, branchId: branch.id, token: `tok-${label}-${n++}`, label, createdByUserId: user.id })
    .returning();
  return device;
}

const validConfig = (over: Partial<UpdateFiscalConfigInput> = {}): UpdateFiscalConfigInput => ({
  rin: "200173707",
  clientId: "erp-client-id",
  clientSecretRef: REFS.erp,
  environment: "preprod",
  activationStatus: "pending",
  wireContext: WIRE_CONTEXT,
  ...over,
});

const validCredential = (over: Partial<UpsertDeviceCredentialInput> = {}): UpsertDeviceCredentialInput => ({
  etaSerial: "POS-001",
  clientId: "device-client-id",
  clientSecret1Ref: REFS.secret1,
  clientSecret2Ref: REFS.secret2,
  presharedKeyRef: REFS.psk,
  posOsVersion: "IOS",
  posModelFramework: "1",
  ...over,
});

// ---------------------------------------------------------------------------
// The masking assertion
// ---------------------------------------------------------------------------

/** Every string anywhere inside a value — object keys included, because a key
 *  built from a reference would leak it just as surely as a value would. */
function deepStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) deepStrings(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push(k);
      deepStrings(v, out);
    }
  }
  return out;
}

/** Substring, not equality: a reference embedded in an error message or a
 *  summary line is exactly the leak this guards against. `forbidden` defaults to
 *  the set every gated surface is held to; the token surface passes
 *  `TOKEN_FORBIDDEN` instead, for the reason recorded on it. */
function expectNoRefValues(payload: unknown, what: string, forbiddenSet: readonly string[] = FORBIDDEN) {
  const strings = deepStrings(payload);
  for (const forbidden of forbiddenSet) {
    const hit = strings.find((s) => s.includes(forbidden));
    expect(hit, `${what} leaked ${forbidden} in ${JSON.stringify(hit)}`).toBeUndefined();
  }
}

/** Asserts the call is refused with an issue at `path`, and hands the error
 *  back so a caller can assert on it further. Runs the call exactly once — a
 *  second run would be a second write attempt. */
async function expectRejected(
  run: () => Promise<unknown>,
  expected: { path: string; match?: RegExp },
): Promise<FiscalConfigInputError> {
  let caught: unknown;
  try {
    await run();
  } catch (e) {
    caught = e;
  }
  expect(caught, "expected the save to be refused").toBeInstanceOf(FiscalConfigInputError);
  const error = caught as FiscalConfigInputError;
  const issue = error.issues.find((i) => i.path === expected.path);
  expect(issue, `no issue at path "${expected.path}" in ${JSON.stringify(error.issues)}`).toBeDefined();
  if (expected.match) expect(issue!.message).toMatch(expected.match);
  return error;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("updateFiscalConfig validation", () => {
  it("accepts a 9-digit RIN and refuses every other length or shape", async () => {
    const t = await makeTenant();
    const saved = await updateFiscalConfig(t.id, validConfig({ rin: "200173707" }));
    expect(saved.rin).toBe("200173707");

    // ETA's Registration Identification Number is 9 digits (Main
    // Calculations). Everything else files the receipt under a taxpayer that
    // does not exist — a permanent rejection discovered hours after the sale.
    for (const bad of ["20017370", "2001737070", "20017370a", "", " 200173707 x", "٢٠٠١٧٣٧٠٧"]) {
      await expectRejected(() => updateFiscalConfig(t.id, validConfig({ rin: bad })), {
        path: "rin",
        match: /9 digits/,
      });
    }
  });

  it("accepts a decimal buyer-id threshold and refuses anything compareDecimal would reject", async () => {
    const t = await makeTenant();
    for (const good of ["150000", "150000.00", "0", "0.5"]) {
      const saved = await updateFiscalConfig(
        t.id,
        validConfig({ wireContext: { ...WIRE_CONTEXT, buyerIdThreshold: good } }),
      );
      expect(saved.wireContext?.buyerIdThreshold).toBe(good);
    }
    // `assertDecimal` (./decimal) is what `compareDecimal` runs at document
    // build time; a threshold that fails there fails on a receipt already
    // handed to a customer, so it has to fail here instead.
    for (const bad of ["1e5", "1.2.3", "abc", "-150000", "150,000", ""]) {
      await expectRejected(
        () => updateFiscalConfig(t.id, validConfig({ wireContext: { ...WIRE_CONTEXT, buyerIdThreshold: bad } })),
        { path: "wireContext.buyerIdThreshold", match: /decimal/ },
      );
    }
  });

  it("names every mandatory wire-context field requireWireContext would refuse", async () => {
    const t = await makeTenant();
    // Exactly the set ./finalize's requireWireContext enforces. If this list
    // and that one ever diverge, this service accepts a config the worker
    // permanently refuses — which is the failure mode the split exists to stop.
    const paths = [
      ["sellerName", { ...WIRE_CONTEXT, sellerName: "" }],
      ["activityCode", { ...WIRE_CONTEXT, activityCode: "" }],
      ["branchCode", { ...WIRE_CONTEXT, branchCode: "  " }],
      ["branchAddress.country", { ...WIRE_CONTEXT, branchAddress: { ...WIRE_CONTEXT.branchAddress, country: "" } }],
      ["branchAddress.governate", { ...WIRE_CONTEXT, branchAddress: { ...WIRE_CONTEXT.branchAddress, governate: "" } }],
      ["branchAddress.regionCity", { ...WIRE_CONTEXT, branchAddress: { ...WIRE_CONTEXT.branchAddress, regionCity: "" } }],
      ["branchAddress.street", { ...WIRE_CONTEXT, branchAddress: { ...WIRE_CONTEXT.branchAddress, street: "" } }],
      ["branchAddress.buildingNumber", { ...WIRE_CONTEXT, branchAddress: { ...WIRE_CONTEXT.branchAddress, buildingNumber: "" } }],
    ] as const;

    for (const [path, wireContext] of paths) {
      await expectRejected(
        () => updateFiscalConfig(t.id, validConfig({ wireContext: wireContext as EtaWireContextConfig })),
        { path: `wireContext.${path}` },
      );
    }
  });

  it("reports which mandatory wire-context fields are missing when none is stored", async () => {
    const t = await makeTenant();
    const saved = await updateFiscalConfig(t.id, validConfig({ wireContext: null }));
    expect(saved.wireContextConfigured).toBe(false);
    // The same names requireWireContext reports, so the dashboard and a failed
    // submission agree on what has to be fixed.
    expect(saved.wireContextMissing).toEqual(["sellerName", "activityCode", "branchCode", "branchAddress"]);

    const complete = await updateFiscalConfig(t.id, validConfig());
    expect(complete.wireContextConfigured).toBe(true);
    expect(complete.wireContextMissing).toEqual([]);
  });

  it("refuses an onlineDeviceId that belongs to another tenant, or to nobody", async () => {
    const mine = await makeTenant();
    const theirs = await makeTenant();
    const theirDevice = await makeDevice(theirs.id, "their-till");

    // pos_devices carries no RLS policy, so the FK alone would happily accept
    // this — and that device would then carry every deviceless online sale
    // onto a foreign uuid chain under a foreign ETA credential.
    await expectRejected(() => updateFiscalConfig(mine.id, validConfig({ onlineDeviceId: theirDevice.id })), {
      path: "onlineDeviceId",
      match: /not one of this tenant's POS devices/,
    });
    await expectRejected(
      () => updateFiscalConfig(mine.id, validConfig({ onlineDeviceId: "00000000-0000-4000-8000-000000000000" })),
      { path: "onlineDeviceId" },
    );
    await expectRejected(() => updateFiscalConfig(mine.id, validConfig({ onlineDeviceId: "not-a-uuid" })), {
      path: "onlineDeviceId",
    });

    const myDevice = await makeDevice(mine.id, "my-till");
    const saved = await updateFiscalConfig(mine.id, validConfig({ onlineDeviceId: myDevice.id }));
    expect(saved.onlineDeviceId).toBe(myDevice.id);
  });

  it("requires a secret reference on the FIRST save and keeps the stored one afterwards", async () => {
    const t = await makeTenant();
    // Nothing to keep yet.
    await expectRejected(
      () => updateFiscalConfig(t.id, { ...validConfig(), clientSecretRef: undefined }),
      { path: "clientSecretRef", match: /first time/ },
    );

    await updateFiscalConfig(t.id, validConfig());
    // The form cannot show a reference, so a save that omits it must not wipe
    // it — otherwise changing the environment dropdown breaks submission.
    const second = await updateFiscalConfig(t.id, {
      ...validConfig(),
      clientSecretRef: undefined,
      environment: "prod",
    });
    expect(second.environment).toBe("prod");
    expect(second.hasSecret).toBe(true);

    const [row] = await withTenant(t.id, (tx) =>
      tx.select().from(etaTenantConfig).where(eq(etaTenantConfig.tenantId, t.id)),
    );
    expect(row.clientSecretRef).toBe(REFS.erp);
  });

  it("distinguishes clearing the signing key (null) from leaving it alone (undefined)", async () => {
    const t = await makeTenant();
    await updateFiscalConfig(t.id, validConfig({ signingKeyRef: REFS.signing }));
    expect((await getFiscalConfig(t.id))!.hasSigningKey).toBe(true);

    // undefined -> untouched.
    await updateFiscalConfig(t.id, validConfig({ signingKeyRef: undefined, clientSecretRef: undefined }));
    expect((await getFiscalConfig(t.id))!.hasSigningKey).toBe(true);

    // null -> cleared, the ordinary state of a receipt-only tenant.
    await updateFiscalConfig(t.id, validConfig({ signingKeyRef: null, clientSecretRef: undefined }));
    expect((await getFiscalConfig(t.id))!.hasSigningKey).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

describe("masking — no *Ref value ever leaves this service", () => {
  it("keeps every reference and secret out of the config views, the credential views and the audit trail", async () => {
    const t = await makeTenant();
    const device = await makeDevice(t.id, "till");

    const saved = await updateFiscalConfig(
      t.id,
      validConfig({ signingKeyRef: REFS.signing, onlineDeviceId: device.id }),
    );
    const read = await getFiscalConfig(t.id);
    const credential = await upsertDeviceCredential(t.id, device.id, validCredential());
    const credentials = await listDeviceCredentials(t.id);
    const one = await getDeviceCredential(t.id, device.id);

    expectNoRefValues(saved, "updateFiscalConfig");
    expectNoRefValues(read, "getFiscalConfig");
    expectNoRefValues(credential, "upsertDeviceCredential");
    expectNoRefValues(credentials, "listDeviceCredentials");
    expectNoRefValues(one, "getDeviceCredential");

    // Audit rows are readable by every audit:view holder — owner AND manager —
    // which is a strictly wider audience than fiscal:manage. A reference in
    // metadata would hand the map to the secret store to a role deliberately
    // denied the config screen.
    const events = await withTenant(t.id, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.tenantId, t.id)),
    );
    expectNoRefValues(events, "audit_events");

    // And the booleans that stand in their place are actually true.
    expect(read).toMatchObject({ hasSecret: true, hasSigningKey: true });
    expect(one).toMatchObject({ hasSecret1: true, hasSecret2: true, hasPresharedKey: true });
  });

  it("keeps references out of the FiscalConfigInputError a rejected save throws", async () => {
    const t = await makeTenant();
    const error = await expectRejected(
      () => updateFiscalConfig(t.id, validConfig({ rin: "nope" })),
      { path: "rin" },
    );
    expectNoRefValues({ message: error.message, issues: error.issues }, "FiscalConfigInputError");
  });

  it("walks the READ surfaces too — submissions, sale status, one submission, status counts, devices", async () => {
    // The config and credential views are the obvious leak sites, but they are
    // not the only reachable ones: `lastError` is worker-written free text, and
    // the device list carries operator-typed labels. Both are strings this
    // service hands to a client, so both belong inside the walk.
    const t = await makeTenant();
    const device = await makeDevice(t.id, "till");
    const order = await makeOrder(t.id, device.branchId);
    await updateFiscalConfig(t.id, validConfig({ signingKeyRef: REFS.signing }));
    await upsertDeviceCredential(t.id, device.id, validCredential());

    // A REALISTIC failure message — this is `resolveSecretRef`'s own text
    // (config.ts), verbatim in shape, which is what the worker actually parks
    // in `lastError` when a credential reference will not resolve.
    const realisticLastError =
      "fiscal: eta_tenant_config.client_secret_ref points at env key ZZ_ETA_ERP_SECRET_SENTINEL, " +
      "which is unset or empty — the ETA credential cannot be assembled. " +
      "Set it in the deployment's environment.";

    const [row] = await withTenant(t.id, (tx) =>
      tx.insert(etaSubmissions).values({
        tenantId: t.id,
        docType: "e_receipt",
        orderId: order.id,
        status: "failed",
        etaUuid: "a".repeat(64),
        qrPayload: `https://preprod.invoicing.eta.gov.eg/receipts/search/${"a".repeat(64)}`,
        lastError: realisticLastError,
        // The SAME failure shape on the email column (round 2, Task 7). It
        // joins the walk on `lastError`'s exact terms — owner audience, env KEY
        // names acceptable, VALUES never — and it is seeded with realistic text
        // rather than a placeholder so the walk has something real to walk.
        customerEmailError: "Error: RESEND_API_KEY is not set",
      }).returning(),
    );

    // THE WIDENED SALE SURFACE IS WALKED TOO (round 2, Task 5). A second order,
    // filed as an `e_invoice` — the family `getSaleFiscalStatus` now admits —
    // carrying a reference in `lastError` and in `etaLongId`, which is the field
    // the widening added and the only new string this surface can return. A walk
    // that only ever saw the receipt family would leave the whole B2B path
    // outside the guarantee.
    const b2bOrder = await makeOrder(t.id, device.branchId);
    await withTenant(t.id, (tx) =>
      tx.insert(etaSubmissions).values({
        tenantId: t.id,
        docType: "e_invoice",
        orderId: b2bOrder.id,
        status: "failed",
        etaLongId: "BFNGXFA17265TQX34",
        lastError: realisticLastError,
        buyerJson: {
          rin: "313717919", name: "Receiver Company LLC",
          address: {
            country: "EG", governate: "Cairo", regionCity: "Nasr City",
            street: "580 Clementina Key", buildingNumber: "Bldg. 0",
          },
        },
      }),
    );

    const submissions = await listSubmissions(t.id);
    const saleStatus = await getSaleFiscalStatus(t.id, order.id);
    const invoiceStatus = await getSaleFiscalStatus(t.id, b2bOrder.id);
    // THE TOKEN SURFACE (round 2, Task 6) — the same two sales, reached the way
    // the online status page reaches them. Walked with the STRICTER set, because
    // this one answers to a link rather than to a permission (see
    // `TOKEN_FORBIDDEN`). Both families, so the B2B path is inside the
    // guarantee here too.
    const tokenStatus = await getSaleFiscalStatusByToken(t.id, order.statusToken);
    const tokenInvoice = await getSaleFiscalStatusByToken(t.id, b2bOrder.statusToken);
    const one = await getSubmissionById(t.id, row.id);
    const statusCounts = await getSubmissionStatusCounts(t.id);
    const fiscalDevices = await listFiscalDevices(t.id);
    const taxCodes = await listProductTaxCodes(t.id);

    expectNoRefValues(submissions, "listSubmissions");
    expectNoRefValues(saleStatus, "getSaleFiscalStatus");
    expectNoRefValues(invoiceStatus, "getSaleFiscalStatus (e_invoice)");
    expectNoRefValues(one, "getSubmissionById");
    // Non-vacuity for the pair above: the B2B read really is the invoice family
    // and really does carry the field the widening added, so walking it is
    // walking something.
    expect(invoiceStatus!.docType).toBe("e_invoice");
    expect(invoiceStatus!.etaLongId).toBe("BFNGXFA17265TQX34");

    expectNoRefValues(tokenStatus, "getSaleFiscalStatusByToken", TOKEN_FORBIDDEN);
    expectNoRefValues(tokenInvoice, "getSaleFiscalStatusByToken (e_invoice)", TOKEN_FORBIDDEN);
    // Non-vacuity for the token pair, and the delegation rule stated as data:
    // the token read is not merely non-leaky, it is the SAME value the order-id
    // read produced — which is what a second query in the storefront would stop
    // being the moment the two disagreed.
    expect(tokenStatus).toEqual(saleStatus);
    expect(tokenInvoice).toEqual(invoiceStatus);
    expect(tokenInvoice!.docType).toBe("e_invoice");
    // Numbers under fixed enum keys — nothing here could carry a reference
    // today, and it is walked anyway so that stays true if the shape grows.
    expectNoRefValues(statusCounts, "getSubmissionStatusCounts");
    expectNoRefValues(fiscalDevices, "listFiscalDevices");
    // No references here either, but the walk covers every read surface by
    // rule rather than by a per-function judgement about which ones could
    // plausibly carry one.
    expectNoRefValues(taxCodes, "listProductTaxCodes");

    /**
     * DELIBERATE SCOPE, stated so a later reader does not "tighten" it by
     * accident. The message above names the env KEY (`ZZ_ETA_ERP_SECRET_SENTINEL`)
     * and the walk passes it. That is by design, not an oversight:
     * `resolveSecretRef` documents the stance explicitly — "The thrown message
     * names the ENV KEY, which is not itself a secret, and never the value" —
     * because an operator staring at a failed receipt needs to know WHICH
     * variable is unset.
     *
     * So the invariant pinned here is narrower and sharper than "no reference
     * string ever appears": it is that no reference VALUE and no resolved
     * SECRET transits. `FORBIDDEN` is exactly those two sets, and the bare key
     * name is deliberately outside it.
     *
     * THE DISTINCTION IS NOW ENFORCED AT SAVE TIME, not merely observed here.
     * `resolveSecretRef` still accepts a BARE key so rows written before that
     * rule keep resolving — and under that spelling the stored column value and
     * the error's key name are the SAME characters, collapsing the two sets this
     * walk is built to tell apart. `refSchema` therefore requires `env://` on
     * every save (see the test below), so no NEW row can reintroduce the
     * collapse, and the sentinels in this file are `env://`-spelled for the same
     * reason. That is what turns the assertion above from an accident of format
     * into a property of the data.
     */
    expect(one!.lastError).toContain("ZZ_ETA_ERP_SECRET_SENTINEL");

    // NON-VACUITY FOR THE SIDE-EFFECT VIEW (round 2, Task 8). The seeded email
    // failure really does reach the walked payload, and it reaches it INSIDE the
    // named state rather than as a bare column — so the plants below are planting
    // where a real leak would actually land.
    expect(one!.sideEffects.email).toEqual({ kind: "failed", error: "Error: RESEND_API_KEY is not set" });

    // And the walk is LIVE on all four shapes — the nested array, the wrapper
    // object, the flat record and the plain list. Planting a reference where an
    // accidental leak would actually land must fail, or the four assertions
    // above prove nothing.
    const planted: [string, unknown][] = [
      ["listSubmissions", { ...submissions, rows: [{ ...submissions.rows[0], lastError: REFS.erp }] }],
      ["getSaleFiscalStatus", { ...saleStatus, qrPayload: REFS.signing }],
      // The widened surface's own planted case: `etaLongId` is server-assigned
      // text and the one new string a B2B read can hand back.
      ["getSaleFiscalStatus (e_invoice)", { ...invoiceStatus, etaLongId: REFS.erp }],
      ["getSubmissionById", { ...one, lastError: SECRET_VALUES.ZZ_ETA_DEVICE_S1_SENTINEL }],
      // The email failure text round 2 Task 7 added to this surface, now reached
      // through the named state round 2 Task 8 wrapped it in. It is worker-written
      // free text exactly as `lastError` is, so it is exactly as capable of
      // carrying a reference by accident — and a walk over a field proves nothing
      // until a plant into that field is shown to fail. PLANTED INSIDE THE UNION
      // rather than beside it: the raw column is no longer on the view, so a plant
      // at the old path would sail through the walk while proving nothing, which
      // is precisely the silent hole this pair exists to close.
      ["listSubmissions (email state)", {
        ...submissions,
        rows: [{ ...submissions.rows[0], sideEffects: { ...submissions.rows[0].sideEffects, email: { kind: "failed", error: REFS.signing } } }],
      }],
      ["getSubmissionById (email state)", {
        ...one, sideEffects: { ...one!.sideEffects, email: { kind: "failed", error: SECRET_VALUES.ZZ_ETA_SIGNING_SENTINEL } },
      }],
      ["listFiscalDevices", [{ ...fiscalDevices[0], label: REFS.psk }]],
    ];
    for (const [what, payload] of planted) {
      expect(() => expectNoRefValues(payload, what), `${what}'s walk did not catch a planted reference`).toThrow();
    }

    // The token surface's own liveness, on both families and under its own set.
    for (const [what, payload] of [
      ["getSaleFiscalStatusByToken", { ...tokenStatus, qrPayload: REFS.erp }],
      ["getSaleFiscalStatusByToken (e_invoice)", { ...tokenInvoice, etaLongId: SECRET_VALUES.ZZ_ETA_SIGNING_SENTINEL }],
    ] as [string, unknown][]) {
      expect(() => expectNoRefValues(payload, what, TOKEN_FORBIDDEN), `${what}'s walk did not catch a planted reference`).toThrow();
    }

    // AND THE TWO SETS ARE DEMONSTRABLY DIFFERENT, in the direction claimed.
    // A BARE env key planted where an accidental leak would land fails the token
    // walk and PASSES the dashboard one — which is the whole distinction, shown
    // rather than asserted in prose. If someone later folds the bare keys into
    // `FORBIDDEN` wholesale, the second line here fails and points at the
    // `resolveSecretRef` stance they would be overturning by accident.
    const bareKeyLeak = { ...tokenStatus, etaLongId: "ZZ_ETA_ERP_SECRET_SENTINEL" };
    expect(
      () => expectNoRefValues(bareKeyLeak, "token surface", TOKEN_FORBIDDEN),
      "the token surface's stricter set did not catch a bare env key",
    ).toThrow();
    expect(
      () => expectNoRefValues(bareKeyLeak, "gated surface", FORBIDDEN),
      "FORBIDDEN caught a bare env key — the `lastError` stance below has been overturned",
    ).not.toThrow();
  });

  /**
   * THE WIDEST AUDIENCE IN THE SUBSYSTEM, and the reason it gets the STRICT set.
   *
   * `/order/[token]` answers to whoever holds a link. A forwarded EMAIL answers
   * to that set plus everyone downstream of a forward, with no expiry and no
   * revocation — so the customer's fiscal-document mail (round 2, Task 7) is
   * held to `TOKEN_FORBIDDEN`, the same strict set as the token surface, which
   * refuses even the bare env KEY names the owner-only dashboard reads may carry.
   *
   * PURE, so it needs no send and no provider: the renderer takes data and
   * returns `{subject, html}`, which is the entire payload that leaves the
   * building. Walked HERE rather than in `customer-email.test.ts` so the
   * forbidden sets keep ONE home — the rule this file's header states.
   */
  it("walks the CUSTOMER EMAIL payload — the widest audience, so the strict set", async () => {
    const t = await makeTenant();
    const branch = await makeBranch(t.id);
    const order = await makeOrder(t.id, branch.id);

    const tenantView = { id: t.id, name: "Fiscal Co", currency: "EGP", contactEmail: "hi@fiscal.test" };
    const orderView = {
      id: order.id, orderNumber: order.orderNumber, total: order.total,
      customerName: order.customerName, customerEmail: "buyer@example.test", customerId: null,
    };

    const receiptMail = renderFiscalDocumentEmail({
      id: order.id, docType: "e_receipt", etaUuid: "a".repeat(64), etaLongId: "LONG-1",
      qrPayload: `https://preprod.invoicing.eta.gov.eg/receipts/search/${"a".repeat(64)}`,
    }, orderView, tenantView);
    const invoiceMail = renderFiscalDocumentEmail({
      id: order.id, docType: "e_invoice", etaUuid: null, etaLongId: "EG-LONG-1", qrPayload: null,
    }, orderView, tenantView);

    expectNoRefValues(receiptMail, "renderFiscalDocumentEmail (e_receipt)", TOKEN_FORBIDDEN);
    expectNoRefValues(invoiceMail, "renderFiscalDocumentEmail (e_invoice)", TOKEN_FORBIDDEN);

    // LIVENESS, on the three strings a leak could realistically ride in on: the
    // portal link (worker-written), ETA's long id (server-assigned text) and the
    // tenant's own name (operator-typed). Both halves of the payload are walked,
    // so a leak in the SUBJECT is caught as surely as one in the body.
    const plantedMail: [string, unknown][] = [
      ["email via qrPayload", renderFiscalDocumentEmail(
        { id: order.id, docType: "e_receipt", etaUuid: null, etaLongId: null, qrPayload: REFS.erp },
        orderView, tenantView)],
      ["email via etaLongId", renderFiscalDocumentEmail(
        { id: order.id, docType: "e_invoice", etaUuid: null, etaLongId: SECRET_VALUES.ZZ_ETA_SIGNING_SENTINEL, qrPayload: null },
        orderView, tenantView)],
      ["email via subject", renderFiscalDocumentEmail(
        { id: order.id, docType: "e_receipt", etaUuid: null, etaLongId: null, qrPayload: null },
        orderView, { ...tenantView, name: REFS.psk })],
    ];
    for (const [what, payload] of plantedMail) {
      expect(
        () => expectNoRefValues(payload, what, TOKEN_FORBIDDEN),
        `${what}'s walk did not catch a planted reference`,
      ).toThrow();
    }

    // AND IT IS THE STRICT SET, shown rather than claimed: a BARE env key in the
    // body fails this walk and PASSES the dashboard's. An email is forwarded; a
    // deployment's variable names must not ride along with it.
    const bareKeyMail = renderFiscalDocumentEmail(
      { id: order.id, docType: "e_invoice", etaUuid: null, etaLongId: "ZZ_ETA_ERP_SECRET_SENTINEL", qrPayload: null },
      orderView, tenantView);
    expect(
      () => expectNoRefValues(bareKeyMail, "customer email", TOKEN_FORBIDDEN),
      "the email walk's stricter set did not catch a bare env key",
    ).toThrow();
    expect(
      () => expectNoRefValues(bareKeyMail, "customer email", FORBIDDEN),
      "FORBIDDEN caught a bare env key — the `lastError` stance has been overturned",
    ).not.toThrow();
  });

  it("refuses a BARE env key on save, while legacy bare rows keep resolving", async () => {
    const t = await makeTenant();
    const device = await makeDevice(t.id, "till");

    // Every ref field, both surfaces. A bare key is a valid thing for
    // `resolveSecretRef` to READ and an invalid thing to WRITE: stored bare,
    // the reference VALUE and the env KEY NAME are the same characters, and the
    // masking walk's whole distinction between "never leaves" and "may appear in
    // an error message" collapses.
    await expectRejected(() => updateFiscalConfig(t.id, validConfig({ clientSecretRef: "ZZ_BARE_KEY" })), {
      path: "clientSecretRef",
      match: /env:\/\//,
    });
    await expectRejected(() => updateFiscalConfig(t.id, validConfig({ signingKeyRef: "ZZ_BARE_KEY" })), {
      path: "signingKeyRef",
      match: /env:\/\//,
    });
    await updateFiscalConfig(t.id, validConfig());
    for (const field of ["clientSecret1Ref", "clientSecret2Ref", "presharedKeyRef"] as const) {
      await expectRejected(
        () => upsertDeviceCredential(t.id, device.id, validCredential({ [field]: "ZZ_BARE_KEY" })),
        { path: field, match: /env:\/\// },
      );
    }
    // Not merely "starts with something": a scheme with no key behind it names
    // nothing at all.
    await expectRejected(() => updateFiscalConfig(t.id, validConfig({ clientSecretRef: "env://" })), {
      path: "clientSecretRef",
    });

    // LEGACY ROWS STILL RESOLVE. A row written before this rule holds a bare
    // key, and refusing to read it would take a working tenant's submissions
    // down for a formatting change. Seeded past the service, exactly as an old
    // row would exist.
    await withTenant(t.id, (tx) =>
      tx.update(etaTenantConfig)
        .set({ clientSecretRef: "ZZ_ETA_ERP_SECRET_SENTINEL", activationStatus: "active" })
        .where(eq(etaTenantConfig.tenantId, t.id)),
    );
    const resolved = await resolveEtaConfig(t.id);
    expect(resolved!.erp.clientSecret()).toBe(SECRET_VALUES.ZZ_ETA_ERP_SECRET_SENTINEL);
  });

  it("stores the references verbatim — the masking is a read-side guarantee, not a lossy write", async () => {
    const t = await makeTenant();
    const device = await makeDevice(t.id, "till");
    await updateFiscalConfig(t.id, validConfig({ signingKeyRef: REFS.signing, activationStatus: "active" }));
    await upsertDeviceCredential(t.id, device.id, validCredential({ status: "active" }));

    // The end-to-end proof: what the views refused to show still resolves into
    // live credentials for the submission path.
    const resolved = await resolveEtaConfig(t.id, device.id);
    expect(resolved).not.toBeNull();
    expect(resolved!.erp.clientSecret()).toBe(SECRET_VALUES.ZZ_ETA_ERP_SECRET_SENTINEL);
    expect(resolved!.signingKey()).toBe(SECRET_VALUES.ZZ_ETA_SIGNING_SENTINEL);
    expect(resolved!.device!.secret1).toBe(SECRET_VALUES.ZZ_ETA_DEVICE_S1_SENTINEL);
    expect(resolved!.device!.secret2).toBe(SECRET_VALUES.ZZ_ETA_DEVICE_S2_SENTINEL);
    expect(resolved!.device!.presharedKey).toBe(SECRET_VALUES.ZZ_ETA_DEVICE_PSK_SENTINEL);
  });
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

describe("audit", () => {
  it("emits eta.config.updated naming the changed FIELDS, and eta.device_credentials.updated", async () => {
    const t = await makeTenant();
    const device = await makeDevice(t.id, "till");

    await updateFiscalConfig(t.id, validConfig());
    await updateFiscalConfig(t.id, validConfig({ clientSecretRef: "env://ZZ_ROTATED", environment: "prod" }));
    await upsertDeviceCredential(t.id, device.id, validCredential());
    await upsertDeviceCredential(t.id, device.id, validCredential({ status: "active" }));

    const events = await withTenant(t.id, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.tenantId, t.id)),
    );
    const config = events.filter((e) => e.action === "eta.config.updated");
    const creds = events.filter((e) => e.action === "eta.device_credentials.updated");

    expect(config).toHaveLength(2);
    expect(config[0].metadata).toMatchObject({ created: true, changedFields: [] });
    // Which fields moved is the fact worth keeping; their values are not.
    expect((config[1].metadata as { changedFields: string[] }).changedFields).toEqual(
      expect.arrayContaining(["clientSecretRef", "environment"]),
    );
    expect(config[1].entityType).toBe("eta_tenant_config");

    expect(creds).toHaveLength(2);
    expect(creds[1].metadata).toMatchObject({ previousStatus: "registered", status: "active" });
    expect(creds[1].entityType).toBe("eta_pos_credential");
  });
});

// ---------------------------------------------------------------------------
// Device credentials
// ---------------------------------------------------------------------------

describe("device credentials", () => {
  it("validates the ETA serial at ETA's 100-character cap", async () => {
    const t = await makeTenant();
    const device = await makeDevice(t.id, "till");

    const ok = await upsertDeviceCredential(t.id, device.id, validCredential({ etaSerial: "S".repeat(100) }));
    expect(ok.etaSerial).toHaveLength(100);

    for (const bad of ["", "   ", "S".repeat(101)]) {
      await expectRejected(() => upsertDeviceCredential(t.id, device.id, validCredential({ etaSerial: bad })), {
        path: "etaSerial",
      });
    }
  });

  it("refuses a device that is not this tenant's", async () => {
    const mine = await makeTenant();
    const theirs = await makeTenant();
    const theirDevice = await makeDevice(theirs.id, "their-till");
    await expectRejected(() => upsertDeviceCredential(mine.id, theirDevice.id, validCredential()), {
      path: "deviceId",
    });
  });

  it("walks the documented status transitions and refuses the rest", async () => {
    const t = await makeTenant();
    const device = await makeDevice(t.id, "till");

    // A brand-new credential starts where a real one starts.
    await expectRejected(
      () => upsertDeviceCredential(t.id, device.id, validCredential({ status: "expired" })),
      { path: "status", match: /registered or active/ },
    );

    const created = await upsertDeviceCredential(t.id, device.id, validCredential());
    expect(created.status).toBe("registered");
    expect(created.activatedAt).toBeNull();

    // registered -> expired is not a thing: ETA never activated it.
    await expectRejected(
      () => upsertDeviceCredential(t.id, device.id, validCredential({ status: "expired" })),
      { path: "status", match: /registered to expired/ },
    );

    const active = await upsertDeviceCredential(t.id, device.id, validCredential({ status: "active" }));
    expect(active.status).toBe("active");
    // Stamped by the service on the transition INTO active, not accepted from
    // the caller.
    expect(active.activatedAt).toBeInstanceOf(Date);

    const expired = await upsertDeviceCredential(t.id, device.id, validCredential({ status: "expired" }));
    expect(expired.status).toBe("expired");
    // Renewed at pos.eta.gov.eg and re-recorded — and it keeps the timestamp it
    // first earned.
    const renewed = await upsertDeviceCredential(t.id, device.id, validCredential({ status: "active" }));
    expect(renewed.activatedAt).toEqual(active.activatedAt);

    await upsertDeviceCredential(t.id, device.id, validCredential({ status: "retired" }));
    // Terminal: eta_device_chains keys the receipt uuid chain on the device, so
    // reviving a retired credential is how a till comes back with a chain
    // someone believes is finished.
    for (const revive of ["registered", "active", "expired"] as const) {
      await expectRejected(
        () => upsertDeviceCredential(t.id, device.id, validCredential({ status: revive })),
        { path: "status", match: /retired/ },
      );
    }
  });

  it("requires both secret references on first save and keeps them afterwards", async () => {
    const t = await makeTenant();
    const device = await makeDevice(t.id, "till");
    await expectRejected(
      () => upsertDeviceCredential(t.id, device.id, { ...validCredential(), clientSecret1Ref: undefined }),
      { path: "clientSecret1Ref", match: /first time/ },
    );
    await upsertDeviceCredential(t.id, device.id, validCredential());
    const kept = await upsertDeviceCredential(t.id, device.id, {
      ...validCredential(),
      clientSecret1Ref: undefined,
      clientSecret2Ref: undefined,
      etaSerial: "POS-002",
    });
    expect(kept).toMatchObject({ etaSerial: "POS-002", hasSecret1: true, hasSecret2: true });
  });

  it("names the till rather than a uuid, and lists devices with no credential at all", async () => {
    const t = await makeTenant();
    const registered = await makeDevice(t.id, "front-counter");
    await makeDevice(t.id, "back-counter");
    await upsertDeviceCredential(t.id, registered.id, validCredential());

    const credentials = await listDeviceCredentials(t.id);
    expect(credentials).toHaveLength(1);
    expect(credentials[0].deviceLabel).toBe("front-counter");

    // The device list is the other half: a till with no ETA credential is
    // exactly the row an operator is looking for.
    const devices = await listFiscalDevices(t.id);
    expect(devices.map((d) => d.label).sort()).toEqual(["back-counter", "front-counter"]);
  });
});

// ---------------------------------------------------------------------------
// RLS
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Product tax codes
// ---------------------------------------------------------------------------

describe("product tax codes", () => {
  const validTaxCode = (
    productId: string,
    over: Partial<UpsertProductTaxCodeInput> = {},
  ): UpsertProductTaxCodeInput => ({
    productId,
    codeSource: "gs1",
    itemCode: "1234567890123",
    taxType: "T1",
    taxSubType: "V009",
    unitType: "EA",
    ...over,
  });

  it("classifies a product, then re-classifies it, and reports both halves of the catalogue", async () => {
    // A real product through the real catalogue service, so the join and the FK
    // are exercised rather than assumed.
    const s = await seedPosContext("owner");

    const before = await listProductTaxCodes(s.tenantId);
    expect(before.classified).toEqual([]);
    // The rows an operator opens this screen to clear: an unclassified product
    // fails its receipt permanently the moment it is sold.
    expect(before.unclassified).toEqual([
      { productId: s.productId, productName: "Margherita", productSku: null },
    ]);

    const saved = await upsertProductTaxCode(s.tenantId, validTaxCode(s.productId));
    expect(saved).toMatchObject({
      productId: s.productId,
      productName: "Margherita",
      codeSource: "gs1",
      itemCode: "1234567890123",
      taxType: "T1",
      taxSubType: "V009",
      unitType: "EA",
      egsApprovalStatus: null,
    });

    const after = await listProductTaxCodes(s.tenantId);
    expect(after.unclassified).toEqual([]);
    expect(after.classified).toHaveLength(1);
    // The list carries the product's own name and SKU — a screen of bare uuids
    // cannot be matched against ETA's code tables by hand.
    expect(after.classified[0].productName).toBe("Margherita");

    // Upsert, not insert: re-classifying is the same operation as classifying.
    const reclassified = await upsertProductTaxCode(
      s.tenantId,
      validTaxCode(s.productId, { codeSource: "egs", itemCode: "EG-9", egsApprovalStatus: "pending" }),
    );
    expect(reclassified).toMatchObject({ codeSource: "egs", itemCode: "EG-9", egsApprovalStatus: "pending" });
    expect((await listProductTaxCodes(s.tenantId)).classified).toHaveLength(1);
  });

  it("refuses a bad shape, naming the field", async () => {
    const s = await seedPosContext("owner");
    for (const [path, input] of [
      ["itemCode", validTaxCode(s.productId, { itemCode: "  " })],
      ["taxType", validTaxCode(s.productId, { taxType: "" })],
      ["unitType", validTaxCode(s.productId, { unitType: "" })],
      ["codeSource", validTaxCode(s.productId, { codeSource: "gs2" as never })],
      ["productId", validTaxCode("not-a-uuid")],
    ] as const) {
      await expectRejected(() => upsertProductTaxCode(s.tenantId, input), { path });
    }
  });

  it("refuses a product that belongs to another tenant", async () => {
    const mine = await seedPosContext("owner");
    const theirs = await seedPosContext("owner");

    // `products` is RLS-backed, so this already reads as absent — the point of
    // the explicit check is that the operator gets a 400 naming the field
    // instead of an opaque 500 from the foreign key.
    await expectRejected(() => upsertProductTaxCode(mine.tenantId, validTaxCode(theirs.productId)), {
      path: "productId",
      match: /not one of this tenant's products/,
    });

    // And nothing was written on either side.
    expect((await listProductTaxCodes(mine.tenantId)).classified).toEqual([]);
    expect((await listProductTaxCodes(theirs.tenantId)).classified).toEqual([]);
  });

  it("emits eta.product_tax_code.updated naming the changed FIELDS", async () => {
    const s = await seedPosContext("owner");
    await upsertProductTaxCode(s.tenantId, validTaxCode(s.productId));
    await upsertProductTaxCode(s.tenantId, validTaxCode(s.productId, { itemCode: "9999999999999", unitType: "KGM" }));

    const events = await withTenant(s.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.tenantId, s.tenantId)),
    );
    const emitted = events.filter((e) => e.action === "eta.product_tax_code.updated");
    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toMatchObject({ entityType: "product_tax_code", actorType: "user" });
    expect(emitted[0].metadata).toMatchObject({ created: true, changedFields: [] });
    expect((emitted[1].metadata as { changedFields: string[] }).changedFields).toEqual(
      expect.arrayContaining(["itemCode", "unitType"]),
    );
  });

  it("is tenant-scoped on read — one tenant never sees another's classifications", async () => {
    const mine = await seedPosContext("owner");
    const theirs = await seedPosContext("owner");
    await upsertProductTaxCode(theirs.tenantId, validTaxCode(theirs.productId));

    const seen = await listProductTaxCodes(mine.tenantId);
    expect(seen.classified).toEqual([]);
    expect(seen.unclassified.map((p) => p.productId)).toEqual([mine.productId]);
  });
});

describe("RLS", () => {
  it("shows one tenant nothing of another's config, credentials or submissions", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const deviceA = await makeDevice(a.id, "a-till");

    await updateFiscalConfig(a.id, validConfig());
    await upsertDeviceCredential(a.id, deviceA.id, validCredential());
    const orderA = await makeOrder(a.id, deviceA.branchId);
    await withTenant(a.id, (tx) =>
      tx.insert(etaSubmissions).values({
        tenantId: a.id,
        docType: "e_receipt",
        orderId: orderA.id,
        status: "pending",
      }),
    );

    // Through the service.
    expect(await getFiscalConfig(b.id)).toBeNull();
    expect(await listDeviceCredentials(b.id)).toEqual([]);
    expect((await listSubmissions(b.id)).rows).toEqual([]);
    expect(await getDeviceCredential(b.id, deviceA.id)).toBeNull();

    // And directly, so the policy itself is what is being proved rather than a
    // tenant predicate in a WHERE clause.
    const seen = await withTenant(b.id, async (tx) => ({
      config: await tx.select().from(etaTenantConfig),
      credentials: await tx.select().from(etaPosCredentials),
      submissions: await tx.select().from(etaSubmissions),
    }));
    expect(seen.config).toEqual([]);
    expect(seen.credentials).toEqual([]);
    expect(seen.submissions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sale fiscal status + submission feed
// ---------------------------------------------------------------------------

/** An EG tenant with a paid cash sale. `configureFirst` decides whether the
 *  sale path can finalize the row inline (uuid + QR at issuance, the
 *  production path) or leaves it pending and unfinalized. */
async function seedSale(opts: { configureFirst: boolean }) {
  const s = await seedPosContext("owner");
  await openShiftForCtx(s.ctx);
  await withTenant(s.tenantId, (tx) =>
    tx.insert(productTaxCodes).values({
      tenantId: s.tenantId,
      productId: s.productId,
      codeSource: "gs1",
      itemCode: "1234567890123",
      taxType: "T1",
      taxSubType: "V009",
      unitType: "EA",
    }),
  );

  const configure = async () => {
    await withTenant(s.tenantId, (tx) =>
      tx.insert(etaTenantConfig).values({
        tenantId: s.tenantId,
        registrationNumber: "200173707",
        clientId: "erp-client",
        clientSecretRef: REFS.erp,
        environment: "preprod",
        activationStatus: "active",
        wireContextJson: WIRE_CONTEXT,
      }),
    );
    await withTenant(s.tenantId, (tx) =>
      tx.insert(etaPosCredentials).values({
        tenantId: s.tenantId,
        deviceId: s.ctx.deviceId,
        etaSerial: "POS-001",
        clientId: "device-client",
        clientSecret1Ref: REFS.secret1,
        clientSecret2Ref: REFS.secret2,
        presharedKeyRef: REFS.psk,
        status: "active",
      }),
    );
  };

  if (opts.configureFirst) await configure();
  const receipt = await recordSale(s.ctx, {
    clientOrderId: `sale-${n++}`,
    lines: [{ productId: s.productId, quantity: 1, selectedOptionIds: [] }],
    expectedTotal: s.total,
    payments: [{ clientPaymentId: "p-1", method: "cash", amount: s.total, tenderedAmount: s.total }],
  });
  if (!opts.configureFirst) await configure();

  return { ...s, receipt };
}

describe("getSaleFiscalStatus", () => {
  it("is null for an order with no submission at all", async () => {
    const t = await makeTenant();
    // The ordinary state of a non-EG tenant, and of an EG sale in the seconds
    // before its enqueue lands. The POS renders no fiscal footer for it.
    expect(await getSaleFiscalStatus(t.id, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("walks pending (no QR yet) -> pending (finalized) -> accepted", async () => {
    // Configured AFTER the sale: the row exists but was never finalized, so it
    // carries no uuid and no QR. (The sale path logs one expected
    // "finalize-at-enqueue failed" line here.)
    const unfinalized = await seedSale({ configureFirst: false });
    const early = await getSaleFiscalStatus(unfinalized.tenantId, unfinalized.receipt.orderId);
    expect(early).toEqual({
      docType: "e_receipt", status: "pending",
      etaUuid: null, etaLongId: null, qrPayload: null, qrImageDataUrl: null,
    });

    // The production path: finalized inline, so the printed customer copy
    // carries its uuid and QR before ETA has seen the document (addendum C5).
    const s = await seedSale({ configureFirst: true });
    const pending = await getSaleFiscalStatus(s.tenantId, s.receipt.orderId);
    expect(pending!.status).toBe("pending");
    expect(pending!.etaUuid).toMatch(/^[0-9a-f]{64}$/);
    expect(pending!.qrPayload).toContain(pending!.etaUuid!);
    // Rendered from the STORED payload — never recomputed, since the payload is
    // part of the identity already hashed into the uuid.
    expect(pending!.qrImageDataUrl).toMatch(/^data:image\/png;base64,/);

    await withTenant(s.tenantId, (tx) =>
      tx.update(etaSubmissions)
        .set({ status: "accepted", acceptedAt: new Date(), etaLongId: "LONG-1" })
        .where(eq(etaSubmissions.tenantId, s.tenantId)),
    );

    const accepted = await getSaleFiscalStatus(s.tenantId, s.receipt.orderId);
    expect(accepted!.status).toBe("accepted");
    expect(accepted!.etaUuid).toBe(pending!.etaUuid);
    expect(accepted!.qrPayload).toBe(pending!.qrPayload);
    expect(accepted!.qrImageDataUrl).toBe(pending!.qrImageDataUrl);
    // The receipt family carries a long id too once ETA answers; the footer just
    // prints the QR instead of it.
    expect(accepted!.etaLongId).toBe("LONG-1");
    expect(accepted!.docType).toBe("e_receipt");
  });

  it("returns the CORRECTION, not the rejection it supersedes", async () => {
    const s = await seedSale({ configureFirst: true });
    await withTenant(s.tenantId, (tx) =>
      tx.update(etaSubmissions)
        .set({ status: "rejected", lastError: "InvalidTaxpayer" })
        .where(eq(etaSubmissions.tenantId, s.tenantId)),
    );
    const [rejected] = await withTenant(s.tenantId, (tx) =>
      tx.select().from(etaSubmissions).where(eq(etaSubmissions.tenantId, s.tenantId)),
    );

    const correctionId = await enqueueCorrectedResubmission({ tenantId: s.tenantId }, rejected.id);
    expect(correctionId).not.toBeNull();

    // Both rows share the order, and only the unfiltered lookup index sees
    // both. The correction is the document that counts.
    const status = await getSaleFiscalStatus(s.tenantId, s.receipt.orderId);
    expect(status!.status).toBe("pending");
    expect(status!.etaUuid).toBeNull();
  });

  it("SEES A B2B SALE AT ALL — the invoice family, with ETA's long id", async () => {
    // THE READ-MODEL GAP THIS CLOSES. A B2B sale enqueues an `e_invoice` INSTEAD
    // of an `e_receipt`, so the round-1 `docType = 'e_receipt'` filter found
    // nothing and this returned `null` — which the till cannot tell apart from a
    // non-EG tenant, so it printed no fiscal block whatsoever: no error, no
    // failing row, no log line to find it by.
    const s = await seedSale({ configureFirst: true });
    await withTenant(s.tenantId, (tx) =>
      tx.update(etaSubmissions).set({ docType: "e_invoice", etaUuid: null, qrPayload: null })
        .where(eq(etaSubmissions.tenantId, s.tenantId)));

    const queued = await getSaleFiscalStatus(s.tenantId, s.receipt.orderId);
    expect(queued).not.toBeNull();
    expect(queued!.docType).toBe("e_invoice");
    // An invoice has no QR at any point in its life, so there is nothing to
    // render and nothing to poll for.
    expect(queued!.qrPayload).toBeNull();
    expect(queued!.qrImageDataUrl).toBeNull();
    expect(queued!.etaLongId).toBeNull();

    await withTenant(s.tenantId, (tx) =>
      tx.update(etaSubmissions).set({ status: "accepted", etaLongId: "LONG-INV-1" })
        .where(eq(etaSubmissions.tenantId, s.tenantId)));

    // The long id IS the B2B footer — the only identity a tax invoice can show.
    const accepted = await getSaleFiscalStatus(s.tenantId, s.receipt.orderId);
    expect(accepted!.etaLongId).toBe("LONG-INV-1");
    expect(accepted!.qrImageDataUrl).toBeNull();
  });

  it("resolves an anomalous BOTH-FAMILY order deterministically: accepted wins", async () => {
    // Reachable only through the ONE sanctioned family switch — every receipt
    // rejected, then an invoice issued in its place — and nothing in the schema
    // prevents it (the partial unique indexes are keyed on (tenant, docType,
    // order), so a receipt and an invoice for one sale collide with nothing).
    // Whatever ETA has ACCEPTED is what the sale is, whichever row sorts first.
    const s = await seedSale({ configureFirst: true });
    await withTenant(s.tenantId, (tx) =>
      tx.update(etaSubmissions).set({ status: "rejected" }).where(eq(etaSubmissions.tenantId, s.tenantId)));
    await withTenant(s.tenantId, (tx) => tx.insert(etaSubmissions).values({
      tenantId: s.tenantId, docType: "e_invoice", orderId: s.receipt.orderId,
      status: "accepted", etaLongId: "LONG-ACCEPTED-INV",
    }));

    const status = await getSaleFiscalStatus(s.tenantId, s.receipt.orderId);
    expect(status!.docType).toBe("e_invoice");
    expect(status!.status).toBe("accepted");
    expect(status!.etaLongId).toBe("LONG-ACCEPTED-INV");
  });

  it("resolves two LIVE unaccepted families towards the e_receipt, never the sort", async () => {
    // Rung 3. Two pending rows of different families: `createdAt` alone would
    // resolve a same-instant tie arbitrarily, and swapping a QR the customer has
    // already been handed for an invoice line — both still pending, neither more
    // settled than the other — is the outcome worth ruling out by name.
    const s = await seedSale({ configureFirst: true });
    const [receipt] = await withTenant(s.tenantId, (tx) =>
      tx.select().from(etaSubmissions).where(eq(etaSubmissions.tenantId, s.tenantId)));
    await withTenant(s.tenantId, (tx) => tx.insert(etaSubmissions).values({
      tenantId: s.tenantId, docType: "e_invoice", orderId: s.receipt.orderId,
      status: "pending",
      // NEWER than the receipt, so `createdAt desc` alone would pick it.
      createdAt: new Date(receipt.createdAt.getTime() + 1000),
    }));

    const status = await getSaleFiscalStatus(s.tenantId, s.receipt.orderId);
    expect(status!.docType).toBe("e_receipt");
    expect(status!.etaUuid).toBe(receipt.etaUuid);
  });
});

/** The `orders.status_token` a checkout hands the customer — the whole auth for
 *  `/order/[token]`. Read back rather than passed in, because `recordSale`
 *  allocates it and nothing else knows the value. */
async function statusTokenOf(tenantId: string, orderId: string): Promise<string> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.select({ statusToken: orders.statusToken }).from(orders).where(eq(orders.id, orderId)),
  );
  return row.statusToken;
}

describe("getSaleFiscalStatusByToken", () => {
  it("returns exactly what the order-id read returns, for the same sale", async () => {
    // THE DELEGATION RULE, pinned as an equality rather than trusted to a
    // comment. `getSaleFiscalStatus` owns the widened both-families query and
    // the four-rung precedence; if this function ever grew a query of its own,
    // the two would start answering differently on some order and this is what
    // notices. Walked through every state the page renders, since a second
    // implementation would most plausibly diverge on the unfinalized one.
    const s = await seedSale({ configureFirst: true });
    const token = await statusTokenOf(s.tenantId, s.receipt.orderId);

    const byToken = await getSaleFiscalStatusByToken(s.tenantId, token);
    expect(byToken).toEqual(await getSaleFiscalStatus(s.tenantId, s.receipt.orderId));
    // Non-vacuity: `toEqual(null)` would pass against two nulls, so the value
    // being compared is a real finalized receipt with a QR to show.
    expect(byToken!.docType).toBe("e_receipt");
    expect(byToken!.qrImageDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(byToken!.etaUuid).toMatch(/^[0-9a-f]{64}$/);

    await withTenant(s.tenantId, (tx) =>
      tx.update(etaSubmissions).set({ status: "accepted", etaLongId: "LONG-TOK" })
        .where(eq(etaSubmissions.tenantId, s.tenantId)));
    expect(await getSaleFiscalStatusByToken(s.tenantId, token))
      .toEqual(await getSaleFiscalStatus(s.tenantId, s.receipt.orderId));
  });

  it("SEES A B2B SALE — the round-trip rule applied to the read side", async () => {
    // The optional-field silent-degrade rule, in this task's own form. A B2B
    // sale is filed as an `e_invoice` INSTEAD of an `e_receipt`, so a token read
    // that re-derived the round-1 `docType = 'e_receipt'` filter would return
    // `null` here — and `null` on the status page means "nothing filed yet", so
    // a business customer's tax invoice would render as a pending consumer
    // receipt, silently, with no failing row and no log line.
    const s = await seedSale({ configureFirst: true });
    await withTenant(s.tenantId, (tx) =>
      tx.update(etaSubmissions)
        .set({ docType: "e_invoice", status: "accepted", etaUuid: null, qrPayload: null, etaLongId: "BFNGXFA17265TQX34" })
        .where(eq(etaSubmissions.tenantId, s.tenantId)));

    const byToken = await getSaleFiscalStatusByToken(s.tenantId, await statusTokenOf(s.tenantId, s.receipt.orderId));
    expect(byToken).not.toBeNull();
    expect(byToken!.docType).toBe("e_invoice");
    // The long id IS the storefront's B2B surface — an invoice has no QR at any
    // point in its life, so there is nothing else to show.
    expect(byToken!.etaLongId).toBe("BFNGXFA17265TQX34");
    expect(byToken!.qrImageDataUrl).toBeNull();
  });

  it("is null for a token that names no order — and the miss is indistinguishable", async () => {
    const s = await seedSale({ configureFirst: true });
    const token = await statusTokenOf(s.tenantId, s.receipt.orderId);

    // A wrong token, a near-miss of a real one, and an empty one. All `null`,
    // and identical to the `null` a real order with no fiscal row returns — so
    // someone guessing tokens learns nothing from the difference.
    for (const wrong of ["not-a-token", `${token}x`, token.slice(0, -1), ""]) {
      expect(await getSaleFiscalStatusByToken(s.tenantId, wrong), `token ${JSON.stringify(wrong)}`).toBeNull();
    }
    // Non-vacuity: the RIGHT token against the same tenant is not null, so the
    // loop above is measuring the token and not a broken fixture.
    expect(await getSaleFiscalStatusByToken(s.tenantId, token)).not.toBeNull();
  });

  it("is null for ANOTHER TENANT'S token, even though the token itself is real", async () => {
    // The token is globally unique (`orders.status_token` carries a UNIQUE
    // constraint), so a stranger's token is a valid lookup key everywhere — RLS
    // inside `getOrderByToken` is what refuses it, not a WHERE clause this
    // function could forget. A storefront serving tenant B must never answer
    // about tenant A's sale, however the link was obtained.
    const s = await seedSale({ configureFirst: true });
    const other = await makeTenant();
    const token = await statusTokenOf(s.tenantId, s.receipt.orderId);

    expect(await getSaleFiscalStatusByToken(other.id, token)).toBeNull();
    // Non-vacuity, both halves: the token resolves for its OWN tenant, and the
    // other tenant is a real EG tenant that would have been shown a document if
    // one had been visible to it.
    expect(await getSaleFiscalStatusByToken(s.tenantId, token)).not.toBeNull();
    expect(other.country).toBe("EG");
  });
});

describe("listSubmissions", () => {
  it("returns newest first, paginates, and filters by status", async () => {
    const t = await makeTenant();
    const branch = await makeBranch(t.id);
    for (let i = 0; i < 3; i++) {
      // A row per order: the live partial index caps non-rejected rows at one
      // per (tenant, docType, order), so three pending rows need three orders.
      const order = await makeOrder(t.id, branch.id);
      await withTenant(t.id, (tx) =>
        tx.insert(etaSubmissions).values({
          tenantId: t.id,
          docType: "e_receipt",
          orderId: order.id,
          status: i === 0 ? "rejected" : "pending",
          etaUuid: `uuid-${i}`,
          lastError: i === 0 ? "InvalidTaxpayer" : null,
          attempts: i,
        }),
      );
    }

    const page1 = await listSubmissions(t.id, { limit: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    const page2 = await listSubmissions(t.id, { limit: 2, offset: 2 });
    expect(page2.rows).toHaveLength(1);
    expect(page2.hasMore).toBe(false);

    // Newest first: uuid-2 was inserted last.
    expect(page1.rows[0].etaUuid).toBe("uuid-2");
    expect(page1.rows[0]).toMatchObject({ docType: "e_receipt", status: "pending", attempts: 2 });

    const rejected = await listSubmissions(t.id, { status: "rejected" });
    expect(rejected.rows).toHaveLength(1);
    expect(rejected.rows[0]).toMatchObject({ etaUuid: "uuid-0", lastError: "InvalidTaxpayer" });

    // A hand-built query string cannot ask for the whole fiscal history.
    const capped = await listSubmissions(t.id, { limit: 10_000 });
    expect(capped.rows.length).toBeLessThanOrEqual(50);
  });

  it("getSubmissionStatusCounts counts the WHOLE table, zero-fills every status, and is tenant-scoped", async () => {
    const t = await makeTenant();
    const stranger = await makeTenant();
    const branch = await makeBranch(t.id);

    // Before any document exists: every status present at zero, not an empty
    // object. A chip row built from a sparse map would appear and disappear as
    // documents moved between states.
    expect(await getSubmissionStatusCounts(t.id)).toEqual({
      pending: 0, submitted: 0, accepted: 0, rejected: 0, failed: 0,
    });

    const statuses = ["accepted", "accepted", "rejected", "pending"] as const;
    for (const status of statuses) {
      const order = await makeOrder(t.id, branch.id);
      await withTenant(t.id, (tx) =>
        tx.insert(etaSubmissions).values({
          tenantId: t.id, docType: "e_receipt", orderId: order.id, status,
        }),
      );
    }

    expect(await getSubmissionStatusCounts(t.id)).toEqual({
      pending: 1, submitted: 0, accepted: 2, rejected: 1, failed: 0,
    });

    // It counts the whole table, not a page — which is the entire reason it
    // exists: `listSubmissions` capped at one row would still report one
    // rejection here, and that is the row an owner opened the screen to find.
    const page = await listSubmissions(t.id, { limit: 1 });
    expect(page.rows).toHaveLength(1);
    expect((await getSubmissionStatusCounts(t.id)).accepted).toBe(2);

    // RLS: another tenant sees zeros, not this tenant's four documents.
    expect(await getSubmissionStatusCounts(stranger.id)).toEqual({
      pending: 0, submitted: 0, accepted: 0, rejected: 0, failed: 0,
    });
  });

  it("getSubmissionById is tenant-scoped and returns null for a stranger's row", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const order = await makeOrder(a.id, (await makeBranch(a.id)).id);
    const [row] = await withTenant(a.id, (tx) =>
      tx.insert(etaSubmissions)
        .values({ tenantId: a.id, docType: "e_receipt", orderId: order.id, status: "rejected" })
        .returning(),
    );
    expect((await getSubmissionById(a.id, row.id))!.status).toBe("rejected");
    expect(await getSubmissionById(b.id, row.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// B2B invoice trigger
// ---------------------------------------------------------------------------

const B2B_BUYER = (): RequestB2bInvoiceBuyer => ({
  rin: "313717919",
  name: "Receiver Company LLC",
  address: {
    country: "EG",
    governate: "Cairo",
    regionCity: "Nasr City",
    street: "580 Clementina Key",
    buildingNumber: "Bldg. 0",
  },
});

/** `B2B_BUYER()` with one field blanked, at a dotted path. */
function buyerWithout(path: string): RequestB2bInvoiceBuyer {
  const buyer = B2B_BUYER();
  if (path.startsWith("address.")) {
    const key = path.slice("address.".length) as keyof RequestB2bInvoiceBuyer["address"];
    return { ...buyer, address: { ...buyer.address, [key]: "" } };
  }
  return { ...buyer, [path as "rin" | "name"]: "" };
}

const invoiceRows = (tenantId: string) =>
  withTenant(tenantId, (tx) =>
    tx.select().from(etaSubmissions).where(eq(etaSubmissions.docType, "e_invoice")),
  );

/** Drops every `e_receipt` row for a tenant. See `seedInvoiceableSale`. */
const clearReceiptRows = (tenantId: string) =>
  withTenant(tenantId, (tx) => tx.delete(etaSubmissions).where(eq(etaSubmissions.docType, "e_receipt")));

/**
 * A sale that a B2B invoice may actually be issued for: rung through the real
 * POS path, then with its `e_receipt` row removed.
 *
 * WHY THE REMOVAL IS NOT A CHEAT. Under ONE SALE, ONE DOCUMENT FAMILY, an order
 * carrying a live receipt can never be invoiced — so a fixture that rings a sale
 * and leaves its receipt in place cannot exercise the trigger's success path at
 * all. The state constructed here is genuinely reachable today (`recordSale`
 * swallows a failed enqueue by the iron rule, and an online order carries no row
 * until the reconciliation sweep adopts it minutes later), and it is the state
 * every B2B sale will be in once round-2 Task 5 lands: the till will enqueue an
 * `e_invoice` INSTEAD of an `e_receipt`, so a real business sale never has a
 * receipt row to begin with. Until that exists, this is how the tests reach it.
 *
 * The tests that DO want a receipt present — the cross-family 409 and the one
 * permitted family switch — use `seedSale` directly and say so.
 */
async function seedInvoiceableSale() {
  const s = await seedSale({ configureFirst: true });
  await clearReceiptRows(s.tenantId);
  return s;
}

const auditRows = (tenantId: string) =>
  withTenant(tenantId, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.tenantId, tenantId)));

describe("requestB2bInvoice — buyer validation", () => {
  it("names EVERY one of the seven mandatory fields, at its own path", async () => {
    const s = await seedInvoiceableSale();

    // The whole point of validating HERE rather than in the worker: each of
    // these is a form error with the operator still looking at the form, not a
    // `failed` submission row and an owner alert hours later.
    const paths = [
      "rin",
      "name",
      "address.country",
      "address.governate",
      "address.regionCity",
      "address.street",
      "address.buildingNumber",
    ];
    for (const path of paths) {
      await expectRejected(
        () => requestB2bInvoice(s.tenantId, s.receipt.orderId, buyerWithout(path)),
        { path },
      );
    }

    // Refused means refused: seven rejected attempts, zero rows.
    expect(await invoiceRows(s.tenantId)).toEqual([]);
  });

  it("holds the buyer's RIN to exactly the shape the seller's is held to", async () => {
    const s = await seedInvoiceableSale();
    // A document naming a 9-digit issuer and an 8-digit receiver is not well
    // formed — ETA's Registration Identification Number is one kind of value.
    for (const rin of ["12345678", "1234567890", "20017370x", "200 173 707", ""]) {
      await expectRejected(
        () => requestB2bInvoice(s.tenantId, s.receipt.orderId, { ...B2B_BUYER(), rin }),
        { path: "rin", match: /9 digits/ },
      );
    }
    const ok = await requestB2bInvoice(s.tenantId, s.receipt.orderId, { ...B2B_BUYER(), rin: " 313717919 " });
    // Trimmed on the way in, like every other text field this service takes.
    expect(ok.ok).toBe(true);
    const [row] = await invoiceRows(s.tenantId);
    expect(row.buyerJson!.rin).toBe("313717919");
  });

  it("validates the buyer BEFORE the order lookup — the operator's own typing comes first", async () => {
    const s = await seedInvoiceableSale();
    // Both the order id and the buyer are wrong. The buyer is the half they can
    // see and fix, so it is what they are told about.
    await expectRejected(
      () => requestB2bInvoice(s.tenantId, "00000000-0000-4000-8000-000000000000", buyerWithout("name")),
      { path: "name" },
    );
  });
});

describe("requestB2bInvoice — ownership and the live-invoice ladder", () => {
  it("404s an unknown order, a malformed id, and another tenant's order alike", async () => {
    const mine = await seedInvoiceableSale();
    const theirs = await seedInvoiceableSale();

    for (const orderId of ["00000000-0000-4000-8000-000000000000", "not-a-uuid", theirs.receipt.orderId]) {
      const outcome = await requestB2bInvoice(mine.tenantId, orderId, B2B_BUYER());
      expect(outcome, orderId).toEqual({ ok: false, status: 404, error: "Order not found" });
    }

    // Identical answers on purpose: a foreign order must not be distinguishable
    // from a fictional one. And nothing was written to either tenant.
    expect(await invoiceRows(mine.tenantId)).toEqual([]);
    expect(await invoiceRows(theirs.tenantId)).toEqual([]);
  });

  it("409s a second request — one live invoice per sale, or the sale is declared twice", async () => {
    const s = await seedInvoiceableSale();

    const first = await requestB2bInvoice(s.tenantId, s.receipt.orderId, B2B_BUYER());
    expect(first.ok).toBe(true);

    const second = await requestB2bInvoice(s.tenantId, s.receipt.orderId, B2B_BUYER());
    expect(second).toMatchObject({ ok: false, status: 409 });
    expect((second as { error: string }).error).toMatch(/already has a tax invoice/);

    // The pre-check is the friendly face of `eta_submissions_order`; the index
    // is what actually holds. Either way there is exactly one row.
    expect(await invoiceRows(s.tenantId)).toHaveLength(1);
  });

  it("409s the loser of two CONCURRENT requests rather than letting it overwrite the winner", async () => {
    const s = await seedInvoiceableSale();

    // WHAT THIS PINS, STATED PRECISELY, because the obvious reading is wrong.
    // It pins the OUTCOME of two overlapping calls — one row, one audit event,
    // exactly one `ok` — and NOT which of the two refusals produced it. Measured
    // by disabling the post-enqueue `buyerJson` backstop and re-running: this
    // test stays green, because the first call commits before the second's
    // pre-check reads, so the pre-check is what refuses here. The backstop
    // covers the window this suite cannot open (two processes, not two promises
    // on one pool) and is labelled as such at its own site. Do not "simplify" it
    // away on the strength of this test passing.
    const other = { ...B2B_BUYER(), rin: "100000009", name: "Someone Else LLC" };
    const results = await Promise.all([
      requestB2bInvoice(s.tenantId, s.receipt.orderId, B2B_BUYER()),
      requestB2bInvoice(s.tenantId, s.receipt.orderId, other),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toMatchObject([{ status: 409 }]);

    const rows = await invoiceRows(s.tenantId);
    expect(rows).toHaveLength(1);
    // The WINNER's buyer stands — whichever it was; what must not happen is a
    // row carrying one caller's buyer while the other was told it succeeded.
    expect([B2B_BUYER(), other]).toContainEqual(rows[0].buyerJson);
    const requested = (await auditRows(s.tenantId)).filter((e) => e.action === "eta.invoice.requested");
    expect(requested).toHaveLength(1);
  });

  it("409s a REJECTED invoice by pointing at the correction path, not by silently no-opping", async () => {
    const s = await seedInvoiceableSale();
    await requestB2bInvoice(s.tenantId, s.receipt.orderId, B2B_BUYER());
    await withTenant(s.tenantId, (tx) =>
      tx.update(etaSubmissions)
        .set({ status: "rejected", lastError: "InvalidTaxpayer" })
        .where(eq(etaSubmissions.docType, "e_invoice")),
    );

    // The LIVE index would admit this insert (every row is rejected); the
    // ORIGINAL index would not. Without the pre-check `onConflictDoNothing`
    // would no-op and the operator would get a success toast and no invoice.
    const outcome = await requestB2bInvoice(s.tenantId, s.receipt.orderId, B2B_BUYER());
    expect(outcome).toMatchObject({ ok: false, status: 409 });
    expect((outcome as { error: string }).error).toMatch(/corrected resubmission/);
    expect(await invoiceRows(s.tenantId)).toHaveLength(1);
  });

  it("409s an order already filed as an e-receipt — ONE SALE, ONE DOCUMENT FAMILY", async () => {
    // `seedSale` rings a real POS sale, so the order already carries a live
    // `e_receipt`. Two accepted documents for one sale is that sale declared
    // twice in the taxpayer's filings — the same harm the in-family check
    // refuses, one step wider, and the partial unique indexes cannot see it
    // (they are keyed on (tenant, docType, order), so a receipt and an invoice
    // collide with nothing). This rung is the only thing enforcing it.
    const s = await seedSale({ configureFirst: true });
    const [receipt] = await withTenant(s.tenantId, (tx) =>
      tx.select().from(etaSubmissions).where(eq(etaSubmissions.docType, "e_receipt")),
    );
    expect(receipt.status).not.toBe("rejected");

    const outcome = await requestB2bInvoice(s.tenantId, s.receipt.orderId, B2B_BUYER());
    expect(outcome).toMatchObject({ ok: false, status: 409 });
    const error = (outcome as { error: string }).error;
    // Names the document that stands in the way, its status, and the reason the
    // ordinary workflow it blocks is unavailable rather than forbidden.
    expect(error).toContain(String(s.receipt.orderNumber));
    expect(error).toContain(`e-receipt (${receipt.status})`);
    expect(error).toMatch(/VERIFY-12/);
    expect(await invoiceRows(s.tenantId)).toEqual([]);

    // ACCEPTED counts too, not just pending: a filed document is exactly the one
    // that must not be doubled.
    await withTenant(s.tenantId, (tx) =>
      tx.update(etaSubmissions).set({ status: "accepted", acceptedAt: new Date() })
        .where(eq(etaSubmissions.docType, "e_receipt")),
    );
    expect(await requestB2bInvoice(s.tenantId, s.receipt.orderId, B2B_BUYER())).toMatchObject({ status: 409 });

    // And a rejected receipt whose CORRECTION is in flight still blocks — the
    // correction is itself a non-rejected `e_receipt` row for this order, which
    // is why "non-rejected" is the whole test and `referenceOldUuid` never has
    // to be reasoned about.
    await withTenant(s.tenantId, (tx) =>
      tx.update(etaSubmissions).set({ status: "rejected", lastError: "InvalidTaxpayer" })
        .where(eq(etaSubmissions.docType, "e_receipt")),
    );
    expect(await enqueueCorrectedResubmission({ tenantId: s.tenantId }, receipt.id)).not.toBeNull();
    expect(await requestB2bInvoice(s.tenantId, s.receipt.orderId, B2B_BUYER())).toMatchObject({ status: 409 });
    expect(await invoiceRows(s.tenantId)).toEqual([]);
  });

  it("ALLOWS the one family switch: every receipt rejected and no correction queued", async () => {
    // The deliberate hole in the rule above. ETA holds no document for this sale
    // at all, so refusing would leave it permanently UNDECLARED — strictly worse
    // than the double-declaration the rule prevents, because there is nothing to
    // double. The invoice becomes the sale's first and only filing.
    const s = await seedSale({ configureFirst: true });
    await withTenant(s.tenantId, (tx) =>
      tx.update(etaSubmissions).set({ status: "rejected", lastError: "InvalidTaxpayer" })
        .where(eq(etaSubmissions.docType, "e_receipt")),
    );

    const outcome = await requestB2bInvoice(s.tenantId, s.receipt.orderId, B2B_BUYER());
    expect(outcome.ok).toBe(true);
    const [invoice] = await invoiceRows(s.tenantId);
    expect(invoice.buyerJson).toEqual(B2B_BUYER());
    // The rejected receipt is left exactly as ETA left it — under the same
    // 5-year retention as every other fiscal record, superseded by nothing.
    const receipts = await withTenant(s.tenantId, (tx) =>
      tx.select().from(etaSubmissions).where(eq(etaSubmissions.docType, "e_receipt")),
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0].status).toBe("rejected");
  });

  it("409s a cancelled or rejected order — a cancelled sale has nothing to invoice", async () => {
    for (const status of ["cancelled", "rejected"] as const) {
      const s = await seedInvoiceableSale();
      await withTenant(s.tenantId, (tx) =>
        tx.update(orders).set({ status }).where(eq(orders.id, s.receipt.orderId)),
      );

      const outcome = await requestB2bInvoice(s.tenantId, s.receipt.orderId, B2B_BUYER());
      expect(outcome, status).toMatchObject({ ok: false, status: 409 });
      // Refused in the SERVICE, not only by hiding the dashboard button: the
      // API cannot be allowed to do what the button will not.
      expect(await invoiceRows(s.tenantId)).toEqual([]);
    }
  });
});

describe("requestB2bInvoice — the happy path", () => {
  it("queues the invoice, captures the buyer in buyer_json, and audits who asked", async () => {
    const s = await seedInvoiceableSale();

    const outcome = await requestB2bInvoice(s.tenantId, s.receipt.orderId, B2B_BUYER(), {
      actorUserId: s.ctx.cashierUserId,
      actorType: "user",
      roleKey: "owner",
      fingerprint: emptyFingerprint(),
    });
    expect(outcome.ok).toBe(true);
    const submissionId = (outcome as { submissionId: string }).submissionId;

    const [row] = await invoiceRows(s.tenantId);
    expect(row.id).toBe(submissionId);
    expect(row).toMatchObject({ docType: "e_invoice", orderId: s.receipt.orderId, refundId: null });
    // THE CAPTURE. Round-trips through jsonb unchanged — it is input, not the
    // hashed document, which is exactly why this column may be jsonb while
    // `request_json` may not.
    expect(row.buyerJson).toEqual(B2B_BUYER());

    const requested = (await auditRows(s.tenantId)).filter((e) => e.action === "eta.invoice.requested");
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({
      entityType: "eta_submission",
      entityId: submissionId,
      actorType: "user",
      actorUserId: s.ctx.cashierUserId,
    });
    expect(requested[0].metadata).toMatchObject({ orderId: s.receipt.orderId, docType: "e_invoice" });

    // FIELD NAMES, NEVER VALUES — the same rule eta.config.updated keeps, biting
    // here on something that is not a credential. Audit rows are readable by
    // every audit:view holder, which is wider than fiscal:manage; the record of
    // WHO was invoiced is the filed document and `buyer_json`, not this row.
    expect(requested[0].metadata).toMatchObject({ buyerFields: ["rin", "name", "address"] });
    const metadata = JSON.stringify(requested[0].metadata);
    expect(metadata).not.toContain("313717919");
    expect(metadata).not.toContain("Receiver Company LLC");
  });

  it("finalizes immediately after the commit, so bad config surfaces at the form", async () => {
    const s = await seedInvoiceableSale();
    await requestB2bInvoice(s.tenantId, s.receipt.orderId, B2B_BUYER());

    // The best-effort finalize has already run by the time the call returns:
    // there is no QR deadline here, but building the document is what discovers
    // an unclassified product or a missing branch address, and doing it now puts
    // that in front of an operator who is still on the page.
    const [row] = await invoiceRows(s.tenantId);
    const wire = row.requestJson as Record<string, unknown>;
    expect(Array.isArray(wire.invoiceLines)).toBe(true);
    expect(wire.documentType).toBe("I");
    expect(wire.internalID).toBe(String(s.receipt.orderNumber));
    // The captured buyer became the filed receiver — the two records agree.
    expect(wire.receiver).toMatchObject({ type: "B", id: "313717919", name: "Receiver Company LLC" });
    // And the capture SURVIVES the wire write; it is a separate column now.
    expect(row.buyerJson).toEqual(B2B_BUYER());
    // Nothing local claims an invoice's identity — ETA assigns it.
    expect(row.etaUuid).toBeNull();
    expect(row.qrPayload).toBeNull();
  });

  it("never fails the request when the finalize cannot build a document", async () => {
    // The product's ETA classification is removed, so the build throws inside
    // `finalizeAfterCommit`. (One expected "finalize-at-request failed" line is
    // logged here.)
    const s = await seedInvoiceableSale();
    await withTenant(s.tenantId, (tx) => tx.delete(productTaxCodes));

    const outcome = await requestB2bInvoice(s.tenantId, s.receipt.orderId, B2B_BUYER());
    // The request SUCCEEDED: the row is the durable part and the worker will
    // finalize it on its next pass. Reporting a failed request would be a lie.
    expect(outcome.ok).toBe(true);
    const [row] = await invoiceRows(s.tenantId);
    expect(row.status).toBe("pending");
    expect(row.requestJson).toEqual({});
    expect(row.buyerJson).toEqual(B2B_BUYER());
  });

  it("two live invoices can never share an internalID — the match key enqueue.ts asked to be asserted", async () => {
    // `internalID` is `String(order.orderNumber)`, and ETA keys BOTH
    // acceptedDocuments and rejectedDocuments on it because an invoice has no
    // uuid at submission. Two live invoices sharing one value would cross-map
    // ETA's assigned uuid/longId onto the wrong document.
    const s = await seedInvoiceableSale();
    const second = await recordSale(s.ctx, {
      clientOrderId: `internalid-${n++}`,
      lines: [{ productId: s.productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: s.total,
      payments: [{ clientPaymentId: "p-1", method: "cash", amount: s.total, tenderedAmount: s.total }],
    });
    // The second sale rang its own `e_receipt`, which ONE SALE, ONE DOCUMENT
    // FAMILY would refuse an invoice for — see `seedInvoiceableSale`.
    await clearReceiptRows(s.tenantId);

    await requestB2bInvoice(s.tenantId, s.receipt.orderId, B2B_BUYER());
    await requestB2bInvoice(s.tenantId, second.orderId, B2B_BUYER());
    // And a repeat of either is refused, which is the second half of the
    // property: at most one LIVE invoice per order.
    expect(await requestB2bInvoice(s.tenantId, s.receipt.orderId, B2B_BUYER())).toMatchObject({ status: 409 });

    const internalIds = (await invoiceRows(s.tenantId))
      .map((row) => (row.requestJson as { internalID?: string }).internalID);
    expect(internalIds).toHaveLength(2);
    expect(new Set(internalIds).size).toBe(2);
    // orderNumber is allocated MAX+1 under placeOrder's per-tenant advisory
    // lock, which is what makes order -> internalID injective in the first place.
    expect(internalIds).toContain(String(s.receipt.orderNumber));
    expect(internalIds).toContain(String(second.orderNumber));

    // THE CAVEAT THIS CANNOT COVER, restated where someone would try to extend
    // the test: ETA scopes identity per TAXPAYER (RIN), not per ServeOS tenant,
    // and two tenants sharing one registration number are invisible to each
    // other under RLS. See `requestB2bInvoice`'s JSDoc — operational constraint,
    // not an assertion this or any query inside `withTenant` could make.
  });

  it("leaks no reference through the trigger's outcome or its audit row", async () => {
    // By RULE rather than by judgement, exactly like the read-surface walk
    // above: `buyer_json` holds no credential and the outcome is an id, but the
    // masking guarantee is kept as "nothing ever leaves", so every new surface
    // joins the walk whether or not it could plausibly carry one.
    const s = await seedInvoiceableSale();
    await withTenant(s.tenantId, (tx) =>
      tx.update(etaTenantConfig).set({ signingKeyRef: REFS.signing }).where(eq(etaTenantConfig.tenantId, s.tenantId)),
    );

    const outcome = await requestB2bInvoice(s.tenantId, s.receipt.orderId, B2B_BUYER());
    expectNoRefValues(outcome, "requestB2bInvoice");
    expectNoRefValues(await auditRows(s.tenantId), "audit_events (eta.invoice.requested)");
    // The submission row itself is not a read SURFACE — nothing returns it to a
    // client — but it is what the finalize wrote under a configured e-seal ref,
    // so it is walked too.
    expectNoRefValues(await invoiceRows(s.tenantId), "eta_submissions after the trigger");
  });
});

/**
 * THE BUYER REGISTRATION NUMBER CROSSES A MODULE-GRAPH BOUNDARY, AND NOTHING
 * ELSE CAN CATCH IT DRIFTING.
 *
 * `rinSchema` (config-service.ts) is the authority on what an ETA Registration
 * Identification Number looks like, and `apps/pos/src/fiscal/buyer.ts`'s
 * `BUYER_RIN_RE` is a hand-written copy of it — the till validates the buyer
 * BEFORE the sale is sent, because the alternative is discovering a mistyped
 * number inside the worker as a permanent failure hours after the customer has
 * left.
 *
 * THE COPY CANNOT BE REPLACED BY AN IMPORT. The renderer is a separate Electron
 * bundle with its own tsconfig and no path into the Next.js server tree, and
 * pulling `config-service.ts` across would put zod, an audit writer and 1,300
 * lines of configuration onto the module graph of every till transaction.
 *
 * NOR CAN IT BE CHECKED FROM EITHER SIDE ALONE. `buyer.test.ts` cannot reach
 * `rinSchema`: asserting `BUYER_RIN_RE` against nine digits only asserts the
 * regex against ITSELF, and stays green through any change to the server's rule
 * — a guard that cannot fail is not a guard. The only mechanism that can fail on
 * drift is one that reads the other file as TEXT, which is what this does, in
 * the same shape as `sign-invoice.test.ts`'s unreachability scan.
 *
 * THE CONSEQUENCE OF UNDETECTED DRIFT IS SPECIFIC: the till accepts a number the
 * server's own schema would refuse, the sale is filed as a B2B invoice anyway
 * (the sale path carries no zod, by design), and `buildInvoice` refuses it into
 * a `failed` row — the exact failure the till form exists to prevent,
 * reintroduced silently.
 */
describe("the buyer RIN regex does not drift across the server/till boundary", () => {
  const SERVER_MODULE = "src/server/fiscal/config-service.ts";
  const TILL_MODULE = "apps/pos/src/fiscal/buyer.ts";

  /** The pattern as it is SPELLED IN SOURCE. `String.raw` so the backslash here
   *  is the same character the two files carry. */
  const RIN_LITERAL = String.raw`/^\d{9}$/`;

  /**
   * The DECLARATION lines for a name — `const X =` / `export const X =`,
   * anchored to the start of the line so a mention inside a comment or a doc
   * block is not one.
   *
   * ANCHORING IS NOT TIDINESS, it is the difference between a live guard and a
   * dead one, and this test found that out by failing: a substring search takes
   * the FIRST line naming the constant, and the moment `buyer.ts` grew a doc
   * comment mentioning `BUYER_RIN_RE` above the declaration, that comment
   * shadowed it and the scan reported drift that did not exist. The same
   * mechanism in reverse is how it would have rotted into a green no-op — a
   * comment carrying the old literal above a changed declaration.
   */
  const declarationLines = (source: string, name: string): string[] =>
    source
      .split("\n")
      .filter((line) => new RegExp(String.raw`^\s*(export\s+)?const\s+${name}\s*=`).test(line));

  /** The scan, as one function, so the liveness checks below run the SAME
   *  predicate against planted sources rather than a lookalike of it. */
  const declaresRinLiteral = (source: string, name: string): boolean => {
    const lines = declarationLines(source, name);
    // EXACTLY ONE, so a second declaration added elsewhere cannot satisfy this
    // while the real one drifts — and so a rename that leaves no declaration at
    // all fails rather than passing vacuously.
    return lines.length === 1 && lines[0].includes(RIN_LITERAL);
  };

  it("is the same literal in `rinSchema` and in the till's `BUYER_RIN_RE`", () => {
    const server = readFileSync(SERVER_MODULE, "utf8");
    const till = readFileSync(TILL_MODULE, "utf8");

    // Non-vacuity first: a scan that read nothing — or read a file since renamed
    // away — proves nothing. Floors rather than pins, so ordinary growth passes.
    expect(server.length).toBeGreaterThan(10_000);
    expect(till.length).toBeGreaterThan(1_000);

    // Pinned to each DECLARATION rather than to the file, so moving the pattern
    // onto some unrelated line — or leaving a stale copy in a comment above a
    // changed declaration — does not satisfy it.
    expect(
      declaresRinLiteral(server, "rinSchema"),
      `${SERVER_MODULE}'s rinSchema no longer declares ${RIN_LITERAL}. It is the authority on ETA's ` +
        `Registration Identification Number, and ${TILL_MODULE} carries a hand-written copy that cannot ` +
        "import it (separate Electron bundle; zod must stay off the sale path). Change BOTH, in one commit.",
    ).toBe(true);

    expect(
      declaresRinLiteral(till, "BUYER_RIN_RE"),
      `${TILL_MODULE}'s BUYER_RIN_RE no longer declares ${RIN_LITERAL}, so the till now accepts (or refuses) ` +
        `buyer registration numbers that ${SERVER_MODULE}'s rinSchema does not. The till validates BEFORE the ` +
        "sale is sent and the sale path carries no zod, so drift here surfaces as a `failed` invoice row hours " +
        "later — the exact failure that form exists to prevent. Change BOTH, in one commit.",
    ).toBe(true);
  });

  it("the scan is live in BOTH directions — a changed literal fails, a lookalike does not pass", () => {
    // Catches the real declarations, in both spellings.
    expect(declaresRinLiteral(String.raw`const rinSchema = z.string().regex(/^\d{9}$/, "…");`, "rinSchema")).toBe(true);
    expect(declaresRinLiteral(String.raw`export const BUYER_RIN_RE = /^\d{9}$/;`, "BUYER_RIN_RE")).toBe(true);

    // FAILS on the drift it exists to find: a different digit count, a relaxed
    // pattern, or the declaration removed outright.
    expect(declaresRinLiteral(String.raw`const rinSchema = z.string().regex(/^\d{8}$/, "…");`, "rinSchema")).toBe(false);
    expect(declaresRinLiteral(String.raw`export const BUYER_RIN_RE = /^\d+$/;`, "BUYER_RIN_RE")).toBe(false);
    expect(declaresRinLiteral("const rinSchema = z.string().min(9);", "rinSchema")).toBe(false);
    expect(declaresRinLiteral("const somethingElse = 1;", "rinSchema")).toBe(false);

    // A COMMENT IS NOT A DECLARATION, in either direction — and this pair is
    // here because the naive substring version of this predicate got both wrong
    // when it was first run against the real files.
    //
    // (1) A stale copy carrying the OLD literal above a changed declaration must
    //     not satisfy the scan: that is how this guard would rot into a green
    //     no-op while the till quietly accepted eight-digit numbers.
    const staleComment = [
      String.raw`// was /^\d{9}$/ before we relaxed it`,
      String.raw`export const BUYER_RIN_RE = /^\d{8}$/;`,
    ].join("\n");
    expect(declaresRinLiteral(staleComment, "BUYER_RIN_RE")).toBe(false);

    // (2) And a doc block that merely NAMES the constant above a correct
    //     declaration must not fail it — the false alarm this predicate
    //     actually produced before it was anchored. `buyer.ts` carries exactly
    //     this shape today.
    const documented = [
      " * `BUYER_RIN_RE` is scanned from the server side; do not rename it.",
      " */",
      String.raw`export const BUYER_RIN_RE = /^\d{9}$/;`,
    ].join("\n");
    expect(declaresRinLiteral(documented, "BUYER_RIN_RE")).toBe(true);

    // TWO declarations is a failure, not a pass: a second copy added elsewhere
    // must not cover for the real one drifting.
    const duplicated = [
      String.raw`export const BUYER_RIN_RE = /^\d{9}$/;`,
      String.raw`const BUYER_RIN_RE = /^\d{8}$/;`,
    ].join("\n");
    expect(declaresRinLiteral(duplicated, "BUYER_RIN_RE")).toBe(false);
  });
});
