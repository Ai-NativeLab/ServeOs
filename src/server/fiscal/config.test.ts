import { describe, it, expect, afterEach } from "vitest";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { users } from "@/server/auth/schema";
import { posDevices } from "@/server/pos/schema";
import { etaTenantConfig, etaPosCredentials } from "./schema";
import { resolveEtaConfig } from "./config";
import { EtaConfigError } from "./eta-transport-errors";

/**
 * Runs against the real test Postgres (the house pattern — rows are seeded
 * through `withTenant`, so RLS is exercised on the way in as well as out).
 *
 * Secrets live in `process.env` under these keys for the duration of a test
 * and are removed afterwards; the *_REF columns only ever hold the key names.
 */
const ERP_SECRET_KEY = "TEST_ETA_ERP_SECRET";
const SIGNING_KEY = "TEST_ETA_SIGNING_KEY";
const SECRET_1_KEY = "TEST_ETA_DEVICE_SECRET_1";
const SECRET_2_KEY = "TEST_ETA_DEVICE_SECRET_2";
const PSK_KEY = "TEST_ETA_DEVICE_PSK";
const ALL_KEYS = [ERP_SECRET_KEY, SIGNING_KEY, SECRET_1_KEY, SECRET_2_KEY, PSK_KEY];

function setSecrets() {
  process.env[ERP_SECRET_KEY] = "erp-secret-value";
  process.env[SIGNING_KEY] = "signing-key-value";
  process.env[SECRET_1_KEY] = "device-secret-1-value";
  process.env[SECRET_2_KEY] = "device-secret-2-value";
  process.env[PSK_KEY] = "device-psk-value";
}

afterEach(() => {
  for (const key of ALL_KEYS) delete process.env[key];
});

async function makeTenant(slug: string) {
  const [tenant] = await db.insert(tenants).values({ slug, name: "Fiscal Co", country: "EG" }).returning();
  return tenant;
}

/** A paired POS device — `pos_devices` needs a branch and a creating user.
 *  `branches` is RLS-backed, so its insert goes through `withTenant`;
 *  `users`/`pos_devices` are control-plane tables without RLS. */
async function makeDevice(tenantId: string, label: string) {
  const [branch] = await withTenant(tenantId, (tx) =>
    tx.insert(branches).values({ tenantId, name: "Main" }).returning(),
  );
  const [user] = await db.insert(users).values({ tenantId, name: "Owner", email: `${label}@example.test` }).returning();
  const [device] = await db
    .insert(posDevices)
    .values({ tenantId, branchId: branch.id, token: `tok-${label}`, label, createdByUserId: user.id })
    .returning();
  return device;
}

type TenantConfigOverrides = Partial<typeof etaTenantConfig.$inferInsert>;

async function seedTenantConfig(tenantId: string, overrides: TenantConfigOverrides = {}) {
  await withTenant(tenantId, (tx) =>
    tx.insert(etaTenantConfig).values({
      tenantId,
      registrationNumber: "200173707",
      clientId: "erp-client-id",
      clientSecretRef: ERP_SECRET_KEY,
      environment: "preprod",
      activationStatus: "active",
      ...overrides,
    }),
  );
}

type DeviceCredOverrides = Partial<typeof etaPosCredentials.$inferInsert>;

async function seedDeviceCredential(tenantId: string, deviceId: string, overrides: DeviceCredOverrides = {}) {
  await withTenant(tenantId, (tx) =>
    tx.insert(etaPosCredentials).values({
      tenantId,
      deviceId,
      etaSerial: "POS-001",
      clientId: "device-client-id",
      clientSecret1Ref: SECRET_1_KEY,
      clientSecret2Ref: SECRET_2_KEY,
      presharedKeyRef: PSK_KEY,
      posOsVersion: "IOS",
      posModelFramework: "1",
      status: "active",
      ...overrides,
    }),
  );
}

