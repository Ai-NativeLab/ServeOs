import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { orders } from "@/server/ordering/schema";
import { users } from "@/server/auth/schema";
import { posDevices } from "@/server/pos/schema";
import { auditEvents } from "@/server/audit/schema";
import { seedPosContext, openShiftForCtx } from "@/server/pos/test-helpers";
import { recordSale } from "@/server/pos/record-sale";
import {
  etaSubmissions,
  etaTenantConfig,
  etaPosCredentials,
  productTaxCodes,
  type EtaWireContextConfig,
} from "./schema";
import { enqueueCorrectedResubmission } from "./enqueue";
import { resolveEtaConfig } from "./config";
import {
  FiscalConfigInputError,
  getDeviceCredential,
  getFiscalConfig,
  listDeviceCredentials,
  listFiscalDevices,
  updateFiscalConfig,
  upsertDeviceCredential,
  type UpdateFiscalConfigInput,
  type UpsertDeviceCredentialInput,
} from "./config-service";
// The READ surfaces live next door (`./read-model`, split along the permission
// seam) but are tested from HERE on purpose — see this file's header: the
// masking walk has to cover both modules from one place or it becomes two half
// guarantees that can drift apart.
import {
  getSaleFiscalStatus,
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
 *  summary line is exactly the leak this guards against. */
function expectNoRefValues(payload: unknown, what: string) {
  const strings = deepStrings(payload);
  for (const forbidden of FORBIDDEN) {
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
      }).returning(),
    );

    const submissions = await listSubmissions(t.id);
    const saleStatus = await getSaleFiscalStatus(t.id, order.id);
    const one = await getSubmissionById(t.id, row.id);
    const statusCounts = await getSubmissionStatusCounts(t.id);
    const fiscalDevices = await listFiscalDevices(t.id);

    expectNoRefValues(submissions, "listSubmissions");
    expectNoRefValues(saleStatus, "getSaleFiscalStatus");
    expectNoRefValues(one, "getSubmissionById");
    // Numbers under fixed enum keys — nothing here could carry a reference
    // today, and it is walked anyway so that stays true if the shape grows.
    expectNoRefValues(statusCounts, "getSubmissionStatusCounts");
    expectNoRefValues(fiscalDevices, "listFiscalDevices");

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
     * The distinction is only legible because this file stores its refs in the
     * `env://KEY` spelling. `resolveSecretRef` accepts a BARE key too, and a
     * deployment using that spelling would make the stored column value and the
     * error's key name the same characters — which is precisely why config.ts's
     * stance has to be a considered decision rather than an accident of format.
     */
    expect(one!.lastError).toContain("ZZ_ETA_ERP_SECRET_SENTINEL");

    // And the walk is LIVE on all four shapes — the nested array, the wrapper
    // object, the flat record and the plain list. Planting a reference where an
    // accidental leak would actually land must fail, or the four assertions
    // above prove nothing.
    const planted: [string, unknown][] = [
      ["listSubmissions", { ...submissions, rows: [{ ...submissions.rows[0], lastError: REFS.erp }] }],
      ["getSaleFiscalStatus", { ...saleStatus, qrPayload: REFS.signing }],
      ["getSubmissionById", { ...one, lastError: SECRET_VALUES.ZZ_ETA_DEVICE_S1_SENTINEL }],
      ["listFiscalDevices", [{ ...fiscalDevices[0], label: REFS.psk }]],
    ];
    for (const [what, payload] of planted) {
      expect(() => expectNoRefValues(payload, what), `${what}'s walk did not catch a planted reference`).toThrow();
    }
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
    expect(early).toEqual({ status: "pending", etaUuid: null, qrPayload: null, qrImageDataUrl: null });

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
