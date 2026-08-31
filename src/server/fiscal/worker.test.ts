import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { orders, orderItems } from "@/server/ordering/schema";
import { placeOrder } from "@/server/ordering/service";
import { createCategory, createProduct, updateProduct } from "@/server/catalog/service";
import { auditEvents } from "@/server/audit/schema";
import { notifications } from "@/server/notifications/schema";
import { seedPosContext, openShiftForCtx } from "@/server/pos/test-helpers";
import { recordSale } from "@/server/pos/record-sale";
import { issueRefund, type RefundActor } from "@/server/pos/refund";
import { refundLines } from "@/server/pos/refund-schema";
import type { PosCashierContext } from "@/server/pos/require-cashier";
import {
  etaSubmissions, etaTenantConfig, etaPosCredentials, etaDeviceChains, productTaxCodes,
  type EtaWireContextConfig,
} from "./schema";
import { drainEtaSubmissions, MAX_ATTEMPTS } from "./worker";
import { finalizeSubmissionRow, reconcileMissingReceipts } from "./finalize";
import { enqueueCorrectedResubmission } from "./enqueue";
import { stringifyWire } from "./serialize";
import { EtaTransportError, EtaConfigError } from "./eta-transport-errors";
import type {
  EtaConfig, FinalizedFiscalDocument, FiscalProvider, FiscalSaleInput, FiscalRefundInput, FiscalSubmitResult,
} from "./provider";

/**
 * Runs against the real test Postgres, seeding through the real service
 * functions (`seedPosContext`, `recordSale`, `issueRefund`, `placeOrder`) the
 * way `enqueue.test.ts` does — so RLS, the FKs and the partial unique indexes
 * are all exercised for real. Only ETA itself is faked, at the one seam the
 * `FiscalProvider` contract puts a network call behind.
 */

const SECRET_KEYS = {
  erp: "TEST_WORKER_ETA_ERP_SECRET",
  secret1: "TEST_WORKER_ETA_SECRET_1",
  secret2: "TEST_WORKER_ETA_SECRET_2",
  psk: "TEST_WORKER_ETA_PSK",
} as const;

beforeAll(() => {
  process.env[SECRET_KEYS.erp] = "erp-secret";
  process.env[SECRET_KEYS.secret1] = "device-secret-1";
  process.env[SECRET_KEYS.secret2] = "device-secret-2";
  process.env[SECRET_KEYS.psk] = "device-psk";
});

afterAll(() => {
  for (const key of Object.values(SECRET_KEYS)) delete process.env[key];
});

const WIRE_CONTEXT: EtaWireContextConfig = {
  sellerName: "Fiscal Co",
  activityCode: "5610",
  branchCode: "0",
  branchAddress: {
    country: "EG", governate: "Cairo", regionCity: "Nasr City",
    street: "Test Street", buildingNumber: "12",
  },
};

// ---------------------------------------------------------------------------
// A fake ETA. Only `submit`/`poll` are real behaviour — the worker builds and
// finalizes through the pure modules directly (see `./finalize`'s header), so
// the build methods here exist to satisfy the interface and would be a bug if
// they were ever reached.
// ---------------------------------------------------------------------------

type SubmitOutcome = FiscalSubmitResult | Error;

class FakeEta implements FiscalProvider {
  readonly name = "fake";
  readonly submitted: FinalizedFiscalDocument[] = [];
  readonly polled: string[] = [];

  constructor(
    private readonly submitOutcomes: SubmitOutcome[],
    private readonly pollOutcomes: SubmitOutcome[] = [],
  ) {}

  buildReceipt(_input: FiscalSaleInput): never {
    throw new Error("FakeEta.buildReceipt must not be called — finalization uses the pure builders directly");
  }

  buildReturnReceipt(_input: FiscalRefundInput): never {
    throw new Error("FakeEta.buildReturnReceipt must not be called — finalization uses the pure builders directly");
  }

  async submit(finalized: FinalizedFiscalDocument, _cfg: EtaConfig): Promise<FiscalSubmitResult> {
    this.submitted.push(finalized);
    return unwrap(this.submitOutcomes, this.submitted.length, "submit");
  }

  async poll(submissionUuid: string, _cfg: EtaConfig): Promise<FiscalSubmitResult> {
    this.polled.push(submissionUuid);
    return unwrap(this.pollOutcomes, this.polled.length, "poll");
  }
}

/** The nth scripted outcome, or the last one for every call past the script. */
function unwrap(outcomes: SubmitOutcome[], call: number, what: string): FiscalSubmitResult {
  const outcome = outcomes[Math.min(call, outcomes.length) - 1];
  if (!outcome) throw new Error(`FakeEta: no scripted ${what} outcome for call ${call}`);
  if (outcome instanceof Error) throw outcome;
  return outcome;
}

/**
 * A provider that makes THIS drain the loser of the one race the claim lease
 * cannot rule out: the lease can expire while a submit is in flight, so a
 * second drain may finish the row while this one is still waiting on ETA.
 *
 * The racing write happens INSIDE submit — mid-flight, exactly where it would
 * really land — and then the call fails, so the worker's terminal write runs
 * against a row another drain has already parked at the attempt cap.
 */
function losingDrain(tenantId: string, failure: Error): FiscalProvider {
  return {
    name: "losing-drain",
    buildReceipt: () => { throw new Error("not used"); },
    buildReturnReceipt: () => { throw new Error("not used"); },
    poll: () => { throw new Error("not used"); },
    submit: async () => {
      await withTenant(tenantId, (tx) => tx.update(etaSubmissions)
        .set({ status: "failed", attempts: MAX_ATTEMPTS, lastError: "terminalized by the other drain" })
        .where(eq(etaSubmissions.tenantId, tenantId)));
      throw failure;
    },
  };
}

const accepted202 = (submissionUuid = "sub-1"): FiscalSubmitResult => ({
  status: "submitted", submissionUuid, responseJson: { submissionUUID: submissionUuid },
});

const pollValid = (longId = "LONG-1"): FiscalSubmitResult => ({
  status: "accepted", etaLongId: longId, responseJson: { status: "Valid" },
});

const pollInProgress = (): FiscalSubmitResult => ({ status: "submitted", responseJson: { status: "InProgress" } });