describe("resolveEtaConfig — tenant-level config", () => {
  it("resolves an active tenant's config, mapping registration_number to rin", async () => {
    setSecrets();
    const tenant = await makeTenant("eta-active");
    await seedTenantConfig(tenant.id, { signingKeyRef: SIGNING_KEY });

    const cfg = await resolveEtaConfig(tenant.id);
    expect(cfg).not.toBeNull();
    // ETA calls it the RIN; the column predates that spelling.
    expect(cfg!.rin).toBe("200173707");
    expect(cfg!.environment).toBe("preprod");
    expect(cfg!.erp.clientId).toBe("erp-client-id");
    expect(cfg!.erp.clientSecret()).toBe("erp-secret-value");
    // The thunk is why an accidental serialization cannot leak the ERP secret:
    // JSON.stringify drops function values outright.
    expect(JSON.stringify(cfg!.erp)).toBe('{"clientId":"erp-client-id"}');
    expect(cfg!.signingKey()).toBe("signing-key-value");
    // A thunk for the same reason erp.clientSecret is one — and JSON.stringify
    // drops it, so an accidental serialization cannot leak the e-seal either.
    expect(JSON.stringify({ signingKey: cfg!.signingKey })).toBe("{}");
    // No deviceId asked for, so no device credential is loaded.
    expect(cfg!.device).toBeNull();
  });

  it("leaves signingKey null when the tenant has no signing material (receipt-only)", async () => {
    setSecrets();
    const tenant = await makeTenant("eta-nosign");
    await seedTenantConfig(tenant.id, { signingKeyRef: null });

    const cfg = await resolveEtaConfig(tenant.id);
    // No signing material configured is the ORDINARY state of a receipt-only
    // tenant, so it is a value, not a throw.
    expect(cfg!.signingKey()).toBeNull();
  });

  it("resolves a tenant whose signing_key_ref is set but unresolvable, and throws only when the key is asked for", async () => {
    setSecrets();
    delete process.env[SIGNING_KEY]; // the ref stays; the env key is gone
    const tenant = await makeTenant("eta-stale-signing");
    await seedTenantConfig(tenant.id, { signingKeyRef: SIGNING_KEY });

    // THE POINT: the e-seal signs B2B e_invoices and ETA has not deployed
    // receipt signature validation at all, so no receipt reads this. If
    // resolution threw here, the worker would classify it as PERMANENT and fail
    // every receipt this tenant ever issues over a credential none of them use.
    const cfg = await resolveEtaConfig(tenant.id);
    expect(cfg).not.toBeNull();
    expect(cfg!.rin).toBe("200173707");

    // The failure lands where the credential is actually needed, naming the
    // column and the env key a human has to go and set.
    expect(() => cfg!.signingKey()).toThrow(EtaConfigError);
    expect(() => cfg!.signingKey()).toThrow(/eta_tenant_config\.signing_key_ref/);
    expect(() => cfg!.signingKey()).toThrow(new RegExp(SIGNING_KEY));
  });

  it("accepts the env:// ref spelling as well as a bare env key", async () => {
    setSecrets();
    const tenant = await makeTenant("eta-envscheme");
    await seedTenantConfig(tenant.id, { clientSecretRef: `env://${ERP_SECRET_KEY}` });

    const cfg = await resolveEtaConfig(tenant.id);
    expect(cfg!.erp.clientSecret()).toBe("erp-secret-value");
  });

  it("returns null for a tenant with no eta_tenant_config row at all", async () => {
    setSecrets();
    const tenant = await makeTenant("eta-unconfigured");
    expect(await resolveEtaConfig(tenant.id)).toBeNull();
  });

  it.each(["not_configured", "pending", "suspended"] as const)(
    "returns null when activationStatus is %s",
    async (activationStatus) => {
      setSecrets();
      const tenant = await makeTenant(`eta-${activationStatus.replace(/_/g, "-")}`);
      await seedTenantConfig(tenant.id, { activationStatus });

      expect(await resolveEtaConfig(tenant.id)).toBeNull();
    },
  );

  it("throws a typed EtaConfigError when an eagerly-resolved ref has no env value", async () => {
    setSecrets();
    // The DEVICE secrets are the only refs still resolved eagerly, and rightly
    // so: they are the ones the receipt path actually submits with, so a
    // missing one is a failure worth having up front. (The two B2B-only refs —
    // erp.clientSecret and signingKey — are thunks; see their own tests.)
    delete process.env[SECRET_1_KEY];
    const tenant = await makeTenant("eta-missing-ref");
    const device = await makeDevice(tenant.id, "till-missing-ref");
    await seedTenantConfig(tenant.id);
    await seedDeviceCredential(tenant.id, device.id);

    const error = await resolveEtaConfig(tenant.id, device.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EtaConfigError);
    expect((error as EtaConfigError).code).toBe("missing-secret-ref");
    // The message names the exact column and env KEY that failed — the key is
    // safe to name, and the value never existed to leak.
    expect((error as EtaConfigError).message).toContain(SECRET_1_KEY);
    expect((error as EtaConfigError).message).toContain("eta_pos_credentials.client_secret_1_ref");
  });

  it("does not fail a receipt-path resolution because the unused ERP secret ref is stale", async () => {
    setSecrets();
    delete process.env[ERP_SECRET_KEY];
    const tenant = await makeTenant("eta-stale-erp");
    const device = await makeDevice(tenant.id, "till-stale");
    await seedTenantConfig(tenant.id);
    await seedDeviceCredential(tenant.id, device.id);

    // E-receipts authenticate with the DEVICE credential; a broken ERP secret
    // (B2B only, unused here) must not take the till offline.
    const cfg = await resolveEtaConfig(tenant.id, device.id);
    expect(cfg!.device!.secret1).toBe("device-secret-1-value");

    // It still fails, precisely and by name, at the moment something asks for it.
    let thrown: unknown;
    try {
      cfg!.erp.clientSecret();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(EtaConfigError);
    expect((thrown as EtaConfigError).message).toContain("eta_tenant_config.client_secret_ref");
    expect((thrown as EtaConfigError).message).toContain(ERP_SECRET_KEY);
  });
});

describe("resolveEtaConfig — per-device credentials", () => {
  it("resolves the device's own client id, both secrets and the pre-shared key", async () => {
    setSecrets();
    const tenant = await makeTenant("eta-device");
    const device = await makeDevice(tenant.id, "till-1");
    await seedTenantConfig(tenant.id);
    await seedDeviceCredential(tenant.id, device.id);

    const cfg = await resolveEtaConfig(tenant.id, device.id);
    expect(cfg!.device).toEqual({
      serial: "POS-001",
      clientId: "device-client-id",
      secret1: "device-secret-1-value",
      secret2: "device-secret-2-value",
      presharedKey: "device-psk-value",
      osVersion: "IOS",
      modelFramework: "1",
    });
  });

  it("leaves presharedKey null when the device has no pre-shared key ref yet", async () => {
    setSecrets();
    const tenant = await makeTenant("eta-nopsk");
    const device = await makeDevice(tenant.id, "till-2");
    await seedTenantConfig(tenant.id);
    await seedDeviceCredential(tenant.id, device.id, { presharedKeyRef: null });

    const cfg = await resolveEtaConfig(tenant.id, device.id);
    // Resolution reports the gap; the provider decides what it means.
    expect(cfg!.device!.presharedKey).toBeNull();
  });

  it.each(["registered", "expired", "retired"] as const)(
    "returns null when the device credential status is %s",
    async (status) => {
      setSecrets();
      const tenant = await makeTenant(`eta-dev-${status}`);
      const device = await makeDevice(tenant.id, `till-${status}`);
      await seedTenantConfig(tenant.id);
      await seedDeviceCredential(tenant.id, device.id, { status });

      // "POS should be activated before submission on any other channel" —
      // only "active" is usable.
      expect(await resolveEtaConfig(tenant.id, device.id)).toBeNull();
    },
  );

  it("returns null when a deviceId is given but that device has no ETA credential", async () => {
    setSecrets();
    const tenant = await makeTenant("eta-dev-unregistered");
    const device = await makeDevice(tenant.id, "till-3");
    await seedTenantConfig(tenant.id);

    expect(await resolveEtaConfig(tenant.id, device.id)).toBeNull();
  });
});

describe("resolveEtaConfig — tenant isolation", () => {
  it("never reads another tenant's ETA config or device credential", async () => {
    setSecrets();
    const a = await makeTenant("eta-iso-a");
    const b = await makeTenant("eta-iso-b");
    const deviceA = await makeDevice(a.id, "till-a");
    await seedTenantConfig(a.id);
    await seedDeviceCredential(a.id, deviceA.id);

    // The RLS policy itself, not just resolveEtaConfig's tenant filter: an
    // unfiltered select inside B's scope still cannot see A's rows.
    expect(await withTenant(b.id, (tx) => tx.select().from(etaTenantConfig))).toHaveLength(0);
    expect(await withTenant(b.id, (tx) => tx.select().from(etaPosCredentials))).toHaveLength(0);

    // B has no config of its own, and A's is invisible to it.
    expect(await resolveEtaConfig(b.id)).toBeNull();
    // Even naming A's device from B's tenant scope resolves to nothing.
    expect(await resolveEtaConfig(b.id, deviceA.id)).toBeNull();
    // A still sees its own.
    expect((await resolveEtaConfig(a.id, deviceA.id))!.device!.serial).toBe("POS-001");
  });

  it("fails closed outside withTenant — an unscoped read sees no ETA rows", async () => {
    setSecrets();
    const a = await makeTenant("eta-iso-c");
    const deviceA = await makeDevice(a.id, "till-c");
    await seedTenantConfig(a.id);
    await seedDeviceCredential(a.id, deviceA.id);

    expect(await db.select().from(etaTenantConfig)).toHaveLength(0);
    expect(await db.select().from(etaPosCredentials)).toHaveLength(0);
  });
});