const rejection = (): FiscalSubmitResult => ({
  status: "rejected",
  responseJson: { rejectedDocuments: [{ error: { code: "InvalidTaxpayer", message: "seller RIN is not registered" } }] },
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const actorFrom = (ctx: PosCashierContext): RefundActor => ({
  tenantId: ctx.tenantId, branchId: ctx.branchId, actorUserId: ctx.cashierUserId, permissions: [...ctx.permissions],
});

async function seedTaxCode(tenantId: string, productId: string) {
  await withTenant(tenantId, (tx) => tx.insert(productTaxCodes).values({
    tenantId, productId, codeSource: "gs1", itemCode: "1234567890123",
    taxType: "T1", taxSubType: "V009", unitType: "EA",
  }));
}

async function seedFiscalConfig(
  tenantId: string,
  overrides: Partial<typeof etaTenantConfig.$inferInsert> = {},
) {
  await withTenant(tenantId, (tx) => tx.insert(etaTenantConfig).values({
    tenantId,
    registrationNumber: "200173707",
    clientId: "erp-client",
    clientSecretRef: SECRET_KEYS.erp,
    environment: "preprod",
    activationStatus: "active",
    wireContextJson: WIRE_CONTEXT,
    ...overrides,
  }));
}

async function seedDeviceCredential(tenantId: string, deviceId: string, etaSerial = "POS-001") {
  await withTenant(tenantId, (tx) => tx.insert(etaPosCredentials).values({
    tenantId, deviceId, etaSerial, clientId: "device-client",
    clientSecret1Ref: SECRET_KEYS.secret1, clientSecret2Ref: SECRET_KEYS.secret2,
    presharedKeyRef: SECRET_KEYS.psk, posOsVersion: "IOS", posModelFramework: "1", status: "active",
  }));
}

type Fixture = Awaited<ReturnType<typeof seedPosContext>> & { receipt: Awaited<ReturnType<typeof recordSale>> };

/**
 * An EG tenant that can issue a fiscal document, with one paid cash sale.
 *
 * `configureFirst` decides WHEN the fiscal config lands relative to the sale,
 * which is exactly the difference between the two finalization paths.
 * Configured first (the default, and the production path): `recordSale`
 * finalizes the row inline, so the printed receipt carries its uuid and QR.
 * Configured after: the sale-path finalization fails — it logs a
 * `finalize-at-enqueue failed` line, which is expected noise in those tests —
 * and the row reaches the worker unfinalized, exercising the worker's own
 * authoritative fallback.
 */
async function seedSale(opts: { configureFirst?: boolean; clientOrderId?: string } = {}): Promise<Fixture> {
  const configureFirst = opts.configureFirst ?? true;
  const s = await seedPosContext("owner");
  await openShiftForCtx(s.ctx);
  await seedTaxCode(s.tenantId, s.productId);

  if (configureFirst) {
    await seedFiscalConfig(s.tenantId);
    await seedDeviceCredential(s.tenantId, s.ctx.deviceId);
  }

  const receipt = await recordSale(s.ctx, {
    clientOrderId: opts.clientOrderId ?? "sale-1",
    lines: [{ productId: s.productId, quantity: 1, selectedOptionIds: [] }],
    expectedTotal: s.total,
    payments: [{ clientPaymentId: "p-1", method: "cash", amount: s.total, tenderedAmount: s.total }],
  });

  if (!configureFirst) {
    await seedFiscalConfig(s.tenantId);
    await seedDeviceCredential(s.tenantId, s.ctx.deviceId);
  }

  return { ...s, receipt };
}

const rowsFor = (tenantId: string) =>
  withTenant(tenantId, (tx) => tx.select().from(etaSubmissions).where(eq(etaSubmissions.tenantId, tenantId)));

const auditsFor = (tenantId: string) =>
  withTenant(tenantId, (tx) => tx.select().from(auditEvents).where(and(
    eq(auditEvents.tenantId, tenantId),
    inArray(auditEvents.action, ["eta.submission.submitted", "eta.submission.accepted", "eta.submission.rejected"]),
  )));

const notificationsFor = (tenantId: string) =>
  withTenant(tenantId, (tx) => tx.select().from(notifications).where(eq(notifications.tenantId, tenantId)));

const chainFor = (tenantId: string) =>
  withTenant(tenantId, (tx) => tx.select().from(etaDeviceChains).where(eq(etaDeviceChains.tenantId, tenantId)));

/** The `header` block of a finalized row's stored wire document. Its values are
 *  all strings, so the mapped (JSON.parse'd) column is enough — the decimal
 *  fidelity that needs `request_json::text` is `storedWireText`'s job. */
function header(requestJson: Record<string, unknown>): Record<string, unknown> {
  return requestJson.header as Record<string, unknown>;
}

/** The row's stored document as raw text — the bytes ETA is meant to receive,
 *  before node-postgres parses `114.00` down to `114`. */
async function storedWireText(tenantId: string, submissionId: string): Promise<string> {
  const rows = await withTenant(tenantId, async (tx) => {
    const res = await tx.execute<{ wire: string }>(
      sql`SELECT request_json::text AS wire FROM eta_submissions WHERE tenant_id = ${tenantId} AND id = ${submissionId}`);
    return res.rows;
  });
  return rows[0].wire;
}

// ---------------------------------------------------------------------------

describe("finalization at enqueue time", () => {
  it("gives a POS sale its uuid, QR and chain head before recordSale returns", async () => {
    const s = await seedSale({ configureFirst: true });

    const [row] = await rowsFor(s.tenantId);
    const [order] = await withTenant(s.tenantId, (tx) =>
      tx.select().from(orders).where(eq(orders.id, s.receipt.orderId)));

    expect(row.status).toBe("pending");
    expect(row.etaUuid).toMatch(/^[0-9a-f]{64}$/);
    // The QR the printed customer copy carries — buildable at issuance, long
    // before ETA has seen the document (addendum C5). Its total is the order's
    // own stored money string, trailing zeros and all.
    expect(row.qrPayload).toBe(
      `https://preprod.invoicing.eta.gov.eg/receipts/search/${row.etaUuid}/share/${header(row.requestJson).dateTimeIssued}` +
        `#Total:${order.total},IssuerRIN:200173707`,
    );
    // The stored document is the document — property order and decimal
    // literals preserved, not a jsonb-normalized copy of it.
    const wireText = await storedWireText(s.tenantId, row.id);
    expect(wireText).toContain(`"totalAmount":${order.total}`);
    expect(JSON.parse(wireText).header.uuid).toBe(row.etaUuid);
    // Receipts are not e-sealed today (addendum C7), so this stays null rather
    // than being loaded with the uuid.
    expect(row.hashOrSignature).toBeNull();
    expect(header(row.requestJson).previousUUID).toBe(""); // genesis
    expect(header(row.requestJson).receiptNumber).toBe(String(s.receipt.orderNumber));

    const [chain] = await chainFor(s.tenantId);
    expect(chain.deviceId).toBe(s.ctx.deviceId);
    expect(chain.lastUuid).toBe(row.etaUuid);
  });

  it("chains concurrent finalizations on one device: distinct uuids, second links to the first", async () => {
    // BOTH sales are rung before the tenant is configured, so neither is
    // finalized inline and the two finalizations can be raced deliberately.
    const s = await seedPosContext("owner");
    await openShiftForCtx(s.ctx);
    await seedTaxCode(s.tenantId, s.productId);
    const first = await recordSale(s.ctx, {
      clientOrderId: "chain-a",
      lines: [{ productId: s.productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: s.total,
      payments: [{ clientPaymentId: "p-1", method: "cash", amount: s.total, tenderedAmount: s.total }],
    });
    const second = await recordSale(s.ctx, {
      clientOrderId: "chain-b",
      lines: [{ productId: s.productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: s.total,
      payments: [{ clientPaymentId: "p-2", method: "cash", amount: s.total, tenderedAmount: s.total }],
    });
    await seedFiscalConfig(s.tenantId);
    await seedDeviceCredential(s.tenantId, s.ctx.deviceId);

    const queued = await rowsFor(s.tenantId);
    expect(queued).toHaveLength(2);
    expect(queued.every((row) => row.etaUuid === null)).toBe(true);

    // Both at once, on the same device: only the advisory device lock stops
    // them reading the same predecessor.
    await Promise.all(queued.map((row) => finalizeSubmissionRow(s.tenantId, row.id)));

    const finalized = await rowsFor(s.tenantId);
    const uuids = finalized.map((row) => row.etaUuid);
    expect(new Set(uuids).size).toBe(2);

    const bySale = new Map(finalized.map((row) => [row.orderId, row]));
    const rowA = bySale.get(first.orderId)!;
    const rowB = bySale.get(second.orderId)!;
    // Whichever won the lock, the chain is a line and not a fork: exactly one
    // row starts from genesis and the other names its sibling.
    const links = [header(rowA.requestJson).previousUUID, header(rowB.requestJson).previousUUID];
    expect(links).toContain("");
    expect(links.filter((link) => link === "")).toHaveLength(1);
    const chained = links.find((link) => link !== "");
    expect(uuids).toContain(chained);

    const [chain] = await chainFor(s.tenantId);
    // The head is the row that finalized second, not either row arbitrarily.
    expect(chain.lastUuid).toBe(finalized.find((row) => row.etaUuid !== chained)!.etaUuid);
  });
});

describe("drainEtaSubmissions — accept path", () => {
  it("finalizes an unfinalized row, submits it, polls it, and accepts it with audits in the same tx", async () => {
    const s = await seedSale({ configureFirst: false });
    const provider = new FakeEta([accepted202("sub-accept")], [pollValid("LONG-ACCEPT")]);

    const first = await drainEtaSubmissions({ provider, reconcile: false });
    expect(first.processed).toBe(1);

    const [submitted] = await rowsFor(s.tenantId);
    expect(submitted.status).toBe("submitted");
    expect(submitted.submissionUuid).toBe("sub-accept");
    expect(submitted.submittedAt).not.toBeNull();
    // Finalization happened here, in the worker — the row arrived without it.
    expect(submitted.etaUuid).toMatch(/^[0-9a-f]{64}$/);
    expect(provider.submitted[0].uuid).toBe(submitted.etaUuid);
    // The load-bearing round trip: what the provider was handed re-serializes
    // into the exact bytes stored at finalization — property order and decimal
    // literals included, because ETA re-derives the uuid from them.
    expect(stringifyWire(provider.submitted[0].wire)).toBe(await storedWireText(s.tenantId, submitted.id));

    // The poll clock is in the future, so a second pass has to be told the row
    // is eligible again.
    await makeEligible(s.tenantId, submitted.id);
    const second = await drainEtaSubmissions({ provider, reconcile: false });
    expect(second.accepted).toBe(1);
    expect(provider.polled).toEqual(["sub-accept"]);

    const [row] = await rowsFor(s.tenantId);
    expect(row.status).toBe("accepted");
    expect(row.etaLongId).toBe("LONG-ACCEPT");
    expect(row.acceptedAt).not.toBeNull();
    expect(row.lastError).toBeNull();

    const audits = await auditsFor(s.tenantId);
    expect(audits.map((a) => a.action).sort()).toEqual(["eta.submission.accepted", "eta.submission.submitted"]);
    expect(audits.every((a) => a.actorType === "system" && a.entityType === "eta_submission")).toBe(true);
    expect(audits.every((a) => a.entityId === row.id)).toBe(true);
  });

  it("re-polls, never re-submits, a row whose poll failed in transit", async () => {
    const s = await seedSale();
    // Submit lands, then the poll dies on the wire — which parks the row as
    // `failed` while ETA is still holding the document.
    const provider = new FakeEta(
      [accepted202("sub-once")],
      [new EtaTransportError("gateway down", { status: 502 }), pollValid("LONG-LATE")],
    );

    await drainEtaSubmissions({ provider, reconcile: false });
    await makeEligibleAll(s.tenantId);
    await drainEtaSubmissions({ provider, reconcile: false });

    const failed = (await rowsFor(s.tenantId))[0];
    expect(failed.status).toBe("failed");
    expect(failed.submissionUuid).toBe("sub-once");

    await makeEligibleAll(s.tenantId);
    await drainEtaSubmissions({ provider, reconcile: false });

    // The load-bearing assertion: ETA was asked what happened, not handed the
    // document a second time. Its duplicate window is ~10 minutes, so a
    // re-submit here would file a second copy of the same receipt.
    expect(provider.submitted).toHaveLength(1);
    expect(provider.polled).toEqual(["sub-once", "sub-once"]);

    const [row] = await rowsFor(s.tenantId);
    expect(row.status).toBe("accepted");
    expect(row.etaLongId).toBe("LONG-LATE");
  });

  it("submits a row exactly once when two drains race it — the claim's exclusivity pin", async () => {
    const s = await seedSale({ configureFirst: true });
    const [pending] = await rowsFor(s.tenantId);
    const uuid = pending.etaUuid!;
    // ONE provider shared by both drains, so its call log is the global count.
    const provider = new FakeEta([accepted202("sub-race-a"), accepted202("sub-race-b")]);

    await Promise.all([
      drainEtaSubmissions({ provider, reconcile: false }),
      drainEtaSubmissions({ provider, reconcile: false }),
    ]);

    // this catches losing claim exclusivity (drop SKIP LOCKED -> two submits);
    // it does NOT catch neutering the lease alone, because in-pass row locks
    // serialize the two claims anyway — the lease's cross-pass job is pinned by
    // the notify-once race tests below.
    expect(provider.submitted.filter((doc) => doc.uuid === uuid)).toHaveLength(1);

    const rows = await rowsFor(s.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("submitted");
    expect(rows[0].attempts).toBe(0);
  });

  it("does not consume an attempt while ETA is still processing", async () => {
    const s = await seedSale();
    const provider = new FakeEta([accepted202("sub-slow")], [pollInProgress()]);

    await drainEtaSubmissions({ provider, reconcile: false });
    const [submitted] = await rowsFor(s.tenantId);
    await makeEligible(s.tenantId, submitted.id);
    await drainEtaSubmissions({ provider, reconcile: false });

    const [row] = await rowsFor(s.tenantId);
    expect(row.status).toBe("submitted");
    expect(row.attempts).toBe(0); // a poll is not an attempt
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("drainEtaSubmissions — rejection", () => {
  it("records the response, names the reason, and alerts the owner; the sale stands", async () => {
    const s = await seedSale();
    const provider = new FakeEta([rejection()]);

    const res = await drainEtaSubmissions({ provider, reconcile: false });
    expect(res.rejected).toBe(1);

    const [row] = await rowsFor(s.tenantId);
    expect(row.status).toBe("rejected");
    expect(row.responseJson).toEqual(rejection().responseJson);
    expect(row.lastError).toContain("InvalidTaxpayer");

    const alerts = await notificationsFor(s.tenantId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ type: "system_alert", severity: "critical", entityId: row.id });

    const audits = await auditsFor(s.tenantId);
    expect(audits.map((a) => a.action)).toEqual(["eta.submission.rejected"]);

    // The sale itself is untouched.
    const [order] = await withTenant(s.tenantId, (tx) =>
      tx.select().from(orders).where(eq(orders.id, s.receipt.orderId)));
    expect(order.paymentStatus).toBe("paid");
    expect(Number(order.total)).toBe(s.total);
  });
});

describe("drainEtaSubmissions — the failure taxonomy", () => {
  it("backs off on a transport error, honouring Retry-After as a floor", async () => {
    const s = await seedSale();
    // 20 minutes is far past the 60s the first backoff step would give, so
    // only the floor can produce it.
    const retryAfterSeconds = 20 * 60;
    const now = new Date("2026-08-31T10:00:00.000Z");
    const provider = new FakeEta([
      new EtaTransportError("throttled", { status: 429, retryAfterSeconds, etaErrorCode: "TooManyRequests" }),
    ]);

    const res = await drainEtaSubmissions({ provider, reconcile: false, now: () => now });
    expect(res.failed).toBe(1);

    const [row] = await rowsFor(s.tenantId);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("EtaTransportError");
    expect(row.nextAttemptAt.getTime()).toBe(now.getTime() + retryAfterSeconds * 1000);
    expect(await notificationsFor(s.tenantId)).toHaveLength(0); // not terminal yet
  });

  it.each(["BadStructure", "MaximumSizeExceeded", "IncorrectSubmitter"])(
    "treats %s as permanent — no retries, one alert",
    async (etaErrorCode) => {
      const s = await seedSale({ clientOrderId: `perm-${etaErrorCode}` });
      const provider = new FakeEta([new EtaTransportError("refused", { status: 400, etaErrorCode })]);

      await drainEtaSubmissions({ provider, reconcile: false });

      const [row] = await rowsFor(s.tenantId);
      expect(row.status).toBe("failed");
      expect(row.attempts).toBe(MAX_ATTEMPTS); // parked: the claim query can never see it again
      expect(row.lastError).toContain(etaErrorCode);
      expect(await notificationsFor(s.tenantId)).toHaveLength(1);

      // Proof it is really unreachable: a second pass claims nothing.
      const second = await drainEtaSubmissions({ provider, reconcile: false });
      expect(second.processed).toBe(0);
      expect(await notificationsFor(s.tenantId)).toHaveLength(1);
    },
  );

  it("alerts exactly once when a document exhausts MAX_ATTEMPTS", async () => {
    const s = await seedSale();
    const provider = new FakeEta([new EtaTransportError("gateway down", { status: 502 })]);

    for (let pass = 0; pass < MAX_ATTEMPTS + 2; pass++) {
      const [row] = await rowsFor(s.tenantId);
      await makeEligible(s.tenantId, row.id);
      await drainEtaSubmissions({ provider, reconcile: false });
    }

    const [row] = await rowsFor(s.tenantId);
    expect(row.attempts).toBe(MAX_ATTEMPTS);
    // MAX_ATTEMPTS submissions, then the row is out of reach — no more calls.
    expect(provider.submitted).toHaveLength(MAX_ATTEMPTS);
    expect(await notificationsFor(s.tenantId)).toHaveLength(1);
  });

  it("fails permanently and alerts when the tenant has no wire context", async () => {
    // Unfinalized on purpose: a row that already carries its uuid never
    // re-reads the wire context, so the fault has to be present at
    // finalization to be observable at all.
    const s = await seedSale({ configureFirst: false });
    await withTenant(s.tenantId, (tx) => tx.update(etaTenantConfig)
      .set({ wireContextJson: null }).where(eq(etaTenantConfig.tenantId, s.tenantId)));
    const provider = new FakeEta([accepted202()]);

    await drainEtaSubmissions({ provider, reconcile: false });

    const [row] = await rowsFor(s.tenantId);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(MAX_ATTEMPTS);
    expect(row.lastError).toContain("wire-context-missing");
    expect(provider.submitted).toHaveLength(0); // never reached the network
    expect(await notificationsFor(s.tenantId)).toHaveLength(1);
  });

  it("passes over a tenant whose ETA config is inactive without claiming its rows", async () => {
    const s = await seedSale();
    const before = (await rowsFor(s.tenantId))[0];
    await withTenant(s.tenantId, (tx) => tx.update(etaTenantConfig)
      .set({ activationStatus: "pending" }).where(eq(etaTenantConfig.tenantId, s.tenantId)));
    const provider = new FakeEta([accepted202()]);

    const res = await drainEtaSubmissions({ provider, reconcile: false });
    // The gate is above the claim, so nothing is even looked at: an
    // onboarding tenant costs one config query per pass, not a claim plus a
    // lease bump on every row it owns.
    expect(res).toMatchObject({ processed: 0, skippedTenants: 1 });

    const [row] = await rowsFor(s.tenantId);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBeNull();
    // Not even the backoff clock moved — no lease was taken.
    expect(row.nextAttemptAt.getTime()).toBe(before.nextAttemptAt.getTime());
    expect(provider.submitted).toHaveLength(0);
    expect(await notificationsFor(s.tenantId)).toHaveLength(0);
  });

  it("submits receipts for a tenant whose UNUSED signing_key_ref is stale", async () => {
    const s = await seedSale({ configureFirst: false });
    // A dangling e-seal reference. The e-seal signs B2B e_invoices and ETA has
    // not deployed receipt signature validation at all, so no receipt reads it
    // — but while resolveEtaConfig resolved it eagerly, this one unset env var
    // failed the whole tenant, and the worker turned that into a PERMANENT
    // failure on every receipt.
    await withTenant(s.tenantId, (tx) => tx.update(etaTenantConfig)
      .set({ signingKeyRef: "TEST_WORKER_ETA_SIGNING_KEY_THAT_IS_NOT_SET" })
      .where(eq(etaTenantConfig.tenantId, s.tenantId)));
    const provider = new FakeEta([accepted202("sub-unsigned")]);

    await drainEtaSubmissions({ provider, reconcile: false });

    const [row] = await rowsFor(s.tenantId);
    expect(row.status).toBe("submitted");
    expect(row.etaUuid).toMatch(/^[0-9a-f]{64}$/);
    expect(row.lastError).toBeNull();
    expect(await notificationsFor(s.tenantId)).toHaveLength(0);
  });

  it("stays quiet when another drain has already terminalized the row (transient path)", async () => {
    const s = await seedSale();
    // One attempt short of the cap, so THIS drain's failure is the one that
    // would exhaust it and alert — which is the only configuration where a
    // double notify is possible at all.
    await withTenant(s.tenantId, (tx) => tx.update(etaSubmissions)
      .set({ attempts: MAX_ATTEMPTS - 1 }).where(eq(etaSubmissions.tenantId, s.tenantId)));

    // Simulates the one race the lease cannot rule out: it can expire while a
    // submit is in flight, so a second drain can be finishing this row while
    // this one is still waiting on ETA. The fake plays that second drain —
    // writing the terminal state mid-flight — and then fails our call.
    const raceThenFail = losingDrain(s.tenantId, new EtaTransportError("gateway down", { status: 502 }));

    await drainEtaSubmissions({ provider: raceThenFail, reconcile: false });

    const [row] = await rowsFor(s.tenantId);
    // The compare-and-set on the attempt count we read at claim time found
    // nothing to update, so neither the counter nor the alert moved. Without
    // it this drain would have written its own terminal state over the other's
    // and sent a second critical alert for one failure.
    expect(row.attempts).toBe(MAX_ATTEMPTS);
    expect(row.lastError).toBe("terminalized by the other drain");
    expect(await notificationsFor(s.tenantId)).toHaveLength(0);
  });

  it("stays quiet when another drain has already terminalized the row (permanent path)", async () => {
    const s = await seedSale();
    const raceThenFail = losingDrain(s.tenantId, new EtaConfigError("device-not-registered", "config went away mid-flight"));

    await drainEtaSubmissions({ provider: raceThenFail, reconcile: false });

    const [row] = await rowsFor(s.tenantId);
    // `attempts < MAX_ATTEMPTS` makes the terminal UPDATE the thing that
    // decides who alerts: the loser matches no row and says nothing.
    expect(row.lastError).toBe("terminalized by the other drain");
    expect(await notificationsFor(s.tenantId)).toHaveLength(0);
  });

  it("fails one poison row without stopping its siblings", async () => {
    const s = await seedSale({ clientOrderId: "good-1" });
    // A second sale of a product with NO product_tax_codes row: its document
    // cannot be built at all (MissingTaxCodeError, permanent).
    const poisonProduct = await seedUnclassifiedProduct(s.tenantId);
    const poison = await recordSale(s.ctx, {
      clientOrderId: "poison-1",
      lines: [{ productId: poisonProduct, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: s.total,
      payments: [{ clientPaymentId: "p-poison", method: "cash", amount: s.total, tenderedAmount: s.total }],
    });

    const provider = new FakeEta([accepted202("sub-good")]);
    const res = await drainEtaSubmissions({ provider, reconcile: false });
    expect(res.processed).toBe(2);

    const rows = await rowsFor(s.tenantId);
    const good = rows.find((row) => row.orderId === s.receipt.orderId)!;
    const bad = rows.find((row) => row.orderId === poison.orderId)!;
    expect(good.status).toBe("submitted"); // unaffected by its neighbour
    expect(bad.status).toBe("failed");
    expect(bad.lastError).toContain("missing-tax-code");
    expect(bad.attempts).toBe(MAX_ATTEMPTS);
  });
});

describe("drainEtaSubmissions — online orders", () => {
  it("issues an online order's receipt on the tenant's nominated online device", async () => {
    const s = await seedPosContext("owner");
    await seedTaxCode(s.tenantId, s.productId);
    await seedFiscalConfig(s.tenantId, { onlineDeviceId: s.ctx.deviceId });
    await seedDeviceCredential(s.tenantId, s.ctx.deviceId, "POS-ONLINE");
    // Aged past the sweep threshold: nothing enqueues a web order today, so
    // the reconciliation sweep is how one enters the fiscal pipeline.
    const orderId = await placeWebOrder(s.tenantId, s.branchId, s.productId, { minutesAgo: 30 });

    const provider = new FakeEta([accepted202("sub-web")]);
    await drainEtaSubmissions({ provider, limit: 10 });

    const [row] = await rowsFor(s.tenantId);
    expect(row.orderId).toBe(orderId);
    expect(row.status).toBe("submitted");
    // The serial in the hashed document is the nominated device's.
    expect(((row.requestJson.seller as Record<string, unknown>).deviceSerialNumber)).toBe("POS-ONLINE");

    const [chain] = await chainFor(s.tenantId);
    expect(chain.deviceId).toBe(s.ctx.deviceId);
  });

  it("fails permanently when no online device is nominated", async () => {
    const s = await seedPosContext("owner");
    await seedTaxCode(s.tenantId, s.productId);
    await seedFiscalConfig(s.tenantId); // no onlineDeviceId
    await seedDeviceCredential(s.tenantId, s.ctx.deviceId);
    await placeWebOrder(s.tenantId, s.branchId, s.productId, { minutesAgo: 30 });

    const provider = new FakeEta([accepted202()]);
    await drainEtaSubmissions({ provider, limit: 10 });

    const [row] = await rowsFor(s.tenantId);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(MAX_ATTEMPTS);
    expect(row.lastError).toContain("no fiscal device configured for online orders");
    expect(await notificationsFor(s.tenantId)).toHaveLength(1);
  });
});

describe("drainEtaSubmissions — reconciliation sweep", () => {
  it("adopts an EG order that has no submission row at all, and ignores a fresh one", async () => {
    const s = await seedPosContext("owner");
    await seedTaxCode(s.tenantId, s.productId);
    await seedFiscalConfig(s.tenantId, { onlineDeviceId: s.ctx.deviceId });
    await seedDeviceCredential(s.tenantId, s.ctx.deviceId);

    // The row-less failure this sweep exists to catch: an order that was
    // placed and paid, whose enqueue never produced a row.
    const stale = await placeWebOrder(s.tenantId, s.branchId, s.productId, { minutesAgo: 30 });
    const fresh = await placeWebOrder(s.tenantId, s.branchId, s.productId, { minutesAgo: 0 });

    const provider = new FakeEta([accepted202("sub-swept")]);
    const res = await drainEtaSubmissions({ provider, limit: 10 });
    expect(res.reconciled).toBe(1);

    const rows = await rowsFor(s.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0].orderId).toBe(stale);
    expect(rows[0].orderId).not.toBe(fresh);
    // Swept AND finalized in the same pass — the sweep uses the sale path's
    // own entry point, not a bare insert.
    expect(rows[0].etaUuid).toMatch(/^[0-9a-f]{64}$/);
  });

  it("enqueues at most `limit` orders in one pass, leaving the backlog for the next", async () => {
    const s = await seedPosContext("owner");
    await seedTaxCode(s.tenantId, s.productId);
    await seedFiscalConfig(s.tenantId, { onlineDeviceId: s.ctx.deviceId });
    await seedDeviceCredential(s.tenantId, s.ctx.deviceId);
    for (let i = 0; i < 5; i++) await placeWebOrder(s.tenantId, s.branchId, s.productId, { minutesAgo: 30 });

    // A tenant that has been unconfigured for a while can present a backlog of
    // any size; the sweep must take a bounded bite rather than hold a pass open
    // over thousands of orders.
    const first = await reconcileMissingReceipts({ tenantId: s.tenantId }, { limit: 2 });
    expect(first.enqueued).toBe(2);
    expect(await rowsFor(s.tenantId)).toHaveLength(2);

    // Oldest first, so the backlog drains in issuance order and the receipts
    // closest to ETA's 24-hour window go first.
    const second = await reconcileMissingReceipts({ tenantId: s.tenantId }, { limit: 2 });
    expect(second.enqueued).toBe(2);
    expect(await rowsFor(s.tenantId)).toHaveLength(4);
  });

  it("sweeps an order past the age threshold and leaves one just inside it", async () => {
    const s = await seedPosContext("owner");
    await seedTaxCode(s.tenantId, s.productId);
    await seedFiscalConfig(s.tenantId, { onlineDeviceId: s.ctx.deviceId });
    await seedDeviceCredential(s.tenantId, s.ctx.deviceId);

    // The threshold exists so an in-flight sale is never swept out from under
    // its own enqueue — a sale whose recordSale has committed but whose
    // after-commit enqueue has not run yet must not be adopted here.
    const older = await placeWebOrder(s.tenantId, s.branchId, s.productId, { minutesAgo: 11 });
    const newer = await placeWebOrder(s.tenantId, s.branchId, s.productId, { minutesAgo: 9 });

    const res = await reconcileMissingReceipts({ tenantId: s.tenantId }, { olderThanMs: 10 * 60 * 1000 });
    expect(res.enqueued).toBe(1);

    const rows = await rowsFor(s.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0].orderId).toBe(older);
    expect(rows.some((row) => row.orderId === newer)).toBe(false);
  });

  it("does not reach back past the horizon, so activating a tenant never back-submits its history", async () => {
    const s = await seedPosContext("owner");
    await seedTaxCode(s.tenantId, s.productId);
    await seedFiscalConfig(s.tenantId, { onlineDeviceId: s.ctx.deviceId });
    await seedDeviceCredential(s.tenantId, s.ctx.deviceId);

    const ancient = await placeWebOrder(s.tenantId, s.branchId, s.productId, { minutesAgo: 60 * 24 * 30 });
    const recent = await placeWebOrder(s.tenantId, s.branchId, s.productId, { minutesAgo: 60 * 24 * 2 });

    const res = await reconcileMissingReceipts({ tenantId: s.tenantId });
    expect(res.enqueued).toBe(1);

    const rows = await rowsFor(s.tenantId);
    // A month-old order would carry a month-old dateTimeIssued — outside ETA's
    // 24-hour window and into the Late Submission path this pipeline does not
    // implement. Recent history still gets adopted.
    expect(rows).toHaveLength(1);
    expect(rows[0].orderId).toBe(recent);
    expect(rows.some((row) => row.orderId === ancient)).toBe(false);
  });

  it("ignores an unpaid order — no sale, no receipt", async () => {
    const s = await seedPosContext("owner");
    await seedTaxCode(s.tenantId, s.productId);
    await seedFiscalConfig(s.tenantId, { onlineDeviceId: s.ctx.deviceId });
    await seedDeviceCredential(s.tenantId, s.ctx.deviceId);
    await placeWebOrder(s.tenantId, s.branchId, s.productId, { minutesAgo: 30, paymentStatus: "unpaid" });

    const res = await drainEtaSubmissions({ provider: new FakeEta([]), limit: 10 });
    expect(res.reconciled).toBe(0);
    expect(await rowsFor(s.tenantId)).toHaveLength(0);
  });

  it("never visits a non-EG tenant", async () => {
    const s = await seedPosContext("owner");
    await db.update(tenants).set({ country: "SA" }).where(eq(tenants.id, s.tenantId));
    await placeWebOrder(s.tenantId, s.branchId, s.productId, { minutesAgo: 30 });

    await drainEtaSubmissions({ provider: new FakeEta([]), limit: 10 });
    expect(await rowsFor(s.tenantId)).toHaveLength(0);
  });
});

describe("drainEtaSubmissions — return receipts", () => {
  it("defers a return until its parent sale is accepted, then references the parent uuid", async () => {
    const s = await seedSale({ configureFirst: true });
    const refund = await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "partial",
      lines: [{ orderItemId: (await orderItemIds(s.tenantId, s.receipt.orderId))[0], quantity: 1, amount: 100, restock: false }],
      payments: [{ method: "cash", amount: 100 }],
      reasonCode: "other",
      clientRefundId: "r-1",
    });

    // Pass 1: the sale submits; the return is deferred with no attempt spent,
    // because its Mandatory referenceUUID does not exist yet.
    const provider = new FakeEta([accepted202("sub-sale")], [pollValid("LONG-SALE")]);
    await drainEtaSubmissions({ provider, reconcile: false });

    let ret = (await rowsFor(s.tenantId)).find((row) => row.refundId === refund.refundId)!;
    expect(ret.status).toBe("pending");
    expect(ret.attempts).toBe(0);
    expect(ret.etaUuid).toBeNull();
    expect(provider.submitted).toHaveLength(1); // the sale only

    // Pass 2: the sale is accepted. Still deferred — the parent's acceptance
    // and the return's submission cannot happen in the same pass.
    await makeEligibleAll(s.tenantId);
    await drainEtaSubmissions({ provider, reconcile: false });
    const sale = (await rowsFor(s.tenantId)).find((row) => row.orderId === s.receipt.orderId)!;
    expect(sale.status).toBe("accepted");

    // Pass 3: the return finalizes against the accepted parent and submits.
    await makeEligibleAll(s.tenantId);
    const returnProvider = new FakeEta([accepted202("sub-return")]);
    await drainEtaSubmissions({ provider: returnProvider, reconcile: false });

    ret = (await rowsFor(s.tenantId)).find((row) => row.refundId === refund.refundId)!;
    expect(ret.status).toBe("submitted");
    expect(ret.etaUuid).toMatch(/^[0-9a-f]{64}$/);
    expect(header(ret.requestJson).referenceUUID).toBe(sale.etaUuid);
    // The return chains on the same device as the sale it reverses.
    expect(header(ret.requestJson).previousUUID).toBe(sale.etaUuid);
    expect(header(ret.requestJson).receiptNumber).toBe(`${s.receipt.orderNumber}-R1`);
    expect(((ret.requestJson.documentType as Record<string, unknown>).receiptType)).toBe("r");
  });
});

describe("drainEtaSubmissions — corrected resubmission", () => {
  it("hashes the rejected document's uuid into the correction and chains it after it", async () => {
    const s = await seedSale({ configureFirst: true });
    const rejected = (await rowsFor(s.tenantId))[0];

    await drainEtaSubmissions({ provider: new FakeEta([rejection()]), reconcile: false });
    expect((await rowsFor(s.tenantId))[0].status).toBe("rejected");

    const correctionId = await enqueueCorrectedResubmission({ tenantId: s.tenantId }, rejected.id);
    const provider = new FakeEta([accepted202("sub-correction")]);
    await drainEtaSubmissions({ provider, reconcile: false });

    const correction = (await rowsFor(s.tenantId)).find((row) => row.id === correctionId)!;
    expect(correction.status).toBe("submitted");
    // A correction is a NEW document: its own uuid, carrying the rejected
    // one's as referenceOldUUID — which, being in the wire, is part of the new
    // hash rather than a side note on the row.
    expect(correction.etaUuid).not.toBe(rejected.etaUuid);
    expect(header(correction.requestJson).referenceOldUUID).toBe(rejected.etaUuid);
    // Still on the device's chain, immediately after the document it replaces.
    expect(header(correction.requestJson).previousUUID).toBe(rejected.etaUuid);
    expect(header(correction.requestJson).receiptNumber).toBe(String(s.receipt.orderNumber));

    const [chain] = await chainFor(s.tenantId);
    expect(chain.lastUuid).toBe(correction.etaUuid);
  });
});

describe("drainEtaSubmissions — headerless full refunds", () => {
  /** Drives the sale to `accepted` so a return can reference it. */
  async function acceptTheSale(tenantId: string) {
    await drainEtaSubmissions({ provider: new FakeEta([accepted202("sub-sale")]), reconcile: false });
    await makeEligibleAll(tenantId);
    await drainEtaSubmissions({ provider: new FakeEta([], [pollValid("LONG-SALE")]), reconcile: false });
  }

  it("files a return receipt for a full refund that stores NO refund_lines", async () => {
    const s = await seedSale({ configureFirst: true });
    await acceptTheSale(s.tenantId);

    // Exactly what both POS surfaces send: kind "full", lines []. This is the
    // most common refund shape there is, and it used to file no document at
    // all — buildReturnReceipt threw EmptyReturnReceiptError, the worker made
    // it permanent, and the owner got an alert naming nothing they could fix.
    const refund = await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "full",
      lines: [],
      payments: [{ method: "cash", amount: s.receipt.paidAmount }],
      reasonCode: "other",
      clientRefundId: "r-headerless",
    });
    expect(await refundLineCount(s.tenantId, refund.refundId)).toBe(0);

    await makeEligibleAll(s.tenantId);
    const returnProvider = new FakeEta([accepted202("sub-return")], [pollValid("LONG-RETURN")]);
    await drainEtaSubmissions({ provider: returnProvider, reconcile: false });
    await makeEligibleAll(s.tenantId);
    await drainEtaSubmissions({ provider: returnProvider, reconcile: false });

    const ret = (await rowsFor(s.tenantId)).find((row) => row.refundId === refund.refundId)!;
    expect(ret.status).toBe("accepted");

    // The lines came from the PARENT ORDER, and the document totals to the
    // refund's own stored figure — the invariant toWireReceipt enforces.
    const items = ret.requestJson.itemData as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    expect(items[0].description).toBe("Margherita");
    expect(items[0].quantity).toBe(1);
    expect(Number(items[0].total)).toBeCloseTo(s.receipt.paidAmount, 2);
    expect(Number(ret.requestJson.totalAmount)).toBeCloseTo(s.receipt.paidAmount, 2);
    expect(header(ret.requestJson).referenceUUID).toBe(
      (await rowsFor(s.tenantId)).find((row) => row.orderId === s.receipt.orderId)!.etaUuid,
    );
  });

  it("resolves a full refund that FOLLOWS a partial one from what is left", async () => {
    // Two units, so a partial can take one and the headerless full refund can
    // take the remainder — the case `issueRefund` permits and the net-paid
    // ceiling bounds.
    const s = await seedPosContext("owner");
    await openShiftForCtx(s.ctx);
    await seedTaxCode(s.tenantId, s.productId);
    await seedFiscalConfig(s.tenantId);
    await seedDeviceCredential(s.tenantId, s.ctx.deviceId);
    const receipt = await recordSale(s.ctx, {
      clientOrderId: "sale-two-units",
      lines: [{ productId: s.productId, quantity: 2, selectedOptionIds: [] }],
      expectedTotal: s.total * 2,
      payments: [{ clientPaymentId: "p-1", method: "cash", amount: s.total * 2, tenderedAmount: s.total * 2 }],
    });
    await acceptTheSale(s.tenantId);

    const [orderItemId] = await orderItemIds(s.tenantId, receipt.orderId);
    await issueRefund(actorFrom(s.ctx), {
      orderId: receipt.orderId,
      kind: "partial",
      lines: [{ orderItemId, quantity: 1, amount: s.total, restock: false }],
      payments: [{ method: "cash", amount: s.total }],
      reasonCode: "other",
      clientRefundId: "r-partial",
    });
    const full = await issueRefund(actorFrom(s.ctx), {
      orderId: receipt.orderId,
      kind: "full",
      lines: [],
      payments: [{ method: "cash", amount: s.total }],
      reasonCode: "other",
      clientRefundId: "r-remainder",
    });

    await makeEligibleAll(s.tenantId);
    const provider = new FakeEta([accepted202("sub-r1"), accepted202("sub-r2")]);
    await drainEtaSubmissions({ provider, reconcile: false });

    const ret = (await rowsFor(s.tenantId)).find((row) => row.refundId === full.refundId)!;
    expect(ret.status).toBe("submitted");
    const items = ret.requestJson.itemData as Record<string, unknown>[];
    // ONE unit, not two: the quantity already returned by the partial is off
    // the table, and the money is this refund's own stored total.
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(1);
    expect(Number(ret.requestJson.totalAmount)).toBeCloseTo(s.total, 2);
  });

  it("refuses to guess which items a goodwill full refund returned", async () => {
    const s = await seedSale({ configureFirst: true });
    await acceptTheSale(s.tenantId);

    // `issueRefund` permits a `full` refund of LESS than the outstanding
    // balance — a goodwill gesture that names no items. There is no honest
    // mapping from that to itemData, so the document is refused rather than
    // invented.
    const goodwill = await issueRefund(actorFrom(s.ctx), {
      orderId: s.receipt.orderId,
      kind: "full",
      lines: [],
      payments: [{ method: "cash", amount: 10 }],
      reasonCode: "other",
      clientRefundId: "r-goodwill",
    });

    await makeEligibleAll(s.tenantId);
    await drainEtaSubmissions({ provider: new FakeEta([accepted202()]), reconcile: false });

    const ret = (await rowsFor(s.tenantId)).find((row) => row.refundId === goodwill.refundId)!;
    expect(ret.status).toBe("failed");
    expect(ret.attempts).toBe(MAX_ATTEMPTS);
    // The alert names both figures, so the owner can see the shape of the fix
    // (itemise the refund) rather than being told a document "failed".
    expect(ret.lastError).toContain("irreconcilable-order");
    expect(ret.lastError).toContain("goodwill");
  });
});

// ---------------------------------------------------------------------------
// Helpers that reach past the service layer, and say why.
// ---------------------------------------------------------------------------

/** Backoff/lease clocks are real timestamps; a test that wants the next pass
 *  to see a row has to move that clock rather than wait out a real minute. */
function makeEligible(tenantId: string, submissionId: string) {
  return withTenant(tenantId, (tx) => tx.update(etaSubmissions)
    .set({ nextAttemptAt: new Date(Date.now() - 1000) })
    .where(and(eq(etaSubmissions.tenantId, tenantId), eq(etaSubmissions.id, submissionId))));
}

function makeEligibleAll(tenantId: string) {
  return withTenant(tenantId, (tx) => tx.update(etaSubmissions)
    .set({ nextAttemptAt: new Date(Date.now() - 1000) })
    .where(eq(etaSubmissions.tenantId, tenantId)));
}

/** How many refund_lines a refund actually stored — the whole point of the
 *  headerless case is that this is zero. */
async function refundLineCount(tenantId: string, refundId: string): Promise<number> {
  const rows = await withTenant(tenantId, (tx) => tx.select({ id: refundLines.id }).from(refundLines)
    .where(and(eq(refundLines.tenantId, tenantId), eq(refundLines.refundId, refundId))));
  return rows.length;
}

async function orderItemIds(tenantId: string, orderId: string): Promise<string[]> {
  const rows = await withTenant(tenantId, (tx) => tx.select({ id: orderItems.id }).from(orderItems)
    .where(and(eq(orderItems.tenantId, tenantId), eq(orderItems.orderId, orderId))).orderBy(orderItems.id));
  return rows.map((row) => row.id);
}

/** A published second product with no `product_tax_codes` row — the cheapest
 *  way to make one document in a batch unbuildable. */
async function seedUnclassifiedProduct(tenantId: string): Promise<string> {
  const cat = await createCategory(tenantId, { nameEn: "Sides", nameAr: "جانبية" });
  const product = await createProduct(tenantId, {
    nameEn: "Fries", nameAr: "بطاطس", basePrice: "100", categoryId: cat.id, trackStock: false, stockQuantity: null,
  });
  await updateProduct(tenantId, product.id, { isPublished: true });
  return product.id;
}

/**
 * A web order — no `pos_order_receipts` row, so nothing but the tenant's
 * nominated online device can carry it. `placedAt`/`paymentStatus` are set
 * directly afterwards because no service exposes "this order was placed half
 * an hour ago and paid": the checkout stamps `now()` and the offline-payment
 * flow needs a payment method this fixture does not exercise.
 */
async function placeWebOrder(
  tenantId: string, branchId: string, productId: string,
  opts: { minutesAgo?: number; paymentStatus?: "paid" | "unpaid" } = {},
): Promise<string> {
  const placed = await placeOrder(tenantId, {
    branchId, fulfillmentType: "pickup", customerName: "Web Buyer", customerPhone: "01000000000",
    channel: "web", lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
  });

  await withTenant(tenantId, (tx) => tx.update(orders).set({
    paymentStatus: opts.paymentStatus ?? "paid",
    placedAt: new Date(Date.now() - (opts.minutesAgo ?? 0) * 60 * 1000),
  }).where(eq(orders.id, placed.orderId)));

  return placed.orderId;
}
